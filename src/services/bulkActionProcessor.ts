import { BulkActionStatus, LogStatus, type Prisma } from "@prisma/client";
import { config } from "../config.js";
import { getHandler } from "../handlers/registry.js";
import type { BatchLogEntry, BulkActionHandler, ContactRow, HandlerContext } from "../handlers/types.js";
import { prisma } from "../lib/prisma.js";
import { RateLimitExceededError, reserveCapacity } from "./rateLimit.js";

type BulkPayload = {
  filter?: { ids?: string[] };
  options?: { batchSize?: number; dedupeByEmail?: boolean };
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
  const seenEmails = new Set<string>();

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
  };

  try {
    // If filter is provided, process filtered IDs, otherwise process full scan for all contacts
    const filterIds = payload.filter?.ids?.length
      ? [...new Set(payload.filter.ids)].sort()
      : null;

    if (filterIds) {
      await processFilteredIds({
        bulkActionId,
        handlerContext,
        sortedUniqueIds: filterIds,
        batchSize,
        handler,
        validatedPayload,
        seenEmails,
      });
    } else {
      await processFullScan({
        bulkActionId,
        handlerContext,
        accountId: job.accountId,
        batchSize,
        handler,
        validatedPayload,
        seenEmails,
      });
    }

    await prisma.bulkAction.update({
      where: { id: bulkActionId },
      data: {
        status: BulkActionStatus.COMPLETED,
        completedAt: new Date(),
      },
    });
  } catch (error: unknown) {
    // Rate limit exceeded → let BullMQ retry the job, don't mark it FAILED
    if (error instanceof RateLimitExceededError) throw error;

    const message = error instanceof Error ? error.message : "Processing failed";
    await markFailed(bulkActionId, message);
    throw error;
  }
}

type ProcessBatchParams = {
  bulkActionId: string;
  handlerContext: HandlerContext;
  batchSize: number;
  handler: BulkActionHandler<unknown>;
  validatedPayload: unknown;
  seenEmails: Set<string>;
};

type ProcessFilteredIdsParams = ProcessBatchParams & { sortedUniqueIds: string[] };

async function processFilteredIds(params: ProcessFilteredIdsParams): Promise<void> {
  const {
    bulkActionId,
    handlerContext,
    sortedUniqueIds,
    batchSize,
    handler,
    validatedPayload,
    seenEmails,
  } = params;

  await prisma.bulkAction.update({
    where: { id: bulkActionId },
    data: { totalCount: sortedUniqueIds.length },
  });

  for (let offset = 0; offset < sortedUniqueIds.length; offset += batchSize) {
    const idChunk = sortedUniqueIds.slice(offset, offset + batchSize);

    const { skipLogs, contacts } = await loadBatchForAccount(handlerContext.accountId, idChunk);

    // Reserve capacity for every entity we're about to touch (skips + updates)
    await reserveCapacity(handlerContext.accountId, skipLogs.length + contacts.length);

    if (skipLogs.length > 0) {
      await persistLogsAndCounts(bulkActionId, skipLogs);
    }
    if (contacts.length > 0) {
      const batchLogs = await handler.processBatch(
        handlerContext,
        contacts,
        validatedPayload,
        seenEmails,
      );
      await persistLogsAndCounts(bulkActionId, batchLogs);
    }
  }
}

type ProcessFullScanParams = ProcessBatchParams & { accountId: string };

async function processFullScan(params: ProcessFullScanParams): Promise<void> {
  const {
    bulkActionId,
    handlerContext,
    accountId,
    batchSize,
    handler,
    validatedPayload,
    seenEmails,
  } = params;

  const totalContacts = await prisma.contact.count({ where: { accountId } });
  await prisma.bulkAction.update({
    where: { id: bulkActionId },
    data: { totalCount: totalContacts },
  });

  let lastId: string | undefined;
  while (true) {
    const where: Prisma.ContactWhereInput = { accountId };
    if (lastId !== undefined) {
      where.id = { gt: lastId };
    }

    const contactsPage = await prisma.contact.findMany({
      where,
      orderBy: { id: "asc" },
      take: batchSize,
    });
    if (contactsPage.length === 0) break;

    const contacts = contactsPage as ContactRow[];
    await reserveCapacity(accountId, contacts.length);

    const batchLogs = await handler.processBatch(
      handlerContext,
      contacts,
      validatedPayload,
      seenEmails,
    );
    await persistLogsAndCounts(bulkActionId, batchLogs);

    lastId = contactsPage[contactsPage.length - 1].id;
  }
}

async function loadBatchForAccount(
  accountId: string,
  chunk: string[],
): Promise<{ skipLogs: BatchLogEntry[]; contacts: ContactRow[] }> {
  const found = await prisma.contact.findMany({
    where: { id: { in: chunk }, accountId },
  });
  const contactById = new Map(found.map((contact) => [contact.id, contact]));

  const skipLogs: BatchLogEntry[] = [];
  const contacts: ContactRow[] = [];

  for (const requestedId of chunk) {
    const contact = contactById.get(requestedId);
    if (!contact) {
      skipLogs.push({
        entityId: requestedId,
        entityType: "contact",
        status: LogStatus.SKIPPED,
        reason: "Contact not found for this account",
      });
    } else {
      contacts.push(contact as ContactRow);
    }
  }

  return { skipLogs, contacts };
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
