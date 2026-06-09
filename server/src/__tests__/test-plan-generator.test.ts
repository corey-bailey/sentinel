// server/src/__tests__/test-plan-generator.test.ts
import { describe, expect, it } from 'vitest';
import type { SlaTarget } from '@sentinel/db';
import {
  baselineDuration,
  deriveDefaultStages,
  deriveTestPlan,
  selectExecutionModel,
  selectLoadProfile,
  validateWorkflowWeights,
  type RequirementsDocumentInput,
} from '../services/test-plan-generator.js';
import { resolveSteadyWindow } from '../services/k6-generator/window.js';

const target = (over: Partial<SlaTarget> = {}): SlaTarget => ({
  id: 't1', source: 'k6', metric: 'p95_ms', operator: 'lt', threshold: 500, required: true, ...over,
});

const rd = (over: Partial<RequirementsDocumentInput> = {}): RequirementsDocumentInput => ({
  id: 'rd-1', appName: 'demo', protocol: 'http', slaTargets: [target()],
  loadModel: { peakConcurrentUsers: 100 }, minSampleCount: 200, testIntent: 'conformance', ...over,
});

describe('deriveDefaultStages', () => {
  it('shapes 10/80/10 over the total duration', () => {
    expect(deriveDefaultStages(100, 10)).toEqual([
      { duration: '60s', target: 100 },
      { duration: '480s', target: 100 },
      { duration: '60s', target: 0 },
    ]);
  });

  it('floors ramps at 30s for short totals', () => {
    const stages = deriveDefaultStages(50, 2); // 120s total → 10% = 12s < 30s floor
    expect(stages[0]).toEqual({ duration: '30s', target: 50 });
    expect(stages[1]).toEqual({ duration: '60s', target: 50 });
    expect(stages[2]).toEqual({ duration: '30s', target: 0 });
  });
});

describe('selectExecutionModel', () => {
  it('per-scenario iff any target is workflow-scoped', () => {
    expect(selectExecutionModel([target()])).toBe('weighted-loop');
    expect(selectExecutionModel([target({ workflowScope: 'checkout' })])).toBe('per-scenario');
  });
});

describe('validateWorkflowWeights', () => {
  it('passes when weights sum to 100 and scopes join', () => {
    const mix = [{ workflow: 'a', percentage: 60 }, { workflow: 'b', percentage: 40 }];
    expect(validateWorkflowWeights(mix, [target({ workflowScope: 'a' })])).toEqual([]);
  });

  it('flags a bad weight sum', () => {
    const gaps = validateWorkflowWeights([{ workflow: 'a', percentage: 60 }], []);
    expect(gaps[0]!.reason).toContain('sum to 60');
  });

  it('flags a workflowScope with no matching trafficMix workflow', () => {
    const gaps = validateWorkflowWeights([{ workflow: 'a', percentage: 100 }], [target({ workflowScope: 'missing' })]);
    expect(gaps[0]!.reason).toContain("workflowScope 'missing'");
  });

  it('flags empty workflow names', () => {
    const gaps = validateWorkflowWeights([{ workflow: ' ', percentage: 100 }], []);
    expect(gaps.some((g) => g.reason.includes('no workflow name'))).toBe(true);
  });
});

