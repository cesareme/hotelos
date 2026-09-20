import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { GuestSession } from "../api/client";
import { setGuestToken } from "../api/client";

// Tanda CHK · W4-C (diseño §4a paso 2 y §8): la sesión del huésped vive en
// `window.sessionStorage` — sobrevive a una recarga pero se borra al cerrar la
// pestaña — y nunca en un almacén persistente del navegador (el token del portal es sensible). En modo
// kiosco (`persist: false`) no se escribe en ningún almacén: la tablet es
// compartida y el reinicio por inactividad (kiosk/kiosk-mode.ts) limpia la
// memoria.
const STORAGE_KEY = "hotelos.guest.session";

type GuestSessionContextValue = {
  session: GuestSession | null;
  setSession: (session: GuestSession) => void;
  signOut: () => void;
  /** false en modo kiosco: la sesión solo vive en memoria. */
  persist: boolean;
};

const GuestSessionContext = createContext<GuestSessionContextValue | null>(null);

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function readStoredSession(): GuestSession | null {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as GuestSession;
  } catch {
    return null;
  }
}

function writeStoredSession(session: GuestSession | null): void {
  try {
    const store = storage();
    if (!store) return;
    if (session) store.setItem(STORAGE_KEY, JSON.stringify(session));
    else store.removeItem(STORAGE_KEY);
  } catch {
    // ignore storage failures (private mode, quota, etc.)
  }
}

export function GuestSessionProvider({ children, persist = true }: { children: ReactNode; persist?: boolean }) {
  const [session, setSessionState] = useState<GuestSession | null>(() => {
    if (!persist) {
      // Kiosk: never restore anything left by a previous guest on this tab.
      writeStoredSession(null);
      setGuestToken(null);
      return null;
    }
    const restored = readStoredSession();
    // Re-hydrate the module-level guest token from a restored session so
    // x-guest-token is sent again after a page reload within the same tab.
    setGuestToken(restored?.token ?? null);
    return restored;
  });

  const setSession = useCallback(
    (next: GuestSession) => {
      setSessionState(next);
      setGuestToken(next.token ?? null);
      if (persist) writeStoredSession(next);
    },
    [persist]
  );

  const signOut = useCallback(() => {
    setSessionState(null);
    setGuestToken(null);
    writeStoredSession(null);
  }, []);

  const value = useMemo<GuestSessionContextValue>(() => ({ session, setSession, signOut, persist }), [session, setSession, signOut, persist]);

  return <GuestSessionContext.Provider value={value}>{children}</GuestSessionContext.Provider>;
}

export function useGuestSession(): GuestSessionContextValue {
  const ctx = useContext(GuestSessionContext);
  if (!ctx) throw new Error("useGuestSession must be used inside <GuestSessionProvider>.");
  return ctx;
}

export { STORAGE_KEY as GUEST_SESSION_STORAGE_KEY };
