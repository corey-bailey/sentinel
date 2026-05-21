import { useEffect } from "react";
import { useParams } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { testRunsApi } from "../api/sentinel";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { Play, CheckCircle2, XCircle, Clock } from "lucide-react";

function statusColor(status: string) {
  switch (status) {
    case "queued": return "bg-yellow-100 text-yellow-800";
    case "running": return "bg-blue-100 text-blue-800";
    case "completed": return "bg-green-100 text-green-800";
    case "failed": return "bg-red-100 text-red-800";
    default: return "bg-gray-100 text-gray-700";
  }
}

function formatDate(dateStr: string | null | undefined) {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleString();
}

function durationSeconds(start: string | null | undefined, end: string | null | undefined) {
  if (!start || !end) return null;
  return Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000);
}

export function TestRunDetail() {
  const { runId } = useParams<{ runId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  const { data: run, isLoading } = useQuery({
    queryKey: queryKeys.testRuns.detail(runId!),
    queryFn: () => testRunsApi.get(runId!),
    enabled: !!runId,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "queued" || status === "running" ? 5_000 : false;
    },
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Sentinel" },
      { label: "Test Runs" },
      { label: run ? `Run ${run.triggerType}` : "…" },
    ]);
  }, [setBreadcrumbs, run]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Play} message="Select a company to view this run." />;
  }

  if (isLoading) return <PageSkeleton />;

  if (!run) {
    return <EmptyState icon={Play} message="Run not found." />;
  }

  const duration = durationSeconds(run.startedAt, run.completedAt);
  const isLive = run.status === "queued" || run.status === "running";

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center gap-3">
        {run.resultSignal === "pass" ? (
          <CheckCircle2 className="h-6 w-6 text-green-600" />
        ) : run.resultSignal === "fail" || run.status === "failed" ? (
          <XCircle className="h-6 w-6 text-red-600" />
        ) : (
          <Play className="h-6 w-6 text-muted-foreground" />
        )}
        <h1 className="text-2xl font-bold capitalize">{run.triggerType} Run</h1>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColor(run.status)}`}>
          {run.status}
          {isLive && <span className="ml-1 animate-pulse">●</span>}
        </span>
      </div>

      {/* Metadata */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-lg border bg-card p-4">
          <div className="text-xs text-muted-foreground mb-1">Trigger</div>
          <div className="font-medium text-sm capitalize">{run.triggerType}</div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
            <Clock className="h-3 w-3" /> Duration
          </div>
          <div className="font-medium text-sm">{duration != null ? `${duration}s` : "—"}</div>
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

      {/* Signal */}
      {run.resultSignal && (
        <div
          className={`rounded-lg border p-4 ${
            run.resultSignal === "pass"
              ? "border-green-200 bg-green-50"
              : "border-red-200 bg-red-50"
          }`}
        >
          <div className="flex items-center gap-2">
            {run.resultSignal === "pass" ? (
              <CheckCircle2 className="h-5 w-5 text-green-600" />
            ) : (
              <XCircle className="h-5 w-5 text-red-600" />
            )}
            <span className={`font-semibold ${run.resultSignal === "pass" ? "text-green-800" : "text-red-800"}`}>
              Result: {run.resultSignal.toUpperCase()}
            </span>
          </div>
        </div>
      )}

      {/* Trigger context */}
      {run.triggerContext && Object.keys(run.triggerContext).length > 0 && (
        <div>
          <h2 className="mb-2 font-semibold text-sm">Trigger Context</h2>
          <pre className="rounded-lg border bg-muted p-4 text-xs overflow-auto">
            {JSON.stringify(run.triggerContext, null, 2)}
          </pre>
        </div>
      )}

      {/* Live run message */}
      {isLive && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800">
          This run is actively executing. The page refreshes every 5 seconds.
        </div>
      )}
    </div>
  );
}
