import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { requirementsApi } from "../api/sentinel";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { Button } from "@/components/ui/button";
import { ClipboardList, Plus, X } from "lucide-react";
import { timeAgo } from "../lib/timeAgo";

function coverageColor(status: string) {
  switch (status) {
    case "covered": return "bg-green-100 text-green-800";
    case "partial": return "bg-yellow-100 text-yellow-800";
    case "gap": return "bg-red-100 text-red-800";
    default: return "bg-gray-100 text-gray-700";
  }
}

export function Requirements() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [jiraIssueId, setJiraIssueId] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Sentinel" }, { label: "Requirements" }]);
  }, [setBreadcrumbs]);

  const { data: requirements, isLoading } = useQuery({
    queryKey: queryKeys.requirements.list(selectedCompanyId!),
    queryFn: () => requirementsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const createMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      requirementsApi.create(selectedCompanyId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.requirements.list(selectedCompanyId!) });
      setShowForm(false);
      setName("");
      setDescription("");
      setJiraIssueId("");
      setFormError(null);
    },
    onError: (err) => {
      setFormError(err instanceof Error ? err.message : "Failed to create requirement");
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={ClipboardList} message="Select a company to view requirements." />;
  }

  if (isLoading) return <PageSkeleton />;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setFormError("Name is required");
      return;
    }
    createMutation.mutate({
      name: name.trim(),
      description: description.trim() || undefined,
      jiraIssueId: jiraIssueId.trim() || undefined,
      slaTargets: [],
    });
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Requirements</h1>
        <Button size="sm" onClick={() => setShowForm(true)}>
          <Plus className="h-4 w-4 mr-1.5" />
          New Requirement
        </Button>
      </div>

      {showForm && (
        <div className="rounded-lg border bg-card p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold">New Requirement</h2>
            <button onClick={() => { setShowForm(false); setFormError(null); }}>
              <X className="h-4 w-4 text-muted-foreground" />
            </button>
          </div>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="text-sm font-medium">Name *</label>
              <input
                className="mt-1 block w-full rounded-md border px-3 py-2 text-sm bg-background"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Checkout flow SLA requirements"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Description</label>
              <textarea
                className="mt-1 block w-full rounded-md border px-3 py-2 text-sm bg-background"
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe the performance and functional requirements"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Jira Issue ID</label>
              <input
                className="mt-1 block w-full rounded-md border px-3 py-2 text-sm bg-background"
                value={jiraIssueId}
                onChange={(e) => setJiraIssueId(e.target.value)}
                placeholder="e.g. PROJ-123"
              />
            </div>
            {formError && <p className="text-sm text-red-600">{formError}</p>}
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={createMutation.isPending}>
                {createMutation.isPending ? "Creating…" : "Create"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => { setShowForm(false); setFormError(null); }}
              >
                Cancel
              </Button>
            </div>
          </form>
        </div>
      )}

      {(requirements ?? []).length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          message="No requirements yet."
          action="New Requirement"
          onAction={() => setShowForm(true)}
        />
      ) : (
        <div className="rounded-lg border divide-y">
          {(requirements ?? []).map((req) => (
            <div key={req.id} className="flex items-center justify-between px-4 py-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm truncate">{req.name}</span>
                  {req.jiraIssueId && (
                    <span className="text-xs text-muted-foreground">{req.jiraIssueId}</span>
                  )}
                </div>
                {req.description && (
                  <p className="text-xs text-muted-foreground mt-0.5 truncate">{req.description}</p>
                )}
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-xs text-muted-foreground">
                    {req.slaTargets.length} SLA target{req.slaTargets.length !== 1 ? "s" : ""}
                  </span>
                  <span className="text-xs text-muted-foreground">·</span>
                  <span className="text-xs text-muted-foreground">{timeAgo(req.createdAt)}</span>
                </div>
              </div>
              <span
                className={`ml-4 shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${coverageColor(req.coverageStatus)}`}
              >
                {req.coverageStatus}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
