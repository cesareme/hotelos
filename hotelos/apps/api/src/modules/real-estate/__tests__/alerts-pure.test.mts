// Unit tests · motor de alertas del activo inmobiliario (Tanda ACT · L0a). Sin BD ni reloj. Desde apps/api:
//   node --import tsx --test src/modules/real-estate/__tests__/alerts-pure.test.mts
// Un caso por kind y por gravedad (umbrales 90 / 30 / 7: baja · media · alta; vencido siempre alta).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REAL_ESTATE_ALERT_KINDS, REAL_ESTATE_ALERT_THRESHOLD_DAYS, type RealEstateAlert } from "@hotelos/shared";
import { buildRealEstateAlerts, severityForDaysLeft, sortRealEstateAlerts } from "../alerts.pure.js";

const TODAY = "2026-09-20";
const PROP = "prop_test";

const only = (alerts: RealEstateAlert[], kind: RealEstateAlert["kind"]): RealEstateAlert[] => alerts.filter((alert) => alert.kind === kind);
const single = (alerts: RealEstateAlert[], kind: RealEstateAlert["kind"]): RealEstateAlert => {
  const matches = only(alerts, kind);
  assert.equal(matches.length, 1, `esperaba exactamente una alerta ${kind}, hay ${matches.length}`);
  return matches[0]!;
};

describe("severityForDaysLeft (90 / 30 / 7)", () => {
  it("alta ≤ 7 · media ≤ 30 · baja ≤ 90 · null más lejos o vencido", () => {
    assert.deepEqual([...REAL_ESTATE_ALERT_THRESHOLD_DAYS], [90, 30, 7]);
    assert.equal(severityForDaysLeft(0), "alta");
    assert.equal(severityForDaysLeft(7), "alta");
    assert.equal(severityForDaysLeft(8), "media");
    assert.equal(severityForDaysLeft(30), "media");
    assert.equal(severityForDaysLeft(31), "baja");
    assert.equal(severityForDaysLeft(90), "baja");
    assert.equal(severityForDaysLeft(91), null);
    assert.equal(severityForDaysLeft(-1), null);
  });
});

describe("documentos: DOCUMENT_EXPIRED · DOCUMENT_EXPIRING", () => {
  it("caducado → EXPIRED alta; +5 alta · +20 media · +60 baja; +120, sustituido, retirado y sin fecha no avisan", () => {
    const alerts = buildRealEstateAlerts({
      today: TODAY,
      documents: [
        { id: "d_expired", propertyId: PROP, title: "CEE", validUntil: "2026-09-19" },
        { id: "d_5", propertyId: PROP, title: "Acta OCA BT", validUntil: "2026-09-25" },
        { id: "d_20", propertyId: PROP, title: "Póliza RC", validUntil: "2026-10-10" },
        { id: "d_60", propertyId: PROP, title: "Licencia de actividad", validUntil: "2026-11-19" },
        { id: "d_120", propertyId: PROP, title: "Plan de autoprotección", validUntil: "2027-01-18" },
        { id: "d_superseded", propertyId: PROP, title: "CEE v1", validUntil: "2020-01-01", supersededById: "d_expired" },
        { id: "d_deleted", propertyId: PROP, title: "Retirado", validUntil: "2020-01-01", deletedAt: "2026-01-01T00:00:00.000Z" },
        { id: "d_nodate", propertyId: PROP, title: "Escritura", validUntil: null }
      ]
    });
    const expired = single(alerts, "DOCUMENT_EXPIRED");
    assert.deepEqual([expired.severity, expired.dueAt, expired.entityType, expired.entityId, expired.propertyId], ["alta", "2026-09-19", "real_estate_document", "d_expired", PROP]);
    assert.match(expired.message, /«CEE» caducado el 19\/09\/2026/);
    const expiring = only(alerts, "DOCUMENT_EXPIRING");
    assert.deepEqual(expiring.map((a) => [a.entityId, a.severity]), [["d_5", "alta"], ["d_20", "media"], ["d_60", "baja"]]);
    assert.match(expiring[0]!.message, /caduca en 5 días \(25\/09\/2026\)/);
    assert.equal(alerts.length, 4, "d_120, sustituido, retirado y sin fecha no generan alerta");
  });
});

