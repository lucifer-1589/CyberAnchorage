import { create } from "zustand";

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
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
  toggleSidebar: () => void;
  setMobileNav: (o: boolean) => void;
  setPalette: (o: boolean) => void;
  setLive: (o: boolean) => void;
}

const initialTheme: Theme = read("ca-theme") === "light" ? "light" : "dark";

export const useUi = create<UiState>((set, get) => ({
  theme: initialTheme,
  sidebarCollapsed: read("ca-sidebar") === "1",
  mobileNavOpen: false,
  paletteOpen: false,
  liveConnected: false,
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
