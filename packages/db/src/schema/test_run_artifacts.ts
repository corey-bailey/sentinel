import { type AnyPgColumn, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { pipelineRuns } from "./pipeline_runs.js";
import { testRuns } from "./test_runs.js";
// NOTE: executionRunId references execution_runs.id; the FK is created as an
// ALTER after both tables exist (circular with execution_runs.stdoutRef).
import { executionRuns } from "./execution_runs.js";

export const testRunArtifacts = pgTable("test_run_artifacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  pipelineRunId: uuid("pipeline_run_id")
    .notNull()
    .references(() => pipelineRuns.id, { onDelete: "cascade" }),
  executionRunId: uuid("execution_run_id").references((): AnyPgColumn => executionRuns.id, { onDelete: "set null" }),
  testRunId: uuid("test_run_id").references(() => testRuns.id, { onDelete: "set null" }),
  // k6_html_summary|sentinel_summary|stdout_log|metrics_json_stream|dynatrace_deeplink|gha_workflow_bundle|performance_envelope
  artifactType: text("artifact_type").notNull(),
  storageRef: text("storage_ref").notNull(),
  url: text("url"),
  contentType: text("content_type"),
  sizeBytes: integer("size_bytes"),
  publishStatus: text("publish_status").notNull().default("stored"), // stored | published | publish_failed
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
