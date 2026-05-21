import { pgTable, uuid, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const requirements = pgTable("requirements", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  name: text("name").notNull(),
  description: text("description"),
  // SLA targets: array of { id, metric, operator, threshold, source }
  slaTargets: jsonb("sla_targets").notNull().$type<SLATargetRecord[]>().default([]),
  // "human" | "agent" | "jira"
  source: text("source").notNull().default("human"),
  jiraIssueId: text("jira_issue_id"),
  // "pending" | "audited" | "covered" | "gap"
  coverageStatus: text("coverage_status").notNull().default("pending"),
  createdByUserId: text("created_by_user_id"),
  createdByAgentId: uuid("created_by_agent_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SLATargetRecord = {
  id: string;
  metric: string;
  operator: "lt" | "lte" | "gt" | "gte";
  threshold: number;
  source: string;
};
