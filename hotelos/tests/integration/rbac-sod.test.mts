/**
 * Tanda 8a · L2 · separación de funciones dinámica en los servicios — REAL
 * HTTP via app.inject (Postgres required). Organización AISLADA
 * `org_sod_<run>` (sociedad con NIF válido, un hotel con tipo, habitaciones,
 * plan y tarifas publicadas, plan contable PGC provisionado, roles de
 * plantilla, usuarios ficticios @faranda.test con contraseña y sesiones reales
 * por POST /auth/login; limpieza en `after`). Ni org_123 ni Faranda se
 * escriben: la suite mide las invariantes de Faranda (facturas, asientos,
 * envíos VeriFactu) antes y después y exige que no cambien.
 *
 * Escenarios (brief punto 14):
 *   · reembolso de 400 € (> T2) solicitado por recepción → pending; jefatura
 *     (T2) → 403 RBAC_LEVEL_EXCEEDED; dirección de hotel (T3) → approved;
 *     ejecución por administración (payment.refund) → 200 y
 *     PaymentRefund.requiresApproval = true; ejecución por el propio
 *     solicitante → 409 APPROVAL_MISMATCH; sin solicitud → 409 APPROVAL_REQUIRED;
 *     el administrador de plataforma sigue reembolsando directamente (auditado);
 *   · anulación de factura por su emisor → 409 RBAC_SOD_CONFLICT; por dirección
 *     con solicitud aprobada → registro de anulación (VeriFactu de Faranda intacto);
 *   · factura de proveedor de 5.000 € aprobada por dirección de hotel → 403
 *     RBAC_LEVEL_EXCEEDED, por su creador → 409, por controller → ok; pagada
 *     por su creador → 409, por controller → ok;
 *   · cierre del día por auditoría nocturna → ok; revisión por la misma persona
 *     → 409; por administración → ok; reapertura con motivo → reopened;
 *   · nómina: pay sin approve → 409 PAYROLL_NOT_APPROVED; approve por dirección
 *     general y pay por controller → ok;
 *   · reserva con 20 % de descuento por recepción → 409 APPROVAL_REQUIRED y con
 *     override por jefatura → 201; 5 % por recepción → 201 (banda T1);
 *   · Tanda CIERRE-1 (T9 deuda 17d): remesa SEPA de proveedores
 *     (POST /treasury/sepa/supplier-payments) por el registrador de la factura
 *     → 409 creator_ne_payer y nada persistido; por el controller que la
 *     aprobó → 200 con 1 acreedor (excepción controller); recepción → 403.
 *     Corrector CIERRE-1 (REV-01): con `generate: true` la remesa persistida
 *     guarda `billIds` + `sod` (controllerException) en payloadJson y se
 *     audita SEPA_REMITTANCE_GENERATED (worker_job_run) sin XML ni IBAN.
 *
 * Run: cd apps/api && node --import tsx --test ../../tests/integration/rbac-sod.test.mts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  // No .env → CI defaults below.
}
process.env.DATABASE_URL ??= "postgresql://hotelos:hotelos@localhost:5432/hotelos";
process.env.JWT_SECRET ??= "integration-test-secret-32chars-minimum-aaaa";
process.env.ENCRYPTION_KEY ??= "integration-test-enckey-32chars-min-aaaa";
process.env.HOTELOS_ALLOW_DEMO_AUTH ??= "true";
// Real grants only: the demo union would hide every SoD refusal.
process.env.HOTELOS_DEMO_PERMISSION_UNION = "false";

const { buildApiServer } = await import("../../apps/api/src/server.js");
const { prisma, hashPassword } = await import("@hotelos/database");
const { syncPermissionCatalog, provisionDefaultTemplateRoles } = await import("../../apps/api/src/lib/rbac-catalog.js");
const { provisionOrganizationChart } = await import("../../apps/api/src/modules/accounting/chart-of-accounts.service.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { resetRbacScopeCacheForTests } = await import("../../apps/api/src/lib/rbac-scope.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Headers = Record<string, string>;
type Session = { token: string; headers: Headers; userId: string };
type Body = Record<string, unknown> & { message?: string; details?: { code?: string; rule?: string; [k: string]: unknown } };

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const ORG = `org_sod_${RUN}`;
const LE = `le_sod_${RUN}`;
const A = `prop_sod_a_${RUN}`;
const PASSWORD = "Sod-Test-2026!";
const FARANDA_ORG = "cmrhw9jy30002fyvb6tsdiugt";
const LE_TAX_ID = "B76543214";
const SUPPLIER_TAX_ID = "B11223344";

const USERS = {
  rec: { id: `usr_sod_rec_${RUN}`, email: `recepcion.${RUN}@faranda.test`, fullName: "Recepción" },
  clerk: { id: `usr_sod_clerk_${RUN}`, email: `administracion.${RUN}@faranda.test`, fullName: "Administración de hotel" },
  clerkreq: { id: `usr_sod_clerkreq_${RUN}`, email: `administracion.recepcion.${RUN}@faranda.test`, fullName: "Administración + Recepción" },
  fom: { id: `usr_sod_fom_${RUN}`, email: `jefatura.recepcion.${RUN}@faranda.test`, fullName: "Jefatura de recepción" },
  dirh: { id: `usr_sod_dirh_${RUN}`, email: `direccion.hotel.${RUN}@faranda.test`, fullName: "Dirección de hotel" },
  issuer: { id: `usr_sod_issuer_${RUN}`, email: `recepcion.direccion.${RUN}@faranda.test`, fullName: "Recepción + Dirección (emite y anula)" },
  ctrl: { id: `usr_sod_ctrl_${RUN}`, email: `direccion.financiera.${RUN}@faranda.test`, fullName: "Dirección financiera" },
  clerkctrl: { id: `usr_sod_clerkctrl_${RUN}`, email: `administracion.financiera.${RUN}@faranda.test`, fullName: "Administración + Dirección financiera" },
  acc: { id: `usr_sod_acc_${RUN}`, email: `contabilidad.${RUN}@faranda.test`, fullName: "Contabilidad" },
  dg: { id: `usr_sod_dg_${RUN}`, email: `direccion.general.${RUN}@faranda.test`, fullName: "Dirección general" },
  na: { id: `usr_sod_na_${RUN}`, email: `auditoria.noche.${RUN}@faranda.test`, fullName: "Auditoría nocturna" },
  hr: { id: `usr_sod_hr_${RUN}`, email: `rrhh.${RUN}@faranda.test`, fullName: "RRHH y nóminas" }
} as const;
type UserKey = keyof typeof USERS;

const roles: Record<string, string> = {};
const sessions: Partial<Record<UserKey, Session>> = {};
let app: ApiApp;
let platform: Session | null = null;
let seeded = false;
let seedError: string | null = null;
let roomTypeId = "";
let ratePlanId = "";
let baseline: { invoices: number; entries: number; verifactu: number } | null = null;

async function farandaInvariants(): Promise<{ invoices: number; entries: number; verifactu: number }> {
  const propertyIds = (await prisma.property.findMany({ where: { organizationId: FARANDA_ORG }, select: { id: true } })).map((row) => row.id);
  const [invoices, entries, verifactu] = await Promise.all([
    prisma.invoice.count({ where: { propertyId: { in: propertyIds } } }),
    prisma.journalEntry.count({ where: { organizationId: FARANDA_ORG } }),
    prisma.verifactuSubmission.count({ where: { propertyId: { in: propertyIds } } })
  ]);
  return { invoices, entries, verifactu };
}

let loginSeq = 0;

async function login(email: string, password: string, deviceId: string): Promise<Session | null> {
  // POST /auth/login is limited to 10 per minute per IP (anti-bruteforce): each
  // fictitious user logs in from its own loopback address, like distinct PCs.
  loginSeq += 1;
  const res = await app.inject({ method: "POST", url: "/auth/login", remoteAddress: `127.0.0.${10 + loginSeq}`, payload: { email, password, deviceId } });
  if (res.statusCode !== 200) {
    console.error(`[rbac-sod test] login ${email} → ${res.statusCode}: ${res.body.slice(0, 300)}`);
    return null;
  }
  const body = JSON.parse(res.body) as { token: string; user?: { id?: string } };
  const me = await app.inject({ method: "GET", url: "/users/me", headers: { Authorization: `Bearer ${body.token}` } });
  const profile = me.statusCode === 200 ? (JSON.parse(me.body) as { id?: string; userId?: string }) : {};
  return { token: body.token, headers: { Authorization: `Bearer ${body.token}` }, userId: profile.id ?? profile.userId ?? body.user?.id ?? "" };
}

/**
 * Every request names the property it acts on (`x-property-id`, exactly what
 * the admin-web api-client sends from the active property): entity routes
 * (/payments/:id, /invoices/:id, /approvals/:id…) carry no property in the
 * path, and without the header the L1 gate resolves the keys of a user with
 * several narrow assignments as their intersection (transitional rule of
 * lib/rbac-scope.ts).
 */
