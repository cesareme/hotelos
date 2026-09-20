// Tanda CHK (lote W1-C) · motor puro de asignación explicable (diseño §4b).
// Sin base de datos: `suggestRooms` recibe todo en memoria.
//
//   node --import tsx --test src/modules/pms/__tests__/room-assignment.engine.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_ASSIGNMENT_WEIGHTS,
  isVipForAssignment,
  parseFloorNumber,
  suggestRooms,
  type AssignmentCandidate,
  type AssignmentReservationInput,
  type AssignmentRoomInput,
  type AssignmentSuggestionInput,
  type AssignmentSuggestionResult
} from "../room-assignment.engine.js";

const NOW = new Date("2026-09-19T10:00:00Z");

function room(id: string, number: string, over: Partial<AssignmentRoomInput> = {}): AssignmentRoomInput {
  return {
    id,
    number,
    roomTypeId: "std",
    floor: "1",
    floorId: null,
    viewType: null,
    maxOccupancy: 2,
    bedConfigurationJson: {},
    featuresJson: {},
    accessibilityJson: {},
    status: "clean",
    housekeepingStatus: "clean",
    maintenanceStatus: "ok",
    sellable: true,
    active: true,
    ...over
  };
}

function reservation(over: Partial<AssignmentReservationInput> = {}): AssignmentReservationInput {
  return { id: "res_1", roomTypeId: "std", arrivalDate: "2026-09-19", departureDate: "2026-09-21", adults: 2, children: 0, vipFlag: false, ...over };
}

function base(over: Partial<AssignmentSuggestionInput> = {}): AssignmentSuggestionInput {
  return {
    reservation: reservation(),
    guest: null,
    rooms: [],
    roomTypes: [
      { id: "eco", displayOrder: 0, maxOccupancy: 2 },
      { id: "std", displayOrder: 1, maxOccupancy: 2 },
      { id: "sup", displayOrder: 2, maxOccupancy: 3 }
    ],
    overlappingReservations: [],
    openWorkOrderRoomIds: [],
    roomBlocks: [],
    roomConnections: [],
    groupAssignedRooms: [],
    demandByRoomType: {},
    policy: { allowUpgrade: false, requireInspectedRoom: false, weights: {} },
    now: NOW,
    ...over
  };
}

const ids = (result: AssignmentSuggestionResult) => result.candidates.map((c) => c.roomId);
const rejectedReason = (result: AssignmentSuggestionResult, roomId: string) => result.rejected.find((r) => r.roomId === roomId)?.reason;
const candidate = (result: AssignmentSuggestionResult, roomId: string) => result.candidates.find((c) => c.roomId === roomId);
const reason = (c: AssignmentCandidate | undefined, rule: string) => c?.reasons.find((r) => r.rule === rule);
const reasonsOf = (c: AssignmentCandidate | undefined, rule: string) => c?.reasons.filter((r) => r.rule === rule) ?? [];
function assertScoreInvariant(result: AssignmentSuggestionResult) {
  for (const c of result.candidates) {
    assert.equal(c.score, c.reasons.reduce((sum, r) => sum + r.weight, 0), `score de ${c.number} ≠ Σ pesos`);
  }
}

