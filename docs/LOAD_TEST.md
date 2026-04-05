# Load Test Report — Bulk Action Platform

## Overview

Artillery-based load test validating the API tier's throughput, latency, and stability under
warm-up, sustained, and spike traffic patterns.

**Scope:** Single laptop, Docker Postgres/Redis, dev `npm run dev`. Good for relative numbers, not a production SLO.

**Test date:** April 2026  
**Tool:** [Artillery](https://www.artillery.io/) v2  
**Config:** [`tests/load/bulk-action.yml`](../tests/load/bulk-action.yml)  
**Raw results:** [`tests/load/report.json`](../tests/load/report.json)
[load-test](./load-test-output.png)

---

## Environment

| Component | Details |
|-----------|---------|
| API | 1 × Node.js process (`npm run dev`) |
| Worker | 1 × process, `WORKER_CONCURRENCY=4` |
| Database | PostgreSQL 16 (Docker, single instance) |
| Queue | Redis 7 (Docker, single instance) |
| Seed data | 2,500 contacts — `demo-account-1` |
| Machine | Apple M-series (ARM), local |

---

## Test Phases

```
Phase 1 — Warm-up    (30 s):   5 → 50 req/s  ramp
Phase 2 — Sustained  (60 s):  50 req/s        steady state
Phase 3 — Spike      (15 s): 200 req/s        sudden burst
```

**Scenarios (weighted):**

| Scenario | Weight | Flow |
|----------|--------|------|
| Create bulk action + poll status | 70 % | POST /bulk-actions → GET /:id → GET /:id/stats |
| List bulk actions | 20 % | GET /bulk-actions?accountId=... |
| Health check | 10 % | GET /health |

**Pass thresholds (configured in YAML):**
- p99 latency < 2,000 ms
- Error rate < 1 %

---

## Aggregate Results

| Metric | Value |
|--------|-------|
| Total HTTP requests | **16,275** |
| Virtual users completed | **6,825** |
| Virtual users failed | **0** |
| Error rate | 0 % |
| Peak request rate | **480 req/s** |
| Avg request rate | **168 req/s** |

### Response Time — All Endpoints

| Percentile | Latency |
|------------|---------|
| p50 (median) | 2 ms |
| p75 | 4 ms |
| p90 | 6 ms |
| p95 | 8.9 ms |
| **p99** | **30.3 ms** (threshold in YAML: 2,000 ms) |
| p999 | 149.9 ms |
| max | 266 ms |

---

## Per-Endpoint Breakdown

| Endpoint | p50 | p90 | p95 | p99 | Notes |
|----------|-----|-----|-----|-----|-------|
| `POST /bulk-actions` | 3 ms | 8.9 ms | 12 ms | 43 ms | Heaviest — DB write + Redis enqueue |
| `GET /bulk-actions/:id` | 2 ms | 5 ms | 7 ms | 27 ms | Single DB read |
| `GET /bulk-actions/:id/stats` | 2 ms | 4 ms | 6 ms | 17 ms | Aggregated counts |
| `GET /health` | 1 ms | 4 ms | 5 ms | 21 ms | Queue depth from Redis |

---

## Phase-by-Phase Analysis

### Phase 1 — Warm-up (5 → 50 req/s)

- RPS ramp: 20 → 75 req/s observed
- p99: 12–22 ms
- Zero failures — cold-start handled cleanly

### Phase 2 — Sustained (50 req/s)

- RPS: ~120 req/s (each virtual user makes 3 sequential requests)
- p99: consistently 8–14 ms across all 10-second windows
- Latency was **stable** — no degradation over the 60-second window

### Phase 3 — Spike (200 req/s)

- Peak RPS reached: **480 req/s**
- p99 briefly reached **102 ms** at the transition into the spike (DB connection pool contention)
- Recovered to **24 ms** within the next 10-second window at full 480 req/s
- Zero failures throughout

The transient p99 spike at phase transition is expected: the PostgreSQL connection pool
momentarily contended as concurrency jumped from ~50 to ~200 virtual users. The queue
absorbed the burst without dropping any jobs.

---

## Capacity Conclusions

### API tier

Only **one** API process was measured (~480 req/s peak in this run). Extra replicas usually add throughput until something else caps out (Postgres writes, Redis, network); the table below is **not** measured — rough order of magnitude for interviews only.

| Replicas | Rough RPS (guess) | Eventual bottleneck |
|----------|-------------------|---------------------|
| 1 | ~480 (observed) | Single Node event loop |
| 2+ | sub-linear to linear | Postgres / Redis |

### Worker tier

This Artillery scenario mostly hits **create + poll**, not sustained entity processing at max rate. We did **not** separately stress-test “N workers × M concurrent jobs × full DB write volume.” More worker processes do add parallel **jobs**; BullMQ assigns each job once. Throughput still hits **per-account rate limits** and DB limits.

### Production

Single PostgreSQL: ~2,000–5,000 contact writes/second.  
Mitigation: PgBouncer connection pooling + read replicas.

---

## How to Reproduce

```bash
# 1. Start infrastructure
docker-compose up -d

# 2. Start API and worker (separate terminals)
npm run dev
npm run dev:worker

# 3. Seed test data
npm run db:seed

# 4. Run load test (CLI output)
npm run load:test

# 5. Run with HTML report
npm run load:test:report
open tests/load/report.json.html
```

---

## Relation to TECH_DESIGN.md

[`TECH_DESIGN.md`](./TECH_DESIGN.md) §8 states what we **measured** (API via this doc) vs what we **did not** (full worker saturation). This run shows the API can accept and enqueue quickly; the queue buffers when workers fall behind. Per-account `RATE_LIMIT_PER_MINUTE` still caps how fast entities can be processed over time.
