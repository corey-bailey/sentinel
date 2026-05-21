import { and, count, eq } from "drizzle-orm";
import type { Db } from "@sentinel/db";
import { heartbeatRuns } from "@sentinel/db";

/**
 * Count the heartbeat runs currently in status='running' for the given agent.
 * Exported for tests; production callers should use `isAgentAtConcurrencyCap`.
 */
export async function countRunningRunsForAgent(db: Db, agentId: string): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "running")));
  return Number(rows[0]?.n ?? 0);
}

/**
 * Decide whether the given agent has hit the per-agent concurrent-run cap.
 *
 * Returns `false` (allow) when `cap` is 0 or negative — disables the check.
 * Otherwise returns `true` (block) iff the agent's current `running` count is
 * already at or above the cap.
 *
 * Note: this is a read-then-decide check, not a strict invariant. Two
 * concurrent dispatch attempts can both observe `running=cap-1` and both
 * promote, allowing one extra run past the cap. For typical cap values (2+)
 * this small overshoot is acceptable and avoids the complexity of advisory
 * locking on the agent row.
 */
export async function isAgentAtConcurrencyCap(
  db: Db,
  agentId: string,
  cap: number,
): Promise<boolean> {
  if (!Number.isFinite(cap) || cap <= 0) return false;
  const runningCount = await countRunningRunsForAgent(db, agentId);
  return runningCount >= cap;
}
