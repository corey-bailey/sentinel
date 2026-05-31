CREATE TABLE "pipeline_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"test_plan_id" uuid,
	"pipeline_request_id" uuid,
	"requirements_document_id" uuid,
	"trigger" jsonb NOT NULL,
	"stages" jsonb NOT NULL,
	"verdict" text DEFAULT 'pending' NOT NULL,
	"ci_signal" text DEFAULT 'pending' NOT NULL,
	"blocked_at" jsonb,
	"resolved_execution" jsonb,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_test_plan_id_test_plans_id_fk" FOREIGN KEY ("test_plan_id") REFERENCES "public"."test_plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_pipeline_request_id_pipeline_requests_id_fk" FOREIGN KEY ("pipeline_request_id") REFERENCES "public"."pipeline_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_requirements_document_id_requirements_documents_id_fk" FOREIGN KEY ("requirements_document_id") REFERENCES "public"."requirements_documents"("id") ON DELETE set null ON UPDATE no action;