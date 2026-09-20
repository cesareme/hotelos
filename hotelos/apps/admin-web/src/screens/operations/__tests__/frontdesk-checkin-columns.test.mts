import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

// Tanda CHK · W4-B (docs/design/CHECKIN-AUTOMATIZADO-IA.md §8, filas «Recepción ·
// /hoy» y «Cola de acciones»). Las funciones puras viven en FrontDeskDashboard.tsx
// y FrontDeskActionQueue.tsx; esos módulos llegan (services/api-client) a
// `import.meta.env.VITE_API_URL`, que define Vite y no `node --test`: el mismo
// gancho síncrono de frontdesk-actions.test.mts sustituye solo ese módulo.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("/src/services/api-client.ts")) {
      const source = stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), { mode: "strip" });
      return { format: "module", source: `import.meta.env ??= {};\n${source}`, shortCircuit: true };
    }
    return nextLoad(url, context);
  }
});

const dashboard = await import("../FrontDeskDashboard.tsx");
const queue = await import("../FrontDeskActionQueue.tsx");
const labels = await import("../frontdesk-labels.ts");
const drawer = await import("../ArrivalPreCheckInDrawer.tsx");
const { preCheckInBadge, suggestedRoomChip, suggestedRoomFor, filterByPreCheckIn, applyPreCheckInToDashboard, applyRoomToDashboard, toFrontDeskRows, PRECHECKIN_FILTER_OPTIONS } = dashboard;
const { queueKindLabel, queueKindTone, CHECKIN_QUEUE_KINDS, roomNumberFromLabel } = queue;

const DASHBOARD_SOURCE = readFileSync(new URL("../FrontDeskDashboard.tsx", import.meta.url), "utf8");
const QUEUE_SOURCE = readFileSync(new URL("../FrontDeskActionQueue.tsx", import.meta.url), "utf8");
const DRAWER_SOURCE = readFileSync(new URL("../ArrivalPreCheckInDrawer.tsx", import.meta.url), "utf8");
const SETTINGS_SOURCE = readFileSync(new URL("../CheckInAutomationSettingsScreen.tsx", import.meta.url), "utf8");
const count = (source: string, needle: string): number => source.split(needle).length - 1;

const ROOMS = [
  { id: "r110", number: "110", roomTypeId: "dbl", status: "dirty", housekeepingStatus: "dirty", sellable: true },
  { id: "r101", number: "101", roomTypeId: "dbl", status: "occupied", housekeepingStatus: "clean", sellable: true },
  { id: "r118", number: "118", roomTypeId: "dbl", status: "clean", housekeepingStatus: "clean", sellable: true },
  { id: "r103", number: "103", roomTypeId: "dbl", status: "clean", housekeepingStatus: "inspected", sellable: true }
];

const ENGINE = { suggestionId: "as_1", roomId: "r103", number: "103", reasons: ["Inspeccionada esta mañana", "Del tipo reservado", "Reparte el uso"], confidence: 0.75 };

// Las ocho `kind` de W3-D + `signature_pending` (corrector L7-REV-05) con etiqueta y tono propios.
const NEW_KINDS = ["precheckin_ready", "assignment_suggested", "self_checkin_done", "identity_review", "minor_without_guardian", "room_not_ready", "payment_failed", "ses_rejected", "signature_pending"];

