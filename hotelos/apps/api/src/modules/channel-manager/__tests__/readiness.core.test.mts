// Readiness texts (readiness.core.ts): Spanish, dates formatted for the
// hotelier (es-ES, Europe/Madrid), never ISO stamps, sync-type codes or
// capitals; the sandbox mode is worded as a structural validation, never as
// «el esquema real del proveedor».

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SANDBOX_MEANING,
  credentialsCheck,
  deliveryKindLabelEs,
  formatDateTimeEs,
  modeCheck,
  productCodesCheck,
  readinessForGrid,
  recentSuccessCheck,
  syncTypeLabelEs
} from "../readiness.core.js";

const ISO_STAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
// Capitals are only legitimate for an env var name and the protocol acronym.
const SHOUTING = { test: (text: string) => /[A-ZÁÉÍÓÚÑ]{4,}/.test(text.replace(/CHANNEL_MAX_MODE=\w+/g, "").replace(/HTTPS/g, "")) };

describe("readiness.core — dates and labels", () => {
  it("formatDateTimeEs renders Europe/Madrid wall clock as dd/mm/yyyy hh:mm", () => {
    assert.equal(formatDateTimeEs(new Date("2026-09-14T23:29:32.044Z")), "15/09/2026 01:29");
    assert.equal(formatDateTimeEs("2026-01-10T11:05:00.000Z"), "10/01/2026 12:05");
    assert.equal(formatDateTimeEs("garbage"), "fecha desconocida");
    assert.equal(formatDateTimeEs(null), "fecha desconocida");
  });

  it("sync types and delivery kinds have Spanish labels, unknown codes never leak underscores", () => {
    assert.equal(syncTypeLabelEs("test_credentials"), "prueba de conexión");
    assert.equal(syncTypeLabelEs("push_rates"), "envío de tarifas");
    assert.equal(syncTypeLabelEs("pull_reservations"), "descarga de reservas");
    assert.equal(syncTypeLabelEs("full_resync"), "sincronización full resync");
    assert.equal(deliveryKindLabelEs("availability"), "de disponibilidad");
  });
});

describe("readiness.core — checks", () => {
  it("recent_success: confirmed delivery → ok with a formatted date; only a test → warn with the sync type in words", () => {
    const ok = recentSuccessCheck({ lastConfirmed: { kind: "rates", confirmedAt: new Date("2026-09-14T23:29:32.044Z") }, recentTest: null });
    assert.equal(ok.status, "ok");
    assert.equal(ok.detail, "Última entrega de tarifas confirmada el 15/09/2026 01:29.");
    const warn = recentSuccessCheck({ lastConfirmed: null, recentTest: { syncType: "test_credentials", createdAt: new Date("2026-09-14T23:29:32.044Z") } });
    assert.equal(warn.status, "warn");
    assert.equal(warn.detail, "Sin entregas confirmadas; última prueba de conexión correcta el 15/09/2026 01:29.");
    assert.equal(ISO_STAMP.test(warn.detail), false);
    assert.equal(SHOUTING.test(warn.detail), false);
    assert.equal(warn.detail.includes("test_credentials"), false);
    const none = recentSuccessCheck({ lastConfirmed: null, recentTest: null });
    assert.equal(none.status, "warn");
    assert.ok(none.detail.includes("Probar conexión"));
  });

  it("mode and grid summary describe sandbox as a structural validation, never as the provider's real schema", () => {
    const texts = [
      modeCheck("sandbox", "sandbox", "sandbox").detail,
      modeCheck("real", "sandbox", "sandbox").detail,
      modeCheck("stub", "stub", "sandbox").detail,
      readinessForGrid({ status: "active", mode: "sandbox", hasCredentials: true, mappedProducts: 4, hasAdapter: true }).summary
    ];
    for (const t of texts) {
      assert.equal(/esquema real/i.test(t), false, t);
      assert.equal(ISO_STAMP.test(t), false, t);
      assert.equal(SHOUTING.test(t), false, t);
    }
    assert.ok(texts[0]!.includes("valida la estructura del payload"));
    assert.ok(texts[0]!.includes("no sustituye la certificación del proveedor"));
    assert.ok(texts[1]!.includes("Solicitado real, limitado a sandbox por CHANNEL_MAX_MODE=sandbox"));
    assert.equal(texts[3], "Modo sandbox: validado por el simulador local (validación estructural del payload, no certificación del proveedor).");
    assert.ok(SANDBOX_MEANING.includes("validación estructural del payload"));
    assert.equal(readinessForGrid({ status: "active", mode: "sandbox", hasCredentials: true, mappedProducts: 4, hasAdapter: true }).readyToPush, true);
    assert.deepEqual(readinessForGrid({ status: "active", mode: "sandbox", hasCredentials: false, mappedProducts: 4, hasAdapter: true }), { readyToPush: false, summary: "Modo sandbox (pruebas): faltan credenciales." });
    assert.deepEqual(readinessForGrid({ status: "inactive", mode: "real", hasCredentials: true, mappedProducts: 4, hasAdapter: true }), { readyToPush: false, summary: "Canal inactivo." });
    assert.deepEqual(readinessForGrid({ status: "active", mode: "real", hasCredentials: true, mappedProducts: 0, hasAdapter: true }), { readyToPush: false, summary: "Sin productos mapeados (tipo × plan)." });
  });

  it("credentials: undecryptable envelope is told apart from never saved; provider keys checked on the normalised code", () => {
    assert.equal(credentialsCheck("booking", null, false, "sandbox", true).detail.includes("clave rotada sin backfill"), true);
    assert.equal(credentialsCheck("booking", null, false, "sandbox", false).detail.includes("Sin credenciales guardadas"), true);
    assert.equal(credentialsCheck("booking", { client_id: "x", client_secret: "y" }, false, "sandbox").detail, "Faltan: hotelId.");
    assert.equal(credentialsCheck("booking", { client_id: "x", client_secret: "y", hotelId: "1" }, false, "sandbox").status, "ok");
    assert.equal(credentialsCheck("booking", { client_id: "x", client_secret: "y", hotelId: "1" }, true, "sandbox").status, "warn");
    assert.equal(credentialsCheck("booking", null, false, "stub").status, "ok");
  });
});

