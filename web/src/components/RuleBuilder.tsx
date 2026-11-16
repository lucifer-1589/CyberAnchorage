import { useEffect, useState } from "react";
import { Ban, Braces, Plus, Trash2 } from "lucide-react";
import type { Condition, FieldSpec } from "@/lib/types";
import { cn, TYPE_LABELS } from "@/lib/utils";
import { Button, Input, Select } from "@/components/ui/primitives";
import { Tip } from "@/components/ui/overlays";

export const OP_LABELS: Record<string, string> = {
  eq: "is",
  neq: "is not",
  in: "is any of",
  not_in: "is none of",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  between: "between",
  has_any: "has any of",
  has_all: "has all of",
  has_none: "has none of",
  equals: "equals",
  in_cidr: "in CIDR",
  domain_suffix: "domain / subdomain of",
  wildcard: "matches wildcard",
  regex: "matches regex",
  contains: "contains",
  starts_with: "starts with",
  ends_with: "ends with",
};

const PLACEHOLDER: Record<string, string> = {
  in_cidr: "185.220.101.0/24",
  domain_suffix: "evil.com",
  wildcard: "*.evil-cdn*.top",
  regex: "^(login|secure)-",
  contains: "panel",
  equals: "evil[.]com or 1.2.3.4",
  in: "a.com, b.net, 1.2.3.4",
  not_in: "a.com, b.net",
};

let seq = 0;
export const uid = () => `n${++seq}`;

export function withIds(c: Condition): Condition {
  if ("field" in c) return { ...c, id: c.id ?? uid() };
  if (c.op === "not") return { ...c, id: c.id ?? uid(), child: withIds(c.child) };
  return { ...c, id: c.id ?? uid(), children: c.children.map(withIds) };
}

export function stripIds(c: Condition): Condition {
  if ("field" in c) return { field: c.field, operator: c.operator, value: c.value };
  if (c.op === "not") return { op: "not", child: stripIds(c.child) };
  return { op: c.op, children: c.children.map(stripIds) };
}

export function defaultLeaf(fields: FieldSpec[]): Condition {
  const f = fields.find((x) => x.name === "type") ?? fields[0];
  return { id: uid(), field: f.name, operator: f.operators.includes("in") ? "in" : f.operators[0], value: f.kind === "enum" ? [f.options[0]] : "" };
}

function isList(op: string) {
  return ["in", "not_in", "has_any", "has_all", "has_none"].includes(op);
}

function initialValue(f: FieldSpec, op: string): unknown {
  if (op === "between") return [f.min ?? 0, f.max ?? 1];
  if (f.kind === "enum" || f.kind === "tlp") return isList(op) ? [f.options[0]] : f.options[0];
  if (f.kind === "number" || f.kind === "age") return isList(op) ? [] : f.kind === "age" ? 7 : f.min ?? 0;
  return isList(op) ? [] : "";
}

/** Comma/newline separated list input that keeps the raw text while typing. */
function ListInput({ value, onChange, placeholder, numeric }: { value: unknown; onChange: (v: unknown[]) => void; placeholder?: string; numeric?: boolean }) {
  const toText = (v: unknown) => (Array.isArray(v) ? v.join(", ") : String(v ?? ""));
  const [text, setText] = useState(toText(value));
  useEffect(() => setText(toText(value)), [value]);
  return (
    <Input
      value={text}
      placeholder={placeholder ?? "comma separated"}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const parts = text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
        onChange(numeric ? parts.map(Number).filter((n) => !Number.isNaN(n)) : parts);
      }}
      aria-label="Values"
    />
  );
}

