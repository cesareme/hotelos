// Unit tests · servicio del activo inmobiliario (Tanda ACT · L1). Sin BD: solo
// los mapeadores fila → DTO, los cálculos puros (valor por habitación, valor
// catastral, KPIs, estado derivado de la tenencia) y el prellenado de la
// primera unidad desde el censo del centro, con filas simuladas. Desde apps/api:
//   node --import tsx --test src/modules/real-estate/__tests__/real-estate-service.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RealEstateAsset, RealEstateCharge, RealEstateTenure, RealEstateUnit, RealEstateValuation } from "@prisma/client";
import { dec, utcDay } from "../../payables/money.js";
import {
  auditProjectionOf,
  cadastralValueTotalOf,
  computeRealEstateKpis,
  maskTaxId,
  computeValuePerRoom,
  definedFields,
  deriveTenureStatus,
  initialUnitFromProperty,
  roomsForValuation,
  tenureAlertInput,
  toRealEstateAssetRecord,
  toRealEstateTenureRecord,
  toRealEstateUnitWithCharges,
  toRealEstateValuationRecord
} from "../real-estate.service.js";

const CREATED = new Date("2026-09-20T10:00:00.000Z");
const VALID_REF = "9872023VH5797S0001WX";

function assetRow(overrides: Partial<RealEstateAsset> = {}): RealEstateAsset {
  return {
    id: "rea_1",
    organizationId: "org_act",
    legalEntityId: "le_act",
    propertyId: "prop_act",
    name: "Hotel de prueba ACT",
    yearBuilt: 1998,
    yearLastRefurbished: null,
    builtSurfaceM2: dec("5400.5"),
    plotSurfaceM2: null,
    floorsAbove: 6,
    floorsBelow: 1,
    roomsCount: 120,
    protectionLevel: "none",
    energyRating: "C",
    energyCertValidUntil: utcDay("2030-06-30"),
    cadastralValueTotal: dec("3250000"),
    cadastralValueYear: 2025,
    referenceValue: null,
    lastValuationValue: dec("9800000"),
    lastValuationAt: utcDay("2025-11-15"),
    currentTenureKind: "propiedad",
    status: "active",
    notes: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides
  };
}

function unitRow(overrides: Partial<RealEstateUnit> = {}): RealEstateUnit {
  return {
    id: "reu_1",
    organizationId: "org_act",
    assetId: "rea_1",
    kind: "finca_registral",
    registryOffice: null,
    registryFincaNumber: "12345",
    registryTomo: null,
    registryLibro: null,
    registryFolio: null,
    cru: null,
    cadastralReference: VALID_REF,
    useCode: "hotelero",
    surfaceM2: dec("5400.5"),
    cadastralValueLand: dec("1000000"),
    cadastralValueBuilding: dec("2250000"),
    titleKind: "pleno_dominio",
    titleHolderTaxId: null,
    titleHolderName: null,
    titleDeedDate: null,
    notary: null,
    fixedAssetId: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides
  };
}

function chargeRow(overrides: Partial<RealEstateCharge> = {}): RealEstateCharge {
  return {
    id: "rec_1",
    unitId: "reu_1",
    kind: "hipoteca",
    holderName: "Entidad financiera de prueba",
    holderTaxId: null,
    amount: dec("1500000"),
    outstandingAmount: dec("820000.5"),
    registeredAt: utcDay("2019-03-01"),
    expiresAt: null,
    cancelledAt: null,
    documentId: null,
    note: null,
    createdAt: CREATED,
    ...overrides
  };
}

function tenureRow(overrides: Partial<RealEstateTenure> = {}): RealEstateTenure {
  return {
    id: "ret_1",
    assetId: "rea_1",
    kind: "arrendamiento_industria",
    counterpartyName: "Sociedad arrendadora de prueba SL",
    counterpartyTaxId: "B00000000",
    counterpartyNonResident: false,
    startDate: utcDay("2020-01-01"),
    endDate: utcDay("2030-12-31"),
    noticeMonths: 6,
    renewal: "tacita",
    rentKind: "fija",
    rentMonthly: dec("25000"),
    rentVariablePct: null,
    rentVariableBase: null,
    rentReviewIndex: "ipc",
    rentReviewMonth: 1,
    depositAmount: dec("50000"),
    vatApplies: true,
    withholdingApplies: false,
    withholdingRatePct: null,
    ibiPayer: "propietario",
    insurancePayer: "propietario",
    capexResponsibility: "compartido",
    ffeReservePct: dec("4"),
    brandName: null,
    status: "vigente",
    documentId: null,
    notes: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides
  };
}

