import { LogStatus } from "@prisma/client";
import { z } from "zod";
import type { BatchLogEntry, BulkActionHandler, EntityRow, HandlerContext } from "./types.js";

// ── Contact-specific types ──────────────────────────────────────────

type ContactEntity = EntityRow & {
  email: string;
  name: string;
  age: number | null;
  status: string;
};

type ContactState = {
  seenEmails: Set<string>;
};

// ── Zod schemas (contact-specific validation) ───────────────────────

const updatesFieldsSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  status: z.string().min(1).optional(),
  age: z.number().int().min(0).max(150).optional(),
});

const updatesSchema = updatesFieldsSchema.refine(
  (fields) => Object.keys(fields).length > 0,
  { message: "updates must include at least one field" },
);

const payloadSchema = z.object({
  updates: updatesSchema,
  filter: z.object({ ids: z.array(z.string().uuid()).optional() }).optional(),
  options: z
    .object({
      batchSize: z.number().int().min(1).max(2000).optional(),
      dedupeByEmail: z.boolean().optional(),
    })
    .optional(),
});

export type BulkUpdateContactPayload = z.infer<typeof payloadSchema>;

// ── Helpers ─────────────────────────────────────────────────────────

function resolveEmail(updates: BulkUpdateContactPayload["updates"], contact: ContactEntity): string {
  return (updates.email ?? contact.email ?? "").toLowerCase();
}

function logEntry(entityId: string, status: LogStatus, reason?: string): BatchLogEntry {
  return { entityId, entityType: "contact", status, reason };
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code: string }).code === "P2002"
  );
}

async function updateContact(
  ctx: HandlerContext,
  contact: ContactEntity,
  payload: BulkUpdateContactPayload,
  state: ContactState,
): Promise<BatchLogEntry> {
  const shouldDedupe = payload.options?.dedupeByEmail === true;
  const emailAfterUpdate = resolveEmail(payload.updates, contact);

  if (shouldDedupe && state.seenEmails.has(emailAfterUpdate)) {
    return logEntry(contact.id, LogStatus.SKIPPED, "Duplicate email within this bulk action");
  }

  try {
    await ctx.entityRepository.update(contact.id, ctx.accountId, payload.updates as Record<string, unknown>);

    if (shouldDedupe) state.seenEmails.add(emailAfterUpdate);
    return logEntry(contact.id, LogStatus.SUCCESS);
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      return logEntry(contact.id, LogStatus.SKIPPED, "Email already exists for another contact in this account");
    }
    const reason = error instanceof Error ? error.message : "Unknown error updating contact";
    return logEntry(contact.id, LogStatus.FAILED, reason);
  }
}

// ── Exported handler ────────────────────────────────────────────────

export const bulkUpdateContactHandler: BulkActionHandler<BulkUpdateContactPayload> = {
  actionType: "bulk_update",
  entityType: "contact",

  validatePayload(payload: unknown): BulkUpdateContactPayload {
    return payloadSchema.parse(payload);
  },

  createState(): ContactState {
    return { seenEmails: new Set<string>() };
  },

  async processBatch(
    ctx: HandlerContext,
    entities: EntityRow[],
    payload: BulkUpdateContactPayload,
    state: unknown,
  ): Promise<BatchLogEntry[]> {
    const contactState = state as ContactState;
    const contacts = entities as ContactEntity[];

    const logs: BatchLogEntry[] = [];
    for (const contact of contacts) {
      logs.push(await updateContact(ctx, contact, payload, contactState));
    }
    return logs;
  },
};
