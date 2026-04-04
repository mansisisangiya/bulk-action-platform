# Bulk Action Platform

A scalable bulk action platform for CRM entities, built with Node.js and TypeScript. Processes thousands of entity updates per minute with batch processing, per-entity logging, and real-time progress tracking.

## Architecture

![Architecture](docs/architecture.png)

The system separates the **API** (accepts requests, returns status) from the **Worker** (processes jobs asynchronously). This allows horizontal scaling: add more workers to handle higher throughput without affecting API latency.

![Request Flow](docs/request-flow.png)

### Key design decisions

- **Stateless API + stateless workers** — all state lives in PostgreSQL and Redis. Any API or worker instance can handle any request/job.
- **BullMQ on Redis** — reliable job queue with retries, exponential backoff, and concurrency control.
- **Batch processing** — entities are processed in configurable chunks (default 500) to manage memory and DB load.
- **Keyset pagination** — full-account scans use `WHERE id > lastId` instead of `OFFSET`, which stays fast at any table size.
- **Denormalized counters** — success/failure/skipped counts are updated per batch on the job row, so the stats API reads one row instead of counting millions of logs.
- **Handler registry** — new bulk actions are added by implementing a `BulkActionHandler` interface and registering it. No changes to the processor or API routes required.

## Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Runtime | Node.js 20+ | Required by spec |
| Language | TypeScript | Type safety, better DX |
| API | Express | Simple, mature, widely understood |
| Database | PostgreSQL | JSONB for flexible payloads, strong indexing |
| ORM | Prisma | Type-safe queries, schema-first migrations |
| Queue | BullMQ + Redis | Reliable async processing with retries |
| Validation | Zod | Runtime validation + TypeScript type inference |

## Project Structure

```
src/
├── config.ts              # Environment config
├── error.ts               # Express error-handling middleware
├── index.ts               # API server entry point
├── worker.ts              # BullMQ worker entry point
├── handlers/
│   ├── types.ts           # BulkActionHandler interface
│   ├── registry.ts        # Handler lookup by actionType + entityType
│   └── bulkUpdateContact.ts  # bulk_update:contact implementation
├── lib/
│   ├── prisma.ts          # PrismaClient singleton
│   └── redis.ts           # Redis singleton
├── queue/
│   └── bulkQueue.ts       # BullMQ queue setup + enqueue helper
├── routes/
│   └── bulkActions.ts     # Express routes for /bulk-actions
└── services/
    ├── bulkActionService.ts    # Create, list, get, stats, logs
    └── bulkActionProcessor.ts  # Core batch processing engine
```

## Prerequisites

- **Node.js** >= 20
- **Docker** (for PostgreSQL and Redis)

## Getting Started

### 1. Clone and install

```bash
git clone git@github.com:mansisisangiya/bulk-action-platform.git
cd bulk-action-platform
npm install
```

### 2. Start infrastructure

```bash
docker compose up -d
```

This starts PostgreSQL (port 5432) and Redis (port 6379) with persistent volumes.

### 3. Configure environment

```bash
cp .env.example .env
```

Default values work with the Docker setup. Edit `.env` if needed.

### 4. Run database migrations

```bash
npm run db:migrate
```

### 5. Seed demo data

```bash
npm run db:seed
```

Creates ~2500 sample contacts under `demo-account-1`.

### 6. Start the application

You need **two terminals**:

```bash
# Terminal 1 — API server
npm run dev

# Terminal 2 — Background worker
npm run dev:worker
```

API runs at `http://localhost:3000`.

## API Endpoints

### `GET /health`

Health check.

### `GET /bulk-actions/meta/handlers`

Lists all registered handlers (useful for checking extensibility).

### `POST /bulk-actions`

Create a new bulk action.

```json
{
  "accountId": "demo-account-1",
  "actionType": "bulk_update",
  "entityType": "contact",
  "payload": {
    "updates": {
      "status": "active"
    },
    "options": {
      "batchSize": 500
    }
  }
}
```

**With filtered IDs** (update specific contacts only):

```json
{
  "accountId": "demo-account-1",
  "actionType": "bulk_update",
  "entityType": "contact",
  "payload": {
    "updates": {
      "name": "Bulk Renamed"
    },
    "filter": {
      "ids": ["uuid-1", "uuid-2", "uuid-3"]
    }
  }
}
```

### `GET /bulk-actions`

List all bulk actions. Supports query params: `limit`, `offset`, `accountId`.

### `GET /bulk-actions/:id`

Get bulk action details with progress (0 to 1).

### `GET /bulk-actions/:id/stats`

Get processing statistics:

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

### `GET /bulk-actions/:id/logs`

Paginated per-entity logs. Supports query params: `status` (SUCCESS/FAILED/SKIPPED), `limit`, `offset`.

## Testing with curl

**Create a bulk action:**

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

**Check progress** (replace `<id>` with the returned id):

```bash
curl http://localhost:3000/bulk-actions/<id>
```

**Get stats:**

```bash
curl http://localhost:3000/bulk-actions/<id>/stats
```

**Get failed logs:**

```bash
curl "http://localhost:3000/bulk-actions/<id>/logs?status=FAILED"
```

## Testing with Postman

Import `postman/Bulk-Action-Platform.postman_collection.json` into Postman. The collection includes pre-configured requests for all endpoints.

## Database Schema

Three tables:

- **`bulk_actions`** — job metadata, payload (JSONB), status lifecycle, denormalized counters.
- **`bulk_action_logs`** — per-entity audit trail (SUCCESS/FAILED/SKIPPED + reason).
- **`contacts`** — sample CRM entity with unique constraint on `(account_id, email)`.

See `prisma/schema.prisma` for the full schema.

## Adding a New Bulk Action

1. Create a handler file in `src/handlers/` implementing `BulkActionHandler<TPayload>`:

```typescript
export const myHandler: BulkActionHandler<MyPayload> = {
  actionType: "my_action",
  entityType: "contact",
  validatePayload(payload) { /* Zod or manual validation */ },
  async processBatch(ctx, contacts, payload) { /* your logic */ },
};
```

2. Register it in `src/handlers/registry.ts`:

```typescript
const handlers: BulkActionHandler<unknown>[] = [
  bulkUpdateContactHandler as BulkActionHandler<unknown>,
  myHandler as BulkActionHandler<unknown>,
];
```

No changes needed in the processor, queue, routes, or service layer.

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

## Production Considerations

- **Horizontal scaling** — run multiple worker instances behind the same Redis queue; BullMQ handles job distribution.
- **Monitoring** — add Bull Board or similar for queue visibility.
- **Connection pooling** — tune Prisma's connection pool size based on worker concurrency.
