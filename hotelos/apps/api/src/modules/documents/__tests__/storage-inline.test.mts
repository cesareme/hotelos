// Unit tests · Tanda T9 · lote T9-03 — almacén inline (Map + base64).
// Sin base de datos, sin red. Desde apps/api:
//   node --import tsx --test src/modules/documents/__tests__/storage-inline.test.mts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { InlineDocumentStorage, decodeInline, encodeInline } from "../storage/inline-storage.js";
import { createDocumentStorage } from "../storage/index.js";
import { DocumentStorageError, buildStorageKey, isValidStorageKey } from "../storage/storage.js";

const SHA = "a".repeat(64);
const key = buildStorageKey({ organizationId: "org_0123456789abcdef", propertyId: "prop_0123456789abcdef", documentId: "doc_0123456789abcdef", sha256: SHA, ext: "pdf" });

describe("InlineDocumentStorage · put / get / head / delete", () => {
  it("guarda, devuelve los mismos bytes y el sha256 real del contenido", async () => {
    const store = new InlineDocumentStorage();
    const bytes = Buffer.from("%PDF-1.4 demo inline");
    const put = await store.put({ key, bytes, mimeType: "application/pdf" });
    assert.equal(put.key, key);
    assert.equal(put.sizeBytes, bytes.length);
    assert.equal(put.sha256, createHash("sha256").update(bytes).digest("hex"));
    const got = await store.get(key);
    assert.ok(got);
    assert.equal(got.mimeType, "application/pdf");
    assert.ok(got.bytes.equals(bytes));
    assert.deepEqual(await store.head(key), { sizeBytes: bytes.length });
    await store.delete(key);
    assert.equal(await store.get(key), null);
    assert.equal(await store.head(key), null);
    await store.delete(key); // idempotente
  });

  it("las copias devueltas no comparten memoria con el almacén", async () => {
    const store = new InlineDocumentStorage();
    const bytes = Buffer.from("abc");
    await store.put({ key, bytes, mimeType: "application/pdf" });
    bytes[0] = 0x7a;
    const got = await store.get(key);
    assert.equal(got!.bytes.toString(), "abc");
    got!.bytes[1] = 0x7a;
    assert.equal((await store.get(key))!.bytes.toString(), "abc");
  });

  it("rechaza ficheros por encima del tope inline (2 MiB) con 413 DOCUMENT_TOO_LARGE", async () => {
    const store = new InlineDocumentStorage();
    const big = Buffer.alloc(2 * 1024 * 1024 + 1, 1);
    await assert.rejects(store.put({ key, bytes: big, mimeType: "application/pdf" }), (error: unknown) => {
      assert.ok(error instanceof DocumentStorageError);
      assert.equal(error.code, "DOCUMENT_TOO_LARGE");
      assert.equal(error.statusCode, 413);
      return true;
    });
    const exact = Buffer.alloc(2 * 1024 * 1024, 1);
    const ok = await store.put({ key, bytes: exact, mimeType: "application/pdf" });
    assert.equal(ok.sizeBytes, exact.length);
  });

  it("el tope inline nunca supera maxBytes global aunque inlineMaxBytes sea mayor", async () => {
    const store = new InlineDocumentStorage({ inlineMaxBytes: 1024, maxBytes: 100 });
    await assert.rejects(store.put({ key, bytes: Buffer.alloc(101), mimeType: "application/pdf" }), /tamaño máximo/);
  });

  it("rechaza claves que no cumplen la forma org/…/prop/…/doc/…/<sha256>.<ext>", async () => {
    const store = new InlineDocumentStorage();
    for (const bad of ["../etc/passwd", "/org/a/prop/b/doc/c/" + SHA + ".pdf", `org/a/prop/b/doc/c/${SHA}.html`, `org/a/prop/b/doc/c/${SHA.toUpperCase()}.pdf`, "", "org/a/prop/b/doc/../c/x.pdf"]) {
      assert.equal(isValidStorageKey(bad), false, bad);
      await assert.rejects(store.get(bad), (error: unknown) => error instanceof DocumentStorageError && error.code === "DOCUMENT_STORAGE_KEY_INVALID");
    }
  });
});

describe("InlineDocumentStorage · caché de lectura acotada (SEC-04)", () => {
  const keyFor = (n: number) => key.replace("doc_0123456789abcdef", `doc_${String(n).padStart(16, "0")}`);

  it("nunca retiene más de cacheMaxBytes: expulsa las entradas más antiguas (LRU) y las claves expulsadas dejan de resolverse en memoria", async () => {
    const store = new InlineDocumentStorage({ cacheMaxBytes: 100 });
    for (let n = 1; n <= 5; n += 1) await store.put({ key: keyFor(n), bytes: Buffer.alloc(40, n), mimeType: "application/pdf" });
    assert.ok(store.cachedBytes <= 100, `cachedBytes ${store.cachedBytes}`);
    assert.equal(store.size, 2);
    assert.equal(await store.get(keyFor(1)), null, "la más antigua se expulsó");
    assert.ok((await store.get(keyFor(5)))!.bytes.equals(Buffer.alloc(40, 5)), "la última sigue en caché");
    // get refresca la recencia: la clave 4 tocada sobrevive a la siguiente inserción.
    await store.get(keyFor(4));
    await store.put({ key: keyFor(6), bytes: Buffer.alloc(40, 6), mimeType: "application/pdf" });
    assert.ok(await store.get(keyFor(4)));
    assert.equal(await store.get(keyFor(5)), null);
    await store.delete(keyFor(4));
    assert.equal(store.cachedBytes, 40);
  });

  it("un fichero mayor que la caché se sirve (put OK, sha real) sin quedarse en memoria; por defecto la caché es de 8 MiB", async () => {
    const store = new InlineDocumentStorage({ cacheMaxBytes: 10 });
    const put = await store.put({ key, bytes: Buffer.alloc(64, 1), mimeType: "application/pdf" });
    assert.equal(put.sizeBytes, 64);
    assert.equal(store.cachedBytes, 0);
    assert.equal(await store.get(key), null);
    const restored = new InlineDocumentStorage({ cacheMaxBytes: 10 }).restoreInlineRecord({ key, mimeType: "application/pdf", base64: Buffer.alloc(64, 1).toString("base64") });
    assert.equal(restored.sizeBytes, 64);
    assert.equal(new InlineDocumentStorage().cachedBytes, 0);
  });
});

describe("InlineDocumentStorage · serialización base64 para DocumentFile.inline", () => {
  it("toInlineRecord / restoreInlineRecord conservan bytes, mime y sha256", async () => {
    const store = new InlineDocumentStorage();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]);
    await store.put({ key, bytes, mimeType: "image/png" });
    const record = store.toInlineRecord(key);
    assert.ok(record);
    assert.equal(record.base64, bytes.toString("base64"));
    assert.equal(record.sizeBytes, 7);
    assert.ok(decodeInline(encodeInline(bytes)).equals(bytes));

    const other = new InlineDocumentStorage();
    const restored = other.restoreInlineRecord(record);
    assert.equal(restored.sha256, record.sha256);
    assert.ok((await other.get(key))!.bytes.equals(bytes));
    assert.equal(other.toInlineRecord(key.replace("doc_0123456789abcdef", "doc_ffffffffffffffff")), null);
  });

  it("createDocumentStorage({ kind: inline }) devuelve el adaptador inline", async () => {
    const store = createDocumentStorage({ kind: "inline", encryptAtRest: false, maxBytes: 0, inlineMaxBytes: 0 });
    assert.equal(store.kind, "inline");
    assert.ok(store instanceof InlineDocumentStorage);
  });
});
