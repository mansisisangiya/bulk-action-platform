import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { ValidationError } from "./services/bulkActionService.js";

/**
 * Maps Zod and domain validation errors to 400 responses.
 * Passes everything else to `next(err)` for the generic 500 handler.
 */
export function bulkActionsErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (err instanceof ZodError) {
    res.status(400).json({ error: "Validation error", details: err.flatten() });
    return;
  }
  if (err instanceof ValidationError) {
    res.status(400).json({ error: err.message });
    return;
  }
  next(err);
}