async function inject(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, session: Session, payload?: unknown): Promise<{ status: number; body: Body; text: string }> {
  const res = await app.inject({ method, url, headers: { ...session.headers, "x-property-id": A }, ...(payload !== undefined ? { payload } : {}) });
  let body: Body = {};
  try {
    body = JSON.parse(res.body) as Body;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body, text: res.body };
}

const s = (key: UserKey): Session => {
  const session = sessions[key];
  assert.ok(session, `session of ${key} unavailable${seedError ? ` (${seedError})` : ""}`);
  return session;
};

async function assign(userKey: UserKey, templateKey: string, scope: { scopeType: "property" | "organization"; propertyId?: string }): Promise<void> {
  await prisma.userRoleAssignment.create({
    data: { userId: USERS[userKey].id, roleId: roles[templateKey]!, scopeType: scope.scopeType, propertyId: scope.propertyId ?? null, organizationId: ORG, reason: "seed rbac-sod test" }
  });
}

async function newReservation(code: string, status: "confirmed" | "checked_in" = "checked_in"): Promise<{ reservationId: string; folioId: string }> {
  const reservation = await prisma.reservation.create({
    data: { propertyId: A, code, channel: "direct", status, arrivalDate: new Date("2026-09-15T00:00:00Z"), departureDate: new Date("2026-09-17T00:00:00Z"), adults: 1, bookerName: `SoD ${code}`, currency: "EUR", roomTypeId, totalAmount: 200 },
    select: { id: true }
  });
  const folio = await prisma.folio.create({ data: { reservationId: reservation.id, status: "open", currency: "EUR", label: "guest", isPrimary: true }, select: { id: true } });
  return { reservationId: reservation.id, folioId: folio.id };
}

async function capture(session: Session, folioId: string, amount: number, tag: string): Promise<string> {
  const res = await inject("POST", `/folios/${folioId}/payments`, session, { amount, method: "cash", clientRequestId: `sod-${RUN}-${tag}` });
  assert.ok(res.status === 200 || res.status === 201, `capture ${tag}: ${res.text.slice(0, 300)}`);
  return String(res.body.id);
}

