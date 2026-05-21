import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { testAssetsApi, testPlansApi } from "../api/sentinel";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { FileCode2, CheckCircle2, AlertTriangle } from "lucide-react";
import { timeAgo } from "../lib/timeAgo";

const ENGINE_COLORS: Record<string, string> = {
  k6: "bg-purple-100 text-purple-800",
  playwright: "bg-blue-100 text-blue-800",
  pytest: "bg-yellow-100 text-yellow-800",
  mocha: "bg-orange-100 text-orange-800",
};

function assetTypeLabel(assetType: string) {
  switch (assetType) {
    case "human_authored": return "human";
    case "approved_generated": return "approved AI";
    case "generated": return "AI draft";
    default: return assetType;
  }
}

export function TestAssets() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Sentinel" }, { label: "Test Assets" }]);
  }, [setBreadcrumbs]);

  const { data: assets, isLoading: assetsLoading } = useQuery({
    queryKey: queryKeys.testAssets.list(selectedCompanyId!),
    queryFn: () => testAssetsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: plans } = useQuery({
    queryKey: queryKeys.testPlans.list(selectedCompanyId!),
    queryFn: () => testPlansApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={FileCode2} message="Select a company to view test assets." />;
  }

  if (assetsLoading) return <PageSkeleton />;

  const planMap = new Map((plans ?? []).map((p) => [p.id, p]));

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-bold">Test Assets</h1>

      {(assets ?? []).length === 0 ? (
        <EmptyState icon={FileCode2} message="No test assets yet. The TestGenerationAgent creates them automatically when coverage gaps are detected." />
      ) : (
        <div className="rounded-lg border divide-y">
          {(assets ?? []).map((asset) => {
            const plan = planMap.get(asset.testPlanId);
            const isCovered = asset.assetType === "human_authored" || asset.assetType === "approved_generated";
            return (
              <div key={asset.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      {isCovered ? (
                        <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
                      ) : (
                        <AlertTriangle className="h-4 w-4 text-yellow-600 shrink-0" />
                      )}
                      <span className="font-medium text-sm truncate">{asset.name}</span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${ENGINE_COLORS[asset.engine] ?? "bg-gray-100 text-gray-700"}`}
                      >
                        {asset.engine}
                      </span>
                      <span className="rounded-full px-2 py-0.5 text-xs bg-gray-100 text-gray-700">
                        {assetTypeLabel(asset.assetType)}
                      </span>
                    </div>
                    {plan && (
                      <p className="text-xs text-muted-foreground mt-0.5">Plan: {plan.name}</p>
                    )}
                    {asset.scriptPath && (
                      <code className="text-xs text-muted-foreground mt-0.5 block truncate">
                        {asset.scriptPath}
                      </code>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-xs text-muted-foreground">v{asset.version}</div>
                    <div className="text-xs text-muted-foreground">{timeAgo(asset.createdAt)}</div>
                  </div>
                </div>
                {asset.scriptContent && (
                  <details className="mt-2">
                    <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                      View script
                    </summary>
                    <pre className="mt-2 rounded border bg-muted p-3 text-xs overflow-auto max-h-64">
                      {asset.scriptContent}
                    </pre>
                  </details>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
