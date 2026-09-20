// Unit tests · inspecciones obligatorias, pólizas y proyecciones del motor de
// alertas (Tanda ACT · L5). Sin BD: catálogo por defecto, nextDueAt por
// periodicidad, planificación pura del PATCH (acta, defectos, subsanación,
// estado explícito), mapeadores fila → DTO, estado derivado del seguro y el
// filtro de inspecciones del motor. Desde apps/api:
//   node --import tsx --test src/modules/real-estate/__tests__/inspections.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RealEstateInspection, RealEstateInsurance } from "@prisma/client";
import { REAL_ESTATE_INSPECTION_KINDS, type RealEstateInspectionDefect } from "@hotelos/shared";
import { dec, utcDay } from "../../payables/money.js";
import { RECEIPT_STATUSES_WITH_ALERT, applyInsuranceNotice, capexAlertInput, inspectionAlertInput, inspectionsForAlerts, insuranceNoticeOf, receiptAlertInput } from "../alerts.service.js";
import { buildRealEstateAlerts } from "../alerts.pure.js";
import { realEstateErrorCodeOf } from "../errors.js";
import {
  REAL_ESTATE_INSPECTION_DEFAULTS,
  allDefectsFixed,
  applyInspectionDefaults,
  computeNextDueAt,
  defectsFromInput,
  earliestOpenDefectDue,
  inspectionDueDate,
  latestDefectFixedAt,
  parseDefects,
  planInspectionPatch,
  toRealEstateInspectionRecord,
  type InspectionSnapshot
} from "../inspections.service.js";
import { DEFAULT_INSURANCE_NOTICE_DAYS, deriveInsuranceStatus, insuranceExpiresSoon, toRealEstateInsuranceRecord } from "../insurances.service.js";

const TODAY = "2026-09-20";
const CREATED = new Date("2026-09-20T10:00:00.000Z");

function snapshot(overrides: Partial<InspectionSnapshot> = {}): InspectionSnapshot {
  return { status: "programada", performedAt: null, result: null, defects: null, correctionDueAt: null, correctedAt: null, nextDueAt: null, scheduledAt: "2026-10-15", periodicityMonths: 24, ...overrides };
}

const defect = (overrides: Partial<RealEstateInspectionDefect> = {}): RealEstateInspectionDefect => ({ severity: "grave", text: "Cable de tracción con hilos rotos", dueAt: "2026-11-30", fixedAt: null, ...overrides });

function inspectionRow(overrides: Partial<RealEstateInspection> = {}): RealEstateInspection {
  return {
    id: "rei_1",
    organizationId: "org_act",
    propertyId: "prop_act",
    assetId: "rea_1",
    kind: "oca_ascensor",
    legalBasis: "RD 355/2024 art. 11.4.a",
    periodicityMonths: 24,
    installationRef: "RAE-0001",
    technicalAssetId: null,
    providerName: null,
    supplierId: null,
    scheduledAt: utcDay("2026-10-15"),
    performedAt: null,
    result: null,
    defectsJson: null,
    correctionDueAt: null,
    correctedAt: null,
    nextDueAt: null,
    documentId: null,
    complianceRequirementCode: null,
    status: "programada",
    notes: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides
  };
}

function insuranceRow(overrides: Partial<RealEstateInsurance> = {}): RealEstateInsurance {
  return {
    id: "rein_1",
    organizationId: "org_act",
    propertyId: "prop_act",
    assetId: "rea_1",
    kind: "rc",
    insurerName: "Aseguradora de prueba SA",
    policyNumber: "RC-ACT-0001",
    brokerName: null,
    policyholder: "sociedad",
    insuredSum: dec("3000000"),
    deductible: null,
    premiumAnnual: dec("4200"),
    validFrom: utcDay("2025-10-30"),
    validUntil: utcDay("2026-10-30"),
    autoRenew: true,
    noticeDays: 60,
    mandatoryBasis: null,
    documentId: null,
    status: "vigente",
    notes: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides
  };
}

const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (error) {
    return realEstateErrorCodeOf(error);
  }
};