describe("Mi día · columna «Pre-check-in» (preCheckInBadge)", () => {
  it("traduce los estados de la sesión al vocabulario de §8 y cuenta viajeros completos", () => {
    const invited = preCheckInBadge({ status: "invited", completedGuests: 0, totalGuests: 2 });
    assert.equal(invited?.entry.label, "Invitado");
    assert.equal(invited?.entry.tone, "info");
    assert.equal(invited?.caption, "0/2 viajeros");
    assert.equal(preCheckInBadge({ status: "in_progress", completedGuests: 1, totalGuests: 2 })?.entry.label, "En curso");
    assert.equal(preCheckInBadge({ status: "ready_for_arrival", completedGuests: 2, totalGuests: 2 })?.entry.label, "Listo");
    assert.equal(preCheckInBadge({ status: "arrived", completedGuests: 1, totalGuests: 1 })?.caption, "1/1 viajero");
    assert.equal(preCheckInBadge({ status: "checked_in", completedGuests: 2, totalGuests: 2 })?.entry.label, "Check-in hecho");
    assert.equal(preCheckInBadge({ status: "handed_off", completedGuests: 1, totalGuests: 2 })?.entry.tone, "warning");
  });
  it("«sin invitar» no lleva recuento; sin capa del API devuelve null (la celda pinta «—»); un estado desconocido nunca enseña el enum", () => {
    const none = preCheckInBadge({ status: "not_invited", completedGuests: 0, totalGuests: 0 });
    assert.equal(none?.entry.label, "Sin invitar");
    assert.equal(none?.caption, null);
    assert.equal(preCheckInBadge(undefined), null);
    assert.equal(preCheckInBadge(null), null);
    assert.equal(preCheckInBadge({ status: "weird_state", completedGuests: 0, totalGuests: 1 })?.entry.label, labels.UNKNOWN_STATUS?.label ?? "Desconocido");
  });
  it("el diccionario del lote cubre los 9 estados y la llave; ninguna etiqueta es el enum", () => {
    for (const key of labels.PRECHECKIN_STATUS_KEYS) {
      const entry = labels.preCheckInStatus(key);
      assert.notEqual(entry.label, key, key);
      assert.ok(entry.label.length > 0);
    }
    assert.equal(labels.keyStatus("issued").label, "Emitida");
    assert.equal(labels.keyStatus("pending").label, "Pendiente");
    assert.equal(labels.keyStatus("reception").label, "Recepción");
    assert.equal(labels.keyStatus("other").label, "Desconocido");
  });
});

describe("Mi día · chip «Sugerida 312 · 3 motivos» (suggestedRoomChip / suggestedRoomFor)", () => {
  const base = { reservationId: "res_1", guestName: "Huésped", status: "confirmed", roomTypeId: "dbl", balanceEur: 0, vip: false, tab: "arrivals" as const };
  it("con sugerencia del motor: etiqueta con nº de motivos, motivos y confianza; la candidata del motor manda sobre la primera limpia", () => {
    const chip = suggestedRoomChip({ ...base, suggestedRoom: ENGINE }, ROOMS);
    assert.equal(chip.kind, "suggested");
    if (chip.kind !== "suggested") return;
    assert.equal(chip.label, "Sugerida 103 · 3 motivos");
    assert.equal(chip.source, "engine");
    assert.equal(chip.suggestionId, "as_1");
    assert.deepEqual(chip.reasons, ENGINE.reasons);
    assert.equal(chip.confidence, 0.75);
    assert.equal(suggestedRoomFor({ ...base, suggestedRoom: ENGINE }, ROOMS)?.number, "103");
  });
  it("un solo motivo va en singular y sin motivos no inventa ninguno", () => {
    const one = suggestedRoomChip({ ...base, suggestedRoom: { ...ENGINE, reasons: ["Inspeccionada"] } }, ROOMS);
    assert.equal(one.kind === "suggested" ? one.label : null, "Sugerida 103 · 1 motivo");
    const zero = suggestedRoomChip({ ...base, suggestedRoom: { ...ENGINE, reasons: [] } }, ROOMS);
    assert.equal(zero.kind === "suggested" ? zero.label : null, "Sugerida 103");
  });
  it("sin sugerencia persistida cae a la primera limpia y libre del tipo (R14) sin suggestionId; sin candidatas, nada; con habitación, asignada", () => {
    const clean = suggestedRoomChip(base, ROOMS);
    assert.equal(clean.kind, "suggested");
    if (clean.kind === "suggested") {
      assert.equal(clean.number, "103", "la 103 inspeccionada va antes que la 118 por número; nunca la 101 ocupada ni la 110 sucia");
      assert.equal(clean.suggestionId, null);
      assert.equal(clean.source, "clean");
      assert.equal(clean.label, "Sugerida 103 · limpia y libre");
    }
    assert.deepEqual(suggestedRoomChip({ ...base, roomTypeId: "sup" }, ROOMS), { kind: "none" });
    assert.deepEqual(suggestedRoomChip({ ...base, roomNumber: "204" }, ROOMS), { kind: "assigned", number: "204" });
  });
  it("la candidata del motor que el catálogo ya muestra ocupada se descarta (cae a la primera limpia); si no está en el catálogo se sintetiza", () => {
    const occupied = suggestedRoomFor({ ...base, suggestedRoom: { ...ENGINE, roomId: "r101", number: "101" } }, ROOMS);
    assert.equal(occupied?.number, "103");
    const unknown = suggestedRoomFor({ ...base, suggestedRoom: { ...ENGINE, roomId: "r999", number: "999" } }, []);
    assert.equal(unknown?.id, "r999");
    assert.equal(unknown?.number, "999");
  });
});

