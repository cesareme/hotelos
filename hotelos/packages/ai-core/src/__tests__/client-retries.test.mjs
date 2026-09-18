// Cliente Anthropic sobre fetch: reintentos en 429/5xx/red, nunca en 4xx,
// retry-after, timeout por intento, cabeceras y rutas. Sin red: fetch simulado.
//
// Run from the package directory: corepack pnpm --filter @hotelos/ai-core test

import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_RETRIES, RETRY_AFTER_CAP_MS, createAnthropicClient, parseRetryAfter, retryDelayMs } from "../client.ts";
import { AiError } from "../errors.ts";

globalThis.fetch = () => {
  throw new Error("red prohibida");
};

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
function okMessage(text = "hola") {
  return json(200, { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } });
}
function providerError(status, type, headers = {}) {
  return json(status, { type: "error", error: { type, message: `simulado ${status}` } }, headers);
}
function fakeFetch(responders) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined, signal: init.signal });
    const next = responders.shift();
    if (next === undefined) throw new Error("sin respuesta simulada");
    return typeof next === "function" ? next() : next;
  };
  return { impl, calls };
}
function harness(responders, extra = {}) {
  const sleeps = [];
  const { impl, calls } = fakeFetch(responders);
  const client = createAnthropicClient({ apiKey: "sk-test", fetchImpl: impl, sleep: async (ms) => void sleeps.push(ms), now: () => 1_700_000_000_000, random: () => 0, ...extra });
  return { client, calls, sleeps };
}
const BODY = { model: "claude-sonnet-5", max_tokens: 20, messages: [{ role: "user", content: "hola" }] };

test("429 con retry-after → espera lo indicado, reintenta y acierta; cabeceras y ruta correctas", async () => {
  const { client, calls, sleeps } = harness([providerError(429, "rate_limit_error", { "retry-after": "2" }), okMessage("ok")]);
  const response = await client.createMessage(BODY, { timeoutMs: 1000 });
  assert.equal(response.content[0].text, "ok");
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [2000]);
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers["x-api-key"], "sk-test");
  assert.equal(calls[0].headers["anthropic-version"], "2023-06-01");
  assert.equal(calls[0].headers["content-type"], "application/json");
  assert.deepEqual(calls[0].body, BODY);
});

test("500, 502, 503, 504 y 529 reintentan con backoff exponencial (500 ms · 2^n, jitter 0)", async () => {
  for (const status of [500, 502, 503, 504, 529]) {
    const { client, calls, sleeps } = harness([providerError(status, "api_error"), providerError(status, "overloaded_error"), okMessage()]);
    await client.createMessage(BODY, { timeoutMs: 1000 });
    assert.equal(calls.length, 3, `HTTP ${status}`);
    assert.deepEqual(sleeps, [500, 1000], `HTTP ${status}`);
  }
});

test("máximo 3 intentos: tras el tercer 503 lanza AiError provider_error retryable con providerType", async () => {
  const { client, calls } = harness([providerError(503, "overloaded_error"), providerError(503, "overloaded_error"), providerError(503, "overloaded_error"), okMessage()]);
  await assert.rejects(client.createMessage(BODY, { timeoutMs: 1000 }), (error) => {
    assert.ok(error instanceof AiError);
    assert.equal(error.code, "provider_error");
    assert.equal(error.retryable, true);
    assert.equal(error.status, 503);
    assert.equal(error.providerType, "overloaded_error");
    return true;
  });
  assert.equal(calls.length, MAX_RETRIES + 1);
});

test("429 agotado → AiError rate_limited con retryAfterMs", async () => {
  const { client } = harness([providerError(429, "rate_limit_error", { "retry-after": "1" }), providerError(429, "rate_limit_error"), providerError(429, "rate_limit_error", { "retry-after": "7" })]);
  await assert.rejects(client.createMessage(BODY, { timeoutMs: 1000 }), (error) => {
    assert.equal(error.code, "rate_limited");
    assert.equal(error.status, 429);
    assert.equal(error.retryAfterMs, 7000);
    return true;
  });
});

