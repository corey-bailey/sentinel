import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { pipelineRunsApi, type PipelineRun, type StageRecord } from "../api/sentinel";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { Workflow } from "lucide-react";
import { timeAgo } from "../lib/timeAgo";

export function verdictColor(verdict: string) {
  switch (verdict) {
    case "pass": return "bg-green-100 text-green-800";
    case "fail": return "bg-red-100 text-red-800";
    case "running": return "bg-blue-100 text-blue-800";
    case "pending": return "bg-yellow-100 text-yellow-800";
    case "inconclusive": return "bg-amber-100 text-amber-800";
    case "characterization": return "bg-purple-100 text-purple-800";
    case "error": return "bg-red-100 text-red-800";
    default: return "bg-gray-100 text-gray-700";
  }
}

export function ciSignalColor(ciSignal: string | null) {
  switch (ciSignal) {
    case "pass": return "bg-green-100 text-green-800";
    case "fail": return "bg-red-100 text-red-800";
    default: return "bg-gray-100 text-gray-700";
  }
}

const STAGE_ORDER = ["intake", "discovery", "plan", "generate", "validate", "execute", "analysis", "report"] as const;

function stageDotColor(record: StageRecord | undefined) {
  switch (record?.status) {
    case "complete": return "bg-green-500";
    case "running": return "bg-blue-500 animate-pulse";
    case "failed": return "bg-red-500";
    case "skipped": return "bg-gray-300";
    default: return "bg-gray-200";
  }
}

export function StageDots({ stages }: { stages: PipelineRun["stages"] }) {
  return (
    <div className="flex items-center gap-1">
      {STAGE_ORDER.map((stage) => (
        <span
          key={stage}
          title={`${stage}: ${stages[stage]?.status ?? "pending"}`}
          className={`h-2 w-2 rounded-full ${stageDotColor(stages[stage])}`}
        />
      ))}
    </div>
  );
}

export function PipelineRuns() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Sentinel" }, { label: "Pipeline Runs" }]);
  }, [setBreadcrumbs]);

  const { data: runs, isLoading } = useQuery({
    queryKey: queryKeys.pipelineRuns.list(selectedCompanyId!),
    queryFn: () => pipelineRunsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: (query) =>
      (query.state.data ?? []).some((r) => r.verdict === "running" || r.verdict === "pending") ? 5_000 : false,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Workflow} message="Select a company to view pipeline runs." />;
  }

  if (isLoading) return <PageSkeleton />;

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-bold">Pipeline Runs</h1>

      {(runs ?? []).length === 0 ? (
        <EmptyState
          icon={Workflow}
          message="No pipeline runs yet. Trigger one from a test plan (Test Plans → Run pipeline)."
        />
      ) : (
        <div className="rounded-lg border divide-y">
          {(runs ?? []).map((run) => (
            <Link
              key={run.id}
              to={`/sentinel/pipeline-runs/${run.id}`}
              className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-muted/50"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm capitalize">{run.trigger.type.replace(/_/g, " ")}</span>
                  <span className="text-xs text-muted-foreground">via {run.trigger.source}</span>
                </div>
                <div className="mt-1.5">
                  <StageDots stages={run.stages} />
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${verdictColor(run.verdict)}`}>
                  {run.verdict}
                </span>
                {run.ciSignal && run.ciSignal !== "pending" && (
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${ciSignalColor(run.ciSignal)}`}>
                    ci: {run.ciSignal}
                  </span>
                )}
                <span className="text-xs text-muted-foreground">{timeAgo(run.createdAt)}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
