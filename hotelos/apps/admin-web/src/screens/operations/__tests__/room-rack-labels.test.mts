import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NO_FLOOR_KEY, floorKey, floorTitle, normalizeFloor } from "../room-rack-labels.ts";

// fix:3-A qa#11 — /recepcion/reservas/tablero (Rías Altas, floor "" on
// 120/120 rooms) titled its only section «Planta », the filter read «Planta
// (120)» and the drawer «Individual · Planta »; Los Tilos (floor «Planta 1»)
// would have read «Planta Planta 1».
describe("Tablero · título de planta", () => {
  it("names the rooms without a floor instead of painting an empty suffix", () => {
    assert.equal(floorTitle(""), "Sin planta");
    assert.equal(floorTitle("   "), "Sin planta");
    assert.equal(floorTitle(undefined), "Sin planta");
    assert.equal(floorTitle(null), "Sin planta");
    assert.equal(floorTitle("—"), "Sin planta");
  });
  it("prefixes a bare floor and keeps one that already says «Planta»", () => {
    assert.equal(floorTitle("2"), "Planta 2");
    assert.equal(floorTitle(" 2 "), "Planta 2");
    assert.equal(floorTitle("Planta 1"), "Planta 1");
    assert.equal(floorTitle("planta baja"), "planta baja");
    assert.equal(floorTitle("Ático"), "Planta Ático");
  });
});

describe("Tablero · clave de planta para el filtro", () => {
  it("maps every spelling of «no floor» to one non-empty key and keeps real floors as-is", () => {
    assert.equal(floorKey(""), NO_FLOOR_KEY);
    assert.equal(floorKey("—"), NO_FLOOR_KEY);
    assert.equal(floorKey(undefined), NO_FLOOR_KEY);
    assert.notEqual(NO_FLOOR_KEY, "");
    assert.equal(floorKey("Planta 1"), "Planta 1");
    assert.equal(floorKey("2"), "2");
  });
  it("normalizes to null so callers can branch without string checks", () => {
    assert.equal(normalizeFloor(""), null);
    assert.equal(normalizeFloor("-"), null);
    assert.equal(normalizeFloor("3"), "3");
  });
});
