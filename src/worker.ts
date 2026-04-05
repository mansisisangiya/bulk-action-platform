import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { config } from "./config.js";
import type { BulkJobData } from "./queue/bulkQueue.js";
import { processBulkAction } from "./services/bulkActionProcessor.js";
import { RateLimitExceededError } from "./services/rateLimit.js";
import { logger } from "./utils/logger.js";

const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

const worker = new Worker<BulkJobData>(
  config.queueName,
  async (job) => {
    await processBulkAction(job.data.bulkActionId);
  },
  {
    connection,
    concurrency: 4,
  },
);

worker.on("failed", (job, err) => {
  if (err instanceof RateLimitExceededError) {
    logger.warn(`Job ${job?.id} deferred — rate limit exceeded (will retry)`);
    return;
  }
  logger.error(`Job ${job?.id} failed`, { error: err.message });
});

worker.on("completed", (job) => {
  logger.info(`Job ${job.id} completed`);
});

logger.info(`Worker started for queue "${config.queueName}"`, { concurrency: 4 });
