import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuth } from "@/store/auth";
import { useUi } from "@/store/ui";

export interface LiveEvent {
  type: string;
  ts: string;
  data: Record<string, any>;
}

type Listener = (e: LiveEvent) => void;
const listeners = new Set<Listener>();

export function onLive(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** One WebSocket per session; reconnects with backoff; invalidates queries on server events. */
export function useLiveConnection() {
  const token = useAuth((s) => s.token);
  const qc = useQueryClient();
  const setLive = useUi((s) => s.setLive);

  useEffect(() => {
    if (!token) return;
    let ws: WebSocket | null = null;
    let stopped = false;
    let attempt = 0;
    let timer: number | undefined;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/api/ws?token=${encodeURIComponent(token)}`);
      ws.onopen = () => {
        attempt = 0;
        setLive(true);
      };
      ws.onclose = () => {
        setLive(false);
        if (stopped) return;
        attempt += 1;
        timer = window.setTimeout(connect, Math.min(30000, 1000 * 2 ** attempt));
      };
      ws.onmessage = (m) => {
        let ev: LiveEvent;
        try {
          ev = JSON.parse(m.data);
        } catch {
          return;
        }
        if (ev.type === "ping") return;
        listeners.forEach((l) => l(ev));
        handle(ev);
      };
    };

    const handle = (ev: LiveEvent) => {
      switch (ev.type) {
        case "sync.queued":
        case "sync.started":
          qc.invalidateQueries({ queryKey: ["sync"] });
          if (ev.type === "sync.started") toast.info(`Sync #${ev.data.run_id} started (${ev.data.mode})`);
          break;
        case "sync.progress":
          qc.setQueryData(["sync", "progress"], ev.data);
          break;
        case "sync.finished":
          qc.invalidateQueries();
          toast.success(`Sync #${ev.data.id} ${ev.data.status}: ${ev.data.new} new, ${ev.data.updated} updated`);
          break;
        case "flags.updated":
          qc.invalidateQueries({ queryKey: ["flags"] });
          qc.invalidateQueries({ queryKey: ["iocs"] });
          qc.invalidateQueries({ queryKey: ["overview"] });
          if (ev.data.new_flags > 0) toast.warning(`${ev.data.new_flags} new flag${ev.data.new_flags > 1 ? "s" : ""}`);
          break;
        case "detection.created":
          qc.invalidateQueries({ queryKey: ["detections"] });
          break;
        case "rule.changed":
          qc.invalidateQueries({ queryKey: ["rules"] });
          break;
      }
    };

    connect();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      ws?.close();
      setLive(false);
    };
  }, [token, qc, setLive]);
}
