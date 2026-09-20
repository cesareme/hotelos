// Tests de la pantalla Finanzas › Activo inmobiliario › Inspecciones y seguros
// (Tanda ACT · lote ACT-F3). Los helpers puros y las piezas sin hooks viven en
// RealEstateInspectionsScreen.tsx; ese módulo llega (services/activeProperty →
// services/api-client) a `import.meta.env.VITE_API_URL`, que define Vite y no
// `node --test`: el gancho síncrono sustituye solo api-client.ts por su fuente
// sin tipos precedida de `import.meta.env ??= {}` (mismo patrón que
// screens/operations/__tests__/frontdesk-actions.test.mts). Las piezas se
// renderizan con react-dom/server; las reglas Cocoa 22, el copy en español y
// la superficie de red se anclan sobre la fuente.
// Desde apps/admin-web: corepack pnpm --filter @hotelos/admin-web test

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("/src/services/api-client.ts")) {
      const source = stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), { mode: "strip" });
      return { format: "module", source: `import.meta.env ??= {};\n${source}`, shortCircuit: true };
    }
    return nextLoad(url, context);
  }
});

const screen = await import("../RealEstateInspectionsScreen.tsx");
const { ApiError } = await import("../../../services/api-client.ts");
const { REAL_ESTATE_ERROR_MESSAGES } = await import("../real-estate-helpers.ts");
type RealEstateInspectionRecord = import("../../../services/realEstateApi").RealEstateInspectionRecord;
type RealEstateInsuranceRecord = import("../../../services/realEstateApi").RealEstateInsuranceRecord;
type RealEstateTenureRecord = import("../../../services/realEstateApi").RealEstateTenureRecord;

const SOURCE = readFileSync(new URL("../RealEstateInspectionsScreen.tsx", import.meta.url), "utf8");
const count = (src: string, re: RegExp) => (src.match(re) ?? []).length;
const render = (element: unknown) => renderToStaticMarkup(element as never).replace(/\u00a0/g, " ");
/** lib/format separa unidades con espacio duro; los tests comparan con espacio normal. */
const plain = (text: string) => text.replace(/\u00a0/g, " ");

