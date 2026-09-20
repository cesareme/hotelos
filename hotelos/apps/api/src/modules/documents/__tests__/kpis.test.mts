// Unit tests · Tanda T9 · lote T9-13 — KPIs de la oficina (kpis.service.ts):
// agregados puros (periodo por defecto, media de horas, touchless, backlog por
// centro con SLA, ventana semanal, degraded) y el servicio con BD simulada:
// forma DocumentKpis, degraded[] con { metric, reason } cuando una consulta
// falla (nunca un 0 silencioso), 403 sin documents.review, ámbito R11 (404
// opaco) y validación de la query. Sin Postgres, sin red. Desde apps/api:
//   node --import tsx --test src/modules/documents/__tests__/kpis.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PermissionDeniedError, type PermissionKey } from "@hotelos/shared";
import type { DegradedCollector } from "../../../lib/degraded.js";
import type { UserContext } from "../../../lib/demo-store.js";
import { HttpError } from "../../../lib/http-error.js";
import {
  actionsWeekWindow,
  averageHours,
  createDocumentKpisService,
  DEFAULT_KPI_PERIOD_DAYS,
  DocumentKpisQuerySchema,
  isTouchless,
  KPI_DEGRADED_REASON,
  moneyString,
  pendingByProperty,
  resolveKpiPeriod,
  toDegraded,
  touchlessPct
} from "../kpis.service.js";

const NOW = new Date("2026-09-20T10:00:00.000Z");
const PROPERTIES = [
  { id: "prop_a", code: "L2A", name: "Hotel Norte" },
  { id: "prop_b", code: "L2B", name: "Hotel Sur" }
];

function context(permissions: PermissionKey[], extra: Partial<UserContext> = {}): UserContext {
  return { organizationId: "org_t9", propertyId: "prop_a", userId: "usr_t9", fullName: "Prueba T9", deviceId: "dev_t9", permissions, orgScope: true, ...extra };
}

function codeOf(error: unknown): string | undefined {
  return error instanceof HttpError ? (error.details as { code?: string } | undefined)?.code : undefined;
}

/** Colector sin console.warn (el real de lib/degraded.ts avisa por consola). */
function quietCollector(): DegradedCollector {
  const degraded: string[] = [];
  return {
    degraded,
    async safe<T>(label: string, promise: Promise<T>, fallback: T): Promise<T> {
      try {
        return await promise;
      } catch {
        degraded.push(label);
        return fallback;
      }
    }
  };
}

type Fail = Partial<Record<"settings" | "pending" | "decided" | "approved" | "bills" | "receipts" | "actions" | "cost", boolean>>;

function fakeDb(fail: Fail = {}) {
  const boom = async (): Promise<never> => {
    throw new Error("consulta caída");
  };
  const calls: Array<{ model: string; where: unknown }> = [];
  return {
    calls,
    property: { findMany: async () => PROPERTIES },
    documentSettings: { findUnique: fail.settings ? boom : async () => ({ officeSlaBusinessDays: 2 }) },
    incomingDocument: {
      findMany: async (args: { where: Record<string, unknown>; select: Record<string, boolean> }) => {
        calls.push({ model: "incomingDocument", where: args.where });
        if (args.select.propertyId) {
          if (fail.pending) return boom();
          return [
            { propertyId: "prop_a", status: "sent_to_office", sentAt: new Date("2026-09-01T08:00:00.000Z") },
            { propertyId: "prop_a", status: "in_review", sentAt: new Date("2026-09-19T08:00:00.000Z") },
            { propertyId: "prop_b", status: "sent_to_office", sentAt: new Date("2026-09-18T08:00:00.000Z") }
          ];
        }
        if (args.select.decidedAt) {
          if (fail.decided) return boom();
          return [
            { sentAt: new Date("2026-09-10T08:00:00.000Z"), decidedAt: new Date("2026-09-10T20:00:00.000Z") },
            { sentAt: new Date("2026-09-11T08:00:00.000Z"), decidedAt: new Date("2026-09-12T08:00:00.000Z") }
          ];
        }
        if (fail.approved) return boom();
        return [{ reviewedFieldsJson: null }, { reviewedFieldsJson: {} }, { reviewedFieldsJson: { total: "10.00" } }, { reviewedFieldsJson: null }];
      }
    },
    supplierBill: { count: fail.bills ? boom : async () => 3 },
    goodsReceipt: { count: fail.receipts ? boom : async () => 1 },
    documentAction: { count: fail.actions ? boom : async () => 4 },
    documentExtraction: { aggregate: fail.cost ? boom : async () => ({ _sum: { costEur: { toFixed: (scale: number) => (1.2345).toFixed(scale) } } }) }
  };
}

function serviceWith(db: ReturnType<typeof fakeDb>) {
  return createDocumentKpisService({ db: db as unknown as Parameters<typeof createDocumentKpisService>[0]["db"], now: () => NOW, collector: () => quietCollector() });
}

// ---------------------------------------------------------------------------
// Funciones puras
// ---------------------------------------------------------------------------

