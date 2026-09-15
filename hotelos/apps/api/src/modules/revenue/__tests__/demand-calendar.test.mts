// Unit tests for the demand calendar zod contracts (no database). Run from
// apps/api with
//   node --import tsx --test src/modules/revenue/__tests__/demand-calendar.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DemandEventCreateSchema,
  DemandEventListQuerySchema,
  DemandEventPatchSchema,
  IMPACT_SCORE_DEFAULTS,
  parseOrBadRequest
} from "../demand-calendar.service.js";
import { BadRequestError } from "../../../lib/http-error.js";
import { z } from "zod";

describe("DemandEventCreateSchema", () => {
  it("accepts a minimal event and fills the defaults (eventType manual, impact medium, source manual)", () => {
    const v = DemandEventCreateSchema.parse({ name: "  Feria del Libro ", startDate: "2026-10-02", endDate: "2026-10-04" });
    assert.equal(v.name, "Feria del Libro");
    assert.equal(v.eventType, "manual");
    assert.equal(v.expectedImpact, "medium");
    assert.equal(v.source, "manual");
    assert.equal(v.impactScore, undefined);
    assert.equal(IMPACT_SCORE_DEFAULTS[v.expectedImpact], 50);
  });
  it("rejects name empty, startDate > endDate, bad impact, impactScore out of 0-100, unknown keys and non-calendar days", () => {
    const bad = (body: unknown) => DemandEventCreateSchema.safeParse(body).success;
    assert.equal(bad({ name: "   ", startDate: "2026-10-02", endDate: "2026-10-04" }), false);
    assert.equal(bad({ name: "X", startDate: "2026-10-05", endDate: "2026-10-04" }), false);
    assert.equal(bad({ name: "X", startDate: "2026-10-02", endDate: "2026-10-04", expectedImpact: "huge" }), false);
    assert.equal(bad({ name: "X", startDate: "2026-10-02", endDate: "2026-10-04", impactScore: 101 }), false);
    assert.equal(bad({ name: "X", startDate: "2026-10-02", endDate: "2026-10-04", impactScore: -1 }), false);
    assert.equal(bad({ name: "X", startDate: "2026-10-02", endDate: "2026-10-04", foo: 1 }), false);
    assert.equal(bad({ name: "X", startDate: "2026-02-30", endDate: "2026-03-01" }), false);
    assert.equal(bad({ name: "X", startDate: "2026-13-99", endDate: "2026-03-01" }), false);
    assert.equal(bad({ name: "X", startDate: "2026-10-02", endDate: "2026-10-02", expectedImpact: "high", impactScore: 100, source: "import" }), true);
  });
});

describe("DemandEventPatchSchema / list query", () => {
  it("patch needs at least one field; impactScore may be cleared with null", () => {
    assert.equal(DemandEventPatchSchema.safeParse({}).success, false);
    const v = DemandEventPatchSchema.parse({ impactScore: null, expectedImpact: "low" });
    assert.equal(v.impactScore, null);
    assert.equal(v.expectedImpact, "low");
    assert.equal(DemandEventPatchSchema.safeParse({ startDate: "2026-1-1" }).success, false);
  });
  it("list query validates the from/to pair", () => {
    assert.deepEqual(DemandEventListQuerySchema.parse({}), {});
    assert.equal(DemandEventListQuerySchema.safeParse({ from: "2026-10-05", to: "2026-10-01" }).success, false);
    assert.equal(DemandEventListQuerySchema.safeParse({ from: "2026-10-01", to: "2026-10-05" }).success, true);
  });
});

describe("parseOrBadRequest", () => {
  it("turns the first zod issue into a Spanish 400 with every issue in details", () => {
    assert.throws(
      () => parseOrBadRequest(DemandEventCreateSchema, { name: "", startDate: "2026-10-05", endDate: "2026-10-04" }),
      (e: unknown) => {
        assert.ok(e instanceof BadRequestError);
        assert.equal(e.statusCode, 400);
        assert.equal(e.message, "cuerpo inválido: name: name es obligatorio");
        const details = e.details as { code: string; issues: Array<{ path: string; message: string }> };
        assert.equal(details.code, "VALIDATION_ERROR");
        assert.ok(details.issues.some((i) => i.path === "endDate" && i.message === "startDate debe ser igual o anterior a endDate"));
        return true;
      }
    );
    assert.deepEqual(parseOrBadRequest(DemandEventListQuerySchema, undefined, "query"), {});
  });
  it("los textos incrustados de zod salen en español (zodErrorMapEs): tope numérico, clave no admitida, obligatorio, enum (api-live-contract#8)", () => {
    const message = (fn: () => unknown): { message: string; issues: Array<{ path: string; message: string }> } => {
      try {
        fn();
      } catch (e) {
        assert.ok(e instanceof BadRequestError);
        return { message: e.message, issues: (e.details as { issues: Array<{ path: string; message: string }> }).issues };
      }
      throw new Error("no lanzó");
    };
    // El caso reportado en vivo: PUT …/recommendations/config { minDeltaPct: 51 }.
    const RmsLike = z.object({ minDeltaPct: z.number().min(0).max(50).optional(), floorPrice: z.number().min(0).optional() }).strict();
    assert.equal(message(() => parseOrBadRequest(RmsLike, { minDeltaPct: 51 })).message, "cuerpo inválido: minDeltaPct: debe ser menor o igual que 50");
    assert.equal(message(() => parseOrBadRequest(RmsLike, { floorPrice: -1 })).message, "cuerpo inválido: floorPrice: debe ser mayor o igual que 0");
    assert.equal(message(() => parseOrBadRequest(RmsLike, { foo: 1 })).message, "cuerpo inválido: clave no admitida: 'foo'");
    assert.equal(message(() => parseOrBadRequest(RmsLike, { minDeltaPct: "5" })).message, "cuerpo inválido: minDeltaPct: se esperaba número y se recibió texto");
    assert.equal(message(() => parseOrBadRequest(DemandEventCreateSchema, { startDate: "2026-10-02", endDate: "2026-10-04" })).message, "cuerpo inválido: name: obligatorio");
    assert.equal(
      message(() => parseOrBadRequest(DemandEventCreateSchema, { name: "X", startDate: "2026-10-02", endDate: "2026-10-04", expectedImpact: "huge" })).message,
      "cuerpo inválido: expectedImpact: valor no admitido 'huge'; valores válidos: low | medium | high"
    );
    // Los mensajes explícitos del schema prevalecen sobre el mapa.
    assert.equal(message(() => parseOrBadRequest(DemandEventCreateSchema, { name: "X", startDate: "2026-10-02", endDate: "2026-10-04", impactScore: 101 })).message, "cuerpo inválido: impactScore: impactScore debe estar entre 0 y 100");
    // Ningún issue lleva literales ingleses de zod.
    const english = /Required|Invalid|Expected|Unrecognized|must be|received/;
    for (const body of [{ minDeltaPct: 51, foo: 1, floorPrice: "x" }, {}]) {
      for (const issue of message(() => parseOrBadRequest(RmsLike.extend({ name: z.string().min(1) }), body)).issues) {
        assert.doesNotMatch(issue.message, english, `${issue.path}: ${issue.message}`);
      }
    }
  });
});
