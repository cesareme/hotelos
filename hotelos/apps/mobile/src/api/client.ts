/**
 * Sprint 37a — staff mobile API client.
 *
 * fetch wrapper with:
 *   - JSON encode/decode
 *   - Authorization: Bearer <token> (token resolved lazily via getToken)
 *   - AbortController timeout
 *   - 401 -> calls onUnauthorized() so the AuthContext can clear storage + bounce to Login
 */

export type ApiClientConfig = {
  baseUrl: string;
  getToken: () => string | null;
  onUnauthorized: () => void;
};

export type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  /** Override the default 15s timeout. */
  timeoutMs?: number;
  /** Skip Authorization header (e.g. login). */
  unauthenticated?: boolean;
};

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export function resolveBaseUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_BASE_URL;
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv.replace(/\/$/, "");
  }
  return "http://localhost:3000";
}

export function createApiClient(config: ApiClientConfig) {
  async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = `${config.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);

    const headers: Record<string, string> = {
      Accept: "application/json"
    };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (!options.unauthenticated) {
      const token = config.getToken();
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
    }

    try {
      const response = await fetch(url, {
        method: options.method ?? "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal
      });

      if (response.status === 401) {
        config.onUnauthorized();
        throw new ApiError("Unauthorized", 401, null);
      }

      const text = await response.text();
      const parsed: unknown = text.length > 0 ? safeParse(text) : null;

      if (!response.ok) {
        throw new ApiError(
          `Request failed with ${response.status}`,
          response.status,
          parsed
        );
      }

      return parsed as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  return { request };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export type ApiClient = ReturnType<typeof createApiClient>;
