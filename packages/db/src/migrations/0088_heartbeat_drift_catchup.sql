-- Heartbeat issue cascade cap counter + idempotent catch-up for 0085/0086 drift.
-- The catch-up clauses use IF NOT EXISTS so the migration is safe on databases
-- that already had 0085 and 0086 applied (the columns and FK already exist).
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "locked_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "locked_by_user_id" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "issues_created_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN IF NOT EXISTS "routine_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "env" jsonb;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_locked_by_agent_id_agents_id_fk') THEN
    ALTER TABLE "documents" ADD CONSTRAINT "documents_locked_by_agent_id_agents_id_fk" FOREIGN KEY ("locked_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routine_runs_routine_revision_id_routine_revisions_id_fk') THEN
    ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_routine_revision_id_routine_revisions_id_fk" FOREIGN KEY ("routine_revision_id") REFERENCES "public"."routine_revisions"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routine_runs_revision_idx" ON "routine_runs" USING btree ("routine_revision_id");
