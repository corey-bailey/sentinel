// server/src/__tests__/k6-generator/generate.test.ts
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateK6Script } from '../../services/k6-generator/generate.js';
import { UnsupportedProtocolError } from '../../services/k6-generator/types.js';
import type { GenerateK6Input } from '../../services/k6-generator/types.js';
import type { SlaTarget } from '@sentinel/db';

const sla = (o: Partial<SlaTarget> & Pick<SlaTarget, 'metric' | 'operator' | 'threshold'>): SlaTarget => ({
  id: o.id ?? `t-${o.metric}-${o.workflowScope ?? 'agg'}`, source: o.source ?? 'k6', required: o.required ?? true, workflowScope: o.workflowScope, ...o,
});

function nodeChecks(src: string): void {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'k6gen-')), 'script.mjs');
  fs.writeFileSync(file, src);
  execFileSync('node', ['--check', file]); // throws if syntax invalid
}

describe('generateK6Script', () => {
  it('Shape A — weighted-loop aggregate: one router, aggregate thresholds, valid module', () => {
    const input: GenerateK6Input = {
      loadProfile: { protocol: 'http', executor: 'ramping-vus', startVUs: 0, stages: [{ duration: '2m', target: 500 }, { duration: '10m', target: 500 }, { duration: '2m', target: 0 }] },
      executionModel: 'weighted-loop',
      workflows: [
        { name: 'product-search', weight: 0.7, request: { method: 'GET', path: '/search', queryFromData: 'term' }, dataStrategy: 'reusable' },
        { name: 'product-detail', weight: 0.3, request: { method: 'GET', path: '/products', queryFromData: 'id' }, dataStrategy: 'reusable' },
      ],
      slaTargets: [sla({ metric: 'p95_ms', operator: 'lt', threshold: 500 }), sla({ metric: 'error_rate', operator: 'lt', threshold: 0.01 })],
      data: { reusable: [{ term: 'x', id: '1' }] },
    };
    const asset = generateK6Script(input);
    expect(asset).toMatchObject({ engine: 'k6', protocol: 'http', assetType: 'generated', generatedFrom: 'scratch', binaryProfile: 'k6' });
    expect(asset.dataFiles.map((f) => f.name)).toEqual(['reusable.json']);
    expect(asset.scriptContent).toContain('export function router()');
    expect(asset.scriptContent).toContain('http_req_duration{expected_response:true,phase:steady}'); // threshold materializes the sub-metric
    expect(asset.scriptContent).toContain('export function handleSummary(data)');
    nodeChecks(asset.scriptContent);
  });

  it('Shape B — per-scenario: one exec fn + threshold per workflow', () => {
    const input: GenerateK6Input = {
      loadProfile: { protocol: 'http', executor: 'constant-arrival-rate', rate: 1000, timeUnit: '1s', duration: '14m', evaluationWindow: { warmup: '1m', steady: '12m', cooldown: '1m' } },
      executionModel: 'per-scenario',
      workflows: [
        { name: 'search', weight: 0.8, request: { method: 'GET', path: '/search', queryFromData: 'term' }, dataStrategy: 'reusable' },
        { name: 'checkout', weight: 0.2, request: { method: 'POST', path: '/checkout', bodyFromData: true }, dataStrategy: 'consumable' },
      ],
      slaTargets: [sla({ metric: 'p95_ms', operator: 'lt', threshold: 200, workflowScope: 'search' }), sla({ metric: 'p95_ms', operator: 'lt', threshold: 300, workflowScope: 'checkout' }), sla({ metric: 'error_rate', operator: 'lt', threshold: 0.005 })],
      data: { reusable: [{ term: 'x' }], consumable: [{ sku: 'a' }, { sku: 'b' }] },
    };
    const asset = generateK6Script(input);
    expect(asset.scriptContent).toContain('export function search()');
    expect(asset.scriptContent).toContain('export function checkout()');
    expect(asset.scriptContent).toContain('claimConsumable()');
    expect(asset.scriptContent).toContain('http_req_duration{workflow:search,phase:steady,expected_response:true}');
    expect(asset.dataFiles.map((f) => f.name).sort()).toEqual(['consumable.json', 'reusable.json']);
    nodeChecks(asset.scriptContent);
  });

  it('baseline — constant-vus: single-VU router, whole run steady', () => {
    const input: GenerateK6Input = {
      loadProfile: { protocol: 'http', executor: 'constant-vus', vus: 1, duration: '2m' },
      executionModel: 'weighted-loop',
      workflows: [{ name: 'health', weight: 1, request: { method: 'GET', path: '/health' }, dataStrategy: 'none' }],
      slaTargets: [sla({ metric: 'p95_ms', operator: 'lt', threshold: 100 })],
    };
    const asset = generateK6Script(input);
    expect(asset.scriptContent).toContain('"executor": "constant-vus"');
    expect(asset.dataFiles).toEqual([]);
    nodeChecks(asset.scriptContent);
  });

  it('throws UnsupportedProtocolError for non-http protocols', () => {
    const input = {
      loadProfile: { protocol: 'kafka', producerRate: 100, duration: '5m' } as never,
      executionModel: 'per-scenario', workflows: [], slaTargets: [],
    } as unknown as GenerateK6Input;
    expect(() => generateK6Script(input)).toThrow(UnsupportedProtocolError);
  });
});
