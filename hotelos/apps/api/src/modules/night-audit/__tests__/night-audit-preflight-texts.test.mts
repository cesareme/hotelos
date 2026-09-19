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
  housekeepingStatusLabel,
  settledFoliosStepDetail,
  settledFoliosToCloseHint,
  settledFoliosWarnings
} from "../night-audit-preflight.texts.js";
// Tanda L3 (lote B): the sentence the preflight appends for folios of cancelled /
// no-show reservations lives in the service (pure function, no query).
import { settledStayFoliosHint } from "../night-audit-preflight.service.js";

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
  out.push(PREFLIGHT_TEXTS.open_folios_with_balance.ok + settledStayFoliosHint(1, 150), PREFLIGHT_TEXTS.open_folios_with_balance.some(2, 300) + settledStayFoliosHint(12, 1126.45));
  // Tanda L5 (L5-D): folios of closed reservations in the preflight detail and in the run report.
  out.push(PREFLIGHT_TEXTS.open_folios_with_balance.ok + settledFoliosToCloseHint(1), settledFoliosToCloseHint(42));
  out.push(settledFoliosStepDetail({ closed: 42, pendingInvoice: 3, withBalance: 9, totalWithBalance: 445 }), settledFoliosStepDetail({ closed: 1, pendingInvoice: 0, withBalance: 1, totalWithBalance: 27928.11 }));
  out.push(...settledFoliosWarnings({ pendingInvoice: 1, withBalance: 1, totalWithBalance: 764.75 }), ...settledFoliosWarnings({ pendingInvoice: 3, withBalance: 4, totalWithBalance: 379.75 }));
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

  it("open folios of cancelled / no-show reservations: appended as a warning, never a blocker; empty when none (Tanda L3)", () => {
    assert.equal(settledStayFoliosHint(0, 0), "");
    assert.equal(settledStayFoliosHint(1, 150), " Además, 1 folio de reservas canceladas o no presentadas conserva 150,00 € sin cobrar: no bloquea el cierre.");
    // es-ES no agrupa millares en cifras de 4 dígitos (mismo formatEur que «27.928,11 €»).
    assert.equal(settledStayFoliosHint(12, 1126.45), " Además, 12 folios de reservas canceladas o no presentadas conservan 1126,45 € sin cobrar: no bloquean el cierre.");
    assert.equal(settledStayFoliosHint(3, 27928.11), " Además, 3 folios de reservas canceladas o no presentadas conservan 27.928,11 € sin cobrar: no bloquean el cierre.");
    assert.equal(
      PREFLIGHT_TEXTS.open_folios_with_balance.ok + settledStayFoliosHint(1, 150),
      "Sin folios con saldo pendiente. Además, 1 folio de reservas canceladas o no presentadas conserva 150,00 € sin cobrar: no bloquea el cierre."
    );
  });

  it("folios of closed reservations the run will close: «N folios liquidados … se cerrarán en el cierre del día»; empty when none (Tanda L5 · L5-D)", () => {
    assert.equal(settledFoliosToCloseHint(0), "");
    assert.equal(settledFoliosToCloseHint(1), " 1 folio liquidado de reservas canceladas, no presentadas o con salida hecha se cerrará en el cierre del día.");
    assert.equal(settledFoliosToCloseHint(42), " 42 folios liquidados de reservas canceladas, no presentadas o con salida hecha se cerrarán en el cierre del día.");
    assert.equal(
      PREFLIGHT_TEXTS.open_folios_with_balance.ok + settledStayFoliosHint(1, 150) + settledFoliosToCloseHint(42),
      "Sin folios con saldo pendiente. Además, 1 folio de reservas canceladas o no presentadas conserva 150,00 € sin cobrar: no bloquea el cierre. 42 folios liquidados de reservas canceladas, no presentadas o con salida hecha se cerrarán en el cierre del día."
    );
  });

  it("close_settled_folios: step detail and report warnings («N folios de reservas cerradas conservan X € sin cobrar») (Tanda L5 · L5-D)", () => {
    assert.equal(settledFoliosStepDetail({ closed: 42, pendingInvoice: 3, withBalance: 9, totalWithBalance: 445 }), "42 folios liquidados de reservas canceladas, no presentadas o con salida hecha cerrados; 3 con cargos sin facturar; 9 conservan 445,00 € sin cobrar.");
    assert.equal(settledFoliosStepDetail({ closed: 1, pendingInvoice: 0, withBalance: 0, totalWithBalance: 0 }), "1 folio liquidado de reservas canceladas, no presentadas o con salida hecha cerrado.");
    assert.equal(settledFoliosStepDetail({ closed: 0, pendingInvoice: 0, withBalance: 1, totalWithBalance: 379.75 }), "0 folios liquidados de reservas canceladas, no presentadas o con salida hecha cerrados; 1 conserva 379,75 € sin cobrar.");
    assert.deepEqual(settledFoliosWarnings({ pendingInvoice: 0, withBalance: 0, totalWithBalance: 0 }), []);
    assert.deepEqual(settledFoliosWarnings({ pendingInvoice: 0, withBalance: 4, totalWithBalance: 379.75 }), ["4 folios de reservas cerradas conservan 379,75 € sin cobrar."]);
    assert.deepEqual(settledFoliosWarnings({ pendingInvoice: 1, withBalance: 1, totalWithBalance: 12.5 }), [
      "1 folio de reservas cerradas conserva 12,50 € sin cobrar.",
      "1 folio liquidado de reservas cerradas conserva cargos sin facturar: emite la factura para cerrarlo."
    ]);
    assert.deepEqual(settledFoliosWarnings({ pendingInvoice: 3, withBalance: 0, totalWithBalance: 0 }), ["3 folios liquidados de reservas cerradas conservan cargos sin facturar: emite la factura para cerrarlos."]);
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
