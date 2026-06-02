// server/src/services/pipeline-run.ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipelineRuns, type Db, type PipelineTrigger, type StageRecordMap, type StageRecord } from "@sentinel/db";
import { testAssets, testPlans, requirementsDocuments, slaVerdicts, type SlaTarget } from "@sentinel/db";
import { gateResolutions, testRuns, executionRuns } from "@sentinel/db";
import { and, eq } from "drizzle-orm";
import { resolveSteadyWindow, type SteadyWindow } from "./k6-generator/window.js";
import { k6Executor } from "./k6-executor.js";
import { executionRunService } from "./execution-runs.js";
import { slaVerdictEngine } from "./sla-verdict-engine.js";
import { testRunArtifactsService } from "./test-run-artifacts.js";
import { buildResolvedExecution } from "./pipeline-resolved-execution.js";
import { resolveGate, verdictForOutcome } from "./gate-resolver.js";
import type { SpawnFn } from "./test-adapters/k6-adapter.js";

export class UnsupportedTriggerPathError extends Error {
  constructor(path: string) { super(`Unsupported pipeline trigger path (v1 = execution-trigger only): ${path}`); this.name = "UnsupportedTriggerPathError"; }
}

export class ExecutePrerequisiteError extends Error {
  constructor(detail: string) { super(`Cannot execute: ${detail}`); this.name = "ExecutePrerequisiteError"; }
}

export type ExecuteInputs = {
  testPlan: typeof testPlans.$inferSelect;
  asset: typeof testAssets.$inferSelect;
  baseUrl: string;
  window: SteadyWindow;
};

// Resolves what the mechanical EXECUTE stage needs. v1: the first k6 asset for the plan, the baseUrl
// from requirements_documents.targetEnvironment, and the steady window derived from the plan's
// loadProfile (same derivation the generated script baked in — see Plan 3 window.ts).
export async function resolveExecuteInputs(
  db: Db, companyId: string, input: { testPlanId: string; requirementsDocumentId: string },
): Promise<ExecuteInputs> {
  const [testPlan] = await db.select().from(testPlans).where(and(eq(testPlans.id, input.testPlanId), eq(testPlans.companyId, companyId)));
  if (!testPlan) throw new ExecutePrerequisiteError(`test_plan ${input.testPlanId} not found`);

  const assets = await db.select().from(testAssets).where(and(eq(testAssets.companyId, companyId), eq(testAssets.testPlanId, input.testPlanId), eq(testAssets.engine, "k6")));
  const asset = assets.find((a) => a.scriptContent && a.scriptContent.length > 0);
  if (!asset) throw new ExecutePrerequisiteError(`no k6 asset with scriptContent for test_plan ${input.testPlanId}`);

  const [rd] = await db.select().from(requirementsDocuments).where(and(eq(requirementsDocuments.id, input.requirementsDocumentId), eq(requirementsDocuments.companyId, companyId)));
  const targetEnv = (rd?.targetEnvironment ?? {}) as { baseUrl?: unknown };
  const baseUrl = typeof targetEnv.baseUrl === "string" ? targetEnv.baseUrl : "";
  if (!baseUrl) throw new ExecutePrerequisiteError(`requirements_documents.targetEnvironment.baseUrl is missing`);

  // resolveSteadyWindow reads only executor/stages/evaluationWindow/duration/warmupGuard — the test_plans
  // LoadProfile is structurally compatible for those fields (the startVus/startVUs casing difference is
  // not read). Cast across the two LoadProfile types.
  const window = resolveSteadyWindow(testPlan.loadProfile as never);
  return { testPlan, asset, baseUrl, window };
}

export type RequiredVerdictCounts = { requiredTargetCount: number; requiredFailCount: number; requiredInconclusiveCount: number };

// Scopes the gate to REQUIRED SLA targets (the engine's aggregate counts mix in optional breaches).
export async function countRequiredVerdicts(
  db: Db, companyId: string, input: { pipelineRunId: string; executionRunId: string; requirementsDocumentId: string },
): Promise<RequiredVerdictCounts> {
  const [rd] = await db.select().from(requirementsDocuments).where(and(eq(requirementsDocuments.id, input.requirementsDocumentId), eq(requirementsDocuments.companyId, companyId)));
  const targets = (rd?.slaTargets ?? []) as SlaTarget[];
  const requiredIds = new Set(targets.filter((t) => t.required).map((t) => t.id));

  const rows = await db.select().from(slaVerdicts).where(and(eq(slaVerdicts.companyId, companyId), eq(slaVerdicts.pipelineRunId, input.pipelineRunId), eq(slaVerdicts.executionRunId, input.executionRunId)));
  let requiredFailCount = 0;
  let requiredInconclusiveCount = 0;
  for (const r of rows) {
    if (!requiredIds.has(r.slaTargetId)) continue;
    if (r.status === "fail") requiredFailCount++;
    else if (r.status === "inconclusive") requiredInconclusiveCount++;
  }
  return { requiredTargetCount: requiredIds.size, requiredFailCount, requiredInconclusiveCount };
}