async function cleanup(): Promise<void> {
  const userIds = Object.values(USERS).map((user) => user.id);
  const roleIds = (await prisma.role.findMany({ where: { organizationId: ORG }, select: { id: true } })).map((row) => row.id);
  await prisma.approvalRequest.deleteMany({ where: { organizationId: ORG } });
  await prisma.supervisorAuthorization.deleteMany({ where: { organizationId: ORG } });
  const reservationIds = (await prisma.reservation.findMany({ where: { propertyId: A }, select: { id: true } })).map((r) => r.id);
  const folioIds = reservationIds.length ? (await prisma.folio.findMany({ where: { reservationId: { in: reservationIds } }, select: { id: true } })).map((f) => f.id) : [];
  const invoiceIds = (await prisma.invoice.findMany({ where: { propertyId: A }, select: { id: true } })).map((i) => i.id);
  await prisma.verifactuSubmission.deleteMany({ where: { propertyId: A } });
  if (invoiceIds.length) {
    await prisma.invoiceLine.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.vatBookEntry.deleteMany({ where: { organizationId: ORG } }).catch(() => undefined);
  }
  if (folioIds.length) {
    const paymentIds = (await prisma.payment.findMany({ where: { folioId: { in: folioIds } }, select: { id: true } })).map((p) => p.id);
    if (paymentIds.length) await prisma.paymentRefund.deleteMany({ where: { paymentId: { in: paymentIds } } });
    await prisma.paymentIntent.deleteMany({ where: { folioId: { in: folioIds } } });
    await prisma.payment.deleteMany({ where: { folioId: { in: folioIds } } });
    await prisma.folioLine.deleteMany({ where: { folioId: { in: folioIds } } });
  }
  if (invoiceIds.length) await prisma.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
  if (folioIds.length) await prisma.folio.deleteMany({ where: { id: { in: folioIds } } });
  await prisma.stay.deleteMany({ where: { reservationId: { in: reservationIds } } }).catch(() => undefined);
  await prisma.reservationGuest.deleteMany({ where: { reservationId: { in: reservationIds } } }).catch(() => undefined);
  await prisma.reservation.deleteMany({ where: { propertyId: A } });
  await prisma.guest.deleteMany({ where: { organizationId: ORG } }).catch(() => undefined);
  const bills = await prisma.supplierBill.findMany({ where: { organizationId: ORG }, select: { id: true } });
  if (bills.length) {
    await prisma.supplierBillLine.deleteMany({ where: { supplierBillId: { in: bills.map((b) => b.id) } } });
    await prisma.withholdingTaxRecord.deleteMany({ where: { organizationId: ORG } }).catch(() => undefined);
    await prisma.supplierBill.deleteMany({ where: { organizationId: ORG } });
  }
  // Remesas SEPA (worker_job_runs: organization_id sin FK a organizations, no cae en cascada).
  await prisma.workerJobRun.deleteMany({ where: { organizationId: ORG } });
  await prisma.bankAccount.deleteMany({ where: { organizationId: ORG } });
  await prisma.supplier.deleteMany({ where: { organizationId: ORG } }).catch(() => undefined);
  const periods = await prisma.payrollPeriod.findMany({ where: { organizationId: ORG }, select: { id: true } });
  if (periods.length) {
    const slips = await prisma.payrollSlip.findMany({ where: { periodId: { in: periods.map((p) => p.id) } }, select: { id: true } });
    if (slips.length) {
      await prisma.payrollLine.deleteMany({ where: { slipId: { in: slips.map((x) => x.id) } } }).catch(() => undefined);
      await prisma.payrollSlip.deleteMany({ where: { id: { in: slips.map((x) => x.id) } } });
    }
    await prisma.payrollPeriod.deleteMany({ where: { organizationId: ORG } });
  }
  await prisma.employmentContract.deleteMany({ where: { organizationId: ORG } }).catch(() => undefined);
  await prisma.staffProfile.deleteMany({ where: { propertyId: A } }).catch(() => undefined);
  const entryIds = (await prisma.journalEntry.findMany({ where: { organizationId: ORG }, select: { id: true } })).map((e) => e.id);
  if (entryIds.length) await prisma.journalLine.deleteMany({ where: { journalEntryId: { in: entryIds } } }).catch(() => undefined);
  await prisma.journalEntry.deleteMany({ where: { organizationId: ORG } }).catch(() => undefined);
  await prisma.fiscalPeriod.deleteMany({ where: { organizationId: ORG } }).catch(() => undefined);
  await prisma.fiscalYear.deleteMany({ where: { organizationId: ORG } }).catch(() => undefined);
  await prisma.account.deleteMany({ where: { organizationId: ORG } }).catch(() => undefined);
  await prisma.nightAuditRun.deleteMany({ where: { propertyId: A } });
  await prisma.businessDate.deleteMany({ where: { propertyId: A } }).catch(() => undefined);
  await prisma.cashClosure.deleteMany({ where: { propertyId: A } }).catch(() => undefined);
  await prisma.rateDay.deleteMany({ where: { propertyId: A } });
  await prisma.ratePlan.deleteMany({ where: { propertyId: A } });
  await prisma.room.deleteMany({ where: { propertyId: A } });
  await prisma.roomType.deleteMany({ where: { propertyId: A } });
  await prisma.userRoleAssignment.deleteMany({ where: { organizationId: ORG } });
  await prisma.userPropertyRole.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.mfaChallenge.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { organizationId: ORG } });
  if (roleIds.length > 0) await prisma.rolePermission.deleteMany({ where: { roleId: { in: roleIds } } });
  await prisma.roleThreshold.deleteMany({ where: { organizationId: ORG } });
  await prisma.role.deleteMany({ where: { organizationId: ORG } });
  await prisma.invoiceSequence.deleteMany({ where: { propertyId: A } }).catch(() => undefined);
  await prisma.property.deleteMany({ where: { organizationId: ORG } });
  await prisma.legalEntity.deleteMany({ where: { organizationId: ORG } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
}

before(async () => {
  app = await buildApiServer();
  await app.ready();
  try {
    baseline = await farandaInvariants();
    await syncPermissionCatalog();
    await prisma.organization.create({ data: { id: ORG, name: `[rbac-sod test] ${RUN}`, country: "ES" } });
    await prisma.legalEntity.create({ data: { id: LE, organizationId: ORG, code: "SOD", legalName: `SoD Test ${RUN} SL`, taxId: LE_TAX_ID, fiscalAddress: "Calle Real 1", fiscalPostalCode: "15001", isDefault: true } });
    await prisma.property.create({ data: { id: A, organizationId: ORG, name: `Hotel SoD ${RUN}`, timezone: "Europe/Madrid", country: "ES", taxRegion: "ES_PENINSULA_BALEARES", legalEntityId: LE, kind: "hotel" } });
    const roomType = await prisma.roomType.create({ data: { propertyId: A, name: "Doble", code: "DBL", maxOccupancy: 2, baseCapacity: 2, active: true }, select: { id: true } });
    roomTypeId = roomType.id;
    // maintenanceStatus is nullable and the availability count filters `not: "blocked"`, which excludes NULL: set it.
    for (const number of ["101", "102", "103"]) await prisma.room.create({ data: { propertyId: A, roomTypeId, number, sellable: true, maintenanceStatus: "operational" } });
    const plan = await prisma.ratePlan.create({ data: { propertyId: A, code: "BAR", name: "Tarifa base", ratePlanType: "public", active: true }, select: { id: true } });
    ratePlanId = plan.id;
    for (const day of ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]) {
      await prisma.rateDay.create({ data: { propertyId: A, ratePlanId, roomTypeId, date: new Date(`${day}T00:00:00.000Z`), price: "100.00", currency: "EUR" } });
    }
    await provisionOrganizationChart(ORG);
    for (const role of await provisionDefaultTemplateRoles(ORG)) roles[role.templateKey] = role.id;
    for (const user of Object.values(USERS)) {
      await prisma.user.create({ data: { id: user.id, organizationId: ORG, email: user.email, fullName: user.fullName, status: "active", passwordHash: hashPassword(PASSWORD), mustChangePassword: false, passwordChangedAt: new Date() } });
    }
    await assign("rec", "receptionist", { scopeType: "property", propertyId: A });
    await assign("clerk", "admin_clerk", { scopeType: "property", propertyId: A });
    await assign("clerkreq", "admin_clerk", { scopeType: "property", propertyId: A });
    await assign("clerkreq", "receptionist", { scopeType: "property", propertyId: A });
    await assign("fom", "front_office_manager", { scopeType: "property", propertyId: A });
    await assign("dirh", "manager", { scopeType: "property", propertyId: A });
    await assign("issuer", "receptionist", { scopeType: "property", propertyId: A });
    await assign("issuer", "manager", { scopeType: "property", propertyId: A });
    await assign("ctrl", "controller", { scopeType: "organization" });
    await assign("clerkctrl", "admin_clerk", { scopeType: "property", propertyId: A });
    await assign("clerkctrl", "controller", { scopeType: "organization" });
    await assign("acc", "accountant", { scopeType: "organization" });
    await assign("dg", "general_manager", { scopeType: "organization" });
    await assign("na", "night_auditor", { scopeType: "property", propertyId: A });
    // The night_auditor template never holds night_audit.review (static SoD
    // pair): to exercise the DYNAMIC rule «quien corre ≠ quien revisa» the
    // runner also gets the admin_clerk template (seeded directly, the
    // assignment route would refuse the pair) and still gets 409 on its own run.
    await assign("na", "admin_clerk", { scopeType: "property", propertyId: A });
    await assign("hr", "payroll_hr", { scopeType: "organization" });
    resetRbacScopeCacheForTests();
    for (const key of Object.keys(USERS) as UserKey[]) {
      const session = await login(USERS[key].email, PASSWORD, `integration-sod-${key}`);
      if (!session) throw new Error(`login failed for ${key}`);
      sessions[key] = session;
    }
    platform = await login(process.env.INTEGRATION_LOGIN_EMAIL ?? "reception@example.com", process.env.INTEGRATION_LOGIN_PASSWORD ?? "hotelos-demo", "integration-sod-platform");
    seeded = true;
  } catch (error) {
    seedError = error instanceof Error ? error.message : String(error);
    console.error(`[rbac-sod test] seeding the isolated organisation failed: ${seedError}`);
  }
});

after(async () => {
  try {
    await flushAuditQueues();
    await cleanup();
  } finally {
    await app.close();
    await prisma.$disconnect();
  }
});

