import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Command } from "cmdk";
import * as Dialog from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { ListChecks, Moon, RefreshCcw, Search } from "lucide-react";
import { toast } from "sonner";
import { api, post } from "@/lib/api";
import type { Ioc, Rule } from "@/lib/types";
import { useAuth } from "@/store/auth";
import { useUi } from "@/store/ui";
import { NAV } from "@/components/nav";
import { SeverityBadge, TypeBadge } from "@/components/badges";
import { Kbd } from "@/components/ui/primitives";
import { withViewTransition } from "@/lib/motion";

function useDebounced<T>(value: T, ms = 200): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const itemCls =
  "flex h-10 cursor-pointer items-center gap-3 rounded-[10px] px-3 text-sm text-fg-muted aria-selected:bg-primary/15 aria-selected:text-fg [&_svg]:size-4 [&_svg]:text-fg-subtle aria-selected:[&_svg]:text-primary-text";
const groupCls = "[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-fg-subtle";

export function CommandPalette() {
  const { paletteOpen, setPalette, toggleTheme } = useUi();
  const can = useAuth((s) => s.can);
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim());

  const { data, isFetching } = useQuery({
    queryKey: ["search", dq],
    queryFn: () => api<{ iocs: Ioc[]; rules: Rule[] }>("/search", { query: { q: dq } }),
    enabled: paletteOpen && dq.length >= 2,
    staleTime: 10_000,
  });

  const pages = NAV.flatMap((g) => g.items).filter(
    (i) => (!i.role || can(i.role)) && (!q || i.label.toLowerCase().includes(q.toLowerCase())),
  );

  const go = (to: string) => {
    setPalette(false);
    setQ("");
    navigate(to);
  };

  return (
    <Dialog.Root open={paletteOpen} onOpenChange={setPalette}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[rgb(var(--scrim)/var(--scrim-a))] duration-2 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <Dialog.Content className="glass-strong fixed inset-x-3 top-[10vh] z-50 mx-auto max-w-2xl origin-top overflow-hidden rounded-3xl outline-none duration-2 ease-emphasized data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[.97] data-[state=open]:slide-in-from-top-1.5 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[.98] data-[state=closed]:duration-1" aria-describedby={undefined}>
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <Command shouldFilter={false} loop className="flex max-h-[70vh] flex-col">
            <div className="flex items-center gap-2 border-b border-line px-4">
              <Search className="size-4 text-fg-subtle" aria-hidden />
              <Command.Input
                value={q}
                onValueChange={setQ}
                placeholder="Search an IOC (defanged is fine), a rule, or a page…"
                className="h-12 flex-1 bg-transparent text-[15px] text-fg outline-none placeholder:text-fg-subtle"
              />
              <Kbd>Esc</Kbd>
            </div>
            <Command.List className="overflow-y-auto p-2">
              <Command.Empty className="px-3 py-8 text-center text-sm text-fg-muted">
                {isFetching ? "Searching…" : dq.length < 2 ? "Type at least 2 characters" : "No matches"}
              </Command.Empty>
              {data?.iocs?.length ? (
                <Command.Group heading="IOCs" className={groupCls}>
                  {data.iocs.map((i) => (
                    <Command.Item key={`i${i.id}`} value={`ioc-${i.id}`} onSelect={() => go(`/iocs?open=${i.id}`)} className={itemCls}>
                      <TypeBadge type={i.type} />
                      <span className="mono min-w-0 flex-1 truncate">{i.value}</span>
                      <SeverityBadge severity={i.severity} compact />
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : null}
              {data?.rules?.length ? (
                <Command.Group heading="Rules" className={groupCls}>
                  {data.rules.map((r) => (
                    <Command.Item key={`r${r.id}`} value={`rule-${r.id}`} onSelect={() => go(`/rules/${r.id}`)} className={itemCls}>
                      <ListChecks />
                      <span className="flex-1 truncate">{r.name}</span>
                      <SeverityBadge severity={r.severity} compact />
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : null}
              {pages.length > 0 && (
                <Command.Group heading="Pages" className={groupCls}>
                  {pages.map((i) => (
                    <Command.Item key={i.to} value={`page-${i.to}`} onSelect={() => go(i.to)} className={itemCls}>
                      <i.icon />
                      {i.label}
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              <Command.Group heading="Actions" className={groupCls}>
                <Command.Item value="act-theme" onSelect={() => (setPalette(false), withViewTransition(toggleTheme))} className={itemCls}>
                  <Moon /> Toggle light / dark theme
                </Command.Item>
                {can("analyst") && (
                  <>
                    <Command.Item value="act-rule" onSelect={() => go("/rules/new")} className={itemCls}>
                      <ListChecks /> New rule
                    </Command.Item>
                    <Command.Item
                      value="act-sync"
                      onSelect={async () => {
                        setPalette(false);
                        try {
                          await post("/sync/run", { kind: "manual" });
                          toast.success("Sync queued");
                        } catch (e) {
                          toast.error((e as Error).message);
                        }
                      }}
                      className={itemCls}
                    >
                      <RefreshCcw /> Sync now
                    </Command.Item>
                  </>
                )}
              </Command.Group>
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
