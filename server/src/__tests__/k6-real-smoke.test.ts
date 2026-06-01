import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { generateK6Script } from '../services/k6-generator/generate.js';
import { runK6, readK6Summary } from '../services/test-adapters/k6-adapter.js';
import { mapK6Summary } from '../services/k6-generator/summary-mapping.js';
import { createExecFileSpawn } from '../services/test-adapters/spawn.js';
import { k6Support } from './helpers/k6-binary.js';
import type { GenerateK6Input } from '../services/k6-generator/types.js';

const d = k6Support.available ? describe : describe.skip;

d('real k6 smoke (constant-vus baseline against a local server)', () => {
  let server: http.Server;
  let baseUrl = '';

  beforeAll(async () => {
    server = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('generates, runs, and emits a parseable summary with steady-phase p95', async () => {
    const input: GenerateK6Input = {
      loadProfile: { protocol: 'http', executor: 'constant-vus', vus: 1, duration: '8s', warmupGuard: '1s' },
      executionModel: 'weighted-loop',
      workflows: [{ name: 'health', weight: 1, request: { method: 'GET', path: '/' }, dataStrategy: 'none' }],
      slaTargets: [{ id: 't1', source: 'k6', metric: 'p95_ms', operator: 'lt', threshold: 1000, required: true }],
    };
    const asset = generateK6Script(input);
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'k6smoke-'));
    await fs.writeFile(path.join(cwd, 'script.js'), asset.scriptContent);

    const res = await runK6({
      scriptPath: 'script.js', cwd, testRunId: 'smoke-1', baseUrl,
      window: { warmupEndS: 1, rampUpEndS: 1, steadyEndS: 8 }, spawnFn: createExecFileSpawn(),
    });
    expect(res.exitCode).toBe(0);

    const raw = await readK6Summary(cwd, 'smoke-1');     // raw k6 summary written by handleSummary
    const { series, run } = mapK6Summary(raw);           // the harness-side transform under real k6 output
    const p95 = series.find((s) => s.metric === 'p95_ms' && s.phase === 'steady');
    expect(p95).toBeDefined();
    expect(typeof p95!.value).toBe('number');
    expect(p95!.sampleCount).toBeGreaterThan(0);
    expect(run.totalRequests).toBeGreaterThan(0);
  }, 30_000);
});