describe("inspecciones: INSPECTION_DUE · INSPECTION_OVERDUE · INSPECTION_NEGATIVE_OPEN", () => {
  it("DUE por gravedad (realizada con nextDueAt; programada con scheduledAt); OVERDUE alta; ascensor vencido avisa del fuera de servicio", () => {
    const alerts = buildRealEstateAlerts({
      today: TODAY,
      inspections: [
        { id: "i_due_low", propertyId: PROP, kind: "oca_bt", status: "realizada", result: "favorable", nextDueAt: "2026-11-04" }, // +45
        { id: "i_due_mid", propertyId: PROP, kind: "rite", status: "realizada", result: "favorable", nextDueAt: "2026-10-05" }, // +15
        { id: "i_due_high", propertyId: PROP, kind: "legionella", status: "programada", scheduledAt: "2026-09-23", nextDueAt: null }, // +3
        { id: "i_far", propertyId: PROP, kind: "cee", status: "realizada", result: "favorable", nextDueAt: "2027-06-01" },
        { id: "i_overdue", propertyId: PROP, kind: "oca_pci", status: "realizada", result: "favorable", nextDueAt: "2026-09-10" },
        { id: "i_lift", propertyId: PROP, kind: "oca_ascensor", status: "programada", scheduledAt: "2026-09-19", nextDueAt: null, installationRef: "RAE 12345" },
        { id: "i_closed", propertyId: PROP, kind: "gas", status: "cerrada", result: "negativa", nextDueAt: "2020-01-01" }
      ]
    });
    assert.deepEqual(only(alerts, "INSPECTION_DUE").map((a) => [a.entityId, a.severity, a.dueAt]), [["i_due_high", "alta", "2026-09-23"], ["i_due_mid", "media", "2026-10-05"], ["i_due_low", "baja", "2026-11-04"]]);
    const overdue = only(alerts, "INSPECTION_OVERDUE");
    assert.deepEqual(overdue.map((a) => [a.entityId, a.severity, a.dueAt]), [["i_overdue", "alta", "2026-09-10"], ["i_lift", "alta", "2026-09-19"]], "misma gravedad: por fecha ascendente");
    const lift = overdue.find((a) => a.entityId === "i_lift")!;
    assert.match(lift.message, /OCA del ascensor \(RAE 12345\) vencida el 19\/09\/2026: el ascensor debe quedar fuera de servicio a las 24 h/);
    assert.equal(only(alerts, "INSPECTION_NEGATIVE_OPEN").length, 0);
    assert.equal(alerts.some((a) => a.entityId === "i_closed" || a.entityId === "i_far"), false);
  });

  it("NEGATIVE_OPEN alta: acta negativa o con defectos sin correctedAt (con plazo de subsanación como dueAt); subsanada no avisa", () => {
    const alerts = buildRealEstateAlerts({
      today: TODAY,
      inspections: [
        { id: "i_neg", propertyId: PROP, kind: "oca_bt", status: "con_defectos", result: "negativa", performedAt: "2026-09-01", correctionDueAt: "2026-10-01", nextDueAt: "2031-09-01" },
        { id: "i_cond", propertyId: PROP, kind: "rite", status: "con_defectos", result: "condicionada", performedAt: "2026-09-01", nextDueAt: "2030-09-01" },
        { id: "i_fixed", propertyId: PROP, kind: "oca_pci", status: "con_defectos", result: "negativa", performedAt: "2026-08-01", correctedAt: "2026-09-10", nextDueAt: "2036-08-01" }
      ]
    });
    const negatives = only(alerts, "INSPECTION_NEGATIVE_OPEN");
    assert.deepEqual(negatives.map((a) => [a.entityId, a.severity, a.dueAt]), [["i_cond", "alta", "2026-09-01"], ["i_neg", "alta", "2026-10-01"]]);
    assert.match(negatives.find((a) => a.entityId === "i_neg")!.message, /OCA de baja tensión con resultado negativa sin subsanar \(plazo 01\/10\/2026\)/);
    assert.equal(alerts.some((a) => a.entityId === "i_fixed"), false);
  });
});

