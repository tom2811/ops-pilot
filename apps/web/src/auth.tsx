import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, post, setCsrfToken } from "./api.js";
import type { Membership, User } from "./types.js";

type MeResponse = { user: User; memberships: Membership[]; csrfToken: string | null };

type AuthState = {
  user: User | null;
  memberships: Membership[];
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

const SESSION_HINT_KEY = "opspilot.session_active";

export function hasSessionHint(): boolean {
  try {
    return localStorage.getItem(SESSION_HINT_KEY) === "1";
  } catch {
    return false;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api<MeResponse>("/auth/me")
      .then((me) => {
        if (cancelled) return;
        try {
          localStorage.setItem(SESSION_HINT_KEY, "1");
        } catch {
          /* ignore */
        }
        setCsrfToken(me.csrfToken);
        setUser(me.user);
        setMemberships(me.memberships);
      })
      .catch(() => {
        if (!cancelled) {
          try {
            localStorage.removeItem(SESSION_HINT_KEY);
          } catch {
            /* ignore */
          }
          setUser(null);
          setMemberships([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const me = await post<MeResponse>("/auth/login", { email, password });
    try {
      localStorage.setItem(SESSION_HINT_KEY, "1");
    } catch {
      /* ignore */
    }
    setCsrfToken(me.csrfToken);
    setUser(me.user);
    setMemberships(me.memberships);
  }, []);

  const logout = useCallback(async () => {
    try {
      localStorage.removeItem(SESSION_HINT_KEY);
    } catch {
      /* ignore */
    }
    await post("/auth/logout", {});
    setCsrfToken(null);
    setUser(null);
    setMemberships([]);
  }, []);

  const value = useMemo(
    () => ({ user, memberships, loading, login, logout }),
    [user, memberships, loading, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
