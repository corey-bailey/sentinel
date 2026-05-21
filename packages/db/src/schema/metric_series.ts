import { pgTable, uuid, text, real, jsonb, timestamp } from "drizzle-orm/pg-core";
import { testRuns } from "./test_runs.js";
import { companies } from "./companies.js";

export const metricSeries = pgTable("metric_series", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  testRunId: uuid("test_run_id").notNull().references(() => testRuns.id, { onDelete: "cascade" }),
  metric: text("metric").notNull(),
  // "k6" | "playwright" | "pytest" | "mocha" | "apm:dynatrace"
  source: text("source").notNull(),
  value: real("value"),
  // raw values for percentile computation
  rawValues: jsonb("raw_values").$type<number[]>(),
  // additional context
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
