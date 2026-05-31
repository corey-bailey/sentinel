import { pgTable, uuid, text, jsonb, timestamp, boolean } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { requirements } from "./requirements.js";
import { requirementsDocuments } from "./requirements_documents.js";

export const testPlans = pgTable("test_plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  requirementId: uuid("requirement_id").references(() => requirements.id),
  // requirements_documents FK — SLA targets are read THROUGH this, never copied
  requirementsDocumentId: uuid("requirements_document_id").references(() => requirementsDocuments.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  description: text("description"),
  // ["k6", "playwright", "pytest", "mocha"]
  engines: jsonb("engines").notNull().$type<string[]>().default([]),
  // protocol-tagged discriminated load profile (column stays jsonb; type-only widening)
  loadProfile: jsonb("load_profile").$type<LoadProfile | null>(),
  // "weighted-loop" | "per-scenario" — per-scenario iff per-workflow SLAs exist
  executionModel: text("execution_model"),
  // "dynatrace" | null
  apmProvider: text("apm_provider"),
  apmServiceId: text("apm_service_id"),
  // file globs for CI trigger matching
  filePatterns: jsonb("file_patterns").$type<string[]>().default([]),
  // cron expression for scheduled runs
  schedule: text("schedule"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Protocol-tagged discriminated load profile (decision #3, spec Stage 2). WHICH
// branch instantiates is DERIVED from the RequirementsDocument:
//   peakConcurrentUsers → ramping-vus     (closed model — concurrency)
//   peakTps / peakRps   → arrival-rate     (open model — holds throughput)
//   peakMps             → kafka            (producer/consumer rate)
//   websocket/sse       → streaming        (connections × msg-rate)
// The type expresses ALL protocols now; generators are built incrementally.
// Column stays jsonb so legacy { vus, stages } rows remain valid at the DB layer.
export type LoadProfile =
  | {
      protocol: "http" | "grpc" | "graphql";
      executor: "ramping-vus";
      startVus?: number;
      stages: Array<{ duration: string; target: number }>; // target = VUs
      gracefulRampDown?: string;
      thinkTime?: number; // ms pause between iterations
    }
  | {
      protocol: "http" | "grpc" | "graphql";
      executor: "constant-arrival-rate";
      rate: number;
      timeUnit: string; // e.g. 2000 per "1s"
      duration: string;
      // Flat constant-arrival-rate has no stages → no intrinsic window origin.
      // This triple is the REQUIRED window carrier the sustain-window rule mandates.
      evaluationWindow: { warmup: string; steady: string; cooldown: string };
      preAllocatedVUs: number;
      maxVUs: number; // VUs allocated to HOLD the rate
    }
  | {
      protocol: "http" | "grpc" | "graphql";
      executor: "ramping-arrival-rate";
      startRate: number;
      timeUnit: string;
      stages: Array<{ duration: string; target: number }>; // target = arrival RATE
      preAllocatedVUs: number;
      maxVUs: number;
    }
  | {
      protocol: "kafka";
      producerRate?: number; // messages/sec injected (from peakMps)
      consumerRate?: number; // messages/sec drained
      duration: string;
    }
  | {
      protocol: "websocket" | "sse";
      concurrentConnections: number;
      messagesPerConnectionPerSec: number;
      duration: string;
    }
  | {
      protocol: "http" | "grpc" | "graphql";
      executor: "constant-vus"; // TRUE BASELINE — uncontended single-user latency floor
      vus: number; // typically 1; NO thinkTime => iterations fire back-to-back
      duration: string; // SIZED to accrue >= minSampleCount steady samples (Stage 6)
    };
