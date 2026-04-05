import { Router } from "express";
import * as BulkActionController from "../controllers/BulkActionController.js";
import { listRegisteredHandlers } from "../handlers/registry.js";

export const bulkActionsRouter = Router();

bulkActionsRouter.get("/meta/handlers", (_req, res) => {
  res.json({ handlers: listRegisteredHandlers() });
});

bulkActionsRouter.get("/", BulkActionController.list);

bulkActionsRouter.post("/", BulkActionController.create);

bulkActionsRouter.get("/:id", BulkActionController.getOne);

bulkActionsRouter.get("/:id/stats", BulkActionController.stats);

bulkActionsRouter.get("/:id/logs", BulkActionController.logs);
