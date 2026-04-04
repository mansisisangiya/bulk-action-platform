import { BulkActionStatus, type BulkAction, type LogStatus, type Prisma } from "@prisma/client";
import { z } from "zod";
import { getHandler } from "../handlers/registry.js";
import { prisma } from "../lib/prisma.js";
import { enqueueBulkAction } from "../queue/bulkQueue.js";

const createBodySchema = z.object({
  accountId: z.string().min(1),
  actionType: z.string().min(1),
  entityType: z.string().min(1),
  payload: z.unknown(),
});

export type CreateBulkActionInput = z.infer<typeof createBodySchema>;

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export async function createBulkAction(raw: unknown): Promise<BulkAction> {
  const body = createBodySchema.parse(raw);

  const handler = getHandler(body.actionType, body.entityType);
  if (!handler) {
    throw new ValidationError(`Unsupported action ${body.actionType} for entity ${body.entityType}`);
  }

  let validatedPayload: unknown;
  try {
    validatedPayload = handler.validatePayload(body.payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid payload";
    throw new ValidationError(message);
  }

  const action = await prisma.bulkAction.create({
    data: {
      accountId: body.accountId,
      actionType: body.actionType,
      entityType: body.entityType,
      status: BulkActionStatus.QUEUED,
      payload: validatedPayload as Prisma.InputJsonValue,
    },
  });

  await enqueueBulkAction(action.id);

  return action;
}

export async function listBulkActions(params: {
  limit: number;
  offset: number;
  accountId?: string;
}): Promise<BulkAction[]> {
  return prisma.bulkAction.findMany({
    where: params.accountId ? { accountId: params.accountId } : undefined,
    orderBy: { createdAt: "desc" },
    take: params.limit,
    skip: params.offset,
  });
}

export async function getBulkAction(id: string): Promise<BulkAction | null> {
  return prisma.bulkAction.findUnique({ where: { id } });
}

export async function getBulkActionStats(id: string): Promise<{
  bulkActionId: string;
  totalCount: number;
  processedCount: number;
  successCount: number;
  failureCount: number;
  skippedCount: number;
  status: BulkActionStatus;
} | null> {
  const action = await prisma.bulkAction.findUnique({
    where: { id },
    select: {
      id: true,
      totalCount: true,
      processedCount: true,
      successCount: true,
      failureCount: true,
      skippedCount: true,
      status: true,
    },
  });
  if (!action) return null;

  return {
    bulkActionId: action.id,
    totalCount: action.totalCount,
    processedCount: action.processedCount,
    successCount: action.successCount,
    failureCount: action.failureCount,
    skippedCount: action.skippedCount,
    status: action.status,
  };
}

export async function listBulkActionLogs(params: {
  bulkActionId: string;
  status?: LogStatus;
  limit: number;
  offset: number;
}) {
  const where: { bulkActionId: string; status?: LogStatus } = {
    bulkActionId: params.bulkActionId,
  };
  if (params.status) where.status = params.status;

  const [items, total] = await Promise.all([
    prisma.bulkActionLog.findMany({
      where,
      orderBy: { createdAt: "asc" },
      take: params.limit,
      skip: params.offset,
    }),
    prisma.bulkActionLog.count({ where }),
  ]);

  return { items, total };
}
