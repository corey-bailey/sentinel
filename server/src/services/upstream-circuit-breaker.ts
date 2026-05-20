import { and, eq, sql } from "drizzle-orm";
import { upstreamHealthState, type Db } from "@paperclipai/db";

/**
 * Per-(company, adapter) circuit breaker for upstream transient failures.
 *
 * Background: a Claude/Codex/Gemini server-side rate-limit storm last session
 * burned ~$50 of subscription quota because the per-run retry backoff was the
 * only gate. While ONE run was in its 2-minute backoff, dozens of other runs
 * (routine fires, assignment cascades, recovery-loop re-dispatches) each
 * spawned their own fresh attempts, all hitting the same rate limit. The
 * heartbeat retry scheduler is per-run; there was no system-level gate that
 * said "Anthropic is throttling us, stop dispatching new heartbeats."
 *
 * This service is that gate. The heartbeat dispatcher consults
 * `isInCooldown(companyId, adapterType)` before starting a new run. The run-
 * finalizer calls `recordFailure` on `*_transient_upstream` outcomes and
 * `recordSuccess` on any successful run.
 *
 * Cooldown escalates: every threshold breach within the rolling failure window
 * raises `cooldown_level`, which maps to a progressively longer pause (60s,
 * 5m, 15m, 60m, capped). Successful runs reset both the failure count and the
 * cooldown level — the breaker self-heals.
 */
export interface UpstreamCircuitBreakerOptions {
  /** Threshold of consecutive transient failures within `failureWindowMs` that
   *  trips the breaker. Default 5. */
  failureThreshold?: number;
  /** Sliding window for counting consecutive failures. A new failure outside
   *  this window resets the counter to 0 before incrementing. Default 5 min. */
  failureWindowMs?: number;
  /** Escalating cooldown durations by level (1-indexed). The last entry is
   *  reused for any further escalations (capped). Default 60s, 5m, 15m, 60m. */
  cooldownDurationsMs?: readonly number[];
}

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_FAILURE_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_COOLDOWN_DURATIONS_MS: readonly number[] = [
  60 * 1000,
  5 * 60 * 1000,
  15 * 60 * 1000,
  60 * 60 * 1000,
] as const;

export interface UpstreamHealthSnapshot {
  inCooldown: boolean;
  cooldownUntil: Date | null;
  cooldownLevel: number;
  consecutiveFailures: number;
  lastFailureAt: Date | null;
  lastSuccessAt: Date | null;
  lastErrorCode: string | null;
}

export interface RecordFailureOptions {
  errorCode?: string | null;
  now?: Date;
}

export interface RecordSuccessOptions {
  now?: Date;
}

export interface IsInCooldownOptions {
  now?: Date;
}

export interface UpstreamCircuitBreaker {
  isInCooldown(
    companyId: string,
    adapterType: string,
    options?: IsInCooldownOptions,
  ): Promise<UpstreamHealthSnapshot>;
  recordFailure(
    companyId: string,
    adapterType: string,
    options?: RecordFailureOptions,
  ): Promise<UpstreamHealthSnapshot>;
  recordSuccess(
    companyId: string,
    adapterType: string,
    options?: RecordSuccessOptions,
  ): Promise<UpstreamHealthSnapshot>;
}

const EMPTY_SNAPSHOT: UpstreamHealthSnapshot = Object.freeze({
  inCooldown: false,
  cooldownUntil: null,
  cooldownLevel: 0,
  consecutiveFailures: 0,
  lastFailureAt: null,
  lastSuccessAt: null,
  lastErrorCode: null,
});

function rowToSnapshot(row: typeof upstreamHealthState.$inferSelect, now: Date): UpstreamHealthSnapshot {
  const cooldownUntil = row.cooldownUntil ?? null;
  return {
    inCooldown: cooldownUntil !== null && cooldownUntil.getTime() > now.getTime(),
    cooldownUntil,
    cooldownLevel: row.cooldownLevel,
    consecutiveFailures: row.consecutiveFailures,
    lastFailureAt: row.lastFailureAt ?? null,
    lastSuccessAt: row.lastSuccessAt ?? null,
    lastErrorCode: row.lastErrorCode ?? null,
  };
}