function valuationRow(overrides: Partial<RealEstateValuation> = {}): RealEstateValuation {
  return {
    id: "rev_1",
    assetId: "rea_1",
    kind: "eco_805",
    purpose: "hipotecaria",
    valuedAt: utcDay("2025-11-15"),
    value: dec("9800000"),
    valuePerRoom: dec("81666.67"),
    capRatePct: dec("6.25"),
    method: null,
    appraiser: null,
    documentId: null,
    createdAt: CREATED,
    ...overrides
  };
}

describe("mapeadores fila → DTO (MoneyString, IsoDay, catálogos)", () => {
  it("la ficha: Decimal → cadena de 2 decimales, @db.Date → AAAA-MM-DD, instantes ISO, nulls explícitos", () => {
    const record = toRealEstateAssetRecord(assetRow());
    assert.equal(record.builtSurfaceM2, "5400.50");
    assert.equal(record.plotSurfaceM2, null);
    assert.equal(record.cadastralValueTotal, "3250000.00");
    assert.equal(record.lastValuationValue, "9800000.00");
    assert.equal(record.lastValuationAt, "2025-11-15");
    assert.equal(record.energyCertValidUntil, "2030-06-30");
    assert.equal(record.currentTenureKind, "propiedad");
    assert.equal(record.createdAt, "2026-09-20T10:00:00.000Z");
    assert.equal(record.yearLastRefurbished, null);
    assert.equal(toRealEstateAssetRecord(assetRow({ lastValuationValue: null, lastValuationAt: null, currentTenureKind: null })).lastValuationAt, null);
  });

  it("la unidad lleva sus cargas anidadas con importes y fechas convertidos", () => {
    const record = toRealEstateUnitWithCharges({ ...unitRow(), charges: [chargeRow()] });
    assert.equal(record.cadastralReference, VALID_REF);
    assert.equal(record.surfaceM2, "5400.50");
    assert.equal(record.cadastralValueLand, "1000000.00");
    assert.equal(record.charges.length, 1);
    assert.equal(record.charges[0]!.kind, "hipoteca");
    assert.equal(record.charges[0]!.amount, "1500000.00");
    assert.equal(record.charges[0]!.outstandingAmount, "820000.50");
    assert.equal(record.charges[0]!.registeredAt, "2019-03-01");
    assert.equal(record.charges[0]!.expiresAt, null);
  });

  it("la valoración: valor, valor por habitación y cap rate como cadenas decimales", () => {
    const record = toRealEstateValuationRecord(valuationRow());
    assert.equal(record.valuedAt, "2025-11-15");
    assert.equal(record.value, "9800000.00");
    assert.equal(record.valuePerRoom, "81666.67");
    assert.equal(record.capRatePct, "6.25");
    assert.equal(toRealEstateValuationRecord(valuationRow({ valuePerRoom: null, capRatePct: null })).capRatePct, null);
  });

  it("la tenencia: porcentajes con 2 decimales, booleanos tal cual y estado derivado", () => {
    const record = toRealEstateTenureRecord(tenureRow(), "2026-09-20");
    assert.equal(record.startDate, "2020-01-01");
    assert.equal(record.endDate, "2030-12-31");
    assert.equal(record.rentMonthly, "25000.00");
    assert.equal(record.ffeReservePct, "4.00");
    assert.equal(record.vatApplies, true);
    assert.equal(record.status, "vigente");
  });
});

describe("estado derivado de la tenencia (§5.1: vencido si endDate < hoy)", () => {
  it("vigente con endDate pasada → vencido en el DTO; el día del vencimiento sigue vigente", () => {
    assert.equal(deriveTenureStatus({ status: "vigente", endDate: utcDay("2026-09-19") }, "2026-09-20"), "vencido");
    assert.equal(deriveTenureStatus({ status: "vigente", endDate: utcDay("2026-09-20") }, "2026-09-20"), "vigente");
    assert.equal(deriveTenureStatus({ status: "vigente", endDate: null }, "2026-09-20"), "vigente");
  });

  it("borrador y resuelto no se derivan aunque endDate haya pasado", () => {
    assert.equal(deriveTenureStatus({ status: "borrador", endDate: utcDay("2020-01-01") }, "2026-09-20"), "borrador");
    assert.equal(deriveTenureStatus({ status: "resuelto", endDate: utcDay("2020-01-01") }, "2026-09-20"), "resuelto");
    assert.equal(toRealEstateTenureRecord(tenureRow({ endDate: utcDay("2026-01-31") }), "2026-09-20").status, "vencido");
  });

  it("la proyección para alertas conserva el estado PERSISTIDO y no lleva contraparte", () => {
    const input = tenureAlertInput(tenureRow({ endDate: utcDay("2026-01-31") }), "prop_act");
    assert.equal(input.status, "vigente");
    assert.equal(input.endDate, "2026-01-31");
    assert.equal(input.noticeMonths, 6);
    assert.equal(input.propertyId, "prop_act");
    assert.equal("counterpartyName" in input, false);
  });
});