describe("room-assignment.engine · fase A (filtros duros)", () => {
  it("descarta bloqueadas, no vendibles, con orden abierta, con bloqueo de fechas y ocupadas", () => {
    const result = suggestRooms(
      base({
        rooms: [
          room("r_blocked", "101", { maintenanceStatus: "blocked", sellable: false, status: "out_of_order" }),
          room("r_unsellable", "102", { sellable: false }),
          room("r_inactive", "103", { active: false }),
          room("r_wo", "104"),
          room("r_block", "105"),
          room("r_block_far", "106"),
          room("r_occ", "107", { status: "occupied" }),
          room("r_ooo", "108", { status: "out_of_order" }),
          room("r_oos", "109", { status: "out_of_service" }),
          room("r_taken", "110"),
          room("r_taken_cancelled", "111"),
          room("r_self", "112"),
          room("r_ok", "113")
        ],
        openWorkOrderRoomIds: ["r_wo"],
        roomBlocks: [
          { roomId: "r_block", fromDate: "2026-09-20", toDate: "2026-09-22" },
          { roomId: "r_block_far", fromDate: "2026-09-25", toDate: "2026-09-26" }
        ],
        overlappingReservations: [
          { id: "res_2", assignedRoomId: "r_taken", status: "confirmed" },
          { id: "res_3", assignedRoomId: "r_taken_cancelled", status: "cancelled" },
          { id: "res_1", assignedRoomId: "r_self", status: "confirmed" }
        ]
      })
    );
    assert.equal(rejectedReason(result, "r_blocked"), "Bloqueada por mantenimiento");
    assert.equal(rejectedReason(result, "r_unsellable"), "No vendible");
    assert.equal(rejectedReason(result, "r_inactive"), "Habitación inactiva");
    assert.equal(rejectedReason(result, "r_wo"), "Orden de trabajo abierta");
    assert.equal(rejectedReason(result, "r_block"), "Bloqueada del 2026-09-20 al 2026-09-22");
    assert.equal(rejectedReason(result, "r_occ"), "Ocupada");
    assert.match(rejectedReason(result, "r_ooo") ?? "", /out_of_order/);
    assert.match(rejectedReason(result, "r_oos") ?? "", /out_of_service/);
    assert.equal(rejectedReason(result, "r_taken"), "Asignada a otra reserva solapada");
    for (const free of ["r_block_far", "r_taken_cancelled", "r_self", "r_ok"]) {
      assert.equal(rejectedReason(result, free), undefined, `${free} no debe rechazarse`);
    }
    assert.equal(result.rejected.length, 9);
    assert.equal(result.candidates.length, 3, "top-3");
    for (const id of ids(result)) assert.ok(["r_block_far", "r_taken_cancelled", "r_self", "r_ok"].includes(id));
    assert.equal(result.rulesVersion, "chk-rules-1");
    assert.equal(result.source, "rules");
    assertScoreInvariant(result);
  });

  it("respeta tipo igual o superior solo con allowUpgrade", () => {
    const rooms = [room("s1", "201"), room("u1", "301", { roomTypeId: "sup" }), room("e1", "101", { roomTypeId: "eco" })];

    const strict = suggestRooms(base({ rooms }));
    assert.deepEqual(ids(strict), ["s1"]);
    assert.match(rejectedReason(strict, "u1") ?? "", /no permite mejora/);
    assert.match(rejectedReason(strict, "e1") ?? "", /inferior/);

    const upgradeWithSame = suggestRooms(base({ rooms, policy: { allowUpgrade: true, requireInspectedRoom: false, weights: {} } }));
    assert.deepEqual(ids(upgradeWithSame), ["s1"]);
    assert.match(rejectedReason(upgradeWithSame, "u1") ?? "", /quedan habitaciones del tipo reservado/);

    const upgradeOnly = suggestRooms(base({ rooms: [rooms[1]!, rooms[2]!], policy: { allowUpgrade: true, requireInspectedRoom: false, weights: {} } }));
    assert.deepEqual(ids(upgradeOnly), ["u1"]);
    const up = reason(candidate(upgradeOnly, "u1"), "free_upgrade");
    assert.equal(up?.weight, -10);
    assert.match(up?.detail ?? "", /Mejora sin coste/);
    assert.equal(candidate(upgradeOnly, "u1")?.score, 20 - 10);
    assert.match(rejectedReason(upgradeOnly, "e1") ?? "", /inferior/);

    const unknownType = suggestRooms(base({ rooms: [room("x1", "401", { roomTypeId: "loft" })], policy: { allowUpgrade: true, requireInspectedRoom: false, weights: {} } }));
    assert.match(rejectedReason(unknownType, "x1") ?? "", /sin categoría comparable/);

    const untyped = suggestRooms(base({ rooms, reservation: reservation({ roomTypeId: null }) }));
    assert.equal(untyped.candidates.length, 3);
    assert.ok(untyped.dataNotes.some((n) => /no tiene tipo de habitación/.test(n)));
    assertScoreInvariant(upgradeOnly);
  });

  it("ocupación máxima y accesibilidad como filtros duros", () => {
    const family = reservation({ adults: 2, children: 1 });
    const capacity = suggestRooms(
      base({
        reservation: family,
        roomTypes: [
          { id: "std", displayOrder: 1, maxOccupancy: 3 },
          { id: "bare", displayOrder: 1 }
        ],
        rooms: [room("small", "101", { maxOccupancy: 2 }), room("byType", "102", { maxOccupancy: null }), room("big", "104", { maxOccupancy: 4 })]
      })
    );
    assert.equal(rejectedReason(capacity, "small"), "Capacidad 2 para 3 personas");
    assert.equal(rejectedReason(capacity, "byType"), undefined, "cae al maxOccupancy del tipo (3)");
    assert.equal(rejectedReason(capacity, "big"), undefined);
    assert.deepEqual(ids(capacity).sort(), ["big", "byType"]);

    // Sin maxOccupancy en la habitación ni en el tipo → 2 por defecto.
    const defaultTwo = suggestRooms(
      base({
        reservation: reservation({ adults: 2, children: 1, roomTypeId: "bare" }),
        roomTypes: [{ id: "bare", displayOrder: 1 }],
        rooms: [room("defaultTwo", "103", { roomTypeId: "bare", maxOccupancy: null })]
      })
    );
    assert.equal(rejectedReason(defaultTwo, "defaultTwo"), "Capacidad 2 para 3 personas");

    const accessible = suggestRooms(
      base({
        reservation: reservation({ accessibilityNeeds: "silla de ruedas" }),
        rooms: [
          room("a1", "101", { accessibilityJson: { accessible: true } }),
          room("a2", "102", { featuresJson: ["accessible"] }),
          room("a3", "103", { featuresJson: { accessible: false } }),
          room("a4", "104")
        ]
      })
    );
    assert.deepEqual(ids(accessible).sort(), ["a1", "a2"]);
    assert.equal(rejectedReason(accessible, "a3"), "No accesible (la reserva lo requiere)");
    assert.equal(rejectedReason(accessible, "a4"), "No accesible (la reserva lo requiere)");

    const noNeeds = suggestRooms(base({ rooms: [room("a4", "104")] }));
    assert.deepEqual(ids(noNeeds), ["a4"]);
  });
});

