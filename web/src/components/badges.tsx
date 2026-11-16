import { Activity, AlertTriangle, CircleDot, FlaskConical, ShieldAlert, ShieldCheck, Skull } from "lucide-react";
import type { Severity, Verdict } from "@/lib/types";
import { cn, TYPE_LABELS } from "@/lib/utils";
import { Tip } from "@/components/ui/overlays";

const SEV_LEVEL: Record<Severity, number> = { low: 1, medium: 2, high: 3, critical: 4 };
const SEV_COLOR: Record<Severity, string> = {
  low: "bg-sev-low",
  medium: "bg-sev-medium",
  high: "bg-sev-high",
  critical: "bg-sev-critical",
};
const SEV_BORDER: Record<Severity, string> = {
  low: "border-sev-low/40 bg-sev-low/10",
  medium: "border-sev-medium/45 bg-sev-medium/10",
  high: "border-sev-high/45 bg-sev-high/10",
  critical: "border-sev-critical/50 bg-sev-critical/12",
};

/** Severity = label + 4-step bar glyph (shape encodes level) + hue. Never colour alone. */
export function SeverityBadge({ severity, compact }: { severity: Severity | null | undefined; compact?: boolean }) {
  if (!severity) return <span className="text-xs text-fg-subtle">—</span>;
  const level = SEV_LEVEL[severity];
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11.5px] font-semibold capitalize text-fg", SEV_BORDER[severity])}
      aria-label={`Severity ${severity}`}
    >
      <span className="flex h-3 items-end gap-[2px]" aria-hidden>
        {[1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className={cn("w-[3px] rounded-[1px]", i <= level ? SEV_COLOR[severity] : "bg-[rgb(var(--hover)/0.18)]")}
            style={{ height: `${3 + i * 2.25}px` }}
          />
        ))}
      </span>
      {!compact && severity}
    </span>
  );
}

const VERDICT_META: Record<Verdict, { icon: typeof Activity; cls: string; dot: string }> = {
  abnormal: { icon: Activity, cls: "border-ver-abnormal/45 bg-ver-abnormal/10", dot: "text-ver-abnormal" },
  suspicious: { icon: AlertTriangle, cls: "border-ver-suspicious/45 bg-ver-suspicious/10", dot: "text-ver-suspicious" },
  malicious: { icon: Skull, cls: "border-ver-malicious/50 bg-ver-malicious/12", dot: "text-ver-malicious" },
};

export function VerdictBadge({ verdict, allowlisted }: { verdict: Verdict | null | undefined; allowlisted?: boolean }) {
  if (allowlisted)
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[11.5px] font-semibold text-fg">
        <ShieldCheck className="size-3.5 text-primary-text" aria-hidden /> allowlisted
      </span>
    );
  if (!verdict)
    return (
      <span className="inline-flex items-center gap-1 text-[11.5px] text-fg-subtle">
        <CircleDot className="size-3" aria-hidden /> unflagged
      </span>
    );
  const m = VERDICT_META[verdict];
  const Icon = m.icon;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11.5px] font-semibold capitalize text-fg", m.cls)}>
      <Icon className={cn("size-3.5", m.dot)} aria-hidden />
      {verdict}
    </span>
  );
}

export function TypeBadge({ type }: { type: string }) {
  return (
    <span className="inline-flex items-center rounded-md border border-secondary/40 bg-secondary/10 px-1.5 py-0.5 font-mono text-[11px] font-medium text-secondary-text">
      {TYPE_LABELS[type] ?? type}
    </span>
  );
}

const TLP_CLS: Record<string, string> = {
  CLEAR: "border-line text-fg-muted",
  GREEN: "border-[#3fae6a]/50 text-fg",
  AMBER: "border-highlight/60 text-fg",
  "AMBER+STRICT": "border-highlight/80 text-fg",
  RED: "border-danger/60 text-fg",
};
const TLP_DOT: Record<string, string> = {
  CLEAR: "bg-fg-subtle",
  GREEN: "bg-[#3fae6a]",
  AMBER: "bg-highlight",
  "AMBER+STRICT": "bg-highlight",
  RED: "bg-danger",
};

export function TlpBadge({ tlp }: { tlp: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[10.5px] font-semibold", TLP_CLS[tlp])}>
      <span className={cn("size-1.5 rounded-full", TLP_DOT[tlp])} aria-hidden />
      TLP:{tlp}
    </span>
  );
}

export function DemoBadge({ label = "DEMO" }: { label?: string }) {
  return (
    <Tip content="Synthetic demo data from `make seed-demo` — not real threat intelligence">
      <span className="inline-flex items-center gap-1 rounded-md border border-highlight/60 bg-highlight-soft/90 px-1.5 py-0.5 text-[10.5px] font-bold uppercase tracking-wide text-[#5b4300]">
        <FlaskConical className="size-3" aria-hidden />
        {label}
      </span>
    </Tip>
  );
}

export function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    success: "border-primary/45 bg-primary/10",
    running: "border-secondary/50 bg-secondary/12",
    queued: "border-line bg-[rgb(var(--hover)/0.06)]",
    partial: "border-highlight/55 bg-highlight/10",
    failed: "border-danger/55 bg-danger/10",
    skipped: "border-line bg-[rgb(var(--hover)/0.04)]",
    active: "border-primary/45 bg-primary/10",
    expired: "border-line bg-[rgb(var(--hover)/0.06)]",
    retired: "border-line bg-[rgb(var(--hover)/0.04)]",
  };
  const icon =
    status === "running" ? (
      <span className="size-1.5 animate-pulse-dot rounded-full bg-secondary-text" />
    ) : status === "failed" ? (
      <ShieldAlert className="size-3 text-danger-text" />
    ) : (
      <span className={cn("size-1.5 rounded-full", status === "success" || status === "active" ? "bg-primary" : status === "partial" ? "bg-highlight" : "bg-fg-subtle")} />
    );
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11.5px] font-medium capitalize text-fg", map[status] ?? map.queued)}>
      {icon}
      {status}
    </span>
  );
}
