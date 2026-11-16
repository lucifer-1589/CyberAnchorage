import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Anchor } from "lucide-react";
import { refreshSession } from "@/lib/api";
import type { Role } from "@/lib/types";
import { useAuth } from "@/store/auth";
import { AppShell } from "@/components/AppShell";
import { EmptyState, Skeleton } from "@/components/ui/primitives";
import { LoginPage } from "@/pages/Login";

/* Route chunks: each loader is shared by React.lazy and by preloadRoute(), which main.tsx calls at boot so
 * the current page's chunk downloads in parallel with the session refresh instead of after it. */
const load = {
  overview: () => import("@/pages/Overview"),
  iocs: () => import("@/pages/IocExplorer"),
  sync: () => import("@/pages/Sync"),
  rules: () => import("@/pages/Rules"),
  ruleEditor: () => import("@/pages/RuleEditor"),
  flags: () => import("@/pages/Flags"),
  allowlist: () => import("@/pages/Allowlist"),
  detections: () => import("@/pages/Detections"),
  audit: () => import("@/pages/Audit"),
  users: () => import("@/pages/Users"),
  settings: () => import("@/pages/Settings"),
};
const Overview = lazy(load.overview);
const IocExplorer = lazy(load.iocs);
const SyncPage = lazy(load.sync);
const RulesPage = lazy(load.rules);
const RuleEditor = lazy(load.ruleEditor);
const FlagsPage = lazy(load.flags);
const AllowlistPage = lazy(load.allowlist);
const DetectionsPage = lazy(load.detections);
const AuditPage = lazy(load.audit);
const UsersPage = lazy(load.users);
const SettingsPage = lazy(load.settings);

export function preloadRoute(pathname: string): void {
  const first = pathname.split("/")[1] ?? "";
  const key = ({ "": "overview", iocs: "iocs", sync: "sync", flags: "flags", allowlist: "allowlist", detections: "detections", audit: "audit", users: "users", settings: "settings" } as const)[first as ""];
  if (first === "rules") void (pathname.split("/")[2] ? load.ruleEditor() : load.rules());
  else if (key) void load[key]();
}
/** Dev-only component gallery; also built when VITE_UI_KIT=1 (screenshot runs). Absent from production. */
const DevUiKit = import.meta.env.DEV || import.meta.env.VITE_UI_KIT === "1" ? lazy(() => import("@/pages/DevUiKit")) : null;

function Splash() {
  return (
    <div className="grid h-full place-items-center">
      <div className="flex flex-col items-center gap-3 text-fg-muted">
        <Anchor className="size-8 animate-pulse text-primary-text" aria-hidden />
        <span className="text-sm">Loading CyberAnchorage…</span>
      </div>
    </div>
  );
}

function PageFallback() {
  return (
    <div className="space-y-4" aria-busy>
      <Skeleton className="h-8 w-56" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-2xl" />
        ))}
      </div>
      <Skeleton className="h-80 rounded-2xl" />
    </div>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, ready } = useAuth();
  const location = useLocation();
  if (!ready) return <Splash />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}

function RequireRole({ role, children }: { role: Role; children: ReactNode }) {
  const can = useAuth((s) => s.can);
  if (!can(role)) return <EmptyState title="Not permitted" description={`This page needs the ${role} role.`} />;
  return <>{children}</>;
}

export function App() {
  const setReady = useAuth((s) => s.setReady);
  useEffect(() => {
    // Restore the session from the HttpOnly refresh cookie on first load.
    refreshSession().then((ok) => !ok && setReady());
  }, [setReady]);

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        {[
          ["/", <Overview />],
          ["/iocs", <IocExplorer />],
          ["/sync", <SyncPage />],
          ["/rules", <RulesPage />],
          ["/rules/:id", <RuleEditor />],
          ["/flags", <FlagsPage />],
          ["/allowlist", <AllowlistPage />],
          ["/detections", <DetectionsPage />],
          ["/audit", <RequireRole role="analyst"><AuditPage /></RequireRole>],
          ["/users", <RequireRole role="admin"><UsersPage /></RequireRole>],
          ["/settings", <SettingsPage />],
          ...(DevUiKit ? [["/dev/ui-kit", <DevUiKit />]] : []),
        ].map(([path, el]) => (
          <Route key={path as string} path={path as string} element={<Suspense fallback={<PageFallback />}>{el}</Suspense>} />
        ))}
        <Route path="*" element={<EmptyState title="Page not found" description="That page doesn't exist." />} />
      </Route>
    </Routes>
  );
}
