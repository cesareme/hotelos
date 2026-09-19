// useApiData v2 (Tanda UX-1 · lote U3 · docs/design/UX-RECEPCION-FEEL.md §4.1,
// §6.2, §10 R4). ADITIVA: misma exportación y el mismo `{ data, loading, error,
// refresh }` que consumen las 200+ pantallas; sobre `hooks/apiCache.ts` añade
// caché por clave (path + query + propiedad activa), stale-while-revalidate
// (`staleTime` 30 s: se sirve la caché y solo se revalida si caducó), `data`
// nunca se vacía si hay caché (`keepPreviousData`), dedupe de peticiones en
// vuelo, `AbortController` al cambiar de ruta o desmontar, sondeo pausado con
// `document.hidden` con revalidación inmediata al volver y backoff ×2 hasta
// 2 min tras 3 fallos, `loading` solo sin caché, `isValidating`, `mutate`
// optimista con rollback + rethrow y reconciliación por respuesta, y
// `prefetchApi` / `invalidateApi` re-exportados de la caché.
//
// Las funciones puras (`pollDelayFor`, `reconcile`, `runMutation`,
// `deriveApiState`, `shouldRevalidateOnVisible`) se prueban sin DOM en
// `hooks/__tests__/useApiData.test.mts`.

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { apiRequest, type RequestOptions } from "../services/api-client";
import { getActivePropertyId, isPropertyNotFoundError, reportActivePropertyInvalid } from "../services/activeProperty";
import { onAuthChange } from "../services/auth-storage";
import {
  DEFAULT_STALE_TIME_MS,
  assertOptimisticAllowed,
  cacheKeyFor,
  clearApiCache,
  endMutating,
  getCached,
  invalidateApi,
  invalidateKey,
  isAbortError,
  isFresh,
  loadApiKey,
  markMutating,
  prefetchApi,
  setApiCacheContext,
  setCached,
  subscribeApiCache,
  type ApiCacheEntry
} from "./apiCache";

export { invalidateApi, prefetchApi } from "./apiCache";

// Cableado de la caché con la capa de red y la propiedad activa (una vez por módulo).
setApiCacheContext({ fetcher: apiRequest, propertyId: getActivePropertyId });
if (typeof window !== "undefined") {
  // Otra sesión (login/logout) no debe ver datos del usuario anterior.
  onAuthChange(() => clearApiCache());
}

export type MutateOptions = {
  /** Deshacer 8 s (lo pinta el toast con acción de U4; hasta entonces se anota en el sink). */
  undo?: { label: string; seconds?: number; onUndo?: () => void | Promise<void> };
  /** Texto para la región viva (`announce` del shell, U4). */
  announce?: string;
};

/** `apiRequest` vigilado por la regla R4 (rutas con dinero prohibidas dentro de `mutate`). */
export type MutateRequest = <R>(path: string, options?: RequestOptions) => Promise<R>;

export type ApiState<T> = {
  data: T | null;
  /** True solo mientras no hay caché para la clave (primera carga o clave nueva sin datos). */
  loading: boolean;
  /** True mientras hay una petición en vuelo para la clave (con o sin datos). */
  isValidating: boolean;
  error: string | null;
  /** Revalida ignorando `staleTime` (comparte la petición si ya hay una en vuelo). */
  refresh: () => void;
  /**
   * Aplica `optimistic` a la caché al instante, ejecuta `commit` (recibe un
   * `apiRequest` vigilado por R4); si falla → rollback, revalidación y rethrow;
   * si devuelve datos → reconciliación (merge superficial) y revalidación.
   */
  mutate: (
    optimistic: (prev: T) => T,
    commit: (request: MutateRequest) => Promise<Partial<T> | void>,
    opts?: MutateOptions
  ) => Promise<void>;
};

export type UseApiDataOptions = RequestOptions & {
  /** Auto-refresh interval in ms while a predicate matches (or always when `true`). Pausado con `document.hidden`. */
  pollIntervalMs?: number;
  /** Predicate that decides if the auto-poll should keep firing. */
  pollWhile?: (data: unknown) => boolean;
  /** Ventana de frescura: dentro de ella la caché se sirve sin pedir nada (30 s por defecto). */
  staleTime?: number;
  /** Nunca vaciar `data` al cambiar de clave sin caché (true por defecto). */
  keepPreviousData?: boolean;
  /** `false` desactiva la carga (equivale a `path` nulo). */
  enabled?: boolean;
};

// ---------------------------------------------------------------- feedback de mutaciones (U4 lo cablea)

export type MutationFeedback = {
  announce?: (text: string) => void;
  undo?: (entry: { label: string; seconds: number; onUndo?: () => void | Promise<void> }) => void;
};

