// Unit tests · Tanda CHK · lote W3-C — adaptadores de hardware del kiosco
// (modules/checkin/adapters/*): lector de MRZ, codificador de tarjetas y
// cerraduras con contrato + none honesto + sandbox, y resolveHardware por
// capacidades y modo. Sin base de datos, sin red, sin proveedor. Desde apps/api:
//   node --import tsx --test src/modules/checkin/__tests__/hardware-adapters.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CARD_ENCODER_PROVIDERS,
  CARD_PICKUP_MESSAGE,
  KEY_PICKUP_MESSAGE,
  LOCK_PROVIDERS,
  bufferedMrzReader,
  hardwareModeFor,
  noneCardEncoder,
  noneLock,
  noneMrzReader,
  normalizeLockProvider,
  normalizeMrzText,
  resolveHardware,
  sandboxCardEncoder,
  sandboxLock
} from "../adapters/index.js";

const WINDOW = { validFrom: "2026-09-19T14:00:00.000Z", validUntil: "2026-09-21T12:00:00.000Z" };
const NOW = new Date("2026-09-19T15:00:00.000Z");

describe("none es honesto", () => {
  it("el lector none nunca lee nada", async () => {
    assert.equal(noneMrzReader.kind, "none");
    assert.equal(await noneMrzReader.read(), null);
    assert.equal(await noneMrzReader.read(), null);
  });

  it("el codificador none responde unavailable con «recoge tu tarjeta en recepción» y sin cardId", async () => {
    assert.equal(noneCardEncoder.provider, "none");
    const result = await noneCardEncoder.encode({ roomNumber: "204", ...WINDOW });
    assert.deepEqual(result, { status: "unavailable", provider: "none", message: CARD_PICKUP_MESSAGE });
    assert.equal("cardId" in result, false);
    assert.match(CARD_PICKUP_MESSAGE, /recepción/);
  });

  it("la cerradura none no emite llave y revoke devuelve false", async () => {
    assert.equal(noneLock.provider, "none");
    const key = await noneLock.issueMobileKey({ reservationId: "res_1", roomNumber: "204", ...WINDOW });
    assert.deepEqual(key, { status: "unavailable", provider: "none", message: KEY_PICKUP_MESSAGE });
    assert.deepEqual(await noneLock.revoke("cualquiera"), { revoked: false });
  });

  it("none también valida la entrada: ventana no positiva o habitación vacía lanzan (error del llamador, no un unavailable)", async () => {
    await assert.rejects(noneCardEncoder.encode({ roomNumber: "204", validFrom: WINDOW.validUntil, validUntil: WINDOW.validFrom }), /validUntil debe ser posterior/);
    await assert.rejects(noneCardEncoder.encode({ roomNumber: "204", validFrom: "ayer", validUntil: WINDOW.validUntil }), /ISO 8601/);
    await assert.rejects(noneCardEncoder.encode({ roomNumber: " ", ...WINDOW }), /habitación/);
    await assert.rejects(noneLock.issueMobileKey({ reservationId: "", roomNumber: "204", ...WINDOW }), /reservationId/);
  });
});

