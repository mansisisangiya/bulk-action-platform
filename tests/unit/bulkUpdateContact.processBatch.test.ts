import { describe, it, expect, vi, beforeEach } from "vitest";
import { bulkUpdateContactHandler } from "../../src/handlers/bulkUpdateContact.js";
import type { HandlerContext } from "../../src/handlers/types.js";
import type { EntityRepository } from "../../src/repositories/EntityRepository.js";

function makeContact(overrides = {}) {
  return {
    id: crypto.randomUUID(),
    accountId: "acc-1",
    email: "user@example.com",
    name: "Test User",
    age: 30,
    status: "active",
    ...overrides,
  };
}

function makeCtx(repoOverrides: Partial<EntityRepository> = {}): HandlerContext {
  return {
    accountId: "acc-1",
    bulkActionId: "ba-1",
    entityRepository: {
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      count: vi.fn(),
      findByIds: vi.fn(),
      findPage: vi.fn(),
      entityType: "contact",
      ...repoOverrides,
    } as unknown as EntityRepository,
  };
}

describe("bulkUpdateContactHandler.processBatch", () => {
  describe("fast path — non-unique field (status)", () => {
    it("calls updateMany once for the whole batch and returns SUCCESS for each", async () => {
      const ctx = makeCtx();
      const contacts = [makeContact({ id: "id-1" }), makeContact({ id: "id-2" })];
      const payload = bulkUpdateContactHandler.validatePayload({ updates: { status: "inactive" } });
      const state = bulkUpdateContactHandler.createState!();

      const logs = await bulkUpdateContactHandler.processBatch(ctx, contacts, payload, state);

      expect(ctx.entityRepository.updateMany).toHaveBeenCalledOnce();
      expect(ctx.entityRepository.update).not.toHaveBeenCalled();
      expect(logs).toHaveLength(2);
      expect(logs.every((l) => l.status === "SUCCESS")).toBe(true);
    });

    it("skips duplicate emails when dedupeByEmail is true (fast path)", async () => {
      const ctx = makeCtx();
      const email = "dup@example.com";
      const contacts = [
        makeContact({ id: "id-1", email }),
        makeContact({ id: "id-2", email }),
      ];
      const payload = bulkUpdateContactHandler.validatePayload({
        updates: { status: "inactive" },
        options: { dedupeByEmail: true },
      });
      const state = bulkUpdateContactHandler.createState!();

      const logs = await bulkUpdateContactHandler.processBatch(ctx, contacts, payload, state);

      expect(logs.find((l) => l.entityId === "id-1")?.status).toBe("SUCCESS");
      expect(logs.find((l) => l.entityId === "id-2")?.status).toBe("SKIPPED");
    });
  });

  describe("per-row path — unique field (email)", () => {
    it("calls update once per contact and returns SUCCESS for each", async () => {
      const ctx = makeCtx();
      const contacts = [
        makeContact({ id: "id-1", email: "a@example.com" }),
        makeContact({ id: "id-2", email: "b@example.com" }),
      ];
      const payload = bulkUpdateContactHandler.validatePayload({
        updates: { email: "new@example.com" },
      });
      const state = bulkUpdateContactHandler.createState!();

      const logs = await bulkUpdateContactHandler.processBatch(ctx, contacts, payload, state);

      expect(ctx.entityRepository.update).toHaveBeenCalledTimes(2);
      expect(ctx.entityRepository.updateMany).not.toHaveBeenCalled();
      expect(logs.every((l) => l.status === "SUCCESS")).toBe(true);
    });

    it("returns SKIPPED when a unique constraint violation occurs (P2002)", async () => {
      const ctx = makeCtx({
        update: vi.fn().mockRejectedValue({ code: "P2002" }),
      });
      const contacts = [makeContact({ id: "id-1" })];
      const payload = bulkUpdateContactHandler.validatePayload({
        updates: { email: "taken@example.com" },
      });
      const state = bulkUpdateContactHandler.createState!();

      const logs = await bulkUpdateContactHandler.processBatch(ctx, contacts, payload, state);

      expect(logs[0].status).toBe("SKIPPED");
      expect(logs[0].reason).toMatch(/already exists/);
    });

    it("returns FAILED when an unexpected DB error occurs", async () => {
      const ctx = makeCtx({
        update: vi.fn().mockRejectedValue(new Error("connection timeout")),
      });
      const contacts = [makeContact({ id: "id-1" })];
      const payload = bulkUpdateContactHandler.validatePayload({
        updates: { email: "x@example.com" },
      });
      const state = bulkUpdateContactHandler.createState!();

      const logs = await bulkUpdateContactHandler.processBatch(ctx, contacts, payload, state);

      expect(logs[0].status).toBe("FAILED");
      expect(logs[0].reason).toMatch(/connection timeout/);
    });
  });
});
