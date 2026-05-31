import { describe, expect, it } from 'vitest';
import { classifyVerdict } from '../services/sla-evaluator.js';

describe('classifyVerdict (pure)', () => {
  const target = { id: 't1', source: 'k6', metric: 'p95_ms', operator: 'lt' as const, threshold: 200, required: true };

  it('pass when measured and within threshold', () => {
    expect(classifyVerdict(target, { value: 180, sampleCount: 1000, minSampleCount: 200, runHealthy: true }).status).toBe('pass');
  });
  it('fail when measured and breaches threshold', () => {
    expect(classifyVerdict(target, { value: 250, sampleCount: 1000, minSampleCount: 200, runHealthy: true }).status).toBe('fail');
  });
  it('inconclusive when the required metric is missing', () => {
    expect(classifyVerdict(target, { value: null, sampleCount: null, minSampleCount: 200, runHealthy: true }).status).toBe('inconclusive');
  });
  it('inconclusive when sampleCount below the floor', () => {
    expect(classifyVerdict(target, { value: 180, sampleCount: 50, minSampleCount: 200, runHealthy: true }).status).toBe('inconclusive');
  });
  it('inconclusive when the run is unhealthy', () => {
    expect(classifyVerdict(target, { value: 180, sampleCount: 1000, minSampleCount: 200, runHealthy: false }).status).toBe('inconclusive');
  });
  it('optional missing metric does NOT force inconclusive (records skipped)', () => {
    const opt = { ...target, required: false };
    expect(classifyVerdict(opt, { value: null, sampleCount: null, minSampleCount: 200, runHealthy: true }).status).toBe('skipped');
  });
});
