// Tanda UX-1 · lote U3 · capa de datos v2 (docs/design/UX-RECEPCION-FEEL.md §4
// «Capa de datos v2», §4.1, §6.2, §10 R4). Sin DOM ni React montado: se prueba
// la lógica pura de hooks/apiCache.ts (caché, SWR, dedupe, aborto compartido,
// invalidación por prefijo, prefetch, rutas prohibidas) y las funciones
// exportadas de hooks/useApiData.ts (runMutation con rollback/reconciliación,
// backoff del sondeo, estado derivado, visibilidad), más el contrato de fuente
// de FrontDeskActionQueue.tsx (sin `refresh()` tras acciones; `assign_room`
// optimista). Desde apps/admin-web:
//   corepack pnpm --filter @hotelos/admin-web test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// services/api-client.ts lee `import.meta.env` al cargar (Vite); bajo `node --test`
// se sustituye ese único módulo por su fuente sin tipos precedida de `import.meta.env ??= {}`
// (mismo gancho que screens/operations/__tests__/frontdesk-actions.test.mts).
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("/src/services/api-client.ts")) {
      const source = stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), { mode: "strip" });
      return { format: "module", source: `import.meta.env ??= {};\n${source}`, shortCircuit: true };
    }
    return nextLoad(url, context);
  }
});

const cache = await import("../apiCache.ts");
const hook = await import("../useApiData.ts");
const queue = await import("../../screens/operations/FrontDeskActionQueue.tsx");

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

let clock = 1_000_000;
beforeEach(() => {
  clock = 1_000_000;
  cache.clearApiCache();
  cache.setApiCacheContext({ propertyId: () => "prop_test", now: () => clock, fetcher: undefined });
});

describe("apiCache · claves", () => {
  it("cacheKeyFor: GET por defecto, query normalizada (orden estable, sin undefined), cuerpo y propiedad activa", () => {
    assert.equal(cache.cacheKeyFor({ path: "/rooms" }), "GET /rooms @prop_test");
    assert.equal(
      cache.cacheKeyFor({ path: "/rooms", query: { b: 2, a: "x", c: undefined } }),
      cache.cacheKeyFor({ path: "/rooms", query: { a: "x", b: 2 } })
    );
    assert.notEqual(cache.cacheKeyFor({ path: "/rooms" }), cache.cacheKeyFor({ path: "/rooms", propertyId: "prop_other" }));
    assert.notEqual(cache.cacheKeyFor({ path: "/search", method: "POST", body: { q: "a" } }), cache.cacheKeyFor({ path: "/search", method: "POST", body: { q: "b" } }));
    assert.match(cache.cacheKeyFor({ path: "/x", method: "post" }), /^POST /);
  });
});