describe("Tanda 8a · L2 · reembolso: solicita ≠ aprueba ≠ ejecuta (org_sod aislada)", () => {
  let paymentId = "";
  let requestId = "";

  it("recepción captura 400 € (capturedByUserId) y administración no puede reembolsar sin solicitud → 409 APPROVAL_REQUIRED", async () => {
    assert.ok(seeded, seedError ?? "seed failed");
    const { folioId } = await newReservation(`SOD-${RUN}-R1`);
    paymentId = await capture(s("rec"), folioId, 400, "r1");
    const row = await prisma.payment.findUnique({ where: { id: paymentId }, select: { capturedByUserId: true } });
    assert.equal(row?.capturedByUserId, USERS.rec.id);
    const refused = await inject("POST", `/payments/${paymentId}/refund`, s("clerk"), { reason: "sin solicitud", amount: 400 });
    assert.equal(refused.status, 409, refused.text.slice(0, 300));
    assert.equal(refused.body.details?.code, "APPROVAL_REQUIRED");
  });

  it("solicitud por recepción → pending (T3); jefatura (T2) → 403 RBAC_LEVEL_EXCEEDED; dirección de hotel → approved", async () => {
    const request = await inject("POST", `/payments/${paymentId}/refund-requests`, s("rec"), { reasonCode: "guest_complaint", reasonText: "Reclamación de la estancia" });
    assert.equal(request.status, 201, request.text.slice(0, 300));
    assert.equal(request.body.status, "pending", request.text.slice(0, 300));
    assert.equal(request.body.thresholdTier, "T3", request.text.slice(0, 300));
    assert.equal(Number(request.body.amount), 400, request.text.slice(0, 300));
    requestId = String(request.body.id);
    // 400 € exceeds T2 (300 € by default): the front-office manager cannot approve it (design §4.7; L1 engine).
    const tooLow = await inject("POST", `/approvals/${requestId}/approve`, s("fom"), {});
    assert.equal(tooLow.status, 403, tooLow.text.slice(0, 300));
    assert.equal(tooLow.body.details?.code, "RBAC_LEVEL_EXCEEDED");
    const self = await inject("POST", `/approvals/${requestId}/approve`, s("rec"), {});
    assert.ok(self.status === 403 || self.status === 409, self.text.slice(0, 300));
    const approved = await inject("POST", `/approvals/${requestId}/approve`, s("dirh"), {});
    assert.equal(approved.status, 200, approved.text.slice(0, 300));
    assert.equal(approved.body.status, "approved");
  });

  it("ejecución por administración (payment.refund) → 200, PaymentRefund.requiresApproval = true y approvedBy = dirección; el solicitante no ejecuta (403: sin payment.refund)", async () => {
    const bySelf = await inject("POST", `/payments/${paymentId}/refund`, s("rec"), { reason: "yo mismo", amount: 400 });
    assert.equal(bySelf.status, 403, bySelf.text.slice(0, 300));
    const executed = await inject("POST", `/payments/${paymentId}/refund`, s("clerk"), { reason: "Reclamación aprobada", amount: 400, clientRequestId: `sod-${RUN}-refund-r1` });
    assert.equal(executed.status, 200, executed.text.slice(0, 400));
    const refunds = await prisma.paymentRefund.findMany({ where: { paymentId } });
    assert.equal(refunds.length, 1);
    assert.equal(refunds[0]!.requiresApproval, true);
    assert.equal(refunds[0]!.approvedBy, USERS.dirh.id);
    const consumed = await prisma.approvalRequest.findUnique({ where: { id: requestId }, select: { consumedByUserId: true, status: true } });
    assert.equal(consumed?.status, "approved");
    assert.equal(consumed?.consumedByUserId, USERS.clerk.id);
    await flushAuditQueues();
    const audit = await prisma.auditEvent.findFirst({ where: { action: "PAYMENT_REFUNDED", entityId: paymentId }, orderBy: { createdAt: "desc" } });
    const authorization = (audit?.afterJson as { authorization?: { mode?: string; approvedBy?: string } } | null)?.authorization;
    assert.equal(authorization?.mode, "approved");
    assert.equal(authorization?.approvedBy, USERS.dirh.id);
  });

  it("solicitante = ejecutor (administración con clave de solicitud) → 409 APPROVAL_MISMATCH; importe mayor que el aprobado → 409", async () => {
    const { folioId } = await newReservation(`SOD-${RUN}-R2`);
    const payment2 = await capture(s("rec"), folioId, 100, "r2");
    const request = await inject("POST", `/payments/${payment2}/refund-requests`, s("clerkreq"), { reasonCode: "duplicate_charge" });
    assert.equal(request.status, 201, request.text.slice(0, 300));
    const approved = await inject("POST", `/approvals/${request.body.id}/approve`, s("fom"), {});
    assert.equal(approved.status, 200, approved.text.slice(0, 300));
    const same = await inject("POST", `/payments/${payment2}/refund`, s("clerkreq"), { reason: "mismo solicitante", amount: 100 });
    assert.equal(same.status, 409, same.text.slice(0, 300));
    assert.equal(same.body.details?.code, "APPROVAL_MISMATCH");
    const bigger = await inject("POST", `/payments/${payment2}/refund`, s("clerk"), { reason: "más de lo aprobado", amount: 100.5 });
    assert.ok(bigger.status === 409 || bigger.status === 400, bigger.text.slice(0, 300));
  });

  it("el administrador de plataforma (reception@example.com) sigue reembolsando directamente: aprobación implícita auditada", async (t) => {
    if (!platform) return t.skip("platform-admin session unavailable (INTEGRATION_LOGIN_EMAIL / _PASSWORD)");
    const { folioId } = await newReservation(`SOD-${RUN}-R3`);
    const payment3 = await capture(s("rec"), folioId, 50, "r3");
    const refunded = await inject("POST", `/payments/${payment3}/refund`, platform, { reason: "plataforma", amount: 50, clientRequestId: `sod-${RUN}-refund-r3` });
    assert.equal(refunded.status, 200, refunded.text.slice(0, 400));
    const refund = await prisma.paymentRefund.findFirst({ where: { paymentId: payment3 } });
    assert.equal(refund?.requiresApproval, true);
    await flushAuditQueues();
    const audit = await prisma.auditEvent.findFirst({ where: { action: "PAYMENT_REFUNDED", entityId: payment3 } });
    const authorization = (audit?.afterJson as { authorization?: { mode?: string } } | null)?.authorization;
    assert.ok(authorization?.mode === "privileged" || authorization?.mode === "implicit", `mode ${authorization?.mode}`);
  });
});

