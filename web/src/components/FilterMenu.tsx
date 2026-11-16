import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Dropdown, DropdownCheckbox, DropdownContent, DropdownItem, DropdownLabel, DropdownSeparator, DropdownTrigger } from "@/components/ui/overlays";

/** Multi-select filter as a compact dropdown of checkboxes (keyboard accessible via Radix). */
export function FilterMenu({
  label,
  options,
  value,
  onChange,
  render = (k) => k,
}: {
  label: string;
  options: { key: string; count?: number }[];
  value: string[];
  onChange: (v: string[]) => void;
  render?: (k: string) => React.ReactNode;
}) {
  const active = value.length > 0;
  return (
    <Dropdown>
      <DropdownTrigger asChild>
        <button
          className={cn(
            "inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-[13px] font-medium transition-colors",
            active ? "border-primary/50 bg-primary/[.12] text-fg" : "border-line text-fg-muted hover:text-fg",
          )}
        >
          {label}
          {active && <span className="rounded bg-primary px-1 text-[11px] font-semibold text-primary-fg">{value.length}</span>}
          <ChevronDown className="size-3.5" aria-hidden />
        </button>
      </DropdownTrigger>
      <DropdownContent align="start" className="max-h-[60vh] overflow-y-auto">
        <DropdownLabel>{label}</DropdownLabel>
        {options.length === 0 && <div className="px-3 py-2 text-sm text-fg-muted">No values</div>}
        {options.map((o) => (
          <DropdownCheckbox
            key={o.key}
            checked={value.includes(o.key)}
            onCheckedChange={(c) => onChange(c ? [...value, o.key] : value.filter((v) => v !== o.key))}
          >
            <span className="flex-1">{render(o.key)}</span>
            {o.count !== undefined && <span className="text-xs tabular-nums text-fg-subtle">{o.count.toLocaleString()}</span>}
          </DropdownCheckbox>
        ))}
        {active && (
          <>
            <DropdownSeparator />
            <DropdownItem onSelect={() => onChange([])}>Clear {label.toLowerCase()}</DropdownItem>
          </>
        )}
      </DropdownContent>
    </Dropdown>
  );
}