describe("ACT-L5 · catálogo por defecto y periodicidad", () => {
  it("cubre los 12 tipos del catálogo y oca_ascensor vale 24 meses (RD 355/2024)", () => {
    for (const kind of REAL_ESTATE_INSPECTION_KINDS) assert.ok(kind in REAL_ESTATE_INSPECTION_DEFAULTS, `sin defecto para ${kind}`);
    assert.deepEqual(REAL_ESTATE_INSPECTION_DEFAULTS.oca_ascensor, { legalBasis: "RD 355/2024 art. 11.4.a", periodicityMonths: 24 });
    assert.equal(REAL_ESTATE_INSPECTION_DEFAULTS.legionella.periodicityMonths, 3);
    assert.equal(REAL_ESTATE_INSPECTION_DEFAULTS.piscina.periodicityMonths, 1);
    assert.equal(REAL_ESTATE_INSPECTION_DEFAULTS.cee.periodicityMonths, 120);
    assert.deepEqual(REAL_ESTATE_INSPECTION_DEFAULTS.otra, { legalBasis: null, periodicityMonths: null });
  });

  it("alta oca_ascensor sin base legal toma el catálogo (24 meses)", () => {
    const filled = applyInspectionDefaults({ kind: "oca_ascensor" });
    assert.equal(filled.legalBasis, "RD 355/2024 art. 11.4.a");
    assert.equal(filled.periodicityMonths, 24);
    // Lo que trae el cuerpo manda, incluido un null explícito.
    const explicit = applyInspectionDefaults({ kind: "oca_ascensor", legalBasis: "Ordenanza local", periodicityMonths: 12 });
    assert.equal(explicit.legalBasis, "Ordenanza local");
    assert.equal(explicit.periodicityMonths, 12);
    const nulled = applyInspectionDefaults({ kind: "oca_ascensor", legalBasis: null, periodicityMonths: null });
    assert.equal(nulled.legalBasis, null);
    assert.equal(nulled.periodicityMonths, null);
    assert.deepEqual(applyInspectionDefaults({ kind: "otra" }), { kind: "otra", legalBasis: null, periodicityMonths: null });
  });

  it("nextDueAt por periodicidad: performedAt + meses, conservando el día cuando existe", () => {
    assert.equal(computeNextDueAt("2026-09-18", 24), "2028-09-18");
    assert.equal(computeNextDueAt("2026-01-31", 1), "2026-02-28");
    assert.equal(computeNextDueAt("2026-11-30", 3), "2027-02-28");
    assert.equal(computeNextDueAt("2026-09-18", null), null);
    assert.equal(computeNextDueAt("2026-09-18", 0), null);
    assert.equal(computeNextDueAt(null, 24), null);
  });
});

describe("ACT-L5 · defectos", () => {
  it("parseDefects tolera basura y defectsFromInput convierte las fechas a IsoDay", () => {
    assert.equal(parseDefects(null), null);
    assert.equal(parseDefects("x"), null);
    assert.deepEqual(parseDefects([{ severity: "grave", text: "A", dueAt: "2026-11-30", fixedAt: null }, { severity: "nope", text: "B" }, 42, { text: "sin severidad" }]), [
      { severity: "grave", text: "A", dueAt: "2026-11-30", fixedAt: null }
    ]);
    assert.equal(defectsFromInput(undefined), undefined);
    assert.equal(defectsFromInput(null), null);
    assert.deepEqual(defectsFromInput([{ severity: "leve", text: "B", dueAt: utcDay("2026-12-15"), fixedAt: undefined }]), [{ severity: "leve", text: "B", dueAt: "2026-12-15", fixedAt: null }]);
  });

  it("allDefectsFixed, primer plazo abierto y última subsanación", () => {
    assert.equal(allDefectsFixed(null), true);
    assert.equal(allDefectsFixed([]), true);
    assert.equal(allDefectsFixed([defect(), defect({ fixedAt: "2026-10-01" })]), false);
    assert.equal(allDefectsFixed([defect({ fixedAt: "2026-10-01" }), defect({ fixedAt: "2026-10-05" })]), true);
    assert.equal(earliestOpenDefectDue([defect({ dueAt: "2026-12-15" }), defect({ dueAt: "2026-11-30" }), defect({ dueAt: "2026-10-01", fixedAt: "2026-09-25" })]), "2026-11-30");
    assert.equal(earliestOpenDefectDue([defect({ dueAt: null })]), null);
    assert.equal(latestDefectFixedAt([defect({ fixedAt: "2026-10-01" }), defect({ fixedAt: "2026-10-05" })]), "2026-10-05");
    assert.equal(latestDefectFixedAt([defect({ fixedAt: "2026-10-01" }), defect()]), null);
    assert.equal(latestDefectFixedAt([]), null);
  });
});