describe("Tanda 8a · L2 · anulación de factura: emisor ≠ anulador, solicitud aprobada, VeriFactu intacto", () => {
  async function issuedInvoice(session: Session, tag: string): Promise<{ id: string; ok: boolean; text: string }> {
    const { folioId } = await newReservation(`SOD-${RUN}-${tag}`);
    const line = await inject("POST", `/folios/${folioId}/lines`, session, { type: "room", description: "Alojamiento", quantity: 1, unitPrice: 100 });
    if (line.status !== 200 && line.status !== 201) return { id: "", ok: false, text: line.text };
    const draft = await inject("POST", `/folios/${folioId}/invoice`, session, { customerType: "guest", customerName: `Huésped ${tag}` });
    if (draft.status !== 200 && draft.status !== 201) return { id: "", ok: false, text: draft.text };
    const issued = await inject("POST", `/invoices/${draft.body.id}/issue`, session, {});
    return { id: String(draft.body.id), ok: issued.status === 200 || issued.status === 201, text: issued.text };
  }

  it("emitida por recepción, anulada por dirección de hotel (invoice.cancel + cancel_approve, T3): registro de anulación con cancelledByUserId", async (t) => {
    assert.ok(seeded, seedError ?? "seed failed");
    const invoice = await issuedInvoice(s("rec"), "I1");
    if (!invoice.ok) return t.skip(`issuing in the isolated organisation is not possible here: ${invoice.text.slice(0, 200)}`);
    const row = await prisma.invoice.findUnique({ where: { id: invoice.id }, select: { issuedByUserId: true, status: true } });
    assert.equal(row?.status, "issued");
    assert.equal(row?.issuedByUserId, USERS.rec.id);
    const byRec = await inject("POST", `/invoices/${invoice.id}/cancel`, s("rec"), { reason: "recepción no anula" });
    assert.equal(byRec.status, 403, byRec.text.slice(0, 300));
    const cancelled = await inject("POST", `/invoices/${invoice.id}/cancel`, s("dirh"), { reason: "Error en los datos" });
    assert.equal(cancelled.status, 200, cancelled.text.slice(0, 400));
    const after = await prisma.invoice.findUnique({ where: { id: invoice.id }, select: { status: true, cancelledByUserId: true, cancellationHash: true } });
    assert.equal(after?.status, "cancelled");
    assert.equal(after?.cancelledByUserId, USERS.dirh.id);
  });

  it("anulación por su propio emisor → 409 RBAC_SOD_CONFLICT issuer_ne_canceller", async (t) => {
    const invoice = await issuedInvoice(s("issuer"), "I2");
    if (!invoice.ok) return t.skip(`issuing in the isolated organisation is not possible here: ${invoice.text.slice(0, 200)}`);
    const self = await inject("POST", `/invoices/${invoice.id}/cancel`, s("issuer"), { reason: "yo la emití" });
    assert.equal(self.status, 409, self.text.slice(0, 300));
    assert.equal(self.body.details?.code, "RBAC_SOD_CONFLICT");
    assert.equal(self.body.details?.rule, "issuer_ne_canceller");
    const still = await prisma.invoice.findUnique({ where: { id: invoice.id }, select: { status: true } });
    assert.equal(still?.status, "issued");
  });

  it("solicitud de anulación por recepción (invoice.cancel_request) aprobada por dirección financiera y ejecutada por dirección de hotel → registro de anulación", async (t) => {
    const invoice = await issuedInvoice(s("rec"), "I3");
    if (!invoice.ok) return t.skip(`issuing in the isolated organisation is not possible here: ${invoice.text.slice(0, 200)}`);
    const request = await inject("POST", `/invoices/${invoice.id}/cancel-request`, s("rec"), { reasonCode: "data_error", reasonText: "NIF erróneo" });
    assert.equal(request.status, 201, request.text.slice(0, 300));
    assert.equal(request.body.kind, "invoice_cancel");
    const approved = await inject("POST", `/approvals/${request.body.id}/approve`, s("ctrl"), {});
    assert.equal(approved.status, 200, approved.text.slice(0, 300));
    const cancelled = await inject("POST", `/invoices/${invoice.id}/cancel`, s("dirh"), { reason: "Anulación aprobada" });
    assert.equal(cancelled.status, 200, cancelled.text.slice(0, 400));
    await flushAuditQueues();
    const audit = await prisma.auditEvent.findFirst({ where: { action: "INVOICE_CANCELLED", entityId: invoice.id } });
    const authorization = (audit?.afterJson as { authorization?: { mode?: string; requestId?: string } } | null)?.authorization;
    assert.equal(authorization?.mode, "approved");
    assert.equal(authorization?.requestId, request.body.id);
  });
});

describe("Tanda 8a · L2 · factura de proveedor de 5.000 €: registrar ≠ aprobar (por importe) ≠ pagar", () => {
  let billId = "";

  it("registrada por administración (payables.create, createdByUserId); aprobación por dirección de hotel → 403 RBAC_LEVEL_EXCEEDED; por su creador → 409; por controller → ok", async () => {
    assert.ok(seeded, seedError ?? "seed failed");
    const created = await inject("POST", `/properties/${A}/payables/supplier-bills`, s("clerkctrl"), {
      supplierName: "Proveedor SoD SL",
      supplierTaxId: SUPPLIER_TAX_ID,
      invoiceNumber: `SOD-${RUN}-F1`,
      issueDate: "2026-09-10",
      lines: [{ description: "Mantenimiento anual", expenseAccountCode: "622", base: 5000, taxRate: 21 }]
    });
    assert.ok(created.status === 200 || created.status === 201, created.text.slice(0, 400));
    billId = String(created.body.id);
    const row = await prisma.supplierBill.findUnique({ where: { id: billId }, select: { createdByUserId: true, total: true } });
    assert.equal(row?.createdByUserId, USERS.clerkctrl.id);
    const byRec = await inject("POST", `/properties/${A}/payables/supplier-bills/${billId}/approve`, s("rec"), {});
    assert.equal(byRec.status, 403, byRec.text.slice(0, 300));
    const byDirh = await inject("POST", `/properties/${A}/payables/supplier-bills/${billId}/approve`, s("dirh"), {});
    assert.equal(byDirh.status, 403, byDirh.text.slice(0, 300));
    assert.equal(byDirh.body.details?.code, "RBAC_LEVEL_EXCEEDED");
    const byCreator = await inject("POST", `/properties/${A}/payables/supplier-bills/${billId}/approve`, s("clerkctrl"), {});
    assert.equal(byCreator.status, 409, byCreator.text.slice(0, 300));
    assert.equal(byCreator.body.details?.rule, "creator_ne_approver");
    const byCtrl = await inject("POST", `/properties/${A}/payables/supplier-bills/${billId}/approve`, s("ctrl"), {});
    assert.equal(byCtrl.status, 200, byCtrl.text.slice(0, 300));
    assert.equal(byCtrl.body.status, "approved");
  });

  it("contabilizada por contabilidad; pagada por su creador → 409 creator_ne_payer; por controller (aprobó: excepción auditada) → ok", async (t) => {
    const posted = await inject("POST", `/properties/${A}/payables/supplier-bills/${billId}/post`, s("acc"), {});
    if (posted.status !== 200) return t.skip(`posting in the isolated organisation is not possible here: ${posted.text.slice(0, 200)}`);
    const byCreator = await inject("POST", `/properties/${A}/payables/supplier-bills/${billId}/pay`, s("clerkctrl"), { paymentDate: "2026-09-18" });
    assert.equal(byCreator.status, 409, byCreator.text.slice(0, 300));
    assert.equal(byCreator.body.details?.rule, "creator_ne_payer");
    const byRec = await inject("POST", `/properties/${A}/payables/supplier-bills/${billId}/pay`, s("rec"), { paymentDate: "2026-09-18" });
    assert.equal(byRec.status, 403, byRec.text.slice(0, 300));
    const byCtrl = await inject("POST", `/properties/${A}/payables/supplier-bills/${billId}/pay`, s("ctrl"), { paymentDate: "2026-09-18" });
    assert.equal(byCtrl.status, 200, byCtrl.text.slice(0, 400));
    assert.equal(byCtrl.body.status, "paid");
  });
});

