/**
 * Tanda L3 · lote A — precio de reserva desde tarifa al crear (Postgres; tenant AISLADO).
 *
 * app.inject como RECEPCIÓN (plantilla receptionist de T8a: pms.reservation.create +
 * pms.reservation.discount, sin override) sobre una organización `org_l2_<run>` creada con
 * helpers/l2-tenant.mts (hotel A: tipo DBL con 3 habitaciones, plan «BAR» de tipo `public`
 * con 100,00 €/noche publicados del 2026-10-01 al 2026-10-07).
 *
 *   (1) POST /properties/:id/reservations SIN totalAmount y con ratePlanId explícito → 200,
 *       totalAmount = 100 × noches, price_source rate_plan, `pricing.source` y auditoría
 *       RESERVATION_CREATED con pricing + discount.skipped no_total;
 *   (2) sin ratePlanId ni total, 2 habitaciones × 2 noches → precio publicado más bajo
 *       (room-charge.quoteNightlyRate «lowest_published», también rate_plan) = 400;
 *   (3) fechas fuera de la parrilla → 0 € con `none` y aviso; noches parcialmente
 *       publicadas → 0 € con `partial` (§6.2, coherente con T7 TOTAL_NOT_QUOTED);
 *   (4) puerta de descuento T8a intacta con la MISMA cotización: 50 % por recepción → 409
 *       APPROVAL_REQUIRED (kind discount); 8 % → 200 con price_source manual y banda T1;
 *   (5) política sellada al crear: default del hotel (`is_default`, lote S) → código enviado
 *       → política del plan (RatePlan.cancellationPolicyId) → código desconocido cae al default;
 *   (6) importación CSV (servicio T7, en proceso) de 2 filas sin importe_total → preview
 *       `totalSource quoted` y, tras el commit, reservas a 100 € con price_source `file` (el
 *       importador sigue enviando el total cotizado como importe: decisión abierta).
 *
 * Faranda es SOLO LECTURA: farandaInvariants() idéntico antes y después. Nunca reinicia ni
 * necesita el API :3000. Desde el repo:
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test "../../tests/integration/l3-precio-reserva.test.mts"
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { UserContext } from "../../apps/api/src/lib/demo-store.js";

// El helper fija DATABASE_URL (connection_limit), JWT_SECRET y ENCRYPTION_KEY antes de cargar Prisma: va primero.
const { createIsolatedTenant, cleanupTenant, loginOrThrow, newRunId, STRICT_ENV, withEnv, farandaInvariants } = await import("./helpers/l2-tenant.mts");
type IsolatedTenant = import("./helpers/l2-tenant.mts").IsolatedTenant;
type Session = import("./helpers/l2-tenant.mts").Session;
const { prisma } = await import("@hotelos/database");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const importService = await import("../../apps/api/src/modules/pms/reservation-import.service.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Reply = { status: number; body: any; raw: string };

const RUN = `p${newRunId()}`;

let app: ApiApp;
let A: IsolatedTenant;
let reception: Session;
let invariantsBefore: Awaited<ReturnType<typeof farandaInvariants>>;
let defaultPolicyId = "";
let nonRefundablePolicyId = "";

async function post(url: string, session: Session, payload: unknown): Promise<Reply> {
  const res = await withEnv(STRICT_ENV, () => app.inject({ method: "POST", url, headers: session.headers, payload }));
  let body: any = null;
  try {
    body = res.body ? JSON.parse(res.body) : null;
  } catch {
    body = null;
  }
  return { status: res.statusCode, body, raw: res.body };
}

function stay(arrivalDate: string, departureDate: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { arrivalDate, departureDate, adults: 1, roomTypeId: A.roomTypeA, bookerName: `Precio L3 ${RUN}`, ...extra };
}

async function createdAudit(reservationId: string): Promise<Record<string, any>> {
  await flushAuditQueues();
  const audit = await prisma.auditEvent.findFirst({ where: { action: "RESERVATION_CREATED", entityId: reservationId }, orderBy: { createdAt: "desc" } });
  assert.ok(audit, "auditoría RESERVATION_CREATED");
  return (audit.afterJson ?? {}) as Record<string, any>;
}

async function rowOf(reservationId: string) {
  const row = await prisma.reservation.findUnique({ where: { id: reservationId } });
  assert.ok(row, "la reserva existe en Prisma");
  return row;
}

before(async () => {
  invariantsBefore = await farandaInvariants();
  app = await buildApiServer();
  A = await createIsolatedTenant(RUN);
  await withEnv(STRICT_ENV, async () => {
    reception = await loginOrThrow(app, A.users.receptionist.email, A.password, "l3a-precio-reception");
  });
});

after(async () => {
  try {
    await flushAuditQueues();
    if (A) await cleanupTenant(A.organizationId);
  } finally {
    await app?.close();
  }
  // Las suites hermanas de test:integration escriben y limpian Faranda en paralelo: se espera ≤ 10 s.
  let current = await farandaInvariants();
  for (let attempt = 0; attempt < 20 && JSON.stringify(current) !== JSON.stringify(invariantsBefore); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    current = await farandaInvariants();
  }
  assert.deepEqual(current, invariantsBefore, "las cifras de Faranda no cambian");
  if (A) assert.equal(await prisma.organization.count({ where: { id: A.organizationId } }), 0, "sin organización residual de esta suite");
});

describe("L3-A · precio desde tarifa al crear (POST /properties/:id/reservations sin totalAmount)", () => {
  it("(1) con ratePlanId explícito: 2 noches × 100 € = 200,00 · price_source rate_plan · pricing en la respuesta y en la auditoría", async () => {
    const reply = await post(`/properties/${A.propertyA}/reservations`, reception, stay("2026-10-02", "2026-10-04", { ratePlanId: A.ratePlanA }));
    assert.equal(reply.status, 200, reply.raw.slice(0, 400));
    assert.equal(reply.body.totalAmount, 200);
    assert.equal(reply.body.priceSource, "rate_plan");
    assert.equal(reply.body.currency, "EUR");
    assert.deepEqual(reply.body.pricing, { source: "rate_plan", nights: 2, nightsWithoutRate: 0, ratePlanId: A.ratePlanA, warning: null });

    const row = await rowOf(reply.body.id);
    assert.equal(Number(row.totalAmount), 200);
    assert.equal(row.priceSource, "rate_plan");
    assert.equal(row.ratePlanId, A.ratePlanA);
    assert.equal(row.status, "confirmed");
    assert.equal(await prisma.folio.count({ where: { reservationId: row.id, status: "open" } }), 1, "folio abierto como siempre");

    const audit = await createdAudit(reply.body.id);
    assert.equal(audit.pricing?.source, "rate_plan");
    assert.equal(audit.pricing?.ratePlanId, A.ratePlanA);
    assert.equal(audit.priceSource, "rate_plan");
    assert.equal(audit.discount?.skipped, "no_total", "sin total no hay descuento que evaluar");
    assert.equal(audit.cancellationPolicy?.source, "none", "sin políticas en el hotel todavía");
  });

  it("(2) sin ratePlanId ni total, 2 habitaciones × 2 noches → precio publicado más bajo (rate_plan) = 400,00", async () => {
    const reply = await post(`/properties/${A.propertyA}/reservations`, reception, stay("2026-10-04", "2026-10-06", { roomsCount: 2 }));
    assert.equal(reply.status, 200, reply.raw.slice(0, 400));
    assert.equal(reply.body.totalAmount, 400);
    assert.equal(reply.body.priceSource, "rate_plan");
    assert.equal(reply.body.pricing.source, "rate_plan");
    assert.equal(reply.body.pricing.ratePlanId, A.ratePlanA, "el plan que puso precio (BAR, precio publicado más bajo)");
    assert.equal(reply.body.pricing.warning, null, "sin plan pedido no hay salto que avisar");
    const row = await rowOf(reply.body.id);
    assert.equal(Number(row.totalAmount), 400);
    assert.equal(row.priceSource, "rate_plan");
    assert.equal(row.ratePlanId, null, "la reserva no lleva plan: el precio vino de la parrilla");
  });

  it("(3) fuera de la parrilla → 0 € con none y aviso; noches parcialmente publicadas → 0 € con partial", async () => {
    const none = await post(`/properties/${A.propertyA}/reservations`, reception, stay("2026-11-10", "2026-11-12"));
    assert.equal(none.status, 200, none.raw.slice(0, 400));
    assert.equal(none.body.totalAmount, 0);
    assert.equal(none.body.priceSource, "none");
    assert.equal(none.body.pricing.source, "none");
    assert.equal(none.body.pricing.nightsWithoutRate, 2);
    assert.match(String(none.body.pricing.warning), /Sin tarifa publicada.*0 €/);
    assert.equal((await rowOf(none.body.id)).priceSource, "none");

    // 2026-10-06 y 10-07 publicados, 10-08 no → 1 de 3 noches sin precio.
    const partial = await post(`/properties/${A.propertyA}/reservations`, reception, stay("2026-10-06", "2026-10-09", { ratePlanId: A.ratePlanA }));
    assert.equal(partial.status, 200, partial.raw.slice(0, 400));
    assert.equal(partial.body.totalAmount, 0);
    assert.equal(partial.body.priceSource, "partial");
    assert.deepEqual([partial.body.pricing.nights, partial.body.pricing.nightsWithoutRate], [3, 1]);
    assert.match(String(partial.body.pricing.warning), /1 de 3 noches.*0 €/);
    assert.equal((await rowOf(partial.body.id)).priceSource, "partial");
  });

  it("(4) puerta de descuento T8a intacta contra la misma cotización: 50 % → 409 APPROVAL_REQUIRED; 8 % → 200 manual (banda T1)", async () => {
    const refused = await post(`/properties/${A.propertyA}/reservations`, reception, stay("2026-10-02", "2026-10-04", { ratePlanId: A.ratePlanA, totalAmount: 100 }));
    assert.equal(refused.status, 409, refused.raw.slice(0, 400));
    assert.equal(refused.body.details?.code, "APPROVAL_REQUIRED");
    assert.equal(refused.body.details?.kind, "discount");

    const small = await post(`/properties/${A.propertyA}/reservations`, reception, stay("2026-10-02", "2026-10-04", { ratePlanId: A.ratePlanA, totalAmount: 184, discountReasonCode: "loyalty" }));
    assert.equal(small.status, 200, small.raw.slice(0, 400));
    assert.equal(small.body.totalAmount, 184);
    assert.equal(small.body.priceSource, "manual");
    assert.equal(small.body.pricing.source, "manual");
    assert.equal(small.body.pricing.warning, null);
    const row = await rowOf(small.body.id);
    assert.equal(Number(row.totalAmount), 184);
    assert.equal(row.priceSource, "manual");
    const audit = await createdAudit(small.body.id);
    assert.equal(audit.discount?.band, "T1");
    assert.equal(audit.discount?.quotedTotal, 200, "la puerta midió contra la cotización canónica (2 × 100)");
    assert.equal(audit.discount?.discountPct, 8);
    assert.equal(audit.discount?.reasonCode, "loyalty");
  });

  it("(5) política sellada al crear: default del hotel → código enviado → política del plan → código desconocido cae al default", async () => {
    const flex = await prisma.cancellationPolicy.create({
      data: { propertyId: A.propertyA, code: `FLEX-${RUN}`, name: "Flexible 48 h", freeCancelHours: 48, penaltyType: "first_night", isDefault: true, active: true },
      select: { id: true, code: true }
    });
    defaultPolicyId = flex.id;
    const nref = await prisma.cancellationPolicy.create({
      data: { propertyId: A.propertyA, code: `NREF-${RUN}`, name: "No reembolsable", freeCancelHours: 0, penaltyType: "all_stay", isDefault: false, active: true },
      select: { id: true, code: true }
    });
    nonRefundablePolicyId = nref.id;

    const byDefault = await post(`/properties/${A.propertyA}/reservations`, reception, stay("2026-10-01", "2026-10-02"));
    assert.equal(byDefault.status, 200, byDefault.raw.slice(0, 400));
    assert.equal(byDefault.body.cancellationPolicyCode, flex.code);
    assert.equal(byDefault.body.totalAmount, 100);
    let row = await rowOf(byDefault.body.id);
    assert.equal(row.cancellationPolicyId, flex.id);
    assert.equal(row.cancellationPolicyCode, flex.code);
    assert.equal((await createdAudit(byDefault.body.id)).cancellationPolicy?.source, "property_default");

    const byCode = await post(`/properties/${A.propertyA}/reservations`, reception, stay("2026-10-01", "2026-10-02", { cancellationPolicyCode: nref.code }));
    assert.equal(byCode.status, 200, byCode.raw.slice(0, 400));
    row = await rowOf(byCode.body.id);
    assert.deepEqual([row.cancellationPolicyId, row.cancellationPolicyCode], [nref.id, nref.code]);
    assert.equal((await createdAudit(byCode.body.id)).cancellationPolicy?.source, "code");

    await prisma.ratePlan.update({ where: { id: A.ratePlanA }, data: { cancellationPolicyId: nref.id } });
    try {
      const byPlan = await post(`/properties/${A.propertyA}/reservations`, reception, stay("2026-10-01", "2026-10-02", { ratePlanId: A.ratePlanA }));
      assert.equal(byPlan.status, 200, byPlan.raw.slice(0, 400));
      row = await rowOf(byPlan.body.id);
      assert.deepEqual([row.cancellationPolicyId, row.cancellationPolicyCode], [nref.id, nref.code], "RatePlan.cancellationPolicyId gana al default");
      assert.equal((await createdAudit(byPlan.body.id)).cancellationPolicy?.source, "rate_plan");
    } finally {
      await prisma.ratePlan.update({ where: { id: A.ratePlanA }, data: { cancellationPolicyId: null } });
    }

    const unknown = await post(`/properties/${A.propertyA}/reservations`, reception, stay("2026-10-03", "2026-10-04", { cancellationPolicyCode: "flexible_18" }));
    assert.equal(unknown.status, 200, unknown.raw.slice(0, 400));
    row = await rowOf(unknown.body.id);
    assert.deepEqual([row.cancellationPolicyId, row.cancellationPolicyCode], [flex.id, flex.code], "un código que no existe en el hotel no se sella: rige el default");
    const audit = await createdAudit(unknown.body.id);
    assert.equal(audit.cancellationPolicy?.requestedCode, "flexible_18");
    assert.equal(audit.cancellationPolicy?.source, "property_default");
  });

  it("(6) importación CSV de 2 filas sin importe_total → totalSource quoted (100 € cada una) y, tras el commit, price_source quoted (corrector L3 · DS-05 / FC-6)", async () => {
    const context = {
      organizationId: A.organizationId,
      propertyId: A.propertyA,
      userId: A.users.receptionist.id,
      fullName: A.users.receptionist.fullName,
      deviceId: `l3a-import-${RUN}`,
      permissions: ["pms.reservation.read", "pms.reservation.create", "pms.reservation.modify"]
    } as unknown as UserContext;
    const header = ["referencia_externa", "llegada", "salida", "tipo_habitacion", "tarifa", "adultos", "nombre", "apellidos", "email", "importe_total"];
    const rows = [
      [`L3A-${RUN}-1`, "2026-10-06", "2026-10-07", "DBL", "BAR", "1", "Uxía", "Prueba Importación", `uxia.${RUN}@example.com`, ""],
      [`L3A-${RUN}-2`, "2026-10-06", "2026-10-07", "DBL", "", "1", "Brais", "Prueba Importación", `brais.${RUN}@example.com`, ""]
    ];
    const content = "﻿" + [header, ...rows].map((row) => row.join(";")).join("\r\n") + "\r\n";

    const preview = await importService.previewReservationImport({ context, propertyId: A.propertyA, body: { format: "csv", content, fileName: `l3a-${RUN}.csv` } });
    assert.equal(preview.rowCount, 2);
    assert.deepEqual(preview.missingRequired, []);
    assert.equal(preview.canImport, true, JSON.stringify(preview.blockers));
    for (const row of preview.rows) {
      assert.ok(row.issues.some((issue) => issue.code === "RESERVATION_IMPORT_ROW_TOTAL_QUOTED"), `fila ${row.rowNumber}: ${row.issues.map((i) => i.code).join(",")}`);
      assert.equal(row.resolved?.totalSource, "quoted");
      assert.equal(row.resolved?.totalAmount, "100.00");
      assert.equal(row.resolved?.ratePlanCode, "BAR");
    }
    assert.equal(preview.totals.quoted, "200.00");

    const result = await importService.importReservations({ context, propertyId: A.propertyA, body: { format: "csv", content, fileName: `l3a-${RUN}.csv` }, correlationId: `corr-l3a-${RUN}` });
    assert.equal(result.createdCount, 2, JSON.stringify(result).slice(0, 400));
    assert.equal(result.errorCount, 0);
    const imported = await prisma.reservation.findMany({ where: { propertyId: A.propertyA, bookingSource: `import:${result.id}` }, orderBy: { code: "asc" } });
    assert.equal(imported.length, 2);
    for (const row of imported) {
      assert.equal(Number(row.totalAmount), 100, "el total cotizado por T7 llega como importe de la fila");
      assert.equal(row.priceSource, "quoted", "el linaje del precio de la migración: un total cotizado por el importador se persiste como `quoted`, nunca como `file`");
      assert.equal(row.cancellationPolicyId, defaultPolicyId, "también las importadas sellan la política default");
    }
    assert.ok(nonRefundablePolicyId, "fixture de política creada en (5)");
  });
});
