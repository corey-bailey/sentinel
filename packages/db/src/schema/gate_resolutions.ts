import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { pipelineRuns } from "./pipeline_runs.js";
import { testRuns } from "./test_runs.js";

export const gateResolutions = pgTable("gate_resolutions", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  pipelineRunId: uuid("pipeline_run_id")
    .notNull()
    .references(() => pipelineRuns.id, { onDelete: "cascade" }),
  testRunId: uuid("test_run_id").references(() => testRuns.id, { onDelete: "set null" }),
  // auto_pass|auto_fail|inconclusive|characterization|regression_approved|regression_rejected|baseline_approved|baseline_rejected
  outcome: text("outcome").notNull(),
  ciSignal: text("ci_signal").notNull(), // pass | fail — total on every path
  resolvedBy: text("resolved_by"), // userId | 'auto'
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  comment: text("comment"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
