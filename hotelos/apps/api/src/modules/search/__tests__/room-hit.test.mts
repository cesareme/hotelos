// Tanda UX-1 · corrector L-06: un hit de habitación en ⌘K lleva a la reserva
// alojada en ella (ficha) o, sin alojado, al tablero de habitaciones; nunca al
// inventario de configuración, que a recepción le responde «Sin acceso».
//
//   node --import tsx --test src/modules/search/__tests__/room-hit.test.mts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { roomHit } from "../search.service.js";

const room = { id: "room_310", number: "310", roomCode: "SUP-310", displayName: null, floor: "3", status: "occupied" };

describe("search · hit de habitación (L-06)", () => {
  it("con reserva alojada abre ReservationDetailWorkspace con reservationId y lo dice en el subtítulo", () => {
    const hit = roomHit({ room, live: { id: "res_uxday_t4", code: "UXDAY-T4" } });
    assert.equal(hit.kind, "room");
    assert.equal(hit.screen, "ReservationDetailWorkspace");
    assert.deepEqual(hit.params, { reservationId: "res_uxday_t4", roomId: "room_310" });
    assert.equal(hit.subtitle, "Planta 3 · SUP-310 · En el hotel: UXDAY-T4");
    assert.equal(hit.badge, "occupied", "el estado crudo viaja; el front lo pasa por el diccionario");
  });
  it("sin alojado abre el tablero (RoomRackScreen) con roomId, nunca RoomInventoryManager", () => {
    const hit = roomHit({ room: { ...room, status: "clean", floor: null, roomCode: null }, live: null });
    assert.equal(hit.screen, "RoomRackScreen");
    assert.deepEqual(hit.params, { roomId: "room_310" });
    assert.equal(hit.subtitle, undefined);
    const source = readFileSync(new URL("../search.service.ts", import.meta.url), "utf8");
    assert.doesNotMatch(source, /screen: "RoomInventoryManager"/);
    assert.match(source, /status: "checked_in", assignedRoomId: \{ in: rooms\.map/);
  });
});
