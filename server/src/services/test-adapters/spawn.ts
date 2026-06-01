import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SpawnFn, SpawnResult } from "./k6-adapter.js";

const execFileAsync = promisify(execFile);

// A real SpawnFn backed by node:child_process.execFile. Captures stdout/stderr/exitCode and does NOT
// throw on a non-zero exit (k6 exits non-zero when thresholds breach — that is a result, not an error).
// ENOENT (binary missing) is rethrown so runK6 can translate it into a clear message.
export function createExecFileSpawn(opts: { maxBuffer?: number } = {}): SpawnFn {
  const maxBuffer = opts.maxBuffer ?? 128 * 1024 * 1024; // k6 stdout can be large
  return async (cmd, args, runOpts): Promise<SpawnResult> => {
    try {
      const { stdout, stderr } = await execFileAsync(cmd, args, {
        env: runOpts.env,
        cwd: runOpts.cwd,
        maxBuffer,
      });
      return { exitCode: 0, stdout: stdout.toString(), stderr: stderr.toString() };
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException & { stdout?: string | Buffer; stderr?: string | Buffer };
      if (e.code === "ENOENT") throw err;
      if (typeof e.code === "number") {
        return { exitCode: e.code, stdout: (e.stdout ?? "").toString(), stderr: (e.stderr ?? "").toString() };
      }
      throw err;
    }
  };
}
