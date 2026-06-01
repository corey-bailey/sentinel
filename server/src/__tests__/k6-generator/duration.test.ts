import { describe, expect, it } from 'vitest';
import { parseDurationToSeconds, sumDurationsSeconds } from '../../services/k6-generator/duration.js';

describe('parseDurationToSeconds', () => {
  it('parses seconds, minutes, hours, and combinations', () => {
    expect(parseDurationToSeconds('30s')).toBe(30);
    expect(parseDurationToSeconds('2m')).toBe(120);
    expect(parseDurationToSeconds('1h')).toBe(3600);
    expect(parseDurationToSeconds('1h30m')).toBe(5400);
    expect(parseDurationToSeconds('1m30s')).toBe(90);
  });

  it('throws on an unparseable duration', () => {
    expect(() => parseDurationToSeconds('soon')).toThrow(/duration/i);
    expect(() => parseDurationToSeconds('')).toThrow(/duration/i);
  });
});

describe('sumDurationsSeconds', () => {
  it('sums a list of k6 duration strings', () => {
    expect(sumDurationsSeconds(['2m', '10m', '2m'])).toBe(840);
    expect(sumDurationsSeconds([])).toBe(0);
  });
});
