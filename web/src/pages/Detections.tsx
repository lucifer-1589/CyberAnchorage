import { useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FlaskConical, Radar, Send } from "lucide-react";
import { toast } from "sonner";
import { useRealtimeStatus } from "@/lib/realtime";
import { api, post } from "@/lib/api";
import type { Detection, Page } from "@/lib/types";
import { fmtDate, fmtNum, timeAgo } from "@/lib/utils";
import { useAuth } from "@/store/auth";
import { PageHeader } from "@/components/AppShell";
import { SeverityBadge, TypeBadge, VerdictBadge } from "@/components/badges";
import { Button, Chip, EmptyState, ErrorState, Label, Panel, PanelHeader, Skeleton, Textarea } from "@/components/ui/primitives";
import { Sheet, SheetContent } from "@/components/ui/overlays";

const SAMPLE = JSON.stringify(
  [{ ts: new Date().toISOString(), sensor: "fw-edge-1", src_ip: "10.20.1.15", dst_ip: "203.0.113.10", dst_port: 443, query: "login-secure.example.top" }],
  null,
  2,
);

function TestEvent() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(SAMPLE);
  const send = useMutation({
    mutationFn: () => post<{ processed: number; detections: Detection[] }>("/events/ingest", { source: "ui-test", events: JSON.parse(text) }),
    onSuccess: (r) => {
      toast[r.detections.length ? "warning" : "success"](`${r.processed} event(s) processed · ${r.detections.length} detection(s)`);
      qc.invalidateQueries({ queryKey: ["detections"] });
    },
    onError: (e) => toast.error(e instanceof SyntaxError ? "Invalid JSON" : (e as Error).message),
  });
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button onClick={() => setOpen(true)}>
        <Send /> Send test event
      </Button>
      <SheetContent title="Send a test event" description="POST /api/events/ingest — runs the same rules + IOC index used for real-time data.">
        <div className="space-y-3 p-5">
          <Label htmlFor="ev-json">Events (JSON array)</Label>
          <Textarea id="ev-json" className="mono min-h-[260px]" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
          <p className="text-xs text-fg-muted">Recognised fields: src_ip, dst_ip, dst_port, domain, host, query, sni, url, ja3, asn. Other fields are ignored and not stored.</p>
          <Button variant="primary" onClick={() => send.mutate()} loading={send.isPending}>
            <Send /> Ingest
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export default function DetectionsPage() {
  const canIngest = useAuth((s) => s.can("analyst"));
  const [page, setPage] = useState(0);
  const status = useRealtimeStatus();
  const list = useQuery({
    queryKey: ["detections", page],
    queryFn: () => api<Page<Detection>>("/detections", { query: { limit: 50, offset: page * 50 } }),
    placeholderData: keepPreviousData,
    refetchInterval: status.data?.simulator ? 10_000 : false,
  });
  const idx = status.data?.index;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Detections"
        description="Matches of real-time events against flagged IOCs and rules. Level 1 ships the seam only — live collection arrives in Level 2."
        actions={canIngest && <TestEvent />}
      />
      <Panel className="grid grid-cols-2 gap-4 p-5 md:grid-cols-5">
        <div>
          <div className="text-xs text-fg-muted">Event source</div>
          <div className="mt-1 flex items-center gap-2 text-sm font-semibold text-fg">
            {status.data?.simulator ? <FlaskConical className="size-4 text-highlight-ink" /> : <Radar className="size-4 text-fg-subtle" />}
            {status.data ? (status.data.simulator ? "Simulator (dev)" : "Not connected") : "…"}
          </div>
        </div>
        <div>
          <div className="text-xs text-fg-muted">Exact IOCs indexed</div>
          <div className="mt-1 text-sm font-semibold tabular-nums text-fg">{fmtNum(idx?.exact)}</div>
        </div>
        <div>
          <div className="text-xs text-fg-muted">CIDR / suffix entries</div>
          <div className="mt-1 text-sm font-semibold tabular-nums text-fg">{fmtNum(idx?.cidr)} / {fmtNum(idx?.suffix)}</div>
        </div>
        <div>
          <div className="text-xs text-fg-muted">Live rules</div>
          <div className="mt-1 text-sm font-semibold tabular-nums text-fg">{fmtNum(idx?.rules)}</div>
        </div>
        <div>
          <div className="text-xs text-fg-muted">Index rebuilt</div>
          <div className="mt-1 text-sm font-semibold text-fg">{timeAgo(idx?.built_at)}</div>
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="Recent detections" subtitle={list.data ? `${fmtNum(list.data.total)} total` : undefined} />
        <div className="pt-2">
          {list.error ? (
            <ErrorState error={list.error} onRetry={() => list.refetch()} />
          ) : list.isLoading ? (
            <Skeleton className="m-4 h-40" />
          ) : !list.data?.items.length ? (
            <EmptyState
              icon={Radar}
              title="Awaiting real-time data"
              description={
                <>
                  No event source is connected yet. Detections will appear here once Level 2 streams network events. Meanwhile you can{" "}
                  {canIngest ? "send a test event" : "ask an analyst to send a test event"}, or start the API with <code className="mono">ENABLE_SIMULATOR=true</code> for a labelled demo feed.
                </>
              }
            />
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[860px] text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-[11.5px] uppercase tracking-wide text-fg-muted">
                      <th className="px-4 py-2.5 font-semibold">Verdict</th>
                      <th className="px-3 py-2.5 font-semibold">Observable</th>
                      <th className="px-3 py-2.5 font-semibold">Matched by</th>
                      <th className="px-3 py-2.5 font-semibold">Source</th>
                      <th className="px-3 py-2.5 font-semibold">When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.data.items.map((d) => (
                      <tr key={d.id} className="border-b border-line last:border-0" title={JSON.stringify(d.event)}>
                        <td className="px-4 py-2.5">
                          <span className="flex items-center gap-1.5">
                            <VerdictBadge verdict={d.verdict} />
                            <SeverityBadge severity={d.severity} compact />
                          </span>
                        </td>
                        <td className="max-w-[380px] px-3 py-2.5">
                          <span className="flex min-w-0 items-center gap-2">
                            <TypeBadge type={d.observable_type} />
                            <span className="mono truncate text-fg">{d.observable}</span>
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-fg-muted">
                          {d.matched_by.replace("_", " ")}
                          {d.rule_ids.length > 0 && ` · ${d.rule_ids.length} rule${d.rule_ids.length > 1 ? "s" : ""}`}
                        </td>
                        <td className="px-3 py-2.5">
                          <span className="flex items-center gap-1.5 text-fg-muted">
                            {d.source}
                            {d.is_simulated && (
                              <Chip className="border-highlight/60 bg-highlight-soft/90 font-bold uppercase text-[#5b4300]">
                                <FlaskConical className="size-3" /> simulated
                              </Chip>
                            )}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-fg-muted" title={fmtDate(d.ts)}>{timeAgo(d.ts)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex justify-end gap-2 border-t border-line px-4 py-2.5">
                <Button size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
                <Button size="sm" disabled={(page + 1) * 50 >= list.data.total} onClick={() => setPage(page + 1)}>Next</Button>
              </div>
            </>
          )}
        </div>
      </Panel>
    </div>
  );
}
