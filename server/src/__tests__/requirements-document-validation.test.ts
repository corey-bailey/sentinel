// server/src/__tests__/requirements-document-validation.test.ts
import { describe, expect, it } from 'vitest';
import type { SlaTarget } from '@sentinel/db';
import {
  assignSlaTargetIds,
  canApprove,
  completenessGaps,
} from '../services/requirements-document-validation.js';

const target = (over: Partial<SlaTarget> = {}): SlaTarget => ({
  id: 't1', source: 'k6', metric: 'p95_ms', operator: 'lt', threshold: 500, required: true, ...over,
});

const completeDoc = {
  protocol: 'http',
  syncModel: 'sync',
  slaTargets: [target()],
  loadModel: { peakConcurrentUsers: 100 },
  targetEnvironment: { baseUrl: 'https://example.test' },
  testIntent: 'conformance',
};

describe('assignSlaTargetIds', () => {
  it('preserves existing ids and assigns stable uuids to new targets', () => {
    const existing = target({ id: 'keep-me' });
    const fresh = { source: 'k6', metric: 'error_rate', operator: 'lt' as const, threshold: 0.01, required: false };
    const out = assignSlaTargetIds([existing, fresh]);
    expect(out[0]!.id).toBe('keep-me');
    expect(out[1]!.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('canApprove', () => {
  it('true only when every REQUIRED target has an approver; optional targets are exempt', () => {
    expect(canApprove({ slaTargets: [target({ approvedByUserId: 'u1' })] })).toBe(true);
    expect(canApprove({ slaTargets: [target()] })).toBe(false);
    expect(canApprove({ slaTargets: [target({ required: false })] })).toBe(true);
    expect(canApprove({ slaTargets: [] })).toBe(true);
  });
});

describe('completenessGaps', () => {
  it('a complete conformance document has no gaps', () => {
    expect(completenessGaps(completeDoc)).toEqual([]);
  });

  it('flags missing protocol, syncModel, and baseUrl', () => {
    const gaps = completenessGaps({ ...completeDoc, protocol: null, syncModel: null, targetEnvironment: {} });
    expect(gaps.map((g) => g.field)).toEqual(['protocol', 'syncModel', 'targetEnvironment.baseUrl']);
  });

  it('conformance requires SLA targets and a load model', () => {
    const gaps = completenessGaps({ ...completeDoc, slaTargets: [], loadModel: null });
    expect(gaps.map((g) => g.field)).toEqual(['slaTargets', 'loadModel']);
  });

  it('baseline/exploratory intents relax SLA and load requirements only', () => {
    expect(completenessGaps({ ...completeDoc, slaTargets: [], loadModel: null, testIntent: 'baseline' })).toEqual([]);
    expect(completenessGaps({ ...completeDoc, slaTargets: [], loadModel: null, testIntent: 'exploratory' })).toEqual([]);
    // ...but not the base URL
    const gaps = completenessGaps({ ...completeDoc, targetEnvironment: null, testIntent: 'baseline' });
    expect(gaps.map((g) => g.field)).toEqual(['targetEnvironment.baseUrl']);
  });
});
