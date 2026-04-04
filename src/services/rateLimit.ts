import { config } from "../config.js";
import { getRedis } from "../lib/redis.js";

/**
 * Thrown when a batch cannot proceed right now.
 * The worker should let BullMQ retry the job (exponential backoff)
 * instead of marking the bulk action as FAILED.
 */
export class RateLimitExceededError extends Error {
  constructor(accountId: string) {
    super(`Rate limit exceeded for account "${accountId}"`);
    this.name = "RateLimitExceededError";
  }
}

/**
 * Build a Redis key like  rate_limit:acme-corp:202604051423
 * One key per account per UTC minute.
 */
function buildKey(accountId: string, now: Date): string {
  const y = now.getUTCFullYear();
  const mo = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const h = String(now.getUTCHours()).padStart(2, "0");
  const mi = String(now.getUTCMinutes()).padStart(2, "0");
  return `rate_limit:${accountId}:${y}${mo}${d}${h}${mi}`;
}

/**
 * Check whether this account can process `count` more operations
 * in the current minute window.
 *
 * How it works:
 *   1. Read the current counter for this minute (or 0 if key doesn't exist).
 *   2. If current + count > limit  →  reject (throw).
 *   3. Otherwise increment atomically and set a 2-minute TTL on the key.
 *
 * We use a Lua script so the read-check-increment is one atomic operation.
 * No race condition even with multiple workers.
 */
const RESERVE_SCRIPT = `
  local key       = KEYS[1]
  local limit     = tonumber(ARGV[1])
  local count     = tonumber(ARGV[2])
  local ttlSec    = tonumber(ARGV[3])

  local current = tonumber(redis.call('GET', key) or '0')
  if current + count > limit then
    return 0
  end

  redis.call('INCRBY', key, count)

  -- Set TTL only on the first increment (when key was just created)
  if redis.call('TTL', key) < 0 then
    redis.call('EXPIRE', key, ttlSec)
  end

  return 1
`;

/** TTL slightly past one minute so keys self-clean even if clocks skew. */
const KEY_TTL_SECONDS = 120;

/**
 * Reserve `count` operation slots for this account in the current minute.
 *
 * Throws RateLimitExceededError if over quota  →  BullMQ retries the job.
 * Throws on Redis failure                      →  same effect (fail-closed).
 */
export async function reserveCapacity(accountId: string, count: number): Promise<void> {
  if (count <= 0) return;

  const limit = config.rateLimitPerMinute;
  if (limit <= 0) return; // 0 = rate limiting disabled

  const redis = getRedis();
  const key = buildKey(accountId, new Date());

  const allowed = await redis.eval(
    RESERVE_SCRIPT,
    1,           // number of KEYS
    key,         // KEYS[1]
    String(limit),
    String(count),
    String(KEY_TTL_SECONDS),
  );

  if (allowed !== 1) {
    throw new RateLimitExceededError(accountId);
  }
}
