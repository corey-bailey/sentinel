import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { pipelineRunsApi, requirementsDocumentsApi, testPlansApi, type TestPlan } from "../api/sentinel";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FlaskConical, Play } from "lucide-react";
import { timeAgo } from "../lib/timeAgo";

const ENGINE_COLORS: Record<string, string> = {
  k6: "bg-purple-100 text-purple-800",
  playwright: "bg-blue-100 text-blue-800",
  pytest: "bg-yellow-100 text-yellow-800",
  mocha: "bg-orange-100 text-orange-800",
};

function RunPipelineDialog({
  plan,
  companyId,
  onClose,
}: {
  plan: TestPlan;
  companyId: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [requirementsDocumentId, setRequirementsDocumentId] = useState<string>("");

  const { data: documents, isLoading } = useQuery({
    queryKey: queryKeys.requirementsDocuments.list(companyId),
    queryFn: () => requirementsDocumentsApi.list(companyId),
  });

  const triggerMutation = useMutation({
    mutationFn: () =>
      pipelineRunsApi.trigger(companyId, {
        testPlanId: plan.id,
        requirementsDocumentId,
        trigger: { type: "manual_rerun", source: "ui" },
      }),
    onSuccess: (result) => {
      onClose();
      navigate(`/sentinel/pipeline-runs/${result.pipelineRunId}`);
    },
  });

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Run pipeline — {plan.name}</DialogTitle>
          <DialogDescription>
            Pick the requirements document that defines the SLA targets and target environment for this run.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading requirements documents…</p>
        ) : (documents ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No requirements documents exist yet. Create one via the API before triggering a pipeline run.
          </p>
        ) : (
          <Select value={requirementsDocumentId} onValueChange={setRequirementsDocumentId}>
            <SelectTrigger>
              <SelectValue placeholder="Select a requirements document" />
            </SelectTrigger>
            <SelectContent>
              {(documents ?? []).map((doc) => (
                <SelectItem key={doc.id} value={doc.id}>
                  {doc.appName ?? doc.id.slice(0, 8)} · {doc.testIntent} · {doc.slaTargetCount} SLA target{doc.slaTargetCount === 1 ? "" : "s"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {triggerMutation.isError && (
          <p className="text-sm text-red-700">
            {triggerMutation.error instanceof Error ? triggerMutation.error.message : "Failed to trigger run"}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => triggerMutation.mutate()}
            disabled={!requirementsDocumentId || triggerMutation.isPending}
          >
            {triggerMutation.isPending ? "Starting…" : "Run pipeline"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function TestPlans() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [runDialogPlan, setRunDialogPlan] = useState<TestPlan | null>(null);

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
                <div className="flex items-center gap-2 shrink-0">
                  {plan.engines.includes("k6") && (
                    <Button size="sm" variant="outline" onClick={() => setRunDialogPlan(plan)}>
                      <Play className="h-3.5 w-3.5 mr-1" /> Run pipeline
                    </Button>
                  )}
                  <span className="text-xs text-muted-foreground">{timeAgo(plan.createdAt)}</span>
                </div>
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

      {runDialogPlan && (
        <RunPipelineDialog
          plan={runDialogPlan}
          companyId={selectedCompanyId}
          onClose={() => setRunDialogPlan(null)}
        />
      )}
    </div>
  );
}
