import { useEffect } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { testRunsApi, baselinesApi, regressionsApi } from "../api/sentinel";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Activity, CheckCircle2, AlertTriangle, Clock, BarChart3 } from "lucide-react";
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

export function SentinelDashboard() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Sentinel" }]);
  }, [setBreadcrumbs]);

  const { data: runs, isLoading: runsLoading } = useQuery({
    queryKey: queryKeys.testRuns.list(selectedCompanyId!),
    queryFn: () => testRunsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });

  const { data: baselines } = useQuery({
    queryKey: queryKeys.baselines.list(selectedCompanyId!),
    queryFn: () => baselinesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: regressions } = useQuery({
    queryKey: queryKeys.regressions.list(selectedCompanyId!),
    queryFn: () => regressionsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={BarChart3} message="Select a company to view Sentinel." />;
  }

  if (runsLoading) return <PageSkeleton />;

  const activeRuns = (runs ?? []).filter((r) => r.status === "queued" || r.status === "running");
  const recentRuns = (runs ?? []).slice(0, 8);
  const openRegressions = (regressions ?? []).filter((r) => r.status === "open");
  const activeBaselines = (baselines ?? []).filter((b) => b.isActive);

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Sentinel</h1>
        <Link to="test-runs" className="text-sm text-primary hover:underline">
          View all runs →
        </Link>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Activity className="h-4 w-4" />
            Active Runs
          </div>
          <div className="mt-1 text-3xl font-bold">{activeRuns.length}</div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <AlertTriangle className="h-4 w-4 text-orange-500" />
            Open Regressions
          </div>
          <div className="mt-1 text-3xl font-bold text-orange-600">{openRegressions.length}</div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <CheckCircle2 className="h-4 w-4 text-green-600" />
            Active Baselines
          </div>
          <div className="mt-1 text-3xl font-bold">{activeBaselines.length}</div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Clock className="h-4 w-4" />
            Total Runs
          </div>
          <div className="mt-1 text-3xl font-bold">{(runs ?? []).length}</div>
        </div>
      </div>

      {/* Open regressions requiring action */}
      {openRegressions.length > 0 && (
        <div className="rounded-lg border border-orange-200 bg-orange-50 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold text-orange-900">Regressions Requiring Decision</h2>
            <Link to="regressions" className="text-sm text-orange-700 hover:underline">
              Review all →
            </Link>
          </div>
          <div className="space-y-2">
            {openRegressions.slice(0, 5).map((reg) => (
              <div key={reg.id} className="flex items-center justify-between rounded bg-white px-3 py-2 shadow-sm">
                <div>
                  <span className="font-medium text-sm">{reg.metric}</span>
                  {reg.deviationPct != null && (
                    <span className="ml-2 text-orange-600 text-sm font-medium">
                      +{reg.deviationPct.toFixed(1)}%
                    </span>
                  )}
                </div>
                <Link to={`regressions`} className="text-xs text-primary hover:underline">
                  Decide →
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent runs */}
      <div>
        <h2 className="mb-3 font-semibold">Recent Test Runs</h2>
        {recentRuns.length === 0 ? (
          <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
            No test runs yet.{" "}
            <Link to="test-runs" className="text-primary hover:underline">
              Start a run
            </Link>
          </div>
        ) : (
          <div className="rounded-lg border divide-y">
            {recentRuns.map((run) => (
              <Link
                key={run.id}
                to={`test-runs/${run.id}`}
                className="flex items-center justify-between px-4 py-3 hover:bg-muted/40 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColor(run.status)}`}
                  >
                    {run.status}
                  </span>
                  <span className="text-sm font-medium truncate max-w-[200px]">
                    {run.triggerType} run
                  </span>
                  {run.resultSignal && (
                    <span className={`text-xs font-medium ${signalColor(run.resultSignal)}`}>
                      {run.resultSignal}
                    </span>
                  )}
                </div>
                <span className="text-xs text-muted-foreground">{timeAgo(run.createdAt)}</span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
