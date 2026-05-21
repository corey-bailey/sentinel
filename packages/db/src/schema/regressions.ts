import { pgTable, uuid, text, real, timestamp } from "drizzle-orm/pg-core";
import { testRuns } from "./test_runs.js";
import { baselines } from "./baselines.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const regressions = pgTable("regressions", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  testRunId: uuid("test_run_id").notNull().references(() => testRuns.id),
  baselineId: uuid("baseline_id").references(() => baselines.id),
  // null baselineId means this is a baseline_proposal (first run)
  regressionType: text("regression_type").notNull().default("regression"),
  metric: text("metric").notNull(),
  baselineValue: real("baseline_value"),
  actualValue: real("actual_value").notNull(),
  deviationPct: real("deviation_pct"),
  // "open" | "approved" | "rejected"
  status: text("status").notNull().default("open"),
  executionIssueId: uuid("execution_issue_id").references(() => issues.id),
  resolvedByUserId: text("resolved_by_user_id"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
