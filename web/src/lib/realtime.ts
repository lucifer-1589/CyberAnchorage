import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export interface RtStatus {
  event_source: string;
  simulator: boolean;
  ingest_token_configured?: boolean;
  index: { exact: number; cidr: number; suffix: number; rules: number; built_at: string; build_ms: number };
}

export function useRealtimeStatus() {
  return useQuery({ queryKey: ["realtime"], queryFn: () => api<RtStatus>("/realtime/status"), refetchInterval: 30_000 });
}

/** Real-time detection surfaces (nav item, KPI tile, drawer row) only appear when something can actually
 *  produce events: an event source (incl. the labelled simulator) or a configured ingest token.
 *  Level 1 ships the seam only, so by default they stay hidden. */
export function useRealtimeVisible(): boolean {
  const { data } = useRealtimeStatus();
  return !!data && (data.event_source !== "none" || !!data.ingest_token_configured);
}
