import { LogStatus } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { listRegisteredHandlers } from "../handlers/registry.js";
import {
  createBulkAction,
  getBulkAction,
  getBulkActionStats,
  listBulkActionLogs,
  listBulkActions,
} from "../services/bulkActionService.js";

export const bulkActionsRouter = Router();

// ── List registered handlers ───────────────────

bulkActionsRouter.get("/meta/handlers", (_req, res) => {
  res.json({ handlers: listRegisteredHandlers() });
});

// ── List bulk actions ───────────────────────────────────────────────

bulkActionsRouter.get("/", async (req, res, next) => {
  try {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).optional().default(50),
        offset: z.coerce.number().int().min(0).optional().default(0),
        accountId: z.string().min(1).optional(),
      })
      .parse(req.query);

    const items = await listBulkActions(query);
    res.json({ items, limit: query.limit, offset: query.offset });
  } catch (error) {
    next(error);
  }
});

// ── Create bulk action ──────────────────────────────────────────────

bulkActionsRouter.post("/", async (req, res, next) => {
  try {
    const action = await createBulkAction(req.body);
    res.status(201).json(action);
  } catch (error) {
    next(error);
  }
});

// ── Get bulk action (status + progress) ─────────────────────────────

bulkActionsRouter.get("/:id", async (req, res, next) => {
  try {
    const action = await getBulkAction(req.params.id);
    if (!action) {
      res.status(404).json({ error: "Bulk action not found" });
      return;
    }

    const progress =
      action.totalCount > 0
        ? Math.min(1, action.processedCount / action.totalCount)
        : action.status === "COMPLETED" ? 1 : 0;

    res.json({ ...action, progress });
  } catch (error) {
    next(error);
  }
});

// ── Get bulk action stats ───────────────────────────────────────────

bulkActionsRouter.get("/:id/stats", async (req, res, next) => {
  try {
    const stats = await getBulkActionStats(req.params.id);
    if (!stats) {
      res.status(404).json({ error: "Bulk action not found" });
      return;
    }
    res.json(stats);
  } catch (error) {
    next(error);
  }
});

// ── Get bulk action logs ────────────────────────────────────────────

bulkActionsRouter.get("/:id/logs", async (req, res, next) => {
  try {
    const query = z
      .object({
        status: z.nativeEnum(LogStatus).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional().default(100),
        offset: z.coerce.number().int().min(0).optional().default(0),
      })
      .parse(req.query);

    const action = await getBulkAction(req.params.id);
    if (!action) {
      res.status(404).json({ error: "Bulk action not found" });
      return;
    }

    const { items, total } = await listBulkActionLogs({
      bulkActionId: req.params.id,
      status: query.status,
      limit: query.limit,
      offset: query.offset,
    });

    res.json({ items, total, limit: query.limit, offset: query.offset });
  } catch (error) {
    next(error);
  }
});