describe("apiCache · entradas, frescura y suscripción", () => {
  it("setCached avisa a los suscriptores por clave y `fresh` gobierna isFresh/staleTime", () => {
    const key = cache.cacheKeyFor({ path: "/a" });
    let calls = 0;
    const unsubscribe = cache.subscribeApiCache(key, () => {
      calls += 1;
    });
    cache.setCached(key, { n: 1 }, { path: "/a", fresh: true });
    assert.equal(calls, 1);
    assert.deepEqual(cache.getCached<{ n: number }>(key)?.data, { n: 1 });
    assert.equal(cache.isFresh(cache.getCached(key), 30_000), true);
    clock += 29_999;
    assert.equal(cache.isFresh(cache.getCached(key), 30_000), true);
    clock += 1;
    assert.equal(cache.isFresh(cache.getCached(key), 30_000), false);
    unsubscribe();
    cache.setCached(key, { n: 2 }, { path: "/a" });
    assert.equal(calls, 1, "tras desuscribirse no llega nada más");
    assert.equal(cache.getCached(key)?.updatedAt, 0, "sin `fresh` la entrada queda caducada para revalidar");
    assert.equal(cache.isFresh(undefined), false);
  });

  it("invalidateApi(prefix) caduca por prefijo de path sin vaciar `data` y avisa; devuelve cuántas", () => {
    const dash = cache.cacheKeyFor({ path: "/dashboards/front-desk?propertyId=prop_test" });
    const queueKey = cache.cacheKeyFor({ path: "/dashboards/front-desk-queue?propertyId=prop_test" });
    const other = cache.cacheKeyFor({ path: "/reservations/r1" });
    cache.setCached(dash, { kpis: 1 }, { path: "/dashboards/front-desk?propertyId=prop_test", fresh: true });
    cache.setCached(queueKey, { items: [] }, { path: "/dashboards/front-desk-queue?propertyId=prop_test", fresh: true });
    cache.setCached(other, { id: "r1" }, { path: "/reservations/r1", fresh: true });
    let notified = 0;
    cache.subscribeApiCache(dash, () => {
      notified += 1;
    });
    clock += 10;
    assert.equal(cache.invalidateApi("/dashboards/front-desk"), 1, "solo la ruta y lo que cuelga de ella; la cola es otra ruta hermana");
    assert.equal(notified, 1);
    assert.deepEqual(cache.getCached(dash)?.data, { kpis: 1 }, "los datos se conservan (sin esqueleto)");
    assert.equal(cache.getCached(dash)?.updatedAt, 0);
    assert.equal(cache.getCached(dash)?.staleSince, clock);
    assert.equal(cache.isFresh(cache.getCached(queueKey)), true, "la cola sigue fresca");
    assert.equal(cache.invalidateApi("/dashboards/front-desk-queue"), 1);
    assert.equal(cache.getCached(queueKey)?.updatedAt, 0);
    assert.equal(cache.isFresh(cache.getCached(other)), true, "otro prefijo intacto");
    assert.equal(cache.invalidateApi("/dashboards"), 2, "el padre alcanza a las dos");
    assert.equal(cache.invalidateApi("/nada"), 0);
    assert.equal(cache.pathMatchesPrefix("/reservations/r1/folio", "/reservations/r1"), true);
    assert.equal(cache.pathMatchesPrefix("/reservations/r10", "/reservations/r1"), false);
    assert.equal(cache.pathMatchesPrefix("/reservations/r1?x=1", "/reservations/r1/"), true);
  });
});

