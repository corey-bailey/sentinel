import { pgTable, uuid, text, real, boolean, timestamp } from "drizzle-orm/pg-core";
import { testRuns } from "./test_runs.js";
import { baselines } from "./baselines.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { pipelineRuns } from "./pipeline_runs.js";

export const regressions = pgTable("regressions", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  testRunId: uuid("test_run_id").notNull().references(() => testRuns.id),
  // pipeline_runs FK — links the regression to its pipeline run (nullable)
  pipelineRunId: uuid("pipeline_run_id").references(() => pipelineRuns.id, { onDelete: "set null" }),
  baselineId: uuid("baseline_id").references(() => baselines.id),
  // the baseline set this comparison ran against (0095)
  baselineSetId: uuid("baseline_set_id"),
  // null baselineId means this is a baseline_proposal (first run)
  // NOTE: regressionType stays free-text in this plan; the closed-enum conversion is deferred to 0095.
  regressionType: text("regression_type").notNull().default("regression"),
  // "higher_is_worse" | "lower_is_worse" — orients the deviation (decision #2)
  direction: text("direction"),
  metric: text("metric").notNull(),
  baselineValue: real("baseline_value"),
  actualValue: real("actual_value").notNull(),
  deviationPct: real("deviation_pct"),
  // Stage-7 dual-threshold comparison (0095): tolerance% (deltaPct) AND z-score gates
  deltaPct: real("delta_pct"),
  zScore: real("z_score"),
  flagged: boolean("flagged"),
  // "high" (sampleN >= K, z-gate applied) | "low" (cold-start, tolerance-only)
  confidence: text("confidence"),
  // "open" | "approved" | "rejected"
  status: text("status").notNull().default("open"),
  executionIssueId: uuid("execution_issue_id").references(() => issues.id),
  resolvedByUserId: text("resolved_by_user_id"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
