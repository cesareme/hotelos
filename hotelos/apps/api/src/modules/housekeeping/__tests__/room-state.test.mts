// Unit tests · Tanda L5 (lote A) · estado de habitación unificado.
// Máquina de estados PURA (nextRoomState) por ocupación × limpieza × evento,
// idempotencia (changed:false), alias de normalizeHousekeepingInput, roomStateOf
// y foldRoomStateCounts (limpieza por hk en todas las ocupaciones; occupied y
// out_of_order | out_of_service por status).
// Run from apps/api with
//   node --import tsx --test src/modules/housekeeping/__tests__/room-state.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HOUSEKEEPING_STATUSES,
  MAINTENANCE_STATUSES,
  ROOM_STATE_EVENTS,
  foldRoomStateCounts,
  isHousekeepingStatus,
  isMaintenanceStatus,
  nextRoomState,
  normalizeHousekeepingInput,
  roomStateCountsAsList,
  roomStateOf,
  snapshotOf,
  type HousekeepingStatus,
  type RoomStateEvent,
  type RoomStateSnapshot
} from "../room-state.service.js";

type OccupancyCase = "vacant" | "occupied" | "out_of_order" | "out_of_service";
const OCCUPANCIES: readonly OccupancyCase[] = ["vacant", "occupied", "out_of_order", "out_of_service"];

/** Fila COHERENTE con el modelo: libre = status espejo de la limpieza; OOO = bloqueada y no vendible. */
function snapshot(occupancy: OccupancyCase, hk: HousekeepingStatus): RoomStateSnapshot {
  switch (occupancy) {
    case "vacant":
      return { status: hk, housekeepingStatus: hk, maintenanceStatus: "ok", sellable: true };
    case "occupied":
      return { status: "occupied", housekeepingStatus: hk, maintenanceStatus: "ok", sellable: true };
    case "out_of_order":
      return { status: "out_of_order", housekeepingStatus: hk, maintenanceStatus: "blocked", sellable: false };
    case "out_of_service":
      return { status: "out_of_service", housekeepingStatus: hk, maintenanceStatus: "ok", sellable: true };
  }
}

function okNext(current: RoomStateSnapshot, event: RoomStateEvent, context?: { inHouse?: boolean }) {
  const result = nextRoomState(current, event, context);
  assert.ok(result.ok, `${event} sobre ${JSON.stringify(current)} no debe fallar`);
  return result;
}

