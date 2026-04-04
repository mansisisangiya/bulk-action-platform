-- CreateEnum
CREATE TYPE "BulkActionStatus" AS ENUM ('QUEUED', 'SCHEDULED', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "LogStatus" AS ENUM ('SUCCESS', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "bulk_actions" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "action_type" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "status" "BulkActionStatus" NOT NULL DEFAULT 'QUEUED',
    "payload" JSONB NOT NULL,
    "scheduled_at" TIMESTAMP(3),
    "total_count" INTEGER NOT NULL DEFAULT 0,
    "processed_count" INTEGER NOT NULL DEFAULT 0,
    "success_count" INTEGER NOT NULL DEFAULT 0,
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_count" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "bulk_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bulk_action_logs" (
    "id" TEXT NOT NULL,
    "bulk_action_id" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "status" "LogStatus" NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bulk_action_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "age" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bulk_actions_account_id_created_at_idx" ON "bulk_actions"("account_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "bulk_actions_status_idx" ON "bulk_actions"("status");

-- CreateIndex
CREATE INDEX "bulk_action_logs_bulk_action_id_status_idx" ON "bulk_action_logs"("bulk_action_id", "status");

-- CreateIndex
CREATE INDEX "bulk_action_logs_bulk_action_id_created_at_idx" ON "bulk_action_logs"("bulk_action_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_account_id_email_key" ON "contacts"("account_id", "email");

-- CreateIndex
CREATE INDEX "contacts_account_id_idx" ON "contacts"("account_id");

-- AddForeignKey
ALTER TABLE "bulk_action_logs" ADD CONSTRAINT "bulk_action_logs_bulk_action_id_fkey" FOREIGN KEY ("bulk_action_id") REFERENCES "bulk_actions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
