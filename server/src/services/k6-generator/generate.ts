// server/src/services/k6-generator/generate.ts
import { resolveSteadyWindow } from './window.js';
import { buildScenarios, execName } from './scenarios.js';
import { buildThresholds } from './thresholds.js';
import { buildDataFiles } from './data-files.js';
import { assembleScript } from './render-script.js';
import { UnsupportedProtocolError, type GenerateK6Input, type GeneratedK6Asset, type Workflow } from './types.js';

const SUPPORTED_EXECUTORS = new Set(['ramping-vus', 'constant-arrival-rate', 'constant-vus']);

// Estimate the p95 latency (ms) used for arrival-rate VU allocation: the lowest p95 SLA ceiling if present, else 500.
function p95EstimateMs(input: GenerateK6Input): number {
  const p95s = input.slaTargets.filter((t) => t.source === 'k6' && t.metric === 'p95_ms').map((t) => t.threshold);
  return p95s.length ? Math.min(...p95s) : 500;
}

function requestSource(wf: Workflow): string {
  const url = wf.request.queryFromData
    ? `BASE + ${JSON.stringify(wf.request.path)} + "?${wf.request.queryFromData}=" + encodeURIComponent(String(rec.${wf.request.queryFromData}))`
    : `BASE + ${JSON.stringify(wf.request.path)}`;
  const tag = JSON.stringify(wf.name);
  if (wf.request.method === 'GET' || wf.request.method === 'DELETE') {
    const method = wf.request.method.toLowerCase();
    return `http.${method}(${url}, params(${tag}));`;
  }
  const method = wf.request.method.toLowerCase();
  const body = wf.request.bodyFromData ? 'JSON.stringify(claimConsumable())' : '"{}"';
  return `http.${method}(${url}, ${body}, params(${tag}));`;
}

function buildWeightedRouter(workflows: Workflow[]): string {
  // Cumulative-weight selection over Math.random(); {workflow} stamped per-request inside the chosen branch.
  const anyReusable = workflows.some((w) => w.dataStrategy === 'reusable');
  const lines: string[] = ['export function router() {'];
  if (anyReusable) lines.push('  var rec = reusable.length ? reusable[Math.floor(Math.random() * reusable.length)] : {};');
  lines.push('  var r = Math.random();');
  let acc = 0;
  workflows.forEach((wf, i) => {
    acc += wf.weight;
    const isLast = i === workflows.length - 1;
    let cond: string;
    if (isLast) {
      // A lone workflow has no preceding branch, so a bare `else` is invalid — emit an unconditional block.
      cond = i === 0 ? '{' : 'else {';
    } else {
      cond = `${i === 0 ? 'if' : 'else if'} (r < ${acc.toFixed(6)}) {`;
    }
    lines.push(`  ${cond}`);
    lines.push(`    ${requestSource(wf)}`);
    lines.push('  }');
  });
  lines.push('}');
  return lines.join('\n');
}

function buildPerScenarioFns(workflows: Workflow[]): string {
  return workflows.map((wf) => {
    const body: string[] = [`export function ${execName(wf.name)}() {`];
    if (wf.dataStrategy === 'reusable') body.push('  var rec = reusable[exec.scenario.iterationInTest % reusable.length];');
    body.push(`  ${requestSource(wf)}`);
    body.push('}');
    return body.join('\n');
  }).join('\n\n');
}

export function generateK6Script(input: GenerateK6Input): GeneratedK6Asset {
  const lp = input.loadProfile;
  if ((lp as { protocol?: string }).protocol !== 'http' || !SUPPORTED_EXECUTORS.has((lp as { executor?: string }).executor ?? '')) {
    throw new UnsupportedProtocolError(`${(lp as { protocol?: string }).protocol}/${(lp as { executor?: string }).executor}`);
  }

  const window = resolveSteadyWindow(lp);
  const scenarioPlan = buildScenarios(lp, input.workflows, input.executionModel, { p95EstimateMs: p95EstimateMs(input) });
  const thresholds = buildThresholds(input.slaTargets);
  const dataPlan = buildDataFiles(input.workflows, input.data);

  const execFnsSource = scenarioPlan.execModel === 'per-scenario'
    ? buildPerScenarioFns(input.workflows)
    : buildWeightedRouter(input.workflows);

  const scriptContent = assembleScript({
    window,
    scenarios: scenarioPlan.scenarios,
    thresholds,
    execModel: scenarioPlan.execModel,
    execFnsSource,
    hasReusable: dataPlan.hasReusable,
    hasConsumable: dataPlan.hasConsumable,
  });

  return {
    engine: 'k6',
    protocol: 'http',
    binaryProfile: 'k6',
    assetType: 'generated',
    generatedFrom: 'scratch',
    scriptContent,
    dataFiles: dataPlan.dataFiles,
    setupScript: null,
  };
}
