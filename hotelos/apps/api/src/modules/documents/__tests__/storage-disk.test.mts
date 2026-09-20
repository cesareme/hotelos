// Unit tests · Tanda T9 · lote T9-03 — almacén en disco (rutas saneadas,
// escritura atómica, cifrado en reposo AES-256-GCM con cabecera EHD1).
// Directorio temporal propio por prueba; sin base de datos, sin red.
//   node --import tsx --test src/modules/documents/__tests__/storage-disk.test.mts
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { AT_REST_OVERHEAD_BYTES, decryptAtRest, encryptAtRest, isAtRestEnvelope, parseFieldKey } from "../storage/at-rest-encryption.js";
import { DiskDocumentStorage } from "../storage/disk-storage.js";
import { createDocumentStorage } from "../storage/index.js";
import { DocumentStorageError, buildStorageKey } from "../storage/storage.js";

const SHA = "b".repeat(64);
const key = buildStorageKey({ organizationId: "org_0123456789abcdef", propertyId: "prop_0123456789abcdef", documentId: "doc_0123456789abcdef", sha256: SHA, ext: "png" });
const FIELD_KEY = randomBytes(32).toString("base64");
const dirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ehotelos-docs-"));
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("DiskDocumentStorage · sin cifrado", () => {
  it("escribe bajo dir con la clave como ruta, crea directorios y devuelve sha256/tamaño", async () => {
    const dir = tmp();
    const store = new DiskDocumentStorage({ dir, encryptAtRest: false });
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const put = await store.put({ key, bytes, mimeType: "image/png" });
    assert.equal(put.sizeBytes, 7);
    assert.equal(put.sha256.length, 64);
    const onDisk = readFileSync(join(dir, key));
    assert.ok(onDisk.equals(bytes), "en claro cuando encryptAtRest=false");
    const got = await store.get(key);
    assert.equal(got!.mimeType, "image/png");
    assert.ok(got!.bytes.equals(bytes));
    assert.deepEqual(await store.head(key), { sizeBytes: 7 });
    await store.delete(key);
    assert.equal(existsSync(join(dir, key)), false);
    assert.equal(await store.get(key), null);
    assert.equal(await store.head(key), null);
  });

  it("no deja ficheros temporales tras escribir (tmp + rename)", async () => {
    const dir = tmp();
    const store = new DiskDocumentStorage({ dir, encryptAtRest: false });
    await store.put({ key, bytes: Buffer.from("x"), mimeType: "image/png" });
    const leaf = readdirSync(join(dir, key.slice(0, key.lastIndexOf("/"))));
    assert.deepEqual(leaf, [`${SHA}.png`]);
  });

  it("sobrescribir la misma clave es atómico: el contenido final es el último escrito", async () => {
    const dir = tmp();
    const store = new DiskDocumentStorage({ dir, encryptAtRest: false });
    await Promise.all([store.put({ key, bytes: Buffer.alloc(64, 1), mimeType: "image/png" }), store.put({ key, bytes: Buffer.alloc(64, 2), mimeType: "image/png" })]);
    const got = await store.get(key);
    assert.equal(got!.bytes.length, 64);
    assert.ok(got!.bytes.every((b) => b === got!.bytes[0]), "nunca una mezcla de dos escrituras");
  });

  it("rechaza claves inválidas, absolutas o con .. sin tocar el disco", async () => {
    const dir = tmp();
    const store = new DiskDocumentStorage({ dir, encryptAtRest: false });
    for (const bad of ["../x.pdf", `/org/a/prop/b/doc/c/${SHA}.pdf`, `org/a/prop/b/doc/../c/${SHA}.pdf`, `org/a\\prop/b/doc/c/${SHA}.pdf`, `org/a/prop/b/doc/c/${SHA}.exe`]) {
      await assert.rejects(store.put({ key: bad, bytes: Buffer.from("x"), mimeType: "application/pdf" }), (error: unknown) => error instanceof DocumentStorageError && error.code === "DOCUMENT_STORAGE_KEY_INVALID");
      assert.throws(() => store.resolvePath(bad), DocumentStorageError);
    }
    assert.deepEqual(readdirSync(dir), []);
  });

  it("aplica maxBytes", async () => {
    const store = new DiskDocumentStorage({ dir: tmp(), encryptAtRest: false, maxBytes: 10 });
    await assert.rejects(store.put({ key, bytes: Buffer.alloc(11), mimeType: "image/png" }), (error: unknown) => error instanceof DocumentStorageError && error.code === "DOCUMENT_TOO_LARGE");
  });
});

