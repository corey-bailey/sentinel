import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { pipelineRuns } from "./pipeline_runs.js";
import { testRuns } from "./test_runs.js";
import { testAssets } from "./test_assets.js";
import { testRunArtifacts } from "./test_run_artifacts.js";

export const executionRuns = pgTable("execution_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  pipelineRunId: uuid("pipeline_run_id")
    .notNull()
    .references(() => pipelineRuns.id, { onDelete: "cascade" }),
  testRunId: uuid("test_run_id").references(() => testRuns.id, { onDelete: "set null" }),
  testAssetId: uuid("test_asset_id").references(() => testAssets.id, { onDelete: "set null" }),
  engine: text("engine"),
  binaryProfile: text("binary_profile"), // resolvable k6 binary path/profile, NOT literal 'k6'
  workspaceRef: text("workspace_ref"),
  status: text("status").notNull().default("queued"), // queued|running|completed|failed|aborted
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  exitCode: integer("exit_code"),
  peakVus: integer("peak_vus"),
  totalIterations: integer("total_iterations"),
  totalRequests: integer("total_requests"),
  stdoutRef: uuid("stdout_ref").references(() => testRunArtifacts.id, { onDelete: "set null" }),
  liveMetricFeed: text("live_metric_feed"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
