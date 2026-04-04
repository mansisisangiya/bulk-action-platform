import "dotenv/config";

export const config = {
  port: Number(process.env.PORT) || 3000,
  nodeEnv: process.env.NODE_ENV ?? "development",
  databaseUrl: process.env.DATABASE_URL ?? "",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  rateLimitUpdatesPerMinute: Number(process.env.RATE_LIMIT_UPDATES_PER_MINUTE) || 10_000, 
  defaultBatchSize: 500,
  queueName: "bulk-actions",
};
