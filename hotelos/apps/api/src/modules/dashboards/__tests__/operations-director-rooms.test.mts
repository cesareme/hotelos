// Unit tests · FIX-1 · F9 — números de habitación en el detalle de
// /hoy/operaciones (dashboards/operations-director.service.ts). withRoomNumbers
// es pura; el fuente se lee para pinar que los números salen de UNA consulta a
// Room (HousekeepingTask no tiene relación con Room) y que ambos tipos de
// detalle exponen `roomNumber`. Sin base de datos. Desde apps/api:
//   node --import tsx --test src/modules/dashboards/__tests__/operations-director-rooms.test.mts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { withRoomNumbers, type OpsDirectorDetailHkTask, type OpsDirectorDetailWorkOrder } from "../operations-director.service.js";

const SOURCE = readFileSync(new URL("../operations-director.service.ts", import.meta.url), "utf8");

describe("withRoomNumbers (pura)", () => {
  const rooms = new Map<string, string>([
    ["room_a", "204"],
    ["room_b", "119"]
  ]);

  it("añade roomNumber a cada fila a partir del mapa id → número y conserva el resto de campos", () => {
    const rows = [
      { id: "t1", roomId: "room_a", taskType: "departure_clean" },
      { id: "t2", roomId: "room_b", taskType: "stayover" }
    ];
    const out = withRoomNumbers(rows, rooms);
    assert.deepEqual(out, [
      { id: "t1", roomId: "room_a", taskType: "departure_clean", roomNumber: "204" },
      { id: "t2", roomId: "room_b", taskType: "stayover", roomNumber: "119" }
    ]);
    assert.notEqual(out[0], rows[0], "no muta las filas de entrada");
    assert.equal((rows[0] as { roomNumber?: string }).roomNumber, undefined);
  });

  it("habitación desconocida o sin habitación (órdenes sin roomId) → roomNumber null, nunca undefined", () => {
    const out = withRoomNumbers([{ id: "wo1", roomId: "room_zzz" }, { id: "wo2", roomId: null }], rooms);
    assert.deepEqual(out, [
      { id: "wo1", roomId: "room_zzz", roomNumber: null },
      { id: "wo2", roomId: null, roomNumber: null }
    ]);
    assert.deepEqual(withRoomNumbers([], rooms), []);
    assert.deepEqual(withRoomNumbers([{ id: "x", roomId: "room_a" }], new Map()), [{ id: "x", roomId: "room_a", roomNumber: null }]);
  });

  it("el resultado satisface los tipos de detalle (roomNumber obligatorio en OpsDirectorDetailHkTask / WorkOrder)", () => {
    const hk: OpsDirectorDetailHkTask[] = withRoomNumbers(
      [{ id: "t", roomId: "room_a", taskType: "inspection", priority: "normal", status: "pending", assignedTo: null, dueAt: null, createdAt: "2026-09-19T00:00:00.000Z" }],
      rooms
    );
    const wo: OpsDirectorDetailWorkOrder[] = withRoomNumbers(
      [{ id: "w", title: "Grifo", priority: "high", status: "open", roomId: null, assignedTo: null, dueDate: null, createdAt: "2026-09-19T00:00:00.000Z" }],
      rooms
    );
    assert.equal(hk[0].roomNumber, "204");
    assert.equal(wo[0].roomNumber, null);
  });
});

describe("operations-director.service.ts · contrato (lectura del fuente)", () => {
  it("ambos tipos de detalle declaran roomNumber: string | null", () => {
    assert.match(SOURCE, /export type OpsDirectorDetailHkTask = \{[\s\S]*?roomNumber: string \| null;[\s\S]*?\};/);
    assert.match(SOURCE, /export type OpsDirectorDetailWorkOrder = \{[\s\S]*?roomNumber: string \| null;[\s\S]*?\};/);
  });

  it("resuelve los números con UNA consulta prisma.room.findMany({ id in }, select id/number) envuelta en safe(\"details.rooms\") y saltada sin ids", () => {
    const matches = SOURCE.match(/prisma\.room\.findMany\(\{ where: \{ id: \{ in: detailRoomIds \} \}, select: \{ id: true, number: true \} \}\)/g) ?? [];
    assert.equal(matches.length, 1);
    assert.match(SOURCE, /detailRoomIds\.length === 0\s*\?\s*\[\]\s*:\s*await safe\(\s*"details\.rooms",/);
    assert.match(SOURCE, /hkTasks: withRoomNumbers\(/);
    assert.match(SOURCE, /workOrders: withRoomNumbers\(/);
  });
});
