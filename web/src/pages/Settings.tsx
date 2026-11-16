import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Moon, Save, Sun } from "lucide-react";
import { toast } from "sonner";
import { api, put } from "@/lib/api";
import { cn, IOC_TYPES, TYPE_LABELS } from "@/lib/utils";
import { useAuth } from "@/store/auth";
import { useUi } from "@/store/ui";
import { PageHeader } from "@/components/AppShell";
import { EffectsToggle } from "@/components/EffectsToggle";
import { Button, ErrorState, Input, Label, Panel, PanelHeader, Select, Skeleton } from "@/components/ui/primitives";
import { Switch } from "@/components/ui/overlays";

interface Runtime {
  allow_private_ips: boolean;
  default_tlp: string;
  expiry_days: Record<string, number>;
  enabled_types: string[];
  regex_timeout_ms: number;
  retro_statement_timeout_ms: number;
}

export default function SettingsPage() {
  const isAdmin = useAuth((s) => s.can("admin"));
  const { theme, setTheme } = useUi();
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ["settings"], queryFn: () => api<Runtime>("/settings") });
  const [form, setForm] = useState<Runtime | null>(null);
  useEffect(() => setForm(data ?? null), [data]);
  const save = useMutation({
    mutationFn: () => put<Runtime>("/settings", form),
    onSuccess: () => {
      toast.success("Settings saved — applied on the next sync");
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Settings"
        description="Appearance is per browser. Ingestion settings are shared and admin-only."
        actions={isAdmin && form && <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending}><Save /> Save</Button>}
      />
      <Panel>
        <PanelHeader title="Appearance" />
        <div className="flex flex-wrap gap-3 p-5">
          {(["dark", "light"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTheme(t)}
              aria-pressed={theme === t}
              className={cn("flex items-center gap-2 rounded-xl border px-4 py-3 text-sm font-medium transition", theme === t ? "border-primary bg-primary/[.12] text-fg" : "border-line text-fg-muted hover:text-fg")}
            >
              {t === "dark" ? <Moon className="size-4" /> : <Sun className="size-4" />} {t === "dark" ? "Royal Midnight (default)" : "Ivory Pearl"}
            </button>
          ))}
        </div>
        <div className="border-t border-line px-5 py-4">
          <h3 className="text-sm font-semibold text-fg">Visual effects</h3>
          <p className="mb-3 mt-0.5 max-w-2xl text-[13px] text-fg-muted">
            Auto picks Full, Reduced or Off from how fast this device draws frames. Reduced uses a lighter blur and static backgrounds; Off removes every blur and
            non-essential animation. The layout never changes.
          </p>
          <EffectsToggle />
        </div>
      </Panel>
      <Panel>
        <PanelHeader title="Ingestion" subtitle={isAdmin ? undefined : "Read-only — ask an admin to change these."} />
        {error ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : isLoading || !form ? (
          <Skeleton className="m-5 h-48" />
        ) : (
          <fieldset disabled={!isAdmin} className="space-y-6 p-5">
            <div className="flex items-start gap-3">
              <Switch id="s-private" checked={form.allow_private_ips} onCheckedChange={(v) => setForm({ ...form, allow_private_ips: v })} />
              <div>
                <label htmlFor="s-private" className="text-sm font-medium text-fg">Accept private / reserved IPs</label>
                <p className="text-xs text-fg-muted">Off by default — RFC1918, loopback, link-local and documentation ranges are rejected during sync.</p>
              </div>
            </div>
            <div className="max-w-xs">
              <Label htmlFor="s-tlp">Default TLP for sources without one</Label>
              <Select id="s-tlp" value={form.default_tlp} onChange={(e) => setForm({ ...form, default_tlp: e.target.value })}>
                {["CLEAR", "GREEN", "AMBER", "AMBER+STRICT", "RED"].map((t) => <option key={t} value={t}>TLP:{t}</option>)}
              </Select>
            </div>
            <div>
              <h3 className="mb-2 text-sm font-semibold text-fg">In-scope types</h3>
              <div className="flex flex-wrap gap-1.5">
                {IOC_TYPES.map((t) => {
                  const on = form.enabled_types.includes(t);
                  return (
                    <button
                      key={t}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setForm({ ...form, enabled_types: on ? form.enabled_types.filter((x) => x !== t) : [...form.enabled_types, t] })}
                      className={cn("rounded-lg border px-2.5 py-1 text-xs font-medium", on ? "border-primary bg-primary/15 text-fg" : "border-line text-fg-muted")}
                    >
                      {TYPE_LABELS[t]}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1.5 text-xs text-fg-muted">PII-like types (ssn_like, card_like, iban_like, credentials) are always dropped and cannot be enabled.</p>
            </div>
            <div>
              <h3 className="mb-2 text-sm font-semibold text-fg">Expiry (days since last seen)</h3>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                {Object.entries(form.expiry_days).map(([k, v]) => (
                  <div key={k}>
                    <Label htmlFor={`exp-${k}`}>{TYPE_LABELS[k.replace("_", ":")] ?? k}</Label>
                    <Input id={`exp-${k}`} type="number" min={1} max={3650} value={v} onChange={(e) => setForm({ ...form, expiry_days: { ...form.expiry_days, [k]: Number(e.target.value) } })} />
                  </div>
                ))}
              </div>
            </div>
          </fieldset>
        )}
      </Panel>
    </div>
  );
}