describe("Mi día · filtro por estado de pre-check-in y optimismo", () => {
  const DATA = {
    kpis: { arrivalsToday: 3, departuresToday: 0, inHouseNow: 0, unassignedRooms: 2, overdueDepartures: 0, pendingBalanceEur: 0, preCheckInCompleted: 1 },
    arrivals: [
      { reservationId: "a", guestName: "A", arrivalDate: "2026-09-20", nights: 1, roomTypeId: "dbl", status: "confirmed", balanceEur: 0, vip: false, assignedRoomId: null, preCheckIn: { status: "not_invited", completedGuests: 0, totalGuests: 0 }, key: { status: "reception" } },
      { reservationId: "b", guestName: "B", arrivalDate: "2026-09-20", nights: 1, roomTypeId: "dbl", status: "confirmed", balanceEur: 0, vip: false, assignedRoomId: null, preCheckIn: { status: "ready_for_arrival", completedGuests: 2, totalGuests: 2 }, suggestedRoom: ENGINE, key: { status: "pending" } },
      { reservationId: "c", guestName: "C", arrivalDate: "2026-09-20", nights: 1, roomId: "r118", assignedRoomId: "r118", roomNumber: "118", roomTypeId: "dbl", status: "confirmed", balanceEur: 0, vip: false, preCheckIn: { status: "invited", completedGuests: 0, totalGuests: 1 }, key: { status: "reception" } }
    ],
    departures: [],
    inHouse: [],
    unassigned: []
  };
  it("las filas normalizadas conservan preCheckIn / suggestedRoom / key y el filtro separa completados, sin invitar e invitados", () => {
    const rows = toFrontDeskRows(DATA as never, "arrivals");
    assert.equal(rows[1].suggestedRoom?.number, "103");
    assert.equal(rows[2].key?.status, "reception");
    assert.deepEqual(filterByPreCheckIn(rows, "completed").map((row) => row.reservationId), ["b"]);
    assert.deepEqual(filterByPreCheckIn(rows, "not_invited").map((row) => row.reservationId), ["a"]);
    assert.deepEqual(filterByPreCheckIn(rows, "invited").map((row) => row.reservationId), ["c"]);
    assert.equal(filterByPreCheckIn(rows, "all").length, 3);
    assert.equal(PRECHECKIN_FILTER_OPTIONS[0].value, "all");
    assert.ok(PRECHECKIN_FILTER_OPTIONS.some((option) => option.value === "completed"));
    assert.ok(PRECHECKIN_FILTER_OPTIONS.every((option) => option.label.length > 0 && option.label !== option.value));
  });
  it("una fila sin capa de check-in cuenta como «sin invitar» en el filtro", () => {
    const rows = toFrontDeskRows({ ...DATA, arrivals: [{ ...DATA.arrivals[0], preCheckIn: undefined }] } as never, "arrivals");
    assert.equal(filterByPreCheckIn(rows, "not_invited").length, 1);
    assert.equal(filterByPreCheckIn(rows, "completed").length, 0);
  });
  it("invitar pasa la fila a «invited» al instante y confirmar la sugerencia deja la habitación y quita el chip", () => {
    const invited = applyPreCheckInToDashboard(DATA as never, "a", "invited");
    assert.equal(invited.arrivals[0].preCheckIn?.status, "invited");
    assert.equal(invited.arrivals[1].preCheckIn?.status, "ready_for_arrival", "las demás filas no cambian");
    const confirmed = applyRoomToDashboard(DATA as never, "b", { id: "r103", number: "103" });
    assert.equal(confirmed.arrivals[1].roomNumber, "103");
    assert.equal("suggestedRoom" in confirmed.arrivals[1], false, "la sugerencia pendiente desaparece de la fila asignada");
    assert.equal(confirmed.kpis.unassignedRooms, 2, "la fila no estaba en «Sin habitación»: el contador no baja");
  });
});

