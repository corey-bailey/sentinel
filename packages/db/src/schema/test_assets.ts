import { pgTable, uuid, text, integer, jsonb, timestamp } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { testPlans } from "./test_plans.js";
import { requirements } from "./requirements.js";

// READ-ONLY provenance pointer for an imported/adapted asset — a human commits
// the script; this records where it came from. Never used to fetch live.
export type TestAssetSourceRef = { repoUrl: string; path: string; ref: string; importedSha: string };

export const testAssets = pgTable("test_assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  testPlanId: uuid("test_plan_id").notNull().references(() => testPlans.id),
  requirementId: uuid("requirement_id").references(() => requirements.id),
  name: text("name").notNull(),
  // "k6" | "playwright" | "pytest" | "mocha"
  engine: text("engine").notNull(),
  // "human_authored" | "generated" | "approved_generated" | "ci_workflow" | "existing_k6"
  // (text column — new values need no DDL change)
  assetType: text("asset_type").notNull().default("human_authored"),
  scriptContent: text("script_content"),
  scriptPath: text("script_path"),
  version: integer("version").notNull().default(1),
  // "http" | "grpc" | "graphql" | "kafka" | "websocket" | "sse" | ...
  protocol: text("protocol"),
  // attached data files: { name, content, type, strategy }[]
  dataFiles: jsonb("data_files").$type<{ name: string; content: string; type: string; strategy: string }[]>(),
  setupScript: text("setup_script"),
  teardownScript: text("teardown_script"),
  // "openapi" | "postman" | "functional_tests" | "scratch" | "existing_k6"
  generatedFrom: text("generated_from"),
  sourceRef: jsonb("source_ref").$type<TestAssetSourceRef>(),
  createdByUserId: text("created_by_user_id"),
  createdByAgentId: uuid("created_by_agent_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
