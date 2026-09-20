// Unit tests · ejecución y capitalización de obras (Tanda ACT · L4). Sin BD:
// `executionOf` con y sin líneas del diario, prefijos personalizados, ventana de
// lectura, forma y parámetros del SQL, coste de capitalización con ICIO y
// cuenta 211/212 por tipo de obra, más el mapeador fila → CapexWorkRecord y la
// entrada del motor de alertas. Desde apps/api:
//   node --import tsx --test src/modules/real-estate/__tests__/capex-execution.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CapexProject } from "@prisma/client";
import { dec } from "../../payables/money.js";
import {
  DEFAULT_CAPEX_EXECUTION_PREFIXES,
  buildLedgerExecutionSql,
  capitalizationAccountFor,
  capitalizationCost,
  executionOf,
  executionWindow,
  itemsExecution,
  parseExecutionPrefixes,
  serializeExecutionPrefixes
} from "../capex-execution.service.js";
import { CapexWorkStatusPatchSchema, auditProjection, capexAlertInput, toCapexWorkRecord } from "../works.service.js";

function projectRow(overrides: Partial<CapexProject> = {}): CapexProject {
  return {
    id: "capex_1",
    propertyId: "prop_act",
    name: "Reforma plantas 3-6",
    description: null,
    budget: dec("15000"),
    status: "approved",
    startDate: null,
    targetEndDate: null,
    ownerApprovedBy: "usr_owner",
    createdByUserId: "usr_manager",
    realEstateAssetId: "rea_1",
    workKind: "reforma",
    licenceRequired: true,
    licenceDocumentId: null,
    licenceGrantedAt: null,
    icioAmount: null,
    projectDocumentId: null,
    completionDocumentId: null,
    executionAccountPrefixes: null,
    executedAmountLedger: null,
    capitalizedFixedAssetId: null,
    capitalizedAt: null,
    ...overrides
  };
}

describe("ACT-L4 · executionOf (fuente de la ejecución)", () => {
  it("con líneas 21x en el diario manda el diario (executionSource ledger) aunque haya partidas", () => {
    const execution = executionOf(projectRow(), [{ actualCost: dec("1500") }, { actualCost: "2500.00" }], { amount: dec("12000"), lines: 2 });
    assert.deepEqual(execution, { executedAmountLedger: "12000.00", executedAmountItems: "4000.00", executedAmount: "12000.00", executionSource: "ledger" });
  });

  it("sin líneas la ejecución es Σ actualCost de las partidas (executionSource items) y la caché del diario queda null", () => {
    const execution = executionOf(projectRow({ executedAmountLedger: dec("999") }), [{ actualCost: dec("1500") }, { actualCost: 2500 }], { amount: dec("0"), lines: 0 });
    assert.deepEqual(execution, { executedAmountLedger: null, executedAmountItems: "4000.00", executedAmount: "4000.00", executionSource: "items" });
  });

  it("sin lectura nueva del diario usa la caché executedAmountLedger de la fila (null = partidas)", () => {
    assert.equal(executionOf(projectRow({ executedAmountLedger: dec("8100.5") }), []).executedAmount, "8100.50");
    assert.equal(executionOf(projectRow({ executedAmountLedger: dec("8100.5") }), []).executionSource, "ledger");
    assert.deepEqual(executionOf(projectRow(), []), { executedAmountLedger: null, executedAmountItems: "0.00", executedAmount: "0.00", executionSource: "items" });
  });

  it("redondea a céntimos y admite haber mayor que debe (traspaso 231 → 211 negativo)", () => {
    assert.equal(executionOf(projectRow(), [], { amount: dec("-534150.855"), lines: 5 }).executedAmountLedger, "-534150.86");
    assert.equal(itemsExecution([{ actualCost: "0.005" }, { actualCost: "0.005" }]).toFixed(2), "0.01");
  });
});

