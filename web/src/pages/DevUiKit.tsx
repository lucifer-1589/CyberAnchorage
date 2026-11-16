import { useRef, useState, type ReactNode } from "react";
import { Database, FlaskConical, Moon, Plus, RefreshCcw, Settings2, Sun, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useUi } from "@/store/ui";
import { enterStyle } from "@/lib/motion";
import type { Severity, Verdict } from "@/lib/types";
import { PageHeader } from "@/components/AppShell";
import { DemoBadge, SeverityBadge, StatusPill, TlpBadge, TypeBadge, VerdictBadge } from "@/components/badges";
import { EffectsToggle } from "@/components/EffectsToggle";
import { Button, Chip, EmptyState, ErrorState, Input, Kbd, Label, Panel, PanelHeader, Segmented, Select, Skeleton, Sparkline, Stat } from "@/components/ui/primitives";
import { Dropdown, DropdownContent, DropdownItem, DropdownLabel, DropdownSeparator, DropdownTrigger, Sheet, SheetContent, Switch, Tabs, TabsContent, TabsList, TabsTrigger, Tip } from "@/components/ui/overlays";

/**
 * Dev-only kit page (/dev/ui-kit): every component in every state. Switch theme and Visual effects
 * here to check both themes and all three effect levels. Not registered in production builds.
 */
function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-label uppercase text-fg-subtle">{title}</h2>
        {note && <p className="mt-0.5 text-[13px] text-fg-muted">{note}</p>}
      </div>
      {children}
    </section>
  );
}

const VERDICTS: Verdict[] = ["abnormal", "suspicious", "malicious"];
const SEVERITIES: Severity[] = ["low", "medium", "high", "critical"];

