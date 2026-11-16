import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Anchor } from "lucide-react";
import { refreshSession } from "@/lib/api";
import type { Role } from "@/lib/types";
import { useAuth } from "@/store/auth";
import { AppShell } from "@/components/AppShell";
import { EmptyState, Skeleton } from "@/components/ui/primitives";
import { LoginPage } from "@/pages/Login";

const Overview = lazy(() => import("@/pages/Overview"));
const IocExplorer = lazy(() => import("@/pages/IocExplorer"));
const SyncPage = lazy(() => import("@/pages/Sync"));
const RulesPage = lazy(() => import("@/pages/Rules"));
const RuleEditor = lazy(() => import("@/pages/RuleEditor"));
const FlagsPage = lazy(() => import("@/pages/Flags"));
const AllowlistPage = lazy(() => import("@/pages/Allowlist"));
const DetectionsPage = lazy(() => import("@/pages/Detections"));
const AuditPage = lazy(() => import("@/pages/Audit"));
const UsersPage = lazy(() => import("@/pages/Users"));
const SettingsPage = lazy(() => import("@/pages/Settings"));

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
        ].map(([path, el]) => (
          <Route key={path as string} path={path as string} element={<Suspense fallback={<PageFallback />}>{el}</Suspense>} />
        ))}
        <Route path="*" element={<EmptyState title="Page not found" description="That page doesn't exist." />} />
      </Route>
    </Routes>
  );
}