describe("apiCache · loadApiKey: dedupe, aborto compartido, fallos y respuestas tardías", () => {
  it("dos cargas concurrentes de la misma clave comparten UNA ejecución y la entrada acaba fresca", async () => {
    const key = cache.cacheKeyFor({ path: "/rooms" });
    const gate = deferred<{ rooms: number }>();
    let runs = 0;
    const run = () => {
      runs += 1;
      return gate.promise;
    };
    const a = cache.loadApiKey(key, run, { path: "/rooms" });
    const b = cache.loadApiKey(key, run, { path: "/rooms" });
    assert.equal(runs, 1);
    assert.equal(cache.hasInflight(key), true);
    assert.equal(Boolean(cache.getCached(key)?.inflight), true);
    clock += 5;
    gate.resolve({ rooms: 3 });
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra, rb);
    assert.equal(cache.hasInflight(key), false);
    const entry = cache.getCached<{ rooms: number }>(key);
    assert.deepEqual(entry?.data, { rooms: 3 });
    assert.equal(entry?.updatedAt, clock);
    assert.equal(entry?.inflight, null);
    assert.equal(entry?.failures, 0);
    // Una carga posterior vuelve a ejecutar (ya no hay nada en vuelo).
    await cache.loadApiKey(key, run, { path: "/rooms" });
    assert.equal(runs, 2);
  });

  it("cada interesado aborta lo suyo; la petición compartida solo se aborta cuando no queda nadie", async () => {
    const key = cache.cacheKeyFor({ path: "/slow" });
    const gate = deferred<string>();
    let sharedSignal: AbortSignal | undefined;
    const run = (signal: AbortSignal) => {
      sharedSignal = signal;
      return new Promise<string>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("x", "AbortError")), { once: true });
        gate.promise.then(resolve, reject);
      });
    };
    const ca = new AbortController();
    const cb = new AbortController();
    const a = cache.loadApiKey(key, run, { path: "/slow", signal: ca.signal });
    const b = cache.loadApiKey(key, run, { path: "/slow", signal: cb.signal });
    ca.abort();
    await assert.rejects(a, (error: unknown) => cache.isAbortError(error));
    assert.equal(sharedSignal?.aborted, false, "B sigue esperando: la red no se cancela");
    gate.resolve("ok");
    assert.equal(await b, "ok");
    assert.equal(cache.getCached(key)?.error, null);

    // Segunda ronda: los dos abandonan → la compartida se aborta y no cuenta como fallo.
    const gate2 = deferred<string>();
    const run2 = (signal: AbortSignal) =>
      new Promise<string>((resolve, reject) => {
        sharedSignal = signal;
        signal.addEventListener("abort", () => reject(new DOMException("x", "AbortError")), { once: true });
        gate2.promise.then(resolve, reject);
      });
    cache.invalidateKey(key);
    const cc = new AbortController();
    const cd = new AbortController();
    const c = cache.loadApiKey(key, run2, { path: "/slow", signal: cc.signal });
    const d = cache.loadApiKey(key, run2, { path: "/slow", signal: cd.signal });
    cc.abort();
    cd.abort();
    await assert.rejects(c, (error: unknown) => cache.isAbortError(error));
    await assert.rejects(d, (error: unknown) => cache.isAbortError(error));
    await tick();
    assert.equal(sharedSignal?.aborted, true);
    const entry = cache.getCached<string>(key);
    assert.equal(entry?.inflight, null);
    assert.equal(entry?.failures, 0, "abortar no es fallar");
    assert.equal(entry?.error, null);
    assert.equal(entry?.data, "ok", "los datos anteriores se conservan");
  });

  it("los fallos consecutivos se cuentan (backoff) y un éxito los pone a cero", async () => {
    const key = cache.cacheKeyFor({ path: "/flaky" });
    await assert.rejects(cache.loadApiKey(key, () => Promise.reject(new Error("HTTP 500")), { path: "/flaky" }));
    await assert.rejects(cache.loadApiKey(key, () => Promise.reject(new Error("HTTP 502")), { path: "/flaky" }));
    assert.equal(cache.getCached(key)?.failures, 2);
    assert.equal(cache.getCached(key)?.error, "HTTP 502");
    await cache.loadApiKey(key, () => Promise.resolve(1), { path: "/flaky" });
    assert.equal(cache.getCached(key)?.failures, 0);
    assert.equal(cache.getCached(key)?.error, null);
  });

  it("una respuesta iniciada antes de una invalidación o mutación no pisa la caché y deja la clave caducada", async () => {
    const key = cache.cacheKeyFor({ path: "/dashboards/front-desk" });
    cache.setCached(key, { version: 1 }, { path: "/dashboards/front-desk", fresh: true });
    const gate = deferred<{ version: number }>();
    const load = cache.loadApiKey(key, () => gate.promise, { path: "/dashboards/front-desk" });
    clock += 1;
    cache.invalidateApi("/dashboards/front-desk");
    const staleSinceAtInvalidate = cache.getCached(key)?.staleSince;
    clock += 1;
    gate.resolve({ version: 0 }); // respuesta vieja
    await load;
    const entry = cache.getCached<{ version: number }>(key);
    assert.deepEqual(entry?.data, { version: 1 }, "la respuesta tardía se descarta");
    assert.equal(entry?.updatedAt, 0);
    assert.ok((entry?.staleSince ?? 0) > (staleSinceAtInvalidate ?? 0), "staleSince avanza para que los hooks vuelvan a pedir");
    // Igual con una mutación en curso.
    const gate2 = deferred<{ version: number }>();
    const load2 = cache.loadApiKey(key, () => gate2.promise, { path: "/dashboards/front-desk" });
    clock += 1;
    cache.markMutating(key);
    cache.setCached(key, { version: 2 });
    gate2.resolve({ version: 1 });
    await load2;
    assert.deepEqual(cache.getCached<{ version: number }>(key)?.data, { version: 2 }, "el optimismo no se pierde");
    assert.equal(cache.getCached(key)?.mutating, 1);
    cache.endMutating(key);
    assert.equal(cache.getCached(key)?.mutating, 0);
  });
});