describe("Tanda CIERRE-1 · remesa SEPA de proveedores (POST /treasury/sepa/supplier-payments): registrador ≠ pagador, aprobador ≠ pagador salvo controller", () => {
  // T9 deuda 17d: the remittance runs `assertSupplierBillPaymentAuthorized` per
  // bill (the gate of …/supplier-bills/:id/pay), fail-closed for the whole
  // remittance. Without `generate` nothing is persisted either way.
  const bankAccountId = `bank_sod_${RUN}`;
  const supplierId = `sup_sod_${RUN}`;
  const IBAN = "ES9121000418450200051332";
  let billId2 = "";
  let billTotal = 0;
  const remittance = (session: Session) => inject("POST", "/treasury/sepa/supplier-payments", session, { propertyId: A, bankAccountId, billIds: [billId2], executionDate: "2026-09-30" });

  it("por su registrador (clerkctrl, con payables.pay) → 409 RBAC_SOD_CONFLICT rule creator_ne_payer y nada persistido", async () => {
    assert.ok(seeded, seedError ?? "seed failed");
    await prisma.bankAccount.create({
      data: { id: bankAccountId, propertyId: A, organizationId: ORG, legalEntityId: LE, name: "Cuenta SoD", iban: IBAN, currencyCode: "EUR", ledgerAccountCode: "572" }
    });
    // The bills above name their supplier by NIF only (`supplierId` null), which no remittance can pay: F2 hangs from a Supplier row with IBAN.
    await prisma.supplier.create({ data: { id: supplierId, organizationId: ORG, name: "Proveedor SoD SL", taxId: SUPPLIER_TAX_ID, countryCode: "ES", iban: IBAN } });
    const created = await inject("POST", `/properties/${A}/payables/supplier-bills`, s("clerkctrl"), {
      supplierId,
      supplierName: "Proveedor SoD SL",
      supplierTaxId: SUPPLIER_TAX_ID,
      invoiceNumber: `SOD-${RUN}-F2`,
      issueDate: "2026-09-10",
      lines: [{ description: "Mantenimiento anual", expenseAccountCode: "622", base: 5000, taxRate: 21 }]
    });
    assert.ok(created.status === 200 || created.status === 201, created.text.slice(0, 400));
    billId2 = String(created.body.id);
    const approved = await inject("POST", `/properties/${A}/payables/supplier-bills/${billId2}/approve`, s("ctrl"), {});
    assert.equal(approved.status, 200, approved.text.slice(0, 300));
    const posted = await inject("POST", `/properties/${A}/payables/supplier-bills/${billId2}/post`, s("acc"), {});
    assert.equal(posted.status, 200, posted.text.slice(0, 400));
    const row = await prisma.supplierBill.findUnique({ where: { id: billId2 }, select: { createdByUserId: true, approvedBy: true, status: true, supplierId: true, total: true } });
    assert.equal(row?.createdByUserId, USERS.clerkctrl.id);
    assert.equal(row?.approvedBy, USERS.ctrl.id);
    assert.equal(row?.status, "posted");
    assert.equal(row?.supplierId, supplierId);
    billTotal = Number(row?.total);
    const refused = await remittance(s("clerkctrl"));
    assert.equal(refused.status, 409, refused.text.slice(0, 400));
    assert.equal(refused.body.details?.code, "RBAC_SOD_CONFLICT");
    assert.equal(refused.body.details?.rule, "creator_ne_payer");
    assert.equal(refused.body.details?.authorUserId, USERS.clerkctrl.id);
    assert.equal(refused.body.details?.billId, billId2);
    const still = await prisma.supplierBill.findUnique({ where: { id: billId2 }, select: { status: true, paymentDate: true } });
    assert.equal(still?.status, "posted");
    assert.equal(still?.paymentDate, null);
    assert.equal(await prisma.workerJobRun.count({ where: { organizationId: ORG } }), 0, "no remittance persisted");
  });

  it("por el controller que la aprobó → 200 con 1 acreedor y totalAmount de la factura (excepción controller)", async () => {
    const built = await remittance(s("ctrl"));
    assert.equal(built.status, 200, built.text.slice(0, 400));
    const body = built.body as unknown as {
      body?: { debtor?: { taxId?: string; iban?: string }; creditors?: Array<{ iban?: string; amount?: string; endToEndId?: string }> };
      skipped?: unknown[];
      totalAmount?: string;
    };
    assert.deepEqual(body.skipped, []);
    assert.equal(body.body?.creditors?.length, 1);
    assert.equal(body.body?.creditors?.[0]?.iban, IBAN);
    assert.equal(body.body?.creditors?.[0]?.amount, "6050.00");
    assert.equal(body.body?.creditors?.[0]?.endToEndId, `SB-${billId2}`.slice(0, 35));
    assert.equal(body.body?.debtor?.taxId, LE_TAX_ID);
    assert.equal(body.body?.debtor?.iban, IBAN);
    assert.equal(body.totalAmount, "6050.00");
    assert.equal(Number(body.totalAmount), billTotal);
    // Built only (no `generate`): the bill stays posted and unpaid, nothing persisted.
    const still = await prisma.supplierBill.findUnique({ where: { id: billId2 }, select: { status: true, paymentDate: true } });
    assert.equal(still?.status, "posted");
    assert.equal(still?.paymentDate, null);
    assert.equal(await prisma.workerJobRun.count({ where: { organizationId: ORG } }), 0);
  });

  it("recepción sin payables.pay → 403", async () => {
    const byRec = await remittance(s("rec"));
    assert.equal(byRec.status, 403, byRec.text.slice(0, 300));
    assert.equal(await prisma.workerJobRun.count({ where: { organizationId: ORG } }), 0);
  });

  it("corrector CIERRE-1 (REV-01) · controller con generate: true → 200; la remesa persistida guarda billIds + sod (controllerException) y se audita SEPA_REMITTANCE_GENERATED sin XML ni IBAN", async () => {
    const generated = await inject("POST", "/treasury/sepa/supplier-payments", s("ctrl"), { propertyId: A, bankAccountId, billIds: [billId2], executionDate: "2026-09-30", generate: true });
    assert.equal(generated.status, 200, generated.text.slice(0, 400));
    const body = generated.body as unknown as {
      billIds?: string[];
      sod?: Array<{ billId?: string; controllerException?: boolean; approver?: unknown; creator?: { rule?: string; authorUserId?: string | null; authorUnknown?: boolean; privileged?: string | null } }>;
      remittance?: { id?: string; status?: string; kind?: string; totalAmount?: string };
    };
    assert.deepEqual(body.billIds, [billId2]);
    assert.equal(body.sod?.length, 1);
    assert.equal(body.sod?.[0]?.billId, billId2);
    assert.equal(body.sod?.[0]?.controllerException, true, "the controller who approved pays through the audited exception");
    assert.equal(body.sod?.[0]?.approver, null);
    assert.deepEqual(body.sod?.[0]?.creator, { rule: "creator_ne_payer", authorUserId: USERS.clerkctrl.id, authorUnknown: false, privileged: null });
    const remittanceId = String(body.remittance?.id);
    assert.equal(body.remittance?.status, "generated");
    assert.equal(body.remittance?.kind, "norma34");
    assert.equal(body.remittance?.totalAmount, "6050.00");
    // Persisted payload: the bills paid and their SoD outcomes travel with the remittance (before REV-01 the ids only survived inside the XML as endToEndId).
    const rows = await prisma.workerJobRun.findMany({ where: { organizationId: ORG } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.id, remittanceId);
    const payload = rows[0]!.payloadJson as { billIds?: string[]; sod?: Array<{ billId?: string; controllerException?: boolean }> };
    assert.deepEqual(payload.billIds, [billId2]);
    assert.equal(payload.sod?.[0]?.billId, billId2);
    assert.equal(payload.sod?.[0]?.controllerException, true);
    // Audit row of the generation: control data + SoD, never the XML nor the IBAN.
    await flushAuditQueues();
    const audit = await prisma.auditEvent.findFirst({ where: { action: "SEPA_REMITTANCE_GENERATED", entityId: remittanceId } });
    assert.ok(audit, "SEPA_REMITTANCE_GENERATED audited");
    assert.equal(audit.organizationId, ORG);
    assert.equal(audit.propertyId, A);
    assert.equal(audit.actorUserId, USERS.ctrl.id);
    assert.equal(audit.entityType, "worker_job_run");
    const after = audit.afterJson as { kind?: string; totalAmount?: string; transactions?: number; bankAccountId?: string; billIds?: string[]; sod?: Array<{ billId?: string; controllerException?: boolean; creator?: { privileged?: string | null } }> };
    assert.equal(after.kind, "norma34");
    assert.equal(after.totalAmount, "6050.00");
    assert.equal(after.transactions, 1);
    assert.equal(after.bankAccountId, bankAccountId);
    assert.deepEqual(after.billIds, [billId2]);
    assert.equal(after.sod?.[0]?.billId, billId2);
    assert.equal(after.sod?.[0]?.controllerException, true);
    assert.equal(after.sod?.[0]?.creator?.privileged, null);
    const serialised = JSON.stringify(audit.afterJson);
    assert.ok(!serialised.includes(IBAN), "the audit never carries the IBAN");
    assert.ok(!serialised.includes("<?xml"), "the audit never carries the XML");
    // Generating the file does not pay the bill (the payment is posted when the bank confirms).
    const still = await prisma.supplierBill.findUnique({ where: { id: billId2 }, select: { status: true, paymentDate: true } });
    assert.equal(still?.status, "posted");
    assert.equal(still?.paymentDate, null);
  });

  it("corrector CIERRE-1 (REV-02 / FUN-02 · FUN-07) · el cuerpo devuelto por supplier-payments reenviado a POST /treasury/sepa/remittances → 403 SUPPLIER_PAYMENT_ROUTE_REQUIRED (contabilidad y controller) sin fila nueva; banking.read ve billIds + sod en detalle y lista", async () => {
    const built = await remittance(s("ctrl"));
    assert.equal(built.status, 200, built.text.slice(0, 400));
    const body = (built.body as { body?: unknown }).body;
    assert.ok(body && typeof body === "object", "the built Norma 34 body");
    const before = await prisma.workerJobRun.count({ where: { organizationId: ORG } });
    assert.equal(before, 1, "only the remittance generated by the previous case");
    // REV-02 as confirmed in runtime (FUN-02): contabilidad (banking.reconcile, no payables.pay) replays the built body
    // through the generic route — before, it persisted a supplier payment without the gate.
    const replay = await inject("POST", "/treasury/sepa/remittances", s("acc"), { kind: "norma34", propertyId: A, bankAccountId, body });
    assert.equal(replay.status, 403, replay.text.slice(0, 300));
    assert.equal(replay.body.details?.code, "SUPPLIER_PAYMENT_ROUTE_REQUIRED", replay.text.slice(0, 300));
    assert.equal(replay.body.details?.route, "POST /treasury/sepa/supplier-payments");
    assert.equal(replay.body.details?.requiredPermission, "payables.pay");
    // The controller (payables.pay, never banking.reconcile: static SoD pair) does not even reach the service on the generic route.
    const byCtrl = await inject("POST", "/treasury/sepa/remittances", s("ctrl"), { kind: "norma34", propertyId: A, bankAccountId, body });
    assert.equal(byCtrl.status, 403, byCtrl.text.slice(0, 300));
    assert.match(String(byCtrl.body.message), /banking\.reconcile/, byCtrl.text.slice(0, 300));
    assert.equal(await prisma.workerJobRun.count({ where: { organizationId: ORG } }), before, "the generic route persisted nothing");
    await flushAuditQueues();
    assert.equal(await prisma.auditEvent.count({ where: { organizationId: ORG, action: "SEPA_REMITTANCE_GENERATED" } }), 1, "no generation audited for the refused replays");
    // FUN-07: the provenance persisted by REV-01 reaches the DTO of banking.read (before, only audit.read saw it).
    const generated = await prisma.workerJobRun.findFirst({ where: { organizationId: ORG }, select: { id: true } });
    assert.ok(generated);
    const detail = await inject("GET", `/treasury/sepa/remittances/${generated.id}`, s("acc"));
    assert.equal(detail.status, 200, detail.text.slice(0, 300));
    assert.deepEqual(detail.body.billIds, [billId2]);
    const sod = detail.body.sod as Array<{ billId?: string; controllerException?: boolean; approver?: unknown; creator?: { rule?: string } }> | undefined;
    assert.equal(sod?.length, 1);
    assert.equal(sod?.[0]?.billId, billId2);
    assert.equal(sod?.[0]?.controllerException, true);
    assert.equal(sod?.[0]?.creator?.rule, "creator_ne_payer");
    const list = await inject("GET", `/treasury/sepa/remittances?propertyId=${A}`, s("acc"));
    assert.equal(list.status, 200, list.text.slice(0, 300));
    const item = (list.body.items as Array<{ id: string; billIds?: string[]; sod?: unknown[]; xml?: string }>).find((row) => row.id === generated.id);
    assert.ok(item, "the generated remittance is listed");
    assert.deepEqual(item.billIds, [billId2]);
    assert.equal(item.sod?.length, 1);
    assert.equal(item.xml, undefined, "the list never carries the XML");
  });
});

describe("Tanda 8a · L2 · cierre del día: corre ≠ revisa; reapertura con motivo", () => {
  let runId = "";

  it("auditoría nocturna corre el cierre (night_audit.run) → completed; recepción → 403", async () => {
    assert.ok(seeded, seedError ?? "seed failed");
    const byRec = await inject("POST", `/properties/${A}/night-audit/run`, s("rec"), {});
    assert.equal(byRec.status, 403, byRec.text.slice(0, 300));
    // Tanda L5 (L5-D): the preflight is a gate. The fixtures of this suite are
    // in-house stays (2026-09-15 → 2026-09-17) past their departure, so the
    // plain close is a 409 NIGHT_AUDIT_PREFLIGHT_BLOCKED and the auditor
    // forces it with a reason (audited NIGHT_AUDIT_PREFLIGHT_OVERRIDDEN).
    const blocked = await inject("POST", `/properties/${A}/night-audit/run`, s("na"), {});
    assert.equal(blocked.status, 409, blocked.text.slice(0, 400));
    assert.equal(blocked.body.details?.code, "NIGHT_AUDIT_PREFLIGHT_BLOCKED");
    const run = await inject("POST", `/properties/${A}/night-audit/run`, s("na"), { force: true, reasonText: "prueba de integración: estancias de la fixture con salida pasada" });
    assert.equal(run.status, 200, run.text.slice(0, 400));
    assert.equal(run.body.status, "completed");
    assert.equal(run.body.startedBy, USERS.na.id);
    assert.ok((run.body.report as { preflightOverride?: { reasonText?: string } } | null)?.preflightOverride?.reasonText, "the forced close carries the override in its report");
    runId = String(run.body.id);
  });

  it("revisión por la misma persona → 409 runner_ne_reviewer; por administración de hotel → reviewed; reapertura por dirección con motivo → reopened (nada se revierte)", async () => {
    const self = await inject("POST", `/properties/${A}/night-audit/runs/${runId}/review`, s("na"), { note: "yo mismo" });
    assert.equal(self.status, 409, self.text.slice(0, 300));
    assert.equal(self.body.details?.rule, "runner_ne_reviewer");
    const reviewed = await inject("POST", `/properties/${A}/night-audit/runs/${runId}/review`, s("clerk"), { note: "Income audit ok" });
    assert.equal(reviewed.status, 200, reviewed.text.slice(0, 300));
    assert.equal(reviewed.body.reviewedByUserId, USERS.clerk.id);
    const again = await inject("POST", `/properties/${A}/night-audit/runs/${runId}/review`, s("clerk"), {});
    assert.equal(again.status, 409);
    const badReason = await inject("POST", `/properties/${A}/night-audit/runs/${runId}/reopen`, s("dirh"), { reasonCode: "invented" });
    assert.equal(badReason.status, 400, badReason.text.slice(0, 300));
    const entriesBefore = await prisma.journalEntry.count({ where: { organizationId: ORG } });
    const reopened = await inject("POST", `/properties/${A}/night-audit/runs/${runId}/reopen`, s("dirh"), { reasonCode: "missing_charge", reasonText: "Cargo del minibar sin contabilizar" });
    assert.equal(reopened.status, 200, reopened.text.slice(0, 400));
    assert.equal(reopened.body.status, "reopened");
    assert.equal(reopened.body.reopenedByUserId, USERS.dirh.id);
    assert.equal(reopened.body.reopenReasonCode, "missing_charge");
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG } }), entriesBefore, "reopening never reverses entries");
    const byRec = await inject("POST", `/properties/${A}/night-audit/runs/${runId}/reopen`, s("rec"), { reasonCode: "other" });
    assert.equal(byRec.status, 403, byRec.text.slice(0, 300));
  });
});