describe("pólizas: INSURANCE_EXPIRING", () => {
  it("+3 alta · +20 media · +80 baja; vencida alta; cancelada y lejana no avisan", () => {
    const alerts = buildRealEstateAlerts({
      today: TODAY,
      insurances: [
        { id: "s_high", propertyId: PROP, kind: "rc", policyNumber: "RC-1", validUntil: "2026-09-23", status: "vigente" },
        { id: "s_mid", propertyId: PROP, kind: "multirriesgo", validUntil: "2026-10-10", status: "vigente" },
        { id: "s_low", propertyId: PROP, kind: "perdida_beneficios", validUntil: "2026-12-09", status: "vigente" },
        { id: "s_expired", propertyId: PROP, kind: "decenal", policyNumber: "D-9", validUntil: "2026-09-01", status: "vigente" },
        { id: "s_cancelled", propertyId: PROP, kind: "otro", validUntil: "2026-09-01", status: "cancelada" },
        { id: "s_far", propertyId: PROP, kind: "rc", validUntil: "2027-09-01", status: "vigente" }
      ]
    });
    const expiring = only(alerts, "INSURANCE_EXPIRING");
    assert.deepEqual(expiring.map((a) => [a.entityId, a.severity, a.entityType]), [["s_expired", "alta", "real_estate_insurance"], ["s_high", "alta", "real_estate_insurance"], ["s_mid", "media", "real_estate_insurance"], ["s_low", "baja", "real_estate_insurance"]]);
    assert.match(expiring[0]!.message, /Seguro decenal D-9 vencida el 01\/09\/2026 sin renovación registrada/);
    assert.match(expiring[1]!.message, /Póliza de responsabilidad civil RC-1 vence en 3 días/);
    assert.equal(alerts.length, 4);
  });
});

describe("tenencia: TENURE_NOTICE · RENT_REVIEW", () => {
  it("NOTICE: preaviso a 10 días media; a 60 días baja; a 5 días alta; preaviso superado alta (tácita); contrato vencido alta; borrador no avisa", () => {
    const alerts = buildRealEstateAlerts({
      today: TODAY,
      tenures: [
        { id: "t_mid", propertyId: PROP, kind: "arrendamiento_local", status: "vigente", endDate: "2027-03-30", noticeMonths: 6 }, // preaviso 2026-09-30 → +10
        { id: "t_low", propertyId: PROP, kind: "gestion", status: "vigente", endDate: "2027-05-19", noticeMonths: 6 }, // preaviso 2026-11-19 → +60
        { id: "t_high", propertyId: PROP, kind: "franquicia", status: "vigente", endDate: "2026-09-25", noticeMonths: null }, // sin preaviso: vence +5
        { id: "t_missed", propertyId: PROP, kind: "arrendamiento_industria", status: "vigente", endDate: "2026-12-31", noticeMonths: 6, renewal: "tacita" }, // preaviso 2026-06-30 pasado
        { id: "t_ended", propertyId: PROP, kind: "concesion", status: "vigente", endDate: "2026-09-01", noticeMonths: 3 },
        { id: "t_far", propertyId: PROP, kind: "usufructo", status: "vigente", endDate: "2035-01-01", noticeMonths: 12 },
        { id: "t_draft", propertyId: PROP, kind: "arrendamiento_local", status: "borrador", endDate: "2026-09-21", noticeMonths: 1 },
        { id: "t_owned", propertyId: PROP, kind: "propiedad", status: "vigente", endDate: null }
      ]
    });
    const notices = only(alerts, "TENURE_NOTICE");
    assert.deepEqual(notices.map((a) => [a.entityId, a.severity, a.dueAt]), [["t_missed", "alta", "2026-06-30"], ["t_ended", "alta", "2026-09-01"], ["t_high", "alta", "2026-09-25"], ["t_mid", "media", "2026-09-30"], ["t_low", "baja", "2026-11-19"]]);
    assert.match(notices.find((a) => a.entityId === "t_missed")!.message, /plazo de preaviso \(6 meses\) superado el 30\/06\/2026; vence el 31\/12\/2026 y se renueva tácitamente/);
    assert.match(notices.find((a) => a.entityId === "t_ended")!.message, /Concesión vencido el 01\/09\/2026 y todavía vigente/);
    assert.match(notices.find((a) => a.entityId === "t_mid")!.message, /el preaviso \(6 meses\) termina en 10 días \(30\/09\/2026\); vence el 30\/03\/2027/);
    assert.equal(alerts.some((a) => a.entityId === "t_draft" || a.entityId === "t_far" || a.entityId === "t_owned"), false);
  });

  it("RENT_REVIEW: mes de revisión próximo (IPC en octubre → +11 media; +2 alta; +75 baja); mes ya pasado va al año siguiente; índice «ninguno» no avisa", () => {
    const alerts = buildRealEstateAlerts({
      today: TODAY,
      tenures: [
        { id: "r_mid", propertyId: PROP, kind: "arrendamiento_local", status: "vigente", endDate: null, rentReviewIndex: "ipc", rentReviewMonth: 10 }, // 2026-10-01 → +11
        { id: "r_high", propertyId: PROP, kind: "arrendamiento_industria", status: "vigente", endDate: null, rentReviewIndex: "pct_fijo", rentReviewMonth: 9 }, // 2026-09-01 pasado → 2027-09-01 → lejos
        { id: "r_low", propertyId: PROP, kind: "gestion", status: "vigente", endDate: null, rentReviewIndex: "ipc", rentReviewMonth: 12 }, // 2026-12-01 → +72
        { id: "r_none", propertyId: PROP, kind: "arrendamiento_local", status: "vigente", endDate: null, rentReviewIndex: "ninguno", rentReviewMonth: 10 },
        { id: "r_noidx", propertyId: PROP, kind: "arrendamiento_local", status: "vigente", endDate: null, rentReviewIndex: null, rentReviewMonth: 10 }
      ]
    });
    const reviews = only(alerts, "RENT_REVIEW");
    assert.deepEqual(reviews.map((a) => [a.entityId, a.severity, a.dueAt]), [["r_mid", "media", "2026-10-01"], ["r_low", "baja", "2026-12-01"]]);
    assert.match(reviews[0]!.message, /revisión de renta \(IPC\) en 11 días \(01\/10\/2026\)/);
    const soon = buildRealEstateAlerts({ today: "2026-09-29", tenures: [{ id: "r_2", propertyId: PROP, kind: "arrendamiento_local", status: "vigente", endDate: null, rentReviewIndex: "ipc", rentReviewMonth: 10 }] });
    assert.deepEqual(soon.map((a) => [a.kind, a.severity]), [["RENT_REVIEW", "alta"]]);
  });
});

