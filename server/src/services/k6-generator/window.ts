// server/src/services/k6-generator/window.ts
import { parseDurationToSeconds } from './duration.js';
import type { LoadProfile } from './types.js';

export type SteadyWindow = {
  warmupEndS: number;
  rampUpEndS: number;
  steadyEndS: number;
  totalDurationS: number;
};

const DEFAULT_BASELINE_WARMUP_GUARD = '30s';

export function resolveSteadyWindow(lp: LoadProfile): SteadyWindow {
  if (lp.executor === 'ramping-vus') {
    const peak = Math.max(...lp.stages.map((s) => s.target));
    let cum = 0;
    let rampUpEndS = 0;
    let steadyEndS = 0;
    let reachedPeak = false;
    for (const stage of lp.stages) {
      const dur = parseDurationToSeconds(stage.duration);
      const start = cum;
      cum += dur;
      if (!reachedPeak && stage.target >= peak) {
        rampUpEndS = cum;          // steady begins at the end of the stage that first reaches peak
        steadyEndS = cum;
        reachedPeak = true;
      } else if (reachedPeak && stage.target >= peak) {
        steadyEndS = cum;          // extend steady across additional plateau stages
      } else if (reachedPeak && stage.target < peak) {
        steadyEndS = start;        // ramp-down begins → steady ends at this stage's start
        break;
      }
    }
    return { warmupEndS: 0, rampUpEndS, steadyEndS, totalDurationS: cum };
  }

  if (lp.executor === 'constant-arrival-rate') {
    const warmup = parseDurationToSeconds(lp.evaluationWindow.warmup);
    const steady = parseDurationToSeconds(lp.evaluationWindow.steady);
    const total = parseDurationToSeconds(lp.duration);
    return { warmupEndS: warmup, rampUpEndS: warmup, steadyEndS: warmup + steady, totalDurationS: total };
  }

  // constant-vus baseline
  const guard = parseDurationToSeconds(lp.warmupGuard ?? DEFAULT_BASELINE_WARMUP_GUARD);
  const total = parseDurationToSeconds(lp.duration);
  return { warmupEndS: guard, rampUpEndS: guard, steadyEndS: total, totalDurationS: total };
}
