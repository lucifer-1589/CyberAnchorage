import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, del, post } from "@/lib/api";
import type { AllowEntry } from "@/lib/types";
import { fmtDate, fmtNum, IOC_TYPES, TYPE_LABELS } from "@/lib/utils";
import { useAuth } from "@/store/auth";
import { PageHeader } from "@/components/AppShell";
import { Button, Chip, EmptyState, ErrorState, Input, Label, Panel, PanelHeader, Select, Skeleton } from "@/components/ui/primitives";

const KIND_LABEL = { value: "Exact value", cidr: "CIDR range", domain_suffix: "Domain + subdomains" } as const;
const KIND_HINT = { value: "evil-but-sinkholed.com", cidr: "8.8.8.0/24", domain_suffix: "archive.org" } as const;

function AddForm() {
  const qc = useQueryClient();
  const [kind, setKind] = useState<AllowEntry["kind"]>("domain_suffix");
  const [value, setValue] = useState("");
  const [type, setType] = useState("");
  const [reason, setReason] = useState("");
  const [expires, setExpires] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value.trim()), 400);
    return () => clearTimeout(t);
  }, [value]);

  const body = { kind, value: debounced, ioc_type: kind === "value" && type ? type : null, reason };
  const preview = useQuery({
    queryKey: ["allowlist", "preview", kind, debounced, type],
    queryFn: () => post<{ matches: number; currently_flagged: number }>("/allowlist/preview", body),
    enabled: debounced.length > 2,
    retry: false,
  });
  const add = useMutation({
    mutationFn: () => post<AllowEntry>("/allowlist", { ...body, value: value.trim(), expires_at: expires ? new Date(expires).toISOString() : null }),
    onSuccess: () => {
      toast.success("Allowlisted — matching IOCs unflagged");
      setValue("");
      setReason("");
      qc.invalidateQueries();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const submit = (e: FormEvent) => (e.preventDefault(), add.mutate());

  return (
    <Panel>
      <PanelHeader title="Add entry" subtitle="Allowlist entries always override rules and are audited." />
      <form onSubmit={submit} className="grid grid-cols-1 gap-3 p-5 md:grid-cols-2 xl:grid-cols-[180px_1fr_150px_1fr_190px_auto] xl:items-end">
        <div>
          <Label htmlFor="al-kind">Match</Label>
          <Select id="al-kind" value={kind} onChange={(e) => setKind(e.target.value as AllowEntry["kind"])}>
            {Object.entries(KIND_LABEL).map(([k, l]) => (
              <option key={k} value={k}>{l}</option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="al-value">Value</Label>
          <Input id="al-value" className="font-mono" value={value} onChange={(e) => setValue(e.target.value)} placeholder={KIND_HINT[kind]} required />
        </div>
        <div>
          <Label htmlFor="al-type">IOC type</Label>
          <Select id="al-type" value={type} onChange={(e) => setType(e.target.value)} disabled={kind !== "value"}>
            <option value="">Any type</option>
            {IOC_TYPES.map((t) => (
              <option key={t} value={t}>{TYPE_LABELS[t]}</option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="al-reason">Reason</Label>
          <Input id="al-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="benign CDN, internal scanner…" />
        </div>
        <div>
          <Label htmlFor="al-exp">Expires (optional)</Label>
          <Input id="al-exp" type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} />
        </div>
        <Button type="submit" variant="primary" loading={add.isPending} disabled={!value.trim()}>
          <Plus /> Add
        </Button>
        <p className="text-xs text-fg-muted md:col-span-2 xl:col-span-6" aria-live="polite">
          {preview.error
            ? <span className="text-danger-text">{(preview.error as Error).message}</span>
            : preview.data
              ? <>Matches <strong className="text-fg">{fmtNum(preview.data.matches)}</strong> IOCs, <strong className="text-fg">{fmtNum(preview.data.currently_flagged)}</strong> currently flagged — they will be unflagged.</>
              : "Type a value to preview its impact."}
        </p>
      </form>
    </Panel>
  );
}

export default function AllowlistPage() {
  const canEdit = useAuth((s) => s.can("analyst"));
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ["allowlist"], queryFn: () => api<AllowEntry[]>("/allowlist") });
  const remove = useMutation({
    mutationFn: (id: number) => del(`/allowlist/${id}`),
    onSuccess: () => {
      toast.success("Entry removed — rules re-applied");
      qc.invalidateQueries();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <div className="space-y-4">
      <PageHeader title="Allowlist" description="Known-good infrastructure that must never be flagged or detected, e.g. sinkholes, CDNs and archive hosts that appear in CTI chatter." />
      {canEdit && <AddForm />}
      <Panel>
        {error ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : isLoading ? (
          <Skeleton className="m-4 h-32" />
        ) : !data?.length ? (
          <EmptyState icon={ShieldCheck} title="Allowlist is empty" description="Nothing is suppressed — every rule match becomes a flag." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[11.5px] uppercase tracking-wide text-fg-muted">
                  <th className="px-4 py-2.5 font-semibold">Match</th>
                  <th className="px-3 py-2.5 font-semibold">Value</th>
                  <th className="px-3 py-2.5 font-semibold">Reason</th>
                  <th className="px-3 py-2.5 font-semibold">Added</th>
                  <th className="px-3 py-2.5 font-semibold">Expires</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.map((e) => (
                  <tr key={e.id} className="border-b border-line last:border-0">
                    <td className="px-4 py-2.5"><Chip className="text-fg">{KIND_LABEL[e.kind]}{e.ioc_type && ` · ${TYPE_LABELS[e.ioc_type] ?? e.ioc_type}`}</Chip></td>
                    <td className="mono px-3 py-2.5 text-fg">{e.value}</td>
                    <td className="px-3 py-2.5 text-fg-muted">{e.reason || "—"}</td>
                    <td className="px-3 py-2.5 text-fg-muted">{fmtDate(e.created_at, false)} · {e.created_by_email}</td>
                    <td className="px-3 py-2.5 text-fg-muted">{e.expires_at ? fmtDate(e.expires_at) : "never"}</td>
                    <td className="px-3 py-2.5 text-right">
                      {canEdit && (
                        <Button size="icon-sm" variant="ghost" aria-label={`Remove ${e.value}`} loading={remove.isPending && remove.variables === e.id} onClick={() => window.confirm(`Remove ${e.value} from the allowlist? Rules will flag it again.`) && remove.mutate(e.id)}>
                          <Trash2 />
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