const TODAY = "2026-09-20";
const plusDays = (days: number) => new Date(Date.parse(`${TODAY}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);

function inspection(over: Partial<RealEstateInspectionRecord> = {}): RealEstateInspectionRecord {
  return {
    id: "rei_test_1",
    organizationId: "org_test",
    propertyId: "prop_test",
    assetId: "rea_test",
    kind: "oca_bt",
    legalBasis: "REBT ITC-BT-05 4.1.b",
    periodicityMonths: 60,
    installationRef: "CGBT-01",
    technicalAssetId: null,
    providerName: "OCA Demo SL",
    supplierId: null,
    scheduledAt: "2026-10-01",
    performedAt: null,
    result: null,
    defectsJson: null,
    correctionDueAt: null,
    correctedAt: null,
    nextDueAt: "2026-10-01",
    documentId: null,
    complianceRequirementCode: null,
    status: "programada",
    dueState: "proxima",
    notes: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...over
  };
}

function insurance(over: Partial<RealEstateInsuranceRecord> = {}): RealEstateInsuranceRecord {
  return {
    id: "rin_test_1",
    organizationId: "org_test",
    propertyId: "prop_test",
    assetId: "rea_test",
    kind: "multirriesgo",
    insurerName: "Aseguradora Demo SA",
    policyNumber: "MR-TEST-0001",
    brokerName: null,
    policyholder: "sociedad",
    insuredSum: "12000000.00",
    deductible: "3000.00",
    premiumAnnual: "18000.00",
    validFrom: plusDays(-325),
    validUntil: plusDays(40),
    autoRenew: true,
    noticeDays: 60,
    mandatoryBasis: null,
    documentId: null,
    status: "vigente",
    notes: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...over
  };
}

function tenure(over: Partial<RealEstateTenureRecord> = {}): RealEstateTenureRecord {
  return {
    id: "ret_test_1",
    assetId: "rea_test",
    kind: "arrendamiento_industria",
    counterpartyName: "Arrendadora Demo SL",
    counterpartyTaxId: null,
    counterpartyNonResident: false,
    startDate: "2020-01-01",
    endDate: "2035-12-31",
    noticeMonths: 12,
    renewal: "tacita",
    rentKind: "mixta",
    rentMonthly: "32000.00",
    rentVariablePct: "4.00",
    rentVariableBase: "gor",
    rentReviewIndex: "ipc",
    rentReviewMonth: 1,
    depositAmount: "64000.00",
    vatApplies: true,
    withholdingApplies: true,
    withholdingRatePct: "19.00",
    ibiPayer: "arrendatario",
    insurancePayer: "propietario",
    capexResponsibility: "compartido",
    ffeReservePct: null,
    brandName: null,
    status: "vigente",
    documentId: null,
    notes: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...over
  };
}

describe("Inspecciones y seguros · Cocoa 22, copy y superficie de red (lectura de fuente)", () => {
  it("nace sin estilos inline ni elementos crudos, sin literales de color ni emoji, sin fetch crudo y formatea solo por lib/format", () => {
    assert.equal(count(SOURCE, /\bstyle=\{/g), 0, "style={ debe ser 0");
    assert.doesNotMatch(SOURCE, /(?<!-)\bbo-[a-z0-9-]+/);
    assert.doesNotMatch(SOURCE, /<button\b|<table\b|<(?:input|select|textarea)\b|<h1\b/);
    assert.doesNotMatch(SOURCE, /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|\b(?:rgba?|hsla?)\(/);
    assert.doesNotMatch(SOURCE, /\p{Extended_Pictographic}/u);
    assert.doesNotMatch(SOURCE, /\b(?:window\.|globalThis\.)?fetch\s*\(/);
    assert.doesNotMatch(SOURCE, /Intl\.(?:NumberFormat|DateTimeFormat)|toLocale[A-Za-z]*String\(/);
    assert.doesNotMatch(SOURCE, /from "\.\.\/\.\.\/services\/api-client"/, "todo por realEstateApi");
  });

  it("exporta RealEstateInspectionsScreen (y por defecto), pinta un CocoaPage con los dos segmentos y lee con useApiData sobre las rutas del cliente", () => {
    assert.equal(typeof screen.RealEstateInspectionsScreen, "function");
    assert.equal(screen.default, screen.RealEstateInspectionsScreen);
    assert.deepEqual(screen.SEGMENTS.map((segment) => segment.value), ["inspecciones", "seguros"]);
    assert.match(SOURCE, /<CocoaPage\b/);
    assert.match(SOURCE, /tabs=\{SEGMENTS\.map/);
    assert.match(SOURCE, /useApiData<RealEstateInspectionRecord\[\]>\(realEstateInspectionsPath\(propertyId\)\)/);
    assert.match(SOURCE, /useApiData<RealEstateInsuranceRecord\[\]>\(realEstateInsurancesPath\(propertyId\)\)/);
    assert.match(SOURCE, /useApiData<RealEstateTenureRecord\[\]>\(realEstateTenuresPath\(propertyId\)/);
    for (const call of ["createRealEstateInspection(", "updateRealEstateInspection(", "createRealEstateInsurance(", "updateRealEstateInsurance("]) assert.ok(SOURCE.includes(`await ${call}`), call);
    assert.match(SOURCE, /const canManage = canDo\(useNavGate\(\), "real_estate\.manage"\);/);
    assert.doesNotMatch(SOURCE, /auth-storage|getUser\(|\?\.permissions/);
    assert.match(SOURCE, /<CocoaState\s+kind="empty"/);
  });
});

describe("Inspecciones: callout de riesgo con negativa abierta", () => {
  const { inspectionRisk, inspectionRiskLines, InspectionRiskCallout, isNegativeOpen, isElevatorOverdue } = screen;
  const negative = inspection({ id: "neg", kind: "oca_pci", status: "con_defectos", result: "negativa", performedAt: "2026-09-10", correctionDueAt: "2026-10-10", defectsJson: [{ severity: "grave", text: "Extintores caducados", dueAt: "2026-10-10", fixedAt: null }, { severity: "leve", text: "Señalización", dueAt: null, fixedAt: "2026-09-15" }], dueState: "en_plazo", installationRef: null });
  const conditioned = inspection({ id: "cond", status: "con_defectos", result: "condicionada", defectsJson: [{ severity: "leve", text: "Etiqueta", dueAt: null, fixedAt: null }] });
  const elevator = inspection({ id: "elev", kind: "oca_ascensor", installationRef: "RAE-0001", status: "programada", scheduledAt: "2026-08-01", nextDueAt: "2026-08-01", dueState: "vencida" });

  it("detecta la negativa sin subsanar y el ascensor vencido, no la condicionada ni una negativa ya cerrada", () => {
    assert.equal(isNegativeOpen(negative), true);
    assert.equal(isNegativeOpen(conditioned), false);
    assert.equal(isNegativeOpen(inspection({ status: "cerrada", result: "negativa" })), false);
    assert.equal(isElevatorOverdue(elevator), true);
    assert.equal(isElevatorOverdue(inspection({ kind: "oca_bt", dueState: "vencida" })), false, "solo ascensores");
    assert.equal(isElevatorOverdue(inspection({ kind: "oca_ascensor", dueState: "vencida", status: "cerrada" })), false);
    const risk = inspectionRisk([inspection(), negative, conditioned, elevator]);
    assert.deepEqual(risk.negatives.map((row) => row.id), ["neg"]);
    assert.deepEqual(risk.elevatorsOverdue.map((row) => row.id), ["elev"]);
    const lines = inspectionRiskLines(risk);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /OCA de protección contra incendios: acta negativa sin subsanar \(plazo 10\/10\/2026\); 1 defecto abierto\./);
    assert.match(lines[1], /OCA de ascensores \(RAE-0001\): inspección vencida el 01\/08\/2026: el ascensor debe quedar fuera de servicio a las 24 horas\./);
  });

  it("pinta el CocoaCallout de peligro (role=alert) con la negativa abierta y nada sin riesgo", () => {
    const html = render(createElement(InspectionRiskCallout, { inspections: [inspection(), negative] }));
    assert.match(html, /data-cocoa="callout"[^>]*data-tone="danger"/);
    assert.match(html, /role="alert"/);
    assert.match(html, /Riesgo: acta negativa sin subsanar/);
    assert.match(html, /acta negativa sin subsanar \(plazo 10\/10\/2026\)/);
    assert.equal(render(createElement(InspectionRiskCallout, { inspections: [inspection(), conditioned] })), "", "condicionada sin riesgo legal");
    const both = render(createElement(InspectionRiskCallout, { inspections: [negative, elevator] }));
    assert.match(both, /acta negativa sin subsanar y ascensor con la inspección vencida/);
  });

  it("la pantalla monta el callout sobre la lista y dentro del cajón, y tiñe la fila en rojo", () => {
    assert.match(SOURCE, /<InspectionRiskCallout inspections=\{inspections\} \/>/);
    assert.match(SOURCE, /isNegativeOpen\(selectedInspection\) \|\| isElevatorOverdue\(selectedInspection\) \? <InspectionRiskCallout inspections=\{\[selectedInspection\]\} \/>/);
    assert.match(SOURCE, /rowTone=\{\(row\) => \(isNegativeOpen\(row\) \|\| isElevatorOverdue\(row\) \? "danger"/);
  });
});

describe("Inspecciones: registrar acta exige resultado", () => {
  const { actaFormOf, actaFormErrors, actaPatchOf, hasDefectResult, closureErrors, closurePatchOf, plainPatchOf, inspectionsErrorMessage } = screen;

  it("sin resultado (o sin fecha) no hay acta; con los dos, sí", () => {
    const form = actaFormOf(inspection());
    assert.equal(form.result, "");
    assert.match(actaFormErrors({ ...form, performedAt: "2026-09-20" }).result ?? "", /Indica el resultado del acta/);
    assert.match(actaFormErrors({ ...form, result: "favorable" }).performedAt ?? "", /fecha del acta/);
    assert.deepEqual(actaFormErrors({ ...form, performedAt: "2026-09-20", result: "favorable" }), {});
    assert.deepEqual(actaFormErrors({ ...form, performedAt: "2026-09-20", result: "pendiente" }), {});
    assert.match(actaFormErrors({ ...form, performedAt: "2026-09-20", result: "negativa", defects: [{ severity: "grave", text: " ", dueAt: "", fixedAt: "" }] }).defects ?? "", /descripción/);
    assert.equal(hasDefectResult("condicionada"), true);
    assert.equal(hasDefectResult("favorable"), false);
  });

  it("el botón «Registrar acta» se deshabilita con los errores del formulario y muestra la razón", () => {
    assert.match(SOURCE, /disabled=\{inspectionBusy !== null \|\| Object\.keys\(actaErrors\)\.length > 0\}/);
    assert.match(SOURCE, /Registrar acta/);
    assert.match(SOURCE, /<CocoaField label="Resultado" required error=\{actaErrors\.result\}/);
    assert.match(SOURCE, /kind === "acta" \? actaPatchOf\(acta\)/);
  });

  it("el acta viaja con fecha, resultado y defectos solo cuando el resultado los tiene", () => {
    const form = { ...actaFormOf(inspection()), performedAt: "2026-09-20", result: "negativa" as const, defects: [{ severity: "grave" as const, text: " Extintores caducados ", dueAt: "2026-10-10", fixedAt: "" }], correctionDueAt: "2026-10-10", nextDueAt: "", documentId: "red_acta", providerName: "OCA Demo SL", notes: "" };
    assert.deepEqual(actaPatchOf(form), {
      performedAt: "2026-09-20",
      result: "negativa",
      defectsJson: [{ severity: "grave", text: "Extintores caducados", dueAt: "2026-10-10", fixedAt: null }],
      correctionDueAt: "2026-10-10",
      documentId: "red_acta",
      providerName: "OCA Demo SL",
      notes: null
    });
    const favorable = actaPatchOf({ ...form, result: "favorable", nextDueAt: "2031-09-20" });
    assert.equal(favorable.defectsJson, null);
    assert.equal(favorable.nextDueAt, "2031-09-20");
    assert.ok(!("correctionDueAt" in favorable));
  });

  it("cerrar con defectos exige la subsanación de todos y viaja con status cerrada", () => {
    const open = { defects: [{ severity: "grave" as const, text: "Extintores", dueAt: "", fixedAt: "" }], correctedAt: "", documentId: "", notes: "" };
    assert.match(closureErrors(open).defects ?? "", /fecha de subsanación/);
    assert.match(closureErrors({ ...open, defects: [] }).correctedAt ?? "", /indica la fecha/);
    const fixed = { ...open, defects: [{ ...open.defects[0], fixedAt: "2026-09-18" }] };
    assert.deepEqual(closureErrors(fixed), {});
    assert.deepEqual(closurePatchOf(fixed), { defectsJson: [{ severity: "grave", text: "Extintores", dueAt: null, fixedAt: "2026-09-18" }], documentId: null, notes: null, status: "cerrada" });
    assert.deepEqual(plainPatchOf({ providerName: " OCA ", scheduledAt: "2026-10-01", nextDueAt: "", documentId: "", notes: "n" }), { providerName: "OCA", scheduledAt: "2026-10-01", nextDueAt: null, documentId: null, notes: "n" });
  });

  it("un 409 INSPECTION_INVALID_TRANSITION se explica en español con las transiciones posibles", () => {
    const message = inspectionsErrorMessage(new ApiError("Conflict", 409, undefined, { code: "INSPECTION_INVALID_TRANSITION", machine: "INSPECTION", from: "programada", to: "cerrada", allowed: ["realizada", "con_defectos"] }));
    assert.ok(message.startsWith(REAL_ESTATE_ERROR_MESSAGES.INSPECTION_INVALID_TRANSITION));
    assert.match(message, /Cambios posibles: realizada, con_defectos\./);
  });
});

describe("Seguros: póliza a 40 días con badge ámbar", () => {
  const { insuranceBadge, InsuranceStatusBadge, daysUntil, renewalLabel, DEFAULT_INSURANCE_NOTICE_DAYS } = screen;

  it("a 40 días con preaviso de 60 el badge es ámbar «Vence en 40 días»", () => {
    assert.equal(DEFAULT_INSURANCE_NOTICE_DAYS, 60);
    assert.deepEqual(insuranceBadge(insurance(), TODAY), { label: "Vence en 40 días", tone: "warning", daysLeft: 40 });
    const html = render(createElement(InsuranceStatusBadge, { insurance: insurance(), today: TODAY }));
    assert.match(html, /data-cocoa="badge"[^>]*data-tone="warning"/);
    assert.match(html, />Vence en 40 días</);
  });

  it("fuera del preaviso es verde, vencida roja, cancelada gris; el preaviso de la póliza manda", () => {
    assert.deepEqual(insuranceBadge(insurance({ validUntil: plusDays(100) }), TODAY), { label: "Vigente", tone: "success", daysLeft: 100 });
    assert.deepEqual(insuranceBadge(insurance({ noticeDays: 30 }), TODAY), { label: "Vigente", tone: "success", daysLeft: 40 }, "40 días > preaviso 30");
    assert.deepEqual(insuranceBadge(insurance({ validUntil: TODAY }), TODAY), { label: "Vence hoy", tone: "warning", daysLeft: 0 });
    assert.deepEqual(insuranceBadge(insurance({ status: "vencida", validUntil: plusDays(-3) }), TODAY), { label: "Vencida hace 3 días", tone: "danger", daysLeft: -3 });
    assert.equal(insuranceBadge(insurance({ validUntil: plusDays(-1) }), TODAY).tone, "danger", "vencida aunque el API aún diga vigente");
    assert.deepEqual(insuranceBadge(insurance({ status: "cancelada" }), TODAY), { label: "Cancelada", tone: "neutral", daysLeft: 40 });
    assert.equal(daysUntil("2026-09-21", TODAY), 1);
    assert.equal(daysUntil(null, TODAY), null);
    assert.equal(daysUntil("mañana", TODAY), null);
    assert.equal(renewalLabel(insurance()), "Automática · aviso 60 días");
    assert.equal(renewalLabel(insurance({ autoRenew: false, noticeDays: 1 })), "Manual · aviso 1 día");
  });

  it("la tabla de pólizas pinta el badge por fila, tiñe las que vencen y el KPI cuenta las que están dentro del preaviso", () => {
    assert.match(SOURCE, /<InsuranceStatusBadge insurance=\{row\} today=\{today\} \/>/);
    assert.match(SOURCE, /insurances\.filter\(\(insurance\) => insuranceBadge\(insurance, today\)\.tone === "warning"\)\.length/);
    assert.match(SOURCE, /<CocoaKpi label="Pólizas por vencer"/);
    assert.match(SOURCE, /Cancelar póliza/);
    assert.match(SOURCE, /\{ status: "cancelada" \}/);
  });
});

describe("Seguros · formulario de póliza y tenencias en lectura (puros)", () => {
  const { emptyInsuranceForm, insuranceFormOf, insuranceFormErrors, insuranceBodyOf, tenureRentLabel, tenureReviewLabel, tenureNoticeLabel, tenurePayersLabel, periodicityLabel, inspectionKpis, inspectionBodyOf, inspectionFormErrors, emptyInspectionForm } = screen;

  it("exige tipo, aseguradora, número y vigencia ordenada; los importes con dos decimales; el preaviso 0-365", () => {
    const empty = emptyInsuranceForm(TODAY);
    assert.equal(empty.validFrom, TODAY);
    assert.equal(empty.noticeDays, "60");
    assert.deepEqual(Object.keys(insuranceFormErrors(empty)).sort(), ["insurerName", "kind", "policyNumber", "validUntil"]);
    const form = insuranceFormOf(insurance());
    assert.deepEqual(insuranceFormErrors(form), {});
    assert.match(insuranceFormErrors({ ...form, validUntil: "2020-01-01" }).validUntil ?? "", /anterior al inicio/);
    assert.match(insuranceFormErrors({ ...form, premiumAnnual: "1,234" }).premiumAnnual ?? "", /dos decimales/);
    assert.match(insuranceFormErrors({ ...form, noticeDays: "400" }).noticeDays ?? "", /0 y 365/);
    assert.deepEqual(insuranceBodyOf({ ...form, brokerName: " Corredor Demo ", insuredSum: "12.000.000,00", deductible: "", premiumAnnual: "18000.00", noticeDays: " 45 " }), {
      kind: "multirriesgo",
      insurerName: "Aseguradora Demo SA",
      policyNumber: "MR-TEST-0001",
      brokerName: "Corredor Demo",
      policyholder: "sociedad",
      insuredSum: "12000000.00",
      deductible: null,
      premiumAnnual: "18000.00",
      validFrom: form.validFrom,
      validUntil: form.validUntil,
      autoRenew: true,
      noticeDays: 45,
      mandatoryBasis: null,
      documentId: null,
      notes: null
    });
  });

  it("resume renta, revisión, preaviso y quién paga IBI / seguro / capex de una tenencia", () => {
    assert.equal(plain(tenureRentLabel(tenure())), "Renta mixta · 32.000,00 €/mes + 4 % de los ingresos");
    assert.equal(tenureRentLabel(tenure({ kind: "propiedad" })), "Sin renta (propiedad)");
    assert.equal(plain(tenureRentLabel(tenure({ rentKind: "fija", rentVariablePct: null, rentVariableBase: null }))), "Renta fija · 32.000,00 €/mes");
    assert.equal(tenureReviewLabel(tenure()), "IPC · mes 1");
    assert.equal(tenureReviewLabel(tenure({ rentReviewIndex: "ninguno" })), "Sin revisión");
    assert.equal(tenureNoticeLabel(tenure()), "Preaviso 12 meses · renovación tácita");
    assert.equal(tenurePayersLabel(tenure()), "IBI: arrendatario · seguro: propietario · capex: compartida");
  });

  it("periodicidad, KPI de inspecciones y alta de inspección", () => {
    assert.equal(periodicityLabel(24), "Cada 2 años");
    assert.equal(periodicityLabel(3), "Cada 3 meses");
    assert.equal(periodicityLabel(null), "Sin periodicidad");
    const rows = [inspection(), inspection({ id: "v", dueState: "vencida" }), inspection({ id: "n", status: "con_defectos", result: "negativa", defectsJson: [{ severity: "grave", text: "x", dueAt: null, fixedAt: null }, { severity: "leve", text: "y", dueAt: null, fixedAt: "2026-09-01" }] }), inspection({ id: "c", status: "cerrada", dueState: "vencida" })];
    assert.deepEqual(inspectionKpis(rows), { open: 3, overdue: 1, negatives: 1, openDefects: 1 });
    assert.deepEqual(Object.keys(inspectionFormErrors(emptyInspectionForm())), ["kind"]);
    assert.match(inspectionFormErrors({ ...emptyInspectionForm(), kind: "gas", periodicityMonths: "5000" }).periodicityMonths ?? "", /entero/);
    assert.deepEqual(inspectionBodyOf({ ...emptyInspectionForm(), kind: "oca_ascensor", installationRef: " RAE-0001 ", providerName: "", scheduledAt: "2026-11-01", periodicityMonths: "24", legalBasis: "", complianceRequirementCode: "", notes: "" }), { kind: "oca_ascensor", installationRef: "RAE-0001", scheduledAt: "2026-11-01", periodicityMonths: 24 });
  });
});
