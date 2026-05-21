import type { CLIAdapterModule } from "@sentinel/adapter-utils";
import { printAcpxStreamEvent } from "@sentinel/adapter-acpx-local/cli";
import { printClaudeStreamEvent } from "@sentinel/adapter-claude-local/cli";
import { printCodexStreamEvent } from "@sentinel/adapter-codex-local/cli";
import { printCursorStreamEvent } from "@sentinel/adapter-cursor-local/cli";
import { printCursorCloudEvent } from "@sentinel/adapter-cursor-cloud/cli";
import { printGeminiStreamEvent } from "@sentinel/adapter-gemini-local/cli";
import { printGrokStreamEvent } from "@sentinel/adapter-grok-local/cli";
import { printOpenCodeStreamEvent } from "@sentinel/adapter-opencode-local/cli";
import { printPiStreamEvent } from "@sentinel/adapter-pi-local/cli";
import { printOpenClawGatewayStreamEvent } from "@sentinel/adapter-openclaw-gateway/cli";
import { processCLIAdapter } from "./process/index.js";
import { httpCLIAdapter } from "./http/index.js";

const claudeLocalCLIAdapter: CLIAdapterModule = {
  type: "claude_local",
  formatStdoutEvent: printClaudeStreamEvent,
};

const acpxLocalCLIAdapter: CLIAdapterModule = {
  type: "acpx_local",
  formatStdoutEvent: printAcpxStreamEvent,
};

const codexLocalCLIAdapter: CLIAdapterModule = {
  type: "codex_local",
  formatStdoutEvent: printCodexStreamEvent,
};

const openCodeLocalCLIAdapter: CLIAdapterModule = {
  type: "opencode_local",
  formatStdoutEvent: printOpenCodeStreamEvent,
};

const piLocalCLIAdapter: CLIAdapterModule = {
  type: "pi_local",
  formatStdoutEvent: printPiStreamEvent,
};

const cursorLocalCLIAdapter: CLIAdapterModule = {
  type: "cursor",
  formatStdoutEvent: printCursorStreamEvent,
};

const cursorCloudCLIAdapter: CLIAdapterModule = {
  type: "cursor_cloud",
  formatStdoutEvent: printCursorCloudEvent,
};

const geminiLocalCLIAdapter: CLIAdapterModule = {
  type: "gemini_local",
  formatStdoutEvent: printGeminiStreamEvent,
};

const grokLocalCLIAdapter: CLIAdapterModule = {
  type: "grok_local",
  formatStdoutEvent: printGrokStreamEvent,
};

const openclawGatewayCLIAdapter: CLIAdapterModule = {
  type: "openclaw_gateway",
  formatStdoutEvent: printOpenClawGatewayStreamEvent,
};

const adaptersByType = new Map<string, CLIAdapterModule>(
  [
    acpxLocalCLIAdapter,
    claudeLocalCLIAdapter,
    codexLocalCLIAdapter,
    openCodeLocalCLIAdapter,
    piLocalCLIAdapter,
    cursorLocalCLIAdapter,
    cursorCloudCLIAdapter,
    geminiLocalCLIAdapter,
    grokLocalCLIAdapter,
    openclawGatewayCLIAdapter,
    processCLIAdapter,
    httpCLIAdapter,
  ].map((a) => [a.type, a]),
);

export function getCLIAdapter(type: string): CLIAdapterModule {
  return adaptersByType.get(type) ?? processCLIAdapter;
}
