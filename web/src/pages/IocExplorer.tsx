import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef, type ColumnSizingState, type Header, type Row, type SortingState } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, Bookmark, Search, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { api, del, post } from "@/lib/api";
import type { Facet, Ioc, Page } from "@/lib/types";
import { cn, fmtNum, timeAgo, TYPE_LABELS } from "@/lib/utils";
import { PageHeader } from "@/components/AppShell";
import { DemoBadge, SeverityBadge, TlpBadge, TypeBadge, VerdictBadge } from "@/components/badges";
import { FilterMenu } from "@/components/FilterMenu";
import { IocDrawer } from "@/components/IocDrawer";
import { IocValue } from "@/components/IocValue";
import { Button, Chip, EmptyState, ErrorState, Input, Panel, Segmented, Select, Skeleton } from "@/components/ui/primitives";
import { useUi } from "@/store/ui";
import { Dropdown, DropdownContent, DropdownItem, DropdownLabel, DropdownSeparator, DropdownTrigger } from "@/components/ui/overlays";

const MULTI = ["type", "verdict", "severity", "source", "tag", "tlp"] as const;
const SINGLE = ["q", "status", "min_score", "malware", "actor", "new_within_hours", "demo"] as const;
const PAGE = 100;
/** Row heights per density: compact is the IOC Explorer default (32 px fits the 22 px row actions + focus ring). */
const ROW_H = { compact: 32, comfortable: 42 } as const;
const CARD_H = 92; // phone layout: stacked card rows
const FLEX_COL = "value"; // the indicator column absorbs spare width

function useIsWide(query = "(min-width: 768px)") {
  const get = () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : true);
  const [wide, setWide] = useState(get);
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(query);
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return wide;
}

type Filters = Record<string, string | string[]>;

function readFilters(sp: URLSearchParams): Filters {
  const f: Filters = {};
  for (const k of MULTI) if (sp.getAll(k).length) f[k] = sp.getAll(k);
  for (const k of SINGLE) if (sp.get(k)) f[k] = sp.get(k)!;
  if (sp.get("new")) f.new_within_hours = sp.get("new")!;
  return f;
}

function ScoreBar({ value }: { value: number }) {
  return (
    <span className="flex items-center gap-2" aria-label={`Score ${Math.round(value * 100)} percent`}>
      <span className="h-1.5 w-14 overflow-hidden rounded-full bg-[rgb(var(--hover)/0.1)]">
        <span className="block h-full origin-left rounded-full bg-primary" style={{ transform: `scaleX(${value})` }} />
      </span>
      <span className="w-8 text-xs tabular-nums text-fg-muted">{Math.round(value * 100)}</span>
    </span>
  );
}

