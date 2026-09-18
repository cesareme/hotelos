/**
 * Tanda L2 · L2-04 · integración (Postgres): plataforma persistida —
 * notificaciones (Notification con organizationId), sincronización offline
 * (OfflineSyncRecord), confirmación HITL del check-in por escaneo
 * (AiPendingConfirmation + AiToolCall) y remesas SEPA con ámbito por columna
 * (WorkerJobRun.organizationId / propertyId). Dos organizaciones AISLADAS
 * (helpers/l2-tenant.mts), auth real y RBAC_STRICT; Faranda y org_123 solo se
 * leen (invariantes).
 *
 *   · GET /notifications solo devuelve las del usuario Y de su organización (una
 *     fila con el mismo userId en otra organización no aparece); POST …/read;
 *   · POST /offline/sync → fila offline_sync_records con organizationId → GET
 *     lista (organización B → 404);
 *   · check-in-from-scan (recepción) crea AiPendingConfirmation + AiToolCall `pending` →
 *     execute desde B → 404 → execute correcto → executed / completed → segundo
 *     execute → 404 (ya no está pendiente);
 *   · remesa SEPA de A invisible para B (lista, detalle y cambio de estado).
 *
 * Run: cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/l2-persistencia-plataforma.test.mts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const { createIsolatedTenant, loginOrThrow, cleanupTenant, STRICT_ENV, withEnv, newRunId, farandaInvariants } = await import("./helpers/l2-tenant.mts");
type IsolatedTenant = import("./helpers/l2-tenant.mts").IsolatedTenant;
type Session = import("./helpers/l2-tenant.mts").Session;
const { prisma } = await import("@hotelos/database");
const { buildApiServer } = await import("../../apps/api/src/server.js");
type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;

const RUN_A = newRunId();
const RUN_B = `${RUN_A}b`;

let app: ApiApp;
let tenantA: IsolatedTenant;
let tenantB: IsolatedTenant;
/** Propiedad (plantilla owner, T8a): lectura; nunca admin de plataforma. */
let ownerA: Session;
let ownerB: Session;
/** Recepción (T8a): ai.tool.execute + pms.checkin.execute + compliance.ses.submit — ejecuta el check-in HITL. */
let receptionistA: Session;
/** Recepción de B: tiene las claves del check-in pero no el ámbito de A → 404 opaco (no 403). */
let receptionistB: Session;
let accountantA: Session;
let baseline: Awaited<ReturnType<typeof farandaInvariants>>;

type Method = "GET" | "POST" | "PATCH" | "DELETE";
type Reply = { status: number; body: Record<string, any> };

async function call(server: ApiApp, method: Method, url: string, session: Session, payload?: unknown, propertyId?: string): Promise<Reply> {
  const res = await withEnv(STRICT_ENV, () =>
    server.inject({
      method,
      url,
      headers: { ...session.headers, ...(propertyId ? { "x-property-id": propertyId } : {}) },
      ...(payload !== undefined ? { payload } : {})
    })
  );
  let body: Record<string, any> = {};
  try {
    body = res.body ? (JSON.parse(res.body) as Record<string, any>) : {};
  } catch {
    body = { raw: res.body };
  }
  return { status: res.statusCode, body };
}

