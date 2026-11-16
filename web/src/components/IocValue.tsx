import { useState } from "react";
import { Copy, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { post } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useAuth } from "@/store/auth";
import { Tip } from "@/components/ui/overlays";

/**
 * IOC values are always shown defanged (hxxp, [.]). Revealing / copying the live value is a deliberate,
 * audited action available to analysts and admins only.
 */
export function IocValue({ id, value, className, actions = true }: { id: number; value: string; className?: string; actions?: boolean }) {
  const canReveal = useAuth((s) => s.can("analyst"));
  const [raw, setRaw] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function fetchRaw(): Promise<string | null> {
    if (raw) return raw;
    setBusy(true);
    try {
      const r = await post<{ value: string }>(`/iocs/${id}/reveal`);
      setRaw(r.value);
      return r.value;
    } catch (e) {
      toast.error((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function copy(live: boolean) {
    const text = live ? await fetchRaw() : value;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast.success(live ? "Live value copied — handle with care" : "Defanged value copied");
    } catch {
      toast.error("Clipboard unavailable");
    }
  }

  return (
    <span className={cn("group inline-flex min-w-0 max-w-full items-center gap-1", className)}>
      <span className={cn("mono truncate", raw ? "text-danger-text" : "text-fg")} title={raw ?? value}>
        {raw ?? value}
      </span>
      {actions && (
        <span className="inline-flex shrink-0 items-center opacity-70 transition group-hover:opacity-100">
          <Tip content="Copy defanged">
            <button className="grid size-6 place-items-center rounded text-fg-subtle hover:text-fg" onClick={(e) => (e.stopPropagation(), copy(false))} aria-label="Copy defanged value">
              <Copy className="size-3.5" />
            </button>
          </Tip>
          {canReveal && (
            <Tip content={raw ? "Hide live value" : "Reveal live value (audited)"}>
              <button
                className="grid size-6 place-items-center rounded text-fg-subtle hover:text-fg disabled:opacity-50"
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  if (raw) setRaw(null);
                  else void fetchRaw();
                }}
                aria-label={raw ? "Hide live value" : "Reveal live value"}
              >
                {raw ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              </button>
            </Tip>
          )}
          {canReveal && raw && (
            <Tip content="Copy live value">
              <button className="grid size-6 place-items-center rounded text-danger-text hover:opacity-80" onClick={(e) => (e.stopPropagation(), copy(true))} aria-label="Copy live value">
                <Copy className="size-3.5" />
              </button>
            </Tip>
          )}
        </span>
      )}
    </span>
  );
}
