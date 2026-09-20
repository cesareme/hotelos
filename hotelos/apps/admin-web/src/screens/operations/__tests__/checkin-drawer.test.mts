import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

// Tanda CHK · lote W4-A · QuickCheckInDrawer (docs/design/CHECKIN-AUTOMATIZADO-IA.md
// §8 «Drawer de check-in»): la lógica pura del cajón — origen y confianza de
// los campos leídos, estado de cada viajero de la sesión, top-3 del motor sobre
// el catálogo (F24: nunca una ocupada ni sucia), estado de la firma del titular
// («Firmado en el portal el dd/mm HH:MM»), camino del CTA (POST …/complete
// solo con sesión y sin override de limpieza) y el mensaje del 409
// ROOM_NOT_READY con la hora de pisos. El módulo llega a services/api-client →
// `import.meta.env`, que define Vite: el gancho lo sustituye como
// walk-in-drawer.test.mts.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("/src/services/api-client.ts")) {
      const source = stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), { mode: "strip" });
      return { format: "module", source: `import.meta.env ??= {};\n${source}`, shortCircuit: true };
    }
    return nextLoad(url, context);
  }
});

const { checkinPathFor, confidenceLabel, fieldOriginLabel, isRoomClean, maskDocumentNumber, mrzChecksLabel, pickSuggestionRoom, roomNotReadyMessage, sessionStatusLabel, signatureStateOf, travellerStatusLabel } = await import("../QuickCheckInDrawer.tsx");
const SOURCE = readFileSync(new URL("../QuickCheckInDrawer.tsx", import.meta.url), "utf8");

type Room = { id: string; number: string; roomTypeId: string; status: string; housekeepingStatus?: string; sellable?: boolean };
const room = (id: string, number: string, roomTypeId: string, status: string, hk: string, sellable = true): Room => ({ id, number, roomTypeId, status, housekeepingStatus: hk, sellable });
const ROOMS: Room[] = [
  room("r201", "201", "ste", "dirty", "dirty"),
  room("r202", "202", "ste", "occupied", "clean"),
  room("r204", "204", "ste", "clean", "inspected"),
  room("r205", "205", "ste", "clean", "clean"),
  room("r301", "301", "sup", "clean", "clean"),
  room("r206", "206", "ste", "clean", "clean", false)
];

type Guest = {
  status: string;
  isMinor: boolean;
  identityVerifiedAt: string | null;
  captures: Array<{ id: string }>;
  signatures: Array<{ method: string; signedAt: string }>;
};
const guest = (over: Partial<Guest> = {}): Guest => ({ status: "pending", isMinor: false, identityVerifiedAt: null, captures: [], signatures: [], ...over });

describe("cajón de check-in · origen y confianza de los campos leídos", () => {
  it("fieldOriginLabel: mrz_reader y mrz_ai → MRZ, ai_vision → IA, manual o desconocido → Manual", () => {
    assert.deepEqual(fieldOriginLabel("mrz_reader"), { label: "MRZ", tone: "success" });
    assert.deepEqual(fieldOriginLabel("mrz_ai"), { label: "MRZ", tone: "success" });
    assert.deepEqual(fieldOriginLabel("ai_vision"), { label: "IA", tone: "info" });
    assert.deepEqual(fieldOriginLabel("manual"), { label: "Manual", tone: "neutral" });
    assert.deepEqual(fieldOriginLabel(null), { label: "Manual", tone: "neutral" });
    assert.equal(confidenceLabel(0.984), "98 %");
    assert.equal(confidenceLabel(1.7), "100 %");
    assert.equal(confidenceLabel(undefined), "—");
    assert.equal(maskDocumentNumber("CHK000321"), "···321");
    assert.equal(maskDocumentNumber(""), "—");
    assert.equal(mrzChecksLabel({ document: true, birth: true, expiry: false, composite: null }), "Dígitos de control 2/3");
    assert.equal(mrzChecksLabel({ document: null, birth: null, expiry: null, composite: null }), "—");
  });
});

