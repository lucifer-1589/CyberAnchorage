import { Fragment, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, CircleCheck, CircleX, Clock, HardDrive, Play, RefreshCcw, Server } from "lucide-react";
import { toast } from "sonner";
import { api, post } from "@/lib/api";
import type { SyncRun } from "@/lib/types";
import { cn, duration, fmtDate, fmtNum, timeAgo } from "@/lib/utils";
import { useAuth } from "@/store/auth";
import { PageHeader } from "@/components/AppShell";
import { DemoBadge, StatusPill } from "@/components/badges";
import { Button, EmptyState, ErrorState, Panel, PanelHeader, Skeleton } from "@/components/ui/primitives";

interface SourceHealth {
  source: string;
  store: string;
  path: string;
  ok: boolean;
  detail: string;
  rows: number | null;
  size_bytes: number | null;
  modified_at: string | null;
  is_demo: boolean;
}
interface SyncStatus {
  sources: SourceHealth[];
  cursors: { source_key: string; max_rowid: number; max_last_seen: string | null; updated_at: string }[];
  worker: { alive: boolean; heartbeat_at: string | null; jobs: Record<string, { name: string; next_run_at: string | null }> };
  current: SyncRun[];
}

const bytes = (n: number | null) => (n == null ? "—" : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

function Count({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="min-w-[72px]">
      <div className={cn("text-base font-semibold tabular-nums text-fg", tone)}>{fmtNum(value)}</div>
      <div className="text-[11px] text-fg-subtle">{label}</div>
    </div>
  );
}

export default function SyncPage() {
  const canRun = useAuth((s) => s.can("analyst"));
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<number | null>(null);
  const status = useQuery({ queryKey: ["sync", "status"], queryFn: () => api<SyncStatus>("/sync/status"), refetchInterval: 15_000 });
  const runs = useQuery({ queryKey: ["sync", "runs"], queryFn: () => api<{ items: SyncRun[]; total: number }>("/sync/runs", { query: { limit: 50 } }), refetchInterval: 15_000 });
  const progress = useQuery<{ run_id: number; source: string; table: string; processed: number; new: number; updated: number }>({
    queryKey: ["sync", "progress"],
    queryFn: () => Promise.resolve(null as any),
    enabled: false,
  });

  const run = useMutation({
    mutationFn: (kind: "manual" | "daily") => post<SyncRun>("/sync/run", { kind }),
    onSuccess: (r) => {
      toast.success(r.status === "queued" ? `Sync #${r.id} queued (${r.mode})` : `Sync #${r.id} already ${r.status}`);
      qc.invalidateQueries({ queryKey: ["sync"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const current = status.data?.current ?? [];
  const busy = current.length > 0;
  const w = status.data?.worker;

  return (
    <div>
      <PageHeader
        title="Sync & Sources"
        description="CTI SQLite stores are snapshotted read-only. Hourly runs are incremental (cursor + hash diff); the daily 07:00 UTC run is a full reconcile with aging and a rule re-run."
        actions={
          canRun && (
            <>
              <Button variant="secondary" onClick={() => run.mutate("daily")} disabled={busy} loading={run.isPending && run.variables === "daily"}>
                <RefreshCcw /> Full reconcile
              </Button>
              <Button variant="primary" onClick={() => run.mutate("manual")} disabled={busy} loading={run.isPending && run.variables === "manual"}>
                <Play /> Sync now
              </Button>
            </>
          )
        }
      />

      {busy && (
        <Panel className="mb-4 border-secondary/40 px-5 py-4" aria-live="polite">
          <div className="flex flex-wrap items-center gap-3">
            <StatusPill status={current[0].status} />
            <span className="text-sm text-fg">
              Run #{current[0].id} · {current[0].mode}
              {progress.data && progress.data.run_id === current[0].id && (
                <span className="text-fg-muted">
                  {" "}
                  — {progress.data.source}/{progress.data.table}: {fmtNum(progress.data.processed)} rows · {fmtNum(progress.data.new)} new · {fmtNum(progress.data.updated)} updated
                </span>
              )}
            </span>
            <span className="text-xs text-fg-subtle">started {timeAgo(current[0].started_at ?? current[0].queued_at)}</span>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[rgb(var(--hover)/0.1)]">
            <div className="h-full w-1/3 animate-[shimmer_1.4s_infinite] rounded-full bg-secondary" style={{ transform: "translateX(-100%)" }} />
          </div>
        </Panel>
      )}

      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel>
          <PanelHeader title="Scheduler" subtitle="Worker process (APScheduler)" />
          <div className="space-y-3 px-5 pb-5 pt-3 text-sm">
            {status.isLoading ? (
              <Skeleton className="h-28" />
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2 text-fg-muted">
                    <Server className="size-4" /> Worker
                  </span>
                  {w?.alive ? (
                    <span className="inline-flex items-center gap-1.5 text-fg">
                      <CircleCheck className="size-4 text-primary-text" /> running
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-fg">
                      <CircleX className="size-4 text-danger-text" /> not reporting
                    </span>
                  )}
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-fg-muted">Heartbeat</span>
                  <span className="text-fg">{timeAgo(w?.heartbeat_at)}</span>
                </div>
                {Object.entries(w?.jobs ?? {}).map(([id, j]) => (
                  <div key={id} className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-fg-muted">
                      <Clock className="size-4" /> {j.name}
                    </span>
                    <span className="text-right text-fg">{fmtDate(j.next_run_at)}</span>
                  </div>
                ))}
                {!w?.alive && <p className="text-[12.5px] text-fg-muted">Start the worker (`docker compose up worker` or `make dev-worker`) for scheduled runs. "Sync now" runs are queued until it picks them up.</p>}
              </>
            )}
          </div>
        </Panel>

        <Panel className="lg:col-span-2">
          <PanelHeader title="CTI stores" subtitle="Read through a private snapshot — never written to or locked" />
          <div className="overflow-x-auto px-2 pb-3 pt-2">
            {status.error ? (
              <ErrorState error={status.error} onRetry={() => status.refetch()} />
            ) : status.isLoading ? (
              <Skeleton className="m-3 h-28" />
            ) : (
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="text-left text-[11.5px] uppercase tracking-wide text-fg-muted">
                    <th className="px-3 py-2 font-semibold">Source</th>
                    <th className="px-3 py-2 font-semibold">File</th>
                    <th className="px-3 py-2 text-right font-semibold">Rows</th>
                    <th className="px-3 py-2 text-right font-semibold">Size</th>
                    <th className="px-3 py-2 font-semibold">Modified</th>
                    <th className="px-3 py-2 font-semibold">State</th>
                  </tr>
                </thead>
                <tbody>
                  {status.data!.sources.map((s) => (
                    <tr key={s.source} className="border-t border-line">
                      <td className="px-3 py-2">
                        <span className="flex items-center gap-2 text-fg">
                          <HardDrive className="size-4 text-fg-subtle" /> {s.source} {s.is_demo && <DemoBadge />}
                        </span>
                      </td>
                      <td className="mono px-3 py-2 text-fg-muted">{s.path}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-fg">{fmtNum(s.rows)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-fg-muted">{bytes(s.size_bytes)}</td>
                      <td className="px-3 py-2 text-fg-muted">{timeAgo(s.modified_at)}</td>
                      <td className="px-3 py-2">
                        <span className={cn("inline-flex items-center gap-1.5 text-[12.5px]", s.ok ? "text-fg" : "text-danger-text")}>
                          {s.ok ? <CircleCheck className="size-4 text-primary-text" /> : <CircleX className="size-4" />}
                          {s.detail}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Panel>
      </div>

      <Panel>
        <PanelHeader title="Run history" subtitle={`${fmtNum(runs.data?.total)} runs recorded`} />
        <div className="px-2 pb-3 pt-2">
          {runs.error ? (
            <ErrorState error={runs.error} onRetry={() => runs.refetch()} />
          ) : runs.isLoading ? (
            <Skeleton className="m-3 h-40" />
          ) : !runs.data?.items.length ? (
            <EmptyState title="No sync has run yet" description={canRun ? "Press “Sync now” to ingest from the CTI." : "An analyst can start the first sync."} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-sm">
                <thead>
                  <tr className="text-left text-[11.5px] uppercase tracking-wide text-fg-muted">
                    <th className="w-8" />
                    <th className="px-3 py-2 font-semibold">Run</th>
                    <th className="px-3 py-2 font-semibold">Status</th>
                    <th className="px-3 py-2 font-semibold">Started</th>
                    <th className="px-3 py-2 font-semibold">Duration</th>
                    <th className="px-3 py-2 font-semibold">Outcome</th>
                    <th className="px-3 py-2 font-semibold">By</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.data.items.map((r) => (
                    <Fragment key={r.id}>
                      <tr className="row-hover cursor-pointer border-t border-line" onClick={() => setExpanded(expanded === r.id ? null : r.id)}>
                        <td className="pl-3">
                          <ChevronRight className={cn("size-4 text-fg-subtle transition-transform", expanded === r.id && "rotate-90")} aria-hidden />
                        </td>
                        <td className="px-3 py-2.5 text-fg">
                          <button className="text-left" aria-expanded={expanded === r.id}>
                            #{r.id} <span className="text-fg-muted">· {r.kind} / {r.mode}</span>
                          </button>
                        </td>
                        <td className="px-3 py-2.5"><StatusPill status={r.status} /></td>
                        <td className="px-3 py-2.5 text-fg-muted">{fmtDate(r.started_at ?? r.queued_at)}</td>
                        <td className="px-3 py-2.5 tabular-nums text-fg-muted">{r.started_at ? duration(r.started_at, r.finished_at) : "—"}</td>
                        <td className="px-3 py-2.5 text-fg-muted">
                          <span className="text-fg">{fmtNum(r.new)}</span> new · <span className="text-fg">{fmtNum(r.updated)}</span> upd · {fmtNum(r.rejected)} rej · {fmtNum(r.flagged)} flagged
                        </td>
                        <td className="max-w-[180px] truncate px-3 py-2.5 text-fg-muted">{r.triggered_by}</td>
                      </tr>
                      {expanded === r.id && (
                        <tr className="border-t border-line bg-[rgb(var(--hover)/0.03)]">
                          <td />
                          <td colSpan={6} className="px-3 py-4">
                            <div className="flex flex-wrap gap-5">
                              <Count label="new" value={r.new} />
                              <Count label="updated" value={r.updated} />
                              <Count label="unchanged" value={r.unchanged} />
                              <Count label="expired / retired" value={r.expired} />
                              <Count label="rejected" value={r.rejected} />
                              <Count label="skipped (out of scope / PII)" value={r.skipped} />
                              <Count label="new flags" value={r.flagged} />
                            </div>
                            {r.stats?.reject_reasons && Object.keys(r.stats.reject_reasons).length > 0 && (
                              <p className="mt-3 text-xs text-fg-muted">
                                Rejections: {Object.entries(r.stats.reject_reasons).map(([k, v]) => `${k} (${v})`).join(", ")}
                              </p>
                            )}
                            {r.stats?.tables && (
                              <div className="mt-3 flex flex-wrap gap-2">
                                {Object.entries(r.stats.tables as Record<string, Record<string, number>>).map(([k, v]) => (
                                  <span key={k} className="rounded-lg border border-line px-2 py-1 text-xs text-fg-muted">
                                    <span className="text-fg">{k}</span> · {fmtNum(v.rows ?? 0)} rows · {fmtNum(v.new ?? 0)} new
                                  </span>
                                ))}
                              </div>
                            )}
                            {r.errors.length > 0 && (
                              <ul className="mt-3 space-y-1 rounded-lg border border-danger/35 bg-danger/[0.07] p-3 text-xs text-fg">
                                {r.errors.map((e, i) => (
                                  <li key={i} className="mono break-all">
                                    {Object.entries(e).map(([k, v]) => `${k}=${v}`).join("  ")}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}
