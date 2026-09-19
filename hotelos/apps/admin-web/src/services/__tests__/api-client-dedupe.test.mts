// Tanda UX-1 · lote U3 · services/api-client.ts: dedupe de GET idénticos en
// vuelo y soporte de `signal` por interesado (docs/design/UX-RECEPCION-FEEL.md
// §2.3 «capa de datos», §4.1). Sin red: `globalThis.fetch` es un doble que
// registra llamadas y contesta cuando el test lo decide. Desde apps/admin-web:
//   corepack pnpm --filter @hotelos/admin-web test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// api-client.ts lee `import.meta.env` al cargar (Vite): se sustituye solo ese
// módulo por su fuente sin tipos precedida de `import.meta.env ??= {}`.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("/src/services/api-client.ts")) {
      const source = stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), { mode: "strip" });
      return { format: "module", source: `import.meta.env ??= {};\n${source}`, shortCircuit: true };
    }
    return nextLoad(url, context);
  }
});

type FetchCall = { url: string; method: string; signal: AbortSignal | null | undefined; resolve: (body: unknown, status?: number) => void };

const calls: FetchCall[] = [];
let autoLogin = true;

globalThis.fetch = ((input: string | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  // Sin sesión en Node, apiRequest hace el login de demo: se contesta al vuelo.
  if (autoLogin && url.endsWith("/auth/login")) {
    return Promise.resolve(new Response(JSON.stringify({ token: "t-demo", user: { permissions: [] } }), { status: 200, headers: { "Content-Type": "application/json" } }));
  }
  return new Promise<Response>((resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    calls.push({
      url,
      method,
      signal,
      resolve: (body, status = 200) => resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }))
    });
  });
}) as typeof fetch;

const client = await import("../api-client.ts");

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const gets = () => calls.filter((c) => c.method === "GET");

beforeEach(() => {
  calls.length = 0;
});

describe("api-client · dedupe de GET en vuelo", () => {
  it("dos GET idénticos concurrentes comparten una sola llamada a fetch y reciben la misma respuesta", async () => {
    const a = client.apiRequest<{ n: number }>("/rooms", { query: { propertyId: "prop_x" } });
    const b = client.apiRequest<{ n: number }>("/rooms", { query: { propertyId: "prop_x" } });
    await tick();
    assert.equal(gets().length, 1, "una sola petición de red");
    assert.equal(client.inflightGetCount(), 1);
    gets()[0].resolve({ n: 7 });
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra, rb);
    assert.deepEqual(ra, { n: 7 });
    assert.equal(client.inflightGetCount(), 0);
    // Terminada la primera, la siguiente vuelve a la red.
    const c = client.apiRequest<{ n: number }>("/rooms", { query: { propertyId: "prop_x" } });
    await tick();
    assert.equal(gets().length, 2);
    gets()[1].resolve({ n: 8 });
    assert.deepEqual(await c, { n: 8 });
  });

  it("URL, query, keepSessionOn401 o método distintos no se comparten; POST nunca", async () => {
    const p1 = client.apiRequest("/rooms", { query: { a: 1 } });
    const p2 = client.apiRequest("/rooms", { query: { a: 2 } });
    const p3 = client.apiRequest("/rooms", { query: { a: 1 }, keepSessionOn401: true });
    const p4 = client.apiRequest("/reservations/r1/assign-room", { method: "POST", body: { roomId: "x" } });
    const p5 = client.apiRequest("/reservations/r1/assign-room", { method: "POST", body: { roomId: "x" } });
    await tick();
    assert.equal(calls.length, 5);
    assert.equal(client.inflightGetCount(), 3, "dos query distintas + keepSessionOn401 = tres claves GET; los POST no entran");
    for (const call of calls) call.resolve({ ok: true });
    await Promise.all([p1, p2, p3, p4, p5]);
    assert.equal(client.inflightGetCount(), 0);
  });

  it("abortar un interesado no cancela la red mientras otro espere; cuando no queda nadie, sí", async () => {
    const ca = new AbortController();
    const cb = new AbortController();
    const a = client.apiRequest("/slow", { signal: ca.signal });
    const b = client.apiRequest("/slow", { signal: cb.signal });
    await tick();
    assert.equal(gets().length, 1);
    ca.abort();
    await assert.rejects(a, (error: unknown) => (error as { name?: string }).name === "AbortError");
    assert.equal(gets()[0].signal?.aborted, false, "B sigue esperando");
    gets()[0].resolve({ slow: true });
    assert.deepEqual(await b, { slow: true });

    const cc = new AbortController();
    const cd = new AbortController();
    const c = client.apiRequest("/slow", { signal: cc.signal });
    const d = client.apiRequest("/slow", { signal: cd.signal });
    await tick();
    assert.equal(gets().length, 2);
    cc.abort();
    cd.abort();
    await assert.rejects(c, (error: unknown) => (error as { name?: string }).name === "AbortError");
    await assert.rejects(d, (error: unknown) => (error as { name?: string }).name === "AbortError");
    await tick();
    assert.equal(gets()[1].signal?.aborted, true, "sin interesados la petición compartida se aborta");
    assert.equal(client.inflightGetCount(), 0);
  });

  it("un fallo HTTP llega a todos los interesados como ApiError con el estado", async () => {
    const a = client.apiRequest("/broken");
    const b = client.apiRequest("/broken");
    await tick();
    gets()[0].resolve({ message: "Propiedad no encontrada." }, 404);
    for (const promise of [a, b]) {
      await assert.rejects(promise, (error: unknown) => error instanceof client.ApiError && error.status === 404 && error.message === "Propiedad no encontrada.");
    }
    assert.equal(client.inflightGetCount(), 0);
  });

  it("el GET compartido envía el token y la cabecera de propiedad activa una sola vez", async () => {
    const a = client.apiRequest("/users/me/properties");
    await tick();
    assert.equal(gets().length, 1);
    assert.match(gets()[0].url, /\/users\/me\/properties$/);
    gets()[0].resolve([]);
    assert.deepEqual(await a, []);
  });
});
