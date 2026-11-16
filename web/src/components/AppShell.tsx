import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Anchor,
  LogOut,
  Menu,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  Sun,
} from "lucide-react";
import { api, post } from "@/lib/api";
import { useLiveConnection } from "@/lib/live";
import { cn, fmtNum } from "@/lib/utils";
import { EASE, DUR, useSettle, withViewTransition } from "@/lib/motion";
import { motionOK } from "@/lib/perf";
import { useAuth } from "@/store/auth";
import { useUi } from "@/store/ui";
import { Button, Kbd } from "@/components/ui/primitives";
import { Dropdown, DropdownContent, DropdownItem, DropdownLabel, DropdownSeparator, DropdownTrigger, Sheet, SheetContent, Tip } from "@/components/ui/overlays";
import { CommandPalette } from "@/components/CommandPalette";
import { NAV } from "@/components/nav";
import { DemoBadge } from "@/components/badges";

function Brand({ collapsed }: { collapsed?: boolean }) {
  return (
    <div className={cn("flex items-center gap-2.5 px-3 py-4", collapsed && "justify-center px-0")}>
      <div className="bg-brand grid size-9 shrink-0 place-items-center rounded-[10px] shadow-[0_6px_20px_rgb(var(--grad-2)/0.3)]">
        <Anchor className="size-5 text-on-brand" aria-hidden />
      </div>
      {!collapsed && (
        <div className="min-w-0 leading-tight">
          <div className="truncate text-[15px] font-bold tracking-[-0.01em] text-fg">CyberAnchorage</div>
          <div className="text-[11px] text-fg-subtle">Threat Detection · L1</div>
        </div>
      )}
    </div>
  );
}