describe("valor por habitación (§4: value / roomsCount, o Property.bedCapacity)", () => {
  it("9.800.000 / 120 = 81.666,67 al céntimo (medio hacia arriba)", () => {
    assert.equal(computeValuePerRoom(dec("9800000"), 120)?.toFixed(2), "81666.67");
    assert.equal(computeValuePerRoom("100", 3)?.toFixed(2), "33.33");
    assert.equal(computeValuePerRoom("200", 3)?.toFixed(2), "66.67");
  });

  it("sin divisor (null o 0) no se calcula", () => {
    assert.equal(computeValuePerRoom(dec("9800000"), null), null);
    assert.equal(computeValuePerRoom(dec("9800000"), 0), null);
  });

  it("el divisor es roomsCount; si es null, bedCapacity del centro; si ninguno, null", () => {
    assert.equal(roomsForValuation({ roomsCount: 120 }, { bedCapacity: 250 }), 120);
    assert.equal(roomsForValuation({ roomsCount: null }, { bedCapacity: 250 }), 250);
    assert.equal(roomsForValuation({ roomsCount: 0 }, { bedCapacity: 250 }), 250);
    assert.equal(roomsForValuation({ roomsCount: null }, { bedCapacity: null }), null);
    assert.equal(roomsForValuation({ roomsCount: null }, null), null);
  });
});

describe("prellenado de la primera unidad desde el censo del centro (§5 alta)", () => {
  it("normaliza la referencia impresa del censo y copia la superficie", () => {
    const unit = initialUnitFromProperty({ cadastralReference: "9872023 vh5797s 0001 wx", surfaceM2: dec("5400.5") });
    assert.equal(unit.cadastralReference, VALID_REF);
    assert.equal(unit.surfaceM2?.toFixed(2), "5400.50");
  });

  it("censo vacío (el caso real de los 8 centros hoy) → unidad sin referencia ni superficie", () => {
    assert.deepEqual(initialUnitFromProperty({ cadastralReference: null, surfaceM2: null }), { cadastralReference: null, surfaceM2: null });
    assert.equal(initialUnitFromProperty({ cadastralReference: "   ", surfaceM2: null }).cadastralReference, null);
  });

  it("una referencia del censo con forma inválida no bloquea el alta: la unidad nace sin referencia", () => {
    assert.equal(initialUnitFromProperty({ cadastralReference: "1234-ABC", surfaceM2: null }).cadastralReference, null);
    assert.equal(initialUnitFromProperty({ cadastralReference: VALID_REF.slice(0, 19), surfaceM2: null }).cadastralReference, null);
  });
});

