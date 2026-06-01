// server/src/__tests__/k6-generator/thresholds.test.ts
import { describe, expect, it } from 'vitest';
import { buildThresholds } from '../../services/k6-generator/thresholds.js';
import type { SlaTarget } from '@sentinel/db';

const t = (o: Partial<SlaTarget> & Pick<SlaTarget, 'metric' | 'operator' | 'threshold'>): SlaTarget => ({
  id: o.id ?? `t-${o.metric}-${o.workflowScope ?? 'agg'}`, source: o.source ?? 'k6', required: o.required ?? true,
  workflowScope: o.workflowScope, ...o,
});

describe('buildThresholds', () => {
  it('aggregate latency + error-rate (no workflowScope) → single keys', () => {
    expect(buildThresholds([
      t({ metric: 'p95_ms', operator: 'lt', threshold: 500 }),
      t({ metric: 'error_rate', operator: 'lt', threshold: 0.01 }),
    ])).toEqual({
      'http_req_duration{expected_response:true,phase:steady}': ['p(95)<500'],
      'http_req_failed{phase:steady}': ['rate<0.01'],
    });
  });

  it('per-workflow latency: one key per workflow; multiple percentiles share a key; error-rate stays aggregate', () => {
    const out = buildThresholds([
      t({ metric: 'p95_ms', operator: 'lt', threshold: 300, workflowScope: 'checkout' }),
      t({ metric: 'p99_ms', operator: 'lt', threshold: 600, workflowScope: 'checkout' }),
      t({ metric: 'p95_ms', operator: 'lt', threshold: 200, workflowScope: 'search' }),
      t({ metric: 'error_rate', operator: 'lt', threshold: 0.005 }), // aggregate, NOT per-workflow
    ]);
    expect(out['http_req_duration{workflow:checkout,phase:steady,expected_response:true}']).toEqual(['p(95)<300', 'p(99)<600']);
    expect(out['http_req_duration{workflow:search,phase:steady,expected_response:true}']).toEqual(['p(95)<200']);
    expect(out['http_req_failed{phase:steady}']).toEqual(['rate<0.005']);
  });

  it('ignores non-k6 targets and unknown metrics', () => {
    expect(buildThresholds([
      t({ metric: 'p95_ms', operator: 'lt', threshold: 500, source: 'apm:dynatrace' }),
      t({ metric: 'mystery', operator: 'lt', threshold: 1 }),
    ])).toEqual({});
  });
});
