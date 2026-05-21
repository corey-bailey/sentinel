import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { regressionsApi } from "../api/sentinel";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { Button } from "@/components/ui/button";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { timeAgo } from "../lib/timeAgo";

function regressionTypeLabel(regressionType: string) {
  if (regressionType === "baseline_proposal") return "Baseline Proposal";
  if (regressionType === "metric_breach") return "Regression";
  return regressionType;
}

function statusBadge(status: string) {
  switch (status) {
    case "open": return "bg-orange-100 text-orange-800";
    case "approved": return "bg-green-100 text-green-800";
    case "rejected": return "bg-red-100 text-red-800";
    default: return "bg-gray-100 text-gray-700";
  }
}

export function Regressions() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Sentinel" }, { label: "Regressions" }]);
  }, [setBreadcrumbs]);

  const { data: regressions, isLoading } = useQuery({
    queryKey: queryKeys.regressions.list(selectedCompanyId!),
    queryFn: () => regressionsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  const approveMutation = useMutation({
    mutationFn: (id: string) => regressionsApi.approve(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.regressions.list(selectedCompanyId!) });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (id: string) => regressionsApi.reject(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.regressions.list(selectedCompanyId!) });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={AlertTriangle} message="Select a company to view regressions." />;
  }

  if (isLoading) return <PageSkeleton />;

  const all = regressions ?? [];
  const open = all.filter((r) => r.status === "open");
  const resolved = all.filter((r) => r.status !== "open");

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-bold">Regressions</h1>

      {all.length === 0 ? (
        <EmptyState
          icon={AlertTriangle}
          message="No regressions detected. Baseline proposals and metric breaches appear here."
        />
      ) : (
        <>
          {open.length > 0 && (
            <div>
              <h2 className="mb-3 font-semibold text-orange-900">
                Requiring Decision ({open.length})
              </h2>
              <div className="space-y-3">
                {open.map((reg) => {
                  const isProposal = reg.regressionType === "baseline_proposal";
                  const isPending =
                    approveMutation.isPending || rejectMutation.isPending;

                  return (
                    <div
                      key={reg.id}
                      className="rounded-lg border border-orange-200 bg-orange-50 p-4"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            {isProposal ? (
                              <BarChart3Icon className="h-4 w-4 text-orange-600 shrink-0" />
                            ) : (
                              <AlertTriangle className="h-4 w-4 text-orange-600 shrink-0" />
                            )}
                            <span className="font-semibold text-sm text-orange-900">
                              {regressionTypeLabel(reg.regressionType)}: {reg.metric}
                            </span>
                          </div>
                          <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                            {reg.baselineValue != null && (
                              <div>
                                <div className="text-muted-foreground">Baseline</div>
                                <div className="font-medium">{reg.baselineValue.toFixed(2)}</div>
                              </div>
                            )}
                            <div>
                              <div className="text-muted-foreground">Actual</div>
                              <div className="font-medium">{reg.actualValue.toFixed(2)}</div>
                            </div>
                            {reg.deviationPct != null && (
                              <div>
                                <div className="text-muted-foreground">Deviation</div>
                                <div className="font-medium text-orange-700">
                                  +{reg.deviationPct.toFixed(1)}%
                                </div>
                              </div>
                            )}
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {timeAgo(reg.createdAt)}
                          </div>
                        </div>
                        <div className="flex gap-2 shrink-0">
                          <Button
                            size="sm"
                            onClick={() => approveMutation.mutate(reg.id)}
                            disabled={isPending}
                          >
                            <CheckCircle2 className="h-4 w-4 mr-1" />
                            {isProposal ? "Promote" : "Accept"}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => rejectMutation.mutate(reg.id)}
                            disabled={isPending}
                          >
                            <XCircle className="h-4 w-4 mr-1" />
                            Reject
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {resolved.length > 0 && (
            <div>
              <h2 className="mb-3 font-semibold">Resolved</h2>
              <div className="rounded-lg border divide-y">
                {resolved.map((reg) => (
                  <div key={reg.id} className="flex items-center justify-between px-4 py-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm">{reg.metric}</span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusBadge(reg.status)}`}
                        >
                          {reg.status}
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {regressionTypeLabel(reg.regressionType)} · actual {reg.actualValue.toFixed(2)}
                        {reg.deviationPct != null && ` · +${reg.deviationPct.toFixed(1)}%`}
                        {reg.resolvedAt && ` · resolved ${timeAgo(reg.resolvedAt)}`}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function BarChart3Icon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  );
}
