// server/src/__tests__/k6-generator/scenarios.test.ts
import { describe, expect, it } from 'vitest';
import { buildScenarios } from '../../services/k6-generator/scenarios.js';
import type { GenerateK6Input } from '../../services/k6-generator/types.js';

const wf = (name: string, weight: number): GenerateK6Input['workflows'][number] => ({
  name, weight, request: { method: 'GET', path: `/${name}` }, dataStrategy: 'reusable',
});

describe('buildScenarios', () => {
  it('Shape A (ramping-vus): one weighted-loop scenario running the router', () => {
    const out = buildScenarios(
      { protocol: 'http', executor: 'ramping-vus', startVUs: 0,
        stages: [{ duration: '2m', target: 500 }, { duration: '10m', target: 500 }, { duration: '2m', target: 0 }] },
      [wf('search', 0.7), wf('detail', 0.3)],
      'weighted-loop',
      { p95EstimateMs: 500 },
    );
    expect(Object.keys(out.scenarios)).toEqual(['weighted_loop']);
    expect(out.scenarios.weighted_loop).toMatchObject({ executor: 'ramping-vus', exec: 'router', startVUs: 0 });
    expect(out.execModel).toBe('weighted-loop');
  });

  it('Shape B (constant-arrival-rate): one named scenario per workflow with derived VU allocation', () => {
    const out = buildScenarios(
      { protocol: 'http', executor: 'constant-arrival-rate', rate: 1000, timeUnit: '1s', duration: '14m',
        evaluationWindow: { warmup: '1m', steady: '12m', cooldown: '1m' } },
      [wf('search', 0.8), wf('checkout', 0.2)],
      'per-scenario',
      { p95EstimateMs: 200 },
    );
    expect(Object.keys(out.scenarios).sort()).toEqual(['checkout', 'search']);
    // rate = weight * total rate
    expect(out.scenarios.search).toMatchObject({ executor: 'constant-arrival-rate', rate: 800, exec: 'search', tags: { workflow: 'search' } });
    expect(out.scenarios.checkout).toMatchObject({ rate: 200, exec: 'checkout', tags: { workflow: 'checkout' } });
    // Little's Law: preAllocatedVUs = ceil(rate * p95s); search: ceil(800 * 0.2) = 160; maxVUs = 4x
    expect(out.scenarios.search.preAllocatedVUs).toBe(160);
    expect(out.scenarios.search.maxVUs).toBe(640);
  });

  it('baseline (constant-vus): single-VU router scenario', () => {
    const out = buildScenarios(
      { protocol: 'http', executor: 'constant-vus', vus: 1, duration: '5m' },
      [wf('search', 1)],
      'weighted-loop',
      { p95EstimateMs: 300 },
    );
    expect(out.scenarios.baseline).toMatchObject({ executor: 'constant-vus', vus: 1, exec: 'router', duration: '5m' });
  });
});
