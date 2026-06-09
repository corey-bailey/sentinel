import { pgTable, uuid, text, real, integer, timestamp, boolean } from "drizzle-orm/pg-core";
import { testPlans } from "./test_plans.js";
import { companies } from "./companies.js";
import { testRuns } from "./test_runs.js";

export const baselines = pgTable("baselines", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  testPlanId: uuid("test_plan_id").notNull().references(() => testPlans.id),
  sourceRunId: uuid("source_run_id").references(() => testRuns.id),
  // groups the baseline rows produced by one characterization run (one set per metric family)
  baselineSetId: uuid("baseline_set_id"),
  metric: text("metric").notNull(),
  baselineValue: real("baseline_value").notNull(),
  // Stage-7 distribution model (0095): median+stddev over the K clean runs behind this baseline.
  // baselineValue stays populated (= median) for back-compat with pre-0095 consumers.
  median: real("median"),
  stddev: real("stddev"),
  sampleN: integer("sample_n"),
  // "higher_is_worse" | "lower_is_worse" — which way this metric regresses
  direction: text("direction"),
  validFrom: timestamp("valid_from", { withTimezone: true }),
  validUntil: timestamp("valid_until", { withTimezone: true }),
  // % tolerance before a deviation counts as regression (default 10)
  tolerancePct: real("tolerance_pct").notNull().default(10),
  isActive: boolean("is_active").notNull().default(false),
  approvedByUserId: text("approved_by_user_id"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