describe("KPIs parciales de L1 (§4)", () => {
  it("valor catastral: el de la ficha manda; si falta, Σ suelo + construcción de las unidades; sin datos, null", () => {
    assert.equal(cadastralValueTotalOf({ cadastralValueTotal: dec("3250000") }, [unitRow({ cadastralValueLand: dec("1"), cadastralValueBuilding: dec("1") })])?.toFixed(2), "3250000.00");
    assert.equal(cadastralValueTotalOf({ cadastralValueTotal: null }, [unitRow(), unitRow({ cadastralValueLand: dec("100.25"), cadastralValueBuilding: null })])?.toFixed(2), "3250100.25");
    assert.equal(cadastralValueTotalOf({ cadastralValueTotal: null }, [unitRow({ cadastralValueLand: null, cadastralValueBuilding: null })]), null);
    assert.equal(cadastralValueTotalOf({ cadastralValueTotal: null }, []), null);
  });

  it("KPIs con caché de valoración: valor por habitación desde roomsCount; sin filas de tributos, documentos e inspecciones quedan null", () => {
    const kpis = computeRealEstateKpis({ asset: assetRow(), units: [unitRow()], property: { bedCapacity: 250 }, openAlerts: 2 });
    assert.deepEqual(kpis, { cadastralValueTotal: "3250000.00", lastValuationValue: "9800000.00", valuePerRoom: "81666.67", annualTaxBurden: null, documentsValidPct: null, inspectionsOnTimePct: null, openAlerts: 2 });
  });

  it("KPIs completos (ACT-REV-06): carga fiscal, % documentos vigentes y % inspecciones en plazo con las definiciones de la vista de grupo", () => {
    const kpis = computeRealEstateKpis({
      asset: assetRow(),
      units: [unitRow()],
      property: { bedCapacity: 250 },
      openAlerts: 7,
      today: "2026-09-20",
      taxes: [
        { status: "activo", taxpayer: "sociedad", expectedAnnualAmount: dec("27240") },
        { status: "activo", taxpayer: "sociedad", expectedAnnualAmount: "3900.00" },
        { status: "activo", taxpayer: "sociedad", expectedAnnualAmount: dec("1200") },
        { status: "activo", taxpayer: "propietario_tercero", expectedAnnualAmount: dec("18000") },
        { status: "baja", taxpayer: "sociedad", expectedAnnualAmount: dec("500") }
      ],
      documents: [
        { category: "legal", validUntil: null, supersededById: null },
        { category: "seguros", validUntil: new Date("2027-03-31T00:00:00.000Z"), supersededById: null },
        { category: "inspecciones", validUntil: new Date("2025-04-01T00:00:00.000Z"), supersededById: null }
      ],
      inspections: [
        { status: "programada", scheduledAt: new Date("2026-08-31T00:00:00.000Z"), nextDueAt: null },
        { status: "realizada", scheduledAt: new Date("2025-03-10T00:00:00.000Z"), nextDueAt: new Date("2027-03-10T00:00:00.000Z") },
        { status: "programada", scheduledAt: new Date("2031-05-01T00:00:00.000Z"), nextDueAt: null }
      ]
    });
    assert.equal(kpis.annualTaxBurden, "32340.00", "IBI + IAE + residuos de la sociedad; ni tercero ni baja");
    assert.equal(kpis.documentsValidPct, "66.67", "2 de 3 vigentes / sin fecha");
    assert.equal(kpis.inspectionsOnTimePct, "66.67", "1 de 3 vencida");
    assert.equal(kpis.openAlerts, 7);
  });

  it("auditoría sin identificadores fiscales en claro (ACT-REV-08): maskTaxId y auditProjectionOf", () => {
    assert.equal(maskTaxId("B12345678"), "***678");
    assert.equal(maskTaxId("AB"), "***");
    assert.equal(maskTaxId(null), null);
    assert.equal(maskTaxId(undefined), null);
    const projected = auditProjectionOf({ titleHolderTaxId: "B12345678", holderTaxId: "X1234567L", counterpartyTaxId: "A98765432", kind: "finca_registral", note: undefined }, ["titleHolderTaxId", "holderTaxId", "counterpartyTaxId", "kind", "note"]);
    assert.deepEqual(projected, { titleHolderTaxId: "***678", holderTaxId: "***67L", counterpartyTaxId: "***432", kind: "finca_registral", note: null });
  });

  it("KPIs sin valoración ni catastral → null, y valor por habitación con bedCapacity cuando roomsCount es null", () => {
    const empty = computeRealEstateKpis({ asset: assetRow({ cadastralValueTotal: null, lastValuationValue: null, roomsCount: null }), units: [unitRow({ cadastralValueLand: null, cadastralValueBuilding: null })], property: null, openAlerts: 0 });
    assert.equal(empty.cadastralValueTotal, null);
    assert.equal(empty.lastValuationValue, null);
    assert.equal(empty.valuePerRoom, null);
    const beds = computeRealEstateKpis({ asset: assetRow({ roomsCount: null, lastValuationValue: dec("1000000") }), units: [], property: { bedCapacity: 250 }, openAlerts: 0 });
    assert.equal(beds.valuePerRoom, "4000.00");
  });
});

describe("definedFields (PATCH: solo lo enviado; null borra)", () => {
  it("quita las claves undefined y conserva null, false y 0", () => {
    assert.deepEqual(definedFields({ a: undefined, b: null, c: false, d: 0, e: "x" }), { b: null, c: false, d: 0, e: "x" });
    assert.deepEqual(definedFields({}), {});
  });
});
