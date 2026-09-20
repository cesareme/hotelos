// Unit tests · esquemas zod del activo inmobiliario (Tanda ACT · L0a). Sin BD. Desde apps/api:
//   node --import tsx --test src/schemas/__tests__/real-estate-schemas.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CapexWorkPatchSchema,
  PropertyTaxCreateSchema,
  PropertyTaxListQuerySchema,
  PropertyTaxPatchSchema,
  PropertyTaxReceiptCreateSchema,
  PropertyTaxReceiptPatchSchema,
  RealEstateAssetCreateSchema,
  RealEstateAssetPatchSchema,
  RealEstateChargeCreateSchema,
  RealEstateDocumentCreateSchema,
  RealEstateDocumentListQuerySchema,
  RealEstateDocumentPatchSchema,
  RealEstateInspectionCreateSchema,
  RealEstateInspectionListQuerySchema,
  RealEstateInspectionPatchSchema,
  RealEstateInsuranceCreateSchema,
  RealEstateInsurancePatchSchema,
  RealEstateTenureCreateSchema,
  RealEstateTenurePatchSchema,
  RealEstateUnitCreateSchema,
  RealEstateUnitPatchSchema,
  RealEstateValuationCreateSchema,
  RealEstateYearQuerySchema
} from "../real-estate.schemas.js";

type Result = { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } };
const messagesOf = (result: Result): string => (result.success ? "" : (result.error?.issues ?? []).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(" | "));
const accepts = (schema: { safeParse(v: unknown): Result }, value: unknown, label = ""): void => {
  const result = schema.safeParse(value);
  assert.equal(result.success, true, `${label} ${messagesOf(result)}`.trim());
};
const rejects = (schema: { safeParse(v: unknown): Result }, value: unknown, pattern: RegExp, label = ""): void => {
  const result = schema.safeParse(value);
  assert.equal(result.success, false, `${label} debería rechazarse`.trim());
  assert.match(messagesOf(result), pattern, label);
};

const VALID_REF = "9872023VH5797S0001WX";

describe("ficha del activo", () => {
  it("acepta el alta con importes como cadena/número y fechas AAAA-MM-DD → Decimal y Date", () => {
    const parsed = RealEstateAssetCreateSchema.parse({ name: "Hotel de prueba", yearBuilt: 1998, builtSurfaceM2: "4520.50", plotSurfaceM2: 1200, protectionLevel: "none", energyRating: "C", energyCertValidUntil: "2030-05-01", cadastralValueTotal: "2500000.00", cadastralValueYear: 2025, roomsCount: 92 });
    assert.equal(parsed.builtSurfaceM2?.toFixed(2), "4520.50");
    assert.equal(parsed.plotSurfaceM2?.toFixed(2), "1200.00");
    assert.ok(parsed.energyCertValidUntil instanceof Date);
    assert.equal(parsed.energyCertValidUntil?.toISOString(), "2030-05-01T00:00:00.000Z");
    accepts(RealEstateAssetPatchSchema, { status: "sold", notes: null }, "patch");
  });

  it("rechaza clave desconocida (strict), fecha inexistente, año fuera de rango, rating fuera del catálogo y patch vacío", () => {
    rejects(RealEstateAssetCreateSchema, { name: "X", cadastralReference: VALID_REF }, /cadastralReference: Unrecognized key|Unrecognized key\(s\)/, "la referencia va en la unidad, no en la ficha");
    rejects(RealEstateAssetCreateSchema, { name: "X", energyCertValidUntil: "2026-02-30" }, /energyCertValidUntil: fecha inexistente/);
    rejects(RealEstateAssetCreateSchema, { name: "X", yearBuilt: 1750 }, /yearBuilt debe ser ≥ 1800/);
    rejects(RealEstateAssetCreateSchema, { name: "X", energyRating: "H" }, /energyRating debe ser uno de: A, B, C, D, E, F, G\./);
    rejects(RealEstateAssetCreateSchema, {}, /name: Required|name debe ser un texto/);
    rejects(RealEstateAssetPatchSchema, {}, /no incluye ningún campo que modificar/);
  });
});

