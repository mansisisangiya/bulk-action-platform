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

/**
 * TPayload is the output of validatePayload — one source of truth per action.
 *
 * Handlers are entity-agnostic at the interface level:
 *   - createState() lets each handler initialise its own cross-batch state
 *     (e.g. a dedup Set for contacts) without the processor knowing the shape.
 *   - processBatch receives generic EntityRow[]; the handler casts internally.
 */
export interface BulkActionHandler<TPayload = unknown> {
  readonly actionType: string;
  readonly entityType: string;

  validatePayload(payload: unknown): TPayload;

  /** Called once per job before any batch. Returns handler-owned state passed to every processBatch call. */
  createState?(): unknown;

  processBatch(
    ctx: HandlerContext,
    entities: EntityRow[],
    payload: TPayload,
    state: unknown,
  ): Promise<BatchLogEntry[]>;
}
