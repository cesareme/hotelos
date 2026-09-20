/**
 * Tanda ACT · lote L6 · calendario anual del activo (calendar.service.ts, puro,
 * sin BD): eventos por tipo (documentos, inspecciones, pólizas, tenencias,
 * tributos con recibo y periodos previstos sin recibo), orden cronológico,
 * preaviso de la tenencia (endDate − noticeMonths), revisión de renta, filtro
 * por año, reparto en 12 meses y etiquetas sin datos personales.
 *
 * Run: cd apps/api && node --import tsx --test src/modules/real-estate/__tests__/calendar.test.mts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RealEstateCalendarEvent } from "@hotelos/shared";
import { REAL_ESTATE_ALERT_ENTITY_TYPES, REAL_ESTATE_ALERT_KINDS } from "@hotelos/shared";
import {
  buildCalendarYear,
  buildRealEstateCalendar,
  formatDay,
  groupEventsByMonth,
  monthOf,
  REAL_ESTATE_CALENDAR_KIND_LABELS,
  sortCalendarEvents,
  withinYear,
  type BuildRealEstateCalendarInput
} from "../calendar.service.js";
import { expectedReceiptsFor } from "../tax-calendar.js";

const YEAR = 2026;
const TODAY = "2026-09-20";
const PROP_A = "prop_a";
const PROP_B = "prop_b";

const isChronological = (events: ReadonlyArray<RealEstateCalendarEvent>) => events.every((event, index) => index === 0 || events[index - 1].dueAt <= event.dueAt);

function fixture(): BuildRealEstateCalendarInput {
  const ibiExpected = expectedReceiptsFor({ kind: "ibi", periodicity: "anual", expectedAnnualAmount: "12000.00", ineMunicipalityCode: "28079" }, YEAR);
  const iaeExpected = expectedReceiptsFor({ kind: "iae", periodicity: "anual", expectedAnnualAmount: "1500.00", ineMunicipalityCode: null }, YEAR);
  return {
    year: YEAR,
    today: TODAY,
    documents: [
      { id: "doc_licence", propertyId: PROP_A, title: "Licencia de actividad", validUntil: "2026-11-30" },
      { id: "doc_expired", propertyId: PROP_A, title: "Certificado; con \"comillas\"", validUntil: "2026-03-01" },
      { id: "doc_superseded", propertyId: PROP_A, title: "Versión vieja", validUntil: "2026-06-01", supersededById: "doc_new" },
      { id: "doc_deleted", propertyId: PROP_A, title: "Retirado", validUntil: "2026-06-01", deletedAt: "2026-05-01T00:00:00.000Z" },
      { id: "doc_no_date", propertyId: PROP_A, title: "Escritura", validUntil: null },
      { id: "doc_next_year", propertyId: PROP_A, title: "CEE", validUntil: "2027-01-15" }
    ],
    inspections: [
      { id: "insp_scheduled", propertyId: PROP_A, kind: "oca_ascensor", status: "programada", scheduledAt: "2026-10-15", nextDueAt: null, installationRef: "RAE-0001" },
      { id: "insp_overdue", propertyId: PROP_A, kind: "legionella", status: "realizada", nextDueAt: "2026-02-10" },
      { id: "insp_closed", propertyId: PROP_A, kind: "cee", status: "cerrada", nextDueAt: "2026-12-01" },
      { id: "insp_no_date", propertyId: PROP_A, kind: "gas", status: "programada", scheduledAt: null, nextDueAt: null }
    ],
    insurances: [
      { id: "ins_rc", propertyId: PROP_B, kind: "rc", policyNumber: "RC-1", validUntil: "2026-12-31", status: "vigente" },
      { id: "ins_cancelled", propertyId: PROP_B, kind: "multirriesgo", policyNumber: "MR-1", validUntil: "2026-12-31", status: "cancelada" }
    ],
    tenures: [
      { id: "ten_gestion", propertyId: PROP_B, kind: "gestion", status: "vigente", endDate: "2027-03-31", noticeMonths: 6, renewal: "tacita", rentReviewIndex: "ipc", rentReviewMonth: 1 },
      { id: "ten_draft", propertyId: PROP_B, kind: "arrendamiento_local", status: "borrador", endDate: "2026-10-01", noticeMonths: 1 },
      { id: "ten_no_notice", propertyId: PROP_A, kind: "propiedad", status: "vigente", endDate: null }
    ],
    taxes: [
      {
        propertyId: PROP_A,
        taxes: [
          {
            tax: { id: "tax_ibi", kind: "ibi", status: "activo", expected: ibiExpected },
            receipts: [{ id: "rcpt_ibi_2026", fiscalYear: YEAR, period: "anual", status: "previsto", dueFrom: "2026-10-01", dueTo: "2026-11-30", paidAt: null }]
          },
          { tax: { id: "tax_iae", kind: "iae", status: "activo", expected: iaeExpected }, receipts: [] },
          { tax: { id: "tax_baja", kind: "residuos", status: "baja", expected: [] }, receipts: [] }
        ]
      }
    ]
  };
}

const byId = (events: ReadonlyArray<RealEstateCalendarEvent>, entityId: string) => events.filter((event) => event.entityId === entityId);

describe("ACT-L6 · calendario anual · eventos por tipo", () => {
  const events = buildRealEstateCalendar(fixture());

  it("solo publica tipos y entidades del catálogo compartido", () => {
    assert.ok(events.length > 0);
    for (const event of events) {
      assert.ok((REAL_ESTATE_ALERT_KINDS as readonly string[]).includes(event.kind), event.kind);
      assert.ok((REAL_ESTATE_ALERT_ENTITY_TYPES as readonly string[]).includes(event.entityType), event.entityType);
      assert.match(event.dueAt, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(event.label.length > 0);
      assert.ok(withinYear(event.dueAt, YEAR), `${event.kind} ${event.dueAt} fuera del año`);
    }
  });

  it("documentos: validUntil del año → DOCUMENT_EXPIRING / DOCUMENT_EXPIRED; sustituidos, retirados, sin fecha y de otro año no entran", () => {
    const licence = byId(events, "doc_licence");
    assert.equal(licence.length, 1);
    assert.equal(licence[0].kind, "DOCUMENT_EXPIRING");
    assert.equal(licence[0].dueAt, "2026-11-30");
    assert.equal(licence[0].entityType, "real_estate_document");
    assert.equal(licence[0].label, "Documento «Licencia de actividad» caduca el 30/11/2026");
    const expired = byId(events, "doc_expired");
    assert.equal(expired.length, 1);
    assert.equal(expired[0].kind, "DOCUMENT_EXPIRED");
    assert.match(expired[0].label, /caducado el 01\/03\/2026/);
    for (const id of ["doc_superseded", "doc_deleted", "doc_no_date", "doc_next_year"]) assert.equal(byId(events, id).length, 0, id);
  });

  it("inspecciones: programada usa scheduledAt (INSPECTION_DUE), realizada con nextDueAt pasado → INSPECTION_OVERDUE; cerrada y sin fecha no entran", () => {
    const scheduled = byId(events, "insp_scheduled");
    assert.equal(scheduled.length, 1);
    assert.deepEqual({ kind: scheduled[0].kind, dueAt: scheduled[0].dueAt, entityType: scheduled[0].entityType }, { kind: "INSPECTION_DUE", dueAt: "2026-10-15", entityType: "real_estate_inspection" });
    assert.equal(scheduled[0].label, "OCA del ascensor (RAE-0001) · próxima inspección el 15/10/2026");
    const overdue = byId(events, "insp_overdue");
    assert.equal(overdue.length, 1);
    assert.equal(overdue[0].kind, "INSPECTION_OVERDUE");
    assert.equal(overdue[0].label, "Control de legionela · vencida el 10/02/2026");
    assert.equal(byId(events, "insp_closed").length, 0);
    assert.equal(byId(events, "insp_no_date").length, 0);
  });

  it("pólizas: validUntil del año → INSURANCE_EXPIRING; canceladas no entran", () => {
    const rc = byId(events, "ins_rc");
    assert.equal(rc.length, 1);
    assert.deepEqual({ kind: rc[0].kind, dueAt: rc[0].dueAt, propertyId: rc[0].propertyId, entityType: rc[0].entityType }, { kind: "INSURANCE_EXPIRING", dueAt: "2026-12-31", propertyId: PROP_B, entityType: "real_estate_insurance" });
    assert.equal(rc[0].label, "Póliza de responsabilidad civil RC-1 · vence el 31/12/2026");
    assert.equal(byId(events, "ins_cancelled").length, 0);
  });

  it("tenencia vigente: preaviso = endDate − noticeMonths (TENURE_NOTICE) y revisión de renta el día 1 del mes (RENT_REVIEW); el vencimiento de 2027 queda fuera", () => {
    const tenure = byId(events, "ten_gestion");
    const notice = tenure.filter((event) => event.kind === "TENURE_NOTICE");
    assert.equal(notice.length, 1, "solo el preaviso cae en 2026 (el vencimiento es de 2027)");
    assert.equal(notice[0].dueAt, "2026-09-30", "2027-03-31 − 6 meses");
    assert.equal(notice[0].entityType, "real_estate_tenure");
    assert.equal(notice[0].label, "Contrato de gestión · fin del preaviso (6 meses) el 30/09/2026; vence el 31/03/2027");
    const review = tenure.filter((event) => event.kind === "RENT_REVIEW");
    assert.equal(review.length, 1);
    assert.equal(review[0].dueAt, "2026-01-01");
    assert.equal(review[0].label, "Contrato de gestión · revisión de renta (IPC) el 01/01/2026");
    assert.equal(byId(events, "ten_draft").length, 0, "una tenencia en borrador no genera eventos");
    assert.equal(byId(events, "ten_no_notice").length, 0, "sin endDate ni revisión no hay eventos");
  });

  it("tenencia con vencimiento en el año y sin preaviso: un único TENURE_NOTICE en endDate; con preaviso, preaviso + vencimiento", () => {
    const plain = buildRealEstateCalendar({ year: YEAR, today: TODAY, tenures: [{ id: "t1", propertyId: PROP_A, kind: "franquicia", status: "vigente", endDate: "2026-12-31", noticeMonths: 0 }] });
    assert.equal(plain.length, 1);
    assert.equal(plain[0].label, "Franquicia · vence el 31/12/2026");
    const withNotice = buildRealEstateCalendar({ year: YEAR, today: TODAY, tenures: [{ id: "t2", propertyId: PROP_A, kind: "arrendamiento_local", status: "vigente", endDate: "2026-12-31", noticeMonths: 3, renewal: "tacita" }] });
    assert.deepEqual(withNotice.map((event) => [event.kind, event.dueAt]), [["TENURE_NOTICE", "2026-09-30"], ["TENURE_NOTICE", "2026-12-31"]]);
    assert.match(withNotice[1].label, /vencimiento del contrato el 31\/12\/2026 \(renovación tácita\)/);
  });

  it("tributos: el recibo del ejercicio da inicio y fin del periodo voluntario (TAX_DUE) enlazando al recibo", () => {
    const receipt = byId(events, "rcpt_ibi_2026");
    assert.deepEqual(receipt.map((event) => [event.kind, event.dueAt, event.entityType]), [["TAX_DUE", "2026-10-01", "property_tax_receipt"], ["TAX_DUE", "2026-11-30", "property_tax_receipt"]]);
    assert.equal(receipt[0].label, "Inicio del periodo voluntario · IBI 2026");
    assert.equal(receipt[1].label, "Fin del periodo voluntario · IBI 2026");
    assert.equal(byId(events, "tax_ibi").length, 0, "con recibo generado no se repite el periodo previsto");
  });

  it("tributos: un tributo activo sin recibo publica su periodo voluntario previsto (supletorio LGT 62.3) enlazando al tributo; los de baja no entran", () => {
    const pending = byId(events, "tax_iae");
    assert.deepEqual(pending.map((event) => [event.kind, event.dueAt]), [["TAX_DUE", "2026-09-01"], ["TAX_DUE", "2026-11-20"]]);
    assert.equal(pending[0].label, "Inicio del periodo voluntario previsto · IAE 2026 (sin recibo)");
    assert.equal(pending[1].label, "Fin del periodo voluntario previsto · IAE 2026 · 1.500,00 € (sin recibo)", "importe formateado (ACT-REV-15)");
    // ACT-REV-13: sin recibo el evento enlaza al TRIBUTO, no a un recibo inexistente.
    assert.equal(pending[0].entityType, "property_tax");
    assert.equal(pending[1].entityType, "property_tax");
    assert.equal(pending[0].entityId, "tax_iae");
    assert.equal(byId(events, "tax_baja").length, 0);
  });

  it("recibo vencido sin pagar → TAX_OVERDUE; pagado → TAX_DUE con «Pagado»", () => {
    const expected = expectedReceiptsFor({ kind: "ibi", periodicity: "anual", expectedAnnualAmount: null, ineMunicipalityCode: null }, YEAR);
    const out = buildRealEstateCalendar({
      year: YEAR,
      today: TODAY,
      taxes: [
        {
          propertyId: PROP_A,
          taxes: [
            { tax: { id: "t_over", kind: "ibi", status: "activo", expected }, receipts: [{ id: "r_over", fiscalYear: YEAR, period: "anual", status: "recibido", dueFrom: "2026-03-01", dueTo: "2026-04-30", paidAt: null }] },
            { tax: { id: "t_paid", kind: "vados", status: "activo", expected: [] }, receipts: [{ id: "r_paid", fiscalYear: YEAR, period: "anual", status: "pagado", dueFrom: null, dueTo: "2026-06-01", paidAt: "2026-05-20" }] }
          ]
        }
      ]
    });
    const over = byId(out, "r_over").find((event) => event.dueAt === "2026-04-30");
    assert.equal(over?.kind, "TAX_OVERDUE");
    assert.match(over?.label ?? "", /^Vencido sin pagar · IBI 2026$/);
    const paid = byId(out, "r_paid");
    assert.equal(paid.length, 1);
    assert.equal(paid[0].kind, "TAX_DUE");
    assert.equal(paid[0].label, "Pagado el 20/05/2026 · Vados 2026", "fecha DD/MM/AAAA (ACT-REV-15)");
  });

  it("las etiquetas no llevan contrapartes ni titulares", () => {
    for (const event of events) assert.doesNotMatch(event.label, /Operadora|Aseguradora|S\.?L\.?\b|S\.?A\.?\b/);
  });
});

describe("ACT-L6 · calendario anual · orden, año y meses", () => {
  it("orden cronológico estable: dueAt, centro, tipo, id, etiqueta", () => {
    const events = buildRealEstateCalendar(fixture());
    assert.ok(isChronological(events));
    assert.equal(events[0].dueAt, "2026-01-01", "la revisión de renta de enero abre el año");
    assert.equal(events[events.length - 1].dueAt, "2026-12-31", "la póliza cierra el año");
    const shuffled = [...events].reverse();
    assert.deepEqual(sortCalendarEvents(shuffled), events);
    const sameDay = sortCalendarEvents([
      { kind: "TAX_DUE", dueAt: "2026-05-05", entityType: "property_tax_receipt", entityId: "b", propertyId: PROP_B, label: "x" },
      { kind: "DOCUMENT_EXPIRING", dueAt: "2026-05-05", entityType: "real_estate_document", entityId: "a", propertyId: PROP_A, label: "x" },
      { kind: "INSPECTION_DUE", dueAt: "2026-05-05", entityType: "real_estate_inspection", entityId: "a", propertyId: PROP_A, label: "x" }
    ]);
    assert.deepEqual(sameDay.map((event) => `${event.propertyId}/${event.kind}`), [`${PROP_A}/DOCUMENT_EXPIRING`, `${PROP_A}/INSPECTION_DUE`, `${PROP_B}/TAX_DUE`]);
  });

  it("solo entran los eventos del año pedido: en 2027 aparecen el CEE, el vencimiento del contrato y su revisión de renta", () => {
    const next = buildRealEstateCalendar({ ...fixture(), year: 2027 });
    assert.ok(next.every((event) => withinYear(event.dueAt, 2027)));
    assert.deepEqual(byId(next, "doc_next_year").map((event) => [event.kind, event.dueAt]), [["DOCUMENT_EXPIRING", "2027-01-15"]]);
    assert.deepEqual(byId(next, "ten_gestion").map((event) => [event.kind, event.dueAt]), [["RENT_REVIEW", "2027-01-01"], ["TENURE_NOTICE", "2027-03-31"]]);
    assert.equal(byId(next, "rcpt_ibi_2026").length, 0, "el recibo de 2026 no es de 2027");
  });

  it("la revisión de renta no se publica más allá del vencimiento del contrato", () => {
    const out = buildRealEstateCalendar({ year: 2028, today: TODAY, tenures: [{ id: "t", propertyId: PROP_A, kind: "gestion", status: "vigente", endDate: "2027-03-31", noticeMonths: 6, rentReviewIndex: "ipc", rentReviewMonth: 1 }] });
    assert.equal(out.length, 0);
  });

  it("groupEventsByMonth reparte en 12 meses (1..12) y descarta los de otro año", () => {
    const events = buildRealEstateCalendar(fixture());
    const months = groupEventsByMonth([...events, { kind: "TAX_DUE", dueAt: "2025-12-31", entityType: "property_tax_receipt", entityId: "x", propertyId: PROP_A, label: "otro año" }], YEAR);
    assert.equal(months.length, 12);
    assert.deepEqual(months.map((month) => month.month), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert.equal(months.reduce((acc, month) => acc + month.events.length, 0), events.length);
    for (const month of months) {
      assert.ok(isChronological(month.events));
      for (const event of month.events) assert.equal(monthOf(event.dueAt), month.month);
    }
    assert.ok(months[0].events.some((event) => event.kind === "RENT_REVIEW"), "enero: revisión de renta");
    assert.ok(months[8].events.some((event) => event.kind === "TENURE_NOTICE"), "septiembre: preaviso");
    assert.ok(months[10].events.some((event) => event.kind === "TAX_DUE" && event.dueAt === "2026-11-30"), "noviembre: fin del periodo voluntario del IBI");
  });

  it("buildCalendarYear devuelve año, centros, 12 meses y el total", () => {
    const events = buildRealEstateCalendar(fixture());
    const calendar = buildCalendarYear({ year: YEAR, properties: [{ propertyId: PROP_A, propertyCode: "A", propertyName: "Hotel A" }, { propertyId: PROP_B, propertyCode: null, propertyName: "Hotel B" }], events });
    assert.equal(calendar.year, YEAR);
    assert.equal(calendar.properties.length, 2);
    assert.equal(calendar.months.length, 12);
    assert.equal(calendar.totalEvents, events.length);
  });

  it("año o «hoy» inválidos → RangeError", () => {
    assert.throws(() => buildRealEstateCalendar({ year: 20261, today: TODAY }), RangeError);
    assert.throws(() => buildRealEstateCalendar({ year: YEAR, today: "2026-13-01" }), RangeError);
  });

  it("helpers: formatDay, monthOf, withinYear y etiquetas de tipo completas", () => {
    assert.equal(formatDay("2026-11-30"), "30/11/2026");
    assert.equal(monthOf("2026-11-30"), 11);
    assert.equal(withinYear("2026-01-01", 2026), true);
    assert.equal(withinYear("2027-01-01", 2026), false);
    for (const kind of REAL_ESTATE_ALERT_KINDS) assert.ok(REAL_ESTATE_CALENDAR_KIND_LABELS[kind]?.length > 0, kind);
  });
});
