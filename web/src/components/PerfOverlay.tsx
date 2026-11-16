import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { useUi } from "@/store/ui";

interface Stats {
  fps: number;
  worst: number;
  long: number;
  longMs: number;
  blur: number;
  g2: number;
  frames: number[];
}

/** Visible blurred surfaces (budget 6) and G2 surfaces (budget 1). */
function countBlur(): [number, number] {
  let n = 0;
  let g2 = 0;
  const vw = innerWidth;
  const vh = innerHeight;
  document.querySelectorAll<HTMLElement>(".glass,.glass-strong").forEach((el) => {
    const cs = getComputedStyle(el);
    const bf = cs.backdropFilter || (cs as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter;
    if (!bf || bf === "none") return;
    const r = el.getBoundingClientRect();
    if (!r.width || r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) return;
    n++;
    if (el.classList.contains("glass-strong")) g2++;
  });
  return [n, g2];
}

/** Dev-only overlay (`?perf=1`): fps, worst frame, long tasks (10 s), blurred surfaces, G2 count. */
export function PerfOverlay() {
  const effects = useUi((s) => s.effects);
  const tier = useUi((s) => s.tier);
  const [st, set] = useState<Stats>({ fps: 0, worst: 0, long: 0, longMs: 0, blur: 0, g2: 0, frames: [] });

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const frames: number[] = [];
    let acc: number[] = [];
    let longs: [number, number][] = [];
    let tick = 0;
    const loop = (t: number) => {
      const d = t - last;
      last = t;
      frames.push(d);
      if (frames.length > 40) frames.shift();
      acc.push(d);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    let obs: PerformanceObserver | null = null;
    try {
      obs = new PerformanceObserver((l) => l.getEntries().forEach((e) => longs.push([performance.now(), e.duration])));
      obs.observe({ type: "longtask", buffered: true });
    } catch {
      /* longtask unsupported (Safari/Firefox) */
    }
    const iv = setInterval(() => {
      const now = performance.now();
      longs = longs.filter((x) => now - x[0] < 10_000);
      const sum = acc.reduce((a, b) => a + b, 0);
      const fps = acc.length ? (1000 * acc.length) / sum : 0;
      const worst = Math.max(0, ...acc);
      acc = [];
      const b = tick++ % 2 === 0 ? countBlur() : null;
      set((o) => ({ fps, worst, long: longs.length, longMs: longs.reduce((a, x) => a + x[1], 0), blur: b ? b[0] : o.blur, g2: b ? b[1] : o.g2, frames: frames.slice() }));
    }, 500);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(iv);
      obs?.disconnect();
    };
  }, []);

  const row = (label: string, value: string, bad: boolean) => (
    <>
      <span>{label}</span>
      <b className={cn("text-right font-semibold", bad ? "text-danger-text" : "text-primary-text")}>{value}</b>
    </>
  );
  return (
    <aside
      aria-label="Performance overlay"
      className="fixed bottom-3 left-3 z-perf grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 rounded-lg border border-control-border bg-[rgb(var(--glass-solid)/var(--glass-solid-a))] px-3 py-2.5 font-mono text-[11px] tabular-nums text-fg-muted"
    >
      {row("fps", st.fps.toFixed(0), st.fps < 55)}
      {row("worst frame", `${st.worst.toFixed(1)} ms`, st.worst > 33)}
      {row("long tasks 10s", `${st.long} · ${st.longMs.toFixed(0)} ms`, st.long > 0)}
      {row("blurred surfaces", `${st.blur} / 6`, st.blur > 6)}
      {row("G2 on screen", `${st.g2} / 1`, st.g2 > 1)}
      {row("effects", `${effects} · ${tier}`, false)}
      <div className="col-span-2 mt-1 flex h-6 items-end gap-px" aria-hidden>
        {st.frames.map((d, i) => (
          <i key={i} className={cn("h-full flex-1 origin-bottom rounded-t-[1px]", d > 20 ? "bg-danger" : "bg-primary")} style={{ transform: `scaleY(${Math.min(1, d / 50).toFixed(2)})` }} />
        ))}
      </div>
    </aside>
  );
}
