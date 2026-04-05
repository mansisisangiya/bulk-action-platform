import type { NextFunction, Request, Response } from "express";
import { logger } from "../utils/logger.js";

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();

  res.on("finish", () => {
    logger.info(`${req.method} ${req.path}`, {
      status: res.statusCode,
      ms: Date.now() - start,
    });
  });

  next();
}
