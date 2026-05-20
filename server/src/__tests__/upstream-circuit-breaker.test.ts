import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  upstreamHealthState,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  CIRCUIT_BREAKER_TRIPPING_ERROR_CODES,
  createUpstreamCircuitBreaker,
  isCircuitBreakerTrippingErrorCode,
  UPSTREAM_CIRCUIT_BREAKER_DEFAULTS,
} from "../services/upstream-circuit-breaker.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres upstream-circuit-breaker tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("upstream circuit breaker", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-upstream-circuit-breaker-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(upstreamHealthState);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(): Promise<string> {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: "Paperclip",
      issuePrefix: `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return id;
  }

  it("returns an empty snapshot for an unknown (company, adapter)", async () => {
    const breaker = createUpstreamCircuitBreaker(db);
    const companyId = await seedCompany();

    const snap = await breaker.isInCooldown(companyId, "claude_local");

    expect(snap.inCooldown).toBe(false);
    expect(snap.cooldownUntil).toBeNull();
    expect(snap.cooldownLevel).toBe(0);
    expect(snap.consecutiveFailures).toBe(0);
  });

  it("does not trip below threshold and counts failures within the window", async () => {
    const breaker = createUpstreamCircuitBreaker(db, { failureThreshold: 5 });
    const companyId = await seedCompany();
    const t0 = new Date("2026-05-19T20:00:00.000Z");

    for (let i = 1; i <= 4; i++) {
      const snap = await breaker.recordFailure(companyId, "claude_local", {
        errorCode: "claude_transient_upstream",
        now: new Date(t0.getTime() + i * 1000),
      });
      expect(snap.consecutiveFailures).toBe(i);
      expect(snap.inCooldown).toBe(false);
      expect(snap.cooldownLevel).toBe(0);
    }
  });

  it("trips at the threshold with cooldown level 1 (60s)", async () => {
    const breaker = createUpstreamCircuitBreaker(db, {
      failureThreshold: 5,
      cooldownDurationsMs: [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000],
    });
    const companyId = await seedCompany();
    const t0 = new Date("2026-05-19T20:00:00.000Z");

    let lastSnap = await breaker.recordFailure(companyId, "claude_local", { now: t0 });
    for (let i = 1; i < 5; i++) {
      lastSnap = await breaker.recordFailure(companyId, "claude_local", {
        now: new Date(t0.getTime() + i * 1000),
      });
    }

    expect(lastSnap.inCooldown).toBe(true);
    expect(lastSnap.cooldownLevel).toBe(1);
    expect(lastSnap.cooldownUntil?.toISOString()).toBe("2026-05-19T20:01:04.000Z");
    // Counter resets so the next breach has to re-accumulate failures.
    expect(lastSnap.consecutiveFailures).toBe(0);
  });

  it("escalates the cooldown ladder on subsequent breaches and caps at the last entry", async () => {
    // Use tiny windows / durations so the test runs deterministically with
    // explicit clocks.
    const breaker = createUpstreamCircuitBreaker(db, {
      failureThreshold: 2,
      failureWindowMs: 10_000,
      cooldownDurationsMs: [1_000, 4_000, 9_000],
    });
    const companyId = await seedCompany();
    let now = new Date("2026-05-19T20:00:00.000Z");

    async function breachOnce(expectedLevel: number, expectedDurationMs: number) {
      const a = await breaker.recordFailure(companyId, "claude_local", { now });
      expect(a.inCooldown).toBe(false);
      now = new Date(now.getTime() + 100);
      const b = await breaker.recordFailure(companyId, "claude_local", { now });
      expect(b.inCooldown).toBe(true);
      expect(b.cooldownLevel).toBe(expectedLevel);
      expect(b.cooldownUntil?.getTime()).toBe(now.getTime() + expectedDurationMs);
      // Advance past the cooldown so the next breach attempt isn't shadowed.
      now = new Date(b.cooldownUntil!.getTime() + 50);
    }

    await breachOnce(1, 1_000);
    await breachOnce(2, 4_000);
    await breachOnce(3, 9_000);
    // Capped — level keeps incrementing but duration stays at the last entry.
    await breachOnce(4, 9_000);
    await breachOnce(5, 9_000);
  });

  it("resets the failure counter when the next failure falls outside the window", async () => {
    const breaker = createUpstreamCircuitBreaker(db, {
      failureThreshold: 3,
      failureWindowMs: 1_000,
      cooldownDurationsMs: [60_000],
    });
    const companyId = await seedCompany();
    const t0 = new Date("2026-05-19T20:00:00.000Z");

    const s1 = await breaker.recordFailure(companyId, "claude_local", { now: t0 });
    expect(s1.consecutiveFailures).toBe(1);

    const s2 = await breaker.recordFailure(companyId, "claude_local", {
      now: new Date(t0.getTime() + 500),
    });
    expect(s2.consecutiveFailures).toBe(2);

    // Big gap — outside the 1 second window. Counter resets.
    const s3 = await breaker.recordFailure(companyId, "claude_local", {
      now: new Date(t0.getTime() + 60_000),
    });
    expect(s3.consecutiveFailures).toBe(1);
    expect(s3.inCooldown).toBe(false);
  });

  it("recordSuccess fully resets the breaker", async () => {
    const breaker = createUpstreamCircuitBreaker(db, {
      failureThreshold: 2,
      cooldownDurationsMs: [60_000],
    });
    const companyId = await seedCompany();
    const t0 = new Date("2026-05-19T20:00:00.000Z");

    await breaker.recordFailure(companyId, "claude_local", { now: t0 });
    const tripped = await breaker.recordFailure(companyId, "claude_local", {
      now: new Date(t0.getTime() + 100),
    });
    expect(tripped.inCooldown).toBe(true);

    const cleared = await breaker.recordSuccess(companyId, "claude_local", {
      now: new Date(t0.getTime() + 200),
    });
    expect(cleared.inCooldown).toBe(false);
    expect(cleared.cooldownUntil).toBeNull();
    expect(cleared.cooldownLevel).toBe(0);
    expect(cleared.consecutiveFailures).toBe(0);
    expect(cleared.lastSuccessAt?.getTime()).toBe(t0.getTime() + 200);
  });

  it("isInCooldown reflects natural cooldown expiry by clock advance", async () => {
    const breaker = createUpstreamCircuitBreaker(db, {
      failureThreshold: 2,
      cooldownDurationsMs: [1_000],
    });
    const companyId = await seedCompany();
    const t0 = new Date("2026-05-19T20:00:00.000Z");

    await breaker.recordFailure(companyId, "claude_local", { now: t0 });
    const tripped = await breaker.recordFailure(companyId, "claude_local", {
      now: new Date(t0.getTime() + 50),
    });
    expect(tripped.inCooldown).toBe(true);

    // Just before expiry.
    const stillHot = await breaker.isInCooldown(companyId, "claude_local", {
      now: new Date(tripped.cooldownUntil!.getTime() - 1),
    });
    expect(stillHot.inCooldown).toBe(true);

    // Past expiry — wall clock advanced beyond cooldownUntil.
    const cool = await breaker.isInCooldown(companyId, "claude_local", {
      now: new Date(tripped.cooldownUntil!.getTime() + 1),
    });
    expect(cool.inCooldown).toBe(false);
  });

  it("isolates (companyA, adapter) from (companyB, adapter) and per-adapter within a company", async () => {
    const breaker = createUpstreamCircuitBreaker(db, {
      failureThreshold: 2,
      cooldownDurationsMs: [60_000],
    });
    const companyA = await seedCompany();
    const companyB = await seedCompany();
    const t0 = new Date("2026-05-19T20:00:00.000Z");

    await breaker.recordFailure(companyA, "claude_local", { now: t0 });
    const trippedA = await breaker.recordFailure(companyA, "claude_local", {
      now: new Date(t0.getTime() + 100),
    });
    expect(trippedA.inCooldown).toBe(true);

    // Different company — should not be tripped.
    const snapB = await breaker.isInCooldown(companyB, "claude_local", {
      now: new Date(t0.getTime() + 100),
    });
    expect(snapB.inCooldown).toBe(false);

    // Same company, different adapter — should not be tripped.
    const snapAOther = await breaker.isInCooldown(companyA, "codex_local", {
      now: new Date(t0.getTime() + 100),
    });
    expect(snapAOther.inCooldown).toBe(false);
  });

  it("persists lastErrorCode from the most recent failure", async () => {
    const breaker = createUpstreamCircuitBreaker(db, { failureThreshold: 10 });
    const companyId = await seedCompany();
    const t0 = new Date("2026-05-19T20:00:00.000Z");

    await breaker.recordFailure(companyId, "claude_local", {
      errorCode: "claude_transient_upstream",
      now: t0,
    });
    const snap = await breaker.recordFailure(companyId, "claude_local", {
      errorCode: "claude_transient_upstream",
      now: new Date(t0.getTime() + 100),
    });
    expect(snap.lastErrorCode).toBe("claude_transient_upstream");
  });

  it("exposes a tripping-error-code helper for the heartbeat finalizer", () => {
    expect(isCircuitBreakerTrippingErrorCode("claude_transient_upstream")).toBe(true);
    expect(isCircuitBreakerTrippingErrorCode("codex_transient_upstream")).toBe(true);
    expect(isCircuitBreakerTrippingErrorCode("max_turns_exhausted")).toBe(false);
    expect(isCircuitBreakerTrippingErrorCode(null)).toBe(false);
    expect(isCircuitBreakerTrippingErrorCode(undefined)).toBe(false);
    expect(CIRCUIT_BREAKER_TRIPPING_ERROR_CODES.size).toBeGreaterThan(0);
  });

  it("exports defaults that match the published constants", () => {
    expect(UPSTREAM_CIRCUIT_BREAKER_DEFAULTS.failureThreshold).toBeGreaterThan(0);
    expect(UPSTREAM_CIRCUIT_BREAKER_DEFAULTS.failureWindowMs).toBeGreaterThan(0);
    expect(UPSTREAM_CIRCUIT_BREAKER_DEFAULTS.cooldownDurationsMs.length).toBeGreaterThan(0);
  });
});
