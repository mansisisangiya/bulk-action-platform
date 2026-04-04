import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { config } from "./config.js";
import type { BulkJobData } from "./queue/bulkQueue.js";
import { processBulkAction } from "./services/bulkActionProcessor.js";

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
  console.error(`Job ${job?.id} failed`, err);
});

worker.on("completed", (job) => {
  console.log(`Job ${job.id} completed`);
});

console.log(`Worker started for queue "${config.queueName}" (concurrency=4)`);
