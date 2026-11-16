import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertOctagon, BarChart3, CalendarClock, Database, ListChecks, Radar, Sparkles, Table2 } from "lucide-react";
import { api } from "@/lib/api";
import type { Facet } from "@/lib/types";
import { cn, duration, fmtDate, fmtNum, timeAgo, TYPE_LABELS } from "@/lib/utils";
import { PageHeader } from "@/components/AppShell";
import { Chart, type ChartTheme } from "@/components/Chart";
import { StatusPill } from "@/components/badges";
import { Button, EmptyState, ErrorState, Panel, PanelHeader, Skeleton, Stat } from "@/components/ui/primitives";
import { Tip } from "@/components/ui/overlays";

interface Overview {
  totals: Record<string, number>;
  by_type: Facet[];
  by_source: Facet[];
  by_verdict: Facet[];
  by_severity: Facet[];
  top_malware: Facet[];
  top_actors: Facet[];
  timeline: { date: string; ingested: number; flagged: number }[];
  sync: {
    last_run: any;
    last_success_at: string | null;
    recent: { id: number; status: string; kind: string; started_at: string; new: number; updated: number }[];
    worker: { heartbeat_at?: string; jobs?: Record<string, { name: string; next_run_at: string | null }> } | null;
  };
}

const SEV_ORDER = ["low", "medium", "high", "critical"];
const VER_ORDER = ["abnormal", "suspicious", "malicious"];

