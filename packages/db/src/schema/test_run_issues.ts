import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";
import { testRuns } from "./test_runs.js";
import { issues } from "./issues.js";

export const testRunIssues = pgTable("test_run_issues", {
  id: uuid("id").primaryKey().defaultRandom(),
  testRunId: uuid("test_run_id").notNull().references(() => testRuns.id, { onDelete: "cascade" }),
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  // stage label: "req" | "gen" | "run:k6" | "run:playwright" | "run:pytest" | "run:mocha" | "anl" | "reg" | "rpt"
  stage: text("stage").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