describe("periodo y ventanas", () => {
  it("resolveKpiPeriod: sin query, hoy y los 29 días anteriores; con un extremo, se completa el otro", () => {
    assert.deepEqual(resolveKpiPeriod({}, NOW), { from: "2026-08-22", to: "2026-09-20" });
    assert.equal(DEFAULT_KPI_PERIOD_DAYS, 30);
    assert.deepEqual(resolveKpiPeriod({ to: "2026-03-31" }, NOW), { from: "2026-03-02", to: "2026-03-31" });
    assert.deepEqual(resolveKpiPeriod({ from: "2026-01-01" }, NOW), { from: "2026-01-01", to: "2026-09-20" });
    assert.deepEqual(resolveKpiPeriod({ from: "2026-01-01", to: "2026-01-31" }, NOW), { from: "2026-01-01", to: "2026-01-31" });
  });

  it("actionsWeekWindow: [hoy 00:00 UTC, +7 días)", () => {
    const window = actionsWeekWindow(NOW);
    assert.equal(window.gte.toISOString(), "2026-09-20T00:00:00.000Z");
    assert.equal(window.lt.toISOString(), "2026-09-27T00:00:00.000Z");
  });

  it("DocumentKpisQuerySchema: días ISO, propertyId opcional, sin claves extra, from ≤ to", () => {
    assert.equal(DocumentKpisQuerySchema.safeParse({ from: "2026-09-01", to: "2026-09-20", propertyId: "prop_a" }).success, true);
    assert.equal(DocumentKpisQuerySchema.safeParse({}).success, true);
    assert.equal(DocumentKpisQuerySchema.safeParse({ from: "2026-09-21", to: "2026-09-20" }).success, false);
    assert.equal(DocumentKpisQuerySchema.safeParse({ from: "20/09/2026" }).success, false);
    assert.equal(DocumentKpisQuerySchema.safeParse({ foo: 1 }).success, false);
  });
});

describe("agregados puros", () => {
  it("averageHours: media con una decimal; pares incompletos o negativos se ignoran; null sin pares", () => {
    assert.equal(averageHours([]), null);
    assert.equal(averageHours([{ start: NOW, end: null }]), null);
    assert.equal(
      averageHours([
        { start: new Date("2026-09-10T08:00:00.000Z"), end: new Date("2026-09-10T20:00:00.000Z") },
        { start: new Date("2026-09-11T08:00:00.000Z"), end: new Date("2026-09-12T08:00:00.000Z") },
        { start: new Date("2026-09-12T08:00:00.000Z"), end: new Date("2026-09-11T08:00:00.000Z") }
      ]),
      18
    );
    assert.equal(averageHours([{ start: new Date("2026-09-10T08:00:00.000Z"), end: new Date("2026-09-10T08:10:00.000Z") }]), 0.2);
  });

  it("isTouchless / touchlessPct: null o {} cuentan como sin edición; una decimal; null sin filas", () => {
    assert.equal(isTouchless(null), true);
    assert.equal(isTouchless(undefined), true);
    assert.equal(isTouchless({}), true);
    assert.equal(isTouchless([]), true);
    assert.equal(isTouchless({ total: "1.00" }), false);
    assert.equal(isTouchless("x"), false);
    assert.equal(touchlessPct([]), null);
    assert.equal(touchlessPct([{ reviewedFieldsJson: null }, { reviewedFieldsJson: {} }, { reviewedFieldsJson: { a: 1 } }]), 66.7);
  });

  it("pendingByProperty: todos los centros del ámbito, SLA vencido por fila, orden pendientes desc y nombre", () => {
    const rows = [
      { propertyId: "prop_b", status: "sent_to_office" as const, sentAt: new Date("2026-09-01T08:00:00.000Z") },
      { propertyId: "prop_b", status: "in_review" as const, sentAt: new Date("2026-09-19T08:00:00.000Z") },
      { propertyId: "prop_a", status: "sent_to_office" as const, sentAt: new Date("2026-09-18T08:00:00.000Z") },
      { propertyId: "prop_x", status: "sent_to_office" as const, sentAt: null }
    ];
    assert.deepEqual(pendingByProperty(PROPERTIES, rows, 2, NOW), [
      { propertyId: "prop_b", propertyCode: "L2B", propertyName: "Hotel Sur", pending: 2, slaBreached: 1 },
      { propertyId: "prop_a", propertyCode: "L2A", propertyName: "Hotel Norte", pending: 1, slaBreached: 0 }
    ]);
    assert.deepEqual(pendingByProperty(PROPERTIES, [], 2, NOW).map((row) => row.pending), [0, 0]);
  });

  it("toDegraded / moneyString", () => {
    assert.deepEqual(toDegraded(["a", "b", "a"]), [
      { metric: "a", reason: KPI_DEGRADED_REASON },
      { metric: "b", reason: KPI_DEGRADED_REASON }
    ]);
    assert.equal(moneyString(null), "0.00");
    assert.equal(moneyString({ toFixed: (scale: number) => (12.3456).toFixed(scale) }), "12.35");
  });
});

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

