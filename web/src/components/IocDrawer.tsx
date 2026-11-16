import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, Radar, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { api, post } from "@/lib/api";
import { useRealtimeVisible } from "@/lib/realtime";
import type { IocDetail } from "@/lib/types";
import { fmtDate, pct, timeAgo } from "@/lib/utils";
import { useAuth } from "@/store/auth";
import { DemoBadge, SeverityBadge, StatusPill, TlpBadge, TypeBadge, VerdictBadge } from "@/components/badges";
import { IocValue } from "@/components/IocValue";
import { Button, Chip, EmptyState, ErrorState, Input, Label, Skeleton } from "@/components/ui/primitives";
import { Sheet, SheetContent, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/overlays";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[130px_1fr] items-start gap-3 py-2 text-sm">
      <dt className="text-fg-muted">{label}</dt>
      <dd className="min-w-0 text-fg">{children}</dd>
    </div>
  );
}

function Chips({ items, mono }: { items: string[]; mono?: boolean }) {
  if (!items.length) return <span className="text-fg-subtle">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((t) => (
        <Chip key={t} className={mono ? "font-mono" : ""}>
          {t}
        </Chip>
      ))}
    </div>
  );
}

function AllowlistAction({ detail }: { detail: IocDetail }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(false);
  const m = useMutation({
    mutationFn: () =>
      post("/allowlist", {
        kind: "value",
        ioc_type: detail.ioc.type,
        value: detail.ioc.value.replace(/\[\.\]/g, ".").replace(/^hxxp/i, "http").replace(/^fxp/i, "ftp"),
        reason,
      }),
    onSuccess: () => {
      toast.success("Added to allowlist — flags removed");
      qc.invalidateQueries();
      setOpen(false);
    },
    onError: (e) => toast.error((e as Error).message),
  });
  if (detail.ioc.allowlisted) return null;
  if (!open)
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        <ShieldCheck /> Allowlist
      </Button>
    );
  return (
    <div className="flex w-full flex-col gap-2 rounded-xl border border-line p-3 sm:flex-row sm:items-end">
      <div className="flex-1">
        <Label htmlFor="al-reason">Reason (audited)</Label>
        <Input id="al-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. benign archive host, sinkhole" />
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" loading={m.isPending} onClick={() => m.mutate()}>
          Confirm
        </Button>
      </div>
    </div>
  );
}