/** Fecha local de hoy en la zona horaria del hotel (Europe/Madrid), YYYY-MM-DD. */
function todayInMadrid(offsetDays = 0): string {
  const date = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

before(async () => {
  app = await buildApiServer();
  await app.ready();
  baseline = await farandaInvariants();
  tenantA = await createIsolatedTenant(RUN_A);
  tenantB = await createIsolatedTenant(RUN_B);
  ownerA = await withEnv(STRICT_ENV, () => loginOrThrow(app, tenantA.users.owner.email, tenantA.password));
  ownerB = await withEnv(STRICT_ENV, () => loginOrThrow(app, tenantB.users.owner.email, tenantB.password));
  receptionistA = await withEnv(STRICT_ENV, () => loginOrThrow(app, tenantA.users.receptionist.email, tenantA.password));
  receptionistB = await withEnv(STRICT_ENV, () => loginOrThrow(app, tenantB.users.receptionist.email, tenantB.password));
  accountantA = await withEnv(STRICT_ENV, () => loginOrThrow(app, tenantA.users.accountant.email, tenantA.password));
});

after(async () => {
  try {
    if (tenantA) await cleanupTenant(tenantA.organizationId);
    if (tenantB) await cleanupTenant(tenantB.organizationId);
    assert.equal(await prisma.organization.count({ where: { id: { in: [tenantA?.organizationId ?? "", tenantB?.organizationId ?? ""] } } }), 0, "sin organizaciones residuales");
    if (baseline) assert.deepEqual(await farandaInvariants(), baseline, "Faranda intacta");
  } finally {
    await app?.close();
  }
});

describe("L2-04 · Notification en Prisma con aislamiento por organización", () => {
  it("GET /notifications devuelve solo las del usuario en su organización; POST …/read marca leída", async () => {
    const mine = await prisma.notification.createMany({
      data: [
        { organizationId: tenantA.organizationId, propertyId: tenantA.propertyA, userId: ownerA.userId, type: "system", title: "Aviso 1", body: "Primera", status: "unread" },
        { organizationId: tenantA.organizationId, propertyId: tenantA.propertyA, userId: ownerA.userId, type: "compliance", title: "Aviso 2", body: "Segunda", status: "unread" },
        // Mismo userId ficticio en OTRA organización: nunca debe aparecer.
        { organizationId: tenantB.organizationId, propertyId: tenantB.propertyA, userId: ownerA.userId, type: "system", title: "Ajena", body: "Otra organización", status: "unread" },
        // Otro usuario de la misma organización: tampoco.
        { organizationId: tenantA.organizationId, propertyId: tenantA.propertyA, userId: receptionistA.userId, type: "system", title: "De recepción", body: "Otro usuario", status: "unread" }
      ]
    });
    assert.equal(mine.count, 4);

    const list = await call(app, "GET", "/notifications", ownerA);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const items = list.body as unknown as Array<{ id: string; title: string; status: string; userId: string }>;
    assert.equal(items.length, 2, JSON.stringify(items));
    assert.deepEqual(items.map((item) => item.title).sort(), ["Aviso 1", "Aviso 2"]);
    assert.ok(items.every((item) => item.userId === ownerA.userId));

    const foreign = await prisma.notification.findFirstOrThrow({ where: { organizationId: tenantB.organizationId, userId: ownerA.userId }, select: { id: true } });
    const denied = await call(app, "POST", `/notifications/${foreign.id}/read`, ownerA);
    assert.equal(denied.status, 404, JSON.stringify(denied.body));
    assert.equal((await prisma.notification.findUniqueOrThrow({ where: { id: foreign.id } })).status, "unread", "la fila ajena no cambia");

    const target = items.find((item) => item.title === "Aviso 1")!;
    const read = await call(app, "POST", `/notifications/${target.id}/read`, ownerA);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.status, "read");
    assert.equal((await prisma.notification.findUniqueOrThrow({ where: { id: target.id } })).status, "read");
    const again = await call(app, "GET", "/notifications", ownerA);
    assert.equal((again.body as unknown as Array<{ id: string; status: string }>).find((item) => item.id === target.id)?.status, "read");
    const other = await call(app, "POST", `/notifications/${target.id}/read`, receptionistA);
    assert.equal(other.status, 404, "otro usuario de la misma organización: 404 opaco");
  });
});