export default function DevUiKitPage() {
  const { theme, toggleTheme } = useUi();
  const [vi, setVi] = useState(0);
  const [density, setDensity] = useState<"compact" | "comfortable">("compact");
  const [range, setRange] = useState("24h");
  const [sheet, setSheet] = useState<DOMRect | null | false>(false);
  const [sw, setSw] = useState(true);
  const openerRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="space-y-8">
      <PageHeader
        title="UI kit"
        description="Royal Glass components in every state. Dev builds only — switch theme and Visual effects to check both themes and all effect levels."
        actions={
          <>
            <EffectsToggle />
            <Button variant="secondary" onClick={toggleTheme}>
              {theme === "dark" ? <Sun /> : <Moon />} {theme === "dark" ? "Ivory Pearl" : "Royal Midnight"}
            </Button>
          </>
        }
      />

      <Section title="Glass tiers" note="G0 solid for data · G1 panel for hero cards · G2 floating for the single overlay. Budget: ≤ 6 blurred surfaces per viewport.">
        <div className="grid gap-4 md:grid-cols-3">
          {(["g0", "g1", "g2"] as const).map((t, i) => (
            <Panel key={t} tier={t} spot={t === "g1"} {...enterStyle(i)}>
              <PanelHeader title={{ g0: "G0 · Solid", g1: "G1 · Panel", g2: "G2 · Floating" }[t]} subtitle={{ g0: "Tables, rule trees, logs", g1: "Sidebar, header, KPI band", g2: "Drawer, palette, menus" }[t]} />
              <p className="px-5 pb-5 pt-2 text-[13px] text-fg-muted">
                {{ g0: "No backdrop-filter; near-opaque so dense text stays crisp while it scrolls.", g1: "14 px blur, saturate 1.2, specular edge, 2 % grain. Hover: the edge follows the cursor.", g2: "22 px blur. One on screen at a time, always above a scrim." }[t]}
              </p>
            </Panel>
          ))}
        </div>
      </Section>

      <Section title="Buttons" note="Primary carries the brand gradient and a rotating conic edge — one per view.">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary">
            <Plus /> New rule
          </Button>
          <Button>
            <RefreshCcw /> Sync now
          </Button>
          <Button loading>Syncing…</Button>
          <Button variant="ghost">Cancel</Button>
          <Button variant="danger">
            <Trash2 /> Delete
          </Button>
          <Button variant="link">View audit trail</Button>
          <Button disabled>Disabled</Button>
          <Button size="sm" variant="primary">
            Apply
          </Button>
          <Button size="icon" aria-label="Settings">
            <Settings2 />
          </Button>
        </div>
      </Section>

      <Section title="Status" note="Never colour alone: icon + word (+ bar glyph for severity). Click re-score to see the verdict morph.">
        <div className="flex flex-wrap items-center gap-2">
          {VERDICTS.map((v) => (
            <VerdictBadge key={v} verdict={v} />
          ))}
          <VerdictBadge verdict={null} allowlisted />
          <VerdictBadge verdict={null} />
          <span className="mx-2 h-5 w-px bg-[rgb(var(--line)/var(--line-a))]" />
          {SEVERITIES.map((s) => (
            <SeverityBadge key={s} severity={s} />
          ))}
          <SeverityBadge severity="critical" pulse />
          <SeverityBadge severity="high" compact />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => setVi((i) => (i + 1) % 3)}>
            Re-score indicator
          </Button>
          <span className="mono text-fg-muted">198.51.100[.]23 →</span>
          <VerdictBadge verdict={VERDICTS[vi]} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {["ipv4", "domain", "url", "ip:port", "onion"].map((t) => (
            <TypeBadge key={t} type={t} />
          ))}
          {["CLEAR", "GREEN", "AMBER", "AMBER+STRICT", "RED"].map((t) => (
            <TlpBadge key={t} tlp={t} />
          ))}
          {["success", "running", "queued", "partial", "failed"].map((s) => (
            <StatusPill key={s} status={s} />
          ))}
          <DemoBadge />
          <Chip>telegram</Chip>
          <Kbd>Ctrl</Kbd>
        </div>
      </Section>

      <Section title="KPI band" note="One G1 surface with six stat cells: animated counters, deltas, sparklines that draw in once.">
        <Panel tier="g1" className="grid grid-cols-2 divide-[rgb(var(--line)/var(--line-a))] md:grid-cols-3 xl:grid-cols-6 xl:divide-x">
          <Stat label="Active IOCs" value={100000} delta={0.042} goodWhen="down" hint="vs 24 h" spark={[8, 9, 9, 11, 10, 12, 13, 12, 14, 15, 15, 17]} icon={Database} tone="primary" />
          <Stat label="New in 24 h" value={1318} hint="first ingested today" />
          <Stat label="Flagged" value={18420} delta={-0.12} goodWhen="down" spark={[30, 28, 34, 26, 22, 25, 20, 21, 18, 17, 19, 16]} />
          <Stat label="Coverage" value={0.964} format="percent" delta={0} hint="steady" />
          <Stat label="Last sync" value="5 min ago" hint="incremental · success" />
          <Stat label="Loading" value={0} loading />
        </Panel>
        <div className="w-40">
          <Sparkline data={[3, 5, 4, 8, 6, 9, 12, 10, 14, 13, 17]} label="Example trend" />
        </div>
      </Section>

      <Section title="Controls">
        <Panel className="grid gap-4 p-5 md:grid-cols-3">
          <div>
            <Label htmlFor="kit-q">Search</Label>
            <Input id="kit-q" placeholder="evil[.]example works" />
          </div>
          <div>
            <Label htmlFor="kit-s">Status</Label>
            <Select id="kit-s" defaultValue="active">
              <option value="active">Active</option>
              <option value="expired">Expired</option>
            </Select>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <Segmented label="Row density" value={density} onChange={setDensity} options={[{ value: "compact", label: "Compact" }, { value: "comfortable", label: "Comfortable" }]} />
            <Segmented label="Time range" size="sm" value={range} onChange={setRange} options={["1h", "24h", "7d", "30d"].map((v) => ({ value: v, label: v }))} />
            <label className="inline-flex items-center gap-2 text-sm text-fg-muted">
              <Switch checked={sw} onCheckedChange={setSw} aria-label="Rule enabled" /> Rule enabled
            </label>
          </div>
        </Panel>
      </Section>

      <Section title="Overlays" note="Drawer opens from the button that triggered it (shared element). Menus are G2; tooltips are solid inverse chips.">
        <div className="flex flex-wrap items-center gap-2">
          <Button ref={openerRef} onClick={(e) => setSheet(e.currentTarget.getBoundingClientRect())}>
            Open drawer from here
          </Button>
          <Dropdown>
            <DropdownTrigger asChild>
              <Button>Menu</Button>
            </DropdownTrigger>
            <DropdownContent>
              <DropdownLabel>Saved views</DropdownLabel>
              <DropdownItem>Critical C2, last 24 h</DropdownItem>
              <DropdownItem>Phishing kits</DropdownItem>
              <DropdownSeparator />
              <DropdownItem>
                <Plus /> Save current filters…
              </DropdownItem>
            </DropdownContent>
          </Dropdown>
          <Tip content="Seen by 3 of 4 CTI sources">
            <Button variant="ghost">Hover for tooltip</Button>
          </Tip>
          <Button onClick={() => toast.success("Rule saved", { description: "Tor exit infrastructure is live." })}>Success toast</Button>
          <Button onClick={() => toast.error("Sync failed", { description: "telegram snapshot locked, retrying next cycle." })}>Error toast</Button>
          <Button onClick={() => toast.warning("2 new flags")}>Warning toast</Button>
        </div>
        <Sheet open={sheet !== false} onOpenChange={(o) => !o && setSheet(false)}>
          <SheetContent title="185.220.101[.]47" description="ipv4 · seen in 3 sources" origin={sheet || null}>
            <div className="space-y-3 p-5">
              <div className="flex flex-wrap gap-2">
                <VerdictBadge verdict="malicious" />
                <SeverityBadge severity="critical" />
                <TlpBadge tlp="AMBER" />
              </div>
              <Tabs defaultValue="a">
                <TabsList className="px-0">
                  <TabsTrigger value="a">Details</TabsTrigger>
                  <TabsTrigger value="b">Sources (3)</TabsTrigger>
                </TabsList>
                <TabsContent value="a" className="py-3 text-sm text-fg-muted">
                  First seen 3 days ago · last seen 5 minutes ago · score 91 %.
                </TabsContent>
                <TabsContent value="b" className="py-3 text-sm text-fg-muted">
                  telegram, crawler, ioc_hunter
                </TabsContent>
              </Tabs>
            </div>
          </SheetContent>
        </Sheet>
      </Section>

      <Section title="Feedback">
        <div className="grid gap-4 md:grid-cols-3">
          <Panel>
            <EmptyState title="No IOCs match these filters" description="Loosen a filter or clear them all." action={<Button size="sm">Clear filters</Button>} />
          </Panel>
          <Panel>
            <EmptyState icon={FlaskConical} title="Custom icon" description="EmptyState also takes a lucide icon." />
          </Panel>
          <Panel>
            <ErrorState error={new Error("Request failed (503)")} onRetry={() => undefined} />
          </Panel>
          <Panel className="space-y-2 p-5 md:col-span-3" aria-busy>
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-8" />
            ))}
          </Panel>
        </div>
      </Section>
    </div>
  );
}
