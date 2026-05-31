import { pgTable, uuid, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { testPlans } from "./test_plans.js";
import { requirements } from "./requirements.js";
import { pipelineRuns } from "./pipeline_runs.js";

export const testRuns = pgTable("test_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  testPlanId: uuid("test_plan_id").notNull().references(() => testPlans.id),
  requirementId: uuid("requirement_id").references(() => requirements.id),
  // pipeline_runs FK — nullable so manual/CI runs without a pipeline still insert
  pipelineRunId: uuid("pipeline_run_id").references(() => pipelineRuns.id, { onDelete: "set null" }),
  // "manual" | "ci" | "scheduled"
  triggerType: text("trigger_type").notNull().default("manual"),
  // ci context: repo, commit, changed_files, pr_number
  triggerContext: jsonb("trigger_context").$type<Record<string, unknown>>(),
  // "queued" | "running" | "pass" | "fail" | "error" | "cancelled"
  status: text("status").notNull().default("queued"),
  // overall pass/fail signal (set by analysis or regression rejection)
  resultSignal: text("result_signal"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdByUserId: text("created_by_user_id"),
  createdByAgentId: uuid("created_by_agent_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