describe("L2-04 · OfflineSyncRecord en Prisma", () => {
  it("POST /offline/sync persiste la fila con organizationId y GET la lista por propiedad (organización B → 404)", async () => {
    const actionId = `act_${RUN_A}`;
    const sync = await call(
      app,
      "POST",
      "/offline/sync",
      receptionistA,
      {
        propertyId: tenantA.propertyA,
        deviceId: `dev-${RUN_A}`,
        actions: [
          { id: actionId, type: "voice.command.draft", payload: { text: "hola" }, createdAt: new Date().toISOString(), status: "pending" },
          { id: `${actionId}_inv`, type: "invoice.issue", payload: {}, createdAt: new Date().toISOString(), status: "pending" }
        ]
      },
      tenantA.propertyA
    );
    assert.equal(sync.status, 200, JSON.stringify(sync.body));
    assert.equal(sync.body.accepted, 1);
    assert.equal(sync.body.rejected, 1);

    const rows = await prisma.offlineSyncRecord.findMany({ where: { propertyId: tenantA.propertyA }, orderBy: { createdAt: "asc" } });
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.organizationId === tenantA.organizationId), "organizationId escrito");
    assert.equal((rows[0]!.actionJson as { id: string }).id, actionId);
    assert.equal((rows[1]!.resultJson as { status: string }).status, "rejected");

    const list = await call(app, "GET", `/properties/${tenantA.propertyA}/offline-sync-records`, receptionistA);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const items = list.body as unknown as Array<{ id: string; propertyId: string; deviceId: string; action: { id: string }; result: { status: string } }>;
    assert.equal(items.length, 2);
    assert.equal(items[0]!.result.status, "rejected", "orden descendente: la última primero");
    assert.equal(items[1]!.action.id, actionId);
    assert.ok(items.every((item) => item.deviceId === `dev-${RUN_A}`));

    const foreignList = await call(app, "GET", `/properties/${tenantA.propertyA}/offline-sync-records`, ownerB);
    assert.equal(foreignList.status, 404, JSON.stringify(foreignList.body));
    const foreignSync = await call(app, "POST", "/offline/sync", ownerB, { propertyId: tenantA.propertyA, deviceId: "dev-b", actions: [] }, tenantA.propertyA);
    assert.equal(foreignSync.status, 404, JSON.stringify(foreignSync.body));
    assert.equal(await prisma.offlineSyncRecord.count({ where: { propertyId: tenantA.propertyA } }), 2, "la organización B no escribe");
  });
});

