import { execFileSync } from 'node:child_process';

export const k6Support = (() => {
  try {
    execFileSync('k6', ['version'], { stdio: 'ignore' });
    return { available: true };
  } catch {
    return { available: false };
  }
})();
