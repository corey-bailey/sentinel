import { api } from "./client";

export type SLATarget = {
  metric: string;
  operator: "lt" | "lte" | "gt" | "gte";
  threshold: number;
  source: string;
};

export type Requirement = {
  id: string;
  companyId: string;
  name: string;
  description?: string;
  slaTargets: SLATarget[];
  source: string;
  jiraIssueId?: string | null;
  coverageStatus: string;
  createdAt: string;
  updatedAt: string;
};

export type LoadProfile = {
  vus: number;
  stages: Array<{ duration: string; target: number }>;
};

export type TestPlan = {
  id: string;
  companyId: string;
  requirementId?: string | null;
  name: string;
  description?: string;
  engines: string[];
  loadProfile?: LoadProfile | null;
  apmProvider?: string | null;
  apmServiceId?: string | null;
  filePatterns: string[];
  schedule?: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type TestAsset = {
  id: string;
  companyId: string;
  testPlanId: string;
  engine: string;
  assetType: string;
  scriptContent?: string | null;
  scriptPath?: string | null;
  version: number;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type CoverageEntry = {
  covered: boolean;
  assetType: string | null;
};

export type CoverageMap = Record<string, CoverageEntry>;

export type TestRun = {
  id: string;
  companyId: string;
  testPlanId: string;
  triggerType: string;
  triggerContext?: Record<string, unknown> | null;
  status: string;
  resultSignal?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
};

export type Baseline = {
  id: string;
  companyId: string;
  testPlanId: string;
  metric: string;
  baselineValue: number;
  tolerancePct: number;
  isActive: boolean;
  approvedByUserId?: string | null;
  approvedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Regression = {
  id: string;
  companyId: string;
  testRunId: string;
  metric: string;
  baselineValue?: number | null;
  actualValue: number;
  deviationPct?: number | null;
  status: string;
  regressionType: string;
  resolvedByUserId?: string | null;
  resolvedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export const requirementsApi = {
  list: (companyId: string) =>
    api.get<Requirement[]>(`/companies/${companyId}/requirements`),
  get: (id: string) => api.get<Requirement>(`/requirements/${id}`),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Requirement>(`/companies/${companyId}/requirements`, data),
  update: (id: string, data: Record<string, unknown>) =>
    api.patch<Requirement>(`/requirements/${id}`, data),
};

export const testPlansApi = {
  list: (companyId: string) =>
    api.get<TestPlan[]>(`/companies/${companyId}/test-plans`),
  get: (id: string) => api.get<TestPlan>(`/test-plans/${id}`),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<TestPlan>(`/companies/${companyId}/test-plans`, data),
};

export const testAssetsApi = {
  list: (companyId: string, testPlanId?: string) =>
    api.get<TestAsset[]>(
      `/companies/${companyId}/test-assets${testPlanId ? `?testPlanId=${testPlanId}` : ""}`,
    ),
  coverage: (companyId: string, testPlanId: string) =>
    api.get<CoverageMap>(`/companies/${companyId}/test-assets?coverage=${testPlanId}`),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<TestAsset>(`/companies/${companyId}/test-assets`, data),
};

export const testRunsApi = {
  list: (companyId: string, testPlanId?: string) =>
    api.get<TestRun[]>(
      `/companies/${companyId}/test-runs${testPlanId ? `?testPlanId=${testPlanId}` : ""}`,
    ),
  get: (id: string) => api.get<TestRun>(`/test-runs/${id}`),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<TestRun>(`/companies/${companyId}/test-runs`, data),
};

export const baselinesApi = {
  list: (companyId: string, testPlanId?: string) =>
    api.get<Baseline[]>(
      `/companies/${companyId}/baselines${testPlanId ? `?testPlanId=${testPlanId}` : ""}`,
    ),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Baseline>(`/companies/${companyId}/baselines`, data),
  approve: (id: string) => api.post<Baseline>(`/baselines/${id}/approve`, {}),
  reject: (id: string) => api.post<Baseline>(`/baselines/${id}/reject`, {}),
};

export const regressionsApi = {
  list: (companyId: string) =>
    api.get<Regression[]>(`/companies/${companyId}/regressions`),
  approve: (id: string) =>
    api.patch<Regression>(`/regressions/${id}`, { action: "approve" }),
  reject: (id: string) =>
    api.patch<Regression>(`/regressions/${id}`, { action: "reject" }),
};

export type StageRecord = {
  status: "pending" | "running" | "complete" | "failed" | "skipped";
  skippedReason?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  executionRunIds?: string[];
};

export type PipelineTrigger = {
  type: "manual_intake" | "jira" | "ci" | "scheduled" | "manual_rerun";
  source: string;
  ref?: string;
};

export type PipelineRun = {
  id: string;
  companyId: string;
  testPlanId?: string | null;
  requirementsDocumentId?: string | null;
  trigger: PipelineTrigger;
  stages: Record<string, StageRecord>;
  verdict: string;
  ciSignal: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ExecutionRun = {
  id: string;
  engine?: string | null;
  status: string;
  exitCode?: number | null;
  peakVus?: number | null;
  totalIterations?: number | null;
  totalRequests?: number | null;
  startedAt?: string | null;
  completedAt?: string | null;
};

export type SlaVerdictTarget = {
  id: string;
  source: string;
  metric: string;
  operator: "lt" | "lte" | "gt" | "gte";
  threshold: number;
  required: boolean;
  workflowScope?: string;
};

export type SlaVerdict = {
  id: string;
  slaTargetId: string;
  workflowName?: string | null;
  phase?: string | null;
  metric?: string | null;
  operator?: string | null;
  threshold?: number | null;
  actualValue?: number | null;
  source?: string | null;
  status: "pass" | "fail" | "inconclusive";
  target: SlaVerdictTarget | null;
};

export type GateResolution = {
  id: string;
  outcome: string;
  ciSignal: string;
  resolvedBy: string;
  resolvedAt?: string | null;
};

export type PipelineArtifact = {
  id: string;
  artifactType: string;
  contentType?: string | null;
  sizeBytes?: number | null;
  createdAt: string;
};

export type RequirementsDocumentSummary = {
  id: string;
  appName: string | null;
  status: string;
  testIntent: string;
  baseUrl: string | null;
  slaTargetCount: number;
  createdAt: string;
};

export type PipelineRunDetail = PipelineRun & {
  executionRuns: ExecutionRun[];
  slaVerdicts: SlaVerdict[];
  gateResolutions: GateResolution[];
  artifacts: PipelineArtifact[];
  requirementsDocument: { id: string; appName: string | null; testIntent: string; status: string } | null;
};

export const pipelineRunsApi = {
  list: (companyId: string, testPlanId?: string) =>
    api.get<PipelineRun[]>(
      `/companies/${companyId}/pipeline-runs${testPlanId ? `?testPlanId=${testPlanId}` : ""}`,
    ),
  get: (id: string) => api.get<PipelineRunDetail>(`/pipeline-runs/${id}`),
  trigger: (
    companyId: string,
    data: { testPlanId: string; requirementsDocumentId: string; trigger: PipelineTrigger },
  ) =>
    api.post<{ pipelineRunId: string; verdict: string; ciSignal: string | null }>(
      `/companies/${companyId}/pipeline-runs`,
      data,
    ),
};

export const requirementsDocumentsApi = {
  list: (companyId: string) =>
    api.get<RequirementsDocumentSummary[]>(`/companies/${companyId}/requirements-documents`),
};

// Plain href for new-tab artifact viewing (same-origin; session cookie rides along).
export const artifactContentUrl = (artifactId: string) => `/api/artifacts/${artifactId}/content`;

export const triggersApi = {
  deploy: (
    companyId: string,
    data: { repo: string; commit: string; changedFiles: string[] },
  ) => api.post<{ runIds: string[] }>(`/companies/${companyId}/triggers/deploy`, data),
};