describe("L2-04 · HITL del check-in por escaneo en Prisma", () => {
  let confirmationId = "";
  let reservationId = "";

  it("check-in-from-scan crea AiPendingConfirmation `pending` y AiToolCall `pending`", async () => {
    const documentNumber = `L2${RUN_A.slice(-6).toUpperCase()}X`;
    const guest = await prisma.guest.create({
      data: {
        organizationId: tenantA.organizationId,
        firstName: `Ana${RUN_A}`,
        surname1: `Prueba${RUN_A}`,
        documentType: "DNI",
        documentNumber,
        nationality: "ESP",
        dateOfBirth: new Date("1985-04-12T00:00:00.000Z")
      },
      select: { id: true }
    });
    const reservation = await prisma.reservation.create({
      data: {
        propertyId: tenantA.propertyA,
        code: `L2-${RUN_A}`,
        channel: "direct",
        status: "confirmed",
        arrivalDate: new Date(`${todayInMadrid()}T00:00:00.000Z`),
        departureDate: new Date(`${todayInMadrid(2)}T00:00:00.000Z`),
        adults: 1,
        roomTypeId: tenantA.roomTypeA,
        ratePlanId: tenantA.ratePlanA,
        currency: "EUR",
        bookerName: `Ana ${RUN_A}`
      },
      select: { id: true }
    });
    reservationId = reservation.id;
    await prisma.reservationGuest.create({ data: { reservationId: reservation.id, guestId: guest.id, isPrimary: true } });

    const res = await call(
      app,
      "POST",
      "/ai/commands/check-in-from-scan",
      receptionistA,
      {
        propertyId: tenantA.propertyA,
        transcript: "check-in de Ana en la 101",
        roomNumber: "101",
        documentExtractedFields: {
          firstName: `Ana${RUN_A}`,
          surname1: `Prueba${RUN_A}`,
          documentType: "DNI",
          documentNumber,
          documentSupportNumber: "ABC123456",
          nationality: "ESP",
          dateOfBirth: "1985-04-12",
          sex: "F"
        },
        documentImageStored: false,
        idImageDiscarded: true
      },
      tenantA.propertyA
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, "confirmation_required", JSON.stringify(res.body));
    confirmationId = res.body.confirmationId;
    assert.ok(confirmationId);
    assert.ok(res.body.card);

    const pending = await prisma.aiPendingConfirmation.findUniqueOrThrow({ where: { id: confirmationId } });
    assert.equal(pending.status, "pending");
    assert.equal(pending.organizationId, tenantA.organizationId);
    assert.equal(pending.propertyId, tenantA.propertyA);
    assert.equal(pending.reservationId, reservation.id);
    assert.equal(pending.guestId, guest.id);
    assert.equal(pending.userId, receptionistA.userId);
    assert.ok(pending.expiresAt.getTime() > Date.now() + 23 * 60 * 60 * 1000, "caduca a las 24 h");
    assert.ok(pending.roomId, "habitación resuelta");

    const toolCall = await prisma.aiToolCall.findFirst({
      where: { organizationId: tenantA.organizationId, toolName: "checkInReservation", outputJson: { path: ["confirmationId"], equals: confirmationId } }
    });
    assert.ok(toolCall, "AiToolCall creado vía recordToolCall");
    assert.equal(toolCall.status, "pending");
    assert.equal(toolCall.requiredConfirmation, true);
    assert.equal(toolCall.propertyId, tenantA.propertyA);
    assert.equal(toolCall.userId, receptionistA.userId);
  });

  it("execute desde la organización B → 404; execute correcto → executed / completed; segundo execute → 404", async () => {
    const foreign = await call(app, "POST", `/ai/confirmations/${confirmationId}/execute`, receptionistB, { signatureObjectKey: "sig_b" }, tenantB.propertyA);
    assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
    const noKey = await call(app, "POST", `/ai/confirmations/${confirmationId}/execute`, ownerB, { signatureObjectKey: "sig_b" }, tenantB.propertyA);
    assert.equal(noKey.status, 403, "sin pms.checkin.execute el guardián de claves responde antes que la entidad");
    assert.equal((await prisma.aiPendingConfirmation.findUniqueOrThrow({ where: { id: confirmationId } })).status, "pending");

    const missing = await call(app, "POST", `/ai/confirmations/conf_l2_missing_${RUN_A}/execute`, receptionistA, { signatureObjectKey: "sig" }, tenantA.propertyA);
    assert.equal(missing.status, 404);

    const executed = await call(app, "POST", `/ai/confirmations/${confirmationId}/execute`, receptionistA, { signatureObjectKey: `sig_${RUN_A}` }, tenantA.propertyA);
    assert.equal(executed.status, 200, JSON.stringify(executed.body));
    assert.equal(executed.body.status, "executed");
    assert.equal(executed.body.reservationId, reservationId);
    assert.ok(executed.body.roomId);

    const confirmation = await prisma.aiPendingConfirmation.findUniqueOrThrow({ where: { id: confirmationId } });
    assert.equal(confirmation.status, "executed");
    assert.ok(confirmation.executedAt);
    const toolCall = await prisma.aiToolCall.findFirstOrThrow({
      where: { organizationId: tenantA.organizationId, toolName: "checkInReservation", outputJson: { path: ["confirmationId"], equals: confirmationId } }
    });
    assert.equal(toolCall.status, "completed");
    assert.equal(toolCall.confirmedBy, receptionistA.userId);
    assert.equal((toolCall.outputJson as { execution?: { reservationId?: string } }).execution?.reservationId, reservationId);
    assert.equal((await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } })).status, "checked_in");
    const register = await prisma.guestRegisterRecord.findFirst({ where: { reservationId }, select: { signatureObjectKey: true } });
    assert.equal(register?.signatureObjectKey, `sig_${RUN_A}`);

    const replay = await call(app, "POST", `/ai/confirmations/${confirmationId}/execute`, receptionistA, { signatureObjectKey: "sig_again" }, tenantA.propertyA);
    assert.equal(replay.status, 404, "una confirmación ejecutada no se distingue de una inexistente");
  });
});

