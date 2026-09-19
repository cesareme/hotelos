// Tanda L5 (lote C) · ventana de frescura del readiness (regla pura, sin base
// de datos). Run from apps/api with
//   node --import tsx --test src/modules/backoffice/__tests__/readiness-freshness.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { READINESS_MAX_AGE_MS, isReadinessStale, readinessComputedAt } from "../readiness-freshness.js";

const NOW = new Date("2026-09-19T10:00:00.000Z");
const minutesAgo = (minutes: number): Date => new Date(NOW.getTime() - minutes * 60_000);

describe("readiness-freshness · isReadinessStale", () => {
  it("la ventana es de 10 minutos", () => {
    assert.equal(READINESS_MAX_AGE_MS, 600_000);
  });

  it("sin filas → stale (hay que calcular)", () => {
    assert.equal(isReadinessStale([], NOW), true);
  });

  it("fila reciente (hace 1 min) → fresca", () => {
    assert.equal(isReadinessStale([{ updatedAt: minutesAgo(1) }], NOW), false);
  });

  it("fila de hace 11 min → stale; justo en el límite (10 min) sigue fresca", () => {
    assert.equal(isReadinessStale([{ updatedAt: minutesAgo(11) }], NOW), true);
    assert.equal(isReadinessStale([{ updatedAt: minutesAgo(10) }], NOW), false);
  });

  it("decide por la fila MÁS reciente aunque haya filas antiguas", () => {
    const rows = [{ updatedAt: minutesAgo(45) }, { updatedAt: minutesAgo(2) }, { updatedAt: minutesAgo(30) }];
    assert.equal(isReadinessStale(rows, NOW), false);
  });

  it("acepta cadenas ISO, ignora fechas inválidas y admite una ventana distinta", () => {
    assert.equal(isReadinessStale([{ updatedAt: minutesAgo(3).toISOString() }], NOW), false);
    assert.equal(isReadinessStale([{ updatedAt: "no-es-fecha" }], NOW), true, "sin fecha válida → stale");
    assert.equal(isReadinessStale([{ updatedAt: minutesAgo(3) }], NOW, 60_000), true, "ventana de 1 min");
    assert.equal(isReadinessStale([{ updatedAt: new Date(NOW.getTime() + 60_000) }], NOW), false, "fecha futura = fresca");
  });
});

describe("readiness-freshness · readinessComputedAt", () => {
  it("sin filas → null", () => {
    assert.equal(readinessComputedAt([]), null);
    assert.equal(readinessComputedAt([{ updatedAt: "invalid" }]), null);
  });

  it("devuelve el máximo updatedAt en ISO 8601", () => {
    const rows = [{ updatedAt: minutesAgo(9) }, { updatedAt: minutesAgo(1).toISOString() }, { updatedAt: minutesAgo(5) }];
    assert.equal(readinessComputedAt(rows), minutesAgo(1).toISOString());
  });
});
