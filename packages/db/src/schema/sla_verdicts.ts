import { boolean, jsonb, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { pipelineRuns } from "./pipeline_runs.js";
import { executionRuns } from "./execution_runs.js";
import { testRuns } from "./test_runs.js";

export const slaVerdicts = pgTable("sla_verdicts", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  pipelineRunId: uuid("pipeline_run_id")
    .notNull()
    .references(() => pipelineRuns.id, { onDelete: "cascade" }),
  executionRunId: uuid("execution_run_id").references(() => executionRuns.id, { onDelete: "set null" }),
  testRunId: uuid("test_run_id").references(() => testRuns.id, { onDelete: "set null" }),
  slaTargetId: text("sla_target_id").notNull(), // joins requirements_documents.slaTargets[].id (live, no copy)
  workflowName: text("workflow_name"),
  phase: text("phase"), // warmup|ramp_up|steady|ramp_down
  metric: text("metric"),
  operator: text("operator"),
  threshold: real("threshold"), // codebase uses real() for floats (spec §1: `real`), not doublePrecision
  actualValue: real("actual_value"),
  evaluationWindow: jsonb("evaluation_window").$type<{ startMs: number; endMs: number }>(),
  source: text("source"), // k6 | playwright | apm:dynatrace
  status: text("status").notNull(), // pass | fail | inconclusive
  evaluatedOnSuccessOnly: boolean("evaluated_on_success_only").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
