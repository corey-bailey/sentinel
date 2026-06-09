// server/src/services/baseline-comparator-runner.ts
// Stage-7 orchestration around the pure comparator: loads the active baseline set for the plan,
// compares this run's steady-phase metric_series against it, and either proposes a new baseline
// set (no active set) or records flagged regressions for human decision.
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { baselines, executionRuns, metricSeries, regressions, testRuns, type Db, type SlaTarget } from "@sentinel/db";
import { SLA_EVALUATION_PHASE } from "./metric-phases.js";
import {
  BASELINE_SET_SIZE, aggregateBaselineSet, compareMetric, directionForMetric, isCleanRun,
  metricKey, regressionTypeForMetric, worseningDirection, type WorseningDirection,
} from "./baseline-comparator.js";

export type ComparatorInput = {
  companyId: string;
  pipelineRunId: string;
  executionRunId: string;
  testRunId: string;
  testPlanId: string;
  slaTargets: SlaTarget[];
};

export type ComparatorResult =
  | { mode: "skipped"; reason: string }
  | { mode: "proposed"; baselineSetId: string; proposedCount: number }
  | { mode: "compared"; baselineSetId: string; comparedCount: number; flaggedCount: number };

// regressions.direction vocabulary ("higher_is_worse" | "lower_is_worse") vs the comparator's up/down.
function directionLabel(direction: WorseningDirection): string {
  return direction === "up" ? "higher_is_worse" : "lower_is_worse";
}

export function baselineComparatorRunner(db: Db) {
  // Direction per metric key: prefer the SLA operator of a matching target, else the metric family.
  function resolveDirection(targets: SlaTarget[], metric: string, source: string, workflowName: string | null) {
    const target = targets.find(
      (t) => t.metric === metric && t.source === source && (t.workflowScope ?? null) === workflowName,
    );
    return target ? worseningDirection(target.operator) : directionForMetric(metric);
  }

  // The most recent K clean execution runs for this plan (this run included) feed the
  // proposal's distribution model so a proposed baseline starts with real history.
  async function cleanRunValuesForPlan(input: ComparatorInput): Promise<Record<string, number[]>> {
    const ers = await db
      .select({ id: executionRuns.id, status: executionRuns.status, exitCode: executionRuns.exitCode })
      .from(executionRuns)
      .innerJoin(testRuns, eq(executionRuns.testRunId, testRuns.id))
      .where(and(
        eq(executionRuns.companyId, input.companyId),
        eq(testRuns.testPlanId, input.testPlanId),
      ))
      .orderBy(desc(executionRuns.createdAt))
      .limit(100);
    const cleanIds = ers.filter((er) => isCleanRun(er)).map((er) => er.id);
    if (cleanIds.length === 0) return {};

    const rows = await db
      .select()
      .from(metricSeries)
      .where(and(
        eq(metricSeries.companyId, input.companyId),
        eq(metricSeries.phase, SLA_EVALUATION_PHASE),
        inArray(metricSeries.executionRunId, cleanIds.slice(0, BASELINE_SET_SIZE)),
      ));
    const grouped: Record<string, number[]> = {};
    for (const row of rows) {
      if (row.value === null) continue;
      const key = metricKey(row.metric, row.source, row.workflowName);
      (grouped[key] ??= []).push(row.value);
    }
    return grouped;
  }

  async function run(input: ComparatorInput): Promise<ComparatorResult> {
    const steadyRows = await db
      .select()
      .from(metricSeries)
      .where(and(
        eq(metricSeries.companyId, input.companyId),
        eq(metricSeries.executionRunId, input.executionRunId),
        eq(metricSeries.phase, SLA_EVALUATION_PHASE),
      ));
    const measured = steadyRows.filter((r) => r.value !== null);
    if (measured.length === 0) return { mode: "skipped", reason: "no steady-phase metrics for this run" };

    const activeSet = await db
      .select()
      .from(baselines)
      .where(and(
        eq(baselines.companyId, input.companyId),
        eq(baselines.testPlanId, input.testPlanId),
        eq(baselines.isActive, true),
        isNull(baselines.validUntil),
      ));

    if (activeSet.length === 0) {
      // ---- PROPOSE: one pending baseline row per measured metric, grouped by a fresh set id ----
      const baselineSetId = randomUUID();
      const history = await cleanRunValuesForPlan(input);
      const stats = aggregateBaselineSet(history);
      const rows = measured.map((row) => {
        const key = metricKey(row.metric, row.source, row.workflowName);
        const s = stats[key] ?? { median: row.value!, stddev: 0, sampleN: 1 };
        const direction = resolveDirection(input.slaTargets, row.metric, row.source, row.workflowName);
        return {
          companyId: input.companyId,
          testPlanId: input.testPlanId,
          sourceRunId: input.testRunId,
          baselineSetId,
          metric: key,
          baselineValue: s.median,
          median: s.median,
          stddev: s.stddev,
          sampleN: s.sampleN,
          direction: directionLabel(direction),
          isActive: false,
        };
      });
      await db.insert(baselines).values(rows);
      return { mode: "proposed", baselineSetId, proposedCount: rows.length };
    }

    // ---- COMPARE: dual-threshold check against the active set; persist only flagged rows ----
    const baselineSetId = activeSet[0]!.baselineSetId ?? activeSet[0]!.id;
    const byKey = new Map(activeSet.map((b) => [b.metric, b]));
    let comparedCount = 0;
    const flaggedRows = [];
    for (const row of measured) {
      const key = metricKey(row.metric, row.source, row.workflowName);
      const baseline = byKey.get(key);
      if (!baseline) continue;
      comparedCount++;
      const direction = resolveDirection(input.slaTargets, row.metric, row.source, row.workflowName);
      const result = compareMetric(
        {
          median: baseline.median ?? baseline.baselineValue,
          stddev: baseline.stddev ?? 0,
          sampleN: baseline.sampleN ?? 1,
          tolerancePct: baseline.tolerancePct,
        },
        row.value!,
        direction,
      );
      if (!result.flagged) continue;
      flaggedRows.push({
        companyId: input.companyId,
        testRunId: input.testRunId,
        pipelineRunId: input.pipelineRunId,
        baselineId: baseline.id,
        baselineSetId,
        regressionType: regressionTypeForMetric(row.metric),
        direction: directionLabel(direction),
        metric: key,
        baselineValue: baseline.median ?? baseline.baselineValue,
        actualValue: row.value!,
        deviationPct: result.deltaPct,
        deltaPct: result.deltaPct,
        zScore: result.zScore,
        flagged: true,
        confidence: result.confidence,
        status: "open",
      });
    }
    if (flaggedRows.length) await db.insert(regressions).values(flaggedRows);
    return { mode: "compared", baselineSetId, comparedCount, flaggedCount: flaggedRows.length };
  }

  return { run };
}