describe("recibos: TAX_DUE · TAX_OVERDUE", () => {
  it("DUE +25 media · +4 alta · +50 baja; OVERDUE alta (también recurrido, marcado); pagado y sin dueTo no avisan", () => {
    const alerts = buildRealEstateAlerts({
      today: TODAY,
      receipts: [
        { id: "x_mid", propertyId: PROP, taxKind: "ibi", fiscalYear: 2026, period: "anual", status: "previsto", dueTo: "2026-10-15", amount: "17955.00" },
        { id: "x_high", propertyId: PROP, taxKind: "iae", fiscalYear: 2026, period: "anual", status: "recibido", dueTo: "2026-09-24" },
        { id: "x_low", propertyId: PROP, taxKind: "residuos", fiscalYear: 2026, period: "2/2", status: "domiciliado", dueTo: "2026-11-09" },
        { id: "x_overdue", propertyId: PROP, taxKind: "vados", fiscalYear: 2026, period: "anual", status: "previsto", dueTo: "2026-06-01", amount: "120.00" },
        { id: "x_appeal", propertyId: PROP, taxKind: "plusvalia", fiscalYear: 2025, period: "unico", status: "recurrido", dueTo: "2026-01-31" },
        { id: "x_paid", propertyId: PROP, taxKind: "ibi", fiscalYear: 2025, period: "anual", status: "pagado", dueTo: "2025-11-30" },
        { id: "x_nodate", propertyId: PROP, taxKind: "terrazas", fiscalYear: 2026, period: "anual", status: "previsto", dueTo: null }
      ]
    });
    assert.deepEqual(only(alerts, "TAX_DUE").map((a) => [a.entityId, a.severity, a.entityType]), [["x_high", "alta", "property_tax_receipt"], ["x_mid", "media", "property_tax_receipt"], ["x_low", "baja", "property_tax_receipt"]]);
    const due = only(alerts, "TAX_DUE").find((a) => a.entityId === "x_mid")!;
    assert.match(due.message, /Recibo IBI 2026 de 17955\.00 €: fin del periodo voluntario en 25 días \(15\/10\/2026\)/);
    const overdue = only(alerts, "TAX_OVERDUE");
    assert.deepEqual(overdue.map((a) => [a.entityId, a.severity, a.dueAt]), [["x_appeal", "alta", "2026-01-31"], ["x_overdue", "alta", "2026-06-01"]]);
    assert.match(overdue[0]!.message, /Plusvalía municipal 2025 \(unico\) vencido el 31\/01\/2026 sin pagar \(recurrido\)/);
    assert.match(overdue[1]!.message, /Recibo Vados 2026 de 120\.00 € vencido el 01\/06\/2026 sin pagar\./);
    assert.equal(alerts.some((a) => a.entityId === "x_paid" || a.entityId === "x_nodate"), false);
  });
});

