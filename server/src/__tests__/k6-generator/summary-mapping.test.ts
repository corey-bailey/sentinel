// server/src/__tests__/k6-generator/summary-mapping.test.ts
import { describe, expect, it } from 'vitest';
import { mapK6Summary } from '../../services/k6-generator/summary-mapping.js';

// Representative RAW k6 handleSummary(data) shape, with summaryTrendStats including med/p(95)/p(99)/count.
const data = {
  metrics: {
    // base (untagged) metric — must be IGNORED for series (no '{...}' tag)
    http_req_duration: { type: 'trend', values: { avg: 200, med: 170, 'p(95)': 340, 'p(99)': 470, count: 3000 } },
    // per-workflow, success-filtered, steady latency sub-metric (materialized by a Task-4 threshold)
    'http_req_duration{workflow:checkout,phase:steady,expected_response:true}': {
      type: 'trend', values: { avg: 210, min: 90, med: 180, max: 900, 'p(90)': 320, 'p(95)': 350, 'p(99)': 480, count: 1200 },
    },
    // aggregate error rate, steady (no workflow tag)
    'http_req_failed{phase:steady}': { type: 'rate', values: { rate: 0.004, passes: 1195, fails: 5 } },
    vus_max: { type: 'gauge', values: { value: 500, max: 500 } },
    http_reqs: { type: 'counter', values: { count: 1500, rate: 17.8 } },
    iterations: { type: 'counter', values: { count: 1500, rate: 17.8 } },
  },
};

describe('mapK6Summary', () => {
  it('emits p50/p95/p99 rows from a steady success-filtered latency sub-metric, workflowName from the tag', () => {
    const { series } = mapK6Summary(data);
    expect(series).toContainEqual({ metric: 'p50_ms', workflowName: 'checkout', phase: 'steady', value: 180, sampleCount: 1200 });
    expect(series).toContainEqual({ metric: 'p95_ms', workflowName: 'checkout', phase: 'steady', value: 350, sampleCount: 1200 });
    expect(series).toContainEqual({ metric: 'p99_ms', workflowName: 'checkout', phase: 'steady', value: 480, sampleCount: 1200 });
  });

  it('emits an aggregate error_rate row (workflowName null) with sampleCount = passes+fails', () => {
    const { series } = mapK6Summary(data);
    expect(series).toContainEqual({ metric: 'error_rate', workflowName: null, phase: 'steady', value: 0.004, sampleCount: 1200 });
  });

  it('ignores untagged base metrics and non-steady sub-metrics', () => {
    const { series } = mapK6Summary({
      metrics: {
        http_req_duration: { type: 'trend', values: { 'p(95)': 999, count: 10 } },
        'http_req_duration{workflow:x,phase:ramp_up,expected_response:true}': { type: 'trend', values: { 'p(95)': 999, count: 10 } },
      },
    });
    expect(series).toEqual([]);
  });

  it('extracts peakVus / totalRequests / totalIterations for the execution_runs row', () => {
    expect(mapK6Summary(data).run).toEqual({ peakVus: 500, totalRequests: 1500, totalIterations: 1500 });
  });

  it('tolerates a missing metrics object', () => {
    expect(mapK6Summary({})).toEqual({ series: [], run: { peakVus: null, totalRequests: null, totalIterations: null } });
  });
});
