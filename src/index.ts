import express from "express";
import { config } from "./config.js";
import { bulkActionsErrorHandler } from "./error.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { getBulkQueue } from "./queue/bulkQueue.js";
import { bulkActionsRouter } from "./routes/bulkActions.js";
import { logger } from "./utils/logger.js";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(requestLogger);

app.get("/", (_req, res) => {
  res.json({
    service: "bulk-action-platform",
    endpoints: {
      health: "/health",
      bulkActions: "/bulk-actions",
      handlers: "/bulk-actions/meta/handlers",
    },
  });
});

/**
 * Health check — also returns queue depth to decide whether to scale worker replicas up or down.
 */
app.get("/health", async (_req, res) => {
  try {
    const queue = getBulkQueue();
    const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed");
    res.json({
      ok: true,
      service: "bulk-action-platform",
      queue: {
        name: config.queueName,
        waiting: counts.waiting,   // jobs queued, not yet picked up
        active: counts.active,     // jobs currently being processed
        delayed: counts.delayed,   // scheduled jobs not yet ready
        failed: counts.failed,     // jobs that exhausted all retries
      },
    });
  } catch {
    res.status(503).json({ ok: false, service: "bulk-action-platform", error: "queue unavailable" });
  }
});

app.use("/bulk-actions", bulkActionsRouter);
app.use(bulkActionsErrorHandler);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error("Unhandled error", { error: err instanceof Error ? err.message : String(err) });
  res.status(500).json({ error: "Internal server error" });
});

app.listen(config.port, () => {
  logger.info(`API listening on http://localhost:${config.port}`);
});