function ValueEditor({ f, op, value, onChange }: { f: FieldSpec; op: string; value: unknown; onChange: (v: unknown) => void }) {
  if (op === "between") {
    const [a, b] = Array.isArray(value) ? value : [0, 0];
    return (
      <div className="flex items-center gap-2">
        <Input type="number" step="any" value={String(a)} onChange={(e) => onChange([Number(e.target.value), b])} aria-label="Minimum" />
        <span className="text-xs text-fg-subtle">and</span>
        <Input type="number" step="any" value={String(b)} onChange={(e) => onChange([a, Number(e.target.value)])} aria-label="Maximum" />
      </div>
    );
  }
  if (f.kind === "enum" || f.kind === "tlp") {
    const label = (o: string) => (f.name === "type" ? TYPE_LABELS[o] ?? o : o);
    if (isList(op)) {
      const sel = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="flex flex-wrap gap-1" role="group" aria-label={`${f.label} values`}>
          {f.options.map((o) => {
            const on = sel.includes(o);
            return (
              <button
                key={o}
                type="button"
                aria-pressed={on}
                onClick={() => onChange(on ? sel.filter((x) => x !== o) : [...sel, o])}
                className={cn("rounded-md border px-2 py-1 text-xs font-medium transition", on ? "border-primary bg-primary/15 text-fg" : "border-line text-fg-muted hover:text-fg")}
              >
                {label(o)}
              </button>
            );
          })}
        </div>
      );
    }
    return (
      <Select value={String(Array.isArray(value) ? value[0] : value)} onChange={(e) => onChange(e.target.value)} aria-label={`${f.label} value`}>
        {f.options.map((o) => (
          <option key={o} value={o}>
            {label(o)}
          </option>
        ))}
      </Select>
    );
  }
  if (f.kind === "number" || f.kind === "age") {
    if (isList(op)) return <ListInput value={value} onChange={onChange} numeric placeholder="443, 8443, 4444" />;
    return (
      <div className="flex items-center gap-2">
        <Input type="number" step="any" min={f.min ?? undefined} max={f.max ?? undefined} value={String(value ?? "")} onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))} aria-label={`${f.label} value`} />
        {f.kind === "age" && <span className="text-xs text-fg-subtle">days</span>}
      </div>
    );
  }
  if (f.kind === "array" || f.kind === "int_set" || isList(op))
    return <ListInput value={value} onChange={onChange} placeholder={PLACEHOLDER[op] ?? (f.name === "asn" ? "AS13335, AS9009" : "lockbit, clop")} />;
  return <Input className={op === "regex" ? "font-mono" : ""} value={String(value ?? "")} placeholder={PLACEHOLDER[op]} onChange={(e) => onChange(e.target.value)} aria-label={`${f.label} value`} />;
}

function LeafEditor({ node, fields, onChange, onRemove, readOnly }: { node: Extract<Condition, { field: string }>; fields: FieldSpec[]; onChange: (c: Condition) => void; onRemove: () => void; readOnly?: boolean }) {
  const f = fields.find((x) => x.name === node.field) ?? fields[0];
  return (
    <fieldset disabled={readOnly} className="grid grid-cols-1 items-start gap-2 rounded-xl border border-line bg-[rgb(var(--glass-strong)/0.35)] p-2.5 sm:grid-cols-[minmax(150px,190px)_minmax(140px,180px)_1fr_auto]">
      <Select
        value={node.field}
        aria-label="Field"
        onChange={(e) => {
          const nf = fields.find((x) => x.name === e.target.value)!;
          const op = nf.operators[0];
          onChange({ ...node, field: nf.name, operator: op, value: initialValue(nf, op) });
        }}
      >
        {fields.map((x) => (
          <option key={x.name} value={x.name}>
            {x.label}
          </option>
        ))}
      </Select>
      <Select
        value={node.operator}
        aria-label="Operator"
        onChange={(e) => {
          const op = e.target.value;
          const keep = isList(op) === isList(node.operator) && op !== "between" && node.operator !== "between";
          onChange({ ...node, operator: op, value: keep ? node.value : initialValue(f, op) });
        }}
      >
        {f.operators.map((o) => (
          <option key={o} value={o}>
            {OP_LABELS[o] ?? o}
          </option>
        ))}
      </Select>
      <div className="min-w-0">
        <ValueEditor f={f} op={node.operator} value={node.value} onChange={(v) => onChange({ ...node, value: v })} />
        {f.help && node.field === "value" && <p className="mt-1 text-[11.5px] text-fg-subtle">{f.help}</p>}
      </div>
      {!readOnly && (
        <Button type="button" variant="ghost" size="icon-sm" onClick={onRemove} aria-label="Remove condition">
          <Trash2 />
        </Button>
      )}
    </fieldset>
  );
}