describe("DiskDocumentStorage · cifrado en reposo", () => {
  it("con encryptAtRest el fichero en disco es un sobre EHD1 y get() devuelve el claro", async () => {
    const dir = tmp();
    const store = new DiskDocumentStorage({ dir, encryptAtRest: true, fieldKeyBase64: FIELD_KEY });
    assert.equal(store.encrypts, true);
    const bytes = Buffer.from("%PDF-1.4 contenido confidencial de demo");
    const put = await store.put({ key: key.replace(".png", ".pdf"), bytes, mimeType: "application/pdf" });
    const onDisk = readFileSync(join(dir, key.replace(".png", ".pdf")));
    assert.ok(isAtRestEnvelope(onDisk));
    assert.equal(onDisk.length, bytes.length + AT_REST_OVERHEAD_BYTES);
    assert.ok(!onDisk.includes(Buffer.from("confidencial")), "el claro no aparece en disco");
    const got = await store.get(key.replace(".png", ".pdf"));
    assert.ok(got!.bytes.equals(bytes));
    assert.equal(got!.mimeType, "application/pdf");
    assert.deepEqual(await store.head(key.replace(".png", ".pdf")), { sizeBytes: bytes.length }, "head devuelve el tamaño del claro");
    assert.equal(put.sha256, (await store.put({ key, bytes, mimeType: "image/png" })).sha256, "sha256 siempre del claro");
  });

  it("un almacén con clave lee ficheros en claro anteriores (activar el flag no rompe lo escrito)", async () => {
    const dir = tmp();
    const plain = new DiskDocumentStorage({ dir, encryptAtRest: false });
    await plain.put({ key, bytes: Buffer.from("antes"), mimeType: "image/png" });
    const encrypted = new DiskDocumentStorage({ dir, encryptAtRest: true, fieldKeyBase64: FIELD_KEY });
    assert.equal((await encrypted.get(key))!.bytes.toString(), "antes");
    assert.deepEqual(await encrypted.head(key), { sizeBytes: 5 });
  });

  it("otra clave no descifra (DOCUMENT_STORAGE_CIPHERTEXT_INVALID) y sin clave el fichero cifrado no se sirve", async () => {
    const dir = tmp();
    const a = new DiskDocumentStorage({ dir, encryptAtRest: true, fieldKeyBase64: FIELD_KEY });
    await a.put({ key, bytes: Buffer.from("secreto"), mimeType: "image/png" });
    const b = new DiskDocumentStorage({ dir, encryptAtRest: true, fieldKeyBase64: randomBytes(32).toString("base64") });
    await assert.rejects(b.get(key), (error: unknown) => error instanceof DocumentStorageError && error.code === "DOCUMENT_STORAGE_CIPHERTEXT_INVALID");
    const none = new DiskDocumentStorage({ dir, encryptAtRest: false });
    await assert.rejects(none.get(key), (error: unknown) => error instanceof DocumentStorageError && error.code === "DOCUMENT_STORAGE_CIPHERTEXT_INVALID");
  });

  it("encryptAtRest sin clave válida no arranca (fail fast)", () => {
    for (const bad of [undefined, "", "no-es-base64!", Buffer.alloc(16).toString("base64"), Buffer.alloc(33).toString("base64")]) {
      assert.throws(() => new DiskDocumentStorage({ dir: tmp(), encryptAtRest: true, fieldKeyBase64: bad }), (error: unknown) => error instanceof DocumentStorageError && error.code === "DOCUMENT_STORAGE_KEY_MALFORMED");
    }
    assert.throws(() => new DiskDocumentStorage({ dir: "", encryptAtRest: false }), (error: unknown) => error instanceof DocumentStorageError && error.code === "DOCUMENT_STORAGE_CONFIG_INVALID");
  });

  it("primitivas: sobre EHD1 = magic | iv(12) | tag(16) | cifrado; manipular un byte invalida", () => {
    const k = parseFieldKey(FIELD_KEY);
    const envelope = encryptAtRest(Buffer.from("hola"), k);
    assert.equal(envelope.subarray(0, 4).toString("latin1"), "EHD1");
    assert.equal(envelope.length, 4 + 12 + 16 + 4);
    assert.equal(decryptAtRest(envelope, k).toString(), "hola");
    const tampered = Buffer.from(envelope);
    tampered[tampered.length - 1] ^= 0x01;
    assert.throws(() => decryptAtRest(tampered, k), (error: unknown) => error instanceof DocumentStorageError && error.code === "DOCUMENT_STORAGE_CIPHERTEXT_INVALID");
    assert.notEqual(encryptAtRest(Buffer.from("hola"), k).toString("hex"), envelope.toString("hex"), "iv aleatorio por objeto");
  });

  it("createDocumentStorage({ kind: disk }) monta el adaptador con la clave", async () => {
    const store = createDocumentStorage({ kind: "disk", dir: tmp(), encryptAtRest: true, fieldKeyBase64: FIELD_KEY, maxBytes: 1024, inlineMaxBytes: 0 });
    assert.equal(store.kind, "disk");
    assert.ok(store instanceof DiskDocumentStorage && store.encrypts);
  });
});
