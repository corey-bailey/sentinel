import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export type PipelineRequestArtifacts = {
  openApiSpec?: Record<string, unknown>;
  postmanCollection?: Record<string, unknown>;
  functionalTests?: { repo: string; path: string };
  existingTestPlanId?: string;
  attachments?: { name: string; content: string; mimeType: string }[];
};

export type PipelineRequestExtractedContext = {
  candidateSlaTargets?: string[];
  protocolHints?: string[];
  appName?: string;
  systemOwner?: string;
};

// Stage 0 intake artifact. source uses the SAME intake tokens as
// pipeline_runs.trigger.type intake-origin set: { manual_intake, jira }.
export const pipelineRequests = pgTable("pipeline_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  source: text("source").notNull(), // 'manual_intake' | 'jira'
  rawDescription: text("raw_description"),
  jiraIssueKey: text("jira_issue_key"),
  jiraIssueUrl: text("jira_issue_url"),
  artifacts: jsonb("artifacts").$type<PipelineRequestArtifacts>().default({}),
  extractedContext: jsonb("extracted_context").$type<PipelineRequestExtractedContext>().default({}),
  requestedBy: text("requested_by"),
  ownerUserId: text("owner_user_id").notNull(),
  status: text("status").notNull().default("pending_confirmation"), // pending_confirmation | confirmed | rejected
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
