import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Per-(company, adapter) circuit breaker state for upstream transient failures
 * (e.g. Anthropic / Codex / Gemini server-side rate-limit storms). The
 * heartbeat dispatcher consults this table before starting a new run and short-
 * circuits when `cooldown_until > now()`. Successful runs reset the row.
 *
 * Cooldown is escalating: every threshold breach within the rolling window
 * raises `cooldown_level`, which the service maps to a progressively longer
 * `cooldown_until` (60s -> 5m -> 15m -> 60m, capped). A successful run resets
 * both `consecutive_failures` and `cooldown_level` to 0.
 */
export const upstreamHealthState = pgTable(
  "upstream_health_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    adapterType: text("adapter_type").notNull(),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
    cooldownLevel: integer("cooldown_level").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAdapterUq: uniqueIndex("upstream_health_state_company_adapter_uq").on(
      table.companyId,
      table.adapterType,
    ),
    cooldownUntilIdx: index("upstream_health_state_cooldown_until_idx").on(table.cooldownUntil),
  }),
);