describe("cajón de check-in · estado de los viajeros de la sesión", () => {
  it("travellerStatusLabel: sin documento → documento leído → firmado → firmado y cotejado; el menor no firma", () => {
    assert.equal(travellerStatusLabel(guest()).label, "Sin documento");
    assert.equal(travellerStatusLabel(guest({ captures: [{ id: "cap_1" }] })).label, "Documento leído · sin firma");
    assert.equal(travellerStatusLabel(guest({ status: "data_complete" })).label, "Documento leído · sin firma");
    const signed = travellerStatusLabel(guest({ status: "signed", signatures: [{ method: "touch_portal", signedAt: "2026-09-20T10:00:00.000Z" }] }));
    assert.equal(signed.label, "Firmado · sin cotejar");
    assert.equal(signed.tone, "info");
    const done = travellerStatusLabel(guest({ status: "verified", signatures: [{ method: "touch_reception", signedAt: "2026-09-20T10:00:00.000Z" }], identityVerifiedAt: "2026-09-20T10:05:00.000Z" }));
    assert.deepEqual(done, { document: true, signature: true, verified: true, label: "Firmado y cotejado", tone: "success" });
    const minor = travellerStatusLabel(guest({ isMinor: true, status: "data_complete" }));
    assert.equal(minor.label, "Menor · datos del adulto");
    assert.equal(minor.signature, true);
    assert.equal(travellerStatusLabel(guest({ isMinor: true })).label, "Menor · sin datos");
  });
  it("sessionStatusLabel traduce los estados de la sesión y deja pasar los desconocidos", () => {
    assert.equal(sessionStatusLabel("ready_for_arrival"), "Listo para llegar");
    assert.equal(sessionStatusLabel("handed_off"), "Pasado a recepción");
    assert.equal(sessionStatusLabel("otro"), "otro");
  });
});

describe("cajón de check-in · top-3 del motor sobre el catálogo", () => {
  it("pickSuggestionRoom: la asignada manda; si no, la primera candidata limpia, libre y del tipo entre las tres primeras", () => {
    const candidates = [{ roomId: "r201" }, { roomId: "r202" }, { roomId: "r204" }, { roomId: "r205" }];
    assert.equal(pickSuggestionRoom(candidates, ROOMS, "ste", "r205"), "r205");
    // 201 sucia y 202 ocupada se saltan; 204 inspeccionada y libre gana.
    assert.equal(pickSuggestionRoom(candidates, ROOMS, "ste"), "r204");
    // Solo las tres primeras cuentan: la 205 (cuarta) no se elige aunque valga.
    assert.equal(pickSuggestionRoom([{ roomId: "r201" }, { roomId: "r202" }, { roomId: "r206" }, { roomId: "r205" }], ROOMS, "ste"), undefined);
    // Otro tipo o no vendible → nunca.
    assert.equal(pickSuggestionRoom([{ roomId: "r301" }], ROOMS, "ste"), undefined);
    assert.equal(pickSuggestionRoom([{ roomId: "r206" }], ROOMS, "ste"), undefined);
    assert.equal(pickSuggestionRoom([], ROOMS, "ste"), undefined);
    assert.equal(isRoomClean({ housekeepingStatus: "inspected" }), true);
  });
});