let mutationFeedback: MutationFeedback = {};

/** Sink de `announce`/`undo` de `mutate` (región viva y toast con acción llegan en U4). */
export function setMutationFeedback(next: MutationFeedback): void {
  mutationFeedback = next;
}

// ---------------------------------------------------------------- funciones puras

export const POLL_BACKOFF_AFTER_FAILURES = 3;
export const POLL_BACKOFF_MAX_MS = 120_000;

/** Intervalo del sondeo: base hasta 2 fallos; a partir del tercero ×2 por fallo hasta 2 min. */
export function pollDelayFor(baseMs: number, failures: number, maxMs: number = POLL_BACKOFF_MAX_MS): number {
  if (failures < POLL_BACKOFF_AFTER_FAILURES) return baseMs;
  const doubled = baseMs * 2 ** (failures - POLL_BACKOFF_AFTER_FAILURES + 1);
  return Math.min(maxMs, doubled);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reconciliación por respuesta: merge superficial si ambos son objetos; si no, la respuesta sustituye. */
export function reconcile<T>(prev: T, partial: Partial<T> | void): T {
  if (partial === undefined || partial === null) return prev;
  if (isPlainObject(prev) && isPlainObject(partial)) return { ...prev, ...partial } as T;
  return partial as T;
}

/** Estado derivado de la entrada de caché (misma forma que v1 + `isValidating`). */
export function deriveApiState<T>(input: {
  entry: ApiCacheEntry<T> | undefined;
  active: boolean;
  keepPreviousData: boolean;
  previousData: T | null;
}): { data: T | null; loading: boolean; isValidating: boolean; error: string | null } {
  const { entry, active, keepPreviousData, previousData } = input;
  const hasData = entry !== undefined && entry.data !== undefined;
  const isValidating = Boolean(entry?.inflight);
  const data = hasData ? (entry.data as T) : keepPreviousData ? previousData : null;
  const error = entry?.error ?? null;
  const loading = active && !hasData && error === null;
  return { data, loading, isValidating, error };
}

/** Al volver a la pestaña: sondeos siempre; el resto solo si la caché caducó. */
export function shouldRevalidateOnVisible(input: { polling: boolean; entry: ApiCacheEntry | undefined; staleTime: number; now?: number }): boolean {
  if (input.polling) return true;
  return !isFresh(input.entry, input.staleTime, input.now);
}

/** `apiRequest` vigilado: cualquier escritura a una ruta con dinero lanza (dev) o avisa (prod). */
export function guardedRequest(request: MutateRequest, options: { dev: boolean }): MutateRequest {
  return (path, requestOptions) => {
    const method = requestOptions?.method ?? "GET";
    if (method !== "GET") {
      try {
        assertOptimisticAllowed(path, { dev: options.dev });
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return request(path, requestOptions);
  };
}

/**
 * Núcleo de `mutate` (sin React): optimismo → commit → reconciliación o rollback.
 * Devuelve la promesa del commit; los errores se relanzan tras el rollback.
 */
export async function runMutation<T>(input: {
  key: string;
  path: string;
  optimistic: (prev: T) => T;
  commit: (request: MutateRequest) => Promise<Partial<T> | void>;
  request: MutateRequest;
  opts?: MutateOptions;
  feedback?: MutationFeedback;
}): Promise<void> {
  const { key, path, optimistic, commit, request, opts, feedback } = input;
  const snapshot = getCached<T>(key);
  const hadData = snapshot !== undefined && snapshot.data !== undefined;
  markMutating(key, path);
  if (hadData) setCached<T>(key, optimistic(snapshot.data as T), { path });
  try {
    const result = await commit(request);
    const current = getCached<T>(key);
    if (result !== undefined && current !== undefined && current.data !== undefined) {
      setCached<T>(key, reconcile(current.data as T, result), { path });
    }
    if (opts?.announce && feedback?.announce) feedback.announce(opts.announce);
    if (opts?.undo && feedback?.undo) feedback.undo({ label: opts.undo.label, seconds: opts.undo.seconds ?? 8, onUndo: opts.undo.onUndo });
  } catch (error) {
    if (hadData) setCached<T>(key, snapshot.data as T, { path });
    throw error;
  } finally {
    endMutating(key);
  }
}

// ---------------------------------------------------------------- hook

const NO_ENTRY_SUBSCRIBE = () => () => undefined;

export function useApiData<T>(path: string | null, options: UseApiDataOptions = {}): ApiState<T> {
  const {
    method,
    body,
    query,
    pollIntervalMs,
    pollWhile,
    staleTime = DEFAULT_STALE_TIME_MS,
    keepPreviousData = true,
    enabled = true
  } = options;
  const active = Boolean(path) && enabled;
  const propertyId = getActivePropertyId();
  const queryKey = JSON.stringify(query ?? {});
  const key = path ? cacheKeyFor({ method, path, query, body, propertyId }) : null;

  // Estado externo: la entrada de la caché para la clave (inmutable por cambio).
  const subscribe = useCallback((listener: () => void) => (key ? subscribeApiCache(key, listener) : NO_ENTRY_SUBSCRIBE()), [key]);
  const getSnapshot = useCallback(() => (key ? getCached<T>(key) : undefined), [key]);
  const entry = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const previousData = useRef<T | null>(null);
  if (entry?.data !== undefined) previousData.current = entry.data as T;

  const abortRef = useRef<AbortController | null>(null);
  const optionsRef = useRef({ method, body, query, pollWhile });
  optionsRef.current = { method, body, query, pollWhile };

  const load = useCallback(() => {
    if (!key || !path) return;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    const { method: m, body: b, query: q } = optionsRef.current;
    loadApiKey<T>(key, (signal) => apiRequest<T>(path, { method: m, body: b, query: q, signal }), { path, signal: controller.signal }).catch(
      (err: unknown) => {
        if (isAbortError(err)) return;
        // Tenancy safety net: the API answers an opaque 404 when the active
        // property is not visible to this user. Let the shell re-validate the
        // selection and offer the switcher instead of leaving N red cards.
        if (isPropertyNotFoundError(err)) reportActivePropertyInvalid();
      }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, path, queryKey]);

  // Carga inicial / cambio de clave / caducidad: sirve la caché y revalida solo
  // si caducó. Se dispara por clave y por `staleSince` (invalidación, fin de una
  // mutación, respuesta descartada por llegar tarde); un fallo NO reintenta
  // aquí (lo hace el sondeo con backoff o `refresh`).
  useEffect(() => {
    if (!active || !key) return;
    const current = getCached<T>(key);
    if (current?.inflight) return;
    if (current && current.mutating > 0) return;
    if (isFresh(current, staleTime)) return;
    load();
  }, [active, key, staleTime, load, entry?.staleSince]);

  // Abort al cambiar de ruta o desmontar (la petición compartida solo se aborta si nadie más la espera).
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [key]);

  // Sondeo: setTimeout encadenado (el intervalo crece con el backoff), pausado con document.hidden.
  useEffect(() => {
    if (!active || !key || !pollIntervalMs) return;
    let timer: number | undefined;
    let cancelled = false;
    const schedule = () => {
      if (cancelled) return;
      const failures = getCached(key)?.failures ?? 0;
      timer = window.setTimeout(() => {
        if (cancelled) return;
        const hidden = typeof document !== "undefined" && document.hidden;
        const current = getCached<T>(key);
        const shouldPoll = optionsRef.current.pollWhile ? optionsRef.current.pollWhile(current?.data ?? null) : true;
        if (!hidden && shouldPoll && !current?.inflight && !(current && current.mutating > 0)) load();
        schedule();
      }, pollDelayFor(pollIntervalMs, failures));
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [active, key, pollIntervalMs, load]);

  // Al volver a la pestaña: revalidación inmediata (sondeos) o si la caché caducó.
  useEffect(() => {
    if (!active || !key || typeof document === "undefined") return;
    const onVisibility = () => {
      if (document.hidden) return;
      const current = getCached<T>(key);
      if (current?.inflight || (current && current.mutating > 0)) return;
      if (shouldRevalidateOnVisible({ polling: Boolean(pollIntervalMs), entry: current, staleTime })) load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [active, key, pollIntervalMs, staleTime, load]);

  // «Actualizar» siempre vuelve a pedir (UX1-REV-15): con una petición en vuelo la clave
  // se marca caducada (la respuesta en curso se descarta, apiCache) y `staleSince` relanza la carga.
  const refresh = useCallback(() => {
    if (!active || !key) return;
    const current = getCached<T>(key);
    invalidateKey(key);
    if (!current?.inflight) load();
  }, [active, key, load]);

  const mutate = useCallback<ApiState<T>["mutate"]>(
    (optimistic, commit, opts) => {
      if (!key || !path) return commit(guardedRequest(apiRequest, { dev: import.meta.env.DEV })).then(() => undefined);
      return runMutation<T>({
        key,
        path,
        optimistic,
        commit,
        request: guardedRequest(apiRequest, { dev: import.meta.env.DEV }),
        opts,
        feedback: mutationFeedback
      });
    },
    [key, path]
  );

  const derived = deriveApiState<T>({ entry, active, keepPreviousData, previousData: previousData.current });

  return {
    data: derived.data,
    loading: derived.loading,
    isValidating: derived.isValidating,
    error: derived.error,
    refresh,
    mutate
  };
}
