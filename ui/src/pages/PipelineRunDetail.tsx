import { useEffect } from "react";
import { useParams } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { pipelineRunsApi, artifactContentUrl, type SlaVerdict, type StageRecord } from "../api/sentinel";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { verdictColor, ciSignalColor } from "./PipelineRuns";
import { Workflow, CheckCircle2, XCircle, CircleDashed, ExternalLink, FileText } from "lucide-react";

const STAGE_ORDER = ["intake", "discovery", "plan", "generate", "validate", "execute", "analysis", "report"] as const;

function formatDate(dateStr: string | null | undefined) {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleString();
}

function stageStatusBadge(status: string) {
  switch (status) {
    case "complete": return "bg-green-100 text-green-800";
    case "running": return "bg-blue-100 text-blue-800";
    case "failed": return "bg-red-100 text-red-800";
    case "skipped": return "bg-gray-100 text-gray-500";
    default: return "bg-yellow-50 text-yellow-700";
  }
}

function verdictStatusIcon(status: SlaVerdict["status"]) {
  switch (status) {
    case "pass": return <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />;
    case "fail": return <XCircle className="h-4 w-4 text-red-600 shrink-0" />;
    default: return <CircleDashed className="h-4 w-4 text-amber-600 shrink-0" />;
  }
}

function verdictCardBorder(status: SlaVerdict["status"]) {
  switch (status) {
    case "pass": return "border-green-200 bg-green-50";
    case "fail": return "border-red-200 bg-red-50";
    default: return "border-amber-200 bg-amber-50";
  }
}

function VerdictCard({ verdict }: { verdict: SlaVerdict }) {
  const metric = verdict.target?.metric ?? verdict.metric ?? "metric";
  const operator = verdict.target?.operator ?? verdict.operator ?? "";
  const threshold = verdict.target?.threshold ?? verdict.threshold;
  return (
    <div className={`rounded-lg border p-3 ${verdictCardBorder(verdict.status)}`}>
      <div className="flex items-center gap-2">
        {verdictStatusIcon(verdict.status)}
        <span className="font-medium text-sm">{metric}</span>
        {verdict.workflowName && (
          <span className="rounded-full bg-white/60 px-2 py-0.5 text-xs">{verdict.workflowName}</span>
        )}
        <span className="ml-auto text-xs font-semibold uppercase">{verdict.status}</span>
      </div>
      <div className="mt-1 ml-6 text-xs text-muted-foreground">
        target {operator} {threshold ?? "—"} · actual{" "}
        <strong className="text-foreground">{verdict.actualValue ?? "no data"}</strong>
        {verdict.phase && <span> · phase: {verdict.phase}</span>}
        {verdict.source && <span> · source: {verdict.source}</span>}
      </div>
    </div>
  );
}