describe("ACT-L5 · planInspectionPatch (§5.1)", () => {
  it("acta favorable: programada → realizada, nextDueAt = performedAt + periodicidad y nace la sucesora", () => {
    const plan = planInspectionPatch(snapshot(), { performedAt: "2026-09-18", result: "favorable" }, TODAY);
    assert.deepEqual(plan.transition, { from: "programada", to: "realizada" });
    assert.equal(plan.next.status, "realizada");
    assert.equal(plan.next.nextDueAt, "2028-09-18");
    assert.equal(plan.successor, true);
  });

  it("acta negativa → con_defectos con correctionDueAt derivado del primer plazo abierto; sin sucesora", () => {
    const plan = planInspectionPatch(snapshot(), { performedAt: "2026-09-18", result: "negativa", defects: [defect({ dueAt: "2026-12-15" }), defect({ dueAt: "2026-11-30" })] }, TODAY);
    assert.deepEqual(plan.transition, { from: "programada", to: "con_defectos" });
    assert.equal(plan.next.correctionDueAt, "2026-11-30");
    assert.equal(plan.next.correctedAt, null);
    assert.equal(plan.next.nextDueAt, "2028-09-18");
    assert.equal(plan.successor, false);
    const condicionada = planInspectionPatch(snapshot(), { performedAt: "2026-09-18", result: "condicionada", correctionDueAt: "2026-10-31", defects: [defect({ dueAt: "2026-12-15" })] }, TODAY);
    assert.equal(condicionada.next.status, "con_defectos");
    assert.equal(condicionada.next.correctionDueAt, "2026-10-31", "el plazo explícito manda");
  });

  it("acta pendiente o incompleta no cambia el estado; nextDueAt explícito es editable", () => {
    const pending = planInspectionPatch(snapshot(), { performedAt: "2026-09-18", result: "pendiente" }, TODAY);
    assert.equal(pending.transition, null);
    assert.equal(pending.next.status, "programada");
    assert.equal(pending.next.performedAt, "2026-09-18");
    const half = planInspectionPatch(snapshot(), { performedAt: "2026-09-18" }, TODAY);
    assert.equal(half.transition, null);
    assert.equal(half.next.nextDueAt, "2028-09-18", "la fecha ya deja calculado el siguiente plazo");
    const edited = planInspectionPatch(snapshot(), { performedAt: "2026-09-18", result: "favorable", nextDueAt: "2027-06-30" }, TODAY);
    assert.equal(edited.next.nextDueAt, "2027-06-30");
    const later = planInspectionPatch(snapshot({ status: "realizada", performedAt: "2026-09-18", result: "favorable", nextDueAt: "2028-09-18" }), { nextDueAt: "2028-06-30" }, TODAY);
    assert.equal(later.transition, null);
    assert.equal(later.next.nextDueAt, "2028-06-30");
    const periodicity = planInspectionPatch(snapshot({ status: "realizada", performedAt: "2026-09-18", result: "favorable", nextDueAt: "2028-09-18" }), { periodicityMonths: 12 }, TODAY);
    assert.equal(periodicity.next.nextDueAt, "2027-09-18", "cambiar la periodicidad recalcula el plazo");
  });

  it("cierre solo con todos los defectos fixedAt (correctedAt = último fixedAt) y nace la sucesora", () => {
    const open = snapshot({ status: "con_defectos", performedAt: "2026-09-18", result: "negativa", nextDueAt: "2028-09-18", correctionDueAt: "2026-11-30", defects: [defect(), defect({ severity: "leve", text: "Iluminación de cabina insuficiente", dueAt: "2026-12-15" })] });
    const partial = planInspectionPatch(open, { defects: [defect({ fixedAt: "2026-10-01" }), defect({ severity: "leve", text: "Iluminación de cabina insuficiente", dueAt: "2026-12-15" })] }, TODAY);
    assert.equal(partial.transition, null, "un defecto abierto: sigue con_defectos");
    assert.equal(partial.next.status, "con_defectos");
    assert.equal(partial.next.correctionDueAt, "2026-12-15", "el plazo pasa al defecto que queda");
    assert.equal(codeOf(() => planInspectionPatch(open, { status: "cerrada" }, TODAY)), "INSPECTION_INVALID_TRANSITION");
    const closed = planInspectionPatch(open, { defects: [defect({ fixedAt: "2026-10-01" }), defect({ severity: "leve", text: "Iluminación de cabina insuficiente", dueAt: "2026-12-15", fixedAt: "2026-10-05" })] }, TODAY);
    assert.deepEqual(closed.transition, { from: "con_defectos", to: "cerrada" });
    assert.equal(closed.next.correctedAt, "2026-10-05");
    assert.equal(closed.successor, true);
    // Sin lista de defectos, el cierre exige correctedAt.
    const noList = snapshot({ status: "con_defectos", performedAt: "2026-09-18", result: "negativa", nextDueAt: "2028-09-18" });
    assert.equal(codeOf(() => planInspectionPatch(noList, { status: "cerrada" }, TODAY)), "INSPECTION_INVALID_TRANSITION");
    const corrected = planInspectionPatch(noList, { correctedAt: "2026-10-10" }, TODAY);
    assert.equal(corrected.next.status, "cerrada");
    assert.equal(corrected.successor, true);
    // Cerrar una favorable (archivo) no crea otra sucesora.
    const archive = planInspectionPatch(snapshot({ status: "realizada", performedAt: "2026-09-18", result: "favorable", nextDueAt: "2028-09-18" }), { status: "cerrada" }, TODAY);
    assert.deepEqual(archive.transition, { from: "realizada", to: "cerrada" });
    assert.equal(archive.successor, false);
  });

  it("409 INSPECTION_INVALID_TRANSITION: cerrada es final, acta incoherente, estado sin acta y cambio de rama", () => {
    assert.equal(codeOf(() => planInspectionPatch(snapshot({ status: "cerrada" }), { scheduledAt: "2027-01-01" }, TODAY)), "INSPECTION_INVALID_TRANSITION");
    assert.equal(codeOf(() => planInspectionPatch(snapshot(), { status: "realizada" }, TODAY)), "INSPECTION_INVALID_TRANSITION", "sin performedAt ni result");
    assert.equal(codeOf(() => planInspectionPatch(snapshot(), { performedAt: "2026-09-18", result: "favorable", status: "con_defectos" }, TODAY)), "INSPECTION_INVALID_TRANSITION");
    assert.equal(codeOf(() => planInspectionPatch(snapshot(), { performedAt: "2026-09-18", result: "negativa", status: "realizada" }, TODAY)), "INSPECTION_INVALID_TRANSITION");
    assert.equal(codeOf(() => planInspectionPatch(snapshot(), { performedAt: "2026-09-18", result: "pendiente", status: "realizada" }, TODAY)), "INSPECTION_INVALID_TRANSITION");
    assert.equal(codeOf(() => planInspectionPatch(snapshot({ status: "realizada", performedAt: "2026-09-18", result: "favorable" }), { result: "negativa" }, TODAY)), "INSPECTION_INVALID_TRANSITION");
    assert.equal(codeOf(() => planInspectionPatch(snapshot({ status: "con_defectos", performedAt: "2026-09-18", result: "negativa" }), { result: "favorable" }, TODAY)), "INSPECTION_INVALID_TRANSITION");
    assert.equal(codeOf(() => planInspectionPatch(snapshot({ status: "realizada", performedAt: "2026-09-18", result: "favorable" }), { status: "programada" }, TODAY)), "INSPECTION_INVALID_TRANSITION");
    // Repetir el estado actual no es una transición.
    assert.equal(planInspectionPatch(snapshot(), { status: "programada", scheduledAt: "2026-11-01" }, TODAY).transition, null);
  });
});

