import { create } from "zustand";
import { applyEffects, detectPerfTier, hintTier, type Effects, type EffectsPref, type Tier } from "@/lib/perf";

type Theme = "dark" | "light";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* storage unavailable: preference just isn't remembered */
  }
}

interface UiState {
  theme: Theme;
  sidebarCollapsed: boolean;
  mobileNavOpen: boolean;
  paletteOpen: boolean;
  liveConnected: boolean;
  /** Settings › Visual effects (persisted) and what it resolves to on this device. */
  effectsPref: EffectsPref;
  tier: Tier;
  tierMeasured: boolean;
  effects: Effects;
  /** IOC table row density (persisted per browser) */
  density: "compact" | "comfortable";
  setDensity: (d: "compact" | "comfortable") => void;
  setEffectsPref: (p: EffectsPref) => void;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
  toggleSidebar: () => void;
  setMobileNav: (o: boolean) => void;
  setPalette: (o: boolean) => void;
  setLive: (o: boolean) => void;
}

const initialTheme: Theme = read("ca-theme") === "light" ? "light" : "dark";
const storedFx = read("ca-effects");
const initialPref: EffectsPref = storedFx === "full" || storedFx === "reduced" || storedFx === "off" ? storedFx : "auto";
const initialTier = hintTier();
const initialEffects = typeof document !== "undefined" ? applyEffects(initialPref, initialTier) : "full";

export const useUi = create<UiState>((set, get) => ({
  theme: initialTheme,
  sidebarCollapsed: read("ca-sidebar") === "1",
  mobileNavOpen: false,
  paletteOpen: false,
  liveConnected: false,
  effectsPref: initialPref,
  tier: initialTier,
  tierMeasured: false,
  effects: initialEffects,
  density: read("ca-density") === "comfortable" ? "comfortable" : "compact",
  setDensity: (density) => {
    write("ca-density", density);
    set({ density });
  },
  setEffectsPref: (effectsPref) => {
    write("ca-effects", effectsPref);
    set({ effectsPref, effects: applyEffects(effectsPref, get().tier) });
  },
  setTheme: (theme) => {
    document.documentElement.dataset.theme = theme;
    write("ca-theme", theme);
    set({ theme });
  },
  toggleTheme: () => get().setTheme(get().theme === "dark" ? "light" : "dark"),
  toggleSidebar: () => {
    const v = !get().sidebarCollapsed;
    write("ca-sidebar", v ? "1" : "0");
    set({ sidebarCollapsed: v });
  },
  setMobileNav: (mobileNavOpen) => set({ mobileNavOpen }),
  setPalette: (paletteOpen) => set({ paletteOpen }),
  setLive: (liveConnected) => set({ liveConnected }),
}));

/** Refine the tier by measuring 60 frames once the page has loaded (Auto follows it). */
export function startPerfProbe(): void {
  const run = () =>
    detectPerfTier().then((tier) => {
      const s = useUi.getState();
      useUi.setState({ tier, tierMeasured: true, effects: applyEffects(s.effectsPref, tier) });
    });
  if (document.readyState === "complete") run();
  else window.addEventListener("load", run, { once: true });
}
