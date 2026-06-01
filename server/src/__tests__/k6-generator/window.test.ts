// server/src/__tests__/k6-generator/window.test.ts
import { describe, expect, it } from 'vitest';
import { resolveSteadyWindow } from '../../services/k6-generator/window.js';
import type { LoadProfile } from '../../services/k6-generator/types.js';

describe('resolveSteadyWindow', () => {
  it('ramping-vus: steady spans the plateau between ramp-up end and ramp-down start', () => {
    const lp: LoadProfile = {
      protocol: 'http', executor: 'ramping-vus', startVUs: 0,
      stages: [{ duration: '2m', target: 500 }, { duration: '10m', target: 500 }, { duration: '2m', target: 0 }],
    };
    expect(resolveSteadyWindow(lp)).toEqual({
      warmupEndS: 0, rampUpEndS: 120, steadyEndS: 720, totalDurationS: 840,
    });
  });

  it('constant-arrival-rate: warmup then steady then cooldown', () => {
    const lp: LoadProfile = {
      protocol: 'http', executor: 'constant-arrival-rate', rate: 1200, timeUnit: '1s', duration: '14m',
      evaluationWindow: { warmup: '1m', steady: '12m', cooldown: '1m' },
    };
    expect(resolveSteadyWindow(lp)).toEqual({
      warmupEndS: 60, rampUpEndS: 60, steadyEndS: 780, totalDurationS: 840,
    });
  });

  it('constant-vus baseline: whole run is steady minus the front-edge warmup guard', () => {
    const lp: LoadProfile = { protocol: 'http', executor: 'constant-vus', vus: 1, duration: '5m' };
    expect(resolveSteadyWindow(lp)).toEqual({
      warmupEndS: 30, rampUpEndS: 30, steadyEndS: 300, totalDurationS: 300,
    });
  });

  it('constant-vus honors an explicit warmupGuard', () => {
    const lp: LoadProfile = { protocol: 'http', executor: 'constant-vus', vus: 1, duration: '5m', warmupGuard: '10s' };
    expect(resolveSteadyWindow(lp)).toMatchObject({ warmupEndS: 10, rampUpEndS: 10, steadyEndS: 300 });
  });
});
