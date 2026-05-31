CREATE TABLE "execution_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"pipeline_run_id" uuid NOT NULL,
	"test_run_id" uuid,
	"test_asset_id" uuid,
	"engine" text,
	"binary_profile" text,
	"workspace_ref" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"exit_code" integer,
	"peak_vus" integer,
	"total_iterations" integer,
	"total_requests" integer,
	"stdout_ref" uuid,
	"live_metric_feed" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gate_resolutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"pipeline_run_id" uuid NOT NULL,
	"test_run_id" uuid,
	"outcome" text NOT NULL,
	"ci_signal" text NOT NULL,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sla_verdicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"pipeline_run_id" uuid NOT NULL,
	"execution_run_id" uuid,
	"test_run_id" uuid,
	"sla_target_id" text NOT NULL,
	"workflow_name" text,
	"phase" text,
	"metric" text,
	"operator" text,
	"threshold" real,
	"actual_value" real,
	"evaluation_window" jsonb,
	"source" text,
	"status" text NOT NULL,
	"evaluated_on_success_only" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_run_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"pipeline_run_id" uuid NOT NULL,
	"execution_run_id" uuid,
	"test_run_id" uuid,
	"artifact_type" text NOT NULL,
	"storage_ref" text NOT NULL,
	"url" text,
	"content_type" text,
	"size_bytes" integer,
	"publish_status" text DEFAULT 'stored' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "execution_runs" ADD CONSTRAINT "execution_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_runs" ADD CONSTRAINT "execution_runs_pipeline_run_id_pipeline_runs_id_fk" FOREIGN KEY ("pipeline_run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_runs" ADD CONSTRAINT "execution_runs_test_run_id_test_runs_id_fk" FOREIGN KEY ("test_run_id") REFERENCES "public"."test_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_runs" ADD CONSTRAINT "execution_runs_test_asset_id_test_assets_id_fk" FOREIGN KEY ("test_asset_id") REFERENCES "public"."test_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_runs" ADD CONSTRAINT "execution_runs_stdout_ref_test_run_artifacts_id_fk" FOREIGN KEY ("stdout_ref") REFERENCES "public"."test_run_artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_resolutions" ADD CONSTRAINT "gate_resolutions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_resolutions" ADD CONSTRAINT "gate_resolutions_pipeline_run_id_pipeline_runs_id_fk" FOREIGN KEY ("pipeline_run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_resolutions" ADD CONSTRAINT "gate_resolutions_test_run_id_test_runs_id_fk" FOREIGN KEY ("test_run_id") REFERENCES "public"."test_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_verdicts" ADD CONSTRAINT "sla_verdicts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_verdicts" ADD CONSTRAINT "sla_verdicts_pipeline_run_id_pipeline_runs_id_fk" FOREIGN KEY ("pipeline_run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_verdicts" ADD CONSTRAINT "sla_verdicts_execution_run_id_execution_runs_id_fk" FOREIGN KEY ("execution_run_id") REFERENCES "public"."execution_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_verdicts" ADD CONSTRAINT "sla_verdicts_test_run_id_test_runs_id_fk" FOREIGN KEY ("test_run_id") REFERENCES "public"."test_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_run_artifacts" ADD CONSTRAINT "test_run_artifacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_run_artifacts" ADD CONSTRAINT "test_run_artifacts_pipeline_run_id_pipeline_runs_id_fk" FOREIGN KEY ("pipeline_run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_run_artifacts" ADD CONSTRAINT "test_run_artifacts_execution_run_id_execution_runs_id_fk" FOREIGN KEY ("execution_run_id") REFERENCES "public"."execution_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_run_artifacts" ADD CONSTRAINT "test_run_artifacts_test_run_id_test_runs_id_fk" FOREIGN KEY ("test_run_id") REFERENCES "public"."test_runs"("id") ON DELETE set null ON UPDATE no action;