describe("unidades y cargas", () => {
  it("normaliza la referencia catastral (minúsculas y espacios) y la devuelve canónica", () => {
    const parsed = RealEstateUnitCreateSchema.parse({ kind: "referencia_catastral", cadastralReference: "9872023 vh5797s 0001 wx", surfaceM2: "980.00", titleKind: "pleno_dominio", titleDeedDate: "2010-06-15" });
    assert.equal(parsed.cadastralReference, VALID_REF);
    assert.equal(parsed.titleDeedDate?.toISOString().slice(0, 10), "2010-06-15");
    accepts(RealEstateUnitPatchSchema, { cadastralReference: null }, "borrar la referencia");
    accepts(RealEstateChargeCreateSchema, { kind: "hipoteca", amount: "1500000.00", outstandingAmount: 900000, registeredAt: "2018-03-01" });
  });

  it("rechaza la referencia catastral de 19 caracteres, con guiones, y claves desconocidas", () => {
    rejects(RealEstateUnitCreateSchema, { cadastralReference: VALID_REF.slice(0, 19) }, /cadastralReference debe tener 20 caracteres alfanuméricos/);
    rejects(RealEstateUnitPatchSchema, { cadastralReference: "9872023-VH5797S-0001WX" }, /cadastralReference debe tener 20 caracteres alfanuméricos/);
    rejects(RealEstateUnitCreateSchema, { kind: "finca_registral", tomo: "12" }, /Unrecognized key/);
    rejects(RealEstateChargeCreateSchema, { kind: "aval" }, /kind debe ser uno de: hipoteca, embargo, servidumbre, afeccion_fiscal, opcion, arrendamiento_inscrito, otra\./);
  });
});

describe("valoraciones y tenencia", () => {
  it("valoración: value obligatorio y > 0; capRatePct como porcentaje", () => {
    const parsed = RealEstateValuationCreateSchema.parse({ kind: "eco_805", purpose: "hipotecaria", valuedAt: "2026-03-01", value: "18500000.00", valuePerRoom: "201086.96", capRatePct: "6.5" });
    assert.equal(parsed.value.toFixed(2), "18500000.00");
    assert.equal(parsed.capRatePct?.toFixed(2), "6.50");
    rejects(RealEstateValuationCreateSchema, { kind: "eco_805", valuedAt: "2026-03-01", value: 0 }, /value: el importe no puede ser cero/);
    rejects(RealEstateValuationCreateSchema, { kind: "eco_805", valuedAt: "2026-03-01", value: "1.005" }, /value: el importe no puede tener más de 2 decimales/);
  });

  it("tenencia: alta válida (arrendamiento con renta y revisión IPC); patch con action activar | resolver; rechaza acción desconocida, endDate < startDate y mes 13", () => {
    accepts(RealEstateTenureCreateSchema, { kind: "arrendamiento_local", startDate: "2020-01-01", endDate: "2035-12-31", noticeMonths: 6, renewal: "tacita", rentKind: "fija", rentMonthly: "3200.00", rentReviewIndex: "ipc", rentReviewMonth: 1, vatApplies: true, withholdingApplies: true, withholdingRatePct: 19, ibiPayer: "propietario" });
    accepts(RealEstateTenureCreateSchema, { kind: "propiedad", startDate: "1998-05-01" });
    accepts(RealEstateTenurePatchSchema, { action: "activar" });
    accepts(RealEstateTenurePatchSchema, { action: "resolver", notes: "Resuelto de mutuo acuerdo." });
    rejects(RealEstateTenurePatchSchema, { action: "cerrar" }, /action debe ser uno de: activar, resolver\./);
    rejects(RealEstateTenureCreateSchema, { kind: "gestion", startDate: "2026-01-01", endDate: "2025-12-31" }, /endDate: endDate no puede ser anterior a startDate\./);
    rejects(RealEstateTenureCreateSchema, { kind: "gestion", startDate: "2026-01-01", rentReviewMonth: 13 }, /rentReviewMonth debe ser ≤ 12/);
    rejects(RealEstateTenurePatchSchema, {}, /no incluye ningún campo/);
  });
});

