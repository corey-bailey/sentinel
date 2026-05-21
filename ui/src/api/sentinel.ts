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
};

export const regressionsApi = {
  list: (companyId: string) =>
    api.get<Regression[]>(`/companies/${companyId}/regressions`),
  approve: (id: string) =>
    api.patch<Regression>(`/regressions/${id}`, { action: "approve" }),
  reject: (id: string) =>
    api.patch<Regression>(`/regressions/${id}`, { action: "reject" }),
};

export const triggersApi = {
  deploy: (
    companyId: string,
    data: { repo: string; commit: string; changedFiles: string[] },
  ) => api.post<{ runIds: string[] }>(`/companies/${companyId}/triggers/deploy`, data),
};
