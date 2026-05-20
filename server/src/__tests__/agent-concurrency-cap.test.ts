import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  countRunningRunsForAgent,
  isAgentAtConcurrencyCap,
} from "../services/agent-concurrency-cap.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function seedAgent(db: ReturnType<typeof createDb>) {
  const suffix = randomUUID().slice(0, 6).toUpperCase();
  const [company] = await db
    .insert(companies)
    .values({
      name: `co-${randomUUID()}`,
      ownerUserId: `u-${randomUUID()}`,
      issuePrefix: `T${suffix}`,
    })
    .returning();
  const [agent] = await db
    .insert(agents)
    .values({ companyId: company!.id, name: `agent-${randomUUID()}` })
    .returning();
  return { companyId: company!.id, agentId: agent!.id };
}

async function seedRuns(
  db: ReturnType<typeof createDb>,
  companyId: string,
  agentId: string,
  statuses: Array<"queued" | "running" | "succeeded" | "failed" | "cancelled">,
) {
  for (const status of statuses) {
    await db.insert(heartbeatRuns).values({ companyId, agentId, status });
  }
}

describeEmbeddedPostgres("per-agent concurrency cap", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-concurrency-cap-");
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

  describe("countRunningRunsForAgent", () => {
    it("returns 0 when agent has no runs", async () => {
      const { agentId } = await seedAgent(db);
      expect(await countRunningRunsForAgent(db, agentId)).toBe(0);
    });

    it("counts only status='running'", async () => {
      const { companyId, agentId } = await seedAgent(db);
      await seedRuns(db, companyId, agentId, [
        "running",
        "running",
        "queued",
        "succeeded",
        "failed",
        "cancelled",
      ]);
      expect(await countRunningRunsForAgent(db, agentId)).toBe(2);
    });

    it("isolates by agent", async () => {
      const a = await seedAgent(db);
      const b = await seedAgent(db);
      await seedRuns(db, a.companyId, a.agentId, ["running", "running", "running"]);
      await seedRuns(db, b.companyId, b.agentId, ["running"]);
      expect(await countRunningRunsForAgent(db, a.agentId)).toBe(3);
      expect(await countRunningRunsForAgent(db, b.agentId)).toBe(1);
    });
  });

  describe("isAgentAtConcurrencyCap", () => {
    it("returns false when cap is 0 (disabled)", async () => {
      const { companyId, agentId } = await seedAgent(db);
      await seedRuns(db, companyId, agentId, ["running", "running", "running", "running"]);
      expect(await isAgentAtConcurrencyCap(db, agentId, 0)).toBe(false);
    });

    it("returns false when cap is negative", async () => {
      const { companyId, agentId } = await seedAgent(db);
      await seedRuns(db, companyId, agentId, ["running"]);
      expect(await isAgentAtConcurrencyCap(db, agentId, -1)).toBe(false);
    });

    it("returns false when below cap", async () => {
      const { companyId, agentId } = await seedAgent(db);
      await seedRuns(db, companyId, agentId, ["running"]);
      expect(await isAgentAtConcurrencyCap(db, agentId, 2)).toBe(false);
    });

    it("returns true when at cap", async () => {
      const { companyId, agentId } = await seedAgent(db);
      await seedRuns(db, companyId, agentId, ["running", "running"]);
      expect(await isAgentAtConcurrencyCap(db, agentId, 2)).toBe(true);
    });

    it("returns true when above cap (consistency check)", async () => {
      const { companyId, agentId } = await seedAgent(db);
      await seedRuns(db, companyId, agentId, ["running", "running", "running"]);
      expect(await isAgentAtConcurrencyCap(db, agentId, 2)).toBe(true);
    });

    it("does not falsely trip on queued/succeeded/failed", async () => {
      const { companyId, agentId } = await seedAgent(db);
      await seedRuns(db, companyId, agentId, [
        "queued",
        "queued",
        "queued",
        "succeeded",
        "succeeded",
        "failed",
      ]);
      expect(await isAgentAtConcurrencyCap(db, agentId, 1)).toBe(false);
    });

    it("does not block agent B when agent A is at cap", async () => {
      const a = await seedAgent(db);
      const b = await seedAgent(db);
      await seedRuns(db, a.companyId, a.agentId, ["running", "running"]);
      expect(await isAgentAtConcurrencyCap(db, a.agentId, 2)).toBe(true);
      expect(await isAgentAtConcurrencyCap(db, b.agentId, 2)).toBe(false);
    });
  });
});
