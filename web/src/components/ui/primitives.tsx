import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { AlertTriangle, Loader2, RefreshCw, TrendingDown, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCounter, useNumberFormat, useSpotlight } from "@/lib/motion";

/* ---------------------------------------------------------------- Button ---
 * primary: brand gradient + rotating conic edge — one per view, for the thing the page is for.
 * Press scales to .97 and releases on the snappy spring (`.press`). */

const buttonVariants = cva(
  "press inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] text-sm font-semibold " +
    "transition-[background-color,color,border-color,transform] duration-1 ease-standard " +
    "disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "cta-edge bg-brand text-on-brand shadow-[0_6px_20px_rgb(var(--grad-2)/0.28)] hover:brightness-110",
        secondary: "border border-control-border bg-control text-fg hover:bg-[rgb(var(--hover)/0.1)]",
        ghost: "text-fg-muted hover:bg-[rgb(var(--hover)/var(--hover-a))] hover:text-fg",
        danger: "border border-danger/70 bg-transparent text-danger-text hover:bg-danger/10",
        link: "px-0 font-medium text-primary-text underline-offset-4 hover:underline",
      },
      size: { sm: "h-8 px-3 text-[13px]", md: "h-[34px] px-3.5", lg: "h-10 px-5", icon: "h-[34px] w-[34px]", "icon-sm": "h-8 w-8" },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, loading, children, disabled, ...props }, ref) => (
  <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
    {loading && <Loader2 className="animate-spin" aria-hidden />}
    {children}
  </button>
));
Button.displayName = "Button";

/* ----------------------------------------------------------------- Inputs --- */

const field =
  "w-full rounded-[10px] border border-control-border bg-control px-3 text-sm text-fg transition-colors duration-1 " +
  "placeholder:text-fg-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:opacity-60";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn(field, "h-[34px]", className)} {...props} />
));
Input.displayName = "Input";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(field, "min-h-[72px] py-2", className)} {...props} />
));
Textarea.displayName = "Textarea";

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(({ className, children, ...props }, ref) => (
  <select ref={ref} className={cn(field, "h-[34px] cursor-pointer pr-8 [&>option]:bg-[rgb(var(--control))]", className)} {...props}>
    {children}
  </select>
));
Select.displayName = "Select";

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("mb-1.5 block text-xs font-medium text-fg-muted", className)} {...props} />;
}

/* ------------------------------------------------------------------ Panel ---
 * Tier by what the surface DOES: g0 (default) for tables/charts/logs, g1 for hero cards,
 * g2 only for the single floating surface. Budget: ≤ 6 blurred surfaces per viewport. */

export type Tier = "g0" | "g1" | "g2";
const TIER: Record<Tier, string> = { g0: "glass-solid", g1: "glass", g2: "glass-strong" };

export function Panel({ className, tier = "g0", spot, ...props }: React.HTMLAttributes<HTMLDivElement> & { tier?: Tier; spot?: boolean }) {
  useSpotlight(spot);
  return <div className={cn(TIER[tier], "rounded-2xl", spot && "spot", className)} {...props} />;
}

export function PanelHeader({ title, subtitle, actions, className }: { title: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-start justify-between gap-3 px-5 pt-4", className)}>
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold leading-6 tracking-[-0.005em] text-fg">{title}</h2>
        {subtitle && <p className="mt-0.5 text-[13px] text-fg-subtle">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ Badge --- */

export function Chip({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn("inline-flex max-w-full items-center gap-1 truncate rounded-md border border-line bg-[rgb(var(--hover)/0.06)] px-1.5 py-0.5 text-[11.5px] font-medium text-fg-muted", className)}
      {...props}
    />
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-line bg-control px-1.5 py-0.5 font-mono text-[10.5px] text-fg-subtle">{children}</kbd>;
}

/* --------------------------------------------------------------- Skeleton --- */

export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn("relative overflow-hidden rounded-md bg-[rgb(var(--hover)/0.08)]", className)} aria-hidden>
      <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-[rgb(var(--hover)/0.1)] to-transparent" />
    </div>
  );
}

/* ---------------------------------------------------------- Empty / Error --- */

