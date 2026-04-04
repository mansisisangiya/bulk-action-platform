import type { LogStatus } from "@prisma/client";

export type ContactRow = {
  id: string;
  accountId: string;
  name: string;
  email: string;
  age: number | null;
  status: string;
};

export type BatchLogEntry = {
  entityId: string;
  entityType: string;
  status: LogStatus;
  reason?: string | null;
};

export type HandlerContext = {
  accountId: string;
  bulkActionId: string;
};

/**
 * TPayload is the output of validatePayload — one source of truth per action.
 * Registry code uses BulkActionHandler<unknown> because each handler has a different payload shape.
 */
export interface BulkActionHandler<TPayload = unknown> {
  readonly actionType: string;
  readonly entityType: string;
  validatePayload(payload: unknown): TPayload;
  processBatch(
    ctx: HandlerContext,
    contacts: ContactRow[],
    payload: TPayload,
    seenEmails: Set<string>,
  ): Promise<BatchLogEntry[]>;
}