describe("obras: CAPEX_LICENCE_MISSING", () => {
  it("en curso + licencia exigida + sin documento → alta con dueAt hoy; aprobada, con licencia o sin exigencia no avisan", () => {
    const alerts = buildRealEstateAlerts({
      today: TODAY,
      capexProjects: [
        { id: "c_missing", propertyId: PROP, name: "Reforma planta 4", status: "in_progress", licenceRequired: true, licenceDocumentId: null },
        { id: "c_approved", propertyId: PROP, name: "PIP", status: "approved", licenceRequired: true, licenceDocumentId: null },
        { id: "c_licensed", propertyId: PROP, name: "Ampliación", status: "in_progress", licenceRequired: true, licenceDocumentId: "doc_lic" },
        { id: "c_norequired", propertyId: PROP, name: "Pintura", status: "in_progress", licenceRequired: false, licenceDocumentId: null }
      ]
    });
    assert.deepEqual(alerts.map((a) => [a.kind, a.severity, a.dueAt, a.entityType, a.entityId]), [["CAPEX_LICENCE_MISSING", "alta", TODAY, "capex_project", "c_missing"]]);
    assert.match(alerts[0]!.message, /Obra «Reforma planta 4» en curso sin licencia de obras registrada/);
  });
});

describe("orden, vacío y validación de la entrada", () => {
  it("cubre los 11 kinds del catálogo con un caso; ordena alta → media → baja y por fecha; entradas vacías → []; today inválido → RangeError", () => {
    const covered = new Set<string>([
      ...buildRealEstateAlerts({
        today: TODAY,
        documents: [{ id: "d1", propertyId: PROP, title: "A", validUntil: "2026-09-01" }, { id: "d2", propertyId: PROP, title: "B", validUntil: "2026-10-01" }],
        inspections: [
          { id: "i1", propertyId: PROP, kind: "oca_bt", status: "realizada", nextDueAt: "2026-10-01" },
          { id: "i2", propertyId: PROP, kind: "oca_bt", status: "realizada", nextDueAt: "2026-09-01" },
          { id: "i3", propertyId: PROP, kind: "oca_bt", status: "con_defectos", result: "negativa", nextDueAt: null }
        ],
        insurances: [{ id: "s1", propertyId: PROP, kind: "rc", validUntil: "2026-10-01", status: "vigente" }],
        tenures: [{ id: "t1", propertyId: PROP, kind: "arrendamiento_local", status: "vigente", endDate: "2026-10-01", rentReviewIndex: "ipc", rentReviewMonth: 10 }],
        receipts: [{ id: "x1", propertyId: PROP, taxKind: "ibi", fiscalYear: 2026, period: "anual", status: "previsto", dueTo: "2026-10-01" }, { id: "x2", propertyId: PROP, taxKind: "ibi", fiscalYear: 2025, period: "anual", status: "previsto", dueTo: "2025-11-30" }],
        capexProjects: [{ id: "c1", propertyId: PROP, name: "Obra", status: "in_progress", licenceRequired: true, licenceDocumentId: null }]
      }).map((a) => a.kind)
    ]);
    assert.deepEqual([...covered].sort(), [...REAL_ESTATE_ALERT_KINDS].sort());

    const unsorted: RealEstateAlert[] = [
      { kind: "TAX_DUE", severity: "baja", dueAt: "2026-12-01", entityType: "property_tax_receipt", entityId: "b", propertyId: PROP, message: "" },
      { kind: "DOCUMENT_EXPIRING", severity: "alta", dueAt: "2026-09-25", entityType: "real_estate_document", entityId: "a2", propertyId: PROP, message: "" },
      { kind: "DOCUMENT_EXPIRED", severity: "alta", dueAt: "2026-09-01", entityType: "real_estate_document", entityId: "a1", propertyId: PROP, message: "" },
      { kind: "INSURANCE_EXPIRING", severity: "media", dueAt: "2026-10-01", entityType: "real_estate_insurance", entityId: "m", propertyId: PROP, message: "" }
    ];
    assert.deepEqual(sortRealEstateAlerts(unsorted).map((a) => a.entityId), ["a1", "a2", "m", "b"]);
    assert.deepEqual(buildRealEstateAlerts({ today: TODAY }), []);
    assert.throws(() => buildRealEstateAlerts({ today: "20/09/2026" }), RangeError);
  });
});
