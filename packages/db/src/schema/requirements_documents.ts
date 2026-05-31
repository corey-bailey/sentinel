import { integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { pipelineRequests } from "./pipeline_requests.js";

// Canonical SLA element — the SINGLE source of truth (decision #8). `id` is the
// stable id that test_plans and sla_verdicts reference; never copied downstream.
export type SlaTarget = {
  id: string;
  source: string; // 'k6' | 'playwright' | 'apm:dynatrace' | ...
  metric: string; // 'p95_ms' | 'p99_ms' | 'error_rate' | 'tps' | ...
  operator: "lt" | "lte" | "gt" | "gte";
  threshold: number;
  required: boolean;
  workflowScope?: string; // a workflowName for a per-workflow SLA (drives Stage-2 per-scenario)
  approvedByUserId?: string;
};

export type LoadModel = {
  peakConcurrentUsers?: number;
  peakTps?: number;
  peakMps?: number;
  loadProfile?: { targetUnit?: "vus" | "rate"; stages?: { duration: string; target: number }[] };
  trafficMix?: { workflow: string; percentage: number; description?: string }[];
};

export const requirementsDocuments = pgTable("requirements_documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  pipelineRequestId: uuid("pipeline_request_id").references(() => pipelineRequests.id, {
    onDelete: "set null",
  }),
  appName: text("app_name"),
  appDescription: text("app_description"),
  ownerUserId: text("owner_user_id"),
  protocol: jsonb("protocol").$type<string | string[]>(),
  syncModel: text("sync_model"), // sync | async | hybrid
  asyncDetails: jsonb("async_details").$type<{ measurementPoint?: string; sagaDescription?: string }>(),
  slaTargets: jsonb("sla_targets").$type<SlaTarget[]>().notNull().default([]),
  loadModel: jsonb("load_model").$type<LoadModel>(),
  authentication: jsonb("authentication").$type<Record<string, unknown>>(),
  testData: jsonb("test_data").$type<Record<string, unknown>>(),
  existingArtifacts: jsonb("existing_artifacts").$type<Record<string, unknown>>(),
  targetEnvironment: jsonb("target_environment").$type<Record<string, unknown>>(),
  dynatrace: jsonb("dynatrace").$type<Record<string, unknown>>(),
  minSampleCount: integer("min_sample_count").notNull().default(200), // p95 floor; percentile-aware
  testIntent: text("test_intent").notNull().default("conformance"), // conformance | baseline | exploratory
  status: text("status").notNull().default("in_progress"), // in_progress | complete | approved
  approvedByUserId: text("approved_by_user_id"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