describe("getDocumentKpis", () => {
  it("forma DocumentKpis con todas las consultas en verde: degraded []", async () => {
    const db = fakeDb();
    const kpis = await serviceWith(db).getDocumentKpis({ context: context(["documents.review"]), organizationId: "org_t9", query: { from: "2026-09-01", to: "2026-09-20" } });
    assert.deepEqual(kpis, {
      from: "2026-09-01",
      to: "2026-09-20",
      propertyId: null,
      officeSlaBusinessDays: 2,
      pendingByProperty: [
        { propertyId: "prop_a", propertyCode: "L2A", propertyName: "Hotel Norte", pending: 2, slaBreached: 1 },
        { propertyId: "prop_b", propertyCode: "L2B", propertyName: "Hotel Sur", pending: 1, slaBreached: 0 }
      ],
      avgHoursCentreToOffice: 18,
      touchlessPct: 75,
      billsWithoutReceipt: 3,
      receiptsWithoutBill: 1,
      slaBreached: 1,
      actionsDueThisWeek: 4,
      aiCostEur: "1.23",
      degraded: []
    });
    const pendingWhere = db.calls[0]!.where as { status: { in: string[] }; propertyId: { in: string[] }; blockedAt: unknown };
    assert.deepEqual(pendingWhere.status.in, ["sent_to_office", "in_review"]);
    assert.deepEqual(pendingWhere.propertyId.in, ["prop_a", "prop_b"]);
    assert.equal(pendingWhere.blockedAt, null);
  });

  it("una consulta caída conserva el valor por defecto y marca degraded[] (nunca un 0 silencioso); pendientes caídos degradan también slaBreached", async () => {
    const partial = await serviceWith(fakeDb({ bills: true, cost: true })).getDocumentKpis({ context: context(["documents.review"]), organizationId: "org_t9", query: {} });
    assert.equal(partial.billsWithoutReceipt, 0);
    assert.equal(partial.aiCostEur, "0.00");
    assert.equal(partial.receiptsWithoutBill, 1);
    assert.deepEqual(partial.degraded, [
      { metric: "billsWithoutReceipt", reason: "query_failed" },
      { metric: "aiCostEur", reason: "query_failed" }
    ]);
    const pending = await serviceWith(fakeDb({ pending: true, settings: true })).getDocumentKpis({ context: context(["documents.review"]), organizationId: "org_t9", query: {} });
    assert.deepEqual(pending.pendingByProperty.map((row) => row.pending), [0, 0]);
    assert.equal(pending.slaBreached, 0);
    assert.deepEqual(
      pending.degraded.map((row) => row.metric),
      ["officeSla", "pendingByProperty", "slaBreached"]
    );
    assert.deepEqual(resolveKpiPeriod({}, NOW), { from: pending.from, to: pending.to });
  });

  it("403 sin documents.review; 400 con from > to; 404 PROPERTY_NOT_FOUND fuera de la organización", async () => {
    const service = serviceWith(fakeDb());
    await assert.rejects(service.getDocumentKpis({ context: context(["documents.capture"]), organizationId: "org_t9", query: {} }), PermissionDeniedError);
    await assert.rejects(service.getDocumentKpis({ context: context(["documents.review"]), organizationId: "org_t9", query: { from: "2026-09-21", to: "2026-09-20" } }), (error: unknown) => error instanceof HttpError && error.statusCode === 400);
    await assert.rejects(service.getDocumentKpis({ context: context(["documents.review"]), organizationId: "org_t9", query: { propertyId: "prop_otra" } }), (error: unknown) => error instanceof HttpError && error.statusCode === 404 && codeOf(error) === "PROPERTY_NOT_FOUND");
  });

  it("ámbito R11: con propertyId solo ese centro; sin ámbito de sociedad y centros fuera de las asignaciones → 404 ENTITY_SCOPE_REQUIRED", async () => {
    const service = serviceWith(fakeDb());
    const scoped = context(["documents.review"], { orgScope: false, assignedPropertyIds: ["prop_a"] });
    const one = await service.getDocumentKpis({ context: scoped, organizationId: "org_t9", query: { propertyId: "prop_a" } });
    assert.equal(one.propertyId, "prop_a");
    assert.deepEqual(
      one.pendingByProperty.map((row) => row.propertyId),
      ["prop_a"]
    );
    await assert.rejects(service.getDocumentKpis({ context: scoped, organizationId: "org_t9", query: {} }), (error: unknown) => error instanceof HttpError && error.statusCode === 404 && codeOf(error) === "ENTITY_SCOPE_REQUIRED");
    await assert.rejects(service.getDocumentKpis({ context: scoped, organizationId: "org_t9", query: { propertyId: "prop_b" } }), (error: unknown) => error instanceof HttpError && error.statusCode === 404);
    const both = await service.getDocumentKpis({ context: context(["documents.review"], { orgScope: false, assignedPropertyIds: ["prop_a", "prop_b"] }), organizationId: "org_t9", query: {} });
    assert.equal(both.pendingByProperty.length, 2);
  });
});
