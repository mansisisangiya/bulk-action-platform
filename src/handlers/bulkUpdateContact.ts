import { LogStatus, Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import type { BatchLogEntry, BulkActionHandler, ContactRow, HandlerContext } from "./types.js";

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


function toPrismaUpdate(updates: BulkUpdateContactPayload["updates"]): Prisma.ContactUpdateInput {
  const data: Prisma.ContactUpdateInput = {};
  if (updates.name !== undefined) data.name = updates.name;
  if (updates.email !== undefined) data.email = updates.email;
  if (updates.status !== undefined) data.status = updates.status;
  if (updates.age !== undefined) data.age = updates.age;
  return data;
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code: string }).code === "P2002"
  );
}

function resolveEmail(updates: BulkUpdateContactPayload["updates"], contact: ContactRow): string {
  return (updates.email ?? contact.email).toLowerCase();
}

function logEntry(
  contactId: string,
  status: LogStatus,
  reason?: string,
): BatchLogEntry {
  return { entityId: contactId, entityType: "contact", status, reason };
}


async function updateContact(
  ctx: HandlerContext,
  contact: ContactRow,
  payload: BulkUpdateContactPayload,
  seenEmails: Set<string>,
): Promise<BatchLogEntry> {
  const shouldDedupe = payload.options?.dedupeByEmail === true;
  const emailAfterUpdate = resolveEmail(payload.updates, contact);

  if (shouldDedupe && seenEmails.has(emailAfterUpdate)) {
    return logEntry(contact.id, LogStatus.SKIPPED, "Duplicate email within this bulk action");
  }

  try {
    await prisma.contact.update({
      where: { id: contact.id, accountId: ctx.accountId },
      data: toPrismaUpdate(payload.updates),
    });

    if (shouldDedupe) seenEmails.add(emailAfterUpdate);
    return logEntry(contact.id, LogStatus.SUCCESS);
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      return logEntry(contact.id, LogStatus.SKIPPED, "Email already exists for another contact in this account");
    }
    const reason = error instanceof Error ? error.message : "Unknown error updating contact";
    return logEntry(contact.id, LogStatus.FAILED, reason);
  }
}


export const bulkUpdateContactHandler: BulkActionHandler<BulkUpdateContactPayload> = {
  actionType: "bulk_update",
  entityType: "contact",

  validatePayload(payload: unknown): BulkUpdateContactPayload {
    return payloadSchema.parse(payload);
  },

  async processBatch(
    ctx: HandlerContext,
    contacts: ContactRow[],
    payload: BulkUpdateContactPayload,
    seenEmails: Set<string>,
  ): Promise<BatchLogEntry[]> {
    const logs: BatchLogEntry[] = [];
    for (const contact of contacts) {
      logs.push(await updateContact(ctx, contact, payload, seenEmails));
    }
    return logs;
  },
};
