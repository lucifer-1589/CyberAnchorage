import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Flag, Search } from "lucide-react";
import { api } from "@/lib/api";
import type { Ioc, Page, Severity, Verdict } from "@/lib/types";
import { fmtNum, timeAgo } from "@/lib/utils";
import { PageHeader } from "@/components/AppShell";
import { DemoBadge, SeverityBadge, TypeBadge, VerdictBadge } from "@/components/badges";
import { FilterMenu } from "@/components/FilterMenu";
import { IocDrawer } from "@/components/IocDrawer";
import { IocValue } from "@/components/IocValue";
import { Button, EmptyState, ErrorState, Input, Panel, Skeleton } from "@/components/ui/primitives";

interface FlagRow {
  id: number;
  ts: string;
  verdict: Verdict;
  severity: Severity;
  rule_id: number;
  rule_name: string;
  rule_version: number;
  ioc: Ioc;
}

const LIMIT = 50;

export default function FlagsPage() {
  const [sp, setSp] = useSearchParams();
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  const verdict = sp.getAll("verdict");
  const severity = sp.getAll("severity");
  const setMulti = (k: string, v: string[]) => {
    const n = new URLSearchParams(sp);
    n.delete(k);
    v.forEach((x) => n.append(k, x));
    setSp(n, { replace: true });
    setPage(0);
  };

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["flags", verdict, severity, q, page],
    queryFn: () => api<Page<FlagRow>>("/flags", { query: { verdict, severity, q: q || undefined, limit: LIMIT, offset: page * LIMIT } }),
    placeholderData: keepPreviousData,
  });

  return (
    <div>
      <PageHeader title="Flags" description="Every rule match on an IOC. An IOC can carry several flags; its displayed verdict is the highest-severity one." />
      <Panel className="mb-3 flex flex-wrap items-center gap-2 p-3">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <Input className="pl-9" value={q} onChange={(e) => (setQ(e.target.value), setPage(0))} placeholder="Filter by IOC value or rule name" aria-label="Filter flags" />
        </div>
        <FilterMenu label="Verdict" options={["malicious", "suspicious", "abnormal"].map((key) => ({ key }))} value={verdict} onChange={(v) => setMulti("verdict", v)} />
        <FilterMenu label="Severity" options={["critical", "high", "medium", "low"].map((key) => ({ key }))} value={severity} onChange={(v) => setMulti("severity", v)} />
      </Panel>
      <Panel>
        {error ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : isLoading ? (
          <div className="space-y-2 p-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
        ) : !data?.items.length ? (
          <EmptyState icon={Flag} title="No flags" description="No enabled rule matches these filters yet. Create or enable a rule to start flagging." action={<Link to="/rules"><Button size="sm">Go to rules</Button></Link>} />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-[11.5px] uppercase tracking-wide text-fg-muted">
                    <th className="px-4 py-2.5 font-semibold">Verdict</th>
                    <th className="px-3 py-2.5 font-semibold">Indicator</th>
                    <th className="px-3 py-2.5 font-semibold">Rule</th>
                    <th className="px-3 py-2.5 font-semibold">Flagged</th>
                  </tr>
                </thead>
                <tbody className={isFetching ? "opacity-70" : ""}>
                  {data.items.map((f) => (
                    <tr key={f.id} className="row-hover cursor-pointer border-b border-line last:border-0" onClick={() => setOpen(f.ioc.id)}>
                      <td className="px-4 py-2.5">
                        <span className="flex items-center gap-1.5">
                          <VerdictBadge verdict={f.verdict} />
                          <SeverityBadge severity={f.severity} compact />
                        </span>
                      </td>
                      <td className="max-w-[420px] px-3 py-2.5">
                        <span className="flex min-w-0 items-center gap-2">
                          <TypeBadge type={f.ioc.type} />
                          <IocValue id={f.ioc.id} value={f.ioc.value} />
                          {f.ioc.is_demo && <DemoBadge />}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        <Link to={`/rules/${f.rule_id}`} onClick={(e) => e.stopPropagation()} className="text-fg hover:text-primary-text">
                          {f.rule_name}
                        </Link>
                        <span className="ml-1 text-xs text-fg-subtle">v{f.rule_version}</span>
                      </td>
                      <td className="px-3 py-2.5 text-fg-muted">{timeAgo(f.ts)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t border-line px-4 py-2.5 text-xs text-fg-muted">
              <span>
                {fmtNum(page * LIMIT + 1)}–{fmtNum(page * LIMIT + data.items.length)} of {fmtNum(data.total)}
              </span>
              <div className="flex gap-2">
                <Button size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
                <Button size="sm" disabled={(page + 1) * LIMIT >= data.total} onClick={() => setPage(page + 1)}>Next</Button>
              </div>
            </div>
          </>
        )}
      </Panel>
      <IocDrawer id={open} onClose={() => setOpen(null)} />
    </div>
  );
}
