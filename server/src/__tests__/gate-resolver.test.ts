// server/src/__tests__/gate-resolver.test.ts
import { describe, expect, it } from 'vitest';
import { resolveGate, resolveHumanGate } from '../services/gate-resolver.js';

describe('resolveGate', () => {
  it('all required pass → auto_pass / pass', () => {
    expect(resolveGate({ testIntent: 'conformance', requiredTargetCount: 2, requiredFailCount: 0, requiredInconclusiveCount: 0 }))
      .toEqual({ outcome: 'auto_pass', ciSignal: 'pass' });
  });
  it('a required breach → auto_fail / fail', () => {
    expect(resolveGate({ testIntent: 'conformance', requiredTargetCount: 2, requiredFailCount: 1, requiredInconclusiveCount: 0 }))
      .toEqual({ outcome: 'auto_fail', ciSignal: 'fail' });
  });
  it('a required inconclusive (no fail) → inconclusive / fail (never false-green)', () => {
    expect(resolveGate({ testIntent: 'conformance', requiredTargetCount: 1, requiredFailCount: 0, requiredInconclusiveCount: 1 }))
      .toEqual({ outcome: 'inconclusive', ciSignal: 'fail' });
  });
  it('fail takes precedence over inconclusive', () => {
    expect(resolveGate({ testIntent: 'conformance', requiredTargetCount: 3, requiredFailCount: 1, requiredInconclusiveCount: 1 }).outcome).toBe('auto_fail');
  });
  it('baseline intent → characterization / pass regardless of counts', () => {
    expect(resolveGate({ testIntent: 'baseline', requiredTargetCount: 0, requiredFailCount: 0, requiredInconclusiveCount: 0 }))
      .toEqual({ outcome: 'characterization', ciSignal: 'pass' });
  });
  it('exploratory intent → characterization / pass', () => {
    expect(resolveGate({ testIntent: 'exploratory', requiredTargetCount: 1, requiredFailCount: 1, requiredInconclusiveCount: 0 }).outcome).toBe('characterization');
  });
  it('conformance with no required targets → characterization / pass', () => {
    expect(resolveGate({ testIntent: 'conformance', requiredTargetCount: 0, requiredFailCount: 0, requiredInconclusiveCount: 0 }))
      .toEqual({ outcome: 'characterization', ciSignal: 'pass' });
  });
});

describe('resolveHumanGate (Stage-7 resolutions)', () => {
  it('approvals pass: baseline_approved and regression_approved (waived) → pass/pass', () => {
    expect(resolveHumanGate('baseline_approved')).toEqual({ outcome: 'baseline_approved', ciSignal: 'pass', verdict: 'pass' });
    expect(resolveHumanGate('regression_approved')).toEqual({ outcome: 'regression_approved', ciSignal: 'pass', verdict: 'pass' });
  });
  it('rejections fail: baseline_rejected and regression_rejected (confirmed) → fail/fail', () => {
    expect(resolveHumanGate('baseline_rejected')).toEqual({ outcome: 'baseline_rejected', ciSignal: 'fail', verdict: 'fail' });
    expect(resolveHumanGate('regression_rejected')).toEqual({ outcome: 'regression_rejected', ciSignal: 'fail', verdict: 'fail' });
  });
});
