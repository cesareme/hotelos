/**
 * Fusión T8 · §6: un correo de notificación de reseña no entra en el HITL de reservas.
 *
 * processNormalizedEmail (email-reservation.service.ts) consulta classifyInboundEmail
 * (modules/reputation/review-email.parser.ts) ANTES de looksLikeBooking: un correo de
 * `noreply@booking.com` cuyo asunto habla de una reseña queda en `inbound_emails` con
 * estado `review_notification` y NO crea ningún ítem `email_reservation` en
 * ai_human_review_items. Control: un correo sin vocabulario de reserva ni de reseña
 * sigue siendo `ignored`. Postgres real, tenant aislado (helpers/l2-tenant.mts),
 * contexto sintético con `integrations.connect` (ingestManualEmail lo exige). Datos
 * FICTICIOS; al terminar borra lo suyo y la organización.
 *
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/t8-email-review-notification.test.mts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const tenantHelpers = await import("./helpers/l2-tenant.mts");
const { createIsolatedTenant, cleanupTenant, newRunId } = tenantHelpers;
type IsolatedTenant = Awaited<ReturnType<typeof createIsolatedTenant>>;

const { prisma } = await import("@hotelos/database");
const { ingestManualEmail } = await import("../../apps/api/src/modules/integrations/email/email-reservation.service.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");

let A: IsolatedTenant;

describe("T8 · §6 · correo de notificación de reseña vs HITL de reservas (tenant aislado)", () => {
  before(async () => {
    A = await createIsolatedTenant(`e${newRunId()}`);
  });

  after(async () => {
    await flushAuditQueues();
    if (A) {
      await prisma.inboundEmail.deleteMany({ where: { propertyId: A.propertyA } });
      await prisma.emailConnection.deleteMany({ where: { propertyId: A.propertyA } });
      await cleanupTenant(A.organizationId);
    }
  });

  const contextFor = () => ({
    organizationId: A.organizationId,
    propertyId: A.propertyA,
    userId: A.users.owner.id,
    fullName: "Propietario Ficticio",
    deviceId: "t8-email",
    permissions: ["integrations.connect"] as never,
    isPlatformAdmin: false
  });

  it("booking.com + asunto de reseña → fila review_notification y 0 ítems email_reservation", async () => {
    const row = await ingestManualEmail({
      context: contextFor(),
      propertyId: A.propertyA,
      from: "noreply@booking.com",
      subject: "Nueva reseña de un huésped",
      body: "Un huésped ha dejado una reseña de su alojamiento. Nota 8/10.",
      correlationId: "corr_t8_email_1"
    });
    assert.equal(row.status, "review_notification");
    assert.equal(row.propertyId, A.propertyA);
    assert.equal(row.detectedSource, "booking_com");

    const persisted = await prisma.inboundEmail.findUnique({ where: { id: row.id } });
    assert.equal(persisted?.status, "review_notification");
    // Sin parseo con IA: parseSource/confidence solo los rellena el flujo de reserva.
    assert.equal(persisted?.parseSource, null);
    assert.equal(persisted?.confidence, null);

    const hitlCount = await prisma.aiHumanReviewItem.count({ where: { propertyId: A.propertyA, reviewType: "email_reservation" } });
    assert.equal(hitlCount, 0);
  });

  it("control: remitente desconocido sin vocabulario de reserva ni reseña → ignored", async () => {
    const row = await ingestManualEmail({
      context: contextFor(),
      propertyId: A.propertyA,
      from: "cliente@example.com",
      subject: "Consulta general",
      body: "Hola, ¿tienen parking?",
      correlationId: "corr_t8_email_2"
    });
    assert.equal(row.status, "ignored");

    const hitlCount = await prisma.aiHumanReviewItem.count({ where: { propertyId: A.propertyA, reviewType: "email_reservation" } });
    assert.equal(hitlCount, 0);
    const rows = await prisma.inboundEmail.count({ where: { propertyId: A.propertyA } });
    assert.equal(rows, 2);
  });
});
