CREATE TABLE "upstream_health_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"adapter_type" text NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_failure_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"cooldown_until" timestamp with time zone,
	"cooldown_level" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'upstream_health_state_company_id_companies_id_fk') THEN
		ALTER TABLE "upstream_health_state" ADD CONSTRAINT "upstream_health_state_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "upstream_health_state_company_adapter_uq" ON "upstream_health_state" USING btree ("company_id","adapter_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "upstream_health_state_cooldown_until_idx" ON "upstream_health_state" USING btree ("cooldown_until");