/** Panel that can flip between the chart and an accessible table of the same rows. */
function ChartPanel({
  title,
  subtitle,
  rows,
  label = (k) => k,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  rows: { key: string; count: number }[];
  label?: (k: string) => string;
  children: React.ReactNode;
  className?: string;
}) {
  const [table, setTable] = useState(false);
  return (
    <Panel className={cn("flex flex-col", className)}>
      <PanelHeader
        title={title}
        subtitle={subtitle}
        actions={
          <Tip content={table ? "Show chart" : "Show as table"}>
            <Button variant="ghost" size="icon-sm" onClick={() => setTable(!table)} aria-label={table ? "Show chart" : "Show as table"} aria-pressed={table}>
              {table ? <BarChart3 /> : <Table2 />}
            </Button>
          </Tip>
        }
      />
      <div className="flex-1 px-3 pb-3 pt-1">
        {rows.length === 0 ? (
          <EmptyState title="No data yet" description="Run a sync or seed the demo data." className="py-8" />
        ) : table ? (
          <table className="m-2 w-[calc(100%-1rem)] text-sm">
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-b border-line last:border-0">
                  <td className="py-1.5 text-fg-muted">{label(r.key)}</td>
                  <td className="py-1.5 text-right tabular-nums text-fg">{fmtNum(r.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          children
        )}
      </div>
    </Panel>
  );
}

function hbar(rows: Facet[], color: (t: ChartTheme, i: number, key: string) => string, label: (k: string) => string) {
  return (t: ChartTheme) => ({
    grid: { left: 8, right: 44, top: 6, bottom: 6, containLabel: true },
    tooltip: { ...t.tooltip, trigger: "item", formatter: (p: any) => `${label(p.name)}<br/><b>${fmtNum(p.value)}</b> IOCs` },
    xAxis: { type: "value", show: false },
    yAxis: {
      type: "category",
      inverse: true,
      data: rows.map((r) => r.key),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: t.muted, fontSize: 12, formatter: label },
    },
    series: [
      {
        type: "bar",
        barWidth: 12,
        data: rows.map((r, i) => ({ value: r.count, name: r.key, itemStyle: { color: color(t, i, r.key), borderRadius: [0, 4, 4, 0] } })),
        label: { show: true, position: "right", color: t.fg, fontSize: 11.5, formatter: (p: any) => fmtNum(p.value) },
        emphasis: { itemStyle: { opacity: 0.85 } },
        cursor: "pointer",
      },
    ],
  });
}

export default function OverviewPage() {
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["overview"],
    queryFn: () => api<Overview>("/stats/overview"),
    refetchInterval: 60_000,
  });

  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
  const t = data?.totals ?? {};
  const sortBy = (rows: Facet[] = [], order: string[]) => order.map((k) => rows.find((r) => r.key === k) ?? { key: k, count: 0 });
  const verdicts = sortBy(data?.by_verdict, VER_ORDER);
  const sevs = sortBy(data?.by_severity, SEV_ORDER);
  const jobs = data?.sync.worker?.jobs ?? {};
  const last = data?.sync.last_run;

  return (
    <div>
      <PageHeader title="Overview" description="Network IOCs from the Dark Web CTI, how they are flagged, and how fresh the intake is." />

      <section aria-label="Key figures" className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Active IOCs" value={fmtNum(t.active)} hint={`${fmtNum(t.all)} total incl. expired`} icon={Database} tone="primary" loading={isLoading} onClick={() => navigate("/iocs")} />
        <Stat label="New in 24 h" value={fmtNum(t.new_24h)} hint="first ingested today" icon={Sparkles} tone="primary" loading={isLoading} onClick={() => navigate("/iocs?new=24")} />
        <Stat label="Flagged" value={fmtNum(t.flagged)} hint={`${fmtNum(t.allowlisted)} allowlisted`} icon={AlertOctagon} tone="danger" loading={isLoading} onClick={() => navigate("/flags")} />
        <Stat label="Enabled rules" value={fmtNum(t.rules_enabled)} icon={ListChecks} loading={isLoading} onClick={() => navigate("/rules")} />
        <Stat label="Detections 24 h" value={fmtNum(t.detections_24h)} hint="real-time seam" icon={Radar} tone="warning" loading={isLoading} onClick={() => navigate("/detections")} />
        <Stat
          label="Last sync"
          value={<span className="text-lg">{last ? timeAgo(last.finished_at ?? last.started_at) : "never"}</span>}
          hint={last ? `${last.kind} · ${last.status}` : "no runs yet"}
          icon={CalendarClock}
          loading={isLoading}
          onClick={() => navigate("/sync")}
        />
      </section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Panel className="xl:col-span-2">
          <PanelHeader title="Ingestion timeline" subtitle="IOCs first ingested vs. flags raised per day · last 30 days" />
          <div className="px-3 pb-3">
            {isLoading ? (
              <Skeleton className="m-2 h-[260px]" />
            ) : (
              <Chart
                height={270}
                ariaLabel="Line chart of IOCs ingested and flags raised per day over the last 30 days"
                deps={[data?.timeline]}
                build={(c) => ({
                  color: [c.s1, c.s2],
                  grid: { left: 8, right: 16, top: 36, bottom: 8, containLabel: true },
                  legend: { top: 4, right: 8, icon: "roundRect", itemWidth: 12, itemHeight: 4, textStyle: { color: c.muted, fontSize: 12 } },
                  tooltip: { ...c.tooltip, trigger: "axis", axisPointer: { type: "line", lineStyle: { color: c.muted, width: 1 } } },
                  xAxis: {
                    type: "category",
                    boundaryGap: false,
                    data: data!.timeline.map((d) => d.date),
                    axisLine: { lineStyle: { color: c.grid } },
                    axisTick: { show: false },
                    axisLabel: { color: c.muted, fontSize: 11, formatter: (v: string) => v.slice(5) },
                  },
                  yAxis: { type: "value", splitLine: { lineStyle: { color: c.grid } }, axisLabel: { color: c.muted, fontSize: 11 } },
                  series: [
                    { name: "Ingested", type: "line", smooth: 0.25, symbol: "circle", symbolSize: 8, showSymbol: false, lineStyle: { width: 2 }, areaStyle: { opacity: 0.08 }, data: data!.timeline.map((d) => d.ingested) },
                    { name: "Flagged", type: "line", smooth: 0.25, symbol: "circle", symbolSize: 8, showSymbol: false, lineStyle: { width: 2 }, data: data!.timeline.map((d) => d.flagged) },
                  ],
                })}
              />
            )}
          </div>
        </Panel>

        <Panel>
          <PanelHeader
            title="Sync health"
            subtitle="Hourly incremental · daily 07:00 UTC full reconcile"
            actions={
              <Button size="sm" variant="ghost" onClick={() => navigate("/sync")}>
                Details
              </Button>
            }
          />
          <div className="space-y-3 px-5 pb-5 pt-3 text-sm">
            {isLoading ? (
              <Skeleton className="h-40" />
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-fg-muted">Last run</span>
                  {last ? <StatusPill status={last.status} /> : <span className="text-fg-subtle">never</span>}
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-fg-muted">Last success</span>
                  <span className="text-fg">{timeAgo(data?.sync.last_success_at)}</span>
                </div>
                {last && (
                  <div className="flex items-center justify-between">
                    <span className="text-fg-muted">Duration</span>
                    <span className="tabular-nums text-fg">{duration(last.started_at, last.finished_at)}</span>
                  </div>
                )}
                {Object.entries(jobs).map(([id, j]) => (
                  <div key={id} className="flex items-center justify-between">
                    <span className="text-fg-muted">Next {id}</span>
                    <span className="text-fg">{j.next_run_at ? fmtDate(j.next_run_at) : "—"}</span>
                  </div>
                ))}
                {!Object.keys(jobs).length && <p className="rounded-lg border border-highlight/40 bg-highlight/10 px-3 py-2 text-[12.5px] text-highlight-ink">Worker has not reported in yet — scheduled runs are not visible.</p>}
                <div className="pt-1">
                  <div className="mb-1.5 text-xs text-fg-subtle">Recent runs</div>
                  <div className="flex gap-1" aria-label="Recent run outcomes">
                    {(data?.sync.recent ?? []).slice().reverse().map((r) => (
                      <Tip key={r.id} content={`#${r.id} ${r.kind} · ${r.status} · ${r.new} new / ${r.updated} updated`}>
                        <span
                          className={cn(
                            "h-6 flex-1 rounded",
                            r.status === "success" ? "bg-primary/70" : r.status === "failed" ? "bg-danger/80" : r.status === "partial" ? "bg-highlight/80" : "bg-[rgb(var(--hover)/0.2)]",
                          )}
                        />
                      </Tip>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        </Panel>

        <ChartPanel title="IOCs by type" subtitle="Active IOCs" rows={data?.by_type ?? []} label={(k) => TYPE_LABELS[k] ?? k}>
          <Chart
            height={Math.max(160, (data?.by_type.length ?? 0) * 30)}
            ariaLabel="Bar chart of active IOCs by type"
            deps={[data?.by_type]}
            build={hbar(data?.by_type ?? [], (c) => c.s1, (k) => TYPE_LABELS[k] ?? k)}
            onClick={(p) => navigate(`/iocs?type=${encodeURIComponent(p.name)}`)}
          />
        </ChartPanel>

        <ChartPanel title="IOCs by source" subtitle="An IOC counts once per source it was seen in" rows={data?.by_source ?? []}>
          <Chart
            height={Math.max(160, (data?.by_source.length ?? 0) * 30)}
            ariaLabel="Bar chart of active IOCs by CTI source"
            deps={[data?.by_source]}
            build={hbar(data?.by_source ?? [], (c) => c.s1, (k) => k)}
            onClick={(p) => navigate(`/iocs?source=${encodeURIComponent(p.name)}`)}
          />
        </ChartPanel>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-1">
          <ChartPanel title="Flagged by verdict" rows={verdicts} label={(k) => k[0].toUpperCase() + k.slice(1)}>
            <Chart
              height={120}
              ariaLabel="Bar chart of flagged IOCs by verdict"
              deps={[data?.by_verdict]}
              build={hbar(verdicts, (c, i) => c.ord[i + 1], (k) => k[0].toUpperCase() + k.slice(1))}
              onClick={(p) => navigate(`/flags?verdict=${p.name}`)}
            />
          </ChartPanel>
          <ChartPanel title="Flagged by severity" rows={sevs} label={(k) => k[0].toUpperCase() + k.slice(1)}>
            <Chart
              height={150}
              ariaLabel="Bar chart of flagged IOCs by severity"
              deps={[data?.by_severity]}
              build={hbar(sevs, (c, i) => c.ord[i], (k) => k[0].toUpperCase() + k.slice(1))}
              onClick={(p) => navigate(`/flags?severity=${p.name}`)}
            />
          </ChartPanel>
        </div>

        <Panel className="xl:col-span-3">
          <PanelHeader title="Attribution" subtitle="Most frequent malware families and threat actors across active IOCs" />
          <div className="grid grid-cols-1 gap-6 px-5 pb-5 pt-3 md:grid-cols-2">
            {(
              [
                ["Malware families", data?.top_malware ?? [], "malware"],
                ["Threat actors", data?.top_actors ?? [], "actor"],
              ] as const
            ).map(([title, rows, param]) => (
              <div key={title}>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">{title}</h3>
                {rows.length === 0 ? (
                  <p className="text-sm text-fg-muted">No attribution yet.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {rows.map((r) => {
                      const max = rows[0].count || 1;
                      return (
                        <li key={r.key}>
                          <button className="group flex w-full items-center gap-3 text-left" onClick={() => navigate(`/iocs?${param}=${encodeURIComponent(r.key)}`)}>
                            <span className="w-36 truncate text-sm text-fg group-hover:text-primary-text">{r.key}</span>
                            <span className="h-2 flex-1 overflow-hidden rounded-full bg-[rgb(var(--hover)/0.08)]">
                              <span className="block h-full rounded-full bg-secondary" style={{ width: `${(r.count / max) * 100}%` }} />
                            </span>
                            <span className="w-12 text-right text-xs tabular-nums text-fg-muted">{fmtNum(r.count)}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}
