import "dotenv/config";

export const config = {
  port: Number(process.env.PORT) || 3000,
  nodeEnv: process.env.NODE_ENV ?? "development",
  databaseUrl: process.env.DATABASE_URL ?? "",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  defaultBatchSize: 500,
  queueName: "bulk-actions",
  /** Max entity operations (success + fail + skip) per account per minute. 0 = no limit. */
  rateLimitPerMinute: Number(process.env.RATE_LIMIT_PER_MINUTE) || 10_000,
  /**
   * Number of jobs this worker process handles in parallel.
   * Each deployed replica can tune independently via WORKER_CONCURRENCY.
   * Total system capacity = workerConcurrency × number of running replicas.
   */
  workerConcurrency: Number(process.env.WORKER_CONCURRENCY) || 4,
};
