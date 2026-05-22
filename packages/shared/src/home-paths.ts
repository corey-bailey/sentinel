import os from "node:os";
import path from "node:path";

export const DEFAULT_SENTINEL_INSTANCE_ID = "default";
export const SENTINEL_CONFIG_BASENAME = "config.json";
export const SENTINEL_ENV_FILENAME = ".env";

const PATH_SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;

export function expandHomePrefix(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.resolve(os.homedir(), value.slice(2));
  return value;
}

export function resolveSentinelHomeDir(homeOverride?: string): string {
  const raw = homeOverride?.trim() || process.env.SENTINEL_HOME?.trim();
  if (raw) return path.resolve(expandHomePrefix(raw));
  return path.resolve(os.homedir(), ".sentinel");
}

export function resolveSentinelInstanceId(instanceIdOverride?: string): string {
  const raw = instanceIdOverride?.trim() || process.env.SENTINEL_INSTANCE_ID?.trim() || DEFAULT_SENTINEL_INSTANCE_ID;
  if (!PATH_SEGMENT_RE.test(raw)) {
    throw new Error(`Invalid SENTINEL_INSTANCE_ID '${raw}'.`);
  }
  return raw;
}

export function resolveSentinelInstanceRoot(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveSentinelHomeDir(input.homeDir), "instances", resolveSentinelInstanceId(input.instanceId));
}

export function resolveSentinelInstanceConfigPath(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveSentinelInstanceRoot(input), SENTINEL_CONFIG_BASENAME);
}

export function resolveSentinelConfigPathForInstance(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return resolveSentinelInstanceConfigPath(input);
}

export function resolveSentinelEnvPathForConfig(configPath: string): string {
  return path.resolve(path.dirname(configPath), SENTINEL_ENV_FILENAME);
}

export function resolveDefaultEmbeddedPostgresDir(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveSentinelInstanceRoot(input), "db");
}

export function resolveDefaultLogsDir(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveSentinelInstanceRoot(input), "logs");
}

export function resolveDefaultSecretsKeyFilePath(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveSentinelInstanceRoot(input), "secrets", "master.key");
}

export function resolveDefaultStorageDir(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveSentinelInstanceRoot(input), "data", "storage");
}

export function resolveDefaultBackupDir(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveSentinelInstanceRoot(input), "data", "backups");
}

export function resolveHomeAwarePath(value: string): string {
  return path.resolve(expandHomePrefix(value));
}

