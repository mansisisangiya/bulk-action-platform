import { describe, it, expect } from "vitest";
import { getHandler, listRegisteredHandlers } from "../../src/handlers/registry.js";

describe("handler registry", () => {
  it("returns the correct handler for bulk_update:contact", () => {
    const handler = getHandler("bulk_update", "contact");
    expect(handler).toBeDefined();
    expect(handler?.actionType).toBe("bulk_update");
    expect(handler?.entityType).toBe("contact");
  });

  it("returns undefined for an unregistered action type", () => {
    expect(getHandler("bulk_delete", "contact")).toBeUndefined();
  });

  it("returns undefined for an unregistered entity type", () => {
    expect(getHandler("bulk_update", "company")).toBeUndefined();
  });

  it("lists all registered handlers", () => {
    const handlers = listRegisteredHandlers();
    expect(handlers.length).toBeGreaterThan(0);
    expect(handlers).toContainEqual({ actionType: "bulk_update", entityType: "contact" });
  });
});
