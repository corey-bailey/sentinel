import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { computeObservedAmount } from "../services/budgets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function seedScope(db: ReturnType<typeof createDb>) {
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

async function seedCostEvent(
  db: ReturnType<typeof createDb>,
  companyId: string,
  agentId: string,
  values: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    costCents: number;
  },
) {
  await db.insert(costEvents).values({
    companyId,
    agentId,
    inputTokens: values.inputTokens,
    cachedInputTokens: values.cachedInputTokens,
    outputTokens: values.outputTokens,
    costCents: values.costCents,
    model: "test",
    provider: "test",
    occurredAt: new Date(),
  });
}

describeEmbeddedPostgres("budget token-metric observation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-budget-tokens-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(costEvents);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("sums billed_cents per the cost_cents column", async () => {
    const { companyId, agentId } = await seedScope(db);
    await seedCostEvent(db, companyId, agentId, {
      inputTokens: 1000, cachedInputTokens: 500, outputTokens: 200, costCents: 12,
    });
    await seedCostEvent(db, companyId, agentId, {
      inputTokens: 100, cachedInputTokens: 0, outputTokens: 50, costCents: 8,
    });
    const observed = await computeObservedAmount(db, {
      companyId, scopeType: "agent", scopeId: agentId,
      windowKind: "calendar_month_utc", metric: "billed_cents",
    });
    expect(observed).toBe(20);
  });

  it("sums input_tokens including cached_input_tokens", async () => {
    const { companyId, agentId } = await seedScope(db);
    await seedCostEvent(db, companyId, agentId, {
      inputTokens: 1000, cachedInputTokens: 500, outputTokens: 200, costCents: 12,
    });
    await seedCostEvent(db, companyId, agentId, {
      inputTokens: 100, cachedInputTokens: 0, outputTokens: 50, costCents: 8,
    });
    const observed = await computeObservedAmount(db, {
      companyId, scopeType: "agent", scopeId: agentId,
      windowKind: "calendar_month_utc", metric: "input_tokens",
    });
    // 1000+500 + 100+0 = 1600
    expect(observed).toBe(1600);
  });

  it("sums output_tokens only from output column", async () => {
    const { companyId, agentId } = await seedScope(db);
    await seedCostEvent(db, companyId, agentId, {
      inputTokens: 1000, cachedInputTokens: 500, outputTokens: 200, costCents: 12,
    });
    await seedCostEvent(db, companyId, agentId, {
      inputTokens: 100, cachedInputTokens: 0, outputTokens: 50, costCents: 8,
    });
    const observed = await computeObservedAmount(db, {
      companyId, scopeType: "agent", scopeId: agentId,
      windowKind: "calendar_month_utc", metric: "output_tokens",
    });
    expect(observed).toBe(250);
  });

  it("sums total_tokens = input + cached + output", async () => {
    const { companyId, agentId } = await seedScope(db);
    await seedCostEvent(db, companyId, agentId, {
      inputTokens: 1000, cachedInputTokens: 500, outputTokens: 200, costCents: 12,
    });
    await seedCostEvent(db, companyId, agentId, {
      inputTokens: 100, cachedInputTokens: 0, outputTokens: 50, costCents: 8,
    });
    const observed = await computeObservedAmount(db, {
      companyId, scopeType: "agent", scopeId: agentId,
      windowKind: "calendar_month_utc", metric: "total_tokens",
    });
    // 1000+500+200 + 100+0+50 = 1850
    expect(observed).toBe(1850);
  });

  it("returns 0 for unknown metrics", async () => {
    const { companyId, agentId } = await seedScope(db);
    await seedCostEvent(db, companyId, agentId, {
      inputTokens: 1000, cachedInputTokens: 0, outputTokens: 200, costCents: 12,
    });
    const observed = await computeObservedAmount(db, {
      companyId, scopeType: "agent", scopeId: agentId,
      windowKind: "calendar_month_utc", metric: "made_up_metric",
    });
    expect(observed).toBe(0);
  });

  it("isolates by agent for agent-scoped policies", async () => {
    const a = await seedScope(db);
    const b = await seedScope(db);
    await seedCostEvent(db, a.companyId, a.agentId, {
      inputTokens: 1000, cachedInputTokens: 0, outputTokens: 0, costCents: 0,
    });
    await seedCostEvent(db, b.companyId, b.agentId, {
      inputTokens: 9999, cachedInputTokens: 0, outputTokens: 0, costCents: 0,
    });
    const observedA = await computeObservedAmount(db, {
      companyId: a.companyId, scopeType: "agent", scopeId: a.agentId,
      windowKind: "calendar_month_utc", metric: "input_tokens",
    });
    expect(observedA).toBe(1000);
  });
});