describe("sandbox codifica y revoca", () => {
  it("el codificador sandbox devuelve encoded con cardId sandbox_<provider>_… y la fecha inyectada", async () => {
    const encoder = sandboxCardEncoder("assa_vostio", { now: () => NOW });
    const first = await encoder.encode({ roomNumber: "204", ...WINDOW, reservationId: "res_1" });
    assert.equal(first.status, "encoded");
    if (first.status !== "encoded") throw new Error("unreachable");
    assert.equal(first.provider, "assa_vostio");
    assert.equal(first.cardId, "sandbox_assa_vostio_0001");
    assert.equal(first.roomNumber, "204");
    assert.equal(first.validUntil, WINDOW.validUntil);
    assert.equal(first.encodedAt, NOW.toISOString());
    const second = await encoder.encode({ roomNumber: "205", ...WINDOW });
    assert.equal(second.status === "encoded" && second.cardId, "sandbox_assa_vostio_0002");
    assert.deepEqual(encoder.issued(), ["sandbox_assa_vostio_0001", "sandbox_assa_vostio_0002"]);
    assert.equal(sandboxCardEncoder().provider, "salto_space");
    assert.deepEqual([...CARD_ENCODER_PROVIDERS], ["none", "salto_space", "assa_vostio", "dormakaba"]);
  });

  it("el sandbox también rechaza ventanas inválidas", async () => {
    const encoder = sandboxCardEncoder("dormakaba");
    await assert.rejects(encoder.encode({ roomNumber: "204", validFrom: WINDOW.validFrom, validUntil: WINDOW.validFrom }), /posterior/);
    assert.deepEqual(encoder.issued(), []);
  });

  it("la cerradura sandbox emite llaves sandbox_… con QR de demo y revoca solo lo que emitió, una vez", async () => {
    const lock = sandboxLock("salto_space", { now: () => NOW, nextId: () => "abc" });
    const key = await lock.issueMobileKey({ reservationId: "res_1", roomNumber: "204", ...WINDOW });
    assert.equal(key.status, "issued");
    if (key.status !== "issued") throw new Error("unreachable");
    assert.equal(key.keyId, "sandbox_salto_space_abc");
    assert.equal(key.deliveryQr, "demo://key/sandbox_salto_space_abc");
    assert.equal(key.issuedAt, NOW.toISOString());
    assert.deepEqual(lock.activeKeys(), ["sandbox_salto_space_abc"]);
    assert.deepEqual(await lock.revoke("sandbox_salto_space_abc"), { revoked: true });
    assert.deepEqual(await lock.revoke("sandbox_salto_space_abc"), { revoked: false }, "una llave ya revocada no se revoca dos veces");
    assert.deepEqual(await lock.revoke("sandbox_salto_space_otra"), { revoked: false }, "una llave que no emitió no existe");
    assert.deepEqual(lock.activeKeys(), []);
    assert.deepEqual([...LOCK_PROVIDERS], ["none", "salto_space", "assa_vostio", "dormakaba"]);
  });
});

describe("lector por texto (keyboard wedge / SDK)", () => {
  it("normaliza a líneas: CRLF, mayúsculas, sin blancos, sin líneas vacías; no corrige caracteres", () => {
    assert.deepEqual(normalizeMrzText(""), []);
    assert.deepEqual(normalizeMrzText("\n\r\n  \n"), []);
    assert.deepEqual(normalizeMrzText("idesp abc123456 7<<<<<<<<<<<<<<<\r\n8001014f3101017ESP<<<<<<<<<<<4\n\nPRUEBA<<ANNA<<<<<<<<<<<<<<<<<<<"), [
      "IDESPABC1234567<<<<<<<<<<<<<<<",
      "8001014F3101017ESP<<<<<<<<<<<4",
      "PRUEBA<<ANNA<<<<<<<<<<<<<<<<<<<"
    ]);
    assert.deepEqual(normalizeMrzText("línea con ñ"), ["LÍNEACONÑ"], "los caracteres no MRZ llegan tal cual: parseMrz los rechaza con motivo");
  });

  it("encola bloques y los entrega en orden; vacío → null; clear vacía", async () => {
    const reader = bufferedMrzReader();
    assert.equal(reader.kind, "keyboard_wedge");
    assert.equal(await reader.read(), null);
    assert.equal(reader.push("  "), 0);
    assert.equal(reader.push("l1\nl2\nl3"), 3);
    assert.equal(reader.push("p1\np2"), 2);
    assert.equal(reader.pending(), 2);
    assert.deepEqual(await reader.read(), ["L1", "L2", "L3"]);
    assert.deepEqual(await reader.read(), ["P1", "P2"]);
    assert.equal(await reader.read(), null);
    reader.push("x");
    reader.clear();
    assert.equal(reader.pending(), 0);
    assert.equal(bufferedMrzReader("sdk").kind, "sdk");
  });
});

