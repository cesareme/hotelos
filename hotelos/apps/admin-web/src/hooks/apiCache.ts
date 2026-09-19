// Caché en memoria de la capa de datos v2 (Tanda UX-1 · lote U3 ·
// docs/design/UX-RECEPCION-FEEL.md §4 «Capa de datos v2», §4.1, §6.2, §10 R4).
//
// Módulo PURO: sin React, sin `services/api-client` (que lee `import.meta.env`
// al cargar) y sin DOM, para que `hooks/__tests__/useApiData.test.mts` lo
// ejercite con `node --test`. `hooks/useApiData.ts` lo cablea con `apiRequest`
// y con la propiedad activa (`setApiCacheContext`).
//
//   · Una entrada por clave `método + path + query + cuerpo + propiedad activa`
//     (`cacheKeyFor`) con `{ data, updatedAt, error, inflight, failures }`.
//   · `loadApiKey`: una sola petición en vuelo por clave (dedupe); cada
//     interesado aporta su `AbortSignal` y la petición compartida solo se
//     aborta cuando TODOS la han abandonado (cambio de ruta o desmontaje).
//   · `invalidateApi(prefix)`: marca caducadas las entradas cuya ruta es el
//     prefijo o cuelga de él por segmentos («/dashboards/front-desk» alcanza a
//     «/dashboards/front-desk?propertyId=…», no a «/dashboards/front-desk-queue»)
//     y avisa a los suscriptores; los hooks montados revalidan en segundo plano
//     sin vaciar `data`.
//   · Respuestas más antiguas que una invalidación o una mutación (`markMutating`
//     / `endMutating`) no pisan la caché: se descartan y la clave queda caducada.
//   · `prefetchApi(path)`: desde `onMouseEnter`/`onFocus`; no pide nada si la
//     entrada está fresca o ya en vuelo.
//   · R4 · lista dura de rutas con dinero PROHIBIDAS para `mutate` optimista
//     (`assertOptimisticAllowed`): lanza en desarrollo.

export type ApiCacheEntry<T = unknown> = {
  readonly key: string;
  /** Path tal y como lo pidió la pantalla (puede llevar `?query`); base del prefijo de `invalidateApi`. */
  readonly path: string;
  /** `undefined` hasta la primera respuesta correcta; nunca se vacía al invalidar. */
  readonly data: T | undefined;
  /** Instante de la última respuesta aplicada; 0 = nunca cargada o caducada. */
  readonly updatedAt: number;
  readonly error: string | null;
  readonly inflight: Promise<T> | null;
  /** Fallos consecutivos (base del backoff del sondeo). */
  readonly failures: number;
  /** Instante de la última invalidación o mutación: las respuestas anteriores se descartan. */
  readonly staleSince: number;
  /** Mutaciones optimistas en curso sobre la clave (los hooks no revalidan mientras > 0). */
  readonly mutating: number;
};

export type ApiCacheQuery = Record<string, string | number | undefined>;

export type ApiCacheKeyInput = {
  method?: string;
  path: string;
  query?: ApiCacheQuery;
  body?: unknown;
  propertyId?: string;
};

export type ApiCacheFetcher = <T>(
  path: string,
  options: { method?: "GET"; query?: ApiCacheQuery; signal?: AbortSignal }
) => Promise<T>;

export type ApiCacheContext = {
  /** `apiRequest` de services/api-client (cableado por useApiData.ts). */
  fetcher?: ApiCacheFetcher;
  /** Propiedad activa (services/activeProperty.getActivePropertyId). */
  propertyId?: () => string;
  now?: () => number;
};

type Listener = () => void;

type Inflight = {
  promise: Promise<unknown>;
  controller: AbortController;
  waiters: number;
  startedAt: number;
};

const entries = new Map<string, ApiCacheEntry>();
const listeners = new Map<string, Set<Listener>>();
const inflights = new Map<string, Inflight>();

let context: ApiCacheContext = {};

/** Por defecto 30 s (§4.1): dentro de la ventana la caché se sirve sin pedir nada. */
export const DEFAULT_STALE_TIME_MS = 30_000;

export function setApiCacheContext(next: ApiCacheContext): void {
  context = { ...context, ...next };
}

function now(): number {
  return context.now ? context.now() : Date.now();
}

function activePropertyId(): string {
  return context.propertyId ? context.propertyId() : "";
}

// ---------------------------------------------------------------- claves

