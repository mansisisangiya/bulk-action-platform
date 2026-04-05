import { describe, it, expect } from "vitest";
import { bulkUpdateContactHandler } from "../../src/handlers/bulkUpdateContact.js";

describe("bulkUpdateContactHandler.validatePayload", () => {
  it("accepts a valid status update", () => {
    const result = bulkUpdateContactHandler.validatePayload({
      updates: { status: "active" },
    });
    expect(result).toEqual({ updates: { status: "active" } });
  });

  it("accepts a valid email update", () => {
    const result = bulkUpdateContactHandler.validatePayload({
      updates: { email: "new@example.com" },
    });
    expect(result).toEqual({ updates: { email: "new@example.com" } });
  });

  it("accepts updates with filter and options", () => {
    const payload = {
      updates: { status: "inactive" },
      filter: { ids: ["550e8400-e29b-41d4-a716-446655440000"] },
      options: { batchSize: 100, dedupeByEmail: true },
    };
    expect(() => bulkUpdateContactHandler.validatePayload(payload)).not.toThrow();
  });

  it("rejects an empty updates object", () => {
    expect(() =>
      bulkUpdateContactHandler.validatePayload({ updates: {} }),
    ).toThrow("updates must include at least one field");
  });

  it("rejects an invalid email format", () => {
    expect(() =>
      bulkUpdateContactHandler.validatePayload({ updates: { email: "not-an-email" } }),
    ).toThrow();
  });

  it("rejects a negative age", () => {
    expect(() =>
      bulkUpdateContactHandler.validatePayload({ updates: { age: -1 } }),
    ).toThrow();
  });

  it("rejects payload with no updates key at all", () => {
    expect(() =>
      bulkUpdateContactHandler.validatePayload({}),
    ).toThrow();
  });
});