describe("Cola de acciones · los nueve kind nuevos (queueKindLabel / queueKindTone)", () => {
  it("cada kind tiene etiqueta en español y tono; ninguna etiqueta es el enum", () => {
    assert.deepEqual([...CHECKIN_QUEUE_KINDS], NEW_KINDS);
    const expected: Record<string, string> = {
      precheckin_ready: "Pre-check-in listo",
      assignment_suggested: "Habitación sugerida",
      self_checkin_done: "Check-in autónomo",
      identity_review: "Revisar identidad",
      minor_without_guardian: "Menor sin adulto",
      room_not_ready: "Habitación no lista",
      payment_failed: "Pago rechazado",
      ses_rejected: "Parte SES rechazado",
      signature_pending: "Firma en recepción"
    };
    for (const kind of NEW_KINDS) {
      assert.equal(queueKindLabel(kind), expected[kind], kind);
      assert.notEqual(queueKindTone(kind), "neutral", `${kind} lleva tono propio`);
    }
    assert.equal(queueKindTone("identity_review"), "danger");
    assert.equal(queueKindTone("minor_without_guardian"), "danger");
    assert.equal(queueKindTone("precheckin_ready"), "success");
    assert.equal(queueKindTone("assignment_suggested"), "info");
  });
  it("un kind desconocido lee «Acción pendiente» con tono neutro y los kinds anteriores siguen igual", () => {
    assert.equal(queueKindLabel("something_new"), "Acción pendiente");
    assert.equal(queueKindTone("something_new"), "neutral");
    assert.equal(queueKindLabel("unassigned_arrival"), "Sin habitación");
    assert.equal(queueKindLabel("checkin_ready"), "Listo para check-in");
  });
  it("«Confirmar 103» y «Asignar 103» dan el número de habitación para el toast", () => {
    assert.equal(roomNumberFromLabel("Confirmar 103"), "103");
    assert.equal(roomNumberFromLabel("Asignar 103"), "103");
    assert.equal(roomNumberFromLabel("Abrir reserva"), "");
  });
  it("confirm_assignment va por mutate optimista con checkinApi.confirmSuggestion y open_precheckin abre el cajón sin invalidar (contrato de fuente)", () => {
    assert.match(QUEUE_SOURCE, /confirmAssignment: \(itemId, suggestionId, roomId\) =>\s*mutate\(\s*\(prev\) => removeQueueItem\(prev, itemId\),\s*\(\) => confirmSuggestion\(suggestionId, roomId\)/);
    assert.match(QUEUE_SOURCE, /case "confirm_assignment": \{/);
    assert.match(QUEUE_SOURCE, /case "open_precheckin": \{/);
    assert.match(QUEUE_SOURCE, /action\.kind !== "open_precheckin"/, "abrir el cajón no revalida Mi día ni la cola");
    assert.match(QUEUE_SOURCE, /<ArrivalPreCheckInDrawer/);
    assert.equal(count(QUEUE_SOURCE, "invalidateFrontDesk();"), 3, "sin recargas nuevas tras las acciones del lote");
    assert.equal(count(QUEUE_SOURCE, "style={{"), 0, "0 style= inline nuevos en la cola");
  });
});

describe("Mi día · contrato de fuente del lote (columnas, chip, drawer, ajustes)", () => {
  it("la tabla de llegadas pinta Pre-check-in y Llave solo con la capa del API, el chip confirma por checkinApi y «Otra…» abre el cajón de check-in", () => {
    assert.match(DASHBOARD_SOURCE, /\{ key: "preCheckIn", label: "Pre-check-in", render: preCheckInCell \}/);
    assert.match(DASHBOARD_SOURCE, /\{ key: "key", label: "Llave", render: keyCell, hideOnNarrow: true \}/);
    assert.match(DASHBOARD_SOURCE, /hasCheckInLayer\s*\?/);
    assert.match(DASHBOARD_SOURCE, /\(\) => confirmSuggestionApi\(suggestionId, room\.id\)/, "Confirmar = POST /assignment-suggestions/:id/confirm vía checkinApi dentro de mutate");
    assert.match(DASHBOARD_SOURCE, /\(\) => inviteSessionApi\(PROPERTY_ID, row\.reservationId, "email"\)/);
    assert.match(DASHBOARD_SOURCE, /onOther=\{\(\) => setCheckInTarget\(\{ reservationId: row\.reservationId, roomId: null \}\)\}/);
    assert.match(DASHBOARD_SOURCE, /label: "Invitar al pre-check-in"/);
    assert.match(DASHBOARD_SOURCE, /label: "Ver pre-check-in"/);
    assert.match(DASHBOARD_SOURCE, /<ArrivalPreCheckInDrawer/);
    assert.match(DASHBOARD_SOURCE, /label="Pre-check-in hecho"/);
    assert.equal(count(DASHBOARD_SOURCE, "style={{"), 0, "0 style= inline nuevos en Mi día");
  });
  it("el cajón y la pantalla de ajustes nacen sin style= y el cajón nunca pinta el número completo del documento", () => {
    assert.equal(count(DRAWER_SOURCE, "style={"), 0);
    assert.equal(count(SETTINGS_SOURCE, "style={"), 0);
    assert.equal(count(DRAWER_SOURCE, "style="), 0, "ni siquiera el literal en comentarios");
    assert.equal(count(SETTINGS_SOURCE, "style="), 0, "ni siquiera el literal en comentarios");
    assert.doesNotMatch(DRAWER_SOURCE, /documentNumber[^L]/, "solo documentNumberLast3");
    assert.match(SETTINGS_SOURCE, /title="Check-in automatizado"/);
    assert.match(SETTINGS_SOURCE, /canManageCheckInPolicy\(gate\.grantedPermissions, gate\.isPlatformAdmin\)/);
  });
  it("el cajón resume documento y firma sin PII", () => {
    const summary = drawer.documentSummary({
      documentType: "P",
      documentNumberLast3: "321",
      captures: [
        { source: "manual", mrzFormat: null, checksJson: {}, needsReviewJson: [], createdAt: "2026-09-19T08:00:00.000Z" },
        { source: "mrz_reader", mrzFormat: "TD3", checksJson: { document: true, birth: true, expiry: false, composite: null }, needsReviewJson: ["documentExpiryDate"], createdAt: "2026-09-19T09:00:00.000Z" }
      ]
    });
    assert.deepEqual(summary, { type: "P", masked: "···321", source: "lector MRZ", format: "TD3", checks: "2/3 controles", needsReview: ["documentExpiryDate"] });
    assert.equal(drawer.documentSummary({ documentType: null, documentNumberLast3: null }).masked, null);
    assert.deepEqual(drawer.signatureSummary({ signatures: [{ method: "touch_portal", signedAt: "2026-09-19T10:00:00.000Z" }] }), { signedAt: "2026-09-19T10:00:00.000Z", method: "en el portal" });
    assert.equal(drawer.signatureSummary({}), null);
    assert.equal(drawer.guestDisplayName({ firstName: null, surname1: null, surname2: null, ordinal: 2 }), "Viajero 2");
    assert.equal(drawer.isNoSessionError("Sesión de check-in no encontrada."), true);
    assert.equal(drawer.isNoSessionError("Error de red"), false);
    assert.deepEqual(labels.mrzChecksSummary({ document: true, birth: true, expiry: true, composite: true }), { passed: 4, total: 4, label: "4/4 controles" });
    assert.equal(labels.mrzChecksSummary({}), null);
  });
});
