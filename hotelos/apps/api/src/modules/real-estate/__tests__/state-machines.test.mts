// Unit tests · máquinas de estado del activo inmobiliario (Tanda ACT · L0a). Sin BD. Desde apps/api:
//   node --import tsx --test src/modules/real-estate/__tests__/state-machines.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CAPEX_PROJECT_STATUSES, PROPERTY_TAX_RECEIPT_STATUSES, REAL_ESTATE_INSPECTION_STATUSES, REAL_ESTATE_TENURE_STATUSES } from "@hotelos/shared";
import { INVALID_TRANSITION_CODES, REAL_ESTATE_STATE_MACHINES, assertTransition, canTransition, nextStates } from "../state-machines.js";

const details = (error: unknown): { code?: string; from?: string; to?: string; allowed?: string[] } => ((error as { details?: object }).details ?? {}) as { code?: string; from?: string; to?: string; allowed?: string[] };
const statusOf = (error: unknown): number | undefined => (error as { statusCode?: number }).statusCode;

describe("TENURE (borrador → vigente → resuelto | vencido)", () => {
  it("transiciones válidas", () => {
    assert.equal(canTransition("TENURE", "borrador", "vigente"), true);
    assert.equal(canTransition("TENURE", "vigente", "resuelto"), true);
    assert.equal(canTransition("TENURE", "vigente", "vencido"), true);
  });

  it("transiciones inválidas: saltarse la activación, reactivar, estados finales", () => {
    assert.equal(canTransition("TENURE", "borrador", "resuelto"), false);
    assert.equal(canTransition("TENURE", "borrador", "vencido"), false);
    assert.equal(canTransition("TENURE", "resuelto", "vigente"), false);
    assert.equal(canTransition("TENURE", "vencido", "vigente"), false);
    assert.equal(canTransition("TENURE", "vigente", "vigente"), false);
    assert.equal(canTransition("TENURE", "inventado", "vigente"), false);
    assert.throws(
      () => assertTransition("TENURE", "borrador", "resuelto"),
      (error: unknown) => statusOf(error) === 409 && details(error).code === "TENURE_INVALID_TRANSITION" && details(error).from === "borrador" && details(error).to === "resuelto" && JSON.stringify(details(error).allowed) === JSON.stringify(["vigente"])
    );
    assert.doesNotThrow(() => assertTransition("TENURE", "borrador", "vigente"));
  });
});

describe("RECEIPT (previsto → recibido | domiciliado | pagado | recurrido; recibido | domiciliado → pagado | recurrido; recurrido → pagado)", () => {
  it("transiciones válidas", () => {
    for (const to of ["recibido", "domiciliado", "pagado", "recurrido"]) assert.equal(canTransition("RECEIPT", "previsto", to), true, `previsto → ${to}`);
    for (const from of ["recibido", "domiciliado"]) for (const to of ["pagado", "recurrido"]) assert.equal(canTransition("RECEIPT", from, to), true, `${from} → ${to}`);
    assert.equal(canTransition("RECEIPT", "recurrido", "pagado"), true);
  });

  it("transiciones inválidas: pagado solo admite recurrir (ACT-REV-10), no se vuelve a previsto ni se «recibe» lo domiciliado; «vencido» no es un estado", () => {
    assert.equal(canTransition("RECEIPT", "pagado", "recurrido"), true, "diseño §5.1: «Recurrir» desde cualquier estado");
    assert.deepEqual(nextStates("RECEIPT", "pagado"), ["recurrido"]);
    assert.equal(canTransition("RECEIPT", "pagado", "previsto"), false);
    assert.equal(canTransition("RECEIPT", "pagado", "recibido"), false);
    assert.equal(canTransition("RECEIPT", "recibido", "previsto"), false);
    assert.equal(canTransition("RECEIPT", "domiciliado", "recibido"), false);
    assert.equal(canTransition("RECEIPT", "recurrido", "recibido"), false);
    assert.equal(canTransition("RECEIPT", "previsto", "vencido"), false);
    assert.throws(() => assertTransition("RECEIPT", "pagado", "recibido"), (error: unknown) => statusOf(error) === 409 && details(error).code === "RECEIPT_NOT_PAYABLE" && JSON.stringify(details(error).allowed) === JSON.stringify(["recurrido"]));
    assert.throws(() => assertTransition("RECEIPT", "pagado", "pagado", { code: "RECEIPT_ENTRY_EXISTS", message: "Ya pagado." }), (error: unknown) => details(error).code === "RECEIPT_ENTRY_EXISTS" && (error as Error).message === "Ya pagado.");
  });
});

