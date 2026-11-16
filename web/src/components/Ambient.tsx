import { useEffect, useRef } from "react";

/**
 * Ambient backdrop: three pre-rendered radial orbs that drift by transform only.
 * They drift only while the user is idle — a moving backdrop forces every blurred panel
 * above it to re-blur each frame — so any input pauses them (a class toggle, no React
 * render) and they resume after 2 s of quiet. Paused in hidden tabs; static at Reduced/Off.
 */
export function Ambient() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    const sync = () => el?.classList.toggle("is-paused", busy || document.hidden);
    const poke = () => {
      if (!busy) {
        busy = true;
        sync();
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        busy = false;
        sync();
      }, 2000);
    };
    const evs = ["pointermove", "pointerdown", "wheel", "keydown", "touchstart", "scroll"] as const;
    evs.forEach((e) => window.addEventListener(e, poke, { passive: true, capture: true }));
    document.addEventListener("visibilitychange", sync);
    return () => {
      clearTimeout(timer);
      evs.forEach((e) => window.removeEventListener(e, poke, { capture: true }));
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);
  return (
    <div ref={ref} className="ambient" aria-hidden>
      <div className="orb orb-1" />
      <div className="orb orb-2" />
      <div className="orb orb-3" />
    </div>
  );
}