/** IOC dossier (G2). `origin` = rect of the row that opened it, so the drawer grows out of that row. */
export function IocDrawer({ id, onClose, origin }: { id: number | null; onClose: () => void; origin?: DOMRect | null }) {
  const canEdit = useAuth((s) => s.can("analyst"));
  const realtime = useRealtimeVisible();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["ioc", id],
    queryFn: () => api<IocDetail>(`/iocs/${id}`),
    enabled: id !== null,
  });
  const ioc = data?.ioc;

  return (
    <Sheet open={id !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent wide origin={origin} title={ioc ? <IocValue id={ioc.id} value={ioc.value} /> : "IOC"} description={ioc ? `${ioc.type} · seen in ${ioc.source_count} source${ioc.source_count === 1 ? "" : "s"}` : undefined}>
        {isLoading && (
          <div className="space-y-3 p-5">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-40" />
          </div>
        )}
        {error && <ErrorState error={error} onRetry={() => refetch()} />}
        {data && ioc && (
          <>
            <div className="flex flex-wrap items-center gap-2 px-5 pt-4">
              <VerdictBadge verdict={ioc.verdict} allowlisted={ioc.allowlisted} />
              <SeverityBadge severity={ioc.severity} />
              <TypeBadge type={ioc.type} />
              <TlpBadge tlp={ioc.tlp} />
              <StatusPill status={ioc.status} />
              {ioc.is_demo && <DemoBadge />}
            </div>
            {canEdit && (
              <div className="flex flex-wrap gap-2 px-5 pt-3">
                <AllowlistAction detail={data} />
              </div>
            )}
            <Tabs defaultValue="details" className="mt-3">
              <TabsList>
                <TabsTrigger value="details">Details</TabsTrigger>
                <TabsTrigger value="sources">Sources ({data.source_refs.length})</TabsTrigger>
                <TabsTrigger value="flags">Rule hits ({data.flags.length})</TabsTrigger>
              </TabsList>
              <TabsContent value="details" className="px-5 py-3">
                <dl className="divide-y divide-[rgb(var(--line)/var(--line-a))]">
                  <Row label="First seen">{fmtDate(ioc.first_seen)} <span className="text-fg-subtle">({timeAgo(ioc.first_seen)})</span></Row>
                  <Row label="Last seen">{fmtDate(ioc.last_seen)} <span className="text-fg-subtle">({timeAgo(ioc.last_seen)})</span></Row>
                  <Row label="Expires">{fmtDate(ioc.expires_at)}</Row>
                  <Row label="Score / confidence">
                    {pct(ioc.score)} / {pct(ioc.confidence)}
                  </Row>
                  <Row label="Sources"><Chips items={ioc.sources} /></Row>
                  <Row label="Tags"><Chips items={ioc.tags} /></Row>
                  <Row label="Malware"><Chips items={ioc.malware_families} /></Row>
                  <Row label="Actors"><Chips items={ioc.actors} /></Row>
                  <Row label="MITRE ATT&CK"><Chips items={ioc.mitre_ids} mono /></Row>
                  {ioc.port != null && <Row label="Port">{ioc.port}</Row>}
                  {(realtime || !!data.detections) && (
                  <Row label="Detections">
                    {data.detections ? (
                      <Link className="inline-flex items-center gap-1 text-primary-text hover:underline" to="/detections">
                        <Radar className="size-3.5" /> {data.detections} real-time hit{data.detections === 1 ? "" : "s"}
                      </Link>
                    ) : (
                      <span className="text-fg-subtle">none</span>
                    )}
                  </Row>
                  )}
                </dl>
              </TabsContent>
              <TabsContent value="sources" className="px-5 py-4">
                {data.source_refs.length === 0 ? (
                  <EmptyState title="No source references" description="All contributing source rows were removed in a reconcile." />
                ) : (
                  <ol className="relative ml-2 border-l border-line">
                    {data.source_refs.map((r) => (
                      <li key={r.k} className="mb-5 ml-5">
                        <span className="absolute -left-[5px] mt-1.5 size-2.5 rounded-full border-2 border-[rgb(var(--glass-strong))] bg-secondary" aria-hidden />
                        <div className="flex flex-wrap items-center gap-2">
                          <Chip className="text-fg">{r.source}</Chip>
                          <span className="text-xs text-fg-subtle">
                            {fmtDate(r.first_seen)} → {fmtDate(r.last_seen)}
                          </span>
                        </div>
                        {r.title && <p className="mt-1 text-sm text-fg">{r.title}</p>}
                        {r.url && <p className="mono mt-0.5 break-all text-fg-muted">{r.url}</p>}
                        {r.messages?.length > 0 && (
                          <ul className="mt-2 space-y-1">
                            {r.messages.slice(0, 6).map((m, i) => (
                              <li key={i} className="flex items-center gap-2 text-xs text-fg-muted">
                                <MessageSquare className="size-3.5" aria-hidden /> {m.channel} · message #{m.message_id} · {fmtDate(m.date)}
                              </li>
                            ))}
                          </ul>
                        )}
                        <p className="mt-1 text-[11px] text-fg-subtle">ref {r.k}</p>
                      </li>
                    ))}
                  </ol>
                )}
                <p className="mt-2 text-xs text-fg-subtle">Only metadata and a source reference are stored — never raw dark-web page or message content. Source URLs are shown defanged.</p>
              </TabsContent>
              <TabsContent value="flags" className="px-5 py-3">
                {data.flags.length === 0 ? (
                  <EmptyState title={ioc.allowlisted ? "Allowlisted — rules are not applied" : "No rule matches this IOC"} />
                ) : (
                  <ul className="divide-y divide-[rgb(var(--line)/var(--line-a))]">
                    {data.flags.map((f) => (
                      <li key={f.rule_id} className="flex flex-wrap items-center gap-2 py-2.5">
                        <Link to={`/rules/${f.rule_id}`} className="min-w-0 flex-1 truncate text-sm font-medium text-fg hover:text-primary-text">
                          {f.rule_name}
                        </Link>
                        <VerdictBadge verdict={f.verdict} />
                        <SeverityBadge severity={f.severity} />
                        <span className="text-xs text-fg-subtle">
                          v{f.rule_version}
                          {f.rule_version !== f.current_rule_version && ` (now v${f.current_rule_version})`} · {timeAgo(f.ts)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </TabsContent>
            </Tabs>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