describe("ACT-L5 · DTO de la inspección", () => {
  it("dueState se deriva de scheduledAt mientras está programada y de nextDueAt después", () => {
    assert.equal(inspectionDueDate({ status: "programada", scheduledAt: "2026-09-19", nextDueAt: "2028-01-01" }), "2026-09-19");
    assert.equal(inspectionDueDate({ status: "programada", scheduledAt: null, nextDueAt: "2028-01-01" }), "2028-01-01");
    assert.equal(inspectionDueDate({ status: "realizada", scheduledAt: "2026-09-19", nextDueAt: "2028-01-01" }), "2028-01-01");
    const overdue = toRealEstateInspectionRecord(inspectionRow({ scheduledAt: utcDay("2026-09-19") }), TODAY);
    assert.equal(overdue.dueState, "vencida");
    assert.equal(overdue.scheduledAt, "2026-09-19");
    assert.equal(overdue.defectsJson, null);
    const soon = toRealEstateInspectionRecord(inspectionRow({ scheduledAt: utcDay("2026-10-15") }), TODAY);
    assert.equal(soon.dueState, "proxima");
    const done = toRealEstateInspectionRecord(inspectionRow({ status: "realizada", performedAt: utcDay("2026-09-18"), result: "favorable", nextDueAt: utcDay("2028-09-18"), scheduledAt: utcDay("2026-09-19") }), TODAY);
    assert.equal(done.dueState, "en_plazo");
    assert.equal(done.performedAt, "2026-09-18");
    assert.equal(done.nextDueAt, "2028-09-18");
    const none = toRealEstateInspectionRecord(inspectionRow({ scheduledAt: null }), TODAY);
    assert.equal(none.dueState, "sin_fecha");
    const withDefects = toRealEstateInspectionRecord(inspectionRow({ status: "con_defectos", defectsJson: [{ severity: "grave", text: "A", dueAt: "2026-11-30", fixedAt: null }] as never }), TODAY);
    assert.deepEqual(withDefects.defectsJson, [{ severity: "grave", text: "A", dueAt: "2026-11-30", fixedAt: null }]);
  });
});

