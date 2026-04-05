# Technical Design — Bulk Action Platform

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [High-Level Design (HLD)](#2-high-level-design-hld)
3. [Low-Level Design (LLD)](#3-low-level-design-lld)
4. [Request Flow](#4-request-flow)
5. [Technology Choices & Trade-offs](#5-technology-choices--trade-offs)
6. [Key Design Decisions](#6-key-design-decisions)
7. [Extensibility — Handler Registry](#7-extensibility--handler-registry)
8. [Scaling Strategy](#8-scaling-strategy)
9. [What I Would Do With More Time](#9-what-i-would-do-with-more-time)

---

## 1. Problem Statement

CRM platforms need to apply the same operation (e.g. update a field, tag contacts, send an email) to thousands — sometimes millions — of entities at once. Doing this synchronously in an HTTP request is not viable:

- It blocks a thread for minutes.
- The client may time out and re-submit, causing duplicates.
- A single failure shouldn't abort the entire job.
- The client needs to know what happened to each individual entity.

**In scope for this project:**

- Accept a bulk action request and return immediately with a job ID.
- Process entities asynchronously in the background.
- Track progress in real time (progress %, counts).
- Log the outcome (SUCCESS / FAILED / SKIPPED) for every entity.
- Support selective updates (specific IDs) and full-account scans.
- Enforce a per-account rate limit to protect shared infrastructure.
- Support scheduling a job to run at a future time.
- Be extensible: adding a new action type must not require touching core infrastructure.

---

## 2. High-Level Design (HLD)

### System Components

```
┌──────────────────────────────────────────────────────────────────┐
│                          Client (HTTP)                           │
└───────────────────────────────┬──────────────────────────────────┘
                                │ POST /bulk-actions
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│                         API Server                               │
│  Express · Zod validation · Handler registry check              │
│  Returns 201 { id } immediately                                  │
└────────────────┬─────────────────────────────┬───────────────────┘
                 │ persist job row              │ enqueue job
                 ▼                             ▼
┌───────────────────────┐      ┌──────────────────────────────────┐
│      PostgreSQL       │      │      Redis (BullMQ Queue)        │
│  bulk_actions         │      │  queue: "bulk-actions"           │
│  bulk_action_logs     │      │  job data: { bulkActionId }      │
│  contacts             │      │  retries: 3, exponential backoff │
└───────────────────────┘      └──────────────┬───────────────────┘
                                              │ dequeue
                                              ▼
                               ┌──────────────────────────────────┐
                               │         Worker Process           │
                               │  BullMQ Worker · concurrency=4   │
                               │  ┌─────────────────────────────┐ │
                               │  │   Batch Processor           │ │
                               │  │   ├─ keyset pagination      │ │
                               │  │   ├─ handler dispatch       │ │
                               │  │   ├─ rate limit check       │ │
                               │  │   └─ persist logs + counts  │ │
                               │  └─────────────────────────────┘ │
                               └──────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility |
|-----------|---------------|
| **API Server** | Validate input, persist job to DB, enqueue job to Redis, return job ID immediately |
| **PostgreSQL** | Single source of truth for job state, counters, logs, and entity data |
| **Redis / BullMQ** | Durable job queue with retries, delays, and at-least-once delivery |
| **Worker** | Pull jobs from queue, run the batch processor, update job status |
| **Batch Processor** | Iterate over entities in chunks, call the appropriate handler, persist outcomes |
| **Handler Registry** | Map (actionType, entityType) → BulkActionHandler implementation |
| **Rate Limiter** | Atomic per-account, per-minute counter in Redis using a Lua script |

### Separation of Concerns

The API and worker are **two separate processes**. The API validates input, persists the job row, and enqueues work; the worker runs batch processing and handlers. The worker does not serve HTTP. Shared state is PostgreSQL and Redis, so you can run multiple API or worker processes pointed at the same backing services.

---

## 3. Low-Level Design (LLD)

### 3.1 Database Schema

```sql
-- Job metadata and counters (one row per bulk action)
CREATE TABLE bulk_actions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      TEXT NOT NULL,
  action_type     TEXT NOT NULL,
  entity_type     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'QUEUED',  -- QUEUED | SCHEDULED | RUNNING | COMPLETED | FAILED
  payload         JSONB NOT NULL,
  scheduled_at    TIMESTAMPTZ,
  total_count     INT NOT NULL DEFAULT 0,
  processed_count INT NOT NULL DEFAULT 0,
  success_count   INT NOT NULL DEFAULT 0,
  failure_count   INT NOT NULL DEFAULT 0,
  skipped_count   INT NOT NULL DEFAULT 0,
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ
);

CREATE INDEX idx_bulk_actions_account ON bulk_actions(account_id, created_at DESC);
CREATE INDEX idx_bulk_actions_status  ON bulk_actions(status);

-- Per-entity audit trail (one row per entity per job)
CREATE TABLE bulk_action_logs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bulk_action_id UUID NOT NULL REFERENCES bulk_actions(id) ON DELETE CASCADE,
  entity_id      TEXT NOT NULL,
  entity_type    TEXT NOT NULL,
  status         TEXT NOT NULL,  -- SUCCESS | FAILED | SKIPPED
  reason         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_logs_action_status ON bulk_action_logs(bulk_action_id, status);
CREATE INDEX idx_logs_action_time   ON bulk_action_logs(bulk_action_id, created_at);

-- Sample CRM entity
CREATE TABLE contacts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id TEXT NOT NULL,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  age        INT,
  status     TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(account_id, email)
);

CREATE INDEX idx_contacts_account ON contacts(account_id);
```

**Design rationale:**
- `payload` is `JSONB` — each action type carries its own schema without requiring schema migrations per new action type.
- Counters (`success_count`, `failure_count`, etc.) are denormalized onto the job row and incremented per batch, so the stats API reads one row instead of aggregating over potentially millions of log rows.
- Cascade delete on logs — dropping a bulk action cleans up all its logs.
- Compound index on `(bulk_action_id, status)` makes filtered log queries (e.g. show only failures) efficient.

### 3.2 BulkActionHandler Interface

Every action type implements one interface. The processor calls it; the processor never knows what the action does.

```typescript
export interface BulkActionHandler<TPayload = unknown> {
  readonly actionType: string;   // e.g. "bulk_update"
  readonly entityType: string;   // e.g. "contact"

  // Validates + parses the raw JSONB payload at creation time and again at processing time.
  validatePayload(payload: unknown): TPayload;

  // Optional: initialise cross-batch state (e.g. a dedup Set).
  // The processor is unaware of its shape.
  createState?(): unknown;

  // Called once per batch. Returns one log entry per entity.
  processBatch(
    ctx: HandlerContext,
    entities: EntityRow[],
    payload: TPayload,
    state: unknown,
  ): Promise<BatchLogEntry[]>;
}
```

`EntityRow` is a thin wrapper (`{ id, accountId, ...data }`). Handlers cast to their concrete type internally, keeping the processor generic.

### 3.3 Batch Processor

```
processBulkAction(bulkActionId)
│
├─ Load job row from DB
├─ Validate payload via handler
├─ Mark status = RUNNING
│
├─ if filter.ids provided  ──►  processFilteredIds()
│     ├─ Slice ids into chunks of batchSize
│     ├─ For each chunk:
│     │   ├─ SELECT WHERE id IN (chunk) AND account_id = :accountId
│     │   ├─ IDs not found → SKIPPED log entries
│     │   ├─ reserveCapacity(accountId, skipLogs + entities)   ← rate limit gate
│     │   └─ handler.processBatch(entities)
│     └─ persistLogsAndCounts()                      ← atomic transaction
│
└─ if no filter  ────────────►  processFullScan()
      ├─ COUNT(*) → set totalCount
      ├─ Cursor = undefined
      └─ loop:
          ├─ SELECT ... WHERE account_id = :id AND id > cursor ORDER BY id LIMIT batchSize
          ├─ break if empty
          ├─ reserveCapacity(accountId, page.length)
          ├─ handler.processBatch(page)
          ├─ persistLogsAndCounts()
          └─ cursor = last row id
```

**`persistLogsAndCounts` is a single DB transaction:**
```sql
BEGIN;
  INSERT INTO bulk_action_logs (...) VALUES ...;  -- bulk insert all entries
  UPDATE bulk_actions
    SET processed_count = processed_count + N,
        success_count   = success_count + S,
        failure_count   = failure_count + F,
        skipped_count   = skipped_count + K
    WHERE id = :bulkActionId;
COMMIT;
```

This ensures logs and counters are always consistent, even if the worker crashes mid-batch.

### 3.4 Rate Limiter

A Redis-based counter tracks how many entities each account has processed in the current minute. If the limit is exceeded, a `RateLimitExceededError` is thrown — the worker does **not** mark the job as FAILED, it re-throws so BullMQ retries with exponential backoff. The job picks up again in the next minute window automatically.

Default limit: **10,000 entity operations per account per minute** (configurable via `RATE_LIMIT_PER_MINUTE` env var).

### 3.5 Scheduled Jobs

When `scheduledAt` is provided:
- If more than ~1.5 seconds in the future → status is `SCHEDULED`, and BullMQ receives a `delay` in milliseconds. (Times closer than this run immediately to avoid flaky sub-second delays.)
- BullMQ holds the job in a `delayed` state and moves it to `waiting` at the scheduled time.
- The `/health` endpoint exposes the `delayed` queue count, so a scheduler can observe upcoming work.

---

## 4. Request Flow

### 4.1 Create a Bulk Action

```
Client                    API Server                  PostgreSQL       Redis
  │                           │                           │               │
  │── POST /bulk-actions ─────►│                           │               │
  │                           │── validateBody(Zod) ──────►│               │
  │                           │── getHandler(type) ────────►               │
  │                           │── handler.validatePayload()│               │
  │                           │                           │               │
  │                           │── INSERT bulk_actions ────►│               │
  │                           │◄─ { id } ─────────────────│               │
  │                           │                           │               │
  │                           │── queue.add({ bulkActionId, delay? }) ────►│
  │                           │                           │               │
  │◄─── 201 { id, status: "QUEUED" } ──────────────────────               │
```

Typical create latency: one DB insert + one Redis enqueue (exact ms depends on machine and load).

### 4.2 Worker Processing

```
Redis                    Worker                     PostgreSQL
  │                         │                           │
  │─ dequeue job ──────────►│                           │
  │                         │── SELECT bulk_actions ───►│
  │                         │── UPDATE status=RUNNING ─►│
  │                         │                           │
  │                         │  [ for each batch ]       │
  │                         │── SELECT entities ────────►│
  │                         │── reserveCapacity(Redis)   │
  │                         │── handler.processBatch()   │
  │                         │                           │
  │                         │── BEGIN TRANSACTION ──────►│
  │                         │── INSERT logs ────────────►│
  │                         │── UPDATE counters ─────────►│
  │                         │── COMMIT ──────────────────►│
  │                         │                           │
  │                         │  [ loop until no more rows ]
  │                         │                           │
  │                         │── UPDATE status=COMPLETED ►│
  │─ ack job ───────────────│                           │
```

### 4.3 Client Polling for Progress

```
Client                    API Server                  PostgreSQL
  │                           │                           │
  │── GET /bulk-actions/:id ──►│                           │
  │                           │── SELECT bulk_actions ───►│
  │                           │◄─ { status, processedCount, totalCount } ─│
  │◄── { progress: 0.42 } ───│                           │
  │                           │                           │
  │  (repeat every N seconds) │                           │
```

`progress = processedCount / totalCount` — computed on read, stored as a ratio in the response. No dedicated progress table needed.

---

## 5. Technology Choices & Trade-offs

### 5.1 BullMQ + Redis vs. Alternatives

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| **BullMQ + Redis** | Mature Node.js-native library; delayed/scheduled jobs built in; at-least-once delivery; dashboard (Bull Board) available; easy local dev | Requires Redis; single queue broker is a potential SPOF (mitigated with Redis Sentinel/Cluster) | **Chosen** |
| SQS + Lambda | Fully managed; massive scale | No free-tier locally; vendor lock-in; cold-start latency; complex local dev | Overkill for this stage |
| Kafka | Extremely high throughput; replay semantics | Operational complexity; consumer group management; too heavy for this use case | Overkill |
| In-memory queue | Zero dependencies | Lost on restart; no multi-replica support | Not acceptable |

### 5.2 PostgreSQL vs. MongoDB

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| **PostgreSQL** | ACID transactions (critical for log + counter atomicity); strong indexing; JSONB for flexible payloads; known quantity | Row-level locking under high write concurrency (mitigated by batch writes) | **Chosen** |
| MongoDB | Flexible schema; native JSON | Weaker transaction semantics (multi-document); less mature for relational joins | Not needed |
| DynamoDB | Managed; auto-scaling | No joins; complex access patterns; vendor lock-in | Overkill |

### 5.3 Keyset Pagination vs. OFFSET

Entities are paged with `WHERE id > lastId ORDER BY id LIMIT N` instead of `OFFSET`. OFFSET gets slower as the table grows because the DB scans and discards all previous rows — keyset avoids that and stays fast at any scale.

### 5.4 Denormalized Counters vs. COUNT Aggregation

| Option | Description | Trade-off |
|--------|-------------|-----------|
| **Denormalized** | Increment `success_count`, `failure_count`, `skipped_count` on the job row per batch | Stats API reads one row — O(1). Risk: counter drift if a transaction partially fails (mitigated by atomic `BEGIN; INSERT logs; UPDATE counters; COMMIT`). **Chosen.** |
| COUNT on read | `SELECT COUNT(*) FROM logs WHERE bulk_action_id = :id AND status = 'SUCCESS'` | Always accurate, but O(N) where N can be millions. Unacceptable at scale. |

### 5.5 Zod for Validation

Every handler's `validatePayload` uses Zod. This gives:
- Runtime validation at both API ingestion and job processing time.
- TypeScript type inference from the schema — no duplicated type declarations.
- Clear error messages surfaced to the API caller.

### 5.6 Prisma ORM

- **Schema-first**: `prisma/schema.prisma` is the single source of truth for DB shape and TS types.
- Migration history is tracked in `prisma/migrations/`, making schema evolution safe and auditable.
- The PrismaClient is a singleton to prevent connection pool exhaustion across batch iterations.

---

## 6. Key Design Decisions

### Idempotent Job Enqueueing

`enqueueBulkAction` uses `jobId: bulkActionId` when calling `queue.add(...)`. BullMQ deduplicates by `jobId` — if the API crashes after writing to PostgreSQL but before the queue.add completes and is retried, the same job ID is used and no duplicate job is created.

### Handler Validates Payload Twice

The handler's `validatePayload` is called at **creation time** (API) and again at **processing time** (worker). This is intentional:
- Catches bad payloads before they waste queue slots.
- Guards against payload format changes between schema versions if a job is long-queued.

### Rate Limit → Retry, Not Fail

When the per-account rate limit is exceeded mid-batch, `RateLimitExceededError` is thrown. The worker **re-throws** without marking the bulk action `FAILED`. BullMQ retries with exponential backoff (2 s, 4 s, 8 s). The client keeps seeing `RUNNING` / progress until the job finishes or hits a real failure.

### Worker Concurrency is Tunable Per Replica

`WORKER_CONCURRENCY` (default: 4) sets how many jobs one worker process runs in parallel. N worker processes with the same Redis queue give up to N × concurrency parallel jobs (BullMQ assigns each job to one worker).

### No Custom Scheduler Process

Scheduled jobs use BullMQ's `delay`. No separate cron service — Redis holds delayed jobs until they move to `waiting`.

### Row updates: sequential vs `Promise.all`

Per-row work inside `processBatch` is **sequential** for the contact handler when it needs dedupe-by-email or per-row error handling. **`Promise.all`** is used in `listBulkActionLogs` only to run `findMany` and `count` in parallel (independent reads).

---

## 7. Extensibility — Handler Registry

For a new action, you add a handler and register it — no changes to routes, queue setup, or processor wiring.

**Step 1: Implement the interface**

```typescript
// src/handlers/bulkTagContact.ts (sketch — match signatures in ./types.ts)
import { z } from "zod";
import type { BulkActionHandler, BatchLogEntry, EntityRow, HandlerContext } from "./types.js";

const schema = z.object({ tags: z.array(z.string()).min(1) });
type Payload = z.infer<typeof schema>;

export const bulkTagContactHandler: BulkActionHandler<Payload> = {
  actionType: "bulk_tag",
  entityType: "contact",

  validatePayload(raw: unknown) {
    return schema.parse(raw);
  },

  async processBatch(
    ctx: HandlerContext,
    entities: EntityRow[],
    payload: Payload,
    _state: unknown,
  ): Promise<BatchLogEntry[]> {
    // …call ctx.entityRepository / your logic…
    return entities.map((c) => ({
      entityId: c.id,
      entityType: "contact",
      status: "SUCCESS" as const,
    }));
  },
};
```

**Step 2: Register it**

```typescript
// src/handlers/registry.ts
import { bulkTagContactHandler } from "./bulkTagContact.js";

const handlers = [
  bulkUpdateContactHandler,
  bulkTagContactHandler,   // ← add this line
];
```

The processor, routes, queue, and service layer are untouched.

---

## 8. Scaling Strategy

### Current Baseline (Single Node)

- 1 API process, 1 Worker process, 1 PostgreSQL, 1 Redis.
- Worker concurrency = 4 → 4 jobs processed in parallel.
- Each job processes entities in batches of 500.
- Effective throughput: ~10,000 entity operations/minute/account (rate limit ceiling).

### Horizontal Worker Scaling

```
Redis Queue
    │
    ├─► Worker Replica 1  (concurrency=4)
    ├─► Worker Replica 2  (concurrency=4)
    ├─► Worker Replica 3  (concurrency=4)
    └─► Worker Replica N  (concurrency=4)
```

BullMQ hands each job to one worker; start more worker processes (same `REDIS_URL` and queue name) to add capacity.

**In Kubernetes:**
```yaml
# Worker Deployment — scale horizontally
spec:
  replicas: 10          # scale based on queue depth metric
  containers:
  - name: worker
    env:
    - name: WORKER_CONCURRENCY
      value: "4"
```

**Queue-depth-based autoscaling**: The `/health` endpoint exposes `queue.waiting`. A Kubernetes HPA (or KEDA) can use this metric to scale worker replicas up when the queue grows and back down when it empties.

### Database Scaling

The current setup runs a single PostgreSQL instance — sufficient for this scale. When write traffic grows, the first step is adding a read replica so status/log queries don't compete with writes. Connection pooling and partitioning are options further down the road.

### Redis Scaling

Redis can be upgraded to a Sentinel setup (automatic failover) or Cluster (horizontal scale) if the queue volume grows. BullMQ supports both — no code changes needed, just a config update.

### Throughput — measured vs not measured

The **API** tier was exercised with Artillery on a **local** machine (1 API process, 1 worker, Docker Postgres/Redis). See [`LOAD_TEST.md`](./LOAD_TEST.md) for numbers — peak observed **~480 req/s** with **0% errors** in that run. 

The **worker** tier was **not** given a comparable load test in this repo. Real entity throughput depends on:

- `defaultBatchSize` / payload `batchSize`
- Handler path: `bulkUpdateContact` uses **`updateMany` per batch** when the payload does **not** touch unique fields (e.g. email); otherwise **per-row** `update` for correct SKIPPED/FAILED logs on constraint violations
- `RATE_LIMIT_PER_MINUTE` per account (hard ceiling on entity operations over time)
- DB and connection pool limits

Adding worker replicas increases how many **jobs** run in parallel; it does not bypass per-account rate limits.

---

## 9. What I Would Do With More Time

| Area | Enhancement |
|------|-------------|
| **Observability** | Add Bull Board UI for queue visibility; emit OpenTelemetry spans per batch; expose Prometheus metrics (queue depth, job duration p95, error rate) |
| **Job Cancellation** | `PATCH /bulk-actions/:id { "status": "CANCELLED" }` — mark the job row, check the flag at the start of each batch, stop processing gracefully |
| **Dead-Letter Handling** | Move permanently failed jobs to a DLQ table; expose a retry API |
| **Webhook Notifications** | Call a client-provided `callbackUrl` when a job completes or fails, so clients don't need to poll |
| **Idempotency Keys** | Accept `X-Idempotency-Key` header; deduplicate create requests within a TTL window |
| **Auth & Multi-tenancy** | JWT auth middleware; validate that the caller's `sub` matches the `accountId` in the request |
| **Pagination on List** | Cursor-based pagination on `GET /bulk-actions` (currently uses OFFSET) |
| **Config Validation** | Validate all env vars at startup and fail fast with a clear error rather than crashing at runtime |
| **Integration Tests** | Spin up real PostgreSQL + Redis in CI (e.g. via `testcontainers`) and run end-to-end flow tests |