describe("nextRoomState · matriz ocupación × limpieza × evento", () => {
  it("cubre las 4 ocupaciones × 3 limpiezas × 9 eventos con invariantes del modelo", () => {
    let cases = 0;
    for (const occupancy of OCCUPANCIES) {
      for (const hk of HOUSEKEEPING_STATUSES) {
        for (const event of ROOM_STATE_EVENTS) {
          const current = snapshot(occupancy, hk);
          const result = nextRoomState(current, event);
          cases += 1;
          if (!result.ok) {
            // Dos fallos posibles: inspeccionar una sucia y liberar a mano una bloqueada por orden de trabajo (OP-05).
            if (event === "mark_sellable") {
              assert.equal(occupancy, "out_of_order");
              assert.equal(result.error, "blocked");
              continue;
            }
            assert.equal(event, "mark_inspected");
            assert.equal(hk, "dirty");
            assert.equal(result.error, "not_clean");
            continue;
          }
          const { next, changed, patch } = result;
          // Vocabulario cerrado a la salida.
          assert.ok(isHousekeepingStatus(next.housekeepingStatus), `hk fuera de vocabulario: ${next.housekeepingStatus}`);
          assert.ok(isMaintenanceStatus(next.maintenanceStatus), `mnt fuera de vocabulario: ${next.maintenanceStatus}`);
          // Espejo: si status es un valor de limpieza, es exactamente la limpieza.
          if (isHousekeepingStatus(next.status)) {
            assert.equal(next.status, next.housekeepingStatus, `status espejo roto tras ${event} en ${occupancy}/${hk}`);
          }
          // `changed` ⇔ el parche no está vacío ⇔ next difiere de current.
          assert.equal(changed, Object.keys(patch).length > 0);
          assert.equal(changed, JSON.stringify(next) !== JSON.stringify(current));
          for (const [key, value] of Object.entries(patch)) {
            assert.equal(next[key as keyof RoomStateSnapshot], value);
            assert.notEqual(current[key as keyof RoomStateSnapshot], value, `el parche solo lleva campos que cambian (${key})`);
          }
          // La ocupación solo la mueven check_in / check_out / bloqueo / liberación.
          if (event === "mark_clean" || event === "mark_dirty" || event === "mark_inspected") {
            if (occupancy !== "vacant") assert.equal(next.status, current.status, `${event} no toca la ocupación (${occupancy})`);
            assert.equal(next.maintenanceStatus, current.maintenanceStatus);
            assert.equal(next.sellable, current.sellable);
          }
          // Idempotencia: el mismo evento otra vez no cambia nada más.
          const again = nextRoomState(next, event);
          assert.ok(again.ok, `${event} repetido no falla`);
          assert.equal(again.changed, false, `${event} repetido sobre ${occupancy}/${hk} es idempotente`);
          assert.deepEqual(again.next, next);
        }
      }
    }
    assert.equal(cases, 4 * 3 * 9);
  });

  it("check_in: status → occupied, limpieza intacta; repetido sobre ocupada → changed:false", () => {
    for (const hk of HOUSEKEEPING_STATUSES) {
      const r = okNext(snapshot("vacant", hk), "check_in");
      assert.equal(r.changed, true);
      assert.equal(r.next.status, "occupied");
      assert.equal(r.next.housekeepingStatus, hk);
      assert.deepEqual(r.patch, { status: "occupied" });
      const twice = okNext(snapshot("occupied", hk), "check_in");
      assert.equal(twice.changed, false);
    }
  });

  it("check_out: libre y sucia (status dirty / hk dirty); una OOO u OOS conserva su indisponibilidad", () => {
    const fromOccupied = okNext(snapshot("occupied", "clean"), "check_out");
    assert.deepEqual(fromOccupied.next, { status: "dirty", housekeepingStatus: "dirty", maintenanceStatus: "ok", sellable: true });
    const fromOoo = okNext(snapshot("out_of_order", "clean"), "check_out");
    assert.equal(fromOoo.next.status, "out_of_order");
    assert.equal(fromOoo.next.housekeepingStatus, "dirty");
    assert.equal(fromOoo.next.maintenanceStatus, "blocked");
    const fromOos = okNext(snapshot("out_of_service", "inspected"), "check_out");
    assert.equal(fromOos.next.status, "out_of_service");
    assert.equal(fromOos.next.housekeepingStatus, "dirty");
    assert.equal(okNext(snapshot("vacant", "dirty"), "check_out").changed, false);
  });

  it("mark_clean: hk → clean y status → clean solo si está libre; sobre clean o inspected → changed:false", () => {
    const vacant = okNext(snapshot("vacant", "dirty"), "mark_clean");
    assert.deepEqual(vacant.next, { status: "clean", housekeepingStatus: "clean", maintenanceStatus: "ok", sellable: true });
    const occupied = okNext(snapshot("occupied", "dirty"), "mark_clean");
    assert.equal(occupied.next.status, "occupied", "una ocupada marcada limpia sigue ocupada");
    assert.equal(occupied.next.housekeepingStatus, "clean");
    assert.deepEqual(occupied.patch, { housekeepingStatus: "clean" });
    const ooo = okNext(snapshot("out_of_order", "dirty"), "mark_clean");
    assert.equal(ooo.next.status, "out_of_order");
    assert.equal(ooo.next.housekeepingStatus, "clean");
    for (const occupancy of OCCUPANCIES) {
      assert.equal(okNext(snapshot(occupancy, "clean"), "mark_clean").changed, false, `clean → mark_clean (${occupancy})`);
      const inspected = okNext(snapshot(occupancy, "inspected"), "mark_clean");
      assert.equal(inspected.changed, false, `inspected → mark_clean (${occupancy}) no degrada`);
      assert.equal(inspected.next.housekeepingStatus, "inspected");
    }
  });

  it("mark_dirty: hk → dirty y status → dirty si está libre; sobre sucia → changed:false", () => {
    const vacant = okNext(snapshot("vacant", "inspected"), "mark_dirty");
    assert.deepEqual(vacant.next, { status: "dirty", housekeepingStatus: "dirty", maintenanceStatus: "ok", sellable: true });
    const occupied = okNext(snapshot("occupied", "clean"), "mark_dirty");
    assert.equal(occupied.next.status, "occupied");
    assert.equal(occupied.next.housekeepingStatus, "dirty");
    for (const occupancy of OCCUPANCIES) assert.equal(okNext(snapshot(occupancy, "dirty"), "mark_dirty").changed, false);
  });

  it("mark_inspected: sucia → not_clean; inspeccionada → changed:false; limpia → inspected (status inspected solo si libre)", () => {
    for (const occupancy of OCCUPANCIES) {
      const dirty = nextRoomState(snapshot(occupancy, "dirty"), "mark_inspected");
      assert.equal(dirty.ok, false);
      assert.equal(!dirty.ok && dirty.error, "not_clean");
      const inspected = okNext(snapshot(occupancy, "inspected"), "mark_inspected");
      assert.equal(inspected.changed, false, `inspected ×2 (${occupancy}) es idempotente`);
      const clean = okNext(snapshot(occupancy, "clean"), "mark_inspected");
      assert.equal(clean.changed, true);
      assert.equal(clean.next.housekeepingStatus, "inspected");
      assert.equal(clean.next.status, occupancy === "vacant" ? "inspected" : snapshot(occupancy, "clean").status);
    }
  });

  it("block_maintenance: blocked + no vendible, limpieza intacta; libre → out_of_order, OCUPADA sigue ocupada (OP-01); sobre bloqueada → changed:false", () => {
    for (const hk of HOUSEKEEPING_STATUSES) {
      const fromVacant = okNext(snapshot("vacant", hk), "block_maintenance");
      assert.deepEqual(fromVacant.next, { status: "out_of_order", housekeepingStatus: hk, maintenanceStatus: "blocked", sellable: false });
      // Corrector L5 (OP-01): el huésped alojado no desaparece de los recuentos.
      const fromOccupied = okNext(snapshot("occupied", hk), "block_maintenance");
      assert.deepEqual(fromOccupied.next, { status: "occupied", housekeepingStatus: hk, maintenanceStatus: "blocked", sellable: false });
      const fromOccupiedExplicit = okNext(snapshot("occupied", hk), "block_maintenance", { inHouse: true });
      assert.equal(fromOccupiedExplicit.next.status, "occupied");
      // Una «occupied» huérfana (sin reserva alojada) sí pasa a out_of_order.
      assert.equal(okNext(snapshot("occupied", hk), "block_maintenance", { inHouse: false }).next.status, "out_of_order");
      assert.equal(okNext(snapshot("out_of_order", hk), "block_maintenance").changed, false);
    }
  });

  it("check_out de una ocupada bloqueada por mantenimiento → out_of_order / dirty (OP-01)", () => {
    const blockedInHouse: RoomStateSnapshot = { status: "occupied", housekeepingStatus: "clean", maintenanceStatus: "blocked", sellable: false };
    assert.deepEqual(okNext(blockedInHouse, "check_out").next, { status: "out_of_order", housekeepingStatus: "dirty", maintenanceStatus: "blocked", sellable: false });
  });

  it("mark_unsellable / mark_sellable (OP-05): fuera de venta sin orden de trabajo y vuelta al inventario; blocked ⇒ sellable=false es invariante", () => {
    const unsellable = okNext(snapshot("vacant", "clean"), "mark_unsellable");
    assert.deepEqual(unsellable.next, { status: "out_of_service", housekeepingStatus: "clean", maintenanceStatus: "ok", sellable: false });
    assert.equal(okNext(snapshot("occupied", "dirty"), "mark_unsellable").next.status, "occupied", "una ocupada sigue ocupada");
    assert.equal(okNext(unsellable.next, "mark_unsellable").changed, false, "idempotente");
    const back = okNext(unsellable.next, "mark_sellable");
    assert.deepEqual(back.next, { status: "clean", housekeepingStatus: "clean", maintenanceStatus: "ok", sellable: true }, "vuelve con su limpieza");
    const importedOoo: RoomStateSnapshot = { status: "out_of_order", housekeepingStatus: "dirty", maintenanceStatus: "ok", sellable: false };
    assert.deepEqual(okNext(importedOoo, "mark_sellable").next, { status: "dirty", housekeepingStatus: "dirty", maintenanceStatus: "ok", sellable: true });
    assert.equal(okNext(snapshot("vacant", "clean"), "mark_sellable").changed, false, "ya vendible: nada que escribir");
    const blocked = nextRoomState(snapshot("out_of_order", "clean"), "mark_sellable");
    assert.deepEqual(blocked, { ok: false, error: "blocked" }, "una bloqueada por orden de trabajo no se libera a mano");
  });

  it("release_maintenance: ok + vendible + sucia; status dirty si libre, occupied si hay alguien alojado, OOS se conserva", () => {
    const vacant = okNext(snapshot("out_of_order", "clean"), "release_maintenance");
    assert.deepEqual(vacant.next, { status: "dirty", housekeepingStatus: "dirty", maintenanceStatus: "ok", sellable: true });
    const inHouse = okNext(snapshot("out_of_order", "inspected"), "release_maintenance", { inHouse: true });
    assert.deepEqual(inHouse.next, { status: "occupied", housekeepingStatus: "dirty", maintenanceStatus: "ok", sellable: true });
    const oos = okNext(snapshot("out_of_service", "clean"), "release_maintenance");
    assert.equal(oos.next.status, "out_of_service");
    assert.equal(oos.next.housekeepingStatus, "dirty");
    assert.equal(oos.next.maintenanceStatus, "ok");
    // Liberar una habitación libre y sucia que no estaba bloqueada: nada que hacer.
    assert.equal(okNext(snapshot("vacant", "dirty"), "release_maintenance").changed, false);
    // Encadenado real: bloqueo → check_out (conserva OOO) → liberación → dirty/dirty/ok.
    const blocked = okNext(snapshot("occupied", "clean"), "block_maintenance", { inHouse: false }).next;
    const out = okNext(blocked, "check_out").next;
    assert.equal(out.status, "out_of_order");
    const released = okNext(out, "release_maintenance").next;
    assert.deepEqual(released, { status: "dirty", housekeepingStatus: "dirty", maintenanceStatus: "ok", sellable: true });
  });
});

