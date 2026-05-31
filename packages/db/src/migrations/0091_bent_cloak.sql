CREATE TABLE "pipeline_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source" text NOT NULL,
	"raw_description" text,
	"jira_issue_key" text,
	"jira_issue_url" text,
	"artifacts" jsonb DEFAULT '{}'::jsonb,
	"extracted_context" jsonb DEFAULT '{}'::jsonb,
	"requested_by" text,
	"owner_user_id" text NOT NULL,
	"status" text DEFAULT 'pending_confirmation' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requirements_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"pipeline_request_id" uuid,
	"app_name" text,
	"app_description" text,
	"owner_user_id" text,
	"protocol" jsonb,
	"sync_model" text,
	"async_details" jsonb,
	"sla_targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"load_model" jsonb,
	"authentication" jsonb,
	"test_data" jsonb,
	"existing_artifacts" jsonb,
	"target_environment" jsonb,
	"dynatrace" jsonb,
	"min_sample_count" integer DEFAULT 200 NOT NULL,
	"test_intent" text DEFAULT 'conformance' NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"approved_by_user_id" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pipeline_requests" ADD CONSTRAINT "pipeline_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirements_documents" ADD CONSTRAINT "requirements_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirements_documents" ADD CONSTRAINT "requirements_documents_pipeline_request_id_pipeline_requests_id_fk" FOREIGN KEY ("pipeline_request_id") REFERENCES "public"."pipeline_requests"("id") ON DELETE set null ON UPDATE no action;