import type { NextFunction, Request, Response } from "express";
import {
  createBulkAction,
  getBulkAction,
  getBulkActionStats,
  listBulkActionLogs,
  listBulkActions,
} from "../services/bulkActionService.js";

// ─── List Bulk Actions ─────────────────────────────────────────────────────────

export async function list(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const limit = Math.min(Number(req.query["limit"]) || 20, 100);
    const offset = Number(req.query["offset"]) || 0;
    const accountId = req.query["accountId"] as string | undefined;

    const actions = await listBulkActions({ limit, offset, accountId });
    res.json({ data: actions, limit, offset });
  } catch (err) {
    next(err);
  }
}

// ─── Create Bulk Action ───────────────────────────────────────────────────────

export async function create(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const action = await createBulkAction(req.body);
    res.status(201).json(action);
  } catch (err) {
    next(err);
  }
}

// ─── Get Bulk Action ──────────────────────────────────────────────────────────────────

export async function getOne(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params["id"] as string;
    const action = await getBulkAction(id);
    if (!action) {
      res.status(404).json({ error: "Bulk action not found" });
      return;
    }
    const progress =
      action.totalCount > 0
        ? Math.round((action.processedCount / action.totalCount) * 100) / 100
        : 0;
    res.json({ ...action, progress });
  } catch (err) {
    next(err);
  }
}

// ─── Get Bulk Action Stats ──────────────────────────────────────────────────────

export async function stats(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params["id"] as string;
    const result = await getBulkActionStats(id);
    if (!result) {
      res.status(404).json({ error: "Bulk action not found" });
      return;
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
}

// ─── Get Bulk Action Logs ───────────────────────────────────────────────────────

export async function logs(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params["id"] as string;
    const limit = Math.min(Number(req.query["limit"]) || 50, 500);
    const offset = Number(req.query["offset"]) || 0;
    const statusFilter = req.query["status"] as Parameters<typeof listBulkActionLogs>[0]["status"];

    const result = await listBulkActionLogs({
      bulkActionId: id,
      status: statusFilter,
      limit,
      offset,
    });

    res.json({ data: result.items, total: result.total, limit, offset });
  } catch (err) {
    next(err);
  }
}