export function ConditionEditor({
  node,
  fields,
  onChange,
  onRemove,
  depth = 0,
  readOnly,
}: {
  node: Condition;
  fields: FieldSpec[];
  onChange: (c: Condition) => void;
  onRemove?: () => void;
  depth?: number;
  readOnly?: boolean;
}) {
  if ("field" in node) return <LeafEditor node={node} fields={fields} onChange={onChange} onRemove={onRemove ?? (() => {})} readOnly={readOnly} />;

  if (node.op === "not") {
    return (
      <div className="rounded-xl border border-dashed border-danger/45 p-2.5">
        <div className="mb-2 flex items-center justify-between">
          <span className="inline-flex items-center gap-1.5 rounded-md bg-danger/12 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-danger-text">
            <Ban className="size-3.5" aria-hidden /> Not
          </span>
          {!readOnly && (
            <Tip content="Remove NOT (keep inner condition)">
              <Button type="button" size="sm" variant="ghost" onClick={() => onChange(node.child)}>
                Unwrap
              </Button>
            </Tip>
          )}
        </div>
        <ConditionEditor node={node.child} fields={fields} depth={depth + 1} readOnly={readOnly} onChange={(c) => onChange({ ...node, child: c })} onRemove={onRemove} />
      </div>
    );
  }

  const g = node;
  const setChild = (i: number, c: Condition) => onChange({ ...g, children: g.children.map((x, j) => (j === i ? c : x)) });
  const removeChild = (i: number) => {
    const rest = g.children.filter((_, j) => j !== i);
    if (rest.length > 0) onChange({ ...g, children: rest });
    else if (onRemove) onRemove();
    else onChange({ ...g, children: [defaultLeaf(fields)] });
  };

  return (
    <div className={cn("rounded-2xl border p-3", depth === 0 ? "border-line" : "border-secondary/35 bg-secondary/[0.04]")}>
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="Combine with" className="inline-flex overflow-hidden rounded-lg border border-line">
          {(["and", "or"] as const).map((op) => (
            <button
              key={op}
              type="button"
              role="radio"
              aria-checked={g.op === op}
              disabled={readOnly}
              onClick={() => onChange({ ...g, op })}
              className={cn("px-3 py-1 text-xs font-bold uppercase tracking-wide transition", g.op === op ? "bg-primary text-primary-fg" : "text-fg-muted hover:text-fg")}
            >
              {op}
            </button>
          ))}
        </div>
        <span className="text-xs text-fg-subtle">{g.op === "and" ? "all of these must match" : "any of these may match"}</span>
        {!readOnly && (
          <div className="ml-auto flex flex-wrap gap-1">
            <Button type="button" size="sm" variant="ghost" onClick={() => onChange({ ...g, children: [...g.children, defaultLeaf(fields)] })}>
              <Plus /> Condition
            </Button>
            {depth < 6 && (
              <Button type="button" size="sm" variant="ghost" onClick={() => onChange({ ...g, children: [...g.children, { id: uid(), op: g.op === "and" ? "or" : "and", children: [defaultLeaf(fields)] }] })}>
                <Braces /> Group
              </Button>
            )}
            <Button type="button" size="sm" variant="ghost" onClick={() => onChange({ id: uid(), op: "not", child: g })} aria-label="Negate this group">
              <Ban /> Not
            </Button>
            {onRemove && (
              <Button type="button" size="icon-sm" variant="ghost" onClick={onRemove} aria-label="Remove group">
                <Trash2 />
              </Button>
            )}
          </div>
        )}
      </div>
      <div className="space-y-2">
        {g.children.map((c, i) => (
          <div key={c.id ?? i} className="relative">
            {i > 0 && <div className="mb-1 ml-3 text-[10.5px] font-bold uppercase tracking-wider text-fg-subtle">{g.op}</div>}
            <ConditionEditor node={c} fields={fields} depth={depth + 1} readOnly={readOnly} onChange={(n) => setChild(i, n)} onRemove={() => removeChild(i)} />
          </div>
        ))}
      </div>
    </div>
  );
}
