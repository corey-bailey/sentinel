import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@sentinel/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  assertWithinIssueCascadeCap,
  incrementHeartbeatIssueCount,
} from "../services/heartbeat-issue-cap.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function seedHeartbeatRun(db: ReturnType<typeof createDb>) {
  const [company] = await db
    .insert(companies)
    .values({ name: `co-${randomUUID()}`, ownerUserId: `u-${randomUUID()}` })
    .returning();
  const [agent] = await db
    .insert(agents)
    .values({ companyId: company!.id, name: `agent-${randomUUID()}` })
    .returning();
  const [run] = await db
    .insert(heartbeatRuns)
    .values({ companyId: company!.id, agentId: agent!.id })
    .returning();
  return { runId: run!.id };
}

describeEmbeddedPostgres("heartbeat issue cascade cap", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-issue-cap-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("increments the counter atomically and returns the new value", async () => {
    const { runId } = await seedHeartbeatRun(db);
    expect(await incrementHeartbeatIssueCount(db, runId, 5)).toBe(1);
    expect(await incrementHeartbeatIssueCount(db, runId, 5)).toBe(2);
    expect(await incrementHeartbeatIssueCount(db, runId, 5)).toBe(3);
  });

  it("returns null once the cap is reached", async () => {
    const { runId } = await seedHeartbeatRun(db);
    expect(await incrementHeartbeatIssueCount(db, runId, 2)).toBe(1);
    expect(await incrementHeartbeatIssueCount(db, runId, 2)).toBe(2);
    expect(await incrementHeartbeatIssueCount(db, runId, 2)).toBeNull();
    expect(await incrementHeartbeatIssueCount(db, runId, 2)).toBeNull();
  });

  it("returns null for an unknown run id", async () => {
    const result = await incrementHeartbeatIssueCount(db, randomUUID(), 5);
    expect(result).toBeNull();
  });

  it("disables the check when cap is 0", async () => {
    const { runId } = await seedHeartbeatRun(db);
    for (let i = 1; i <= 50; i += 1) {
      const r = await incrementHeartbeatIssueCount(db, runId, 0);
      expect(r).toBe(i);
    }
  });

  it("disables the check when cap is negative", async () => {
    const { runId } = await seedHeartbeatRun(db);
    expect(await incrementHeartbeatIssueCount(db, runId, -1)).toBe(1);
  });

  describe("assertWithinIssueCascadeCap", () => {
    it("is a no-op when runId is null", async () => {
      await expect(assertWithinIssueCascadeCap(db, null, 5)).resolves.toBeUndefined();
    });

    it("is a no-op when runId is undefined", async () => {
      await expect(assertWithinIssueCascadeCap(db, undefined, 5)).resolves.toBeUndefined();
    });

    it("passes until cap, then throws 429 HttpError", async () => {
      const { runId } = await seedHeartbeatRun(db);
      await assertWithinIssueCascadeCap(db, runId, 3);
      await assertWithinIssueCascadeCap(db, runId, 3);
      await assertWithinIssueCascadeCap(db, runId, 3);
      await expect(assertWithinIssueCascadeCap(db, runId, 3)).rejects.toMatchObject({
        status: 429,
      });
    });

    it("error message and details include the cap context", async () => {
      const { runId } = await seedHeartbeatRun(db);
      await assertWithinIssueCascadeCap(db, runId, 1);
      try {
        await assertWithinIssueCascadeCap(db, runId, 1);
        throw new Error("expected to throw");
      } catch (err: unknown) {
        const e = err as { status: number; message: string; details: { errorCode: string; cap: number; runId: string } };
        expect(e.status).toBe(429);
        expect(e.message).toMatch(/cascade cap of 1/);
        expect(e.details.errorCode).toBe("issue_cascade_cap_exceeded");
        expect(e.details.cap).toBe(1);
        expect(e.details.runId).toBe(runId);
      }
    });
  });

  it("counter survives concurrent increments without losing writes", async () => {
    const { runId } = await seedHeartbeatRun(db);
    const cap = 1000;
    const n = 50;
    const results = await Promise.all(
      Array.from({ length: n }, () => incrementHeartbeatIssueCount(db, runId, cap)),
    );
    const successCount = results.filter((r) => r !== null).length;
    expect(successCount).toBe(n);
    const sorted = (results.filter((r): r is number => r !== null)).sort((a, b) => a - b);
    expect(sorted[0]).toBe(1);
    expect(sorted[sorted.length - 1]).toBe(n);
  });
});
