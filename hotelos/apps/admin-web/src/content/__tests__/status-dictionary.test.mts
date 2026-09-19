import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BAR_KIND,
  BAR_KIND_KEYS,
  RESERVATION_STATUS,
  RESERVATION_STATUS_KEYS,
  ROOM_STATUS,
  ROOM_STATUS_KEYS,
  STATUS_ICON_NAMES,
  STATUS_LABELS,
  UNKNOWN_STATUS,
  barKindStatus,
  isReservationStatusKey,
  isRoomStatusKey,
  reservationStatus,
  roomStatus,
  statusLabels,
  statusTones, sourceLabel } from "../status-dictionary.ts";
import { COCOA_TONES } from "../../components/cocoa/cocoa-tones.ts";

// Tanda UX-1 · lote U2 (UX-RECEPCION-FEEL §1.1 P6, §4, §10 D5): un solo
// diccionario etiqueta + forma corta + tono + icono; el enum crudo del API
// nunca llega al operador.

const SPANISH_LABEL = /^[A-ZÁÉÍÓÚÑ][a-záéíóúñ .-]*$/;
const ENGLISH_ENUM = /^[a-z]+(_[a-z]+)*$/;

function checkDictionary(name: string, dict: Record<string, { label: string; short: string; tone: string; icon: string }>, keys: readonly string[]) {
  assert.deepEqual(Object.keys(dict), [...keys], `${name}: claves en el orden declarado`);
  for (const [key, entry] of Object.entries(dict)) {
    assert.match(entry.label, SPANISH_LABEL, `${name}.${key}: etiqueta en español con mayúscula inicial («${entry.label}»)`);
    assert.doesNotMatch(entry.label, ENGLISH_ENUM, `${name}.${key}: la etiqueta no es el enum`);
    assert.notEqual(entry.label, key, `${name}.${key}: la etiqueta no repite la clave`);
    assert.ok(entry.short.length > 0 && entry.short.length <= entry.label.length, `${name}.${key}: forma corta no vacía y no más larga que la etiqueta`);
    assert.ok((COCOA_TONES as readonly string[]).includes(entry.tone), `${name}.${key}: tono Cocoa («${entry.tone}»)`);
    assert.ok((STATUS_ICON_NAMES as readonly string[]).includes(entry.icon), `${name}.${key}: icono conocido («${entry.icon}»)`);
  }
}

describe("status-dictionary · reserva (D5)", () => {
  it("todas las claves tienen etiqueta en español, forma corta, tono e icono", () => {
    checkDictionary("RESERVATION_STATUS", RESERVATION_STATUS, RESERVATION_STATUS_KEYS);
  });
  it("vocabulario D5: Confirmada · En el hotel · Salida hecha · No-show · Cancelada · Borrador", () => {
    assert.deepEqual(statusLabels(RESERVATION_STATUS), {
      draft: "Borrador",
      confirmed: "Confirmada",
      checked_in: "En el hotel",
      checked_out: "Salida hecha",
      no_show: "No-show",
      cancelled: "Cancelada"
    });
    assert.equal(RESERVATION_STATUS.draft.label, STATUS_LABELS.draft, "Borrador viene del copy común, no se duplica");
  });
  it("tonos: En el hotel success, Confirmada info, Salida hecha neutral, Cancelada danger, No-show distinguible de Cancelada", () => {
    assert.deepEqual(statusTones(RESERVATION_STATUS), {
      draft: "neutral",
      confirmed: "info",
      checked_in: "success",
      checked_out: "neutral",
      no_show: "warning",
      cancelled: "danger"
    });
    assert.notEqual(RESERVATION_STATUS.no_show.tone, RESERVATION_STATUS.cancelled.tone);
    assert.notEqual(RESERVATION_STATUS.no_show.icon, RESERVATION_STATUS.cancelled.icon);
  });
  it("«Llega hoy» y «Sale hoy» no son estados de reserva", () => {
    for (const entry of Object.values(RESERVATION_STATUS)) {
      assert.notEqual(entry.label, "Llega hoy");
      assert.notEqual(entry.label, "Sale hoy");
    }
  });
});

describe("status-dictionary · habitación (D5)", () => {
  it("todas las claves tienen etiqueta en español, forma corta, tono e icono", () => {
    checkDictionary("ROOM_STATUS", ROOM_STATUS, ROOM_STATUS_KEYS);
  });
  it("vocabulario D5: Limpia · Inspeccionada · Sucia · Ocupada · Bloqueada · Fuera de servicio (ooo/out_of_order/out_of_service)", () => {
    assert.deepEqual(statusLabels(ROOM_STATUS), {
      clean: "Limpia",
      inspected: "Inspeccionada",
      dirty: "Sucia",
      occupied: "Ocupada",
      blocked: "Bloqueada",
      out_of_order: "Fuera de servicio",
      ooo: "Fuera de servicio",
      out_of_service: "Fuera de servicio"
    });
  });
  it("tonos del tablero: Ocupada info, Sucia warning, Limpia success, Bloqueada y Fuera de servicio danger", () => {
    assert.deepEqual(statusTones(ROOM_STATUS), {
      clean: "success",
      inspected: "success",
      dirty: "warning",
      occupied: "info",
      blocked: "danger",
      out_of_order: "danger",
      ooo: "danger",
      out_of_service: "danger"
    });
  });
  it("Inspeccionada se distingue de Limpia por icono propio y énfasis (relleno)", () => {
    assert.notEqual(ROOM_STATUS.inspected.icon, ROOM_STATUS.clean.icon);
    assert.equal(ROOM_STATUS.inspected.emphasis, "tinted");
    assert.equal(ROOM_STATUS.clean.emphasis, undefined);
  });
});

