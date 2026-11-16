import { useEffect, useRef } from "react";
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
  low: "border-sev-low/[.35] bg-sev-low/[.08]",
  medium: "border-sev-medium/40 bg-sev-medium/[.08]",
  high: "border-sev-high/40 bg-sev-high/[.08]",
  critical: "border-sev-critical/[.45] bg-sev-critical/10",
};

/** Severity = label + 4-step bar glyph (shape encodes level) + hue. Never colour alone.
 *  `pulse` (critical/live only) adds an opacity ring — stops under reduced motion / Effects Off. */
export function SeverityBadge({ severity, compact, pulse }: { severity: Severity | null | undefined; compact?: boolean; pulse?: boolean }) {
  if (!severity) return <span className="text-xs text-fg-subtle">—</span>;
  const level = SEV_LEVEL[severity];
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11.5px] font-semibold capitalize text-fg", SEV_BORDER[severity])}
      aria-label={`Severity ${severity}`}
    >
      {pulse ? (
        <span className={cn("relative size-2 rounded-full", SEV_COLOR[severity])} aria-hidden>
          <span className={cn("absolute -inset-1 animate-pulse-ring rounded-full opacity-0", SEV_COLOR[severity])} />
        </span>
      ) : (
        <span className="flex h-3 items-end gap-[2px]" aria-hidden>
          {[1, 2, 3, 4].map((i) => (
            <span key={i} className={cn("w-[3px] rounded-[1px]", i <= level ? SEV_COLOR[severity] : "bg-[rgb(var(--hover)/0.18)]")} style={{ height: `${3 + i * 2.25}px` }} />
          ))}
        </span>
      )}
      {!compact && severity}
    </span>
  );
}

const VERDICT_META: Record<Verdict, { icon: typeof Activity; cls: string; dot: string }> = {
  abnormal: { icon: Activity, cls: "bg-ver-abnormal/[.12] text-ver-abnormal-text", dot: "text-ver-abnormal" },
  suspicious: { icon: AlertTriangle, cls: "bg-ver-suspicious/[.12] text-ver-suspicious-text", dot: "text-ver-suspicious" },
  malicious: { icon: Skull, cls: "bg-ver-malicious/[.12] text-ver-malicious-text", dot: "text-ver-malicious" },
};

/** Verdict = icon + word on a 12 % tint (label inks are contrast-checked on the tint).
 *  When the verdict changes, the contents morph (scale .86 → 1 + fade); never on first render. */
export function VerdictBadge({ verdict, allowlisted }: { verdict: Verdict | null | undefined; allowlisted?: boolean }) {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);
  const key = allowlisted ? "allow" : (verdict ?? "none");
  const morph = mounted.current ? "animate-morph" : undefined;
  if (allowlisted)
    return (
      <span className="inline-flex items-center rounded-md bg-primary/[.12] px-1.5 py-0.5 text-[11.5px] font-semibold text-primary-text">
        <span key={key} className={cn("inline-flex items-center gap-1", morph)}>
          <ShieldCheck className="size-3.5" aria-hidden /> allowlisted
        </span>
      </span>
    );
  if (!verdict)
    return (
      <span key={key} className={cn("inline-flex items-center gap-1 text-[11.5px] text-fg-subtle", morph)}>
        <CircleDot className="size-3" aria-hidden /> unflagged
      </span>
    );
  const m = VERDICT_META[verdict];
  const Icon = m.icon;
  return (
    <span className={cn("inline-flex items-center rounded-md px-1.5 py-0.5 text-[11.5px] font-semibold capitalize", m.cls)}>
      <span key={key} className={cn("inline-flex items-center gap-1", morph)}>
        <Icon className={cn("size-3.5", m.dot)} aria-hidden />
        {verdict}
      </span>
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
    success: "border-primary/[.45] bg-primary/10",
    running: "border-violet/50 bg-violet/[.12]",
    queued: "border-line bg-[rgb(var(--hover)/0.06)]",
    partial: "border-highlight/[.55] bg-highlight/10",
    failed: "border-danger/[.55] bg-danger/10",
    skipped: "border-line bg-[rgb(var(--hover)/0.04)]",
    active: "border-primary/[.45] bg-primary/10",
    expired: "border-line bg-[rgb(var(--hover)/0.06)]",
    retired: "border-line bg-[rgb(var(--hover)/0.04)]",
  };
  const icon =
    status === "running" ? (
      <span className="size-1.5 animate-pulse-dot rounded-full bg-violet-text" />
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
