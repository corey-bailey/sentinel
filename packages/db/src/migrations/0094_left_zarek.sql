ALTER TABLE "baselines" ADD COLUMN "baseline_set_id" uuid;--> statement-breakpoint
ALTER TABLE "metric_series" ADD COLUMN "execution_run_id" uuid;--> statement-breakpoint
ALTER TABLE "metric_series" ADD COLUMN "workflow_name" text;--> statement-breakpoint
ALTER TABLE "metric_series" ADD COLUMN "phase" text;--> statement-breakpoint
ALTER TABLE "metric_series" ADD COLUMN "digest" jsonb;--> statement-breakpoint
ALTER TABLE "metric_series" ADD COLUMN "sample_count" integer;--> statement-breakpoint
ALTER TABLE "regressions" ADD COLUMN "pipeline_run_id" uuid;--> statement-breakpoint
ALTER TABLE "regressions" ADD COLUMN "direction" text;--> statement-breakpoint
ALTER TABLE "test_assets" ADD COLUMN "protocol" text;--> statement-breakpoint
ALTER TABLE "test_assets" ADD COLUMN "data_files" jsonb;--> statement-breakpoint
ALTER TABLE "test_assets" ADD COLUMN "setup_script" text;--> statement-breakpoint
ALTER TABLE "test_assets" ADD COLUMN "teardown_script" text;--> statement-breakpoint
ALTER TABLE "test_assets" ADD COLUMN "generated_from" text;--> statement-breakpoint
ALTER TABLE "test_assets" ADD COLUMN "source_ref" jsonb;--> statement-breakpoint
ALTER TABLE "test_plans" ADD COLUMN "requirements_document_id" uuid;--> statement-breakpoint
ALTER TABLE "test_plans" ADD COLUMN "execution_model" text;--> statement-breakpoint
ALTER TABLE "test_runs" ADD COLUMN "pipeline_run_id" uuid;--> statement-breakpoint
ALTER TABLE "metric_series" ADD CONSTRAINT "metric_series_execution_run_id_execution_runs_id_fk" FOREIGN KEY ("execution_run_id") REFERENCES "public"."execution_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regressions" ADD CONSTRAINT "regressions_pipeline_run_id_pipeline_runs_id_fk" FOREIGN KEY ("pipeline_run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_plans" ADD CONSTRAINT "test_plans_requirements_document_id_requirements_documents_id_fk" FOREIGN KEY ("requirements_document_id") REFERENCES "public"."requirements_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_pipeline_run_id_pipeline_runs_id_fk" FOREIGN KEY ("pipeline_run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE set null ON UPDATE no action;