export function PipelineRunDetail() {
  const { runId } = useParams<{ runId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  const { data: run, isLoading } = useQuery({
    queryKey: queryKeys.pipelineRuns.detail(runId!),
    queryFn: () => pipelineRunsApi.get(runId!),
    enabled: !!runId,
    refetchInterval: (query) => {
      const verdict = query.state.data?.verdict;
      return verdict === "pending" || verdict === "running" ? 5_000 : false;
    },
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Sentinel" },
      { label: "Pipeline Runs" },
      { label: run ? `Run ${run.id.slice(0, 8)}` : "…" },
    ]);
  }, [setBreadcrumbs, run]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Workflow} message="Select a company to view this pipeline run." />;
  }

  if (isLoading) return <PageSkeleton />;

  if (!run) {
    return <EmptyState icon={Workflow} message="Pipeline run not found." />;
  }

  const isLive = run.verdict === "pending" || run.verdict === "running";
  const requiredVerdicts = run.slaVerdicts.filter((v) => v.target?.required);
  const optionalVerdicts = run.slaVerdicts.filter((v) => !v.target?.required);
  const gate = run.gateResolutions[run.gateResolutions.length - 1];
  const htmlReport = run.artifacts.find((a) => a.artifactType === "k6_html_summary");
  const sentinelSummary = run.artifacts.find((a) => a.artifactType === "sentinel_summary");

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Workflow className="h-6 w-6 text-muted-foreground" />
        <h1 className="text-2xl font-bold capitalize">{run.trigger.type.replace(/_/g, " ")} Pipeline Run</h1>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${verdictColor(run.verdict)}`}>
          {run.verdict}
          {isLive && <span className="ml-1 animate-pulse">●</span>}
        </span>
        {run.ciSignal && run.ciSignal !== "pending" && (
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${ciSignalColor(run.ciSignal)}`}>
            ci: {run.ciSignal}
          </span>
        )}
      </div>

      {/* Metadata */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-lg border bg-card p-4">
          <div className="text-xs text-muted-foreground mb-1">Trigger</div>
          <div className="font-medium text-sm capitalize">{run.trigger.type.replace(/_/g, " ")} · {run.trigger.source}</div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="text-xs text-muted-foreground mb-1">App</div>
          <div className="font-medium text-sm">{run.requirementsDocument?.appName ?? "—"}</div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="text-xs text-muted-foreground mb-1">Started</div>
          <div className="font-medium text-sm">{formatDate(run.startedAt)}</div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="text-xs text-muted-foreground mb-1">Completed</div>
          <div className="font-medium text-sm">{formatDate(run.completedAt)}</div>
        </div>
      </div>

      {/* Stage timeline */}
      <div>
        <h2 className="mb-2 font-semibold text-sm">Stages</h2>
        <div className="rounded-lg border divide-y">
          {STAGE_ORDER.map((stage) => {
            const record: StageRecord | undefined = run.stages[stage];
            return (
              <div key={stage} className="flex items-center gap-3 px-4 py-2.5">
                <span className="w-24 font-medium text-sm capitalize">{stage}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${stageStatusBadge(record?.status ?? "pending")}`}>
                  {record?.status ?? "pending"}
                </span>
                {record?.skippedReason && (
                  <span className="text-xs text-muted-foreground truncate">{record.skippedReason}</span>
                )}
                {record?.error && (
                  <span className="text-xs text-red-700 truncate">{record.error}</span>
                )}
                {record?.completedAt && (
                  <span className="ml-auto text-xs text-muted-foreground shrink-0">{formatDate(record.completedAt)}</span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* SLA verdicts */}
      {run.slaVerdicts.length > 0 && (
        <div>
          <h2 className="mb-2 font-semibold text-sm">SLA Verdicts</h2>
          {requiredVerdicts.length > 0 && (
            <div className="grid gap-2 sm:grid-cols-2">
              {requiredVerdicts.map((v) => <VerdictCard key={v.id} verdict={v} />)}
            </div>
          )}
          {optionalVerdicts.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                {optionalVerdicts.length} optional target{optionalVerdicts.length === 1 ? "" : "s"}
              </summary>
              <div className="mt-2 grid gap-2 sm:grid-cols-2 opacity-75">
                {optionalVerdicts.map((v) => <VerdictCard key={v.id} verdict={v} />)}
              </div>
            </details>
          )}
        </div>
      )}

      {/* Gate resolution */}
      {gate && (
        <div className="rounded-lg border bg-card p-4">
          <h2 className="mb-1 font-semibold text-sm">Gate Resolution</h2>
          <div className="flex items-center gap-3 text-sm">
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${verdictColor(gate.outcome.includes("pass") ? "pass" : gate.outcome.includes("fail") ? "fail" : gate.outcome)}`}>
              {gate.outcome}
            </span>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${ciSignalColor(gate.ciSignal)}`}>
              ci: {gate.ciSignal}
            </span>
            <span className="text-xs text-muted-foreground">
              resolved by {gate.resolvedBy}{gate.resolvedAt ? ` · ${formatDate(gate.resolvedAt)}` : ""}
            </span>
          </div>
        </div>
      )}

      {/* Execution runs */}
      {run.executionRuns.length > 0 && (
        <div>
          <h2 className="mb-2 font-semibold text-sm">Execution Runs</h2>
          <div className="rounded-lg border divide-y">
            {run.executionRuns.map((er) => (
              <div key={er.id} className="flex items-center gap-4 px-4 py-2.5 text-sm">
                <span className="font-medium">{er.engine ?? "k6"}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${stageStatusBadge(er.status === "completed" ? "complete" : er.status)}`}>
                  {er.status}
                </span>
                {er.exitCode != null && <span className="text-xs text-muted-foreground">exit {er.exitCode}</span>}
                {er.peakVus != null && <span className="text-xs text-muted-foreground">peak VUs {er.peakVus}</span>}
                {er.totalRequests != null && <span className="text-xs text-muted-foreground">{er.totalRequests} requests</span>}
                {er.totalIterations != null && <span className="text-xs text-muted-foreground">{er.totalIterations} iterations</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Artifacts */}
      <div>
        <h2 className="mb-2 font-semibold text-sm">Artifacts</h2>
        {run.artifacts.length === 0 ? (
          <p className="text-xs text-muted-foreground">No artifacts recorded for this run.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {htmlReport && (
              <a
                href={artifactContentUrl(htmlReport.id)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
              >
                <ExternalLink className="h-3.5 w-3.5" /> View k6 report
              </a>
            )}
            {sentinelSummary && (
              <a
                href={artifactContentUrl(sentinelSummary.id)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
              >
                <FileText className="h-3.5 w-3.5" /> Sentinel summary
              </a>
            )}
          </div>
        )}
      </div>

      {/* Live run message */}
      {isLive && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800">
          This pipeline run is actively executing. The page refreshes every 5 seconds.
        </div>
      )}
    </div>
  );
}
