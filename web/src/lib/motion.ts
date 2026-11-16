/**
 * Motion helpers (UI-SYSTEM.md › Motion). Only transform and opacity animate.
 * CSS handles everything simple; these cover what CSS cannot.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties, type DependencyList, type RefObject } from "react";
import { flushSync } from "react-dom";
import { motionOK } from "@/lib/perf";

export const EASE = {
  standard: "cubic-bezier(0.2, 0, 0, 1)",
  emphasized: "cubic-bezier(0.3, 0, 0, 1)",
  exit: "cubic-bezier(0.4, 0, 1, 1)",
  snappy: "linear(0, 0.42 9%, 0.86 20%, 1.04 32%, 1.06 40%, 1.01 56%, 0.995 70%, 1)",
};
export const DUR = { 1: 120, 2: 200, 3: 320, 4: 500 } as const;

/** Route changes: View Transitions API when available and motion is allowed; plain update otherwise
 *  (the keyed `.route-enter` container then animates with CSS). */
export function withViewTransition(update: () => void): void {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } };
  if (doc.startViewTransition && motionOK()) {
    document.documentElement.setAttribute("data-vt", "");
    const t = doc.startViewTransition(() => flushSync(update));
    t.finished.finally(() => document.documentElement.removeAttribute("data-vt"));
    return;
  }
  update();
}

/** "Blur never moves": while anything under `el` runs a finite animation, glass inside it paints
 *  its solid fallback (`.settling`); blur returns when every such animation has finished. */
export function settle(el: Element | null): void {
  if (!el || !("getAnimations" in el)) return;
  const list = el.getAnimations({ subtree: true }).filter((a) => {
    const t = a.effect?.getTiming();
    return t && t.iterations !== Infinity;
  });
  if (!list.length) {
    el.classList.remove("settling");
    return;
  }
  el.classList.add("settling");
  Promise.all(list.map((a) => a.finished.catch(() => undefined))).then(() => el.classList.remove("settling"));
}

export function useSettle(ref: RefObject<Element>, deps: DependencyList): void {
  useLayoutEffect(() => settle(ref.current), deps); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Staggered entrance: the first 12 items rise in 32 ms apart, the rest render instantly. */
export function enterStyle(i: number): { className?: string; style?: CSSProperties } {
  return i < 12 ? { className: "enter", style: { "--i": i } as CSSProperties } : {};
}

/** Count to `value` over 500 ms, writing textContent from rAF — React never re-renders per frame. */
export function useCounter(value: number | null | undefined, format: (n: number) => string): RefObject<HTMLSpanElement> {
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || value == null) return;
    const from = prev.current;
    const to = value;
    prev.current = value;
    if (!motionOK() || from === to) {
      el.textContent = format(to);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / DUR[4]);
      el.textContent = format(from + (to - from) * (1 - Math.pow(1 - k, 4)));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    el.textContent = format(from);
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      el.textContent = format(to);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return ref;
}

/** Queue stream events and flush once per animation frame after `interval` ms (default 250). */
export function createBatcher<T>(onFlush: (items: T[]) => void, interval = 250) {
  let queue: T[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let raf = 0;
  const flush = () => {
    raf = 0;
    timer = undefined;
    if (!queue.length) return;
    const items = queue;
    queue = [];
    onFlush(items);
  };
  return {
    push(item: T) {
      queue.push(item);
      if (timer === undefined && !raf) timer = setTimeout(() => (raf = requestAnimationFrame(flush)), interval);
    },
    flush,
    cancel() {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      queue = [];
      timer = undefined;
      raf = 0;
    },
  };
}

/* ── Spotlight: one document listener + one rAF, writes --mx/--my on the hovered `.spot` only ── */
const spot = { el: null as HTMLElement | null, x: 0, y: 0, raf: 0, installed: false };
function spotFrame() {
  spot.raf = 0;
  const el = spot.el;
  if (!el) return;
  const r = el.getBoundingClientRect();
  el.style.setProperty("--mx", `${Math.round(spot.x - r.left)}px`);
  el.style.setProperty("--my", `${Math.round(spot.y - r.top)}px`);
}
function spotMove(e: PointerEvent) {
  if (e.pointerType !== "mouse") return;
  const el = (e.target as Element | null)?.closest?.<HTMLElement>(".spot") ?? null;
  if (el !== spot.el) {
    spot.el?.classList.remove("is-lit");
    spot.el = el;
    el?.classList.add("is-lit");
  }
  spot.x = e.clientX;
  spot.y = e.clientY;
  if (el && !spot.raf && document.documentElement.dataset.effects === "full") spot.raf = requestAnimationFrame(spotFrame);
}
export function useSpotlight(enabled = true): void {
  useEffect(() => {
    if (!enabled || spot.installed) return;
    spot.installed = true;
    document.addEventListener("pointermove", spotMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", () => {
      spot.el?.classList.remove("is-lit");
      spot.el = null;
    });
  }, [enabled]);
}

/** Memoised number formatter. */
export function useNumberFormat(kind: "number" | "percent" | "compact" = "number"): (n: number) => string {
  return useMemo(() => {
    const nf =
      kind === "percent"
        ? new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 })
        : kind === "compact"
          ? new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 })
          : new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
    return (n: number) => nf.format(n);
  }, [kind]);
}