function NavList({ collapsed, onNavigate }: { collapsed?: boolean; onNavigate?: () => void }) {
  const can = useAuth((s) => s.can);
  return (
    <nav aria-label="Main" className="flex flex-col gap-4 px-2">
      {NAV.map((group) => (
        <div key={group.section}>
          {!collapsed && <div className="px-2.5 pb-1.5 text-label uppercase text-fg-subtle">{group.section}</div>}
          <ul className="flex flex-col gap-0.5">
            {group.items
              .filter((i) => !i.role || can(i.role))
              .map((item) => {
                const link = (
                  <NavLink
                    to={item.to}
                    end={item.to === "/"}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      cn(
                        "relative flex h-[38px] items-center gap-3 rounded-[10px] px-2.5 text-[13.5px] font-medium transition-colors duration-1",
                        collapsed && "justify-center px-0",
                        isActive
                          ? "bg-primary/[.12] text-fg before:absolute before:inset-y-1.5 before:-left-2 before:w-[3px] before:rounded-r-full before:bg-gradient-to-b before:from-[rgb(var(--grad-1))] before:via-[rgb(var(--grad-2))] before:to-[rgb(var(--grad-3))]"
                          : "text-fg-muted hover:bg-[rgb(var(--hover)/var(--hover-a))] hover:text-fg",
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <item.icon className={cn("size-[18px] shrink-0", isActive ? "text-primary-text" : "")} aria-hidden />
                        {collapsed ? <span className="sr-only">{item.label}</span> : item.label}
                      </>
                    )}
                  </NavLink>
                );
                return <li key={item.to}>{collapsed ? <Tip content={item.label} side="right">{link}</Tip> : link}</li>;
              })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function LiveDot() {
  const live = useUi((s) => s.liveConnected);
  return (
    <Tip content={live ? "Live updates connected" : "Live updates disconnected — retrying"}>
      <span role="status" aria-live="polite" className="hidden items-center gap-1.5 rounded-full border border-line px-2 py-1 text-[11.5px] font-medium text-fg-muted sm:inline-flex">
        <span className={cn("relative size-2 rounded-full", live ? "bg-primary" : "bg-fg-subtle")} aria-hidden>
          {live && <span className="absolute -inset-1 animate-pulse-ring rounded-full bg-primary opacity-0" />}
        </span>
        {live ? "Live" : "Offline"}
      </span>
    </Tip>
  );
}

function TopBar() {
  const { theme, toggleTheme, setPalette, setMobileNav, toggleSidebar, sidebarCollapsed } = useUi();
  const user = useAuth((s) => s.user);
  const clear = useAuth((s) => s.clear);
  const navigate = useNavigate();

  async function logout() {
    try {
      await post("/auth/logout");
    } finally {
      clear();
      navigate("/login");
    }
  }

  return (
    <header className="glass sticky top-2 z-30 mx-2 mt-2 flex h-14 items-center gap-2 rounded-2xl px-2 sm:px-3">
      <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileNav(true)} aria-label="Open navigation">
        <Menu />
      </Button>
      <Button variant="ghost" size="icon" className="hidden lg:inline-flex" onClick={toggleSidebar} aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}>
        {sidebarCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
      </Button>
      <button
        onClick={() => setPalette(true)}
        className="flex h-[34px] min-w-0 flex-1 items-center gap-2 rounded-[10px] border border-control-border/70 bg-control/70 px-3 text-left text-sm text-fg-subtle transition-colors duration-1 hover:text-fg-muted sm:max-w-md"
        aria-label="Search IOCs, rules and pages (Ctrl+K)"
      >
        <Search className="size-4 shrink-0" aria-hidden />
        <span className="truncate">Search IOCs, rules, pages…</span>
        <span className="ml-auto hidden items-center gap-1 sm:flex">
          <Kbd>Ctrl</Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>
      <div className="ml-auto flex items-center gap-1.5">
        <LiveDot />
        <Tip content={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}>
          <Button variant="ghost" size="icon" onClick={() => withViewTransition(toggleTheme)} aria-label="Toggle theme">
            {theme === "dark" ? <Sun /> : <Moon />}
          </Button>
        </Tip>
        <Dropdown>
          <DropdownTrigger asChild>
            <button className="flex items-center gap-2 rounded-xl px-1.5 py-1 hover:bg-[rgb(var(--hover)/var(--hover-a))]" aria-label="Account menu">
              <span className="grid size-8 place-items-center rounded-full bg-secondary/25 text-[13px] font-semibold uppercase text-fg">
                {(user?.name || user?.email || "?").slice(0, 1)}
              </span>
              <span className="hidden text-left leading-tight md:block">
                <span className="block max-w-[160px] truncate text-[13px] font-medium text-fg">{user?.name || user?.email}</span>
                <span className="block text-[11px] capitalize text-fg-subtle">{user?.role}</span>
              </span>
            </button>
          </DropdownTrigger>
          <DropdownContent align="end">
            <DropdownLabel>{user?.email}</DropdownLabel>
            <DropdownSeparator />
            <DropdownItem onSelect={() => navigate("/settings")}>
              <Settings /> Settings
            </DropdownItem>
            <DropdownItem onSelect={logout}>
              <LogOut /> Sign out
            </DropdownItem>
          </DropdownContent>
        </Dropdown>
      </div>
    </header>
  );
}

function DemoBanner() {
  const { data } = useQuery({
    queryKey: ["overview"],
    queryFn: () => api<any>("/stats/overview"),
    staleTime: 30_000,
  });
  const demo = data?.totals?.demo ?? 0;
  if (!demo) return null;
  return (
    <div className="mx-2 mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-highlight/30 bg-highlight-soft/[.08] px-3 py-1.5 text-[12.5px] text-fg-muted">
      <DemoBadge />
      <span>
        <strong className="font-semibold text-fg">{fmtNum(demo)}</strong> IOCs come from the synthetic demo fixture. They are marked with this badge everywhere.
      </span>
    </div>
  );
}

/** Route outlet keyed by path: fade + 8 px rise + .995 scale over 200 ms; glass inside settles while it moves. */
function RouteView({ children }: { children?: ReactNode }) {
  const location = useLocation();
  const ref = useRef<HTMLDivElement>(null);
  useSettle(ref, [location.pathname]);
  return (
    <div key={location.pathname} ref={ref} className="route-enter">
      {children ?? <Outlet />}
    </div>
  );
}

export function AppShell({ children }: { children?: ReactNode }) {
  useLiveConnection();
  const { sidebarCollapsed, mobileNavOpen, setMobileNav, setPalette } = useUi();
  const location = useLocation();
  const columnRef = useRef<HTMLDivElement>(null);
  const lastLeft = useRef<number | null>(null);

  useEffect(() => setMobileNav(false), [location.pathname, setMobileNav]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPalette]);

  // Sidebar collapse: the grid changes once (one layout); the content column then FLIPs from its old x
  // on the snappy spring. Nothing animates width.
  useLayoutEffect(() => {
    const el = columnRef.current;
    if (!el) return;
    const left = el.getBoundingClientRect().left;
    const dx = lastLeft.current === null ? 0 : lastLeft.current - left;
    lastLeft.current = left;
    if (dx && motionOK() && el.animate) el.animate([{ transform: `translateX(${dx}px)` }, { transform: "none" }], { duration: DUR[3], easing: EASE.snappy });
  }, [sidebarCollapsed]);

  return (
    <div className="flex min-h-full">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-fg">
        Skip to content
      </a>
      <aside
        aria-label="Primary"
        className={cn(
          "glass sticky top-2 ml-2 mt-2 hidden h-[calc(100dvh-1rem)] shrink-0 flex-col rounded-2xl lg:flex",
          sidebarCollapsed ? "w-[68px]" : "w-[236px]",
        )}
      >
        <Brand collapsed={sidebarCollapsed} />
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-4">
          <NavList collapsed={sidebarCollapsed} />
        </div>
      </aside>
      <Sheet open={mobileNavOpen} onOpenChange={setMobileNav}>
        <SheetContent title={<Brand />} side="left" className="sm:w-[280px]">
          <div className="py-3">
            <NavList onNavigate={() => setMobileNav(false)} />
          </div>
        </SheetContent>
      </Sheet>
      <div ref={columnRef} className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <DemoBanner />
        <main id="main" className="mx-auto w-full max-w-[1600px] flex-1 px-3 py-4 sm:px-5 sm:py-6">
          <RouteView>{children}</RouteView>
        </main>
      </div>
      <CommandPalette />
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  useEffect(() => {
    document.title = `${title} · CyberAnchorage`;
  }, [title]);
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold leading-[30px] tracking-[-0.01em] text-fg sm:text-2xl">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-fg-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