describe("resolveHardware por capacidades", () => {
  it("sin kiosco: todo none, modo production por defecto", () => {
    const hw = resolveHardware(null);
    assert.equal(hw.mode, "production");
    assert.deepEqual(hw.capabilities, { mrzReader: false, cardEncoder: false, paymentTerminal: false, printer: false });
    assert.equal(hw.lockProvider, "none");
    assert.equal(hw.lockProviderRaw, null);
    assert.deepEqual(hw.summary, { mrzReader: "none", cardEncoder: "none", lock: "none", sandbox: false });
  });

  it("kiosco con capacidades pero sin modo sandbox: lector real por texto, tarjeta y llave none (fail-closed: hoy no hay proveedor real)", async () => {
    const hw = resolveHardware({ capabilitiesJson: { mrzReader: true, cardEncoder: true, paymentTerminal: true, printer: false }, lockProvider: "salto_space" });
    assert.equal(hw.mode, "production");
    assert.deepEqual(hw.capabilities, { mrzReader: true, cardEncoder: true, paymentTerminal: true, printer: false });
    assert.equal(hw.lockProvider, "salto_space");
    assert.deepEqual(hw.summary, { mrzReader: "keyboard_wedge", cardEncoder: "none", lock: "none", sandbox: false });
    const encoded = await hw.cardEncoder.encode({ roomNumber: "204", ...WINDOW });
    assert.equal(encoded.status, "unavailable");
  });

  it("modo sandbox con proveedor conocido: codificador y cerradura sandbox del mismo proveedor; sin cardEncoder en capacidades el codificador sigue none", async () => {
    const hw = resolveHardware({ capabilitiesJson: { mrzReader: true, cardEncoder: true }, lockProvider: "Assa-Abloy" }, { mode: "sandbox" });
    assert.equal(hw.lockProvider, "assa_vostio");
    assert.equal(hw.lockProviderRaw, "Assa-Abloy");
    assert.deepEqual(hw.summary, { mrzReader: "keyboard_wedge", cardEncoder: "assa_vostio", lock: "assa_vostio", sandbox: true });
    const encoded = await hw.cardEncoder.encode({ roomNumber: "204", ...WINDOW });
    assert.equal(encoded.status === "encoded" && encoded.cardId.startsWith("sandbox_assa_vostio_"), true);
    const key = await hw.lock.issueMobileKey({ reservationId: "res_1", roomNumber: "204", ...WINDOW });
    assert.equal(key.status === "issued" && key.keyId.startsWith("sandbox_assa_vostio_"), true);

    const noEncoder = resolveHardware({ capabilitiesJson: { mrzReader: false, cardEncoder: false }, lockProvider: "dormakaba" }, { mode: "sandbox" });
    assert.deepEqual(noEncoder.summary, { mrzReader: "none", cardEncoder: "none", lock: "dormakaba", sandbox: true });
  });

  it("modo sandbox sin proveedor (vacío o desconocido) sigue siendo none: el sandbox no inventa un proveedor", () => {
    assert.deepEqual(resolveHardware({ capabilitiesJson: { cardEncoder: true }, lockProvider: null }, { mode: "sandbox" }).summary, { mrzReader: "none", cardEncoder: "none", lock: "none", sandbox: false });
    assert.deepEqual(resolveHardware({ capabilitiesJson: { cardEncoder: true }, lockProvider: "acme" }, { mode: "sandbox" }).summary, { mrzReader: "none", cardEncoder: "none", lock: "none", sandbox: false });
  });

  it("acepta el DTO del kiosco (capabilities) además de la fila (capabilitiesJson) y capacidades no booleanas cuentan como false", () => {
    const fromDto = resolveHardware({ capabilities: { mrzReader: true, cardEncoder: "yes" }, lockProvider: null });
    assert.deepEqual(fromDto.capabilities, { mrzReader: true, cardEncoder: false, paymentTerminal: false, printer: false });
    const fromArray = resolveHardware({ capabilitiesJson: ["mrzReader"], lockProvider: null });
    assert.equal(fromArray.summary.mrzReader, "none");
  });

  it("normalizeLockProvider: alias de los tres proveedores y none para el resto; hardwareModeFor solo es production con NODE_ENV=production", () => {
    assert.equal(normalizeLockProvider("salto"), "salto_space");
    assert.equal(normalizeLockProvider(" Salto Space "), "salto_space");
    assert.equal(normalizeLockProvider("assa_abloy"), "assa_vostio");
    assert.equal(normalizeLockProvider("vostio"), "assa_vostio");
    assert.equal(normalizeLockProvider("Dormakaba"), "dormakaba");
    assert.equal(normalizeLockProvider("kaba"), "dormakaba");
    assert.equal(normalizeLockProvider("none"), "none");
    assert.equal(normalizeLockProvider(""), "none");
    assert.equal(normalizeLockProvider(null), "none");
    assert.equal(normalizeLockProvider(undefined), "none");
    assert.equal(normalizeLockProvider("tesa"), "none", "TESA no tiene codificador de tarjeta en el diseño §2.4: none hasta que haya adaptador");
    assert.equal(hardwareModeFor("production"), "production");
    assert.equal(hardwareModeFor("development"), "sandbox");
    assert.equal(hardwareModeFor("test"), "sandbox");
    assert.equal(hardwareModeFor(undefined), "sandbox");
  });
});