describe("Tanda 8a · L2 · nómina: RRHH prepara, dirección general aprueba, dirección financiera paga", () => {
  let periodId = "";

  it("periodo y cálculo por RRHH (payroll.manage); pay sin approve → 409 PAYROLL_NOT_APPROVED", async (t) => {
    assert.ok(seeded, seedError ?? "seed failed");
    const profile = await prisma.staffProfile.create({ data: { userId: USERS.rec.id, propertyId: A, employeeCode: `SOD-${RUN}` }, select: { id: true } });
    await prisma.employmentContract.create({
      data: { staffProfileId: profile.id, propertyId: A, organizationId: ORG, contractType: "indefinido", startDate: new Date("2026-01-01T00:00:00Z"), grossSalary: "2000.00", payFrequency: "monthly", payCount: 12, irpfRatePct: "15.00" }
    });
    const created = await inject("POST", "/payroll/periods", s("hr"), { propertyId: A, periodCode: "2026-08" });
    assert.ok(created.status === 200 || created.status === 201, created.text.slice(0, 300));
    periodId = String(created.body.id);
    const calculated = await inject("POST", `/payroll/periods/${periodId}/calculate`, s("hr"), {});
    if (calculated.status !== 200) return t.skip(`calculating in the isolated organisation is not possible here: ${calculated.text.slice(0, 200)}`);
    const row = await prisma.payrollPeriod.findUnique({ where: { id: periodId }, select: { calculatedByUserId: true, status: true } });
    assert.equal(row?.calculatedByUserId, USERS.hr.id);
    const unapproved = await inject("POST", `/payroll/periods/${periodId}/pay`, s("ctrl"), { paidAt: "2026-09-05" });
    assert.equal(unapproved.status, 409, unapproved.text.slice(0, 300));
    assert.equal(unapproved.body.details?.code, "PAYROLL_NOT_APPROVED");
  });

  it("approve por RRHH → 403; por dirección general → approved; pay por dirección general → 403 (sin payables.pay); por controller → paid", async (t) => {
    const period = await prisma.payrollPeriod.findUnique({ where: { id: periodId }, select: { journalEntryIds: true } });
    if (!period || period.journalEntryIds.length === 0) return t.skip("the period has no entries (calculation skipped above)");
    const byHr = await inject("POST", `/payroll/periods/${periodId}/approve`, s("hr"), {});
    assert.equal(byHr.status, 403, byHr.text.slice(0, 300));
    const approved = await inject("POST", `/payroll/periods/${periodId}/approve`, s("dg"), { note: "Registro de agosto" });
    assert.equal(approved.status, 200, approved.text.slice(0, 300));
    assert.equal(approved.body.status, "approved");
    assert.equal(approved.body.approvedByUserId, USERS.dg.id);
    const byDg = await inject("POST", `/payroll/periods/${periodId}/pay`, s("dg"), { paidAt: "2026-09-05" });
    assert.equal(byDg.status, 403, byDg.text.slice(0, 300));
    const paid = await inject("POST", `/payroll/periods/${periodId}/pay`, s("ctrl"), { paidAt: "2026-09-05" });
    assert.equal(paid.status, 200, paid.text.slice(0, 400));
    assert.ok(paid.body.paidAt, "paidAt set");
  });
});

