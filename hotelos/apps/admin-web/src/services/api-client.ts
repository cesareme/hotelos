import { clearSession, getToken as readStoredToken, getUser } from "./auth-storage";
import { logBreadcrumb } from "../lib/breadcrumb";

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

const IS_PRODUCTION = (import.meta.env.MODE ?? import.meta.env.NODE_ENV) === "production";

let cachedToken: string | null = null;
let cachedPermissions: string[] | null = null;
let inFlightLogin: Promise<string> | null = null;

// Demo/dev fallback: when there's no logged-in user we transparently log in
// with the seeded demo account so the API can serve mock data while the UI
// is being built. This must NOT run in production builds — production always
// requires real authentication via LoginScreen.
async function demoLogin(): Promise<string> {
  if (IS_PRODUCTION) {
    throw new Error("Sesión expirada. Inicia sesión de nuevo.");
  }
  const response = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "reception@example.com", password: "hotelos-demo", deviceId: "dev_admin_web" })
  });
  if (!response.ok) throw new Error(`Login failed: HTTP ${response.status}`);
  const data = (await response.json()) as { token: string; user?: { permissions?: string[] } };
  cachedPermissions = data.user?.permissions ?? [];
  return data.token;
}

async function getToken(): Promise<string> {
  // 1. Prefer the JWT from auth-storage (real user login).
  const stored = readStoredToken();
  if (stored) {
    cachedToken = stored;
    // Permissions live on the stored user record.
    if (!cachedPermissions) {
      const user = getUser();
      cachedPermissions = user?.permissions ?? null;
    }
    return stored;
  }

  // 2. Reuse a cached demo token if we already obtained one this session.
  if (cachedToken) return cachedToken;

  // 3. Fall back to the demo login (development only).
  if (!inFlightLogin) {
    inFlightLogin = demoLogin().then((t) => {
      cachedToken = t;
      inFlightLogin = null;
      return t;
    });
  }
  return inFlightLogin;
}

/** Permissions of the currently logged-in user (used for nav gating). */
export async function getCurrentUserPermissions(): Promise<string[]> {
  // Real user's permissions live in auth-storage.
  const user = getUser();
  if (user?.permissions) {
    cachedPermissions = user.permissions;
    return user.permissions;
  }
  if (cachedPermissions) return cachedPermissions;
  await getToken(); // demoLogin() populates cachedPermissions as a side effect
  return cachedPermissions ?? [];
}

export type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
};

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = await getToken();
  const url = new URL(path.startsWith("http") ? path : `${API_BASE}${path}`);
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  const method = options.method ?? "GET";
  // PII-safe: solo método y path (sin query string ni body) para evitar tokens
  // o datos personales en breadcrumbs.
  logBreadcrumb(`api.${method}.${path}`, "api", { method, path });
  const response = await fetch(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: options.signal
  });
  logBreadcrumb(`api.${method}.${path}`, "api", { method, path, status: response.status });
  if (response.status === 401) {
    cachedToken = null;
    cachedPermissions = null;
    inFlightLogin = null;
    // Clear stored session + notify listeners so AuthGate redirects to login.
    clearSession();
    throw new Error("Authentication expired. Refresh the page.");
  }
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try { message = (JSON.parse(text) as { message?: string }).message ?? text; } catch { /* keep raw */ }
    throw new Error(message || `HTTP ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function apiBase(): string { return API_BASE; }