/** Inline animated radar: rotation + opacity only; static under reduced motion / Effects Off. */
export function Radar({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 120 120" className={cn("size-24", className)} aria-hidden>
      <defs>
        <linearGradient id="radar-sweep" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="rgb(var(--primary-text))" stopOpacity="0" />
          <stop offset="1" stopColor="rgb(var(--primary-text))" stopOpacity=".45" />
        </linearGradient>
      </defs>
      {[52, 36, 20].map((r) => (
        <circle key={r} cx="60" cy="60" r={r} fill="none" stroke="rgb(var(--line) / calc(var(--line-a) * 1.6))" />
      ))}
      <path d="M60 8v104M8 60h104" stroke="rgb(var(--line) / var(--line-a))" />
      <g className="origin-center animate-[spin_4s_linear_infinite]" style={{ transformBox: "view-box" }}>
        <path d="M60 60L60 8A52 52 0 0 1 105 34z" fill="url(#radar-sweep)" />
      </g>
      <circle cx="84" cy="40" r="3" fill="rgb(var(--highlight))" className="animate-pulse-dot" />
      <circle cx="60" cy="60" r="3" fill="rgb(var(--primary-text))" />
    </svg>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div role="status" className={cn("flex flex-col items-center justify-center px-6 py-12 text-center", className)}>
      {Icon ? (
        <div className="mb-3 rounded-2xl border border-line bg-[rgb(var(--hover)/0.05)] p-3">
          <Icon className="size-6 text-fg-subtle" />
        </div>
      ) : (
        <Radar className="mb-2" />
      )}
      <p className="text-[15px] font-semibold text-fg">{title}</p>
      {description && <p className="mt-1 max-w-sm text-[13px] text-fg-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : "Request failed";
  return (
    <div role="alert" className="flex flex-col items-center px-6 py-10 text-center">
      <AlertTriangle className="mb-2 size-6 text-danger-text" />
      <p className="text-sm font-semibold text-fg">Couldn't load this</p>
      <p className="mt-1 max-w-md text-[13px] text-fg-muted">{msg}</p>
      {onRetry && (
        <Button size="sm" className="mt-4" onClick={onRetry}>
          <RefreshCw /> Retry
        </Button>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- Sparkline --- */

/** Trend line + soft area; draws in once per mount (stroke-dashoffset on a pathLength=1 path). */
export function Sparkline({ data, label, className }: { data: number[]; label: string; className?: string }) {
  const mounted = React.useRef(false);
  React.useEffect(() => {
    mounted.current = true;
  }, []);
  const w = 120;
  const h = 36;
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const span = Math.max(...data) - min || 1;
  const pts = data.map((v, i) => [2 + (i * (w - 4)) / (data.length - 1), 2 + (h - 4) * (1 - (v - min) / span)]);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("");
  const area = `${d}L${pts[pts.length - 1][0].toFixed(1)} ${h}L${pts[0][0].toFixed(1)} ${h}Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className={cn("block h-9 w-full overflow-visible", className)} role="img" aria-label={label}>
      <path d={area} className={cn("fill-primary/15", !mounted.current && "animate-in fade-in duration-500")} />
      <path
        d={d}
        pathLength={1}
        fill="none"
        stroke="rgb(var(--primary-text))"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        style={mounted.current ? undefined : { strokeDasharray: 1, strokeDashoffset: 1, animation: "draw 500ms cubic-bezier(0.3,0,0,1) forwards" }}
      />
    </svg>
  );
}

/* ------------------------------------------------------------- Stat tile ---
 * Number values animate with a rAF counter written to textContent (no React render per frame);
 * screen readers get the final value once. */

export function Stat({
  label,
  value,
  format = "number",
  hint,
  icon: Icon,
  tone = "default",
  delta,
  goodWhen = "up",
  spark,
  loading,
  onClick,
  className,
  style,
}: {
  label: string;
  value: React.ReactNode | number;
  format?: "number" | "percent" | "compact";
  hint?: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  tone?: "default" | "primary" | "warning" | "danger";
  /** fractional change, e.g. 0.042 → +4.2 % */
  delta?: number;
  /** threat counts going up is bad: pass "down" to colour a rise as negative (arrow + sign still say which way) */
  goodWhen?: "up" | "down";
  spark?: number[];
  loading?: boolean;
  onClick?: () => void;
  className?: string;
  style?: React.CSSProperties;
}) {
  const fmt = useNumberFormat(format);
  const pct = useNumberFormat("percent");
  const numeric = typeof value === "number";
  const ref = useCounter(numeric ? (value as number) : null, fmt);
  const toneCls = { default: "text-fg-subtle", primary: "text-primary-text", warning: "text-highlight-ink", danger: "text-danger-text" }[tone];
  const dir = delta === undefined ? null : delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  const good = dir === "flat" ? null : (dir === "up") === (goodWhen === "up");
  const Comp = (onClick ? "button" : "div") as "div";
  return (
    <Comp
      onClick={onClick}
      style={style}
      className={cn(
        "group flex min-w-0 flex-col rounded-xl px-4 py-3.5 text-left",
        onClick && "press transition-colors duration-1 hover:bg-[rgb(var(--hover)/0.04)]",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-label uppercase text-fg-subtle">{label}</span>
        {Icon && <Icon className={cn("size-4 shrink-0", toneCls)} />}
      </div>
      <div className="mt-1.5 min-w-0">
        <div className="min-w-0">
          {loading ? (
            // reserve the loaded geometry exactly: value line (32 px) + hint/delta line (16 px + 2 px)
            <>
              <Skeleton className="my-1 h-6 w-24" />
              <Skeleton className="mt-1.5 h-3 w-28" />
            </>
          ) : numeric ? (
            <p className="m-0 text-kpi tabular-nums text-fg">
              <span ref={ref} aria-hidden>
                {fmt(value as number)}
              </span>
              <span className="sr-only">{fmt(value as number)}</span>
            </p>
          ) : (
            <p className="m-0 truncate text-[22px] font-semibold leading-8 tracking-[-0.01em] text-fg">{value}</p>
          )}
          {dir && !loading ? (
            <span className={cn("mt-0.5 flex min-w-0 items-center gap-1 whitespace-nowrap text-xs font-semibold tabular-nums", good === null ? "text-fg-subtle" : good ? "text-primary-text" : "text-danger-text")}>
              {dir === "down" ? <TrendingDown className="size-3.5" aria-hidden /> : <TrendingUp className="size-3.5" aria-hidden />}
              {delta! > 0 ? "+" : ""}
              {pct(delta!)}
              {hint && <span className="ml-1 min-w-0 truncate font-medium text-fg-subtle">{hint}</span>}
            </span>
          ) : (
            hint && <span className="mt-0.5 block truncate text-xs text-fg-subtle">{hint}</span>
          )}
        </div>
      </div>
      {/* a spark slot (even an empty array while loading) always reserves its 28 px so nothing shifts */}
      {spark && (spark.length > 1 && !loading ? <Sparkline data={spark} label={`${label} trend`} className="mt-2 h-7" /> : <div className="mt-2 h-7" aria-hidden />)}
    </Comp>
  );
}

/* -------------------------------------------------------------- Segmented ---
 * Pill radio group; the gradient thumb slides on the snappy spring (transform only). */

export function Segmented<V extends string>({
  options,
  value,
  onChange,
  label,
  className,
  size = "md",
}: {
  options: { value: V; label: React.ReactNode }[];
  value: V;
  onChange: (v: V) => void;
  label: string;
  className?: string;
  size?: "sm" | "md";
}) {
  const refs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const thumb = React.useRef<HTMLSpanElement>(null);
  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  React.useLayoutEffect(() => {
    const b = refs.current[idx];
    const t = thumb.current;
    if (!b || !t) return;
    t.style.width = `${b.offsetWidth}px`;
    t.style.transform = `translateX(${b.offsetLeft - 2}px)`;
  });
  const onKey = (e: React.KeyboardEvent) => {
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const n = (idx + d + options.length) % options.length;
    onChange(options[n].value);
    refs.current[n]?.focus();
  };
  return (
    <span role="radiogroup" aria-label={label} onKeyDown={onKey} className={cn("relative inline-flex rounded-full border border-control-border bg-control p-0.5", className)}>
      <span ref={thumb} aria-hidden className="bg-brand absolute bottom-0.5 left-0.5 top-0.5 rounded-full transition-transform duration-3 ease-snappy" />
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => (refs.current[i] = el)}
          type="button"
          role="radio"
          aria-checked={i === idx}
          tabIndex={i === idx ? 0 : -1}
          onClick={() => onChange(o.value)}
          className={cn(
            "relative z-[1] rounded-full font-semibold transition-colors duration-1",
            size === "sm" ? "h-6 px-2.5 text-[11.5px]" : "h-[26px] px-3 text-xs",
            i === idx ? "text-on-brand" : "text-fg-muted hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}