describe("L2-04 · remesas SEPA con ámbito por columna (worker_job_runs)", () => {
  it("la remesa de A escribe organizationId/propertyId y es invisible para B (lista, detalle y estado)", async () => {
    const created = await call(
      app,
      "POST",
      "/treasury/sepa/remittances",
      accountantA,
      {
        kind: "norma34",
        propertyId: tenantA.propertyA,
        body: {
          executionDate: "2026-10-01",
          debtor: { name: `L2 Test ${RUN_A} SL`, taxId: tenantA.taxId, iban: "ES9121000418450200051332" },
          creditors: [{ name: "Proveedor de prueba", iban: "ES7921000813610123456789", amount: "10.00", description: "Prueba L2", endToEndId: `E2E-${RUN_A}` }]
        }
      },
      tenantA.propertyA
    );
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const remittanceId = created.body.id as string;
    assert.equal(created.body.organizationId, tenantA.organizationId);
    assert.equal(created.body.propertyId, tenantA.propertyA);
    assert.equal(created.body.status, "generated");

    const row = await prisma.workerJobRun.findUniqueOrThrow({ where: { id: remittanceId } });
    assert.equal(row.organizationId, tenantA.organizationId, "columna organization_id");
    assert.equal(row.propertyId, tenantA.propertyA, "columna property_id");
    assert.equal((row.payloadJson as { organizationId?: string }).organizationId, tenantA.organizationId, "payloadJson conserva la organización");

    const list = await call(app, "GET", `/treasury/sepa/remittances?propertyId=${tenantA.propertyA}`, accountantA, undefined, tenantA.propertyA);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.ok((list.body.items as Array<{ id: string }>).some((item) => item.id === remittanceId));
    const detail = await call(app, "GET", `/treasury/sepa/remittances/${remittanceId}`, accountantA, undefined, tenantA.propertyA);
    assert.equal(detail.status, 200);
    assert.ok(typeof detail.body.xml === "string" && detail.body.xml.includes("pain.001"));

    const foreignDetail = await call(app, "GET", `/treasury/sepa/remittances/${remittanceId}`, ownerB, undefined, tenantB.propertyA);
    assert.equal(foreignDetail.status, 404, JSON.stringify(foreignDetail.body));
    const foreignStatus = await call(app, "POST", `/treasury/sepa/remittances/${remittanceId}/status`, ownerB, { status: "sent" }, tenantB.propertyA);
    assert.ok([403, 404].includes(foreignStatus.status), `estado desde B: ${foreignStatus.status}`);
    assert.equal((await prisma.workerJobRun.findUniqueOrThrow({ where: { id: remittanceId } })).status, "generated");
    const foreignList = await call(app, "GET", "/treasury/sepa/remittances", ownerB, undefined, tenantB.propertyA);
    if (foreignList.status === 200) {
      assert.ok(!(foreignList.body.items as Array<{ id: string }>).some((item) => item.id === remittanceId), "la lista de B no incluye la remesa de A");
    } else {
      assert.equal(foreignList.status, 403);
    }

    const sent = await call(app, "POST", `/treasury/sepa/remittances/${remittanceId}/status`, accountantA, { status: "sent", note: "Enviada al banco" }, tenantA.propertyA);
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.status, "sent");
    assert.equal((await prisma.workerJobRun.findUniqueOrThrow({ where: { id: remittanceId } })).status, "sent");
  });
});
