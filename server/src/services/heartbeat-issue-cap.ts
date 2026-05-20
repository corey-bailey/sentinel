import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { tooManyRequests } from "../errors.js";
import { logger } from "../middleware/logger.js";

/**
 * Atomically increments `heartbeat_runs.issues_created_count` for the given
 * run if it has not yet hit the cap. Returns the new count on success, or
 * `null` if the run is already at or above the cap.
 *
 * The single-statement conditional UPDATE is race-free under concurrent
 * issue-create requests from the same heartbeat run — Postgres guarantees
 * atomicity, so callers don't need to wrap this in a transaction.
 *
 * If `runId` does not match an existing heartbeat_runs row, returns `null`
 * (callers should bypass the cap when no run-id is present; this function
 * is only called when one IS present).
 *
 * If `cap` is `0` or negative, the check is disabled and the increment
 * always succeeds (returns the new count).
 */
export async function incrementHeartbeatIssueCount(
  db: Db,
  runId: string,
  cap: number,
): Promise<number | null> {
  if (!Number.isFinite(cap) || cap <= 0) {
    const rows = await db.execute<{ issues_created_count: number }>(sql`
      UPDATE heartbeat_runs
         SET issues_created_count = issues_created_count + 1
       WHERE id = ${runId}
       RETURNING issues_created_count
    `);
    const row = Array.isArray(rows) ? rows[0] : null;
    return row ? Number(row.issues_created_count) : null;
  }

  const rows = await db.execute<{ issues_created_count: number }>(sql`
    UPDATE heartbeat_runs
       SET issues_created_count = issues_created_count + 1
     WHERE id = ${runId}
       AND issues_created_count < ${cap}
     RETURNING issues_created_count
  `);
  const row = Array.isArray(rows) ? rows[0] : null;
  return row ? Number(row.issues_created_count) : null;
}

/**
 * Asserts that the current heartbeat run has not exceeded the configured
 * issue cap. Throws `tooManyRequests` (HTTP 429) when the cap is hit.
 *
 * No-op when `runId` is null/undefined — UI-initiated issue creates from
 * users (no x-paperclip-run-id header) pass straight through.
 */
export async function assertWithinIssueCascadeCap(
  db: Db,
  runId: string | null | undefined,
  cap: number,
): Promise<void> {
  if (!runId) return;
  const newCount = await incrementHeartbeatIssueCount(db, runId, cap);
  if (newCount === null) {
    logger.warn(
      { runId, cap, event: "issue_cascade_cap_exceeded" },
      "heartbeat run exceeded issue cascade cap; rejecting create with 429",
    );
    throw tooManyRequests(
      `Issue cascade cap of ${cap} reached for this heartbeat run. ` +
        `Surface follow-up work as a single parent issue or comment, not as ` +
        `a flood of child issues — the next heartbeat will pick up where this left off.`,
      { errorCode: "issue_cascade_cap_exceeded", cap, runId },
    );
  }
}
