ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "issues_created_count" integer DEFAULT 0 NOT NULL;
