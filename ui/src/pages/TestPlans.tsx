import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { testPlansApi } from "../api/sentinel";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { FlaskConical } from "lucide-react";
import { timeAgo } from "../lib/timeAgo";

const ENGINE_COLORS: Record<string, string> = {
  k6: "bg-purple-100 text-purple-800",
  playwright: "bg-blue-100 text-blue-800",
  pytest: "bg-yellow-100 text-yellow-800",
  mocha: "bg-orange-100 text-orange-800",
};

export function TestPlans() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Sentinel" }, { label: "Test Plans" }]);
  }, [setBreadcrumbs]);

  const { data: plans, isLoading } = useQuery({
    queryKey: queryKeys.testPlans.list(selectedCompanyId!),
    queryFn: () => testPlansApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={FlaskConical} message="Select a company to view test plans." />;
  }

  if (isLoading) return <PageSkeleton />;

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-bold">Test Plans</h1>

      {(plans ?? []).length === 0 ? (
        <EmptyState icon={FlaskConical} message="No test plans yet. Create one via the API or from a Requirement." />
      ) : (
        <div className="rounded-lg border divide-y">
          {(plans ?? []).map((plan) => (
            <div key={plan.id} className="px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{plan.name}</span>
                    {!plan.isActive && (
                      <span className="rounded-full px-2 py-0.5 text-xs bg-gray-100 text-gray-600">
                        inactive
                      </span>
                    )}
                  </div>
                  {plan.description && (
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">{plan.description}</p>
                  )}
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    {plan.engines.map((engine) => (
                      <span
                        key={engine}
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${ENGINE_COLORS[engine] ?? "bg-gray-100 text-gray-700"}`}
                      >
                        {engine}
                      </span>
                    ))}
                    {plan.apmProvider && (
                      <span className="rounded-full px-2 py-0.5 text-xs bg-teal-100 text-teal-800">
                        apm:{plan.apmProvider}
                      </span>
                    )}
                    {plan.schedule && (
                      <span className="text-xs text-muted-foreground">⏰ {plan.schedule}</span>
                    )}
                  </div>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(plan.createdAt)}</span>
              </div>
              {plan.filePatterns.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {plan.filePatterns.map((pattern) => (
                    <code key={pattern} className="rounded bg-muted px-1.5 py-0.5 text-xs">
                      {pattern}
                    </code>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
