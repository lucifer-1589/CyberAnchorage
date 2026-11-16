import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { AlertTriangle, Inbox, Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

/* ---------------------------------------------------------------- Button --- */

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors " +
    "disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring " +
    "[&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-fg shadow-sm hover:bg-primary/90",
        secondary: "border border-line bg-[rgb(var(--hover)/0.06)] text-fg hover:bg-[rgb(var(--hover)/0.1)]",
        ghost: "text-fg-muted hover:bg-[rgb(var(--hover)/var(--hover-a))] hover:text-fg",
        danger: "bg-danger text-white hover:bg-danger/90",
        link: "text-primary-text underline-offset-4 hover:underline px-0",
      },
      size: { sm: "h-8 px-3 text-[13px]", md: "h-9 px-4", lg: "h-10 px-5", icon: "h-9 w-9", "icon-sm": "h-8 w-8" },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, loading, children, disabled, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} disabled={disabled || loading} {...props}>
      {loading && <Loader2 className="animate-spin" aria-hidden />}
      {children}
    </button>
  ),
);
Button.displayName = "Button";

/* ----------------------------------------------------------------- Inputs --- */

const field =
  "w-full rounded-lg border border-line bg-[rgb(var(--glass-strong)/0.55)] px-3 text-sm text-fg " +
  "placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => <input ref={ref} className={cn(field, "h-9", className)} {...props} />,
);
Input.displayName = "Input";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => <textarea ref={ref} className={cn(field, "min-h-[72px] py-2", className)} {...props} />,
);
Textarea.displayName = "Textarea";

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <select ref={ref} className={cn(field, "h-9 cursor-pointer pr-8 [&>option]:bg-[rgb(var(--glass-strong))]", className)} {...props}>
      {children}
    </select>
  ),
);
Select.displayName = "Select";

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("mb-1.5 block text-xs font-medium text-fg-muted", className)} {...props} />;
}

/* ------------------------------------------------------------------ Panel --- */

export function Panel({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("glass rounded-2xl", className)} {...props} />;
}

export function PanelHeader({
  title,
  subtitle,
  actions,
  className,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-3 px-5 pt-4", className)}>
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold text-fg">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-fg-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ Badge --- */

export function Chip({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 truncate rounded-md border border-line bg-[rgb(var(--hover)/0.06)] px-1.5 py-0.5 text-[11.5px] font-medium text-fg-muted",
        className,
      )}
      {...props}
    />
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-line bg-[rgb(var(--hover)/0.08)] px-1.5 py-0.5 font-mono text-[10.5px] text-fg-muted">
      {children}
    </kbd>
  );
}

/* --------------------------------------------------------------- Skeleton --- */

export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn("relative overflow-hidden rounded-md bg-[rgb(var(--hover)/0.08)]", className)} aria-hidden>
      <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-[rgb(var(--hover)/0.08)] to-transparent" />
    </div>
  );
}

/* ---------------------------------------------------------- Empty / Error --- */

export function EmptyState({
  icon: Icon = Inbox,
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
    <div className={cn("flex flex-col items-center justify-center px-6 py-12 text-center", className)}>
      <div className="mb-3 rounded-2xl border border-line bg-[rgb(var(--hover)/0.05)] p-3">
        <Icon className="size-6 text-fg-subtle" />
      </div>
      <p className="text-sm font-semibold text-fg">{title}</p>
      {description && <p className="mt-1 max-w-sm text-[13px] text-fg-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : "Something went wrong";
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

/* ------------------------------------------------------------- Stat tile --- */

export function Stat({
  label,
  value,
  hint,
  icon: Icon,
  tone = "default",
  loading,
  onClick,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  tone?: "default" | "primary" | "warning" | "danger";
  loading?: boolean;
  onClick?: () => void;
}) {
  const toneCls = {
    default: "text-fg-muted",
    primary: "text-primary-text",
    warning: "text-highlight-ink",
    danger: "text-danger-text",
  }[tone];
  const Comp: any = onClick ? "button" : "div";
  return (
    <Comp
      onClick={onClick}
      className={cn(
        "glass flex min-w-0 flex-col rounded-2xl px-4 py-3.5 text-left",
        onClick && "transition hover:-translate-y-px hover:border-[rgb(var(--primary)/0.35)]",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-fg-muted">{label}</span>
        {Icon && <Icon className={cn("size-4 shrink-0", toneCls)} />}
      </div>
      {loading ? <Skeleton className="mt-2 h-7 w-20" /> : <span className="mt-1.5 text-2xl font-semibold tabular-nums text-fg">{value}</span>}
      {hint && <span className="mt-0.5 truncate text-[11.5px] text-fg-subtle">{hint}</span>}
    </Comp>
  );
}