describe("ACT-L4 · prefijos de cuenta y ventana de lectura", () => {
  it("null o vacío → los prefijos por defecto (21x sin terrenos ni vehículos + 231/232)", () => {
    assert.deepEqual(parseExecutionPrefixes(null), [...DEFAULT_CAPEX_EXECUTION_PREFIXES]);
    assert.deepEqual(parseExecutionPrefixes(""), [...DEFAULT_CAPEX_EXECUTION_PREFIXES]);
    assert.deepEqual(DEFAULT_CAPEX_EXECUTION_PREFIXES, ["211", "212", "213", "215", "216", "217", "219", "231", "232"]);
  });

  it("prefijos personalizados: separa por comas, recorta, deduplica y descarta lo no numérico", () => {
    assert.deepEqual(parseExecutionPrefixes(" 211, 212 ,211,abc,2110040"), ["211", "212", "2110040"]);
    assert.equal(serializeExecutionPrefixes(["231", " 232 ", "231"]), "231,232");
    assert.equal(serializeExecutionPrefixes([]), null);
    assert.equal(serializeExecutionPrefixes(null), null);
  });

  it("ventana [startDate, targetEndDate ?? hoy]", () => {
    assert.deepEqual(executionWindow(projectRow(), "2026-09-20"), { from: null, to: "2026-09-20" });
    assert.deepEqual(executionWindow(projectRow({ startDate: new Date("2026-03-01T00:00:00.000Z"), targetEndDate: new Date("2026-12-31T00:00:00.000Z") }), "2026-09-20"), { from: "2026-03-01", to: "2026-12-31" });
  });

  it("el SQL es un solo SELECT parametrizado: centro, posted, normal, ventana y un LIKE por prefijo", () => {
    const sql = buildLedgerExecutionSql({ organizationId: "org_act", propertyId: "prop_act", from: "2026-03-01", to: "2026-12-31", prefixes: ["211", "212"] });
    const text = sql.text.replace(/\s+/g, " ");
    assert.match(text, /SUM\(jl\.debit - jl\.credit\)/);
    assert.match(text, /je\.status = 'posted'/);
    assert.match(text, /je\.entry_kind = 'normal'/);
    assert.match(text, /je\.entry_date >= \$\d+::date/);
    assert.match(text, /je\.entry_date <= \$\d+::date/);
    assert.equal((text.match(/jl\.account_code LIKE \$\d+/g) ?? []).length, 2);
    assert.deepEqual(sql.values, ["org_act", "prop_act", "2026-12-31", "2026-03-01", "211%", "212%"]);

    const open = buildLedgerExecutionSql({ organizationId: "org_act", propertyId: "prop_act", from: null, to: "2026-09-20", prefixes: [] });
    assert.doesNotMatch(open.text, />= \$\d+::date/, "sin startDate no hay límite inferior");
    assert.equal(open.values.length, 3 + DEFAULT_CAPEX_EXECUTION_PREFIXES.length, "sin prefijos propios se usan los de por defecto");
  });
});

describe("ACT-L4 · capitalización", () => {
  it("coste = ejecución + ICIO (12.000 + 480 = 12.480,00)", () => {
    assert.equal(capitalizationCost({ executedAmount: "12000.00" }, dec("480")).toFixed(2), "12480.00");
    assert.equal(capitalizationCost({ executedAmount: "4000.00" }, null).toFixed(2), "4000.00");
    assert.equal(capitalizationCost({ executedAmount: "0.00" }, "0.005").toFixed(2), "0.01");
  });

  it("cuenta 211 por defecto y 212 para eficiencia energética", () => {
    assert.equal(capitalizationAccountFor("reforma"), "211");
    assert.equal(capitalizationAccountFor(null), "211");
    assert.equal(capitalizationAccountFor("eficiencia_energetica"), "212");
  });
});

describe("ACT-L4 · mapeador, auditoría y esquema del PATCH", () => {
  it("toCapexWorkRecord expone las 12 columnas de obra, la ejecución y los importes como MoneyString", () => {
    const row = projectRow({ icioAmount: dec("480"), executionAccountPrefixes: "211,212", capitalizedAt: new Date("2026-09-20T00:00:00.000Z"), capitalizedFixedAssetId: "fa_1", targetEndDate: new Date("2026-12-31T00:00:00.000Z") });
    const record = toCapexWorkRecord(row, executionOf(row, [{ actualCost: dec("100") }], { amount: dec("12000"), lines: 1 }));
    assert.equal(record.budget, "15000.00");
    assert.equal(record.icioAmount, "480.00");
    assert.equal(record.targetEndDate, "2026-12-31");
    assert.equal(record.capitalizedAt, "2026-09-20");
    assert.equal(record.capitalizedFixedAssetId, "fa_1");
    assert.equal(record.executionAccountPrefixes, "211,212");
    assert.equal(record.executedAmountLedger, "12000.00");
    assert.equal(record.executedAmountItems, "100.00");
    assert.equal(record.executionSource, "ledger");
    assert.equal(record.licenceRequired, true);
    assert.equal(record.licenceDocumentId, null);
    const projection = auditProjection(record);
    assert.equal(projection.executedAmount, "12000.00");
    assert.ok(!("description" in projection), "sin texto libre en la auditoría");
  });

  it("capexAlertInput alimenta CAPEX_LICENCE_MISSING (in_progress con licencia exigida y sin documento)", () => {
    assert.deepEqual(capexAlertInput(projectRow({ status: "in_progress" })), { id: "capex_1", propertyId: "prop_act", name: "Reforma plantas 3-6", status: "in_progress", licenceRequired: true, licenceDocumentId: null });
  });

  it("CapexWorkStatusPatchSchema admite status in_progress | completed, rechaza approved / cancelled y el cuerpo vacío", () => {
    assert.equal(CapexWorkStatusPatchSchema.safeParse({ status: "in_progress" }).success, true);
    assert.equal(CapexWorkStatusPatchSchema.safeParse({ status: "completed", icioAmount: "480.00", executionAccountPrefixes: ["211", "212"] }).success, true);
    assert.equal(CapexWorkStatusPatchSchema.safeParse({ status: "approved" }).success, false);
    assert.equal(CapexWorkStatusPatchSchema.safeParse({ status: "cancelled" }).success, false);
    assert.equal(CapexWorkStatusPatchSchema.safeParse({}).success, false);
    assert.equal(CapexWorkStatusPatchSchema.safeParse({ nombre: "x" }).success, false, "strict: clave desconocida");
    assert.equal(CapexWorkStatusPatchSchema.safeParse({ executionAccountPrefixes: ["21a"] }).success, false, "prefijos numéricos");
  });
});
