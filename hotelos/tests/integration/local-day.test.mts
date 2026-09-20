/**
 * Tanda CIERRE-1 · lote C4a — `helpers/local-day.mts` (sin Postgres ni HTTP):
 *   · 22:30Z del 19/09 es 20/09 en Europe/Madrid (CEST, +2) y 19/09 en UTC: la
 *     ventana 00:00-02:00 CEST en la que las suites pms-shadow fallaban;
 *   · el desplazamiento cruza el cambio de hora (2026-03-28T23:30Z = 29/03 00:30 CET,
 *     el DST empieza a las 02:00 de ese día; +1 día = 2026-03-30, no 29);
 *   · zona inválida → UTC (mismo comportamiento que `localDateTime`);
 *   · por defecto (hoy, Europe/Madrid) coincide con `localDateTime` del servidor.
 *
 *   cd apps/api && node --import tsx --test ../../tests/integration/local-day.test.mts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { localDay } from "./helpers/local-day.mts";

const { localDateTime } = await import("../../apps/api/src/modules/pms-shadow/pms-shadow.rules.js");

const MADRID = "Europe/Madrid";

describe("helpers/local-day · hoy + n días en la zona del hotel", () => {
  it("22:30Z del 19/09 es 20/09 en Europe/Madrid y 19/09 en UTC", () => {
    const at = new Date("2026-09-19T22:30:00.000Z");
    assert.equal(localDay(0, MADRID, at), "2026-09-20");
    assert.equal(localDay(0, "UTC", at), "2026-09-19");
    assert.equal(localDay(-4, MADRID, at), "2026-09-16", "SC-02: business date 4 días atrás");
    assert.equal(localDay(5, MADRID, at), "2026-09-25", "ARRIVAL_DATE de la fila A");
    assert.equal(localDay(0, MADRID, at), localDateTime(at, MADRID).date, "mismo día que el servidor");
  });

  it("offset cruza el cambio de hora (2026-03-28T23:30Z + 1 = 2026-03-30)", () => {
    const at = new Date("2026-03-28T23:30:00.000Z");
    assert.equal(localDay(0, MADRID, at), "2026-03-29");
    assert.equal(localDay(1, MADRID, at), "2026-03-30");
    assert.equal(localDay(1, "UTC", at), "2026-03-29");
    // Fin del horario de verano (25/10/2026 03:00 CEST → 02:00 CET): el día sigue midiendo un día.
    const autumn = new Date("2026-10-24T22:30:00.000Z");
    assert.equal(localDay(0, MADRID, autumn), "2026-10-25");
    assert.equal(localDay(1, MADRID, autumn), "2026-10-26");
  });

  it("zona inválida cae a UTC", () => {
    const at = new Date("2026-09-19T22:30:00.000Z");
    assert.equal(localDay(0, "Marte/Olympus", at), "2026-09-19");
    assert.equal(localDay(0, "Marte/Olympus", at), localDateTime(at, "Marte/Olympus").date);
    assert.equal(localDay(3, "", at), "2026-09-22");
  });

  it("por defecto hoy en Europe/Madrid coincide con localDateTime del servidor", () => {
    const now = new Date();
    assert.equal(localDay(0, MADRID, now), localDateTime(now, MADRID).date);
    assert.equal(localDay(0, undefined, now), localDateTime(now, MADRID).date, "zona por defecto Europe/Madrid");
    // Sin argumentos toma `new Date()`: se admite el día anterior o el actual por si la llamada cruza la medianoche.
    const before = localDateTime(new Date(), MADRID).date;
    const actual = localDay();
    const after = localDateTime(new Date(), MADRID).date;
    assert.ok(actual === before || actual === after, `localDay() = ${actual}, servidor ${before}/${after}`);
    assert.match(actual, /^\d{4}-\d{2}-\d{2}$/);
  });
});
