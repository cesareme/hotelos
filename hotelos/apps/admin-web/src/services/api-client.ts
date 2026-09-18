import { clearSession, getToken as readStoredToken, getUser } from "./auth-storage";
import { getActivePropertyId } from "./activeProperty";
import { logBreadcrumb } from "../lib/breadcrumb";

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

const IS_PRODUCTION = (import.meta.env.MODE ?? import.meta.env.NODE_ENV) === "production";

let cachedToken: string | null = null;
let cachedPermissions: string[] | null = null;
let inFlightLogin: Promise<string> | null = null;

// ---------------------------------------------------------------------------
// Forced password rotation (Tanda 3 · CFG-P1-6)
//
// A session opened with a temporary password gets 403 + details.code
// "PASSWORD_CHANGE_REQUIRED" on every route outside the API allowlist. Instead
// of N red cards, apiRequest records the state here and fires a window event
// so auth/PublicAuthRoutes.tsx can swap the shell for ChangePasswordScreen.
// The state is module-level (not persisted): a reload derives it again from
// the stored user (`mustChangePassword`) or from the next 403.
// ---------------------------------------------------------------------------

export const PASSWORD_CHANGE_REQUIRED_CODE = "PASSWORD_CHANGE_REQUIRED";
export const PASSWORD_CHANGE_REQUIRED_EVENT = "hotelos-password-change-required";

let passwordChangeRequired = false;

function isPasswordChangeRequiredDetails(details: unknown): boolean {
  return (
    typeof details === "object" &&
    details !== null &&
    (details as { code?: unknown }).code === PASSWORD_CHANGE_REQUIRED_CODE
  );
}

function markPasswordChangeRequired(): void {
  if (passwordChangeRequired) return;
  passwordChangeRequired = true;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(PASSWORD_CHANGE_REQUIRED_EVENT));
  }
}

/** True once the API has answered PASSWORD_CHANGE_REQUIRED for this session. */
export function isPasswordChangeRequired(): boolean {
  return passwordChangeRequired;
}

/** Reset after a successful change (the API revokes the session anyway) or a logout. */
export function clearPasswordChangeRequired(): void {
  passwordChangeRequired = false;
}

/** Subscribe to the rotation requirement; returns the unsubscribe function. */
export function onPasswordChangeRequired(callback: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handler = () => callback();
  window.addEventListener(PASSWORD_CHANGE_REQUIRED_EVENT, handler);
  return () => window.removeEventListener(PASSWORD_CHANGE_REQUIRED_EVENT, handler);
}

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

// ---------------------------------------------------------------------------
// Active-property scope header (Tanda 8a · RBAC por departamento, design §6.2)
//
// The API resolves the permissions of every request for the property it acts
// on: the `:propertyId` param, the entity, or — for routes without a property
// in the URL (`/reservations/:id`, `/approvals`, `/rbac/*`…) — the
// `x-property-id` header the client sends from the ACTIVE property
// (services/activeProperty.ts). Sent by apiRequest and apiRequestBlob when the
// stored id is a valid identifier; never by publicRequest (screens/auth) and
// never on the session routes that must keep working while the stored
// selection is stale (`/users/me`, `/users/me/properties`, `/auth/*`): the
// AuthGate repoints the property from `/users/me/properties` BEFORE the shell
// mounts, and a stale header there would answer the opaque 404 forever.
// ---------------------------------------------------------------------------

export const ACTIVE_PROPERTY_HEADER = "x-property-id";