function SavedViews({ filters, onApply }: { filters: Filters; onApply: (f: Filters) => void }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["views", "iocs"], queryFn: () => api<{ id: number; name: string; filters: Filters }[]>("/views") });
  const save = useMutation({
    mutationFn: (name: string) => post("/views", { name, page: "iocs", filters }),
    onSuccess: () => {
      toast.success("View saved");
      qc.invalidateQueries({ queryKey: ["views"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Dropdown>
      <DropdownTrigger asChild>
        <Button size="sm" variant="secondary">
          <Bookmark /> Views
        </Button>
      </DropdownTrigger>
      <DropdownContent align="end" className="w-64">
        <DropdownLabel>Saved views</DropdownLabel>
        {!data?.length && <div className="px-3 py-2 text-sm text-fg-muted">No saved views yet</div>}
        {data?.map((v) => (
          <DropdownItem key={v.id} onSelect={() => onApply(v.filters)} className="justify-between">
            <span className="truncate">{v.name}</span>
            <button
              className="rounded p-1 text-fg-subtle hover:text-danger-text"
              aria-label={`Delete view ${v.name}`}
              onClick={async (e) => {
                e.stopPropagation();
                await del(`/views/${v.id}`);
                qc.invalidateQueries({ queryKey: ["views"] });
              }}
            >
              <Trash2 className="size-3.5" />
            </button>
          </DropdownItem>
        ))}
        <DropdownSeparator />
        <DropdownItem
          disabled={!Object.keys(filters).length}
          onSelect={() => {
            const name = window.prompt("Name this view");
            if (name?.trim()) save.mutate(name.trim());
          }}
        >
          <Bookmark /> Save current filters…
        </DropdownItem>
      </DropdownContent>
    </Dropdown>
  );
}

export default function IocExplorerPage() {
  const [sp, setSp] = useSearchParams();
  const filters = useMemo(() => readFilters(sp), [sp]);
  const [sorting, setSorting] = useState<SortingState>([{ id: sp.get("sort") ?? "last_seen", desc: sp.get("order") !== "asc" }]);
  const [q, setQ] = useState(sp.get("q") ?? "");
  const openId = sp.get("open") ? Number(sp.get("open")) : null;

  /** Replace the URL state with exactly `f` (filters live in the URL so views are shareable). */
  const setAll = (f: Filters) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) {
      if (Array.isArray(v)) v.forEach((x) => next.append(k, x));
      else if (v) next.set(k, v);
    }
    setSp(next, { replace: true });
  };
  /** Merge a patch into the current filters (null clears everything). */
  const update = (patch: Filters | null) => setAll(patch === null ? {} : { ...filters, ...patch });

  useEffect(() => {
    const t = setTimeout(() => {
      if ((filters.q ?? "") !== q) update({ q });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const sort = sorting[0] ?? { id: "last_seen", desc: true };
  const query = { ...filters, sort: sort.id, order: sort.desc ? "desc" : "asc" };
  delete (query as any).open;

  const list = useInfiniteQuery({
    queryKey: ["iocs", query],
    queryFn: ({ pageParam }) => api<Page<Ioc>>("/iocs", { query: { ...query, limit: PAGE, offset: pageParam } }),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.offset + last.items.length < last.total ? last.offset + last.items.length : undefined),
    placeholderData: keepPreviousData,
  });
  const facetQuery = { ...filters };
  const facets = useQuery({
    queryKey: ["iocs", "facets", facetQuery],
    queryFn: () => api<Record<string, Facet[]>>("/iocs/facets", { query: facetQuery }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const total = list.data?.pages[0]?.total ?? 0;

  const columns = useMemo<ColumnDef<Ioc>[]>(
    () => [
      { id: "severity", header: "Verdict", size: 200, minSize: 150, cell: ({ row: { original: i } }) => (
        <span className="flex items-center gap-1.5"><VerdictBadge verdict={i.verdict} allowlisted={i.allowlisted} />{i.severity && <SeverityBadge severity={i.severity} compact />}</span>
      ) },
      { id: "type", header: "Type", size: 86, minSize: 72, enableSorting: false, cell: ({ row }) => <TypeBadge type={row.original.type} /> },
      { id: "value", header: "Indicator", size: 300, minSize: 180, cell: ({ row: { original: i } }) => (
        <span className="flex min-w-0 items-center gap-2"><IocValue id={i.id} value={i.value} />{i.is_demo && <DemoBadge />}</span>
      ) },
      { id: "source_count", header: "Sources", size: 180, minSize: 110, cell: ({ row: { original: i } }) => (
        <span className="flex min-w-0 gap-1 overflow-hidden">{i.sources.slice(0, 2).map((s) => <Chip key={s}>{s}</Chip>)}{i.sources.length > 2 && <Chip>+{i.sources.length - 2}</Chip>}</span>
      ) },
      { id: "score", header: "Score", size: 110, minSize: 96, cell: ({ row }) => <ScoreBar value={row.original.score} /> },
      { id: "tlp", header: "TLP", size: 128, minSize: 96, enableSorting: false, cell: ({ row }) => <TlpBadge tlp={row.original.tlp} /> },
      { id: "last_seen", header: "Last seen", size: 112, minSize: 90, cell: ({ row }) => <span className="text-xs text-fg-muted">{timeAgo(row.original.last_seen)}</span> },
    ],
    [],
  );

  const [sizing, setSizing] = useState<ColumnSizingState>({});
  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, columnSizing: sizing },
    manualSorting: true,
    enableSortingRemoval: false,
    enableColumnResizing: true,
    columnResizeMode: "onChange",
    onColumnSizingChange: setSizing,
    onSortingChange: (u) => setSorting((s) => (typeof u === "function" ? u(s) : u)),
    getCoreRowModel: getCoreRowModel(),
  });

  const density = useUi((s) => s.density);
  const setDensity = useUi((s) => s.setDensity);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wide = useIsWide();
  const rowH = wide ? ROW_H[density] : CARD_H;
  const virt = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: () => rowH, overscan: 12 });
  useEffect(() => virt.measure(), [rowH, virt]);
  const items = virt.getVirtualItems();
  useEffect(() => {
    const lastItem = items[items.length - 1];
    if (lastItem && lastItem.index >= rows.length - 20 && list.hasNextPage && !list.isFetchingNextPage) list.fetchNextPage();
  }, [items, rows.length, list]);

  // Column widths live in one CSS variable on the scroller, so rows read it without per-row styles.
  const leaf = table.getVisibleLeafColumns();
  const gridTemplate = leaf.map((c) => (c.id === FLEX_COL ? `minmax(${c.getSize()}px, 1fr)` : `${c.getSize()}px`)).join(" ");
  const minWidth = leaf.reduce((n, c) => n + c.getSize(), 0) + 24;

  // Shared-element drawer: remember the clicked row's rect so the drawer grows out of it.
  const [origin, setOrigin] = useState<DOMRect | null>(null);
  const open = useCallback(
    (id: number, el: HTMLElement | null) => {
      setOrigin(el?.getBoundingClientRect() ?? null);
      update({ open: String(id) });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sp],
  );
  /** ↑/↓ move between rows, Home/End jump, Enter opens the drawer. */
  const onRowKey = useCallback(
    (e: KeyboardEvent<HTMLDivElement>, index: number, id: number) => {
      if (e.key === "Enter") return open(id, e.currentTarget);
      const next = e.key === "ArrowDown" ? index + 1 : e.key === "ArrowUp" ? index - 1 : e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : null;
      if (next === null || next < 0 || next >= rows.length) return;
      e.preventDefault();
      virt.scrollToIndex(next, { align: "auto" });
      requestAnimationFrame(() => scrollRef.current?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.focus());
    },
    [open, rows.length, virt],
  );

  const opt = (k: string) => facets.data?.[k] ?? [];
  const activeCount = Object.keys(filters).filter((k) => k !== "q").length + (filters.q ? 1 : 0);

  return (
    <div className="flex h-[calc(100dvh-8rem)] min-h-[520px] flex-col">
      <PageHeader
        title="IOC Explorer"
        description="Every network IOC ingested from the CTI. Values are defanged; analysts can reveal or copy the live value (audited)."
        actions={
          <>
            <Segmented
              label="Row density"
              size="sm"
              value={density}
              onChange={setDensity}
              options={[
                { value: "compact", label: "Compact" },
                { value: "comfortable", label: "Comfortable" },
              ]}
            />
            <SavedViews filters={filters} onApply={(f) => (setQ(typeof f.q === "string" ? f.q : ""), setAll(f))} />
          </>
        }
      />

      <Panel tier="g1" role="search" className="mb-3 p-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search value — defanged input like evil[.]com works" className="pl-9" aria-label="Search IOCs" />
          </div>
          <FilterMenu label="Type" options={opt("type")} value={(filters.type as string[]) ?? []} onChange={(v) => update({ type: v })} render={(k) => TYPE_LABELS[k] ?? k} />
          <FilterMenu label="Verdict" options={opt("verdict")} value={(filters.verdict as string[]) ?? []} onChange={(v) => update({ verdict: v })} render={(k) => (k === "none" ? "Unflagged" : k)} />
          <FilterMenu label="Severity" options={opt("severity")} value={(filters.severity as string[]) ?? []} onChange={(v) => update({ severity: v })} />
          <FilterMenu label="Source" options={opt("source")} value={(filters.source as string[]) ?? []} onChange={(v) => update({ source: v })} />
          <FilterMenu label="Tag" options={opt("tag")} value={(filters.tag as string[]) ?? []} onChange={(v) => update({ tag: v })} />
          <Select aria-label="Status" className="w-auto" value={(filters.status as string) ?? "active"} onChange={(e) => update({ status: e.target.value === "active" ? "" : e.target.value })}>
            <option value="active">Active</option>
            <option value="expired">Expired</option>
            <option value="retired">Retired</option>
            <option value="all">All statuses</option>
          </Select>
          <Select aria-label="Minimum score" className="w-auto" value={(filters.min_score as string) ?? ""} onChange={(e) => update({ min_score: e.target.value })}>
            <option value="">Any score</option>
            <option value="0.5">Score ≥ 50</option>
            <option value="0.75">Score ≥ 75</option>
            <option value="0.9">Score ≥ 90</option>
          </Select>
          {activeCount > 0 && (
            <Button size="sm" variant="ghost" onClick={() => (setQ(""), update(null))}>
              <X /> Clear
            </Button>
          )}
        </div>
        {(filters.malware || filters.actor || filters.new_within_hours) && (
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            {filters.malware && <Chip className="text-fg">malware: {filters.malware}</Chip>}
            {filters.actor && <Chip className="text-fg">actor: {filters.actor}</Chip>}
            {filters.new_within_hours && <Chip className="text-fg">new in last {filters.new_within_hours} h</Chip>}
          </div>
        )}
      </Panel>

      <Panel className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-4 py-2 text-xs text-fg-muted">
          <span aria-live="polite" className="tabular-nums">
            {list.isLoading ? "Loading…" : `${fmtNum(total)}${list.data?.pages[0]?.total_is_estimate ? "+" : ""} IOCs`}
            {list.isFetching && !list.isLoading && " · updating"}
          </span>
          <span className="hidden sm:inline">↑↓ to move · Enter for details · drag a column edge to resize</span>
        </div>
        {list.error ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : (
          <div
            ref={scrollRef}
            className="min-h-0 flex-1 overflow-auto overscroll-contain"
            role="table"
            aria-label="IOCs"
            aria-rowcount={total}
            style={{ ["--cols" as string]: gridTemplate }}
          >
            <div style={wide ? { minWidth } : undefined}>
              <div role="rowgroup" className={cn(!wide && "sr-only", "sticky top-0 z-10 border-b border-line bg-control")}>
                {table.getHeaderGroups().map((hg) => (
                  <div role="row" key={hg.id} className="grid px-3 [grid-template-columns:var(--cols)]">
                    {hg.headers.map((h) => (
                      <HeaderCell key={h.id} header={h} />
                    ))}
                  </div>
                ))}
              </div>
              {list.isLoading ? (
                <div className="space-y-2 p-3" aria-busy>
                  {Array.from({ length: 10 }).map((_, i) => (
                    <Skeleton key={i} className="h-7" />
                  ))}
                </div>
              ) : rows.length === 0 ? (
                <EmptyState
                  title={activeCount ? "No IOCs match these filters" : "No IOCs ingested yet"}
                  description={activeCount ? "Loosen a filter or clear them all." : "Run `make seed-demo` or trigger a sync from Sync & Sources."}
                  action={activeCount ? <Button size="sm" onClick={() => update(null)}>Clear filters</Button> : undefined}
                />
              ) : (
                <div role="rowgroup" className="[contain:strict]" style={{ height: virt.getTotalSize(), position: "relative" }}>
                  {items.map((vi) => {
                    const row = table.getRowModel().rows[vi.index];
                    return wide ? (
                      <IocRow key={row.id} row={row} index={vi.index} start={vi.start} height={rowH} selected={openId === row.original.id} onOpen={open} onKey={onRowKey} sizing={sizing} />
                    ) : (
                      <IocCard key={row.id} ioc={row.original} index={vi.index} start={vi.start} selected={openId === row.original.id} onOpen={open} onKey={onRowKey} />
                    );
                  })}
                </div>
              )}
              {list.isFetchingNextPage && <div className="p-3 text-center text-xs text-fg-muted">Loading more…</div>}
            </div>
          </div>
        )}
      </Panel>
      <IocDrawer id={openId} origin={origin} onClose={() => update({ open: "" })} />
    </div>
  );
}

/** Sortable header with a resize handle (pointer drag, or ←/→ when focused). */
function HeaderCell({ header: h }: { header: Header<Ioc, unknown> }) {
  const sortable = h.column.getCanSort();
  const dir = h.column.getIsSorted();
  const label = flexRender(h.column.columnDef.header, h.getContext());
  return (
    <div role="columnheader" aria-sort={dir ? (dir === "desc" ? "descending" : "ascending") : undefined} className="relative flex h-9 items-center px-2">
      {sortable ? (
        <button className="inline-flex items-center gap-1 text-label uppercase text-fg-subtle hover:text-fg" onClick={h.column.getToggleSortingHandler()}>
          {label}
          {dir === "desc" ? <ArrowDown className="size-3" /> : dir === "asc" ? <ArrowUp className="size-3" /> : null}
        </button>
      ) : (
        <span className="text-label uppercase text-fg-subtle">{label}</span>
      )}
      {h.column.getCanResize() && (
        <span
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize ${String(h.column.columnDef.header)} column`}
          aria-valuenow={h.column.getSize()}
          tabIndex={0}
          onPointerDown={h.getResizeHandler()}
          onKeyDown={(e) => {
            const d = e.key === "ArrowLeft" ? -16 : e.key === "ArrowRight" ? 16 : 0;
            if (!d) return;
            e.preventDefault();
            h.getContext().table.setColumnSizing((s) => ({ ...s, [h.column.id]: Math.max(h.column.columnDef.minSize ?? 60, h.column.getSize() + d) }));
          }}
          className={cn(
            "absolute inset-y-1.5 right-0 flex w-2.5 cursor-col-resize touch-none justify-center after:h-full after:w-px after:bg-[rgb(var(--line)/var(--line-a))] hover:after:w-0.5 hover:after:bg-primary",
            h.column.getIsResizing() && "after:w-0.5 after:bg-primary",
          )}
        />
      )}
    </div>
  );
}

type RowKey = (e: KeyboardEvent<HTMLDivElement>, index: number, id: number) => void;

/** One virtualised row: memoised on the TanStack row object, contained, placed with transform. */
const IocRow = memo(function IocRow({
  row,
  index,
  start,
  height,
  selected,
  onOpen,
  onKey,
}: {
  row: Row<Ioc>;
  index: number;
  start: number;
  height: number;
  selected: boolean;
  onOpen: (id: number, el: HTMLElement | null) => void;
  onKey: RowKey;
  /** passed so a column resize re-renders visible rows' cell widths */
  sizing: ColumnSizingState;
}) {
  const id = row.original.id;
  return (
    <div
      role="row"
      data-index={index}
      tabIndex={0}
      aria-rowindex={index + 2}
      aria-selected={selected}
      onClick={(e) => onOpen(id, e.currentTarget)}
      onKeyDown={(e) => onKey(e, index, id)}
      className={cn(
        "row-hover absolute left-0 grid w-full cursor-pointer items-center border-b border-line px-3 [contain:strict] [grid-template-columns:var(--cols)] focus-visible:outline-offset-[-2px]",
        selected && "bg-primary/[.1]",
      )}
      style={{ height, transform: `translateY(${start}px)` }}
    >
      {row.getVisibleCells().map((c) => (
        <div role="cell" key={c.id} className="min-w-0 overflow-hidden px-2">
          {flexRender(c.column.columnDef.cell, c.getContext())}
        </div>
      ))}
    </div>
  );
});

/** Phone layout: stacked card rows. */
const IocCard = memo(function IocCard({
  ioc: i,
  index,
  start,
  selected,
  onOpen,
  onKey,
}: {
  ioc: Ioc;
  index: number;
  start: number;
  selected: boolean;
  onOpen: (id: number, el: HTMLElement | null) => void;
  onKey: RowKey;
}) {
  return (
    <div
      role="row"
      data-index={index}
      tabIndex={0}
      onClick={(e) => onOpen(i.id, e.currentTarget)}
      onKeyDown={(e) => onKey(e, index, i.id)}
      className={cn("row-hover absolute left-0 flex w-full cursor-pointer flex-col justify-center gap-1.5 border-b border-line px-4 [contain:strict]", selected && "bg-primary/[.1]")}
      style={{ height: CARD_H, transform: `translateY(${start}px)` }}
    >
      <div role="cell" className="flex items-center gap-1.5">
        <VerdictBadge verdict={i.verdict} allowlisted={i.allowlisted} />
        {i.severity && <SeverityBadge severity={i.severity} compact />}
        <TypeBadge type={i.type} />
        {i.is_demo && <DemoBadge />}
        <span className="ml-auto text-[11.5px] text-fg-subtle">{timeAgo(i.last_seen)}</span>
      </div>
      <div role="cell" className="min-w-0">
        <IocValue id={i.id} value={i.value} />
      </div>
      <div role="cell" className="flex items-center gap-2 text-[11.5px] text-fg-muted">
        <span className="truncate">{i.sources.join(", ")}</span>
        <span className="ml-auto shrink-0 tabular-nums">score {Math.round(i.score * 100)}</span>
      </div>
    </div>
  );
});
