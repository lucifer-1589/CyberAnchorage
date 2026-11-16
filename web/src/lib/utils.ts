import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31536000],
  ["month", 2592000],
  ["week", 604800],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];

export function timeAgo(iso?: string | null): string {
  if (!iso) return "—";
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  for (const [unit, secs] of UNITS) {
    if (Math.abs(diff) >= secs || unit === "second") return rtf.format(Math.round(diff / secs), unit);
  }
  return "—";
}

export function fmtDate(iso?: string | null, withTime = true): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return withTime
    ? d.toLocaleString(undefined, { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" });
}

export const fmtNum = (n?: number | null) => (n === undefined || n === null ? "—" : n.toLocaleString());
export const pct = (n?: number | null) => (n === undefined || n === null ? "—" : `${Math.round(n * 100)}%`);

export function duration(a?: string | null, b?: string | null): string {
  if (!a) return "—";
  const ms = (b ? new Date(b) : new Date()).getTime() - new Date(a).getTime();
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60000)} m ${Math.round((ms % 60000) / 1000)} s`;
}

export const TYPE_LABELS: Record<string, string> = {
  ipv4: "IPv4",
  ipv6: "IPv6",
  cidr: "CIDR",
  domain: "Domain",
  url: "URL",
  "ip:port": "IP:Port",
  onion: "Onion",
  asn: "ASN",
  ja3: "JA3",
  ja3s: "JA3S",
};
export const IOC_TYPES = Object.keys(TYPE_LABELS);