describe("readiness.core — product_codes", () => {
  const none = { roomCodes: [], rateCodes: [] };
  const sharedRoom = { roomCodes: [{ code: "EX-DBL", roomTypeIds: ["rt_dbl", "rt_ind"] }], rateCodes: [{ code: "RP-BAR", roomTypeIds: ["rt_dbl", "rt_dbm", "rt_ind", "rt_sui"] }] };

  it("is emitted for every provider: ok when nothing is shared, in the hotelier's words", () => {
    const expedia = productCodesCheck({ providerCode: "expedia", mode: "sandbox", shared: none });
    assert.deepEqual(expedia, { key: "product_codes", label: "Códigos de producto", status: "ok", detail: "Cada código de habitación externo pertenece a un solo tipo de habitación." });
    const channex = productCodesCheck({ providerCode: "channex", mode: "sandbox", shared: none });
    assert.equal(channex.status, "ok");
    assert.ok(channex.detail.includes("rate plan"), channex.detail);
  });

  it("a shared ROOM code is a warn in stub/sandbox and an error in real on a room-addressed provider; its shared RP-<plan> is not reported", () => {
    const warn = productCodesCheck({ providerCode: "expedia", mode: "sandbox", shared: sharedRoom });
    assert.equal(warn.status, "warn");
    assert.ok(warn.detail.startsWith("1 código(s) de habitación compartidos entre tipos (EX-DBL): en Expedia cada código de habitación identifica un solo tipo"), warn.detail);
    assert.equal(warn.detail.includes("RP-BAR"), false, warn.detail);
    assert.equal(SHOUTING.test(warn.detail), false, warn.detail);
    assert.equal(productCodesCheck({ providerCode: "booking_com", mode: "stub", shared: sharedRoom }).status, "warn");
    assert.equal(productCodesCheck({ providerCode: "booking_com", mode: "real", shared: sharedRoom }).status, "error");
    // Only the plan code shared (the seeded Booking / Expedia layout): ok.
    assert.equal(productCodesCheck({ providerCode: "expedia", mode: "real", shared: { roomCodes: [], rateCodes: sharedRoom.rateCodes } }).status, "ok");
  });

  it("a Channex-routed provider reports shared rate codes (existing rule) and shared room codes, both sentences", () => {
    const rate = productCodesCheck({ providerCode: "airbnb", mode: "sandbox", shared: { roomCodes: [], rateCodes: [{ code: "UX-BAR", roomTypeIds: ["rt_dbl", "rt_ind"] }] } });
    assert.equal(rate.status, "warn");
    assert.equal(rate.detail, "1 código(s) de rate plan compartidos entre tipos (UX-BAR): en Channex un rate plan pertenece a un solo tipo, mapee cada tipo con su id real.");
    const both = productCodesCheck({ providerCode: "channex", mode: "real", shared: { roomCodes: [{ code: "CX-DBL", roomTypeIds: ["rt_dbl", "rt_ind"] }], rateCodes: [{ code: "RP-BAR-DBL", roomTypeIds: ["rt_dbl", "rt_ind"] }] } });
    assert.equal(both.status, "error");
    assert.ok(both.detail.includes("código(s) de habitación compartidos entre tipos (CX-DBL): en Channex"), both.detail);
    assert.ok(both.detail.includes("código(s) de rate plan compartidos entre tipos (RP-BAR-DBL)"), both.detail);
  });
});
