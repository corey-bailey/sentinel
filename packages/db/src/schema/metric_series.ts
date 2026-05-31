import { pgTable, uuid, text, integer, real, jsonb, timestamp } from "drizzle-orm/pg-core";
import { testRuns } from "./test_runs.js";
import { companies } from "./companies.js";
import { executionRuns } from "./execution_runs.js";

// Named seam for the deferred sharded t-digest merge (decision #1). Shape is
// firmed when the sharded merge lands; for now a per-bucket digest/HDR blob.
export type MetricDigest = Record<string, unknown>;

export const metricSeries = pgTable("metric_series", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  testRunId: uuid("test_run_id").notNull().references(() => testRuns.id, { onDelete: "cascade" }),
  // execution_runs FK — scopes the series to one harness invocation (nullable)
  executionRunId: uuid("execution_run_id").references(() => executionRuns.id, { onDelete: "set null" }),
  metric: text("metric").notNull(),
  // "k6" | "playwright" | "pytest" | "mocha" | "apm:dynatrace"
  source: text("source").notNull(),
  // per-workflow + phase scoping for windowed percentiles
  workflowName: text("workflow_name"),
  phase: text("phase"), // warmup | ramp_up | steady | ramp_down
  value: real("value"),
  // raw values for percentile computation
  rawValues: jsonb("raw_values").$type<number[]>(),
  // per-bucket t-digest/HDR blob (named seam: MetricDigest)
  digest: jsonb("digest").$type<MetricDigest>(),
  sampleCount: integer("sample_count"),
  // additional context
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
