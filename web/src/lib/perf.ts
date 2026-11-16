/**
 * Performance tier + Visual effects (UI-SYSTEM.md › Glass tiers).
 *
 *   high   → Full     (14/22 px blur, drifting orbs, spotlight, conic edges)
 *   medium → Reduced  (8 px blur everywhere, static orbs, no spotlight/conic)
 *   low    → Off      (no backdrop-filter, no non-essential animation)
 *
 * The tier starts from hardwareConcurrency/deviceMemory and is refined by measuring
 * 60 frames after load. The user's preference (Auto/Full/Reduced/Off) is applied as
 * html[data-effects]; switching only changes paint, never layout.
 */
export type Tier = "high" | "medium" | "low";
export type EffectsPref = "auto" | "full" | "reduced" | "off";
export type Effects = "full" | "reduced" | "off";

const ORDER: Tier[] = ["low", "medium", "high"];

export function hintTier(): Tier {
  if (typeof navigator === "undefined") return "high";
  const cores = navigator.hardwareConcurrency || 4;
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (cores <= 2 || (mem !== undefined && mem <= 2)) return "low";
  if (cores < 6 || (mem !== undefined && mem < 6)) return "medium";
  return "high";
}

function measureFrames(n: number): Promise<{ median: number; p90: number } | null> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "undefined") return resolve(null);
    const times: number[] = [];
    let last = 0;
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      resolve(null);
    }, 2500);
    const tick = (t: number) => {
      if (done) return;
      if (last) times.push(t - last);
      last = t;
      if (times.length >= n) {
        clearTimeout(timer);
        done = true;
        times.sort((a, b) => a - b);
        resolve({ median: times[times.length >> 1], p90: times[Math.floor(times.length * 0.9)] });
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** Hardware hint, then 60 measured frames: the lower of the two wins. */
export async function detectPerfTier(): Promise<Tier> {
  const hint = hintTier();
  const f = await measureFrames(60);
  if (!f) return hint;
  // 60 Hz budget is 16.7 ms: a median over 26 ms or p90 over 40 ms means the device is struggling.
  const frameTier: Tier = f.median > 26 || f.p90 > 40 ? "low" : f.median > 18.5 || f.p90 > 26 ? "medium" : "high";
  return ORDER[Math.min(ORDER.indexOf(hint), ORDER.indexOf(frameTier))];
}

function mq(q: string): boolean {
  try {
    return window.matchMedia(q).matches;
  } catch {
    return false;
  }
}

export function resolveEffects(pref: EffectsPref, tier: Tier): Effects {
  if (pref !== "auto") return pref;
  if (mq("(prefers-reduced-transparency: reduce)")) return "off";
  return tier === "high" ? "full" : tier === "medium" ? "reduced" : "off";
}

export function applyEffects(pref: EffectsPref, tier: Tier): Effects {
  const effects = resolveEffects(pref, tier);
  const el = document.documentElement;
  el.dataset.effects = effects;
  el.dataset.tier = tier;
  return effects;
}

/** False at Effects: Off or with prefers-reduced-motion. */
export function motionOK(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.dataset.effects !== "off" && !mq("(prefers-reduced-motion: reduce)");
}
