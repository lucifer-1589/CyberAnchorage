import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPlus } from "lucide-react";
import { toast } from "sonner";
import { api, patch, post } from "@/lib/api";
import type { Role, User } from "@/lib/types";
import { timeAgo } from "@/lib/utils";
import { useAuth } from "@/store/auth";
import { PageHeader } from "@/components/AppShell";
import { Button, ErrorState, Input, Label, Panel, Select, Skeleton } from "@/components/ui/primitives";
import { Sheet, SheetContent, Switch } from "@/components/ui/overlays";

const ROLE_HELP: Record<Role, string> = {
  viewer: "Read everything except the audit log",
  analyst: "+ rules, allowlist, Sync now, reveal live values",
  admin: "+ users and settings",
};

function NewUser() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ email: "", name: "", role: "viewer" as Role, password: "" });
  const m = useMutation({
    mutationFn: () => post<User>("/users", form),
    onSuccess: (u) => {
      toast.success(`${u.email} created`);
      qc.invalidateQueries({ queryKey: ["users"] });
      setOpen(false);
      setForm({ email: "", name: "", role: "viewer", password: "" });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const submit = (e: FormEvent) => (e.preventDefault(), m.mutate());
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button variant="primary" onClick={() => setOpen(true)}>
        <UserPlus /> Add user
      </Button>
      <SheetContent title="Add user" description="Passwords are hashed with argon2id.">
        <form onSubmit={submit} className="space-y-4 p-5">
          <div>
            <Label htmlFor="u-email">Email</Label>
            <Input id="u-email" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="u-name">Name</Label>
            <Input id="u-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="u-role">Role</Label>
            <Select id="u-role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
              {(["viewer", "analyst", "admin"] as Role[]).map((r) => (
                <option key={r} value={r}>{r} — {ROLE_HELP[r]}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="u-pass">Initial password (min 10 characters)</Label>
            <Input id="u-pass" type="password" minLength={10} required autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </div>
          <Button type="submit" variant="primary" loading={m.isPending} className="w-full">Create user</Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}

export default function UsersPage() {
  const me = useAuth((s) => s.user);
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ["users"], queryFn: () => api<User[]>("/users") });
  const upd = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Partial<User> }) => patch<User>(`/users/${id}`, body),
    onSuccess: () => {
      toast.success("User updated");
      qc.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <div>
      <PageHeader title="Users" description="Role-based access: viewer, analyst, admin. Every change is audited." actions={<NewUser />} />
      <Panel>
        {error ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : isLoading ? (
          <Skeleton className="m-4 h-40" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[11.5px] uppercase tracking-wide text-fg-muted">
                  <th className="px-4 py-2.5 font-semibold">User</th>
                  <th className="px-3 py-2.5 font-semibold">Role</th>
                  <th className="px-3 py-2.5 font-semibold">Last login</th>
                  <th className="px-3 py-2.5 font-semibold">Active</th>
                </tr>
              </thead>
              <tbody>
                {data!.map((u) => (
                  <tr key={u.id} className="border-b border-line last:border-0">
                    <td className="px-4 py-2.5">
                      <div className="text-fg">{u.name || u.email}</div>
                      <div className="text-xs text-fg-subtle">{u.email}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      <Select aria-label={`Role for ${u.email}`} className="w-36" value={u.role} disabled={u.id === me?.id} onChange={(e) => upd.mutate({ id: u.id, body: { role: e.target.value as Role } })}>
                        <option value="viewer">viewer</option>
                        <option value="analyst">analyst</option>
                        <option value="admin">admin</option>
                      </Select>
                    </td>
                    <td className="px-3 py-2.5 text-fg-muted">{timeAgo(u.last_login_at)}</td>
                    <td className="px-3 py-2.5">
                      <Switch aria-label={`${u.is_active ? "Deactivate" : "Activate"} ${u.email}`} checked={u.is_active} disabled={u.id === me?.id} onCheckedChange={(v) => upd.mutate({ id: u.id, body: { is_active: v } })} />
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
