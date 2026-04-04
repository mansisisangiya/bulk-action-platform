import express from "express";
import { config } from "./config.js";
import { bulkActionsErrorHandler } from "./error.js";
import { bulkActionsRouter } from "./routes/bulkActions.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

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

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "bulk-action-platform" });
});

app.use("/bulk-actions", bulkActionsRouter);
app.use(bulkActionsErrorHandler);

app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  },
);

app.listen(config.port, () => {
  console.log(`API listening on http://localhost:${config.port}`);
});
