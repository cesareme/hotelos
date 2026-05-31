/**
 * Sprint 37a — Auth context for the staff mobile MVP.
 *
 * Provides accessToken, user, propertyId, signIn, signOut and an api client
 * bound to the current token. Boot-loads the persisted session from
 * authStorage so the user stays signed in across app restarts.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { ApiError, createApiClient, resolveBaseUrl } from "../api/client";
import { createEndpoints, type Endpoints, type LoginInput } from "../api/endpoints";
import { authStorage, type StoredSession } from "./storage";

export const DEFAULT_PROPERTY_ID = "prop_123";

type AuthState =
  | { status: "loading" }
  | { status: "signed-out"; lastError?: string }
  | { status: "signed-in"; session: StoredSession };

type AuthContextValue = {
  state: AuthState;
  user: StoredSession["user"];
  propertyId: string;
  accessToken: string | null;
  api: Endpoints;
  signIn: (input: LoginInput) => Promise<void>;
  signOut: () => Promise<void>;
  storageBackend: string;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const tokenRef = useRef<string | null>(null);

  // Keep tokenRef in sync with state so the api client can read the latest
  // value without forcing a re-render of every consumer.
  useEffect(() => {
    tokenRef.current = state.status === "signed-in" ? state.session.accessToken : null;
  }, [state]);

  const signOut = useCallback(async () => {
    tokenRef.current = null;
    await authStorage.clear();
    setState({ status: "signed-out" });
  }, []);

  const api = useMemo(() => {
    const client = createApiClient({
      baseUrl: resolveBaseUrl(),
      getToken: () => tokenRef.current,
      onUnauthorized: () => {
        // Fire and forget — clears storage and bounces to Login.
        void signOut();
      }
    });
    return createEndpoints(client);
  }, [signOut]);

  // Boot-load persisted session.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const session = await authStorage.load();
      if (cancelled) return;
      if (session?.accessToken) {
        setState({ status: "signed-in", session });
      } else {
        setState({ status: "signed-out" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(
    async (input: LoginInput) => {
      try {
        const response = await api.login(input);
        const accessToken = response.accessToken ?? response.token;
        if (!accessToken) {
          throw new Error("Login response did not include a token.");
        }
        const session: StoredSession = {
          accessToken,
          refreshToken: response.refreshToken,
          user: response.user ?? { id: "unknown", email: input.email },
          property: response.property ?? { id: DEFAULT_PROPERTY_ID }
        };
        await authStorage.save(session);
        tokenRef.current = accessToken;
        setState({ status: "signed-in", session });
      } catch (error) {
        const message =
          error instanceof ApiError
            ? `Sign-in failed (${error.status}).`
            : error instanceof Error
              ? error.message
              : "Sign-in failed.";
        setState({ status: "signed-out", lastError: message });
        throw error;
      }
    },
    [api]
  );

  const value = useMemo<AuthContextValue>(() => {
    const session = state.status === "signed-in" ? state.session : null;
    return {
      state,
      user: session?.user,
      propertyId: session?.property?.id ?? DEFAULT_PROPERTY_ID,
      accessToken: session?.accessToken ?? null,
      api,
      signIn,
      signOut,
      storageBackend: authStorage.backendName
    };
  }, [api, signIn, signOut, state]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth must be used inside <AuthProvider>");
  }
  return value;
}
