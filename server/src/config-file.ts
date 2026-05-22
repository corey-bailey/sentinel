import fs from "node:fs";
import { sentinelConfigSchema, type PaperclipConfig } from "@sentinel/shared";
import { resolveSentinelConfigPath } from "./paths.js";

export function readConfigFile(): PaperclipConfig | null {
  const configPath = resolveSentinelConfigPath();

  if (!fs.existsSync(configPath)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return sentinelConfigSchema.parse(raw);
  } catch {
    return null;
  }
}