test("429 con retry-after por encima del tope de 30 s → sin espera ni reintento: rate_limited con el retryAfterMs real (CFC-10)", async () => {
  const { client, calls, sleeps } = harness([providerError(429, "rate_limit_error", { "retry-after": "90" }), okMessage("nunca")]);
  await assert.rejects(client.createMessage(BODY, { timeoutMs: 1000 }), (error) => {
    assert.ok(error instanceof AiError);
    assert.equal(error.code, "rate_limited");
    assert.equal(error.retryAfterMs, 90_000);
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(calls.length, 1, "un retry-after de 90 s no se recorta a 30 s ni se reintenta");
  assert.deepEqual(sleeps, []);
});

test("400, 401, 402, 403, 404 y 413 NO reintentan: AiError provider_error retryable:false con providerType del cuerpo", async () => {
  const cases = [
    [400, "invalid_request_error"],
    [401, "authentication_error"],
    [402, "billing_error"],
    [403, "permission_error"],
    [404, "not_found_error"],
    [413, "request_too_large"]
  ];
  for (const [status, type] of cases) {
    const { client, calls, sleeps } = harness([providerError(status, type), okMessage()]);
    await assert.rejects(client.createMessage(BODY, { timeoutMs: 1000 }), (error) => {
      assert.ok(error instanceof AiError, `HTTP ${status}`);
      assert.equal(error.code, "provider_error");
      assert.equal(error.retryable, false);
      assert.equal(error.status, status);
      assert.equal(error.providerType, type);
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      return true;
    });
    assert.equal(calls.length, 1, `HTTP ${status}`);
    assert.deepEqual(sleeps, [], `HTTP ${status}`);
  }
});

test("fallo de red (TypeError de fetch) reintenta y acierta; agotado → provider_error retryable", async () => {
  const { client, calls, sleeps } = harness([() => Promise.reject(new TypeError("fetch failed")), okMessage("tras red")]);
  const response = await client.createMessage(BODY, { timeoutMs: 1000 });
  assert.equal(response.content[0].text, "tras red");
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [500]);

  const exhausted = harness([() => Promise.reject(new TypeError("fetch failed")), () => Promise.reject(new TypeError("fetch failed")), () => Promise.reject(new TypeError("fetch failed"))]);
  await assert.rejects(exhausted.client.createMessage(BODY, { timeoutMs: 1000 }), (error) => error.code === "provider_error" && error.retryable === true);
  assert.equal(exhausted.calls.length, 3);
});

test("timeout por intento: AiError timeout sin reintento", async () => {
  const calls = [];
  const impl = (url, init) =>
    new Promise((_, reject) => {
      calls.push(url);
      init.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
  const client = createAnthropicClient({ apiKey: "sk-test", fetchImpl: impl, sleep: async () => undefined });
  await assert.rejects(client.createMessage(BODY, { timeoutMs: 20 }), (error) => {
    assert.ok(error instanceof AiError);
    assert.equal(error.code, "timeout");
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(calls.length, 1);
});

test("beforeAttempt se invoca antes de cada intento y su excepción corta la llamada sin fetch", async () => {
  const attempts = [];
  const { client, calls } = harness([providerError(529, "overloaded_error"), okMessage()]);
  await client.createMessage(BODY, { timeoutMs: 1000, beforeAttempt: (n) => void attempts.push(n) });
  assert.deepEqual(attempts, [0, 1]);
  assert.equal(calls.length, 2);

  const blocked = harness([okMessage()]);
  await assert.rejects(
    blocked.client.createMessage(BODY, {
      timeoutMs: 1000,
      beforeAttempt: () => {
        throw new AiError("rate_limited", "bloqueado", { retryable: true, retryAfterMs: 10 });
      }
    }),
    (error) => error.code === "rate_limited"
  );
  assert.equal(blocked.calls.length, 0);
});

test("respuesta 200 sin content/usage → provider_error no reintentable", async () => {
  const { client } = harness([json(200, { id: "x" })]);
  await assert.rejects(client.createMessage(BODY, { timeoutMs: 1000 }), (error) => error.code === "provider_error" && error.retryable === false);
});

test("countTokens y getModel usan sus rutas y métodos", async () => {
  const { client, calls } = harness([json(200, { input_tokens: 42 }), json(200, { id: "claude-sonnet-5", type: "model", display_name: "Claude Sonnet 5" })]);
  const count = await client.countTokens({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hola" }] });
  assert.equal(count.input_tokens, 42);
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages/count_tokens");
  assert.equal(calls[0].method, "POST");
  const model = await client.getModel("claude-sonnet-5");
  assert.equal(model.display_name, "Claude Sonnet 5");
  assert.equal(calls[1].url, "https://api.anthropic.com/v1/models/claude-sonnet-5");
  assert.equal(calls[1].method, "GET");
  assert.equal(calls[1].body, undefined);
  assert.equal("content-type" in calls[1].headers, false);
});

test("parseRetryAfter (segundos y fecha HTTP) y retryDelayMs con tope de 30 s", () => {
  const now = 1_700_000_000_000;
  assert.equal(parseRetryAfter("3", now), 3000);
  assert.equal(parseRetryAfter("0.5", now), 500);
  assert.equal(parseRetryAfter(new Date(now + 5000).toUTCString(), now), 5000);
  assert.equal(parseRetryAfter(new Date(now - 5000).toUTCString(), now), 0);
  assert.equal(parseRetryAfter("mañana", now), null);
  assert.equal(parseRetryAfter(null, now), null);
  assert.equal(retryDelayMs(0, null, () => 0), 500);
  assert.equal(retryDelayMs(1, null, () => 0), 1000);
  assert.equal(retryDelayMs(1, null, () => 0.999), 1249);
  assert.equal(retryDelayMs(0, 60_000, () => 0), RETRY_AFTER_CAP_MS);
  assert.equal(retryDelayMs(0, 100, () => 0), 100);
});
