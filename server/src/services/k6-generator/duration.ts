// k6 duration strings: integers suffixed h/m/s, concatenated (e.g. '1h30m', '90s', '2m').
const DURATION_RE = /^(\d+h)?(\d+m)?(\d+s)?$/;

export function parseDurationToSeconds(d: string): number {
  const trimmed = d.trim();
  const m = DURATION_RE.exec(trimmed);
  if (!trimmed || !m || (!m[1] && !m[2] && !m[3])) {
    throw new Error(`Unparseable k6 duration: "${d}"`);
  }
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const s = m[3] ? parseInt(m[3], 10) : 0;
  return h * 3600 + min * 60 + s;
}

export function sumDurationsSeconds(durations: string[]): number {
  return durations.reduce((acc, d) => acc + parseDurationToSeconds(d), 0);
}