describe("ACT-L5 · status derivado del seguro", () => {
  it("cancelada persiste; vencida cuando validUntil ya pasó (aunque autoRenew); vigente en otro caso", () => {
    assert.equal(deriveInsuranceStatus({ status: "vigente", validUntil: "2026-10-30" }, TODAY), "vigente");
    assert.equal(deriveInsuranceStatus({ status: "vigente", validUntil: "2026-09-20" }, TODAY), "vigente", "vence hoy: todavía cubre");
    assert.equal(deriveInsuranceStatus({ status: "vigente", validUntil: "2026-09-19" }, TODAY), "vencida");
    assert.equal(deriveInsuranceStatus({ status: "cancelada", validUntil: "2030-01-01" }, TODAY), "cancelada");
    assert.equal(deriveInsuranceStatus({ status: "cancelada", validUntil: "2026-01-01" }, TODAY), "cancelada");
    assert.equal(DEFAULT_INSURANCE_NOTICE_DAYS, 60);
    assert.equal(insuranceExpiresSoon({ status: "vigente", validUntil: "2026-10-30", noticeDays: 60 }, TODAY), true, "40 días ≤ 60");
    assert.equal(insuranceExpiresSoon({ status: "vigente", validUntil: "2026-11-20", noticeDays: 60 }, TODAY), false, "61 días");
    assert.equal(insuranceExpiresSoon({ status: "vigente", validUntil: "2026-11-20", noticeDays: null }, TODAY), false);
    assert.equal(insuranceExpiresSoon({ status: "vigente", validUntil: "2026-09-19", noticeDays: 60 }, TODAY), false, "vencida no es «vence pronto»");
    assert.equal(insuranceExpiresSoon({ status: "cancelada", validUntil: "2026-10-30", noticeDays: 60 }, TODAY), false);
  });

  it("toRealEstateInsuranceRecord: días ISO, importes MoneyString y status derivado", () => {
    const record = toRealEstateInsuranceRecord(insuranceRow(), TODAY);
    assert.equal(record.status, "vigente");
    assert.equal(record.validFrom, "2025-10-30");
    assert.equal(record.validUntil, "2026-10-30");
    assert.equal(record.insuredSum, "3000000.00");
    assert.equal(record.premiumAnnual, "4200.00");
    assert.equal(record.deductible, null);
    assert.equal(record.noticeDays, 60);
    assert.equal(record.autoRenew, true);
    assert.equal(toRealEstateInsuranceRecord(insuranceRow({ validUntil: utcDay("2026-09-01") }), TODAY).status, "vencida");
    assert.equal(toRealEstateInsuranceRecord(insuranceRow({ status: "cancelada" }), TODAY).status, "cancelada");
  });
});