describe("tributos y recibos", () => {
  it("tributo: alta anual y PAC de 9 plazos (pct suman 100); ratePct con 4 decimales", () => {
    const parsed = PropertyTaxCreateSchema.parse({ kind: "ibi", taxpayer: "sociedad", authorityName: "Ayuntamiento de Madrid", ratePct: "0.4560", taxBase: "2500000.00", expectedAnnualAmount: "11400.00", periodicity: "anual", directDebit: true, directDebitBonusPct: "5" });
    assert.equal(parsed.ratePct?.toFixed(4), "0.4560");
    const installments = Array.from({ length: 9 }, (_, i) => ({ label: `PAC-${String(i + 1).padStart(2, "0")}`, dueFrom: `${String(i + 2).padStart(2, "0")}-01`, dueTo: `${String(i + 2).padStart(2, "0")}-05`, pct: i === 8 ? "11.12" : "11.11" }));
    accepts(PropertyTaxCreateSchema, { kind: "ibi", authorityName: "Ayuntamiento de Madrid", periodicity: "anual", installmentsJson: installments }, "PAC 9 plazos");
    accepts(PropertyTaxPatchSchema, { status: "baja" });
    accepts(PropertyTaxPatchSchema, { voluntaryFrom: "10-01", voluntaryTo: "11-30" });
  });

  it("tributo: rechaza pct que no suman 100, MM-DD inválido, ventana a medias, ratePct con 5 decimales, cuenta no numérica y clave desconocida", () => {
    rejects(PropertyTaxCreateSchema, { kind: "ibi", authorityName: "A", installmentsJson: [{ label: "1", dueFrom: "01-01", dueTo: "01-31", pct: "50" }, { label: "2", dueFrom: "07-01", dueTo: "07-31", pct: "49" }] }, /installmentsJson: los porcentajes de installmentsJson deben sumar 100\./);
    rejects(PropertyTaxCreateSchema, { kind: "ibi", authorityName: "A", installmentsJson: [{ label: "1", dueFrom: "04-31", dueTo: "05-05", pct: "100" }] }, /installmentsJson\.0\.dueFrom: día del año no válido/);
    rejects(PropertyTaxCreateSchema, { kind: "ibi", authorityName: "A", voluntaryFrom: "10-01" }, /voluntaryTo: voluntaryFrom y voluntaryTo van juntos/);
    rejects(PropertyTaxCreateSchema, { kind: "ibi", authorityName: "A", ratePct: "0.45601" }, /ratePct/);
    rejects(PropertyTaxCreateSchema, { kind: "ibi", authorityName: "A", accountCode: "63A" }, /accountCode debe ser un código de cuenta numérico/);
    rejects(PropertyTaxCreateSchema, { kind: "ibi", authorityName: "A", municipality: "Madrid" }, /Unrecognized key/);
    rejects(PropertyTaxCreateSchema, { kind: "ibi", authorityName: "A", taxpayer: "inquilino" }, /taxpayer debe ser uno de: sociedad, propietario_tercero, arrendatario\./);
  });

  it("recibo: alta con ventana ordenada; patch pagado con paidAt y paidWith del catálogo (cash | card | bank); asiento enlazado", () => {
    accepts(PropertyTaxReceiptCreateSchema, { fiscalYear: 2026, period: "anual", dueFrom: "2026-10-01", dueTo: "2026-11-30", amount: "17955.00", status: "previsto" });
    const paid = PropertyTaxReceiptPatchSchema.parse({ status: "pagado", paidAt: "2026-11-15", paidWith: "bank", amount: 17955 });
    assert.equal(paid.paidWith, "bank");
    assert.equal(paid.amount?.toFixed(2), "17955.00");
    accepts(PropertyTaxReceiptPatchSchema, { status: "recurrido", appealRef: "REC-2026-0001" });
    accepts(PropertyTaxReceiptPatchSchema, { journalEntryId: "je_123" });
    accepts(PropertyTaxReceiptPatchSchema, { paidWith: null });
  });

  it("recibo: rechaza paidWith fuera del catálogo, status que no admite el patch (previsto / vencido), dueTo < dueFrom, 3 decimales y clave desconocida", () => {
    rejects(PropertyTaxReceiptPatchSchema, { status: "pagado", paidWith: "cheque" }, /paidWith debe ser uno de: cash, card, bank\./);
    rejects(PropertyTaxReceiptPatchSchema, { status: "pagado", paidWith: "transferencia" }, /paidWith debe ser uno de: cash, card, bank\./);
    rejects(PropertyTaxReceiptPatchSchema, { status: "previsto" }, /status debe ser uno de: recibido, domiciliado, pagado, recurrido\./);
    rejects(PropertyTaxReceiptPatchSchema, { status: "vencido" }, /status debe ser uno de: recibido, domiciliado, pagado, recurrido\./, "vencido es derivado, no se escribe");
    rejects(PropertyTaxReceiptPatchSchema, { dueFrom: "2026-11-30", dueTo: "2026-10-01" }, /dueTo: dueTo no puede ser anterior a dueFrom\./);
    rejects(PropertyTaxReceiptPatchSchema, { amount: "12.345" }, /amount: el importe no puede tener más de 2 decimales/);
    rejects(PropertyTaxReceiptPatchSchema, { expenseId: "exp_1" }, /Unrecognized key/, "el enlace contable es journalEntryId");
    rejects(PropertyTaxReceiptCreateSchema, { fiscalYear: 26 }, /fiscalYear debe ser ≥ 1800/);
  });
});

