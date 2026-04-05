import type { LogStatus } from "@prisma/client";
import type { EntityRepository, EntityRow } from "../repositories/EntityRepository.js";

export type { EntityRow };

export type BatchLogEntry = {
  entityId: string;
  entityType: string;
  status: LogStatus;
  reason?: string | null;
};

export type HandlerContext = {
  accountId: string;
  bulkActionId: string;
  entityRepository: EntityRepository;
};

export interface BulkActionHandler<TPayload = unknown> {
  readonly actionType: string;
  readonly entityType: string;

  validatePayload(payload: unknown): TPayload;

  createState?(): unknown;

  processBatch(
    ctx: HandlerContext,
    entities: EntityRow[],
    payload: TPayload,
    state: unknown,
  ): Promise<BatchLogEntry[]>;
}
