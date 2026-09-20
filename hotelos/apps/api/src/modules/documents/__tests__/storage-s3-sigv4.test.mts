// Unit tests · Tanda T9 · lote T9-03 — firma SigV4 a mano y adaptador S3
// path-style con fetch simulado. Vectores fijos: los ejemplos públicos de la
// documentación de AWS ("Signature Calculations for the Authorization Header",
// bucket examplebucket, 24/05/2013, credenciales de ejemplo de AWS). Sin red.
//   node --import tsx --test src/modules/documents/__tests__/storage-s3-sigv4.test.mts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { createDocumentStorage } from "../storage/index.js";
import { S3DocumentStorage, type FetchLike } from "../storage/s3-storage.js";
import { EMPTY_PAYLOAD_SHA256, amzDate, signRequest, uriEncode } from "../storage/sigv4.js";
import { DocumentStorageError, buildStorageKey } from "../storage/storage.js";

// Credenciales de EJEMPLO publicadas por AWS en su documentación (no son reales).
const AWS_EXAMPLE_CREDENTIALS = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
const AWS_EXAMPLE_DATE = new Date("2013-05-24T00:00:00Z");

describe("sigv4 · vectores oficiales de AWS (S3, us-east-1)", () => {
  it("GET Object con Range: firma f0e8bdb8…", () => {
    const signed = signRequest({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: { Range: "bytes=0-9" },
      payloadSha256: EMPTY_PAYLOAD_SHA256,
      credentials: AWS_EXAMPLE_CREDENTIALS,
      region: "us-east-1",
      service: "s3",
      date: AWS_EXAMPLE_DATE
    });
    assert.equal(
      signed.canonicalRequest,
      [
        "GET",
        "/test.txt",
        "",
        "host:examplebucket.s3.amazonaws.com",
        "range:bytes=0-9",
        "x-amz-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "x-amz-date:20130524T000000Z",
        "",
        "host;range;x-amz-content-sha256;x-amz-date",
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      ].join("\n")
    );
    assert.equal(signed.stringToSign, ["AWS4-HMAC-SHA256", "20130524T000000Z", "20130524/us-east-1/s3/aws4_request", "7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972"].join("\n"));
    assert.equal(signed.signature, "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
    assert.equal(
      signed.headers.authorization,
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
    );
  });

  it("PUT Object con $ en la clave (codificación URI única) y cabecera x-amz-storage-class: firma 98ad7217…", () => {
    const body = Buffer.from("Welcome to Amazon S3.");
    const payloadSha256 = createHash("sha256").update(body).digest("hex");
    assert.equal(payloadSha256, "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072");
    const signed = signRequest({
      method: "PUT",
      url: new URL("https://examplebucket.s3.amazonaws.com/test$file.text"),
      headers: { Date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" },
      payloadSha256,
      credentials: AWS_EXAMPLE_CREDENTIALS,
      region: "us-east-1",
      date: AWS_EXAMPLE_DATE
    });
    assert.match(signed.canonicalRequest, /^PUT\n\/test%24file\.text\n\n/);
    assert.equal(signed.signedHeaders, "date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class");
    assert.equal(signed.signature, "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
  });

  it("uriEncode sigue las reglas de AWS y amzDate formatea en UTC", () => {
    assert.equal(uriEncode("org/a b/ñ$.pdf", false), "org/a%20b/%C3%B1%24.pdf");
    assert.equal(uriEncode("a/b", true), "a%2Fb");
    assert.equal(uriEncode("A-Z_a.z~09", true), "A-Z_a.z~09");
    assert.deepEqual(amzDate(new Date("2026-09-19T21:05:07.123Z")), { amzDate: "20260919T210507Z", dateStamp: "20260919" });
  });

  it("firma con puerto no estándar y token de sesión (host con puerto, x-amz-security-token firmado)", () => {
    const signed = signRequest({
      method: "HEAD",
      url: new URL("http://127.0.0.1:9000/bucket/k"),
      payloadSha256: EMPTY_PAYLOAD_SHA256,
      credentials: { ...AWS_EXAMPLE_CREDENTIALS, sessionToken: "tok" },
      region: "eu-central-1",
      date: AWS_EXAMPLE_DATE
    });
    assert.equal(signed.headers.host, "127.0.0.1:9000");
    assert.equal(signed.signedHeaders, "host;x-amz-content-sha256;x-amz-date;x-amz-security-token");
    assert.match(signed.headers.authorization!, /eu-central-1\/s3\/aws4_request/);
  });
});

// ---------------------------------------------------------------------------
// Adaptador con fetch simulado
// ---------------------------------------------------------------------------

type Call = { url: string; method: string; headers: Record<string, string>; body?: Uint8Array };

function fakeFetch(handler: (call: Call) => { status: number; body?: Buffer; headers?: Record<string, string> }): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const call: Call = { url, method: init.method, headers: init.headers, ...(init.body ? { body: init.body } : {}) };
    calls.push(call);
    const res = handler(call);
    const headers = new Map(Object.entries(res.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status: res.status,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      arrayBuffer: async () => {
        const b = res.body ?? Buffer.alloc(0);
        const copy = new Uint8Array(b.length);
        copy.set(b);
        return copy.buffer;
      }
    };
  };
  return { fetchImpl, calls };
}

const S3 = { endpoint: "https://s3.eu-central-1.example", region: "eu-central-1", bucket: "ehotelos-documentos-demo", accessKeyId: "DEMOKEY", secretAccessKey: "DEMOSECRET" };
const SHA = "c".repeat(64);
const key = buildStorageKey({ organizationId: "org_0123456789abcdef", propertyId: "prop_0123456789abcdef", documentId: "doc_0123456789abcdef", sha256: SHA, ext: "pdf" });

describe("S3DocumentStorage · path-style, cabeceras y errores tipados", () => {
  it("PUT: URL path-style, content-type, SSE AES256, x-amz-content-sha256 del cuerpo y Authorization", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200 }));
    const store = new S3DocumentStorage({ s3: S3, fetchImpl, now: () => AWS_EXAMPLE_DATE });
    const bytes = Buffer.from("%PDF-1.4 demo s3");
    const put = await store.put({ key, bytes, mimeType: "application/pdf" });
    assert.equal(put.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.method, "PUT");
    assert.equal(call.url, `https://s3.eu-central-1.example/ehotelos-documentos-demo/${key}`);
    assert.equal(call.headers["content-type"], "application/pdf");
    assert.equal(call.headers["x-amz-server-side-encryption"], "AES256");
    assert.equal(call.headers["x-amz-content-sha256"], put.sha256);
    assert.equal(call.headers["x-amz-date"], "20130524T000000Z");
    assert.equal(call.headers.host, "s3.eu-central-1.example");
    assert.match(call.headers.authorization!, /^AWS4-HMAC-SHA256 Credential=DEMOKEY\/20130524\/eu-central-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-server-side-encryption, Signature=[0-9a-f]{64}$/);
    assert.ok(call.body && Buffer.from(call.body).equals(bytes));
  });

  it("sin SSE no se envía la cabecera de cifrado del proveedor", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200 }));
    const store = new S3DocumentStorage({ s3: S3, fetchImpl, sse: false });
    await store.put({ key, bytes: Buffer.from("x"), mimeType: "application/pdf" });
    assert.equal(calls[0]!.headers["x-amz-server-side-encryption"], undefined);
  });

  it("GET 200 devuelve bytes y mime por extensión; GET/HEAD 404 → null; DELETE 404 → ok", async () => {
    const payload = Buffer.from("%PDF-1.4 bytes");
    const { fetchImpl, calls } = fakeFetch((call) => {
      if (call.method === "GET") return { status: call.url.endsWith(key) ? 200 : 404, body: payload };
      if (call.method === "HEAD") return { status: 200, headers: { "Content-Length": String(payload.length) } };
      return { status: 404 };
    });
    const store = new S3DocumentStorage({ s3: S3, fetchImpl });
    const got = await store.get(key);
    assert.ok(got!.bytes.equals(payload));
    assert.equal(got!.mimeType, "application/pdf");
    assert.equal(calls[0]!.headers["x-amz-content-sha256"], EMPTY_PAYLOAD_SHA256);
    assert.deepEqual(await store.head(key), { sizeBytes: payload.length });
    await store.delete(key); // 404 tolerado
    const missing = key.replace("doc_0123456789abcdef", "doc_ffffffffffffffff");
    assert.equal(await store.get(missing), null);
  });

  it("403 → DOCUMENT_STORAGE_FORBIDDEN (502), otros → DOCUMENT_STORAGE_UPSTREAM con upstreamStatus, fallo de red → DOCUMENT_STORAGE_IO", async () => {
    const forbidden = new S3DocumentStorage({ s3: S3, fetchImpl: fakeFetch(() => ({ status: 403 })).fetchImpl });
    await assert.rejects(forbidden.put({ key, bytes: Buffer.from("x"), mimeType: "application/pdf" }), (error: unknown) => {
      assert.ok(error instanceof DocumentStorageError);
      assert.equal(error.code, "DOCUMENT_STORAGE_FORBIDDEN");
      assert.equal(error.statusCode, 502);
      assert.equal(error.upstreamStatus, 403);
      return true;
    });
    const broken = new S3DocumentStorage({ s3: S3, fetchImpl: fakeFetch(() => ({ status: 500 })).fetchImpl });
    await assert.rejects(broken.get(key), (error: unknown) => error instanceof DocumentStorageError && error.code === "DOCUMENT_STORAGE_UPSTREAM" && error.upstreamStatus === 500);
    await assert.rejects(broken.delete(key), (error: unknown) => error instanceof DocumentStorageError && error.code === "DOCUMENT_STORAGE_UPSTREAM");
    const offline = new S3DocumentStorage({
      s3: S3,
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      }
    });
    await assert.rejects(offline.head(key), (error: unknown) => error instanceof DocumentStorageError && error.code === "DOCUMENT_STORAGE_IO");
  });

  it("SEC-07: GET rechaza un cuerpo por encima de maxBytes (content-length anunciado o real) con DOCUMENT_STORAGE_UPSTREAM y toda petición lleva AbortSignal con tiempo límite", async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      signals.push(init.signal);
      const headers = new Map(Object.entries({ "content-length": init.method === "HEAD" ? "5" : "999999" }));
      return { status: 200, headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null }, arrayBuffer: async () => new Uint8Array(5).buffer };
    };
    const store = new S3DocumentStorage({ s3: S3, fetchImpl, maxBytes: 1000, requestTimeoutMs: 1234 });
    await assert.rejects(store.get(key), (error: unknown) => error instanceof DocumentStorageError && error.code === "DOCUMENT_STORAGE_UPSTREAM" && /999999 bytes/.test(error.message));
    assert.ok(signals[0] instanceof AbortSignal, "la petición lleva señal de tiempo límite");
    assert.deepEqual(await store.head(key), { sizeBytes: 5 });

    const oversized: FetchLike = async () => ({ status: 200, headers: { get: () => null }, arrayBuffer: async () => new Uint8Array(1001).buffer });
    await assert.rejects(new S3DocumentStorage({ s3: S3, fetchImpl: oversized, maxBytes: 1000 }).get(key), (error: unknown) => error instanceof DocumentStorageError && error.code === "DOCUMENT_STORAGE_UPSTREAM");
    const fits: FetchLike = async () => ({ status: 200, headers: { get: () => null }, arrayBuffer: async () => new Uint8Array(1000).buffer });
    assert.equal((await new S3DocumentStorage({ s3: S3, fetchImpl: fits, maxBytes: 1000 }).get(key))!.bytes.length, 1000);

    const noTimeout: FetchLike = async (_url, init) => {
      signals.push(init.signal);
      return { status: 200, headers: { get: () => null }, arrayBuffer: async () => new Uint8Array(0).buffer };
    };
    await new S3DocumentStorage({ s3: S3, fetchImpl: noTimeout, requestTimeoutMs: 0 }).get(key);
    assert.equal(signals[signals.length - 1], undefined, "requestTimeoutMs 0 desactiva la señal");
  });

  it("valida la configuración (endpoint URL, bucket, credenciales) y las claves", () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 200 }));
    assert.throws(() => new S3DocumentStorage({ s3: { ...S3, endpoint: "no-url" }, fetchImpl }), (error: unknown) => error instanceof DocumentStorageError && error.code === "DOCUMENT_STORAGE_CONFIG_INVALID");
    assert.throws(() => new S3DocumentStorage({ s3: { ...S3, bucket: "Mayúsculas" }, fetchImpl }), DocumentStorageError);
    assert.throws(() => new S3DocumentStorage({ s3: { ...S3, secretAccessKey: "" }, fetchImpl }), DocumentStorageError);
    const store = new S3DocumentStorage({ s3: S3, fetchImpl });
    assert.throws(() => store.objectUrl("../x"), (error: unknown) => error instanceof DocumentStorageError && error.code === "DOCUMENT_STORAGE_KEY_INVALID");
    assert.throws(() => createDocumentStorage({ kind: "s3", encryptAtRest: true, maxBytes: 1, inlineMaxBytes: 1 }), (error: unknown) => error instanceof DocumentStorageError && error.code === "DOCUMENT_STORAGE_CONFIG_INVALID");
    const built = createDocumentStorage({ kind: "s3", s3: S3, encryptAtRest: true, maxBytes: 1, inlineMaxBytes: 1 }, { fetchImpl });
    assert.equal(built.kind, "s3");
  });
});