describe("normalizeHousekeepingInput · alias de entrada", () => {
  it("acepta el vocabulario cerrado y los alias; nunca devuelve un alias", () => {
    assert.equal(normalizeHousekeepingInput("clean"), "clean");
    assert.equal(normalizeHousekeepingInput("dirty"), "dirty");
    assert.equal(normalizeHousekeepingInput("inspected"), "inspected");
    assert.equal(normalizeHousekeepingInput("ready"), "clean");
    assert.equal(normalizeHousekeepingInput("stayover"), "dirty");
    assert.equal(normalizeHousekeepingInput("cleaning"), "dirty");
    assert.equal(normalizeHousekeepingInput("in_progress"), "dirty");
    assert.equal(normalizeHousekeepingInput(" CLEAN "), "clean", "recorta y normaliza mayúsculas");
    assert.equal(normalizeHousekeepingInput("Ready"), "clean");
  });

  it("rechaza (null) cualquier otro texto, incluidos los estados de ocupación", () => {
    for (const raw of ["", "  ", "foo", "occupied", "out_of_order", "out_of_service", "oo", "ok", "blocked", "clean;drop"]) {
      assert.equal(normalizeHousekeepingInput(raw), null, `«${raw}» no es un estado de limpieza`);
    }
  });
});

describe("roomStateOf · lectura única", () => {
  it("ocupación por status, limpieza por hk (en cualquier ocupación), bloqueo por mantenimiento o no vendible", () => {
    assert.deepEqual(roomStateOf({ status: "occupied", housekeepingStatus: "clean", maintenanceStatus: "ok", sellable: true }), {
      occupancy: "occupied",
      cleanliness: "clean",
      isClean: true,
      isBlocked: false
    });
    assert.deepEqual(roomStateOf({ status: "out_of_order", housekeepingStatus: "dirty", maintenanceStatus: "blocked", sellable: false }), {
      occupancy: "out_of_order",
      cleanliness: "dirty",
      isClean: false,
      isBlocked: true
    });
    assert.equal(roomStateOf({ status: "out_of_service", housekeepingStatus: "inspected", maintenanceStatus: "ok", sellable: true }).occupancy, "out_of_service");
    assert.equal(roomStateOf({ status: "inspected", housekeepingStatus: "inspected", maintenanceStatus: "ok", sellable: true }).occupancy, "vacant");
    assert.equal(roomStateOf({ status: "clean", housekeepingStatus: "clean", maintenanceStatus: "ok", sellable: false }).isBlocked, true, "no vendible bloquea");
    assert.equal(roomStateOf({ status: "clean", housekeepingStatus: "clean", maintenanceStatus: "needs_attention", sellable: true }).isBlocked, false);
  });

  it("tolera espejos heredados: hk NULL → espejo de status (o clean), alias → destino, desconocido → dirty", () => {
    assert.equal(roomStateOf({ status: "dirty", housekeepingStatus: null, maintenanceStatus: null, sellable: true }).cleanliness, "dirty");
    assert.equal(roomStateOf({ status: "occupied", housekeepingStatus: undefined, maintenanceStatus: undefined, sellable: true }).cleanliness, "clean");
    assert.equal(roomStateOf({ status: "clean", housekeepingStatus: "ready", maintenanceStatus: "ok", sellable: true }).cleanliness, "clean");
    assert.equal(roomStateOf({ status: "clean", housekeepingStatus: "stayover", maintenanceStatus: "ok", sellable: true }).cleanliness, "dirty");
    assert.equal(roomStateOf({ status: "clean", housekeepingStatus: "xyz", maintenanceStatus: "ok", sellable: true }).cleanliness, "dirty");
  });

  it("snapshotOf normaliza una fila al vocabulario cerrado", () => {
    assert.deepEqual(snapshotOf({ status: "occupied", housekeepingStatus: "ready", maintenanceStatus: "operational", sellable: true }), {
      status: "occupied",
      housekeepingStatus: "clean",
      maintenanceStatus: "ok",
      sellable: true
    });
  });
});

