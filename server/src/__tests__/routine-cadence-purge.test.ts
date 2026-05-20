import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, routines, routineTriggers } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { purgeBelowFloorScheduleTriggers } from "../services/routine-cadence-purge.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function seedCompany(db: ReturnType<typeof createDb>) {
  const suffix = randomUUID().slice(0, 6).toUpperCase();
  const [company] = await db
    .insert(companies)
    .values({
      name: `co-${randomUUID()}`,
      ownerUserId: `u-${randomUUID()}`,
      issuePrefix: `T${suffix}`,
    })
    .returning();
  return company!;
}

async function seedRoutineWithTrigger(
  db: ReturnType<typeof createDb>,
  cronExpression: string,
  enabled = true,
  existingCompanyId?: string,
) {
  const companyId = existingCompanyId ?? (await seedCompany(db)).id;
  const [agent] = await db
    .insert(agents)
    .values({ companyId, name: `agent-${randomUUID()}` })
    .returning();
  const [routine] = await db
    .insert(routines)
    .values({
      companyId,
      title: `routine-${randomUUID()}`,
      assigneeAgentId: agent!.id,
      createdByUserId: "test",
    })
    .returning();
  const [trigger] = await db
    .insert(routineTriggers)
    .values({
      companyId,
      routineId: routine!.id,
      kind: "schedule",
      enabled,
      cronExpression,
      timezone: "UTC",
    })
    .returning();
  return { companyId, routineId: routine!.id, triggerId: trigger!.id };
}

describeEmbeddedPostgres("routine cadence purge", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-cadence-purge-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("disables below-floor triggers and reports them", async () => {
    const { triggerId } = await seedRoutineWithTrigger(db, "*/5 * * * *");
    const result = await purgeBelowFloorScheduleTriggers(db);
    expect(result.disabled).toHaveLength(1);
    expect(result.disabled[0]!.triggerId).toBe(triggerId);
    expect(result.disabled[0]!.cadenceMinutes).toBe(5);

    const row = await db
      .select()
      .from(routineTriggers)
      .where(eq(routineTriggers.id, triggerId))
      .then((rows) => rows[0]!);
    expect(row.enabled).toBe(false);
  });

  it("leaves at-floor triggers untouched", async () => {
    const { triggerId } = await seedRoutineWithTrigger(db, "*/15 * * * *");
    const result = await purgeBelowFloorScheduleTriggers(db);
    expect(result.disabled).toHaveLength(0);
    const row = await db
      .select()
      .from(routineTriggers)
      .where(eq(routineTriggers.id, triggerId))
      .then((rows) => rows[0]!);
    expect(row.enabled).toBe(true);
  });

  it("leaves above-floor triggers untouched", async () => {
    const co = await seedCompany(db);
    await seedRoutineWithTrigger(db, "0 * * * *", true, co.id); // hourly
    await seedRoutineWithTrigger(db, "0 9,10,11 * * 1-5", true, co.id); // 60min gaps
    const result = await purgeBelowFloorScheduleTriggers(db);
    expect(result.disabled).toHaveLength(0);
  });

  it("skips already-disabled triggers", async () => {
    const { triggerId } = await seedRoutineWithTrigger(db, "*/5 * * * *", false);
    const result = await purgeBelowFloorScheduleTriggers(db);
    expect(result.disabled).toHaveLength(0);
    const row = await db
      .select()
      .from(routineTriggers)
      .where(eq(routineTriggers.id, triggerId))
      .then((rows) => rows[0]!);
    expect(row.enabled).toBe(false);
  });

  it("is idempotent — second run finds nothing", async () => {
    await seedRoutineWithTrigger(db, "* * * * *");
    const first = await purgeBelowFloorScheduleTriggers(db);
    expect(first.disabled).toHaveLength(1);
    const second = await purgeBelowFloorScheduleTriggers(db);
    expect(second.disabled).toHaveLength(0);
  });

  it("processes multiple violators in one sweep", async () => {
    const co = await seedCompany(db);
    await seedRoutineWithTrigger(db, "* * * * *", true, co.id);      // 1m
    await seedRoutineWithTrigger(db, "*/5 * * * *", true, co.id);    // 5m
    await seedRoutineWithTrigger(db, "*/10 * * * *", true, co.id);   // 10m
    await seedRoutineWithTrigger(db, "*/15 * * * *", true, co.id);   // 15m — at floor
    const result = await purgeBelowFloorScheduleTriggers(db);
    expect(result.disabled).toHaveLength(3);
    expect(result.disabled.map((d) => d.cadenceMinutes).sort((a, b) => a - b)).toEqual([1, 5, 10]);
  });
});
