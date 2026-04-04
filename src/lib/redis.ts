import { Redis } from "ioredis";
import { config } from "../config.js";

const globalForRedis = globalThis as unknown as { redis?: Redis }; 

/**
 * Get the Redis client.
 * Uses a global singleton to avoid creating multiple clients.
 * The client is cached in the global object and reused across the application.
 * @returns The Redis client.
 */
export function getRedis(): Redis {
  if (!globalForRedis.redis) {
    globalForRedis.redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  }
  return globalForRedis.redis;
}
