import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { GuestSession } from "../api/client";
import { setGuestToken } from "../api/client";

const STORAGE_KEY = "hotelos.guest.session";

type GuestSessionContextValue = {
  session: GuestSession | null;
  setSession: (session: GuestSession) => void;
  signOut: () => void;
};

const GuestSessionContext = createContext<GuestSessionContextValue | null>(null);

function readStoredSession(): GuestSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as GuestSession;
  } catch {
    return null;
  }
}

export function GuestSessionProvider({ children }: { children: ReactNode }) {
  const [session, setSessionState] = useState<GuestSession | null>(() => {
    const restored = readStoredSession();
    // Re-hydrate the module-level guest token from a restored session so
    // x-guest-token is sent again after a page reload.
    setGuestToken(restored?.token ?? null);
    return restored;
  });

  const setSession = useCallback((next: GuestSession) => {
    setSessionState(next);
    setGuestToken(next.token ?? null);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // ignore storage failures (private mode, quota, etc.)
    }
  }, []);

  const signOut = useCallback(() => {
    setSessionState(null);
    setGuestToken(null);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }, []);

  // Keep the session in sync across tabs.
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key !== STORAGE_KEY) return;
      const next = event.newValue ? (JSON.parse(event.newValue) as GuestSession) : null;
      setSessionState(next);
      setGuestToken(next?.token ?? null);
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const value = useMemo<GuestSessionContextValue>(() => ({ session, setSession, signOut }), [session, setSession, signOut]);

  return <GuestSessionContext.Provider value={value}>{children}</GuestSessionContext.Provider>;
}

export function useGuestSession(): GuestSessionContextValue {
  const ctx = useContext(GuestSessionContext);
  if (!ctx) throw new Error("useGuestSession must be used inside <GuestSessionProvider>.");
  return ctx;
}
