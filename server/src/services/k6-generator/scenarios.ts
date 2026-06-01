// server/src/services/k6-generator/scenarios.ts
import type { LoadProfile, Workflow } from './types.js';

// k6 scenario objects are JSON-serializable; we model them loosely (k6 validates at runtime).
export type K6Scenario = Record<string, unknown>;
export type ScenarioPlan = {
  scenarios: Record<string, K6Scenario>;
  execFns: string[];                 // exec function names the script must define: ['router'] or per-workflow names
  execModel: 'weighted-loop' | 'per-scenario';
};
export type ScenarioOpts = { p95EstimateMs: number };

// JS identifier from a workflow name (k6 exec must be a valid exported function name).
export function execName(workflow: string): string {
  const cleaned = workflow.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, '_$1');
  return cleaned.length > 0 ? cleaned : 'wf';
}

export function buildScenarios(
  lp: LoadProfile,
  workflows: Workflow[],
  executionModel: 'weighted-loop' | 'per-scenario',
  opts: ScenarioOpts,
): ScenarioPlan {
  if (lp.executor === 'ramping-vus') {
    return {
      scenarios: {
        weighted_loop: {
          executor: 'ramping-vus',
          startVUs: lp.startVUs ?? 0,
          stages: lp.stages,
          gracefulRampDown: lp.gracefulRampDown ?? '30s',
          exec: 'router',
        },
      },
      execFns: ['router'],
      execModel: 'weighted-loop',
    };
  }

  if (lp.executor === 'constant-vus') {
    return {
      scenarios: {
        baseline: { executor: 'constant-vus', vus: lp.vus, duration: lp.duration, exec: 'router' },
      },
      execFns: ['router'],
      execModel: 'weighted-loop',
    };
  }

  // constant-arrival-rate → per-scenario, one named scenario per workflow.
  const p95s = Math.max(opts.p95EstimateMs / 1000, 0.001);
  const scenarios: Record<string, K6Scenario> = {};
  const execFns: string[] = [];
  for (const wf of workflows) {
    const rate = Math.max(1, Math.round(lp.rate * wf.weight));
    const preAllocatedVUs = lp.preAllocatedVUs ?? Math.max(1, Math.ceil(rate * p95s));
    const maxVUs = lp.maxVUs ?? preAllocatedVUs * 4;
    const fn = execName(wf.name);
    scenarios[wf.name] = {
      executor: 'constant-arrival-rate',
      rate,
      timeUnit: lp.timeUnit,
      duration: lp.duration,
      preAllocatedVUs,
      maxVUs,
      exec: fn,
      tags: { workflow: wf.name },
    };
    execFns.push(fn);
  }
  return { scenarios, execFns, execModel: 'per-scenario' };
}