describe("room-assignment.engine · fase B (puntuación)", () => {
  it("inspected supera a clean y dirty con ETA cercana se descarta", () => {
    const rooms = [
      room("clean", "101", { housekeepingStatus: "clean", status: "clean" }),
      room("insp", "102", { housekeepingStatus: "inspected", status: "inspected" }),
      room("dirty", "103", { housekeepingStatus: "dirty", status: "dirty" })
    ];
    const soon = suggestRooms(base({ rooms, reservation: reservation({ etaHHMM: "11:30" }) }));
    assert.deepEqual(ids(soon), ["insp", "clean"]);
    assert.equal(reason(candidate(soon, "insp"), "hk_inspected")?.weight, 30);
    assert.equal(reason(candidate(soon, "clean"), "hk_clean")?.weight, 20);
    assert.match(rejectedReason(soon, "dirty") ?? "", /Sucia con llegada a las 11:30 \(≤ 2 h\).*pisos/);
    assert.deepEqual(soon.housekeepingAlerts, [{ roomId: "dirty", number: "103", etaHHMM: "11:30" }]);
    assert.equal(soon.confidence, (30 - 20) / 30);

    const later = suggestRooms(base({ rooms, reservation: reservation({ etaHHMM: "16:00" }) }));
    assert.deepEqual(ids(later), ["insp", "clean", "dirty"]);
    assert.equal(candidate(later, "dirty")?.score, 0);
    assert.match(candidate(later, "dirty")?.warnings[0] ?? "", /Sucia: llegada a las 16:00 \(6 h de margen\)/);
    assert.equal(later.housekeepingAlerts.length, 0);

    const mid = suggestRooms(base({ rooms, reservation: reservation({ etaHHMM: "13:00" }) }));
    assert.match(candidate(mid, "dirty")?.warnings[0] ?? "", /menos de 4 h, avisar a pisos/);

    const noEta = suggestRooms(base({ rooms }));
    assert.equal(candidate(noEta, "dirty")?.score, 0);
    assert.match(candidate(noEta, "dirty")?.warnings[0] ?? "", /sin hora de llegada/);
    assert.ok(noEta.dataNotes.some((n) => /sin hora de llegada \(ETA\)/.test(n)));

    const inspectedOnly = suggestRooms(base({ rooms, policy: { allowUpgrade: false, requireInspectedRoom: true, weights: {} } }));
    assert.deepEqual(ids(inspectedOnly), ["insp"]);
    assert.equal(rejectedReason(inspectedOnly, "clean"), "La política exige habitación inspeccionada (estado: limpia)");
    assert.equal(rejectedReason(inspectedOnly, "dirty"), "La política exige habitación inspeccionada (estado: sucia)");
    assertScoreInvariant(later);
  });

  it("cada preferencia satisfecha suma 15 con tope 45 y motivo legible", () => {
    const rooms = [
      room("top", "401", { floor: "4", viewType: "Vista al mar", featuresJson: { quiet: true, far_elevator: true, near_elevator: false }, bedConfigurationJson: { type: "king" } }),
      room("low", "101", { floor: "1", featuresJson: ["quiet"], bedConfigurationJson: { beds: ["twin", "twin"] } }),
      room("mid", "201", { floor: "2", viewType: "ciudad" }),
      room("mid2", "202", { floor: "2" }),
      room("conn", "301", { floor: "3" }),
      room("partner", "302", { floor: "3" })
    ];
    const guest = { id: "g1", preferences: ["floor_high", "view_sea", "quiet", "far_elevator", "bed_king", "jacuzzi"] };
    const result = suggestRooms(base({ rooms, guest }));
    const top = candidate(result, "top");
    const prefs = reasonsOf(top, "preference");
    assert.equal(prefs.length, 5, "cinco preferencias satisfechas → cinco motivos");
    assert.deepEqual(
      prefs.map((r) => r.weight),
      [15, 15, 15, 0, 0]
    );
    assert.equal(prefs.reduce((s, r) => s + r.weight, 0), 45, "tope de +45");
    assert.deepEqual(
      prefs.map((r) => r.detail),
      ["Planta alta como pidió", "Vista al mar como pidió", "Habitación tranquila como pidió", "Lejos del ascensor como pidió (tope de preferencias alcanzado)", "Cama king como pidió (tope de preferencias alcanzado)"]
    );
    assert.equal(top?.score, 20 + 45);
    assert.equal(ids(result)[0], "top");
    // Planta 1 con median 2,5: floor_high no; quiet (array) sí.
    const low = suggestRooms(base({ rooms, guest: { id: "g1", preferences: ["quiet", "floor_low", "bed_twin"] } }));
    assert.deepEqual(
      reasonsOf(candidate(low, "low"), "preference").map((r) => r.detail),
      ["Habitación tranquila como pidió", "Planta baja como pidió", "Camas separadas como pidió"]
    );
    assert.ok(result.dataNotes.some((n) => n === "preferencia no reconocida: jacuzzi"));
    assert.ok(!result.dataNotes.some((n) => /sin preferencias/.test(n)));

    const city = suggestRooms(base({ rooms, guest: { id: "g1", preferences: ["view_city"] } }));
    assert.equal(reason(candidate(city, "mid"), "preference")?.detail, "Vista a la ciudad como pidió");
    assert.equal(reason(candidate(city, "mid2"), "preference"), undefined);

    const connecting = suggestRooms(
      base({ rooms, guest: { id: "g1", preferences: ["connecting"] }, roomConnections: [{ roomAId: "conn", roomBId: "partner", kind: "connecting" }] })
    );
    assert.equal(reason(candidate(connecting, "conn"), "preference")?.detail, "Comunicada con una habitación libre como pidió");
    const partnerBusy = suggestRooms(
      base({
        rooms: rooms.map((r) => (r.id === "partner" ? { ...r, status: "occupied" } : r)),
        guest: { id: "g1", preferences: ["connecting"] },
        roomConnections: [{ roomAId: "conn", roomBId: "partner", kind: "connecting" }]
      })
    );
    assert.equal(reason(candidate(partnerBusy, "conn"), "preference"), undefined, "la pareja ocupada no cuenta");
    assertScoreInvariant(result);
  });

  it("VIP, recurrente y grupo suman con motivo", () => {
    const rooms = [
      room("r1", "301", { floor: "3", viewType: "mar" }),
      room("r2", "101", { floor: "1" }),
      room("r3", "302", { floor: "3" })
    ];
    const result = suggestRooms(
      base({
        rooms,
        reservation: reservation({ groupCode: "G1" }),
        guest: { id: "g1", vipCode: "V1", preferences: [], lastStayRoomId: "r2" },
        groupAssignedRooms: [{ roomId: "r9", floor: "3" }]
      })
    );
    const r1 = candidate(result, "r1");
    assert.equal(reason(r1, "vip")?.weight, 25);
    assert.equal(reason(r1, "vip")?.detail, "Cliente VIP: mejor vista/planta disponible");
    assert.equal(reason(r1, "group")?.detail, "Junto al resto del grupo (planta 3)");
    assert.equal(r1?.score, 20 + 25 + 15);
    const r2 = candidate(result, "r2");
    assert.equal(reason(r2, "returning")?.weight, 20);
    assert.equal(reason(r2, "returning")?.detail, "Se alojó aquí en su última visita");
    assert.equal(reason(r2, "vip"), undefined);
    assert.equal(r2?.score, 40);
    const r3 = candidate(result, "r3");
    assert.equal(reason(r3, "group")?.weight, 15);
    assert.equal(reason(r3, "vip"), undefined);
    assert.equal(r3?.score, 35);
    assert.deepEqual(ids(result), ["r1", "r2", "r3"]);
    assertScoreInvariant(result);

    assert.equal(isVipForAssignment({ vipFlag: false }, { id: "g", preferences: [], loyaltyTier: "Diamond" }), true);
    assert.equal(isVipForAssignment({ vipFlag: false }, { id: "g", preferences: [], loyaltyTier: "silver" }), false);
    assert.equal(isVipForAssignment({ vipFlag: true }, null), true);
    assert.equal(isVipForAssignment({ vipFlag: false }, null), false);

    const noData = suggestRooms(base({ rooms: [room("x", "1", { floor: null }), room("y", "2", { floor: null })], reservation: reservation({ vipFlag: true }) }));
    assert.equal(reason(candidate(noData, "x"), "vip"), undefined);
    assert.ok(noData.dataNotes.some((n) => /VIP sin datos de vista ni planta/.test(n)));
    const grouped = suggestRooms(base({ rooms, reservation: reservation({ groupBookingId: "gb1" }) }));
    assert.ok(grouped.dataNotes.some((n) => /grupo sin habitaciones asignadas/.test(n)));
    assert.equal(parseFloorNumber("Planta 3"), 3);
    assert.equal(parseFloorNumber("PB"), 0);
    assert.equal(parseFloorNumber("ático"), null);
  });

  it("protección de inventario resta 20 en la última del tipo con demanda", () => {
    const rooms = [room("s1", "101"), room("s2", "102")];
    const protectedResult = suggestRooms(base({ rooms, demandByRoomType: { std: { available: 1, pendingArrivals: 2 } } }));
    const inv = reason(candidate(protectedResult, "s1"), "inventory_protection");
    assert.equal(inv?.weight, -20);
    assert.equal(inv?.detail, "Se reserva para otra llegada (última del tipo, 2 llegadas pendientes)");
    assert.equal(candidate(protectedResult, "s1")?.score, 0);

    const plenty = suggestRooms(base({ rooms, demandByRoomType: { std: { available: 3, pendingArrivals: 2 } } }));
    assert.equal(reason(candidate(plenty, "s1"), "inventory_protection"), undefined);
    const noDemand = suggestRooms(base({ rooms, demandByRoomType: { std: { available: 1, pendingArrivals: 0 } } }));
    assert.equal(reason(candidate(noDemand, "s1"), "inventory_protection"), undefined);

    const unknown = suggestRooms(base({ rooms, demandByRoomType: undefined }));
    assert.equal(reason(candidate(unknown, "s1"), "inventory_protection"), undefined);
    assert.ok(unknown.dataNotes.some((n) => /sin datos de demanda por tipo/.test(n)));
    assertScoreInvariant(protectedResult);
  });

  it("empate → confidence 0 y aviso", () => {
    const tie = suggestRooms(base({ rooms: [room("a", "101"), room("b", "102"), room("c", "103", { housekeepingStatus: "dirty", status: "dirty" })] }));
    assert.equal(tie.confidence, 0);
    assert.deepEqual(ids(tie), ["a", "b", "c"]);
    assert.deepEqual(candidate(tie, "a")?.warnings, ["Empate con la habitación 102: elige a mano"]);
    assert.deepEqual(candidate(tie, "b")?.warnings, ["Empate con la habitación 101: elige a mano"]);
    assert.ok(!candidate(tie, "c")?.warnings.some((w) => /Empate/.test(w)));

    const single = suggestRooms(base({ rooms: [room("a", "101")] }));
    assert.equal(single.confidence, 0);
    assert.ok(single.dataNotes.some((n) => /una sola candidata/.test(n)));

    const clear = suggestRooms(base({ rooms: [room("a", "101", { housekeepingStatus: "inspected", status: "inspected" }), room("b", "102")] }));
    assert.equal(clear.confidence, (30 - 20) / 30);
    assert.deepEqual(candidate(clear, "a")?.warnings, []);

    const none = suggestRooms(base({ rooms: [room("a", "101", { status: "occupied" })] }));
    assert.equal(none.confidence, 0);
    assert.deepEqual(none.candidates, []);
    assert.ok(none.dataNotes.some((n) => /ninguna habitación cumple/.test(n)));
  });

  it("sin datos de preferencias → dataNotes y sin motivos inventados", () => {
    const rooms = [room("a", "101"), room("b", "102", { floor: "2" })];
    const empty = suggestRooms(base({ rooms, guest: { id: "g1", preferences: [] } }));
    assert.ok(empty.dataNotes.includes("sin preferencias registradas"));
    assert.ok(empty.dataNotes.includes("sin habitación de estancia previa"));
    assert.ok(empty.dataNotes.includes("sin datos de rotación (estancias en 30 días)"));
    for (const c of empty.candidates) assert.deepEqual(c.reasons.map((r) => r.rule), ["hk_clean"]);

    const noGuest = suggestRooms(base({ rooms }));
    assert.ok(noGuest.dataNotes.some((n) => /sin datos del huésped/.test(n)));
    for (const c of noGuest.candidates) assert.deepEqual(c.reasons.map((r) => r.rule), ["hk_clean"]);

    const noView = suggestRooms(base({ rooms, guest: { id: "g1", preferences: ["view_sea", "bed_king", "quiet"] } }));
    assert.ok(noView.dataNotes.includes("sin datos de vista en las habitaciones"));
    assert.ok(noView.dataNotes.includes("sin datos de camas en las habitaciones"));
    assert.ok(noView.dataNotes.includes("sin datos de características en las habitaciones"));
    for (const c of noView.candidates) assert.equal(reasonsOf(c, "preference").length, 0);

    const noFloor = suggestRooms(base({ rooms: rooms.map((r) => ({ ...r, floor: null })), guest: { id: "g1", preferences: ["floor_high"] } }));
    assert.ok(noFloor.dataNotes.includes("sin datos de planta en las habitaciones"));

    const rotation = suggestRooms(base({ rooms, guest: { id: "g1", preferences: [], stays30dByRoomId: { a: 2, b: 0 } } }));
    assert.equal(reason(candidate(rotation, "b"), "rotation")?.weight, 5);
    assert.equal(reason(candidate(rotation, "b"), "rotation")?.detail, "Reparte el uso (0 estancias en 30 días)");
    assert.equal(reason(candidate(rotation, "a"), "rotation"), undefined);
    assert.ok(!rotation.dataNotes.some((n) => /rotación/.test(n)));

    const request = suggestRooms(base({ rooms, reservation: reservation({ specialRequests: "lejos del ascensor" }) }));
    const sr = reason(candidate(request, "a"), "special_request");
    assert.equal(sr?.weight, 0);
    assert.equal(sr?.detail, "Pidió: lejos del ascensor");
  });

  it("pesos de la política sobrescriben los por defecto", () => {
    const rooms = [
      room("insp", "401", { housekeepingStatus: "inspected", status: "inspected", floor: "4", viewType: "mar" }),
      room("clean", "101", { floor: "1" })
    ];
    const result = suggestRooms(
      base({
        rooms,
        guest: { id: "g1", preferences: ["floor_high", "view_sea"], vipCode: "V" },
        policy: { allowUpgrade: false, requireInspectedRoom: false, weights: { hk_inspected: 50, hk_clean: 5, preference: 10, preference_cap: 10, vip: 0 } }
      })
    );
    const insp = candidate(result, "insp");
    assert.equal(reason(insp, "hk_inspected")?.weight, 50);
    assert.deepEqual(
      reasonsOf(insp, "preference").map((r) => r.weight),
      [10, 0]
    );
    assert.equal(reason(insp, "vip")?.weight, 0);
    assert.equal(insp?.score, 60);
    assert.equal(reason(candidate(result, "clean"), "hk_clean")?.weight, 5);
    assert.equal(result.confidence, (60 - 5) / 60);
    assertScoreInvariant(result);

    assert.equal(DEFAULT_ASSIGNMENT_WEIGHTS.hk_inspected, 30);
    assert.equal(DEFAULT_ASSIGNMENT_WEIGHTS.preference_cap, 45);
    assert.ok(Object.isFrozen(DEFAULT_ASSIGNMENT_WEIGHTS));
    const ignored = suggestRooms(base({ rooms, policy: { allowUpgrade: false, requireInspectedRoom: false, weights: { hk_inspected: undefined } } }));
    assert.equal(reason(candidate(ignored, "insp"), "hk_inspected")?.weight, 30, "undefined no pisa el valor por defecto");
  });
});
