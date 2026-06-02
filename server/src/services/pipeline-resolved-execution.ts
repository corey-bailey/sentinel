// server/src/services/pipeline-resolved-execution.ts
import { createHash } from "node:crypto";
import type { ResolvedExecution } from "@sentinel/db";
import type { SteadyWindow } from "./k6-generator/window.js";

export type BuildResolvedExecutionInput = {
  loadProfile: Record<string, unknown> | null;
  executionModel: string | null;
  asset: { id: string; workflowName?: string | null; engine: string; version?: number | null; dataFiles?: Array<{ name: string; content: string }> | null };
  window: SteadyWindow;
};

// The immutable "what was actually executed" snapshot (distinct from the mutable TestPlan).
export function buildResolvedExecution(input: BuildResolvedExecutionInput): ResolvedExecution {
  const lp = (input.loadProfile ?? {}) as Record<string, unknown>;
  const executor = (typeof lp.executor === "string" ? lp.executor : "unknown") as ResolvedExecution["executor"];
  return {
    loadProfile: lp,
    executor,
    executionModel: (input.executionModel === "per-scenario" ? "per-scenario" : "weighted-loop"),
    resolvedSteadyWindow: { startMs: input.window.rampUpEndS * 1000, endMs: input.window.steadyEndS * 1000 },
    testAssetVersions: [{
      testAssetId: input.asset.id,
      workflowName: input.asset.workflowName ?? "all",
      engine: input.asset.engine,
      version: input.asset.version ?? 1,
    }],
    dataFileHashes: (input.asset.dataFiles ?? []).map((f) => ({
      name: f.name,
      sha256: createHash("sha256").update(f.content).digest("hex"),
    })),
    secretRef: "",
    rngSeed: 0,
  };
}