describe('selectLoadProfile', () => {
  it('baseline intent → constant-vus {vus:1}, never bounces on a missing peak', () => {
    const result = selectLoadProfile(rd({ testIntent: 'baseline', loadModel: null }));
    expect(result).toHaveProperty('profile');
    const profile = (result as { profile: { executor: string; vus: number } }).profile;
    expect(profile.executor).toBe('constant-vus');
    expect(profile.vus).toBe(1);
  });

  it('peakTps → flat constant-arrival-rate (v1-executable) with Little\'s-Law VU allocation and window triple', () => {
    const result = selectLoadProfile(rd({ loadModel: { peakTps: 200 } }));
    const profile = (result as { profile: Record<string, unknown> }).profile;
    expect(profile.executor).toBe('constant-arrival-rate');
    expect(profile.rate).toBe(200);
    // p95 estimate = 500ms (lowest p95 SLA) → 200 × 0.5 = 100 preAllocated, 4× max
    expect(profile.preAllocatedVUs).toBe(100);
    expect(profile.maxVUs).toBe(400);
    expect(profile.evaluationWindow).toEqual({ warmup: '60s', steady: '480s', cooldown: '60s' });
  });

  it('peakConcurrentUsers → ramping-vus with derived stages (db union startVus casing)', () => {
    const result = selectLoadProfile(rd());
    const profile = (result as { profile: Record<string, unknown> }).profile;
    expect(profile.executor).toBe('ramping-vus');
    expect(profile).toHaveProperty('startVus', 0);
    expect(profile).not.toHaveProperty('startVUs');
  });

  it('explicit vus stages win over peaks; rate-unit stages are an honest v1 gap', () => {
    const stages = [{ duration: '1m', target: 50 }, { duration: '5m', target: 50 }];
    const vus = selectLoadProfile(rd({ loadModel: { peakTps: 999, loadProfile: { targetUnit: 'vus', stages } } }));
    expect((vus as { profile: { executor: string } }).profile.executor).toBe('ramping-vus');
    const rate = selectLoadProfile(rd({ loadModel: { loadProfile: { targetUnit: 'rate', stages } } }));
    expect(rate).toHaveProperty('gaps');
  });

  it('gaps: no protocol, unsupported protocol, kafka mps, no load at all', () => {
    expect(selectLoadProfile(rd({ protocol: null }))).toHaveProperty('gaps');
    expect(selectLoadProfile(rd({ protocol: 'kafka' }))).toHaveProperty('gaps');
    expect(selectLoadProfile(rd({ loadModel: { peakMps: 100 } }))).toHaveProperty('gaps');
    expect(selectLoadProfile(rd({ loadModel: {} }))).toHaveProperty('gaps');
  });
});

describe('baselineDuration', () => {
  it('sizes duration to accrue minSampleCount steady samples with 2x safety, 2m floor', () => {
    expect(baselineDuration(200, 500)).toBe('4m'); // 200 × 0.5s × 2 = 200s → 4m (rounded up)
    expect(baselineDuration(10, 100)).toBe('2m'); // tiny → floor
  });
});

describe('deriveTestPlan', () => {
  it('derives a complete plan from a conformance document', () => {
    const result = deriveTestPlan(rd());
    expect(result).toHaveProperty('plan');
    const plan = (result as { plan: { name: string; engines: string[]; executionModel: string } }).plan;
    expect(plan.engines).toEqual(['k6']);
    expect(plan.executionModel).toBe('weighted-loop');
    expect(plan.name).toContain('demo');
  });

  it('collects gaps from both weights and load profile instead of failing fast', () => {
    const result = deriveTestPlan(rd({
      protocol: 'kafka',
      loadModel: { peakMps: 1, trafficMix: [{ workflow: 'a', percentage: 50 }] },
    }));
    expect(result).toHaveProperty('gaps');
    expect((result as { gaps: unknown[] }).gaps.length).toBeGreaterThanOrEqual(2);
  });

  it('derived profile is structurally accepted by resolveSteadyWindow (Stage-3 compatibility)', () => {
    for (const doc of [rd(), rd({ loadModel: { peakTps: 100 } }), rd({ testIntent: 'baseline' })]) {
      const result = deriveTestPlan(doc);
      expect(result).toHaveProperty('plan');
      const window = resolveSteadyWindow((result as { plan: { loadProfile: never } }).plan.loadProfile);
      expect(window.steadyEndS).toBeGreaterThan(window.rampUpEndS - 1);
      expect(window.totalDurationS).toBeGreaterThan(0);
      expect(Number.isFinite(window.steadyEndS)).toBe(true);
    }
  });
});
