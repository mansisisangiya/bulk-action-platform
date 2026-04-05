import { config } from "../config.js";
import { getRedis } from "../lib/redis.js";

/**
 * Thrown when a batch cannot proceed right now.
 * The worker re-throws this so BullMQ retries with exponential backoff
 * instead of marking the bulk action as FAILED.
 */
export class RateLimitExceededError extends Error {
  constructor(accountId: string) {
    super(`Rate limit exceeded for account "${accountId}"`);
    this.name = "RateLimitExceededError";
  }
}

function buildKey(accountId: string, now: Date): string {
  const y = now.getUTCFullYear();
  const mo = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const h = String(now.getUTCHours()).padStart(2, "0");
  const mi = String(now.getUTCMinutes()).padStart(2, "0");
  return `rate_limit:${accountId}:${y}${mo}${d}${h}${mi}`;
}

const RESERVE_SCRIPT = `
  local key    = KEYS[1]
  local limit  = tonumber(ARGV[1])
  local count  = tonumber(ARGV[2])
  local ttlSec = tonumber(ARGV[3])

  local current = tonumber(redis.call('GET', key) or '0')
  if current + count > limit then
    return 0
  end

  redis.call('INCRBY', key, count)

  if redis.call('TTL', key) < 0 then
    redis.call('EXPIRE', key, ttlSec)
  end

  return 1
`;

const KEY_TTL_SECONDS = 120;

export async function reserveCapacity(accountId: string, count: number): Promise<void> {
  if (count <= 0) return;

  const limit = config.rateLimitPerMinute;
  if (limit <= 0) return;

  const redis = getRedis();
  const key = buildKey(accountId, new Date());

  const allowed = await redis.eval(
    RESERVE_SCRIPT,
    1,
    key,
    String(limit),
    String(count),
    String(KEY_TTL_SECONDS),
  );

  if (allowed !== 1) {
    throw new RateLimitExceededError(accountId);
  }
}
