import {
  Activity,
  Database,
  FileClock,
  Flag,
  LayoutDashboard,
  ListChecks,
  Radar,
  RefreshCcw,
  Settings,
  ShieldCheck,
  Users,
} from "lucide-react";
import type { Role } from "@/lib/types";

export interface NavItem {
  to: string;
  label: string;
  icon: typeof Activity;
  role?: Role;
}

export const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: "Monitor",
    items: [
      { to: "/", label: "Overview", icon: LayoutDashboard },
      { to: "/iocs", label: "IOC Explorer", icon: Database },
      { to: "/flags", label: "Flags", icon: Flag },
      { to: "/detections", label: "Detections", icon: Radar },
    ],
  },
  {
    section: "Configure",
    items: [
      { to: "/rules", label: "Rules", icon: ListChecks },
      { to: "/allowlist", label: "Allowlist", icon: ShieldCheck },
      { to: "/sync", label: "Sync & Sources", icon: RefreshCcw },
    ],
  },
  {
    section: "Administer",
    items: [
      { to: "/audit", label: "Audit Log", icon: FileClock, role: "analyst" },
      { to: "/users", label: "Users", icon: Users, role: "admin" },
      { to: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