function stableStringify(value: unknown): string {
  if (value === undefined) return "";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

/** Clave de caché: `GET /path?query{cuerpo}@propiedad`. La query se normaliza (orden estable, sin `undefined`). */
export function cacheKeyFor(input: ApiCacheKeyInput): string {
  const method = (input.method ?? "GET").toUpperCase();
  const query = input.query ? stableStringify(input.query) : "";
  const body = input.body === undefined ? "" : stableStringify(input.body);
  const propertyId = input.propertyId ?? activePropertyId();
  return `${method} ${input.path}${query ? ` ${query}` : ""}${body ? ` body=${body}` : ""} @${propertyId}`;
}

// ---------------------------------------------------------------- entradas

function emptyEntry<T>(key: string, path: string): ApiCacheEntry<T> {
  return { key, path, data: undefined, updatedAt: 0, error: null, inflight: null, failures: 0, staleSince: 0, mutating: 0 };
}

function commitEntry<T>(key: string, path: string, patch: Partial<ApiCacheEntry<T>>): ApiCacheEntry<T> {
  const previous = (entries.get(key) as ApiCacheEntry<T> | undefined) ?? emptyEntry<T>(key, path);
  const next: ApiCacheEntry<T> = { ...previous, ...patch, key, path: previous.path || path };
  entries.set(key, next as ApiCacheEntry);
  notify(key);
  return next;
}

function notify(key: string): void {
  const set = listeners.get(key);
  if (!set) return;
  for (const listener of Array.from(set)) listener();
}

export function getCached<T>(key: string): ApiCacheEntry<T> | undefined {
  return entries.get(key) as ApiCacheEntry<T> | undefined;
}

/** Datos frescos si hay respuesta aplicada y no ha pasado `staleTime` desde ella. */
export function isFresh(entry: ApiCacheEntry | undefined, staleTime: number = DEFAULT_STALE_TIME_MS, at: number = now()): boolean {
  if (!entry || entry.data === undefined || entry.updatedAt === 0) return false;
  return at - entry.updatedAt < staleTime;
}

/**
 * Escribe datos en una clave (optimismo, reconciliación o siembra desde otra
 * respuesta). Sin `fresh: true` la entrada queda caducada para que los hooks
 * montados revaliden en segundo plano; `path` solo hace falta si la clave es nueva.
 */
export function setCached<T>(key: string, data: T, options: { path?: string; fresh?: boolean } = {}): ApiCacheEntry<T> {
  const path = options.path ?? entries.get(key)?.path ?? key;
  return commitEntry<T>(key, path, { data, updatedAt: options.fresh ? now() : 0, error: null });
}

/** Marca caducada una clave concreta (los hooks montados revalidan sin esqueleto). */
export function invalidateKey(key: string): boolean {
  const entry = entries.get(key);
  if (!entry) return false;
  commitEntry(key, entry.path, { updatedAt: 0, staleSince: now() });
  return true;
}

/**
 * True si `path` es la ruta `prefix` o cuelga de ella por segmentos: «/dashboards/front-desk»
 * alcanza «/dashboards/front-desk?propertyId=…» y «/dashboards/front-desk/x», pero NO
 * «/dashboards/front-desk-queue» (otra ruta hermana: se invalida con su propio prefijo).
 */
export function pathMatchesPrefix(path: string, prefix: string): boolean {
  const cleanPrefix = prefix.replace(/\/+$/, "");
  if (!path.startsWith(cleanPrefix)) return false;
  const rest = path.slice(cleanPrefix.length);
  return rest === "" || rest.startsWith("/") || rest.startsWith("?") || rest.startsWith("#");
}

/** Marca caducadas todas las entradas cuya ruta sea `prefix` o cuelgue de ella (`pathMatchesPrefix`). Devuelve cuántas. */
export function invalidateApi(prefix: string): number {
  let count = 0;
  for (const entry of Array.from(entries.values())) {
    if (!pathMatchesPrefix(entry.path, prefix)) continue;
    invalidateKey(entry.key);
    count += 1;
  }
  return count;
}

/** Suscripción por clave; el listener se llama tras cada cambio de la entrada. */
export function subscribeApiCache(key: string, listener: Listener): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => {
    const current = listeners.get(key);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(key);
  };
}

/** Vacía la caché (cierre de sesión, tests). Las peticiones en vuelo se abandonan. */
export function clearApiCache(): void {
  for (const inflight of inflights.values()) inflight.controller.abort();
  inflights.clear();
  entries.clear();
  for (const key of Array.from(listeners.keys())) notify(key);
}

/** Claves cacheadas (diagnóstico y tests). */
export function cachedKeys(): string[] {
  return Array.from(entries.keys());
}

// ---------------------------------------------------------------- mutaciones

/** Una mutación optimista empieza: los hooks no revalidan la clave hasta `endMutating`. */
export function markMutating(key: string, path?: string): void {
  const entry = entries.get(key);
  commitEntry(key, path ?? entry?.path ?? key, { mutating: (entry?.mutating ?? 0) + 1, staleSince: now() });
}

/** La mutación terminó (bien o mal): la clave queda caducada y se revalida en segundo plano. */
export function endMutating(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  commitEntry(key, entry.path, { mutating: Math.max(0, entry.mutating - 1), updatedAt: 0, staleSince: now() });
}

// ---------------------------------------------------------------- carga con dedupe y aborto compartido

export function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

