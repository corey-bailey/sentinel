// server/src/__tests__/pipeline-resolved-execution.test.ts
import { describe, expect, it } from 'vitest';
import { buildResolvedExecution } from '../services/pipeline-resolved-execution.js';

describe('buildResolvedExecution', () => {
  it('snapshots loadProfile, executor/model, steady window (ms), asset version, and data hashes', () => {
    const out = buildResolvedExecution({
      loadProfile: { protocol: 'http', executor: 'ramping-vus', startVus: 0, stages: [{ duration: '2m', target: 500 }, { duration: '10m', target: 500 }, { duration: '2m', target: 0 }] },
      executionModel: 'weighted-loop',
      asset: { id: 'asset-1', workflowName: 'all', engine: 'k6', version: 3, dataFiles: [{ name: 'reusable.json', content: '[]' }] },
      window: { warmupEndS: 0, rampUpEndS: 120, steadyEndS: 720, totalDurationS: 840 },
    });
    expect(out.executor).toBe('ramping-vus');
    expect(out.executionModel).toBe('weighted-loop');
    expect(out.resolvedSteadyWindow).toEqual({ startMs: 120000, endMs: 720000 });
    expect(out.testAssetVersions).toEqual([{ testAssetId: 'asset-1', workflowName: 'all', engine: 'k6', version: 3 }]);
    expect(out.dataFileHashes[0]!.name).toBe('reusable.json');
    expect(out.dataFileHashes[0]!.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(out.loadProfile).toMatchObject({ executor: 'ramping-vus' });
  });

  it('tolerates a null loadProfile and no data files', () => {
    const out = buildResolvedExecution({
      loadProfile: null, executionModel: null,
      asset: { id: 'a', workflowName: 'all', engine: 'k6', version: 1, dataFiles: null },
      window: { warmupEndS: 30, rampUpEndS: 30, steadyEndS: 300, totalDurationS: 300 },
    });
    expect(out.executor).toBe('unknown');
    expect(out.executionModel).toBe('weighted-loop');
    expect(out.dataFileHashes).toEqual([]);
    expect(out.loadProfile).toEqual({});
  });
});