describe("cajón de check-in · firma del titular", () => {
  it("signatureStateOf: «Firmado en el portal el dd/mm HH:MM» con la última firma; pendiente sin firmas; el menor no firma", () => {
    const portal = signatureStateOf({ isMinor: false, signatures: [{ method: "touch_reception", signedAt: "2026-09-19T08:00:00.000Z" }, { method: "touch_portal", signedAt: "2026-09-20T15:04:00.000Z" }] } as never);
    assert.equal(portal.kind, "portal");
    assert.equal(portal.signedAt, "2026-09-20T15:04:00.000Z");
    assert.equal(portal.label, "Firmado en el portal el 20/09 17:04");
    const reception = signatureStateOf({ isMinor: false, signatures: [{ method: "touch_reception", signedAt: "2026-09-20T09:30:00.000Z" }] } as never);
    assert.equal(reception.kind, "reception");
    assert.equal(reception.label, "Firmado en recepción el 20/09 11:30");
    assert.deepEqual(signatureStateOf({ isMinor: false, signatures: [] } as never), { kind: "pending", signedAt: null, label: "Pendiente de firma." });
    assert.equal(signatureStateOf({ isMinor: true, signatures: [] } as never).kind, "not_required");
    assert.equal(signatureStateOf(null).kind, "pending");
  });
});

describe("cajón de check-in · CTA y habitación no lista", () => {
  it("checkinPathFor: POST …/complete solo con sesión en línea y sin override de limpieza; el resto va por el check-in clásico", () => {
    assert.equal(checkinPathFor({ hasSession: true, overrideActive: false }), "complete");
    assert.equal(checkinPathFor({ hasSession: true, overrideActive: true }), "legacy");
    assert.equal(checkinPathFor({ hasSession: false, overrideActive: false }), "legacy");
    assert.equal(checkinPathFor({ hasSession: false, overrideActive: true }), "legacy");
  });
  it("checkinPathFor (corrector REV3-04): con sesión que el huésped NO cerró (invited · in_progress · handed_off) y sin firma en el mostrador, el camino clásico; cerrada o firmada, el completo", () => {
    for (const sessionStatus of ["invited", "in_progress", "handed_off"]) {
      assert.equal(checkinPathFor({ hasSession: true, overrideActive: false, sessionStatus, signed: false }), "legacy", sessionStatus);
      assert.equal(checkinPathFor({ hasSession: true, overrideActive: false, sessionStatus, signed: true }), "complete", `${sessionStatus} firmada en recepción`);
    }
    for (const sessionStatus of ["ready_for_arrival", "arrived"]) {
      assert.equal(checkinPathFor({ hasSession: true, overrideActive: false, sessionStatus, signed: false }), "complete", sessionStatus);
      assert.equal(checkinPathFor({ hasSession: true, overrideActive: true, sessionStatus, signed: true }), "legacy", `${sessionStatus} con override`);
    }
  });
  it("roomNotReadyMessage: habitación y hora prevista de pisos (o que no la hay); sin details, el mensaje del API", () => {
    assert.equal(roomNotReadyMessage({ roomNumber: "204", etaReady: "2026-09-20T11:30:00.000Z" }, "x"), "La 204 no está lista. Pisos prevé tenerla lista a las 13:30. Busca una alternativa limpia del mismo tipo o espera a pisos.");
    assert.equal(roomNotReadyMessage({ roomNumber: null, etaReady: null }, "x"), "La habitación no está lista. Pisos no ha dado hora prevista. Busca una alternativa limpia del mismo tipo o espera a pisos.");
    assert.equal(roomNotReadyMessage(null, "mensaje del API"), "mensaje del API");
  });
});

describe("cajón de check-in · contrato de fuente (Cocoa 22 · honestidad)", () => {
  it("sin el sello falso «Firma digital aplicada», con el pad, el cotejo y el check-in completo; 4 `style=` como antes", () => {
    assert.doesNotMatch(SOURCE, /Firma digital aplicada con sello/);
    assert.match(SOURCE, /completeCheckIn/);
    assert.match(SOURCE, /<SignaturePad /);
    assert.match(SOURCE, /canDo\(navGate, "guest_register\.edit"\)/);
    assert.match(SOURCE, /<CocoaFileInput accept="image\/\*"/);
    assert.match(SOURCE, /<CocoaPopover /);
    assert.match(SOURCE, /<CocoaSheet/);
    assert.equal((SOURCE.match(/\bstyle=\{/g) ?? []).length, 4);
  });
});
