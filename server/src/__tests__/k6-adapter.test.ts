import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type SpawnResult, runK6, readK6Summary } from '../services/test-adapters/k6-adapter.js';

describe('runK6', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs `k6 run <script>` in the cwd with no --vus/--stage flags', async () => {
    const spawnFn = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } satisfies SpawnResult);
    await runK6({
      scriptPath: 'script.js', cwd: '/work/run-1', testRunId: 'tr-1',
      baseUrl: 'http://localhost:3000', window: { warmupEndS: 0, rampUpEndS: 120, steadyEndS: 720 }, spawnFn,
    });
    const [cmd, args, opts] = spawnFn.mock.calls[0]!;
    expect(cmd).toBe('k6');
    expect(args).toEqual(['run', 'script.js']);
    expect(args).not.toContain('--vus');
    expect(args).not.toContain('--stage');
    expect(opts.cwd).toBe('/work/run-1');
    expect(opts.env).toMatchObject({ BASE_URL: 'http://localhost:3000', TEST_RUN_ID: 'tr-1', RAMP_UP_END_S: '120', STEADY_END_S: '720' });
  });

  it('injects EXECUTION_RUN_ID and AUTH_TOKEN when provided', async () => {
    const spawnFn = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } satisfies SpawnResult);
    await runK6({
      scriptPath: 's.js', cwd: '/w', testRunId: 'tr', executionRunId: 'er-9', authToken: 'tok',
      baseUrl: 'http://x', window: { warmupEndS: 0, rampUpEndS: 1, steadyEndS: 2 }, spawnFn,
    });
    const [, , opts] = spawnFn.mock.calls[0]!;
    expect(opts.env).toMatchObject({ EXECUTION_RUN_ID: 'er-9', AUTH_TOKEN: 'tok' });
  });

  it('marks failed=true on a non-zero exit (threshold breach)', async () => {
    const spawnFn = vi.fn().mockResolvedValue({ exitCode: 99, stdout: '', stderr: 'thresholds failed' } satisfies SpawnResult);
    const res = await runK6({ scriptPath: 's.js', cwd: '/w', testRunId: 'tr', baseUrl: 'http://x', window: { warmupEndS: 0, rampUpEndS: 1, steadyEndS: 2 }, spawnFn });
    expect(res.exitCode).toBe(99);
    expect(res.failed).toBe(true);
    expect(res.summaryFileName).toBe('summary-tr.json');
  });

  it('translates ENOENT into a clear "install k6" error', async () => {
    const spawnFn = vi.fn().mockRejectedValue(Object.assign(new Error('spawn k6 ENOENT'), { code: 'ENOENT' }));
    await expect(runK6({ scriptPath: 's.js', cwd: '/w', testRunId: 'tr', baseUrl: 'http://x', window: { warmupEndS: 0, rampUpEndS: 1, steadyEndS: 2 }, spawnFn }))
      .rejects.toThrow(/k6.*not found|install k6/i);
  });
});

describe('readK6Summary', () => {
  it('reads and parses the RAW k6 summary json from the cwd (transform happens in the harness)', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'k6sum-'));
    const rawK6Data = { metrics: { 'http_req_duration{expected_response:true,phase:steady}': { type: 'trend', values: { 'p(95)': 180, count: 1200 } } } };
    await fs.writeFile(path.join(cwd, 'summary-tr-1.json'), JSON.stringify(rawK6Data));
    const out = await readK6Summary(cwd, 'tr-1');
    expect(out.metrics?.['http_req_duration{expected_response:true,phase:steady}']?.values?.['p(95)']).toBe(180);
  });

  it('throws a clear error when the summary file is missing', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'k6sum-'));
    await expect(readK6Summary(cwd, 'absent')).rejects.toThrow(/summary-absent\.json/);
  });
});
