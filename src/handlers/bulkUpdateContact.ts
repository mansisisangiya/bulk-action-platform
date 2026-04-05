import { LogStatus } from "@prisma/client";
import { z } from "zod";
import type { BatchLogEntry, BulkActionHandler, EntityRow, HandlerContext } from "./types.js";

type ContactEntity = EntityRow & {
  email: string;
  name: string;
  age: number | null;
  status: string;
};

type ContactState = {
  seenEmails: Set<string>;
};

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

const UNIQUE_FIELDS = new Set(["email"]);


function touchesUniqueField(updates: BulkUpdateContactPayload["updates"]): boolean {
  return Object.keys(updates).some((k) => UNIQUE_FIELDS.has(k));
}

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

async function updateContactPerRow(
  ctx: HandlerContext,
  contact: ContactEntity,
  payload: BulkUpdateContactPayload,
  state: ContactState,
): Promise<BatchLogEntry> {
  const shouldDedupe = payload.options?.dedupeByEmail === true;
  // resolve the email after the update to check if it's a duplicate.
  const emailAfterUpdate = resolveEmail(payload.updates, contact);

  if (shouldDedupe && state.seenEmails.has(emailAfterUpdate)) {
    return logEntry(contact.id, LogStatus.SKIPPED, "Duplicate email within this bulk action");
  }

  try {
    await ctx.entityRepository.update(contact.id, ctx.accountId, payload.updates as Record<string, unknown>);
    if (shouldDedupe) state.seenEmails.add(emailAfterUpdate);
    return logEntry(contact.id, LogStatus.SUCCESS);
  } catch (error) {
    // if the error is a unique constraint violation, return a SKIPPED log entry.
    if (isUniqueConstraintViolation(error)) {
      return logEntry(contact.id, LogStatus.SKIPPED, "Email already exists for another contact in this account");
    }
    const reason = error instanceof Error ? error.message : "Unknown error updating contact";
    return logEntry(contact.id, LogStatus.FAILED, reason);
  }
}

/**
 * Updates to unique fields require a database roundtrip per contact.
 */
async function processBatchPerRow(
  ctx: HandlerContext,
  contacts: ContactEntity[],
  payload: BulkUpdateContactPayload,
  state: ContactState,
): Promise<BatchLogEntry[]> {
  const logs: BatchLogEntry[] = [];
  for (const contact of contacts) {
    logs.push(await updateContactPerRow(ctx, contact, payload, state));
  }
  return logs;
}

/**
 * Updates to non-unique fields can be batched together. saves a database roundtrip per contact.
 */
async function processBatchFast(
  ctx: HandlerContext,
  contacts: ContactEntity[],
  payload: BulkUpdateContactPayload,
  state: ContactState,
): Promise<BatchLogEntry[]> {
  const shouldDedupe = payload.options?.dedupeByEmail === true;

  const eligible: ContactEntity[] = [];
  const skipped: BatchLogEntry[] = [];

  for (const contact of contacts) {
    const email = resolveEmail(payload.updates, contact);
    if (shouldDedupe && state.seenEmails.has(email)) {
      skipped.push(logEntry(contact.id, LogStatus.SKIPPED, "Duplicate email within this bulk action"));
    } else {
      if (shouldDedupe) state.seenEmails.add(email);
      eligible.push(contact);
    }
  }

  if (eligible.length > 0) {
    await ctx.entityRepository.updateMany(
      ctx.accountId,
      eligible.map((c) => c.id),
      payload.updates as Record<string, unknown>,
    );
  }

  return [
    ...eligible.map((c) => logEntry(c.id, LogStatus.SUCCESS)),
    ...skipped,
  ];
}

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

    if (touchesUniqueField(payload.updates)) {
      return processBatchPerRow(ctx, contacts, payload, contactState);
    }

    return processBatchFast(ctx, contacts, payload, contactState);
  },
};