describe("apiCache · prefetchApi", () => {
  it("pide una vez, no repite mientras la entrada esté fresca o en vuelo, vuelve tras invalidar y traga errores", async () => {
    const calls: string[] = [];
    let fail = false;
    cache.setApiCacheContext({
      fetcher: (async (path: string) => {
        calls.push(path);
        await tick();
        if (fail) throw new Error("HTTP 500");
        return { id: path };
      }) as never
    });
    const first = cache.prefetchApi("/reservations/r1");
    const second = cache.prefetchApi("/reservations/r1"); // en vuelo → no repite
    await Promise.all([first, second]);
    assert.deepEqual(calls, ["/reservations/r1"]);
    await cache.prefetchApi("/reservations/r1"); // fresca → no repite
    assert.equal(calls.length, 1);
    cache.invalidateApi("/reservations/r1");
    await cache.prefetchApi("/reservations/r1");
    assert.equal(calls.length, 2);
    fail = true;
    cache.invalidateApi("/reservations/r1");
    await assert.doesNotReject(cache.prefetchApi("/reservations/r1"));
    assert.equal(cache.getCached(cache.cacheKeyFor({ path: "/reservations/r1" }))?.error, "HTTP 500");
    assert.deepEqual(cache.getCached<{ id: string }>(cache.cacheKeyFor({ path: "/reservations/r1" }))?.data, { id: "/reservations/r1" });
  });

  it("sin fetcher configurado no hace nada", async () => {
    cache.setApiCacheContext({ fetcher: undefined });
    await assert.doesNotReject(cache.prefetchApi("/x"));
    assert.equal(cache.getCached(cache.cacheKeyFor({ path: "/x" })), undefined);
  });
});

describe("R4 · dinero nunca por mutate optimista", () => {
  it("isOptimisticForbidden reconoce cobros, facturas y devoluciones en cualquier posición del path", () => {
    for (const path of ["/folios/f1/payments", "/reservations/r1/invoice", "/payments/p1/refunds", "/invoices/i1", "/folios/f1/payments?x=1", "http://api/folios/f1/Payments"]) {
      assert.equal(cache.isOptimisticForbidden(path), true, path);
    }
    for (const path of ["/reservations/r1/assign-room", "/reservations/r1/check-in", "/reservations/r1/no-show", "/folios/f1/lines", "/settings/invoice-series", "/rooms/1/housekeeping"]) {
      assert.equal(cache.isOptimisticForbidden(path), false, path);
    }
  });

  it("assertOptimisticAllowed lanza en desarrollo y solo avisa en producción; guardedRequest vigila las escrituras", async () => {
    assert.throws(() => cache.assertOptimisticAllowed("/folios/f1/payments", { dev: true }), /mueve dinero/);
    const warnings: string[] = [];
    cache.assertOptimisticAllowed("/folios/f1/payments", { dev: false, warn: (m) => warnings.push(m) });
    assert.equal(warnings.length, 1);
    assert.doesNotThrow(() => cache.assertOptimisticAllowed("/reservations/r1/assign-room", { dev: true }));

    const seen: string[] = [];
    const request = hook.guardedRequest((async (path: string) => {
      seen.push(path);
      return { ok: true };
    }) as never, { dev: true });
    await assert.rejects(request("/folios/f1/payments", { method: "POST", body: {} }), /R4/);
    assert.deepEqual(seen, [], "la petición prohibida no llega a la red");
    await request("/folios/f1/payments"); // un GET de lectura sí
    await request("/reservations/r1/assign-room", { method: "POST", body: { roomId: "x" } });
    assert.deepEqual(seen, ["/folios/f1/payments", "/reservations/r1/assign-room"]);
  });
});

