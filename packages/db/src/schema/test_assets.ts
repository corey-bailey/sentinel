import { pgTable, uuid, text, integer, timestamp } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { testPlans } from "./test_plans.js";
import { requirements } from "./requirements.js";

export const testAssets = pgTable("test_assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  testPlanId: uuid("test_plan_id").notNull().references(() => testPlans.id),
  requirementId: uuid("requirement_id").references(() => requirements.id),
  name: text("name").notNull(),
  // "k6" | "playwright" | "pytest" | "mocha"
  engine: text("engine").notNull(),
  // "human_authored" | "generated" | "approved_generated"
  assetType: text("asset_type").notNull().default("human_authored"),
  scriptContent: text("script_content"),
  scriptPath: text("script_path"),
  version: integer("version").notNull().default(1),
  createdByUserId: text("created_by_user_id"),
  createdByAgentId: uuid("created_by_agent_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
