import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Code2, History, Save, Trash2, Undo2, Zap } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError, del, post, put } from "@/lib/api";
import type { Condition, FieldSpec, Ioc, Rule, Severity, Verdict } from "@/lib/types";
import { fmtDate, fmtNum } from "@/lib/utils";
import { useAuth } from "@/store/auth";
import { PageHeader } from "@/components/AppShell";
import { SeverityBadge, TypeBadge, VerdictBadge } from "@/components/badges";
import { ConditionEditor, defaultLeaf, stripIds, withIds } from "@/components/RuleBuilder";
import { Button, EmptyState, ErrorState, Input, Label, Panel, PanelHeader, Select, Skeleton, Textarea } from "@/components/ui/primitives";
import { Sheet, SheetContent, Switch } from "@/components/ui/overlays";

interface Draft {
  name: string;
  description: string;
  enabled: boolean;
  priority: number;
  verdict: Verdict;
  severity: Severity;
  expires_at: string;
  condition: Condition;
  change_note: string;
}

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

function VersionHistory({ ruleId, current, canEdit }: { ruleId: number; current: number; canEdit: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [show, setShow] = useState<number | null>(null);
  const { data } = useQuery({
    queryKey: ["rules", ruleId, "versions"],
    queryFn: () => api<{ version: number; snapshot: any; changed_by_email: string; change_note: string; changed_at: string }[]>(`/rules/${ruleId}/versions`),
    enabled: open,
  });
  const restore = useMutation({
    mutationFn: (v: number) => post<Rule>(`/rules/${ruleId}/restore/${v}`),
    onSuccess: (r) => {
      toast.success(`Restored as v${r.version}`);
      qc.invalidateQueries({ queryKey: ["rules"] });
      setOpen(false);
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <History /> History
      </Button>
      <SheetContent title="Version history" description="Every save creates a version. Restoring creates a new version.">
        <ol className="divide-y divide-[rgb(var(--line)/var(--line-a))]">
          {data?.map((v) => (
            <li key={v.version} className="px-5 py-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-fg">
                    v{v.version} {v.version === current && <span className="ml-1 rounded bg-primary/15 px-1.5 text-[11px] text-primary-text">current</span>}
                  </div>
                  <div className="text-xs text-fg-muted">
                    {v.change_note || "—"} · {v.changed_by_email} · {fmtDate(v.changed_at)}
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setShow(show === v.version ? null : v.version)} aria-expanded={show === v.version}>
                    <Code2 /> View
                  </Button>
                  {canEdit && v.version !== current && (
                    <Button size="sm" variant="secondary" loading={restore.isPending && restore.variables === v.version} onClick={() => restore.mutate(v.version)}>
                      <Undo2 /> Restore
                    </Button>
                  )}
                </div>
              </div>
              {show === v.version && (
                <pre className="mono mt-2 max-h-72 overflow-auto rounded-lg border border-line bg-[rgb(var(--bg)/0.5)] p-3 text-[11.5px] text-fg-muted">
                  {JSON.stringify(v.snapshot, null, 2)}
                </pre>
              )}
            </li>
          ))}
        </ol>
      </SheetContent>
    </Sheet>
  );
}

export default function RuleEditorPage() {
  const { id } = useParams();
  const isNew = id === "new";
  const ruleId = isNew ? null : Number(id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const canEdit = useAuth((s) => s.can("analyst"));

  const fields = useQuery({ queryKey: ["rules", "fields"], queryFn: () => api<{ fields: FieldSpec[] }>("/rules/fields"), staleTime: Infinity });
  const rule = useQuery({ queryKey: ["rules", ruleId], queryFn: () => api<Rule>(`/rules/${ruleId}`), enabled: ruleId !== null });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [showJson, setShowJson] = useState(false);

  useEffect(() => {
    if (!fields.data) return;
    if (isNew && !draft)
      setDraft({
        name: "",
        description: "",
        enabled: true,
        priority: 100,
        verdict: "suspicious",
        severity: "medium",
        expires_at: "",
        condition: { op: "and", children: [defaultLeaf(fields.data.fields)] } as Condition,
        change_note: "",
      });
    if (rule.data && (!draft || rule.data.version !== (draft as any)._v))
      setDraft({
        ...(rule.data as any),
        expires_at: rule.data.expires_at ? rule.data.expires_at.slice(0, 16) : "",
        condition: withIds(rule.data.condition),
        change_note: "",
        _v: rule.data.version,
      } as Draft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields.data, rule.data, isNew]);

  const condition = useMemo(() => (draft ? stripIds(draft.condition) : null), [draft]);
  const debounced = useDebounced(condition ? JSON.stringify(condition) : "", 450);
  const preview = useQuery({
    queryKey: ["dry-run", debounced],
    queryFn: () => post<{ count: number; allowlisted: number; samples: Ioc[] }>("/rules/dry-run", { condition: JSON.parse(debounced) }),
    enabled: !!debounced,
    retry: false,
    placeholderData: (prev) => prev,
  });

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: draft!.name,
        description: draft!.description,
        enabled: draft!.enabled,
        priority: draft!.priority,
        verdict: draft!.verdict,
        severity: draft!.severity,
        condition,
        expires_at: draft!.expires_at ? new Date(draft!.expires_at).toISOString() : null,
        change_note: draft!.change_note,
      };
      return isNew ? post<Rule>("/rules", body) : put<Rule>(`/rules/${ruleId}`, body);
    },
    onSuccess: (r) => {
      toast.success(`Saved v${r.version} · ${fmtNum(r.match_count)} IOCs flagged`);
      qc.invalidateQueries({ queryKey: ["rules"] });
      qc.invalidateQueries({ queryKey: ["iocs"] });
      qc.invalidateQueries({ queryKey: ["flags"] });
      if (isNew) navigate(`/rules/${r.id}`, { replace: true });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: () => del(`/rules/${ruleId}`),
    onSuccess: () => {
      toast.success("Rule deleted and its flags removed");
      qc.invalidateQueries();
      navigate("/rules");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  if (fields.error || rule.error) return <ErrorState error={fields.error ?? rule.error} onRetry={() => (fields.refetch(), rule.refetch())} />;
  if (!draft || !fields.data) return <Skeleton className="h-[480px] rounded-2xl" />;
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const previewError = preview.error instanceof ApiError ? preview.error.message : preview.error ? String(preview.error) : null;

  return (
    <div>
      <PageHeader
        title={isNew ? "New rule" : draft.name || "Rule"}
        description={isNew ? "Build the condition, check the live preview, then save. Saving re-evaluates all IOCs immediately." : `Version ${rule.data?.version} · ${fmtNum(rule.data?.match_count)} IOCs currently flagged by this rule`}
        actions={
          <>
            <Button variant="ghost" onClick={() => navigate("/rules")}>
              <ArrowLeft /> Rules
            </Button>
            {!isNew && <VersionHistory ruleId={ruleId!} current={rule.data?.version ?? 0} canEdit={canEdit} />}
            {!isNew && canEdit && (
              <Button variant="ghost" onClick={() => window.confirm("Delete this rule? Its flags are removed.") && remove.mutate()} loading={remove.isPending}>
                <Trash2 /> Delete
              </Button>
            )}
            {canEdit && (
              <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending} disabled={!draft.name.trim() || !!previewError}>
                <Save /> Save{!isNew && " new version"}
              </Button>
            )}
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px] 2xl:grid-cols-[minmax(0,1fr)_440px]">
        <div className="space-y-4">
          <Panel className="p-5">
            <fieldset disabled={!canEdit} className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-4">
              <div className="md:col-span-2">
                <Label htmlFor="r-name">Name</Label>
                <Input id="r-name" value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Ransomware C2 infrastructure" maxLength={160} />
              </div>
              <div>
                <Label htmlFor="r-verdict">Verdict</Label>
                <Select id="r-verdict" value={draft.verdict} onChange={(e) => set({ verdict: e.target.value as Verdict })}>
                  <option value="abnormal">Abnormal</option>
                  <option value="suspicious">Suspicious</option>
                  <option value="malicious">Malicious</option>
                </Select>
              </div>
              <div>
                <Label htmlFor="r-sev">Severity</Label>
                <Select id="r-sev" value={draft.severity} onChange={(e) => set({ severity: e.target.value as Severity })}>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="critical">Critical</option>
                </Select>
              </div>
              <div className="md:col-span-2">
                <Label htmlFor="r-desc">Description</Label>
                <Textarea id="r-desc" value={draft.description} onChange={(e) => set({ description: e.target.value })} rows={2} placeholder="Why this rule exists and what an analyst should do" />
              </div>
              <div>
                <Label htmlFor="r-prio">Priority (lower wins ties)</Label>
                <Input id="r-prio" type="number" min={0} max={10000} value={draft.priority} onChange={(e) => set({ priority: Number(e.target.value) })} />
              </div>
              <div>
                <Label htmlFor="r-exp">Expires (optional)</Label>
                <Input id="r-exp" type="datetime-local" value={draft.expires_at} onChange={(e) => set({ expires_at: e.target.value })} />
              </div>
              <div className="flex items-center gap-3 md:col-span-2">
                <Switch id="r-enabled" checked={draft.enabled} onCheckedChange={(enabled) => set({ enabled })} />
                <label htmlFor="r-enabled" className="text-sm text-fg">
                  Enabled
                </label>
                <span className="text-sm text-fg-subtle">→</span>
                <VerdictBadge verdict={draft.verdict} />
                <SeverityBadge severity={draft.severity} />
              </div>
              {!isNew && (
                <div className="md:col-span-2">
                  <Label htmlFor="r-note">Change note (shown in history)</Label>
                  <Input id="r-note" value={draft.change_note} onChange={(e) => set({ change_note: e.target.value })} placeholder="What changed and why" maxLength={240} />
                </div>
              )}
            </fieldset>
          </Panel>

          <Panel>
            <PanelHeader
              title="Condition"
              subtitle="Nested AND / OR / NOT. Allowlisted IOCs are never flagged, whatever the rule says."
              actions={
                <Button size="sm" variant="ghost" onClick={() => setShowJson(!showJson)} aria-pressed={showJson}>
                  <Code2 /> JSON
                </Button>
              }
            />
            <div className="p-4">
              <ConditionEditor node={draft.condition} fields={fields.data.fields} readOnly={!canEdit} onChange={(c) => set({ condition: c })} />
              {showJson && (
                <pre className="mono mt-3 max-h-80 overflow-auto rounded-xl border border-line bg-[rgb(var(--bg)/0.5)] p-3 text-[11.5px] text-fg-muted">
                  {JSON.stringify(condition, null, 2)}
                </pre>
              )}
            </div>
          </Panel>
        </div>

        <Panel className="xl:sticky xl:top-20 xl:self-start">
          <PanelHeader
            title={
              <span className="flex items-center gap-2">
                <Zap className="size-4 text-primary-text" /> Live preview
              </span>
            }
            subtitle="Dry-run against all active IOCs · nothing is saved"
          />
          <div className="px-5 pb-5 pt-3" aria-live="polite">
            {previewError ? (
              <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] text-danger-text">
                {previewError}
              </p>
            ) : preview.isLoading ? (
              <Skeleton className="h-40" />
            ) : preview.data ? (
              <>
                <div className="flex items-end gap-3">
                  <span className="text-3xl font-semibold tabular-nums text-fg">{fmtNum(preview.data.count)}</span>
                  <span className="pb-1 text-sm text-fg-muted">IOCs would be flagged{preview.isFetching && " · updating…"}</span>
                </div>
                {preview.data.allowlisted > 0 && <p className="mt-1 text-xs text-fg-subtle">{fmtNum(preview.data.allowlisted)} more match but are allowlisted</p>}
                {preview.data.samples.length === 0 ? (
                  <EmptyState title="No matches" description="Loosen the condition, or sync more data." className="py-8" />
                ) : (
                  <ul className="mt-4 divide-y divide-[rgb(var(--line)/var(--line-a))] rounded-xl border border-line">
                    {preview.data.samples.map((i) => (
                      <li key={i.id} className="flex items-center gap-2 px-3 py-2">
                        <TypeBadge type={i.type} />
                        <span className="mono min-w-0 flex-1 truncate text-fg" title={i.value}>
                          {i.value}
                        </span>
                        <span className="text-xs tabular-nums text-fg-subtle">{Math.round(i.score * 100)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {preview.data.count > preview.data.samples.length && <p className="mt-2 text-xs text-fg-subtle">Showing the {preview.data.samples.length} highest-scoring matches.</p>}
              </>
            ) : null}
          </div>
        </Panel>
      </div>
    </div>
  );
}