function abortError(): Error {
  if (typeof DOMException !== "undefined") return new DOMException("Petición cancelada.", "AbortError");
  const error = new Error("Petición cancelada.");
  error.name = "AbortError";
  return error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Carga una clave: si ya hay una petición en vuelo la comparte (dedupe); si no,
 * ejecuta `run` con una señal compartida. Cada interesado puede aportar su
 * `signal`: al abortarla su promesa rechaza con AbortError y, cuando ya no queda
 * nadie esperando, se aborta la petición compartida. Los abortos no cuentan como
 * fallo. Una respuesta iniciada antes de una invalidación o mutación posterior
 * no pisa la caché: se descarta y la clave queda caducada.
 */
export function loadApiKey<T>(
  key: string,
  run: (signal: AbortSignal) => Promise<T>,
  options: { path: string; signal?: AbortSignal }
): Promise<T> {
  let shared = inflights.get(key);
  if (!shared) {
    const controller = new AbortController();
    const startedAt = now();
    const promise = run(controller.signal).then(
      (data) => {
        inflights.delete(key);
        const current = entries.get(key);
        if (current && current.staleSince > startedAt) {
          // Llegó tarde: alguien invalidó o mutó la clave mientras volaba. Se
          // descarta y `staleSince` avanza para que los hooks montados vuelvan a pedir.
          commitEntry(key, options.path, { inflight: null, error: null, failures: 0, updatedAt: 0, staleSince: now() });
        } else {
          commitEntry(key, options.path, { data, updatedAt: now(), error: null, failures: 0, inflight: null });
        }
        return data;
      },
      (error: unknown) => {
        inflights.delete(key);
        if (controller.signal.aborted || isAbortError(error)) {
          commitEntry(key, options.path, { inflight: null });
        } else {
          const current = entries.get(key);
          commitEntry(key, options.path, { inflight: null, error: errorMessage(error), failures: (current?.failures ?? 0) + 1 });
        }
        throw error;
      }
    );
    shared = { promise, controller, waiters: 0, startedAt };
    inflights.set(key, shared);
    commitEntry(key, options.path, { inflight: promise as Promise<unknown> });
  }
  const inflight = shared;
  inflight.waiters += 1;
  const signal = options.signal;
  if (!signal) return inflight.promise as Promise<T>;
  return new Promise<T>((resolve, reject) => {
    const release = () => {
      inflight.waiters -= 1;
      if (inflight.waiters <= 0 && inflights.get(key) === inflight) inflight.controller.abort();
    };
    const onAbort = () => {
      release();
      reject(abortError());
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    inflight.promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value as T);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

/** Petición en vuelo para la clave (diagnóstico y tests). */
export function hasInflight(key: string): boolean {
  return inflights.has(key);
}

// ---------------------------------------------------------------- prefetch

/**
 * Precarga un GET (p. ej. `/reservations/:id` desde `onMouseEnter` de una fila).
 * No pide nada si la entrada está fresca o ya en vuelo; los errores se tragan
 * (es una optimización, no una carga). Cancelable con `signal`.
 */
export function prefetchApi(
  path: string,
  options: { query?: ApiCacheQuery; staleTime?: number; propertyId?: string; signal?: AbortSignal } = {}
): Promise<void> {
  const fetcher = context.fetcher;
  if (!fetcher) return Promise.resolve();
  const key = cacheKeyFor({ path, query: options.query, propertyId: options.propertyId });
  const entry = entries.get(key);
  if (isFresh(entry, options.staleTime ?? DEFAULT_STALE_TIME_MS) || inflights.has(key)) return Promise.resolve();
  return loadApiKey(key, (signal) => fetcher(path, { query: options.query, signal }), { path, signal: options.signal }).then(
    () => undefined,
    () => undefined
  );
}

// ---------------------------------------------------------------- R4 · dinero nunca optimista

/** Segmentos de ruta con dinero (§4.1, P4): cobros, facturas y devoluciones. */
export const OPTIMISTIC_FORBIDDEN_SEGMENTS: readonly string[] = ["payments", "invoice", "invoices", "refunds"];

/** True si el path toca dinero (`/folios/:id/payments`, `/reservations/:id/invoice`, `/payments/:id/refunds`…). */
export function isOptimisticForbidden(path: string): boolean {
  const pathname = (path.startsWith("http") ? new URL(path).pathname : path.split(/[?#]/)[0] ?? "").toLowerCase();
  const segments = pathname.split("/").filter(Boolean);
  return segments.some((segment) => OPTIMISTIC_FORBIDDEN_SEGMENTS.includes(segment));
}

/**
 * Regla dura R4: una escritura con dinero nunca viaja por `mutate` optimista.
 * En desarrollo lanza (la mutación hace rollback y el error llega a quien
 * programa); en producción avisa por consola y deja pasar la petición para no
 * bloquear un cobro real.
 */
export function assertOptimisticAllowed(path: string, options: { dev?: boolean; warn?: (message: string) => void } = {}): void {
  if (!isOptimisticForbidden(path)) return;
  const message = `useApiData.mutate: la ruta «${path}» mueve dinero y no admite actualización optimista (R4). Usa apiRequest con loading en el botón.`;
  if (options.dev) throw new Error(message);
  (options.warn ?? ((text: string) => console.error(text)))(message);
}
