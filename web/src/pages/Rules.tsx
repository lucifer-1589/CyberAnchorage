import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ListChecks, Plus } from "lucide-react";
import { toast } from "sonner";
import { api, post } from "@/lib/api";
import type { Rule } from "@/lib/types";
import { cn, fmtNum, timeAgo } from "@/lib/utils";
import { enterStyle } from "@/lib/motion";
import { useAuth } from "@/store/auth";
import { PageHeader } from "@/components/AppShell";
import { DemoBadge, SeverityBadge, VerdictBadge } from "@/components/badges";
import { Button, EmptyState, ErrorState, Panel, Skeleton } from "@/components/ui/primitives";
import { Switch } from "@/components/ui/overlays";

export default function RulesPage() {
  const navigate = useNavigate();
  const canEdit = useAuth((s) => s.can("analyst"));
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ["rules"], queryFn: () => api<Rule[]>("/rules") });
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) => post<Rule>(`/rules/${id}/toggle`, { enabled }),
    onSuccess: (r) => {
      toast.success(`${r.name} ${r.enabled ? "enabled" : "disabled"} · ${fmtNum(r.match_count)} matches`);
      qc.invalidateQueries({ queryKey: ["rules"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <div>
      <PageHeader
        title="Rules"
        description="Rules flag IOCs as abnormal, suspicious or malicious. They re-run after every sync and on save; the same rules will run against real-time events."
        actions={
          canEdit && (
            <Button variant="primary" onClick={() => navigate("/rules/new")}>
              <Plus /> New rule
            </Button>
          )
        }
      />
      <Panel>
        {error ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : !data?.length ? (
          <EmptyState
            icon={ListChecks}
            title="No rules yet"
            description="Create a rule to start flagging IOCs. Try “type is any of IPv4” AND “tags has any of c2”."
            action={canEdit && <Button variant="primary" onClick={() => navigate("/rules/new")}><Plus /> New rule</Button>}
          />
        ) : (
          <ul className="divide-y divide-[rgb(var(--line)/var(--line-a))]">
            {data.map((r, i) => (
              <li key={r.id} className={cn("row-hover flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center", enterStyle(i).className)} style={enterStyle(i).style}>
                <button className="min-w-0 flex-1 text-left" onClick={() => navigate(`/rules/${r.id}`)}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-[14.5px] font-semibold text-fg">{r.name}</span>
                    {r.is_demo && <DemoBadge />}
                    {!r.enabled && <span className="rounded-md border border-line px-1.5 text-[11px] text-fg-muted">disabled</span>}
                    {r.expires_at && new Date(r.expires_at) < new Date() && <span className="rounded-md border border-highlight/50 px-1.5 text-[11px] text-highlight-ink">expired</span>}
                  </div>
                  {r.description && <p className="mt-0.5 truncate text-[13px] text-fg-muted">{r.description}</p>}
                  <p className="mt-1 text-xs text-fg-subtle">
                    v{r.version} · priority {r.priority} · evaluated {timeAgo(r.last_evaluated_at)}
                  </p>
                </button>
                <div className="flex flex-wrap items-center gap-3 sm:justify-end">
                  <VerdictBadge verdict={r.verdict} />
                  <SeverityBadge severity={r.severity} />
                  <span className="w-24 text-right text-sm tabular-nums text-fg">
                    {fmtNum(r.match_count)} <span className="text-xs text-fg-subtle">hits</span>
                  </span>
                  <Switch
                    checked={r.enabled}
                    disabled={!canEdit || toggle.isPending}
                    onCheckedChange={(enabled) => toggle.mutate({ id: r.id, enabled })}
                    aria-label={`${r.enabled ? "Disable" : "Enable"} ${r.name}`}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
