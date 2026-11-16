import { create } from "zustand";
import type { Role, User } from "@/lib/types";

const RANK: Record<Role, number> = { viewer: 1, analyst: 2, admin: 3 };

interface AuthState {
  token: string | null; // kept in memory only; the refresh token is an HttpOnly cookie
  user: User | null;
  ready: boolean;
  setSession: (token: string, user: User) => void;
  setReady: () => void;
  clear: () => void;
  can: (role: Role) => boolean;
}

export const useAuth = create<AuthState>((set, get) => ({
  token: null,
  user: null,
  ready: false,
  setSession: (token, user) => set({ token, user, ready: true }),
  setReady: () => set({ ready: true }),
  clear: () => set({ token: null, user: null, ready: true }),
  can: (role) => {
    const u = get().user;
    return !!u && RANK[u.role] >= RANK[role];
  },
}));