describe("useApiData · runMutation (optimismo → commit → reconciliación / rollback)", () => {
  type Queue = { items: Array<{ id: string }>; total: number };
  const path = "/dashboards/front-desk-queue?propertyId=prop_test";
  const key = () => cache.cacheKeyFor({ path });
  const request = (async () => undefined) as never;

  it("aplica el optimismo al instante, bloquea la revalidación mientras dura y deja la clave caducada al terminar", async () => {
    cache.setCached(key(), { items: [{ id: "a" }, { id: "b" }], total: 2 } satisfies Queue, { path, fresh: true });
    const gate = deferred<void>();
    let seenRequest: unknown;
    const done = hook.runMutation<Queue>({
      key: key(),
      path,
      optimistic: (prev) => ({ items: prev.items.filter((i) => i.id !== "a"), total: prev.total - 1 }),
      commit: (req) => {
        seenRequest = req;
        return gate.promise;
      },
      request
    });
    const during = cache.getCached<Queue>(key());
    assert.deepEqual(during?.data, { items: [{ id: "b" }], total: 1 }, "la tarjeta desaparece antes de que vuelva el servidor");
    assert.equal(during?.mutating, 1);
    assert.equal(seenRequest, request, "el commit recibe el apiRequest vigilado");
    clock += 3;
    gate.resolve();
    await done;
    const after = cache.getCached<Queue>(key());
    assert.deepEqual(after?.data, { items: [{ id: "b" }], total: 1 });
    assert.equal(after?.mutating, 0);
    assert.equal(after?.updatedAt, 0, "caducada: el hook revalida en segundo plano");
    assert.equal(after?.staleSince, clock);
  });

  it("si el commit devuelve datos, reconcilia por merge superficial", async () => {
    cache.setCached(key(), { items: [{ id: "a" }], total: 1, extra: "keep" } as Queue & { extra: string }, { path, fresh: true });
    await hook.runMutation<Queue>({
      key: key(),
      path,
      optimistic: (prev) => ({ ...prev, total: 5 }),
      commit: async () => ({ total: 7 }),
      request
    });
    assert.deepEqual(cache.getCached(key())?.data, { items: [{ id: "a" }], total: 7, extra: "keep" });
  });

  it("si el commit falla: rollback al estado anterior, rethrow del mismo error y clave caducada", async () => {
    const snapshot: Queue = { items: [{ id: "a" }, { id: "b" }], total: 2 };
    cache.setCached(key(), snapshot, { path, fresh: true });
    const failure = new Error("409 ROOM_OCCUPIED");
    await assert.rejects(
      hook.runMutation<Queue>({
        key: key(),
        path,
        optimistic: (prev) => ({ items: prev.items.slice(1), total: 1 }),
        commit: async () => {
          assert.equal(cache.getCached<Queue>(key())?.data?.items.length, 1);
          throw failure;
        },
        request
      }),
      (error: unknown) => error === failure
    );
    const after = cache.getCached<Queue>(key());
    assert.deepEqual(after?.data, snapshot, "la tarjeta vuelve");
    assert.equal(after?.mutating, 0);
    assert.equal(after?.updatedAt, 0);
  });

  it("sin datos en caché no aplica optimismo (commit sí); announce/undo llegan al sink", async () => {
    const announced: string[] = [];
    const undos: Array<{ label: string; seconds: number }> = [];
    let optimisticCalls = 0;
    await hook.runMutation<Queue>({
      key: cache.cacheKeyFor({ path: "/vacio" }),
      path: "/vacio",
      optimistic: (prev) => {
        optimisticCalls += 1;
        return prev;
      },
      commit: async () => undefined,
      request,
      opts: { announce: "Habitación asignada", undo: { label: "Deshacer" } },
      feedback: { announce: (t) => announced.push(t), undo: (u) => undos.push({ label: u.label, seconds: u.seconds }) }
    });
    assert.equal(optimisticCalls, 0);
    assert.deepEqual(announced, ["Habitación asignada"]);
    assert.deepEqual(undos, [{ label: "Deshacer", seconds: 8 }]);
  });

  it("reconcile: merge de objetos, sustitución si no lo son, sin cambio con void", () => {
    assert.deepEqual(hook.reconcile({ a: 1, b: 2 }, { b: 3 }), { a: 1, b: 3 });
    assert.deepEqual(hook.reconcile([1, 2], [3] as never), [3]);
    assert.deepEqual(hook.reconcile({ a: 1 }, undefined), { a: 1 });
  });
});

