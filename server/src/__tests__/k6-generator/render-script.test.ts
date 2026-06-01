// server/src/__tests__/k6-generator/render-script.test.ts
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assembleScript } from '../../services/k6-generator/render-script.js';

const baseParts = {
  window: { warmupEndS: 0, rampUpEndS: 120, steadyEndS: 720, totalDurationS: 840 },
  scenarios: { weighted_loop: { executor: 'ramping-vus', startVUs: 0, stages: [{ duration: '2m', target: 500 }, { duration: '10m', target: 500 }, { duration: '2m', target: 0 }], gracefulRampDown: '30s', exec: 'router' } },
  thresholds: { 'http_req_duration{expected_response:true,phase:steady}': ['p(95)<500'], 'http_req_failed{phase:steady}': ['rate<0.01'] },
  execModel: 'weighted-loop' as const,
  execFnsSource: 'export function router() { http.get(BASE + "/search", params("search")); }',
  hasReusable: true,
  hasConsumable: false,
};

describe('assembleScript', () => {
  it('bakes window defaults, options, summaryTrendStats and the exec fns', () => {
    const src = assembleScript(baseParts);
    expect(src).toContain('var WARMUP_END_S = Number(__ENV.WARMUP_END_S || 0);');
    expect(src).toContain('var RAMP_UP_END_S = Number(__ENV.RAMP_UP_END_S || 120);');
    expect(src).toContain('var STEADY_END_S = Number(__ENV.STEADY_END_S || 720);');
    expect(src).toContain('"summaryTrendStats"');
    expect(src).toContain('p(99)');
    expect(src).toContain('export const options =');
    expect(src).toContain('export function router()');
    expect(src).toContain('export function handleSummary(data)');
    expect(src).toContain('JSON.stringify(data)'); // handleSummary writes the raw k6 summary
  });

  it('produces a syntactically valid ES module (node --check)', () => {
    const src = assembleScript(baseParts);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'k6gen-')), 'script.mjs');
    fs.writeFileSync(file, src);
    // node --check parses syntax only; remote imports are not fetched.
    expect(() => execFileSync('node', ['--check', file])).not.toThrow();
  });
});
