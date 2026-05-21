import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { baselinesApi, testPlansApi } from "../api/sentinel";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { Button } from "@/components/ui/button";
import { BarChart3, CheckCircle2 } from "lucide-react";
import { timeAgo } from "../lib/timeAgo";

export function Baselines() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Sentinel" }, { label: "Baselines" }]);
  }, [setBreadcrumbs]);

  const { data: baselines, isLoading } = useQuery({
    queryKey: queryKeys.baselines.list(selectedCompanyId!),
    queryFn: () => baselinesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: plans } = useQuery({
    queryKey: queryKeys.testPlans.list(selectedCompanyId!),
    queryFn: () => testPlansApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const approveMutation = useMutation({
    mutationFn: (id: string) => baselinesApi.approve(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.baselines.list(selectedCompanyId!) });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={BarChart3} message="Select a company to view baselines." />;
  }

  if (isLoading) return <PageSkeleton />;

  const planMap = new Map((plans ?? []).map((p) => [p.id, p]));
  const allBaselines = baselines ?? [];
  const activeBaselines = allBaselines.filter((b) => b.isActive);
  const pendingBaselines = allBaselines.filter((b) => !b.isActive);

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-bold">Baselines</h1>

      {allBaselines.length === 0 ? (
        <EmptyState
          icon={BarChart3}
          message="No baselines yet. Run a test plan and the AnalysisAgent will propose a v1 baseline."
        />
      ) : (
        <>
          {activeBaselines.length > 0 && (
            <div>
              <h2 className="mb-3 font-semibold">Active Baselines</h2>
              <div className="rounded-lg border divide-y">
                {activeBaselines.map((b) => {
                  const plan = planMap.get(b.testPlanId);
                  return (
                    <div key={b.id} className="flex items-center justify-between px-4 py-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
                          <span className="font-medium text-sm">{b.metric}</span>
                        </div>
                        {plan && (
                          <p className="text-xs text-muted-foreground mt-0.5 ml-6">{plan.name}</p>
                        )}
                        <div className="flex items-center gap-3 mt-1 ml-6 text-xs text-muted-foreground">
                          <span>baseline: <strong className="text-foreground">{b.baselineValue}</strong></span>
                          <span>tolerance: ±{b.tolerancePct}%</span>
                          {b.approvedAt && <span>approved {timeAgo(b.approvedAt)}</span>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {pendingBaselines.length > 0 && (
            <div>
              <h2 className="mb-3 font-semibold">Pending Approval</h2>
              <div className="rounded-lg border divide-y border-yellow-200 bg-yellow-50">
                {pendingBaselines.map((b) => {
                  const plan = planMap.get(b.testPlanId);
                  return (
                    <div key={b.id} className="flex items-center justify-between px-4 py-3">
                      <div>
                        <div className="font-medium text-sm">{b.metric}</div>
                        {plan && (
                          <p className="text-xs text-muted-foreground mt-0.5">{plan.name}</p>
                        )}
                        <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                          <span>proposed value: <strong className="text-foreground">{b.baselineValue}</strong></span>
                          <span>tolerance: ±{b.tolerancePct}%</span>
                          <span>{timeAgo(b.createdAt)}</span>
                        </div>
                      </div>
                      <Button
                        size="sm"
                        onClick={() => approveMutation.mutate(b.id)}
                        disabled={approveMutation.isPending}
                      >
                        Approve
                      </Button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
