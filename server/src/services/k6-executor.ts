import fs from "node:fs/promises";
import path from "node:path";
import type { Db } from "@sentinel/db";
import { runK6, readK6Summary, type SpawnFn, type K6Window } from "./test-adapters/k6-adapter.js";
import { mapK6Summary } from "./k6-generator/summary-mapping.js";
import { metricSeriesService } from "./metric-series.js";
import { executionRunService } from "./execution-runs.js";

export type K6ExecutorDeps = { db: Db; spawnFn: SpawnFn; binary?: string };

export type K6ExecutionInput = {
  companyId: string;
  executionRunId: string;
  testRunId: string | null;
  cwd: string;
  asset: { scriptContent: string; dataFiles: Array<{ name: string; content: string }> };
  baseUrl: string;
  window: K6Window;
  authToken?: string;
};

export type K6ExecutionResult = {
  status: "completed" | "failed";
  exitCode: number;
  ingestedCount: number;
};

const SCRIPT_FILENAME = "script.js";

export function k6Executor(deps: K6ExecutorDeps) {
  const metrics = metricSeriesService(deps.db);
  const runs = executionRunService(deps.db);

  async function run(input: K6ExecutionInput): Promise<K6ExecutionResult> {
    // 1. Materialize the asset into the per-run workspace cwd.
    await fs.writeFile(path.join(input.cwd, SCRIPT_FILENAME), input.asset.scriptContent);
    for (const f of input.asset.dataFiles) {
      await fs.writeFile(path.join(input.cwd, f.name), f.content);
    }

    // 2. Run k6 for real.
    await runs.markRunning(input.executionRunId);
    const runResult = await runK6({
      scriptPath: SCRIPT_FILENAME,
      cwd: input.cwd,
      testRunId: input.testRunId ?? input.executionRunId,
      executionRunId: input.executionRunId,
      baseUrl: input.baseUrl,
      window: input.window,
      authToken: input.authToken,
      spawnFn: deps.spawnFn,
      binary: deps.binary,
    });

    // 3. A non-zero exit before a summary is written => failed run, no metrics.
    if (runResult.failed) {
      await runs.complete(input.executionRunId, { status: "failed", exitCode: runResult.exitCode });
      return { status: "failed", exitCode: runResult.exitCode, ingestedCount: 0 };
    }

    // 4. Read the RAW k6 summary the generated handleSummary wrote, transform it (harness-side), ingest.
    const raw = await readK6Summary(input.cwd, input.testRunId ?? input.executionRunId);
    const { series, run } = mapK6Summary(raw);
    let ingestedCount = 0;
    if (input.testRunId && series.length > 0) {
      const created = await metrics.ingest(input.companyId, {
        testRunId: input.testRunId,
        executionRunId: input.executionRunId,
        source: "k6",
        series,
      });
      ingestedCount = created.length;
    }

    // 5. Record run-level metrics on the execution run.
    await runs.complete(input.executionRunId, {
      status: "completed",
      exitCode: runResult.exitCode,
      peakVus: run.peakVus,
      totalRequests: run.totalRequests,
      totalIterations: run.totalIterations,
    });

    return { status: "completed", exitCode: runResult.exitCode, ingestedCount };
  }

  return { run };
}