describe("documentos", () => {
  const PDF_BASE64 = Buffer.from("%PDF-1.4 demo").toString("base64");

  it("acepta metadatos con fichero base64 y sin fichero; patch de metadatos", () => {
    const parsed = RealEstateDocumentCreateSchema.parse({ category: "inspecciones", kind: "acta_oca", title: "Acta OCA BT 2026", issuerName: "OCA demo", issueDate: "2026-09-01", validFrom: "2026-09-01", validUntil: "2031-09-01", linkedEntityType: "inspection", linkedEntityId: "insp_1", file: { fileName: "acta-oca-bt-2026.pdf", mimeType: "application/pdf", base64: PDF_BASE64 } });
    assert.equal(parsed.file?.fileName, "acta-oca-bt-2026.pdf");
    assert.equal(parsed.validUntil?.toISOString().slice(0, 10), "2031-09-01");
    accepts(RealEstateDocumentCreateSchema, { category: "legal", kind: "escritura", title: "Escritura de compraventa" }, "solo ficha");
    accepts(RealEstateDocumentCreateSchema, { category: "legal", kind: "nota_simple", title: "Nota simple 2026", supersedesId: "doc_old" }, "nueva versión");
    accepts(RealEstateDocumentPatchSchema, { validUntil: "2032-01-01", legalHold: true });
  });

  it("rechaza base64 malformado, fileName con barras, validUntil < validFrom, enlace a medias, categoría/kind fuera del catálogo y clave desconocida", () => {
    rejects(RealEstateDocumentCreateSchema, { category: "legal", kind: "escritura", title: "X", file: { fileName: "a.pdf", mimeType: "application/pdf", base64: "data:application/pdf;base64,AAAA" } }, /file\.base64: base64 no válido/);
    rejects(RealEstateDocumentCreateSchema, { category: "legal", kind: "escritura", title: "X", file: { fileName: "../a.pdf", mimeType: "application/pdf", base64: PDF_BASE64 } }, /file\.fileName: fileName no puede contener barras/);
    rejects(RealEstateDocumentCreateSchema, { category: "legal", kind: "escritura", title: "X", validFrom: "2026-09-01", validUntil: "2026-08-01" }, /validUntil: validUntil no puede ser anterior a validFrom\./);
    rejects(RealEstateDocumentCreateSchema, { category: "legal", kind: "escritura", title: "X", linkedEntityType: "unit" }, /linkedEntityId: linkedEntityType y linkedEntityId van juntos/);
    rejects(RealEstateDocumentCreateSchema, { category: "fiscal", kind: "escritura", title: "X" }, /category debe ser uno de: legal, planos, proyectos, licencias, seguros, inspecciones, contratos, tributos, valoraciones, otros\./);
    rejects(RealEstateDocumentCreateSchema, { category: "legal", kind: "contrato", title: "X" }, /kind debe ser uno de: escritura, nota_simple/);
    rejects(RealEstateDocumentCreateSchema, { category: "legal", kind: "escritura", title: "X", storageKey: "org/x" }, /Unrecognized key/, "el almacén lo decide el servidor");
    rejects(RealEstateDocumentPatchSchema, { file: { fileName: "a.pdf", mimeType: "application/pdf", base64: PDF_BASE64 } }, /Unrecognized key/, "el fichero se cambia con una versión nueva");
  });
});

