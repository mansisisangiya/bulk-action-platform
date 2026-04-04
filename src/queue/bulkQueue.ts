import { Queue } from "bullmq";
import { config } from "../config.js";
import { getRedis } from "../lib/redis.js";

export type BulkJobData = {
  bulkActionId: string;
};

let queue: Queue<BulkJobData> | null = null;


export function getBulkQueue(): Queue<BulkJobData> {
  if (!queue) {
    queue = new Queue<BulkJobData>(config.queueName, {
      connection: getRedis(),
      defaultJobOptions: {
        attempts: 3, 
        backoff: { type: "exponential", delay: 2000 }, // 2 seconds delay between attempts
        removeOnComplete: { count: 500 }, // 500 completed jobs to keep in the queue
        removeOnFail: { count: 200 }, // 200 failed jobs to keep in the queue
      },
    });
  }
  return queue;
}

export async function enqueueBulkAction(bulkActionId: string): Promise<void> {
  const queue = getBulkQueue();
  await queue.add("run", { bulkActionId }, { jobId: bulkActionId });
}