const STAGE_ORDER = ["intake", "discovery", "plan", "generate", "validate", "execute", "analysis", "report"] as const;
export type StageName = (typeof STAGE_ORDER)[number];

function executionTriggerStages(): StageRecordMap {
  const skipped = (reason: string): StageRecord => ({ status: "skipped", skippedReason: reason });
  const pending = (): StageRecord => ({ status: "pending" });
  return {
    intake: skipped("execution-trigger: no new request"),
    discovery: skipped("execution-trigger: RequirementsDocument exists"),
    plan: skipped("execution-trigger: TestPlan exists"),
    generate: skipped("execution-trigger: assets exist"),
    validate: pending(),
    execute: pending(),
    analysis: pending(),
    report: pending(),
  };
}

export type CreatePipelineRunInput = {
  path: "execution-trigger";
  trigger: PipelineTrigger;
  testPlanId?: string | null;
  requirementsDocumentId?: string | null;
  pipelineRequestId?: string | null;
};

export function pipelineRunService(db: Db) {
  async function create(companyId: string, input: CreatePipelineRunInput) {
    if (input.path !== "execution-trigger") throw new UnsupportedTriggerPathError(String(input.path));
    const [row] = await db
      .insert(pipelineRuns)
      .values({
        companyId,
        testPlanId: input.testPlanId ?? null,
        requirementsDocumentId: input.requirementsDocumentId ?? null,
        pipelineRequestId: input.pipelineRequestId ?? null,
        trigger: input.trigger,
        stages: executionTriggerStages(),
      })
      .returning();
    return row!;
  }

  // --- internal: immutable read-modify-write of one stage's record ---
  async function patchStage(id: string, stage: StageName, patch: Partial<StageRecord>) {
    const [row] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, id));
    if (!row) throw new Error(`pipeline_run not found: ${id}`);
    const stages = row.stages as StageRecordMap;
    const next: StageRecordMap = { ...stages, [stage]: { ...stages[stage], ...patch } };
    const [updated] = await db.update(pipelineRuns).set({ stages: next, updatedAt: new Date() }).where(eq(pipelineRuns.id, id)).returning();
    return updated!;
  }

  async function markStageRunning(id: string, stage: StageName) {
    return patchStage(id, stage, { status: "running", startedAt: new Date().toISOString() });
  }
  async function markStageComplete(id: string, stage: StageName, patch: Partial<StageRecord> = {}) {
    return patchStage(id, stage, { status: "complete", completedAt: new Date().toISOString(), ...patch });
  }
  async function markStageSkipped(id: string, stage: StageName, skippedReason: string) {
    return patchStage(id, stage, { status: "skipped", skippedReason });
  }
  async function markStageFailed(id: string, stage: StageName, error: string) {
    return patchStage(id, stage, { status: "failed", completedAt: new Date().toISOString(), error });
  }
  async function setVerdict(id: string, verdict: string) {
    const [r] = await db.update(pipelineRuns).set({ verdict, updatedAt: new Date() }).where(eq(pipelineRuns.id, id)).returning();
    return r!;
  }
  async function setCiSignal(id: string, ciSignal: string) {
    const [r] = await db.update(pipelineRuns).set({ ciSignal, updatedAt: new Date() }).where(eq(pipelineRuns.id, id)).returning();
    return r!;
  }
  async function setResolvedExecution(id: string, resolvedExecution: unknown) {
    const [r] = await db.update(pipelineRuns).set({ resolvedExecution: resolvedExecution as never, updatedAt: new Date() }).where(eq(pipelineRuns.id, id)).returning();
    return r!;
  }
  async function markStarted(id: string) {
    const [r] = await db.update(pipelineRuns).set({ verdict: "running", startedAt: new Date(), updatedAt: new Date() }).where(eq(pipelineRuns.id, id)).returning();
    return r!;
  }
  async function markCompleted(id: string) {
    const [r] = await db.update(pipelineRuns).set({ completedAt: new Date(), updatedAt: new Date() }).where(eq(pipelineRuns.id, id)).returning();
    return r!;
  }

  async function runExecutionTrigger(
    pipelineRunId: string,
    deps: { spawnFn: SpawnFn; reachabilityProbe?: (baseUrl: string) => Promise<boolean> },
  ): Promise<{ verdict: string; ciSignal: string }> {
    await markStarted(pipelineRunId); // verdict='running'
    const [run] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, pipelineRunId));
    if (!run) throw new Error(`pipeline_run not found: ${pipelineRunId}`);
    if (!run.testPlanId || !run.requirementsDocumentId) {
      await markStageFailed(pipelineRunId, "execute", "pipeline_run missing testPlanId/requirementsDocumentId");
      await setVerdict(pipelineRunId, "error");
      await setCiSignal(pipelineRunId, "fail");
      await markCompleted(pipelineRunId);
      return { verdict: "error", ciSignal: "fail" };
    }
    const companyId = run.companyId;
    const testPlanId = run.testPlanId;
    const requirementsDocumentId = run.requirementsDocumentId;

    try {
      // ---- VALIDATE (thin: reachability probe; full Stage-4 validation deferred) ----
      await markStageRunning(pipelineRunId, "validate");
      const inputs = await resolveExecuteInputs(db, companyId, { testPlanId, requirementsDocumentId });
      const reachable = deps.reachabilityProbe ? await deps.reachabilityProbe(inputs.baseUrl) : true;
      if (!reachable) {
        await markStageFailed(pipelineRunId, "validate", `target not reachable: ${inputs.baseUrl}`);
        await setVerdict(pipelineRunId, "error"); await setCiSignal(pipelineRunId, "fail"); await markCompleted(pipelineRunId);
        return { verdict: "error", ciSignal: "fail" };
      }
      await markStageComplete(pipelineRunId, "validate");

      // ---- EXECUTE (server-side, mechanical) ----
      await markStageRunning(pipelineRunId, "execute");
      const [testRun] = await db.insert(testRuns).values({ companyId, testPlanId, pipelineRunId }).returning();
      const runs = executionRunService(db);
      const er = await runs.create(companyId, { pipelineRunId, testRunId: testRun!.id, testAssetId: inputs.asset.id, engine: "k6", binaryProfile: "k6" });
      const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "sentinel-run-"));
      await db.update(executionRuns).set({ workspaceRef: cwd }).where(eq(executionRuns.id, er.id));

      const execResult = await k6Executor({ db, spawnFn: deps.spawnFn }).run({
        companyId,
        executionRunId: er.id,
        testRunId: testRun!.id,
        cwd,
        asset: { scriptContent: inputs.asset.scriptContent ?? "", dataFiles: (inputs.asset.dataFiles ?? []).map((f) => ({ name: f.name, content: f.content })) },
        baseUrl: inputs.baseUrl,
        window: inputs.window,
      });

      // snapshot what actually executed
      await setResolvedExecution(pipelineRunId, buildResolvedExecution({
        loadProfile: (inputs.testPlan.loadProfile ?? null) as Record<string, unknown> | null,
        executionModel: inputs.testPlan.executionModel ?? null,
        asset: { id: inputs.asset.id, workflowName: "all", engine: "k6", version: inputs.asset.version, dataFiles: (inputs.asset.dataFiles ?? []).map((f) => ({ name: f.name, content: f.content })) },
        window: inputs.window,
      }));

      if (execResult.status === "failed") {
        await markStageFailed(pipelineRunId, "execute", `k6 exited ${execResult.exitCode}`);
        await setVerdict(pipelineRunId, "error"); await setCiSignal(pipelineRunId, "fail"); await markCompleted(pipelineRunId);
        return { verdict: "error", ciSignal: "fail" };
      }
      // persist the k6 HTML artifact (no-op if absent)
      await testRunArtifactsService(db).persistK6HtmlSummary(companyId, { pipelineRunId, executionRunId: er.id, testRunId: testRun!.id, cwd, testRunId2: testRun!.id });
      await markStageComplete(pipelineRunId, "execute", { executionRunIds: [er.id] });

      // ---- ANALYSIS (metrics already ingested by k6Executor) → SLA → gate ----
      await markStageRunning(pipelineRunId, "analysis");
      await slaVerdictEngine(db).evaluate({ companyId, pipelineRunId, executionRunId: er.id });
      const [rd] = await db.select().from(requirementsDocuments).where(eq(requirementsDocuments.id, requirementsDocumentId));
      const counts = await countRequiredVerdicts(db, companyId, { pipelineRunId, executionRunId: er.id, requirementsDocumentId });
      const gate = resolveGate({ testIntent: rd?.testIntent ?? "conformance", ...counts });
      await db.insert(gateResolutions).values({ companyId, pipelineRunId, testRunId: testRun!.id, outcome: gate.outcome, ciSignal: gate.ciSignal, resolvedBy: "auto", resolvedAt: new Date() });
      const verdict = verdictForOutcome(gate.outcome);
      await setVerdict(pipelineRunId, verdict);
      await setCiSignal(pipelineRunId, gate.ciSignal);
      await markStageComplete(pipelineRunId, "analysis");

      // ---- REPORT (thin: sentinel_summary artifact) ----
      await markStageRunning(pipelineRunId, "report");
      const summary = { pipelineRunId, verdict, ciSignal: gate.ciSignal, outcome: gate.outcome, requiredVerdicts: counts };
      const summaryPath = path.join(cwd, "sentinel-summary.json");
      await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
      await testRunArtifactsService(db).create(companyId, { pipelineRunId, executionRunId: er.id, testRunId: testRun!.id, artifactType: "sentinel_summary", storageRef: summaryPath, contentType: "application/json", sizeBytes: Buffer.byteLength(JSON.stringify(summary)) });
      await markStageComplete(pipelineRunId, "report");

      await markCompleted(pipelineRunId);
      return { verdict, ciSignal: gate.ciSignal };
    } catch (err) {
      // any unexpected error → mark the running stage failed where possible, verdict error
      await setVerdict(pipelineRunId, "error");
      await setCiSignal(pipelineRunId, "fail");
      await markCompleted(pipelineRunId);
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  return { create, markStageRunning, markStageComplete, markStageSkipped, markStageFailed, setVerdict, setCiSignal, setResolvedExecution, markStarted, markCompleted, runExecutionTrigger };
}
