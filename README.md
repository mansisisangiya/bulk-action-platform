# Bulk Action Platform

A scalable bulk action engine for CRM entities. Accepts a request, queues it, and processes thousands of entity updates asynchronously with real-time progress, per-entity audit logs, rate limiting, and scheduled execution.

> **Architecture & design decisions** → [TECH_DESIGN.md](./docs/TECH_DESIGN.md)

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20+ / TypeScript |
| API | Express |
| Queue | BullMQ + Redis |
| Database | PostgreSQL (Prisma ORM) |
| Validation | Zod |

---

## Quick Start

**Prerequisites:** Node.js ≥ 20 and Docker.

```bash
# 1. Clone the repository
git clone https://github.com/mansisisangiya/bulk-action-platform.git
cd bulk-action-platform

# 2. Install dependencies
npm install

# 3. Start PostgreSQL + Redis
docker compose up -d

# 4. Copy environment file (defaults work out of the box)
cp .env.example .env

# 5. Run migrations and seed ~2500 demo contacts
npm run db:migrate
npm run db:seed

# 6. Start API server (Terminal 1)
npm run dev

# 7. Start background worker (Terminal 2)
npm run dev:worker
```

API is available at `http://localhost:3000`.

---

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check + queue depth |
| `POST` | `/bulk-actions` | Create a bulk action |
| `GET` | `/bulk-actions` | List all bulk actions |
| `GET` | `/bulk-actions/:id` | Get status + progress |
| `GET` | `/bulk-actions/:id/stats` | Success/failure/skipped counts |
| `GET` | `/bulk-actions/:id/logs` | Per-entity audit logs (paginated) |
| `GET` | `/bulk-actions/meta/handlers` | List registered action handlers |

### Create a Bulk Action

```bash
curl -X POST http://localhost:3000/bulk-actions \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": "demo-account-1",
    "actionType": "bulk_update",
    "entityType": "contact",
    "payload": {
      "updates": { "status": "active" }
    }
  }'
```

**Update specific contacts only** (pass `filter.ids`):

```json
{
  "accountId": "demo-account-1",
  "actionType": "bulk_update",
  "entityType": "contact",
  "payload": {
    "updates": { "name": "Renamed" },
    "filter": { "ids": ["uuid-1", "uuid-2"] }
  }
}
```

**Schedule for a future time** (pass `scheduledAt` in ISO 8601):

```json
{
  "accountId": "demo-account-1",
  "actionType": "bulk_update",
  "entityType": "contact",
  "scheduledAt": "2025-11-22T23:15:00.000Z",
  "payload": { "updates": { "status": "inactive" } }
}
```

### Poll Progress

```bash
curl http://localhost:3000/bulk-actions/<id>
# returns: { "status": "RUNNING", "progress": 0.42, ... }
```

### Get Stats

```bash
curl http://localhost:3000/bulk-actions/<id>/stats
```

```json
{
  "bulkActionId": "...",
  "totalCount": 2500,
  "processedCount": 2500,
  "successCount": 2480,
  "failureCount": 5,
  "skippedCount": 15,
  "status": "COMPLETED"
}
```

### Get Per-Entity Logs

```bash
# Filter by status: SUCCESS | FAILED | SKIPPED
curl "http://localhost:3000/bulk-actions/<id>/logs?status=FAILED&limit=50"
```

---

## Postman Collection

Import `postman/Bulk-Action-Platform.postman_collection.json` into Postman. All endpoints are pre-configured with example payloads.

> [postman-list.png](./docs/postman-list.png)

---

## Project Structure

```
src/
├── index.ts                        # API server entry point
├── worker.ts                       # BullMQ worker entry point
├── config.ts                       # Environment config
├── constants.ts                    # Shared constants
├── error.ts                        # Express error-handling middleware
├── handlers/
│   ├── types.ts                    # BulkActionHandler interface
│   ├── registry.ts                 # Handler lookup by actionType + entityType
│   └── bulkUpdateContact.ts        # bulk_update:contact implementation
├── controllers/
│   └── BulkActionController.ts     # Route handlers
├── middleware/
│   └── requestLogger.ts            # Structured request logging
├── repositories/
│   └── EntityRepository.ts         # DB access abstraction for entity types
├── lib/
│   ├── prisma.ts                   # PrismaClient singleton
│   └── redis.ts                    # Redis singleton
├── queue/
│   └── bulkQueue.ts                # BullMQ queue setup + enqueue helper
├── routes/
│   └── bulkActions.ts              # Express routes
├── services/
│   ├── bulkActionService.ts        # Create, list, get, stats, logs
│   ├── bulkActionProcessor.ts      # Core batch processing engine
│   └── rateLimit.ts                # Redis-based per-account rate limiter
└── utils/
    └── logger.ts                   # Structured JSON logger
```

---

## Available Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start API server with hot reload |
| `npm run dev:worker` | Start worker with hot reload |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled API server |
| `npm run start:worker` | Run compiled worker |
| `npm run db:migrate` | Run Prisma migrations |
| `npm run db:seed` | Seed database with demo contacts |
| `npm run db:studio` | Open Prisma Studio (DB browser) |

---

## Adding a New Bulk Action

1. Create `src/handlers/myHandler.ts` implementing `BulkActionHandler<TPayload>`.
2. Register it in `src/handlers/registry.ts`.

No changes to routes, processor, or service layer. See [TECH_DESIGN.md → Extensibility](./TECH_DESIGN.md#extensibility--handler-registry) for details.

---

## Running Tests

```bash
npm test
```

Tests cover the rate limiter (Lua script correctness), batch processor logic, and handler registry.
