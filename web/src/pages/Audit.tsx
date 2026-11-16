import { Fragment, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronRight, FileClock } from "lucide-react";
import { api } from "@/lib/api";
import type { Page } from "@/lib/types";
import { cn, fmtDate, fmtNum } from "@/lib/utils";
import { PageHeader } from "@/components/AppShell";
import { Button, Chip, EmptyState, ErrorState, Input, Panel, Select, Skeleton } from "@/components/ui/primitives";

interface AuditRow {
  id: number;
  ts: string;
  actor_email: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ip: string | null;
}

function Diff({ before, after }: { before: AuditRow["before"]; after: AuditRow["after"] }) {
  const keys = Array.from(new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]));
  if (!keys.length) return <p className="text-xs text-fg-muted">No field changes recorded.</p>;
  const show = (v: unknown) => (v === undefined ? "—" : typeof v === "string" ? v : JSON.stringify(v));
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left text-fg-subtle">
          <th className="py-1 pr-3 font-semibold">Field</th>
          <th className="py-1 pr-3 font-semibold">Before</th>
          <th className="py-1 font-semibold">After</th>
        </tr>
      </thead>
      <tbody>
        {keys.map((k) => {
          const b = before?.[k];
          const a = after?.[k];
          const changed = JSON.stringify(a) !== JSON.stringify(b);
          return (
            <tr key={k} className="align-top">
              <td className="py-1 pr-3 text-fg-muted">{k}</td>
              <td className={cn("mono max-w-[340px] break-all py-1 pr-3", changed && before ? "text-danger-text line-through decoration-1" : "text-fg-muted")}>{show(b)}</td>
              <td className={cn("mono max-w-[340px] break-all py-1", changed ? "text-fg" : "text-fg-muted")}>{show(a)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export default function AuditPage() {
  const [entity, setEntity] = useState("");
  const [actor, setActor] = useState("");
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["audit", entity, actor, page],
    queryFn: () => api<Page<AuditRow>>("/audit", { query: { entity_type: entity || undefined, actor: actor || undefined, limit: 100, offset: page * 100 } }),
    placeholderData: keepPreviousData,
  });

  return (
    <div>
      <PageHeader title="Audit log" description="Every rule, allowlist, user and settings change, logins, and every reveal of a live IOC value." />
      <Panel className="mb-3 flex flex-wrap gap-2 p-3">
        <Select aria-label="Entity" className="w-auto" value={entity} onChange={(e) => (setEntity(e.target.value), setPage(0))}>
          <option value="">All entities</option>
          {["rule", "allowlist", "user", "settings", "ioc"].map((e) => (
            <option key={e} value={e}>{e}</option>
          ))}
        </Select>
        <Input aria-label="Actor" className="max-w-xs" placeholder="Actor email contains…" value={actor} onChange={(e) => (setActor(e.target.value), setPage(0))} />
      </Panel>
      <Panel>
        {error ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : isLoading ? (
          <Skeleton className="m-4 h-60" />
        ) : !data?.items.length ? (
          <EmptyState icon={FileClock} title="No audit entries" />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-[11.5px] uppercase tracking-wide text-fg-muted">
                    <th className="w-8" />
                    <th className="px-3 py-2.5 font-semibold">When</th>
                    <th className="px-3 py-2.5 font-semibold">Actor</th>
                    <th className="px-3 py-2.5 font-semibold">Action</th>
                    <th className="px-3 py-2.5 font-semibold">Entity</th>
                    <th className="px-3 py-2.5 font-semibold">IP</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((a) => (
                    <Fragment key={a.id}>
                      <tr className="row-hover cursor-pointer border-b border-line" onClick={() => setOpen(open === a.id ? null : a.id)} aria-expanded={open === a.id}>
                        <td className="pl-3"><ChevronRight className={cn("size-4 text-fg-subtle transition-transform", open === a.id && "rotate-90")} aria-hidden /></td>
                        <td className="px-3 py-2.5 text-fg-muted">{fmtDate(a.ts)}</td>
                        <td className="px-3 py-2.5 text-fg">{a.actor_email ?? "system"}</td>
                        <td className="px-3 py-2.5"><Chip className={cn("font-mono", a.action.includes("failed") || a.action.includes("reuse") ? "border-danger/50 text-danger-text" : "text-fg")}>{a.action}</Chip></td>
                        <td className="px-3 py-2.5 text-fg-muted">{a.entity_type}{a.entity_id && ` #${a.entity_id}`}</td>
                        <td className="mono px-3 py-2.5 text-fg-muted">{a.ip ?? "—"}</td>
                      </tr>
                      {open === a.id && (
                        <tr className="border-b border-line bg-[rgb(var(--hover)/0.03)]">
                          <td />
                          <td colSpan={5} className="px-3 py-3"><Diff before={a.before} after={a.after} /></td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t border-line px-4 py-2.5 text-xs text-fg-muted">
              <span>{fmtNum(data.total)} entries</span>
              <div className="flex gap-2">
                <Button size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
                <Button size="sm" disabled={(page + 1) * 100 >= data.total} onClick={() => setPage(page + 1)}>Next</Button>
              </div>
            </div>
          </>
        )}
      </Panel>
    </div>
  );
}