describe("useApiData · sondeo, estado derivado y visibilidad (puros)", () => {
  it("pollDelayFor: base hasta 2 fallos; ×2 por fallo desde el tercero; techo 2 min", () => {
    assert.equal(hook.pollDelayFor(30_000, 0), 30_000);
    assert.equal(hook.pollDelayFor(30_000, 2), 30_000);
    assert.equal(hook.pollDelayFor(30_000, 3), 60_000);
    assert.equal(hook.pollDelayFor(30_000, 4), 120_000);
    assert.equal(hook.pollDelayFor(30_000, 9), 120_000);
    assert.equal(hook.pollDelayFor(10_000, 3), 20_000);
    assert.equal(hook.pollDelayFor(10_000, 5), 80_000);
    assert.equal(hook.POLL_BACKOFF_MAX_MS, 120_000);
  });

  it("deriveApiState: loading solo sin caché; isValidating con petición en vuelo; keepPreviousData conserva `data`", () => {
    const key = cache.cacheKeyFor({ path: "/d" });
    assert.deepEqual(hook.deriveApiState({ entry: undefined, active: true, keepPreviousData: true, previousData: null }), { data: null, loading: true, isValidating: false, error: null });
    assert.equal(hook.deriveApiState({ entry: undefined, active: false, keepPreviousData: true, previousData: null }).loading, false);
    assert.deepEqual(hook.deriveApiState({ entry: undefined, active: true, keepPreviousData: true, previousData: { old: true } }).data, { old: true });
    assert.equal(hook.deriveApiState({ entry: undefined, active: true, keepPreviousData: false, previousData: { old: true } }).data, null);
    cache.setCached(key, { n: 1 }, { path: "/d", fresh: true });
    const withData = hook.deriveApiState({ entry: cache.getCached(key), active: true, keepPreviousData: true, previousData: null });
    assert.deepEqual(withData, { data: { n: 1 }, loading: false, isValidating: false, error: null });
    const gate = deferred<{ n: number }>();
    void cache.loadApiKey(key, () => gate.promise, { path: "/d" }).catch(() => undefined);
    const validating = hook.deriveApiState({ entry: cache.getCached(key), active: true, keepPreviousData: true, previousData: null });
    assert.equal(validating.isValidating, true);
    assert.equal(validating.loading, false, "con caché nunca hay esqueleto");
    gate.resolve({ n: 2 });
    const failed = cache.cacheKeyFor({ path: "/f" });
    return cache.loadApiKey(failed, () => Promise.reject(new Error("HTTP 500")), { path: "/f" }).catch(() => {
      const errored = hook.deriveApiState({ entry: cache.getCached(failed), active: true, keepPreviousData: true, previousData: null });
      assert.deepEqual(errored, { data: null, loading: false, isValidating: false, error: "HTTP 500" });
    });
  });

  it("shouldRevalidateOnVisible: sondeos siempre; el resto solo si la caché caducó", () => {
    const key = cache.cacheKeyFor({ path: "/v" });
    cache.setCached(key, 1, { path: "/v", fresh: true });
    assert.equal(hook.shouldRevalidateOnVisible({ polling: true, entry: cache.getCached(key), staleTime: 30_000 }), true);
    assert.equal(hook.shouldRevalidateOnVisible({ polling: false, entry: cache.getCached(key), staleTime: 30_000 }), false);
    assert.equal(hook.shouldRevalidateOnVisible({ polling: false, entry: cache.getCached(key), staleTime: 30_000, now: clock + 30_000 }), true);
    assert.equal(hook.shouldRevalidateOnVisible({ polling: false, entry: undefined, staleTime: 30_000 }), true);
  });
});

