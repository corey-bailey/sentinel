import type { SlaTarget } from '@sentinel/db';

// v1 LoadProfile subset (the spec's discriminated union; non-HTTP/unsupported executors are rejected).
export type RampStage = { duration: string; target: number };

export type RampingVusProfile = {
  protocol: 'http';
  executor: 'ramping-vus';
  startVUs?: number;
  stages: RampStage[];          // target = VUs
  gracefulRampDown?: string;
  thinkTime?: number;
};
export type ConstantArrivalRateProfile = {
  protocol: 'http';
  executor: 'constant-arrival-rate';
  rate: number;
  timeUnit: string;             // e.g. '1s'
  duration: string;
  evaluationWindow: { warmup: string; steady: string; cooldown: string };
  preAllocatedVUs?: number;     // derived if absent (Little's Law)
  maxVUs?: number;
};
export type ConstantVusProfile = {
  protocol: 'http';
  executor: 'constant-vus';     // TRUE BASELINE
  vus: number;                  // typically 1
  duration: string;
  warmupGuard?: string;         // default '30s'
};
export type LoadProfile = RampingVusProfile | ConstantArrivalRateProfile | ConstantVusProfile;

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type Workflow = {
  name: string;                 // 'checkout' | 'search' — MUST equal the SlaTarget.workflowScope it maps to
  weight: number;               // traffic-mix weight in [0,1]; sum across workflows ~= 1 (weighted-loop / arrival-rate split)
  request: {
    method: HttpMethod;
    path: string;               // e.g. '/checkout' (BASE_URL is prefixed at runtime)
    queryFromData?: string;     // reusable record field to interpolate into the query string (GET)
    bodyFromData?: boolean;     // POST/PUT/PATCH: JSON body is a claimed consumable record
  };
  dataStrategy: 'none' | 'reusable' | 'consumable';
};

export type GenerateK6Input = {
  loadProfile: LoadProfile;
  executionModel: 'weighted-loop' | 'per-scenario';
  workflows: Workflow[];
  slaTargets: SlaTarget[];      // requirements_documents.slaTargets[] (only source='k6' targets are realized in-script)
  data?: { reusable?: unknown[]; consumable?: unknown[] };
};

export type GeneratedDataFile = { name: string; content: string; type: 'json'; strategy: 'reusable' | 'consumable' };

export type GeneratedK6Asset = {
  engine: 'k6';
  protocol: 'http';
  binaryProfile: 'k6';
  assetType: 'generated';
  generatedFrom: 'scratch';
  scriptContent: string;
  dataFiles: GeneratedDataFile[];
  setupScript: null;            // setup() is embedded in scriptContent for v1
};
// NOTE: the metric→row transform lives in the HARNESS (mapK6Summary, Task 5), not in the asset.
// The generated script declares k6 thresholds (Task 4) so k6 materializes the tagged sub-metrics;
// the raw k6 summary it writes is transformed to metric_series rows by the executor (Task 14).

export class UnsupportedProtocolError extends Error {
  constructor(detail: string) {
    super(`Unsupported protocol/executor for v1 HTTP generation: ${detail}`);
    this.name = 'UnsupportedProtocolError';
  }
}
