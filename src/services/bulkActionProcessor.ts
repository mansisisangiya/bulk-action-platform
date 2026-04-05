import { BulkActionStatus, LogStatus, type Prisma } from "@prisma/client";
import { config } from "../config.js";
import { getHandler } from "../handlers/registry.js";
import type { BatchLogEntry, BulkActionHandler, HandlerContext } from "../handlers/types.js";
import { prisma } from "../lib/prisma.js";
import { EntityRepository, type EntityRow } from "../repositories/EntityRepository.js";
import { logger } from "../utils/logger.js";
import { RateLimitExceededError, reserveCapacity } from "./rateLimit.js";

type BulkPayload = {
  filter?: { ids?: string[] };
  options?: { batchSize?: number };
};

export async function processBulkAction(bulkActionId: string): Promise<void> {
  const job = await prisma.bulkAction.findUnique({ where: { id: bulkActionId } });
  if (!job) return;

  if (job.status === BulkActionStatus.COMPLETED) return;

  const handler = getHandler(job.actionType, job.entityType);
  if (!handler) {
    await markFailed(bulkActionId, `No handler for ${job.actionType}:${job.entityType}`);
    return;
  }

  let validatedPayload: unknown;
  try {
    validatedPayload = handler.validatePayload(job.payload);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Invalid payload";
    await markFailed(bulkActionId, message);
    return;
  }

  const payload = validatedPayload as BulkPayload;
  const batchSize = payload.options?.batchSize ?? config.defaultBatchSize;

  const entityRepository = new EntityRepository(job.entityType);
  const handlerState = handler.createState?.() ?? {};

  await prisma.bulkAction.update({
    where: { id: bulkActionId },
    data: {
      status: BulkActionStatus.RUNNING,
      startedAt: job.startedAt ?? new Date(),
      errorMessage: null,
    },
  });

  const handlerContext: HandlerContext = {
    accountId: job.accountId,
    bulkActionId,
    entityRepository,
  };

  logger.info("Processing bulk action", {
    bulkActionId,
    actionType: job.actionType,
    entityType: job.entityType,
    accountId: job.accountId,
  });

  try {
    const filterIds = payload.filter?.ids?.length
      ? [...new Set(payload.filter.ids)].sort()
      : null;

    if (filterIds) {
      await processFilteredIds({
        bulkActionId,
        handlerContext,
        entityRepository,
        sortedUniqueIds: filterIds,
        batchSize,
        handler,
        validatedPayload,
        handlerState,
      });
    } else {
      await processFullScan({
        bulkActionId,
        handlerContext,
        entityRepository,
        accountId: job.accountId,
        batchSize,
        handler,
        validatedPayload,
        handlerState,
      });
    }

    await prisma.bulkAction.update({
      where: { id: bulkActionId },
      data: {
        status: BulkActionStatus.COMPLETED,
        completedAt: new Date(),
      },
    });

    logger.info("Bulk action completed", { bulkActionId });
  } catch (error: unknown) {
    if (error instanceof RateLimitExceededError) throw error;

    const message = error instanceof Error ? error.message : "Processing failed";
    logger.error("Bulk action failed", { bulkActionId, error: message });
    await markFailed(bulkActionId, message);
    throw error;
  }
}

type ProcessBatchParams = {
  bulkActionId: string;
  handlerContext: HandlerContext;
  entityRepository: EntityRepository;
  batchSize: number;
  handler: BulkActionHandler<unknown>;
  validatedPayload: unknown;
  handlerState: unknown;
};

type ProcessFilteredIdsParams = ProcessBatchParams & { sortedUniqueIds: string[] };

// known ids + total count first to avoid scanning the entire table
async function processFilteredIds(params: ProcessFilteredIdsParams): Promise<void> {
  const { bulkActionId, handlerContext, entityRepository, sortedUniqueIds, batchSize, handler, validatedPayload, handlerState } =
    params;

  await prisma.bulkAction.update({
    where: { id: bulkActionId },
    data: { totalCount: sortedUniqueIds.length },
  });

  for (let offset = 0; offset < sortedUniqueIds.length; offset += batchSize) {
    const idChunk = sortedUniqueIds.slice(offset, offset + batchSize);
    const { skipLogs, entities } = await loadBatchForAccount(entityRepository, handlerContext.accountId, idChunk, handler.entityType);

    // rate limit gate to avoid overwhelming the system
    await reserveCapacity(handlerContext.accountId, skipLogs.length + entities.length);

    if (skipLogs.length > 0) {
      await persistLogsAndCounts(bulkActionId, skipLogs);
    }
    if (entities.length > 0) {
      const batchLogs = await handler.processBatch(handlerContext, entities, validatedPayload, handlerState);
      await persistLogsAndCounts(bulkActionId, batchLogs);
    }
  }
}

type ProcessFullScanParams = ProcessBatchParams & { accountId: string };

async function processFullScan(params: ProcessFullScanParams): Promise<void> {
  const { bulkActionId, handlerContext, entityRepository, accountId, batchSize, handler, validatedPayload, handlerState } =
    params;

  const total = await entityRepository.count(accountId);
  await prisma.bulkAction.update({
    where: { id: bulkActionId },
    data: { totalCount: total },
  });

  let lastId: string | undefined;
  // keyset pagination to avoid scanning the entire table
  while (true) {
    const page = await entityRepository.findPage(accountId, lastId, batchSize);
    if (page.length === 0) break;

    await reserveCapacity(accountId, page.length);

    const batchLogs = await handler.processBatch(handlerContext, page, validatedPayload, handlerState);
    await persistLogsAndCounts(bulkActionId, batchLogs);

    lastId = page[page.length - 1].id;
  }
}

async function loadBatchForAccount(
  entityRepository: EntityRepository,
  accountId: string,
  chunk: string[],
  entityType: string,
): Promise<{ skipLogs: BatchLogEntry[]; entities: EntityRow[] }> {
  const found = await entityRepository.findByIds(accountId, chunk);
  const byId = new Map(found.map((e) => [e.id, e]));

  const skipLogs: BatchLogEntry[] = [];
  const entities: EntityRow[] = [];

  for (const id of chunk) {
    const entity = byId.get(id);
    if (!entity) {
      skipLogs.push({
        entityId: id,
        entityType,
        status: LogStatus.SKIPPED,
        reason: `${entityType} not found for this account`,
      });
    } else {
      entities.push(entity);
    }
  }

  return { skipLogs, entities };
}

async function persistLogsAndCounts(bulkActionId: string, entries: BatchLogEntry[]): Promise<void> {
  if (entries.length === 0) return;

  let success = 0;
  let failed = 0;
  let skipped = 0;
  for (const entry of entries) {
    if (entry.status === LogStatus.SUCCESS) success += 1;
    else if (entry.status === LogStatus.FAILED) failed += 1;
    else skipped += 1;
  }

  await prisma.$transaction([
    prisma.bulkActionLog.createMany({
      data: entries.map((entry) => ({
        bulkActionId,
        entityId: entry.entityId,
        entityType: entry.entityType,
        status: entry.status,
        reason: entry.reason ?? null,
      })),
    }),
    prisma.bulkAction.update({
      where: { id: bulkActionId },
      data: {
        processedCount: { increment: entries.length },
        successCount: { increment: success },
        failureCount: { increment: failed },
        skippedCount: { increment: skipped },
      },
    }),
  ]);
}

async function markFailed(bulkActionId: string, errorMessage: string): Promise<void> {
  await prisma.bulkAction.update({
    where: { id: bulkActionId },
    data: {
      status: BulkActionStatus.FAILED,
      errorMessage,
      completedAt: new Date(),
    },
  });
}