describe("Tanda 8a · L2 · descuento en reserva: recepción ≤ 10 %, jefatura hasta 25 %", () => {
  const stay = { arrivalDate: "2026-10-01", departureDate: "2026-10-03", adults: 1 };

  it("20 % por recepción → 409 APPROVAL_REQUIRED; 5 % por recepción → 201 (banda T1); 20 % por jefatura (override) → 201 con auditoría", async () => {
    assert.ok(seeded, seedError ?? "seed failed");
    // Published quote: 2 nights × 100 € = 200 €.
    const refused = await inject("POST", `/properties/${A}/reservations`, s("rec"), { ...stay, roomTypeId, ratePlanId, totalAmount: 160, bookerName: "Descuento 20" });
    assert.equal(refused.status, 409, refused.text.slice(0, 400));
    assert.equal(refused.body.details?.code, "APPROVAL_REQUIRED");
    assert.equal(refused.body.details?.kind, "discount");
    // The reservation route answers 200 on creation (server.ts returns the record without reply.code(201)).
    const created = (status: number) => status === 200 || status === 201;
    const small = await inject("POST", `/properties/${A}/reservations`, s("rec"), { ...stay, roomTypeId, ratePlanId, totalAmount: 190, bookerName: "Descuento 5" });
    assert.ok(created(small.status), small.text.slice(0, 400));
    const override = await inject("POST", `/properties/${A}/reservations`, s("fom"), { ...stay, roomTypeId, ratePlanId, totalAmount: 160, bookerName: "Descuento 20 jefatura" });
    assert.ok(created(override.status), override.text.slice(0, 400));
    await flushAuditQueues();
    const audit = await prisma.auditEvent.findFirst({ where: { action: "RESERVATION_CREATED", entityId: String(override.body.id) } });
    const discount = (audit?.afterJson as { discount?: { band?: string; discountPct?: number; authorization?: { mode?: string } } } | null)?.discount;
    assert.equal(discount?.band, "T2");
    assert.equal(discount?.discountPct, 20);
    assert.equal(discount?.authorization?.mode, "implicit");
    const noDiscount = await inject("POST", `/properties/${A}/reservations`, s("rec"), { ...stay, roomTypeId, ratePlanId, totalAmount: 200, bookerName: "Sin descuento" });
    assert.ok(created(noDiscount.status), noDiscount.text.slice(0, 400));
  });
});

describe("Tanda 8a · L2 · invariantes de Faranda", () => {
  it("facturas, asientos y envíos VeriFactu de Faranda no cambian durante la suite", async () => {
    assert.ok(baseline, "baseline not measured");
    const now = await farandaInvariants();
    assert.deepEqual(now, baseline);
  });
});