/** Same shape the API accepts (server.ts PROPERTY_ID_PATTERN). */
const PROPERTY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Session routes resolved without the active property (prefix match, like the API's allowlists). */
const SCOPE_HEADER_EXEMPT_PREFIXES: readonly string[] = ["/users/me", "/auth"];

function scopeHeaderExempt(path: string): boolean {
  const pathname = path.startsWith("http") ? new URL(path).pathname : path.split(/[?#]/)[0] ?? "";
  return SCOPE_HEADER_EXEMPT_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/** `x-property-id` for a request path: the active property when valid, nothing on the exempt session routes. */
export function activePropertyHeader(path: string): Record<string, string> {
  if (scopeHeaderExempt(path)) return {};
  const propertyId = getActivePropertyId();
  return PROPERTY_ID_PATTERN.test(propertyId) ? { [ACTIVE_PROPERTY_HEADER]: propertyId } : {};
}

export type RequestOptions = {
  /** Surface a 401 as an ApiError instead of clearing the session (change-password form). */
  keepSessionOn401?: boolean;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
};

/**
 * Error thrown by apiRequest for non-2xx responses. Carries the HTTP status
 * (and the API correlationId when the body is the errorHandler envelope) so
 * callers can branch on it — e.g. useApiData distinguishes the opaque tenancy
 * 404 "Propiedad no encontrada." from any other failure without regexes.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly correlationId?: string;
  /** Machine-readable payload the API attaches to typed 4xx errors (e.g. { code: "BALANCE_DUE", balanceDue }). */
  readonly details?: unknown;

  constructor(message: string, status: number, correlationId?: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.correlationId = correlationId;
    this.details = details;
  }
}

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
      ...activePropertyHeader(path),
      ...(options.body ? { "Content-Type": "application/json" } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: options.signal
  });
  logBreadcrumb(`api.${method}.${path}`, "api", { method, path, status: response.status });
  if (response.status === 401 && options.keepSessionOn401) {
    const text = await response.text();
    let message = text;
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? text;
    } catch {
      /* raw body */
    }
    throw new ApiError(message || "No autorizado.", 401);
  }
  if (response.status === 401) {
    cachedToken = null;
    cachedPermissions = null;
    inFlightLogin = null;
    // Clear stored session + notify listeners so AuthGate redirects to login.
    passwordChangeRequired = false;
    clearSession();
    throw new ApiError("Authentication expired. Refresh the page.", 401);
  }
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    let correlationId: string | undefined;
    let details: unknown;
    try {
      const parsed = JSON.parse(text) as { message?: string; correlationId?: string; details?: unknown };
      message = parsed.message ?? text;
      correlationId = parsed.correlationId;
      details = parsed.details;
    } catch {
      /* keep raw body as the message */
    }
    if (response.status === 403 && isPasswordChangeRequiredDetails(details)) {
      markPasswordChangeRequired();
    }
    throw new ApiError(message || `HTTP ${response.status}`, response.status, correlationId, details);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function apiBase(): string { return API_BASE; }

// ---------------------------------------------------------------------------
// Binary / text downloads (Finanzas · Tanda 6): invoice PDFs, AEAT summaries,
// journal and ledger CSV, statements in PDF/XLSX/CSV. Same session, tenant and
// 401 handling as apiRequest; the body is returned as a Blob instead of JSON.
// The caller materialises the download (object URL) and names the file with
// `contentDisposition` (services/finance-contracts.ts · downloadFilename).
// ---------------------------------------------------------------------------
export type BlobRequestOptions = Pick<RequestOptions, "query" | "signal"> & {
  method?: "GET" | "POST";
  body?: unknown;
};

export type BlobResponse = {
  blob: Blob;
  status: number;
  contentType: string;
  /** Raw `Content-Disposition` header (`attachment; filename="diario.csv"`), or null. */
  contentDisposition: string | null;
};

async function readApiError(response: Response): Promise<ApiError> {
  const text = await response.text();
  let message = text;
  let correlationId: string | undefined;
  let details: unknown;
  try {
    const parsed = JSON.parse(text) as { message?: string; correlationId?: string; details?: unknown };
    message = parsed.message ?? text;
    correlationId = parsed.correlationId;
    details = parsed.details;
  } catch {
    /* keep raw body as the message */
  }
  if (response.status === 403 && isPasswordChangeRequiredDetails(details)) {
    markPasswordChangeRequired();
  }
  return new ApiError(message || `HTTP ${response.status}`, response.status, correlationId, details);
}

export async function apiRequestBlob(path: string, options: BlobRequestOptions = {}): Promise<BlobResponse> {
  const token = await getToken();
  const url = new URL(path.startsWith("http") ? path : `${API_BASE}${path}`);
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  const method = options.method ?? "GET";
  logBreadcrumb(`api.${method}.${path}`, "api", { method, path });
  const response = await fetch(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...activePropertyHeader(path),
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
    passwordChangeRequired = false;
    clearSession();
    throw new ApiError("Authentication expired. Refresh the page.", 401);
  }
  if (!response.ok) throw await readApiError(response);
  const blob = await response.blob();
  return {
    blob,
    status: response.status,
    contentType: response.headers.get("Content-Type") ?? blob.type,
    contentDisposition: response.headers.get("Content-Disposition")
  };
}

// ---------------------------------------------------------------------------
// Public requests (no session, no demo fallback): invitations, password reset.
// Kept here so the no-raw-fetch contract test has a single fetch() owner.
// ---------------------------------------------------------------------------
export type PublicRequestOptions = {
  method?: "GET" | "POST";
  body?: unknown;
  signal?: AbortSignal;
};

export async function publicRequest<T>(path: string, options: PublicRequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const response = await fetch(`${apiBase()}${path}`, {
    method,
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: options.signal
  });
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    let correlationId: string | undefined;
    let details: unknown;
    try {
      const parsed = JSON.parse(text) as { message?: string; correlationId?: string; details?: unknown };
      message = parsed.message ?? text;
      correlationId = parsed.correlationId;
      details = parsed.details;
    } catch {
      /* keep raw body as the message */
    }
    throw new ApiError(message || `HTTP ${response.status}`, response.status, correlationId, details);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