export function createUpstreamCircuitBreaker(
  db: Db,
  options: UpstreamCircuitBreakerOptions = {},
): UpstreamCircuitBreaker {
  const failureThreshold = Math.max(1, Math.floor(options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD));
  const failureWindowMs = Math.max(1000, Math.floor(options.failureWindowMs ?? DEFAULT_FAILURE_WINDOW_MS));
  const cooldownDurationsMs =
    options.cooldownDurationsMs && options.cooldownDurationsMs.length > 0
      ? options.cooldownDurationsMs.slice()
      : DEFAULT_COOLDOWN_DURATIONS_MS;

  function durationForLevel(level: number): number {
    if (level <= 0) return 0;
    const idx = Math.min(level - 1, cooldownDurationsMs.length - 1);
    return cooldownDurationsMs[idx]!;
  }

  async function readRow(companyId: string, adapterType: string) {
    const rows = await db
      .select()
      .from(upstreamHealthState)
      .where(
        and(
          eq(upstreamHealthState.companyId, companyId),
          eq(upstreamHealthState.adapterType, adapterType),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  return {
    async isInCooldown(companyId, adapterType, opts) {
      const now = opts?.now ?? new Date();
      const row = await readRow(companyId, adapterType);
      if (!row) return EMPTY_SNAPSHOT;
      return rowToSnapshot(row, now);
    },

    async recordFailure(companyId, adapterType, opts) {
      const now = opts?.now ?? new Date();
      const errorCode = opts?.errorCode ?? null;

      // Run as a transaction so the "read prior row + decide next state + write"
      // sequence is atomic across concurrent dispatchers within the same server.
      return await db.transaction(async (tx) => {
        const existing = await tx
          .select()
          .from(upstreamHealthState)
          .where(
            and(
              eq(upstreamHealthState.companyId, companyId),
              eq(upstreamHealthState.adapterType, adapterType),
            ),
          )
          .for("update")
          .limit(1)
          .then((rows) => rows[0] ?? null);

        // If the previous failure is older than the rolling window, the streak
        // restarts. Otherwise we increment it.
        const priorCount =
          existing?.lastFailureAt &&
          now.getTime() - existing.lastFailureAt.getTime() <= failureWindowMs
            ? existing.consecutiveFailures
            : 0;
        const nextCount = priorCount + 1;

        let nextLevel = existing?.cooldownLevel ?? 0;
        let nextCooldownUntil = existing?.cooldownUntil ?? null;
        let resetCounterToZero = false;

        if (nextCount >= failureThreshold) {
          // Threshold breach — escalate the cooldown ladder. We reset the
          // counter so the next breach has to re-accumulate failures within a
          // fresh window before escalating again.
          nextLevel = nextLevel + 1;
          nextCooldownUntil = new Date(now.getTime() + durationForLevel(nextLevel));
          resetCounterToZero = true;
        }

        const baseValues = {
          companyId,
          adapterType,
          consecutiveFailures: resetCounterToZero ? 0 : nextCount,
          lastFailureAt: now,
          cooldownLevel: nextLevel,
          cooldownUntil: nextCooldownUntil,
          lastErrorCode: errorCode,
          updatedAt: now,
        };

        const [row] = await tx
          .insert(upstreamHealthState)
          .values(baseValues)
          .onConflictDoUpdate({
            target: [upstreamHealthState.companyId, upstreamHealthState.adapterType],
            set: {
              consecutiveFailures: baseValues.consecutiveFailures,
              lastFailureAt: now,
              cooldownLevel: nextLevel,
              cooldownUntil: nextCooldownUntil,
              lastErrorCode: errorCode,
              updatedAt: now,
            },
          })
          .returning();

        return rowToSnapshot(row!, now);
      });
    },

    async recordSuccess(companyId, adapterType, opts) {
      const now = opts?.now ?? new Date();
      const [row] = await db
        .insert(upstreamHealthState)
        .values({
          companyId,
          adapterType,
          consecutiveFailures: 0,
          lastSuccessAt: now,
          cooldownLevel: 0,
          cooldownUntil: null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [upstreamHealthState.companyId, upstreamHealthState.adapterType],
          set: {
            consecutiveFailures: 0,
            lastSuccessAt: now,
            cooldownLevel: 0,
            cooldownUntil: null,
            updatedAt: now,
          },
        })
        .returning();

      return rowToSnapshot(row!, now);
    },
  };
}

/** Convenience constants exported for callers / tests. */
export const UPSTREAM_CIRCUIT_BREAKER_DEFAULTS = Object.freeze({
  failureThreshold: DEFAULT_FAILURE_THRESHOLD,
  failureWindowMs: DEFAULT_FAILURE_WINDOW_MS,
  cooldownDurationsMs: DEFAULT_COOLDOWN_DURATIONS_MS,
});

/** Error codes that should trip the circuit breaker. Imported by the heartbeat
 *  finalizer so the recordFailure call site has a single source of truth. */
export const CIRCUIT_BREAKER_TRIPPING_ERROR_CODES = new Set<string>([
  "claude_transient_upstream",
  "codex_transient_upstream",
]);

export function isCircuitBreakerTrippingErrorCode(errorCode: string | null | undefined): boolean {
  return errorCode != null && CIRCUIT_BREAKER_TRIPPING_ERROR_CODES.has(errorCode);
}
