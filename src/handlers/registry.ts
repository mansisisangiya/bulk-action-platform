import { bulkUpdateContactHandler } from "./bulkUpdateContact.js";
import type { BulkActionHandler } from "./types.js";

const handlers: BulkActionHandler<unknown>[] = [
  bulkUpdateContactHandler as BulkActionHandler<unknown>,
  /** add more handlers here for new entities  */
];

const handlerKey = (actionType: string, entityType: string) => `${actionType}:${entityType}`;

const handlerMap = new Map<string, BulkActionHandler<unknown>>();
for (const handler of handlers) {
  handlerMap.set(handlerKey(handler.actionType, handler.entityType), handler);
}

export function getHandler(actionType: string, entityType: string): BulkActionHandler<unknown> | undefined {
  return handlerMap.get(handlerKey(actionType, entityType));
}

export function listRegisteredHandlers(): Array<{ actionType: string; entityType: string }> {
  return handlers.map((handler) => ({ actionType: handler.actionType, entityType: handler.entityType }));
}
