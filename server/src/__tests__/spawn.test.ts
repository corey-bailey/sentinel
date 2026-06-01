import { describe, expect, it } from 'vitest';
import { createExecFileSpawn } from '../services/test-adapters/spawn.js';

describe('createExecFileSpawn', () => {
  const spawn = createExecFileSpawn();

  it('captures stdout and a zero exit code on success', async () => {
    const res = await spawn(process.execPath, ['-e', 'process.stdout.write("hello")'], { env: {} });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('hello');
  });

  it('captures a non-zero exit code and stderr without throwing', async () => {
    const res = await spawn(process.execPath, ['-e', 'process.stderr.write("boom"); process.exit(7)'], { env: {} });
    expect(res.exitCode).toBe(7);
    expect(res.stderr).toContain('boom');
  });

  it('passes env vars through to the child', async () => {
    const res = await spawn(process.execPath, ['-e', 'process.stdout.write(process.env.FOO || "")'], { env: { FOO: 'bar' } });
    expect(res.stdout).toBe('bar');
  });

  it('rethrows ENOENT for a missing binary', async () => {
    await expect(spawn('definitely-not-a-real-binary-xyz', [], { env: {} })).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