describe("status-dictionary · origen / canal (D5, L-14, L-05)", () => {
  it("códigos conocidos en español, bookingSource antes que el canal, y un código desconocido humanizado (nunca crudo)", () => {
    assert.equal(sourceLabel("direct_web"), "Web directa");
    assert.equal(sourceLabel("phone"), "Teléfono");
    assert.equal(sourceLabel("walk_in"), "Walk-in");
    assert.equal(sourceLabel("DIRECT"), "Directo");
    assert.equal(sourceLabel("import:imp_1"), "Importación");
    assert.equal(sourceLabel("late_night_ota"), "Late night ota");
    assert.equal(sourceLabel(""), "Desconocido");
    assert.equal(sourceLabel(null), "Desconocido");
  });
});

describe("status-dictionary · clases de barra del Live Timeline", () => {
  it("todas las claves tienen etiqueta en español, forma corta, tono e icono", () => {
    checkDictionary("BAR_KIND", BAR_KIND, BAR_KIND_KEYS);
  });
  it("Llega hoy · En el hotel · Sale hoy + los cinco estados de reserva (misma entrada, no copia)", () => {
    assert.equal(BAR_KIND.arrival_today.label, "Llega hoy");
    assert.equal(BAR_KIND.departure_today.label, "Sale hoy");
    assert.equal(BAR_KIND.in_house, RESERVATION_STATUS.checked_in);
    assert.equal(BAR_KIND.confirmed, RESERVATION_STATUS.confirmed);
    assert.equal(BAR_KIND.draft, RESERVATION_STATUS.draft);
    assert.equal(BAR_KIND.checked_out, RESERVATION_STATUS.checked_out);
    assert.equal(BAR_KIND.no_show, RESERVATION_STATUS.no_show);
    assert.equal(BAR_KIND.cancelled, RESERVATION_STATUS.cancelled);
  });
  it("las barras vivas (Llega hoy · En el hotel · Sale hoy · Confirmada) llevan cuatro tonos distintos: solo el tono las separa en la parrilla", () => {
    const live = ["arrival_today", "in_house", "departure_today", "confirmed"] as const;
    assert.equal(new Set(live.map((k) => BAR_KIND[k].tone)).size, live.length);
  });
});

describe("status-dictionary · helpers", () => {
  it("toleran mayúsculas y espacios y devuelven la misma entrada", () => {
    assert.equal(reservationStatus("CHECKED_IN"), RESERVATION_STATUS.checked_in);
    assert.equal(reservationStatus("  confirmed "), RESERVATION_STATUS.confirmed);
    assert.equal(roomStatus("Inspected"), ROOM_STATUS.inspected);
    assert.equal(roomStatus("OOO"), ROOM_STATUS.out_of_order);
    assert.equal(barKindStatus("Arrival_Today"), BAR_KIND.arrival_today);
  });
  it("undefined, null, vacío o un valor desconocido → «Desconocido» en español, nunca el enum", () => {
    for (const value of [undefined, null, "", "   ", "weird_state", "constructor", "__proto__", "toString"]) {
      assert.equal(reservationStatus(value), UNKNOWN_STATUS, `reserva ${String(value)}`);
      assert.equal(roomStatus(value), UNKNOWN_STATUS, `habitación ${String(value)}`);
      assert.equal(barKindStatus(value), UNKNOWN_STATUS, `barra ${String(value)}`);
    }
    assert.equal(UNKNOWN_STATUS.label, STATUS_LABELS.unknown);
    assert.equal(UNKNOWN_STATUS.label, "Desconocido");
    assert.equal(UNKNOWN_STATUS.tone, "neutral");
  });
  it("guardas de clave", () => {
    assert.equal(isReservationStatusKey("no_show"), true);
    assert.equal(isReservationStatusKey("NO_SHOW"), true);
    assert.equal(isReservationStatusKey("in_house"), false);
    assert.equal(isRoomStatusKey("dirty"), true);
    assert.equal(isRoomStatusKey("ready"), false);
    assert.equal(isRoomStatusKey(undefined), false);
  });
  it("statusLabels / statusTones proyectan sin perder claves", () => {
    assert.deepEqual(Object.keys(statusLabels(BAR_KIND)), [...BAR_KIND_KEYS]);
    assert.deepEqual(Object.keys(statusTones(BAR_KIND)), [...BAR_KIND_KEYS]);
  });
});