describe("INSPECTION (programada → realizada | con_defectos → cerrada)", () => {
  it("transiciones válidas", () => {
    assert.equal(canTransition("INSPECTION", "programada", "realizada"), true);
    assert.equal(canTransition("INSPECTION", "programada", "con_defectos"), true);
    assert.equal(canTransition("INSPECTION", "con_defectos", "cerrada"), true);
    assert.equal(canTransition("INSPECTION", "realizada", "cerrada"), true);
  });

  it("transiciones inválidas: cerrar sin acta, reabrir, cambiar el resultado del acta", () => {
    assert.equal(canTransition("INSPECTION", "programada", "cerrada"), false);
    assert.equal(canTransition("INSPECTION", "cerrada", "programada"), false);
    assert.equal(canTransition("INSPECTION", "realizada", "con_defectos"), false);
    assert.equal(canTransition("INSPECTION", "con_defectos", "realizada"), false);
    assert.throws(() => assertTransition("INSPECTION", "programada", "cerrada"), (error: unknown) => statusOf(error) === 409 && details(error).code === "INSPECTION_INVALID_TRANSITION");
  });
});

describe("CAPEX_WORK (proposed → approved → in_progress → completed; cancelled solo desde proposed | approved)", () => {
  it("transiciones válidas", () => {
    assert.equal(canTransition("CAPEX_WORK", "proposed", "approved"), true);
    assert.equal(canTransition("CAPEX_WORK", "approved", "in_progress"), true);
    assert.equal(canTransition("CAPEX_WORK", "in_progress", "completed"), true);
    assert.equal(canTransition("CAPEX_WORK", "proposed", "cancelled"), true);
    assert.equal(canTransition("CAPEX_WORK", "approved", "cancelled"), true);
  });

  it("transiciones inválidas: no se cancela una obra en curso ni terminada, no se salta la aprobación, completed es final", () => {
    assert.equal(canTransition("CAPEX_WORK", "in_progress", "cancelled"), false);
    assert.equal(canTransition("CAPEX_WORK", "completed", "cancelled"), false);
    assert.equal(canTransition("CAPEX_WORK", "proposed", "in_progress"), false);
    assert.equal(canTransition("CAPEX_WORK", "completed", "in_progress"), false);
    assert.equal(canTransition("CAPEX_WORK", "cancelled", "proposed"), false);
    assert.throws(() => assertTransition("CAPEX_WORK", "in_progress", "cancelled"), (error: unknown) => statusOf(error) === 409 && details(error).code === "CAPEX_NOT_COMPLETED");
    assert.throws(() => assertTransition("CAPEX_WORK", "approved", "completed", { code: "LICENCE_REQUIRED" }), (error: unknown) => details(error).code === "LICENCE_REQUIRED");
  });
});

describe("tablas completas y coherentes con los catálogos compartidos", () => {
  it("cada estado del catálogo tiene fila; cada destino está en el catálogo; nextStates de un estado desconocido es vacío", () => {
    const check = (machine: keyof typeof REAL_ESTATE_STATE_MACHINES, catalog: readonly string[]) => {
      const table = REAL_ESTATE_STATE_MACHINES[machine] as Record<string, readonly string[]>;
      assert.deepEqual(Object.keys(table).sort(), [...catalog].sort(), machine);
      for (const [from, targets] of Object.entries(table)) for (const to of targets) assert.ok(catalog.includes(to), `${machine}: ${from} → ${to} fuera del catálogo`);
      assert.deepEqual(nextStates(machine, "desconocido"), []);
      assert.ok(INVALID_TRANSITION_CODES[machine]);
    };
    check("TENURE", REAL_ESTATE_TENURE_STATUSES);
    check("RECEIPT", PROPERTY_TAX_RECEIPT_STATUSES);
    check("INSPECTION", REAL_ESTATE_INSPECTION_STATUSES);
    check("CAPEX_WORK", CAPEX_PROJECT_STATUSES);
    assert.deepEqual(nextStates("RECEIPT", "previsto"), ["recibido", "domiciliado", "pagado", "recurrido"]);
  });
});