describe("foldRoomStateCounts · cifras únicas de los dashboards", () => {
  const rows = [
    { status: "occupied", housekeepingStatus: "clean", count: 2 },
    { status: "occupied", housekeepingStatus: "dirty", count: 1 },
    { status: "clean", housekeepingStatus: "clean", count: 3 },
    { status: "dirty", housekeepingStatus: "dirty", count: 4 },
    { status: "inspected", housekeepingStatus: "inspected", count: 1 },
    { status: "out_of_order", housekeepingStatus: "dirty", count: 1 },
    { status: "out_of_service", housekeepingStatus: "clean", count: 1 }
  ];

  it("limpieza por hk en TODAS las ocupaciones; occupied por status; outOfOrder = out_of_order + out_of_service", () => {
    assert.deepEqual(foldRoomStateCounts(rows), { clean: 6, dirty: 6, inspected: 1, occupied: 3, outOfOrder: 2, total: 13 });
  });

  it("ignora filas vacías o inválidas y la lista plegada conserva la forma { status, count }", () => {
    assert.deepEqual(foldRoomStateCounts([]), { clean: 0, dirty: 0, inspected: 0, occupied: 0, outOfOrder: 0, total: 0 });
    assert.deepEqual(foldRoomStateCounts([{ status: "clean", housekeepingStatus: "clean", count: 0 }, { status: "dirty", housekeepingStatus: "dirty", count: Number.NaN }]).total, 0);
    assert.deepEqual(roomStateCountsAsList(foldRoomStateCounts(rows)), [
      { status: "clean", count: 6 },
      { status: "dirty", count: 6 },
      { status: "inspected", count: 1 },
      { status: "occupied", count: 3 },
      { status: "out_of_order", count: 2 }
    ]);
  });

  it("los vocabularios exportados son los del modelo", () => {
    assert.deepEqual([...HOUSEKEEPING_STATUSES], ["dirty", "clean", "inspected"]);
    assert.deepEqual([...MAINTENANCE_STATUSES], ["ok", "blocked", "needs_attention"]);
    assert.equal(ROOM_STATE_EVENTS.length, 9);
  });
});
