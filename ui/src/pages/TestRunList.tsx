import { useEffect } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { testRunsApi } from "../api/sentinel";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { Play } from "lucide-react";
import { timeAgo } from "../lib/timeAgo";

function statusColor(status: string) {
  switch (status) {
    case "queued": return "bg-yellow-100 text-yellow-800";
    case "running": return "bg-blue-100 text-blue-800";
    case "completed": return "bg-green-100 text-green-800";
    case "failed": return "bg-red-100 text-red-800";
    default: return "bg-gray-100 text-gray-700";
  }
}

function signalColor(signal: string | null | undefined) {
  if (!signal) return "";
  if (signal.includes("fail") || signal === "fail") return "text-red-600";
  return "text-green-600";
}

export function TestRunList() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Sentinel" }, { label: "Test Runs" }]);
  }, [setBreadcrumbs]);

  const { data: runs, isLoading } = useQuery({
    queryKey: queryKeys.testRuns.list(selectedCompanyId!),
    queryFn: () => testRunsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Play} message="Select a company to view test runs." />;
  }

  if (isLoading) return <PageSkeleton />;

  const sortedRuns = [...(runs ?? [])].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-bold">Test Runs</h1>

      {sortedRuns.length === 0 ? (
        <EmptyState icon={Play} message="No test runs yet. Trigger one via the deploy webhook or from a test plan." />
      ) : (
        <div className="rounded-lg border divide-y">
          {sortedRuns.map((run) => (
            <Link
              key={run.id}
              to={`test-runs/${run.id}`}
              className="flex items-center justify-between px-4 py-3 hover:bg-muted/40 transition-colors"
            >
              <div className="flex items-center gap-3">
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColor(run.status)}`}>
                  {run.status}
                </span>
                <span className="text-sm font-medium">
                  {run.triggerType} run
                </span>
                {run.resultSignal && (
                  <span className={`text-xs font-medium ${signalColor(run.resultSignal)}`}>
                    {run.resultSignal}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                {run.startedAt && run.completedAt && (
                  <span>
                    {Math.round(
                      (new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000
                    )}s
                  </span>
                )}
                <span>{timeAgo(run.createdAt)}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
