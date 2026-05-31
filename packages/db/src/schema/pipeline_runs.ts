import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { testPlans } from "./test_plans.js";
import { pipelineRequests } from "./pipeline_requests.js";
import { requirementsDocuments } from "./requirements_documents.js";

export type PipelineTrigger = {
  type: "manual_intake" | "jira" | "ci" | "scheduled" | "manual_rerun";
  source: string;
  ref?: string;
  changedFiles?: string[];
};

export type StageRecord = {
  status: "pending" | "running" | "complete" | "skipped" | "failed" | "blocked";
  startedAt?: string;
  completedAt?: string;
  issueId?: string;
  assigneeAgentId?: string;
  skippedReason?: string; // NON-NULL whenever status === 'skipped'
  idempotencyKey?: string;
  error?: string;
  executionRunIds?: string[]; // execute stage only
};

export type StageRecordMap = {
  intake: StageRecord;
  discovery: StageRecord;
  plan: StageRecord;
  generate: StageRecord;
  validate: StageRecord;
  execute: StageRecord;
  analysis: StageRecord; // metrics + SLA + mechanical gate, ONE [ANL] Issue
  report: StageRecord;
};

export type BlockedAt = {
  stage: string;
  reason: string;
  questionId: string;
  interactionType: "thread_interaction" | "approval";
  interactionId: string;
  issueId: string;
};

export type ResolvedExecution = {
  loadProfile: Record<string, unknown>;
  executor:
    | "ramping-vus"
    | "constant-arrival-rate"
    | "ramping-arrival-rate"
    | "constant-vus"
    | "kafka"
    | "streaming";
  executionModel: "weighted-loop" | "per-scenario";
  resolvedSteadyWindow: { startMs: number; endMs: number };
  testAssetVersions: { testAssetId: string; workflowName: string; engine: string; version: number }[];
  dataFileHashes: { name: string; sha256: string }[];
  secretRef: string;
  rngSeed: number;
  discoveredBreakpoint?: { rate: number; p95AtBreak: number; baselineP95: number; stopReason: string }; // DEFERRED: exploratory only
};

export const pipelineRuns = pgTable("pipeline_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  testPlanId: uuid("test_plan_id").references(() => testPlans.id, { onDelete: "set null" }),
  pipelineRequestId: uuid("pipeline_request_id").references(() => pipelineRequests.id, {
    onDelete: "set null",
  }),
  requirementsDocumentId: uuid("requirements_document_id").references(() => requirementsDocuments.id, {
    onDelete: "set null",
  }),
  trigger: jsonb("trigger").$type<PipelineTrigger>().notNull(),
  stages: jsonb("stages").$type<StageRecordMap>().notNull(),
  verdict: text("verdict").notNull().default("pending"), // pending|running|pass|fail|blocked_on_human|inconclusive|error
  ciSignal: text("ci_signal").notNull().default("pending"), // pending|pass|fail|not_applicable
  blockedAt: jsonb("blocked_at").$type<BlockedAt>(),
  resolvedExecution: jsonb("resolved_execution").$type<ResolvedExecution>(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