describe("inspecciones y seguros", () => {
  it("inspección: alta programada; acta con defectos [{severity, text, dueAt, fixedAt?}] y subsanación; rechaza result y severity fuera del catálogo", () => {
    accepts(RealEstateInspectionCreateSchema, { kind: "oca_ascensor", legalBasis: "RD 355/2024 art. 11.4", periodicityMonths: 24, installationRef: "RAE 12345", scheduledAt: "2026-10-01" });
    const parsed = RealEstateInspectionPatchSchema.parse({ performedAt: "2026-10-01", result: "condicionada", defectsJson: [{ severity: "grave", text: "Puerta de cabina sin enclavamiento", dueAt: "2026-11-01" }, { severity: "leve", text: "Rótulo", dueAt: null, fixedAt: "2026-10-02" }], correctionDueAt: "2026-11-01", documentId: "doc_acta" });
    assert.equal(parsed.defectsJson?.length, 2);
    assert.equal(parsed.defectsJson?.[1]?.fixedAt?.toISOString().slice(0, 10), "2026-10-02");
    accepts(RealEstateInspectionPatchSchema, { correctedAt: "2026-10-20", status: "cerrada" });
    rejects(RealEstateInspectionPatchSchema, { result: "aprobada" }, /result debe ser uno de: favorable, condicionada, negativa, pendiente\./);
    rejects(RealEstateInspectionPatchSchema, { defectsJson: [{ severity: "critica", text: "x" }] }, /defectsJson\.0\.severity: severity debe ser uno de: leve, grave, muy_grave\./);
    rejects(RealEstateInspectionCreateSchema, { kind: "oca_bt", safetyCheckId: "sc_1" }, /Unrecognized key/);
  });

  it("seguro: alta válida; patch de estado; rechaza validUntil < validFrom, noticeDays fuera de rango y policyholder fuera del catálogo", () => {
    accepts(RealEstateInsuranceCreateSchema, { kind: "multirriesgo", insurerName: "Aseguradora demo", policyNumber: "MR-2026-001", policyholder: "sociedad", insuredSum: "12000000.00", premiumAnnual: "14364.00", validFrom: "2026-01-01", validUntil: "2026-12-31", autoRenew: true, noticeDays: 60 });
    accepts(RealEstateInsurancePatchSchema, { status: "cancelada", notes: "Sustituida por la póliza nueva." });
    accepts(RealEstateInsurancePatchSchema, { status: "vigente" });
    // ACT-REV-17: `vencida` es derivado (validUntil < hoy) y queda fuera del contrato del PATCH.
    rejects(RealEstateInsurancePatchSchema, { status: "vencida" }, /status debe ser uno de: vigente, cancelada\./);
    rejects(RealEstateInsuranceCreateSchema, { kind: "rc", insurerName: "A", policyNumber: "1", validFrom: "2026-12-31", validUntil: "2026-01-01" }, /validUntil: validUntil no puede ser anterior a validFrom\./);
    rejects(RealEstateInsuranceCreateSchema, { kind: "rc", insurerName: "A", policyNumber: "1", validFrom: "2026-01-01", validUntil: "2026-12-31", noticeDays: 400 }, /noticeDays debe ser ≤ 365/);
    rejects(RealEstateInsuranceCreateSchema, { kind: "rc", insurerName: "A", policyNumber: "1", validFrom: "2026-01-01", validUntil: "2026-12-31", policyholder: "arrendatario" }, /policyholder debe ser uno de: sociedad, propietario_tercero\./);
  });
});

