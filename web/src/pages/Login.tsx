import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { Anchor, Lock, Moon, Sun } from "lucide-react";
import { api } from "@/lib/api";
import type { User } from "@/lib/types";
import { useAuth } from "@/store/auth";
import { useUi } from "@/store/ui";
import { Button, Input, Label } from "@/components/ui/primitives";

export function LoginPage() {
  const { user, setSession } = useAuth();
  const { theme, toggleTheme } = useUi();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: string } };
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to={location.state?.from ?? "/"} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ access_token: string; user: User }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      setSession(r.access_token, r.user);
      navigate(location.state?.from ?? "/", { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative grid min-h-full place-items-center px-4 py-10">
      <button
        onClick={toggleTheme}
        className="absolute right-4 top-4 rounded-lg p-2 text-fg-muted hover:text-fg"
        aria-label="Toggle theme"
      >
        {theme === "dark" ? <Sun className="size-5" /> : <Moon className="size-5" />}
      </button>
      <div className="w-full max-w-[400px]">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="bg-brand mb-4 grid size-14 place-items-center rounded-2xl shadow-[0_10px_34px_rgb(var(--grad-2)/0.35)]">
            <Anchor className="size-7 text-on-brand" aria-hidden />
          </div>
          <h1 className="text-2xl font-bold tracking-[-0.01em] text-fg">CyberAnchorage</h1>
          <p className="mt-1 text-sm text-fg-muted">Threat detection console · Cyber Sentinel suite</p>
        </div>
        <form onSubmit={submit} className="glass rounded-2xl p-6" noValidate>
          <div className="space-y-4">
            <div>
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
            </div>
            <div>
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            {error && (
              <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] text-danger-text">
                {error}
              </p>
            )}
            <Button type="submit" variant="primary" className="w-full" size="lg" loading={busy} disabled={!email || !password}>
              <Lock /> Sign in
            </Button>
          </div>
        </form>
        <p className="mt-4 text-center text-xs text-fg-subtle">Local-only console. Sessions use a rotating HttpOnly refresh cookie.</p>
      </div>
    </div>
  );
}