describe("ACT-L5 · proyecciones del motor de alertas", () => {
  it("los recibos recurridos siguen alimentando el motor (ACT-REV-09: el recurso no oculta el vencimiento); pagado queda fuera", () => {
    assert.deepEqual([...RECEIPT_STATUSES_WITH_ALERT], ["previsto", "recibido", "domiciliado", "recurrido"]);
    assert.equal((RECEIPT_STATUSES_WITH_ALERT as readonly string[]).includes("pagado"), false);
  });

  it("inspectionsForAlerts quita las cerradas y las realizadas cuyo plazo ya lleva su sucesora programada", () => {
    const realizada = inspectionAlertInput(inspectionRow({ id: "rei_done", status: "realizada", performedAt: utcDay("2026-06-10"), result: "favorable", nextDueAt: utcDay("2026-09-10") }));
    const successor = inspectionAlertInput(inspectionRow({ id: "rei_next", status: "programada", scheduledAt: utcDay("2026-09-10"), nextDueAt: utcDay("2026-09-10") }));
    const orphan = inspectionAlertInput(inspectionRow({ id: "rei_orphan", status: "realizada", installationRef: "RAE-0002", performedAt: utcDay("2026-06-10"), result: "favorable", nextDueAt: utcDay("2026-09-10") }));
    const closed = inspectionAlertInput(inspectionRow({ id: "rei_closed", status: "cerrada", nextDueAt: utcDay("2026-09-10") }));
    const defects = inspectionAlertInput(inspectionRow({ id: "rei_defects", status: "con_defectos", result: "negativa", performedAt: utcDay("2026-09-18"), nextDueAt: utcDay("2028-09-18") }));
    const kept = inspectionsForAlerts([realizada, successor, orphan, closed, defects]).map((row) => row.id);
    assert.deepEqual(kept, ["rei_next", "rei_orphan", "rei_defects"]);
    assert.equal(realizada.kind, "oca_ascensor");
    assert.equal(realizada.nextDueAt, "2026-09-10");
    assert.equal(successor.scheduledAt, "2026-09-10");
  });

  it("póliza que vence en 40 días → INSURANCE_EXPIRING media (preaviso noticeDays 60 sobre la «baja» del motor)", () => {
    const rc = insuranceRow({ id: "rein_rc", validUntil: utcDay("2026-10-30") }); // 40 días
    const far = insuranceRow({ id: "rein_far", kind: "multirriesgo", validUntil: utcDay("2026-11-20"), noticeDays: 30 }); // 61 días, preaviso 30
    const near = insuranceRow({ id: "rein_near", kind: "decenal", validUntil: utcDay("2026-10-10") }); // 20 días: ya media
    const rows = [rc, far, near];
    const raw = buildRealEstateAlerts({ today: TODAY, insurances: rows.map((row) => ({ id: row.id, propertyId: row.propertyId, kind: row.kind as never, policyNumber: row.policyNumber, validUntil: row.validUntil.toISOString().slice(0, 10), status: row.status })) });
    assert.equal(raw.find((a) => a.entityId === "rein_rc")?.severity, "baja", "el motor solo conoce 90/30/7");
    const alerts = applyInsuranceNotice(raw, rows.map(insuranceNoticeOf), TODAY);
    assert.equal(alerts.find((a) => a.entityId === "rein_rc")?.severity, "media");
    assert.equal(alerts.find((a) => a.entityId === "rein_far")?.severity, "baja", "fuera de su preaviso de 30 días");
    assert.equal(alerts.find((a) => a.entityId === "rein_near")?.severity, "media");
    assert.deepEqual(alerts.map((a) => a.entityId), ["rein_near", "rein_rc", "rein_far"], "reordenadas por gravedad y fecha");
    assert.equal(applyInsuranceNotice(raw, [], TODAY), raw, "sin pólizas no toca nada");
    assert.equal(insuranceNoticeOf(rc).noticeDays, 60);
  });

  it("recibos y obras se proyectan con el centro y el tipo del tributo", () => {
    const receipt = receiptAlertInput({ id: "ptr_1", fiscalYear: 2026, period: "anual", status: "previsto", dueTo: utcDay("2026-11-30"), amount: dec("41940"), tax: { propertyId: "prop_act", kind: "ibi" } });
    assert.deepEqual(receipt, { id: "ptr_1", propertyId: "prop_act", taxKind: "ibi", fiscalYear: 2026, period: "anual", status: "previsto", dueTo: "2026-11-30", amount: "41940.00" });
    const capex = capexAlertInput({ id: "cpx_1", propertyId: "prop_act", name: "Reforma de plantas 3-6", status: "in_progress", licenceRequired: true, licenceDocumentId: null });
    assert.deepEqual(capex, { id: "cpx_1", propertyId: "prop_act", name: "Reforma de plantas 3-6", status: "in_progress", licenceRequired: true, licenceDocumentId: null });
  });
});