describe("obras (PATCH /capex-projects/:id/work)", () => {
  it("acepta los datos de obra con prefijos de cuenta 21x/23x como lista; rechaza prefijo no numérico, workKind fuera del catálogo y clave desconocida", () => {
    const parsed = CapexWorkPatchSchema.parse({ realEstateAssetId: "rea_1", workKind: "reforma", licenceRequired: true, licenceDocumentId: "doc_lic", licenceGrantedAt: "2026-05-10", icioAmount: "4200.00", projectDocumentId: "doc_proj", executionAccountPrefixes: ["231", "2110"] });
    assert.deepEqual(parsed.executionAccountPrefixes, ["231", "2110"]);
    assert.equal(parsed.icioAmount?.toFixed(2), "4200.00");
    accepts(CapexWorkPatchSchema, { executionAccountPrefixes: null, completionDocumentId: "doc_fin" });
    rejects(CapexWorkPatchSchema, { executionAccountPrefixes: ["23x"] }, /executionAccountPrefixes\.0: cada prefijo de executionAccountPrefixes debe ser numérico/);
    rejects(CapexWorkPatchSchema, { workKind: "obra_nueva" }, /workKind debe ser uno de: reforma, ampliacion, mantenimiento_mayor, pip, eficiencia_energetica, accesibilidad\./);
    rejects(CapexWorkPatchSchema, { capitalizedAt: "2026-12-31" }, /Unrecognized key/, "la capitalización la hace POST …/capitalize");
    rejects(CapexWorkPatchSchema, { budget: 1000 }, /Unrecognized key/, "el presupuesto va por PATCH /capex-projects/:id");
  });
});

describe("queries de listado", () => {
  it("year AAAA → número; category/status/kind del catálogo; rechaza valores fuera del catálogo, year corto y clave desconocida", () => {
    assert.deepEqual(RealEstateYearQuerySchema.parse({ year: "2026" }), { year: 2026 });
    assert.deepEqual(RealEstateYearQuerySchema.parse({}), {});
    rejects(RealEstateYearQuerySchema, { year: "26" }, /year debe ser un año \(AAAA\)\./);
    rejects(RealEstateYearQuerySchema, { year: "2026", month: "9" }, /Unrecognized key/);
    accepts(RealEstateDocumentListQuerySchema, { category: "licencias", status: "caduca_pronto", kind: "licencia_actividad" });
    rejects(RealEstateDocumentListQuerySchema, { status: "vencido" }, /status debe ser uno de: vigente, caduca_pronto, caducado, sin_fecha, sustituido\./);
    accepts(RealEstateInspectionListQuerySchema, { status: "programada", kind: "legionella" });
    rejects(RealEstateInspectionListQuerySchema, { status: "abierta" }, /status debe ser uno de: programada, realizada, con_defectos, cerrada\./);
    assert.deepEqual(PropertyTaxListQuerySchema.parse({ year: "2026", kind: "ibi", receiptStatus: "previsto" }), { year: 2026, kind: "ibi", receiptStatus: "previsto" });
    rejects(PropertyTaxListQuerySchema, { kind: "iva" }, /kind debe ser uno de: ibi, iae, residuos, vados, terrazas, ocupacion_via_publica, icio, plusvalia, otro_local\./);
  });
});
