import { pgTable, uuid, text, jsonb, timestamp, boolean } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { requirements } from "./requirements.js";

export const testPlans = pgTable("test_plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  requirementId: uuid("requirement_id").references(() => requirements.id),
  name: text("name").notNull(),
  description: text("description"),
  // ["k6", "playwright", "pytest", "mocha"]
  engines: jsonb("engines").notNull().$type<string[]>().default([]),
  // { vus, stages: [{ duration, target }] }
  loadProfile: jsonb("load_profile").$type<LoadProfile | null>(),
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

export type LoadProfile = {
  vus: number;
  stages: Array<{ duration: string; target: number }>;
};