describe("contrato de fuente · useApiData.ts y FrontDeskActionQueue.tsx", () => {
  const HOOK_SOURCE = readFileSync(new URL("../useApiData.ts", import.meta.url), "utf8");
  const QUEUE_SOURCE = readFileSync(new URL("../../screens/operations/FrontDeskActionQueue.tsx", import.meta.url), "utf8");
  const count = (source: string, needle: string): number => source.split(needle).length - 1;

  it("la firma v2 es aditiva: misma exportación, {data, loading, error, refresh} + isValidating + mutate; prefetch/invalidate re-exportados", () => {
    assert.equal(typeof hook.useApiData, "function");
    assert.equal(hook.invalidateApi, cache.invalidateApi);
    assert.equal(hook.prefetchApi, cache.prefetchApi);
    assert.match(HOOK_SOURCE, /staleTime = DEFAULT_STALE_TIME_MS,\s*keepPreviousData = true,\s*enabled = true/);
    assert.match(HOOK_SOURCE, /document\.hidden/);
    assert.match(HOOK_SOURCE, /addEventListener\("visibilitychange"/);
    assert.match(HOOK_SOURCE, /if \(isPropertyNotFoundError\(err\)\) reportActivePropertyInvalid\(\);/);
    assert.match(HOOK_SOURCE, /optionsRef\.current\.pollWhile/);
    assert.match(HOOK_SOURCE, /new AbortController\(\)/);
    assert.equal(cache.DEFAULT_STALE_TIME_MS, 30_000);
  });

  it("refresh() nunca es un no-op (UX1-REV-15): con petición en vuelo caduca la clave y la respuesta tardía se descarta", () => {
    assert.match(HOOK_SOURCE, /const refresh = useCallback\(\(\) => \{\s*if \(!active \|\| !key\) return;\s*const current = getCached<T>\(key\);\s*invalidateKey\(key\);\s*if \(!current\?\.inflight\) load\(\);/);
  });
  it("la cola lee con staleTime y sondeo; tras acciones y check-in/out invalida las dos claves de Mi día en vez de refresh()", () => {
    assert.match(QUEUE_SOURCE, /\{ pollIntervalMs: 30000, staleTime: 30000 \}/);
    assert.equal(count(QUEUE_SOURCE, "refresh();"), 0, "ningún refresh() completo tras una acción");
    assert.equal(count(QUEUE_SOURCE, "invalidateFrontDesk();"), 3, "otras acciones de la cola + check-in + check-out");
    assert.match(QUEUE_SOURCE, /if \(result\.ok && action\.kind === "assign_room"\) \{[\s\S]*?invalidateApi\("\/dashboards\/front-desk"\);/, "assign_room: la cola ya la revalida mutate; solo Mi día");
    assert.match(QUEUE_SOURCE, /invalidateApi\("\/dashboards\/front-desk-queue"\);\s*invalidateApi\("\/dashboards\/front-desk"\);/);
    assert.match(QUEUE_SOURCE, /onClick=\{refresh\}/, "el botón «Recargar» sigue siendo explícito");
    assert.match(QUEUE_SOURCE, /onRetry=\{refresh\}/);
  });

  it("assign_room va por mutate optimista (quita la tarjeta y baja contadores); mark_no_show pasa por el diálogo nominal (U6 · F9)", () => {
    assert.match(QUEUE_SOURCE, /mutate\(\s*\(prev\) => removeQueueItem\(prev, itemId\),\s*\(request\) => request<void>\(`\/reservations\/\$\{encodeURIComponent\(reservationId\)\}\/assign-room`, \{ method: "POST", body: \{ roomId \} \}\)/);
    // U6 · F9: nunca a un clic con cuerpo `{}`: LifecycleDialog (motivo + penalización prevista) y la tarjeta sale al confirmar el API.
    assert.doesNotMatch(QUEUE_SOURCE, /\/no-show`, \{\s*method: "POST",\s*body: \{\}\s*\}\)/);
    assert.match(QUEUE_SOURCE, /drawerCtx\.openNoShow\(itemId, String\(reservationId\)\);/);
    assert.match(QUEUE_SOURCE, /<LifecycleDialog[\s\S]*mode="no_show"/);
    const prev = {
      generatedAt: "2026-09-19T08:00:00.000Z",
      items: [
        { id: "unassigned_r1", priority: "today", kind: "unassigned_arrival", title: "t", context: "c" },
        { id: "vip_r2", priority: "soon", kind: "vip_arriving", title: "t", context: "c" }
      ],
      counts: { unassigned_arrival: 1, vip_arriving: 1 },
      summary: { urgent: 0, today: 1, soon: 1, total: 2 }
    } as unknown as Parameters<typeof queue.removeQueueItem>[0];
    const next = queue.removeQueueItem(prev, "unassigned_r1");
    assert.deepEqual(next.items.map((i) => i.id), ["vip_r2"]);
    assert.equal(next.counts.unassigned_arrival, 0);
    assert.deepEqual(next.summary, { urgent: 0, today: 0, soon: 1, total: 1 });
    assert.equal(queue.removeQueueItem(prev, "nope"), prev, "id desconocido → mismo objeto");
    assert.deepEqual(prev.items.length, 2, "no muta el anterior");
  });
});
