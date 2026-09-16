// Unit tests · texts of the night-audit preflight (qa#4 of the Cocoa 22
// walkthrough): Spanish without raw enum values or jargon, es-ES money.
// Run from apps/api with
//   node --import tsx --test src/modules/night-audit/__tests__/night-audit-preflight-texts.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PREFLIGHT_TEXTS,
  arrivalTimeHint,
  blockingMessage,
  countNoun,
  expectedArrivalHint,
  expectedDepartureHint,
  formatEur,
  housekeepingStatusLabel
} from "../night-audit-preflight.texts.js";

/** Raw enum values, anglicisms and English money that the operator must never read. */
const FORBIDDEN = /"confirmed"|\bconfirmed\b|\bdraft\b|in-house|\bpending\b|\bHK\b|\bPOS\b|\bETA\b|postea|night audit|housekeeping|€\d|\d\.\d{2}(?!\d)/i;

function everyText(): string[] {
  const out: string[] = [];
  for (const entry of Object.values(PREFLIGHT_TEXTS)) {
    out.push(entry.title, entry.ok);
    if ("some" in entry) out.push(entry.some(1, 764.75), entry.some(13, 27928.11));
    if ("balance" in entry) out.push(entry.balance(764.75));
    if ("room" in entry) out.push(entry.room("dirty"), entry.room(null));
    if ("failed" in entry) out.push(entry.failed("motivo"));
  }
  out.push(arrivalTimeHint("16:30"), arrivalTimeHint(null), expectedArrivalHint(new Date("2026-09-14T00:00:00Z")), expectedDepartureHint("2026-09-17"));
  out.push(blockingMessage([{ count: 2, title: PREFLIGHT_TEXTS.unresolved_no_shows.title }, { count: 13, title: PREFLIGHT_TEXTS.open_folios_with_balance.title }]));
  return out;
}

describe("formatEur", () => {
  it("formats in es-ES with the symbol after the amount", () => {
    assert.equal(formatEur(764.75), "764,75 €");
    assert.equal(formatEur(27928.11), "27.928,11 €");
    assert.equal(formatEur(0), "0,00 €");
    assert.equal(formatEur(5), "5,00 €");
  });
});

describe("preflight texts", () => {
  it("open folios: «13 folios con 764,75 € sin cobrar», singular and per-item balance", () => {
    assert.equal(PREFLIGHT_TEXTS.open_folios_with_balance.some(13, 764.75), "13 folios con 764,75 € sin cobrar. Cobra o regulariza antes de cerrar.");
    assert.equal(PREFLIGHT_TEXTS.open_folios_with_balance.some(1, 12.5), "1 folio con 12,50 € sin cobrar. Cobra o regulariza antes de cerrar.");
    assert.equal(PREFLIGHT_TEXTS.open_folios_with_balance.balance(764.75), "Saldo 764,75 €");
  });

  it("no-shows: «siguen confirmadas» instead of the raw status, with singular agreement", () => {
    assert.equal(PREFLIGHT_TEXTS.unresolved_no_shows.some(2), "2 reservas pasadas siguen confirmadas sin estancia. Decide check-in tardío o no-show antes del cierre.");
    assert.equal(PREFLIGHT_TEXTS.unresolved_no_shows.some(1), "1 reserva pasada sigue confirmada sin estancia. Decide check-in tardío o no-show antes del cierre.");
  });

  it("invoices: «borrador», never «draft»", () => {
    assert.equal(PREFLIGHT_TEXTS.invoices_pending.ok, "Sin facturas en borrador pendientes de emitir.");
    assert.equal(PREFLIGHT_TEXTS.invoices_pending.some(3), "3 facturas en borrador. Emítelas antes del cierre para que entren en la producción del día.");
    assert.equal(PREFLIGHT_TEXTS.invoices_pending.some(1), "1 factura en borrador. Emítela antes del cierre para que entre en la producción del día.");
    assert.equal(PREFLIGHT_TEXTS.invoices_pending.failed("timeout"), "No se pudo comprobar las facturas pendientes: timeout");
  });

  it("stays: «alojadas», never «in-house»; the close is «el cierre del día»", () => {
    assert.equal(PREFLIGHT_TEXTS.unposted_room_charges.ok, "Todas las estancias alojadas tienen el cargo de la noche en su folio.");
    assert.equal(PREFLIGHT_TEXTS.unposted_room_charges.some(2), "2 estancias sin el cargo de la noche. El cierre del día los carga al ejecutarse.");
    assert.equal(PREFLIGHT_TEXTS.departures_not_checked_out.some(1), "1 reserva con salida pasada todavía alojada. Cierra el check-out o amplía la estancia.");
  });

  it("payments and rooms: «pendientes de captura», «Limpieza: sucia»", () => {
    assert.equal(PREFLIGHT_TEXTS.payments_pending_capture.some(2), "2 pagos pendientes de captura. Captúralos o cancélalos para no perder las garantías.");
    assert.equal(PREFLIGHT_TEXTS.dirty_in_house_rooms.room("dirty"), "Limpieza: sucia");
    assert.equal(PREFLIGHT_TEXTS.dirty_in_house_rooms.room("DIRTY"), "Limpieza: sucia");
    assert.equal(housekeepingStatusLabel(null), "desconocido");
    assert.equal(housekeepingStatusLabel("weird"), "weird");
  });

  it("item hints: Spanish dates and arrival time", () => {
    assert.equal(expectedArrivalHint(new Date("2026-09-14T00:00:00Z")), "Llegada prevista 14/09/2026");
    assert.equal(expectedDepartureHint("2026-09-17T00:00:00.000Z"), "Salida prevista 17/09/2026");
    assert.equal(arrivalTimeHint("16:30"), "Hora prevista 16:30");
    assert.equal(arrivalTimeHint("  "), "Sin hora prevista");
    assert.equal(countNoun(1, "reserva", "reservas"), "1 reserva");
    assert.equal(countNoun(4, "reserva", "reservas"), "4 reservas");
  });

  it("blocking message lists the blockers by lowercase title; a failed count shows «—»", () => {
    assert.equal(
      blockingMessage([{ count: 2, title: "No-shows sin resolver" }, { count: 13, title: "Folios abiertos con saldo" }]),
      "No puedes cerrar todavía: 2 no-shows sin resolver, 13 folios abiertos con saldo."
    );
    assert.equal(blockingMessage([{ count: null, title: "Facturas pendientes" }]), "No puedes cerrar todavía: — facturas pendientes.");
  });

  it("no raw enum value, anglicism or English money in any text the operator reads", () => {
    for (const text of everyText()) {
      assert.doesNotMatch(text, FORBIDDEN, `texto con jerga o formato inglés: «${text}»`);
    }
  });
});
