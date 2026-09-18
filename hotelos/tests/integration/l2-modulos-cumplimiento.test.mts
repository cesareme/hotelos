/**
 * Tanda L2 · L2-08 · tests de integración mínimos por módulo — CUMPLIMIENTO
 * (tbai, tourist-tax). app.inject sobre Postgres real con dos organizaciones
 * AISLADAS (helpers/l2-tenant.mts): A escribe y lee; B (otra organización)
 * nunca ve nada. STRICT_ENV: auth real, sin unión de permisos de demo,
 * RBAC_STRICT=true. Las tarifas de tasa turística (`tourist_tax_rates`) son un
 * catálogo GLOBAL: esta suite solo las lee, nunca las siembra.
 *
 * Tres casos por módulo (criterio §4 del plan · fila L2 «tests por módulo»):
 *   (1) crear o leer con ámbito (fila en Prisma con propertyId de A);
 *   (2) 403 sin clave (mensaje en español del gate o de requirePermissions,
 *       nunca el 403 de «ruta no registrada en el manifiesto»);
 *   (3) 404 opaco en propiedad ajena (recepción de A sobre el hotel B; usuario
 *       de la organización B sobre el hotel A o sobre una entidad de A).
 *
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/l2-modulos-cumplimiento.test.mts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const { createIsolatedTenant, cleanupTenant, loginOrThrow, newRunId, STRICT_ENV, withEnv, farandaInvariants } = await import("./helpers/l2-tenant.mts");
type IsolatedTenant = import("./helpers/l2-tenant.mts").IsolatedTenant;
type Session = import("./helpers/l2-tenant.mts").Session;
const { prisma } = await import("@hotelos/database");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Method = "GET" | "POST" | "PATCH" | "DELETE";
type Reply = { status: number; body: any; raw: string };

const RUN = `k${newRunId()}`;
const OPAQUE_404 = "Propiedad no encontrada.";

let app: ApiApp;
let A: IsolatedTenant;
let B: IsolatedTenant;
let owner: Session;
let reception: Session;
let systems: Session;
let ownerB: Session;
let receptionB: Session;
let invariantsBefore: Awaited<ReturnType<typeof farandaInvariants>>;

async function call(method: Method, url: string, session: Session | null, options: { payload?: unknown; propertyId?: string } = {}): Promise<Reply> {
  const res = await withEnv(STRICT_ENV, () =>
    app.inject({
      method,
      url,
      headers: { ...(session?.headers ?? {}), ...(options.propertyId ? { "x-property-id": options.propertyId } : {}) },
      ...(options.payload !== undefined ? { payload: options.payload } : {})
    })
  );
  let body: any = null;
  try {
    body = res.body ? JSON.parse(res.body) : null;
  } catch {
    body = null;
  }
  return { status: res.statusCode, body, raw: res.body };
}

function expect404(reply: Reply, message = OPAQUE_404): void {
  assert.equal(reply.status, 404, reply.raw.slice(0, 300));
  assert.equal(reply.body?.message, message);
}

/** 403 en español del gate o de requirePermissions, con la clave que falta; nunca el de «ruta sin manifiesto». */
function expect403(reply: Reply, key: string): void {
  assert.equal(reply.status, 403, reply.raw.slice(0, 300));
  const message = String(reply.body?.message ?? "");
  assert.match(message, /^No tienes permiso para realizar esta acción/, message);
  assert.ok(message.includes(key), `la clave que falta (${key}) viaja en el mensaje: ${message}`);
  assert.doesNotMatch(message, /manifiesto/, "no es el 403 de ruta sin entrada en el manifiesto");
}

before(async () => {
  invariantsBefore = await farandaInvariants();
  app = await buildApiServer();
  A = await createIsolatedTenant(RUN);
  B = await createIsolatedTenant(`${RUN}b`);
  await withEnv(STRICT_ENV, async () => {
    owner = await loginOrThrow(app, A.users.owner.email, A.password, "l2-08-cum-owner");
    reception = await loginOrThrow(app, A.users.receptionist.email, A.password, "l2-08-cum-reception");
    systems = await loginOrThrow(app, A.users.systems.email, A.password, "l2-08-cum-systems");
    ownerB = await loginOrThrow(app, B.users.owner.email, B.password, "l2-08-cum-owner-b");
    receptionB = await loginOrThrow(app, B.users.receptionist.email, B.password, "l2-08-cum-reception-b");
  });
});

after(async () => {
  try {
    await flushAuditQueues();
    if (A) await cleanupTenant(A.organizationId);
    if (B) await cleanupTenant(B.organizationId);
  } finally {
    await app?.close();
  }
  assert.deepEqual(await farandaInvariants(), invariantsBefore, "las cifras de Faranda no cambian");
  assert.equal(await prisma.organization.count({ where: { id: { in: [A.organizationId, B.organizationId] } } }), 0, "sin organizaciones residuales de esta suite");
});

// ---------------------------------------------------------------------------
// tbai (TicketBAI foral)
// ---------------------------------------------------------------------------

describe("L2-08 · tbai: territorios forales y envíos TicketBAI con ámbito", () => {
  let submissionId = "";

  it("(1) GET /tbai/territories lista los 4 territorios y GET /properties/:id/tbai/submissions (recepción, billing.compliance.view) devuelve los envíos de A", async () => {
    const territories = await call("GET", "/tbai/territories", reception);
    assert.equal(territories.status, 200, territories.raw.slice(0, 300));
    assert.deepEqual(territories.body.items, ["bizkaia", "gipuzkoa", "araba", "navarra"]);
    assert.equal(typeof territories.body.config, "object");

    const empty = await call("GET", `/properties/${A.propertyA}/tbai/submissions`, reception);
    assert.equal(empty.status, 200, empty.raw.slice(0, 300));
    assert.deepEqual(empty.body.items, []);

    const created = await prisma.tbaiSubmission.create({
      data: { invoiceId: `inv_l2_${RUN}`, propertyId: A.propertyA, territory: "bizkaia", status: "pending" },
      select: { id: true }
    });
    submissionId = created.id;
    const listed = await call("GET", `/properties/${A.propertyA}/tbai/submissions?territory=bizkaia`, owner);
    assert.equal(listed.status, 200, listed.raw.slice(0, 300));
    assert.ok(listed.body.items.some((item: { id: string; propertyId: string }) => item.id === submissionId && item.propertyId === A.propertyA));
    const detail = await call("GET", `/tbai/submissions/${submissionId}`, reception);
    assert.equal(detail.status, 200, detail.raw.slice(0, 300));
    assert.equal(detail.body.id, submissionId);
  });

  it("(2) 403 sin clave: recepción no remite facturas a TicketBAI (compliance.configure); sistemas no ve los envíos (billing.compliance.view) ni los reintenta (compliance.ses.submit)", async () => {
    expect403(await call("POST", `/invoices/inv_l2_${RUN}/tbai/submit`, reception, { propertyId: A.propertyA, payload: { mode: "stub" } }), "compliance.configure");
    expect403(await call("GET", `/properties/${A.propertyA}/tbai/submissions`, systems), "billing.compliance.view");
    expect403(await call("POST", `/tbai/submissions/${submissionId}/retry`, systems, { propertyId: A.propertyA, payload: {} }), "compliance.ses.submit");
    assert.equal((await prisma.tbaiSubmission.findUnique({ where: { id: submissionId } }))?.status, "pending", "nada reintentado");
  });

  it("(3) 404 opaco: recepción de A sobre B, organización B sobre A (lista, cadena y envío por id)", async () => {
    expect404(await call("GET", `/properties/${A.propertyB}/tbai/submissions`, reception));
    expect404(await call("GET", `/properties/${A.propertyA}/tbai/submissions`, ownerB));
    expect404(await call("GET", `/properties/${A.propertyA}/tbai/chain/bizkaia/verify`, ownerB));
    expect404(await call("GET", `/tbai/submissions/${submissionId}`, receptionB), "Envío TicketBAI no encontrado.");
  });
});

// ---------------------------------------------------------------------------
// tourist-tax (routes/tourist-tax.routes.ts)
// ---------------------------------------------------------------------------

describe("L2-08 · tourist-tax: tarifas, aplicaciones por periodo y cargo con ámbito", () => {
  let reservationId = "";

  it("(1) GET /tourist-tax/rates (tourist_tax.read) lee el catálogo y GET /properties/:id/tourist-tax/applications devuelve las aplicaciones de A con resumen", async () => {
    const rates = await call("GET", "/tourist-tax/rates", reception);
    assert.equal(rates.status, 200, rates.raw.slice(0, 300));
    assert.ok(Array.isArray(rates.body.items));

    const reservation = await prisma.reservation.create({
      data: { propertyId: A.propertyA, code: `TT-${RUN}`, channel: "direct", status: "confirmed", arrivalDate: new Date("2026-10-02T00:00:00.000Z"), departureDate: new Date("2026-10-04T00:00:00.000Z"), roomTypeId: A.roomTypeA },
      select: { id: true }
    });
    reservationId = reservation.id;
    await prisma.touristTaxApplication.create({
      data: {
        propertyId: A.propertyA,
        reservationId,
        rateId: `rate_l2_${RUN}`,
        ccaaCode: "ES-CT",
        municipality: "Barcelona",
        establishmentClass: "hotel_4",
        amountPerPersonNight: "3.5000",
        adultsTaxable: 2,
        nightsTaxable: 2,
        totalAmount: "14.00",
        stayFrom: new Date("2026-10-02T00:00:00.000Z"),
        stayUntil: new Date("2026-10-04T00:00:00.000Z")
      }
    });
    const applications = await call("GET", `/properties/${A.propertyA}/tourist-tax/applications?fromDate=2026-10-01&toDate=2026-10-31`, reception);
    assert.equal(applications.status, 200, applications.raw.slice(0, 300));
    assert.equal(applications.body.items.length, 1);
    assert.equal(applications.body.items[0].propertyId, A.propertyA);
    assert.equal(applications.body.items[0].reservationId, reservationId);
    const summary = applications.body.summary.find((row: { jurisdiction: string }) => row.jurisdiction === "ES-CT:Barcelona");
    assert.ok(summary, JSON.stringify(applications.body.summary));
    assert.equal(summary.count, 1);
    assert.equal(summary.totalAmount, 14);
    const badRange = await call("GET", `/properties/${A.propertyA}/tourist-tax/applications?fromDate=no-es-fecha`, reception);
    assert.equal(badRange.status, 400, "fechas inválidas → 400 tipado, nunca 500");
  });

  it("(2) 403 sin clave: recepción no crea tarifas (compliance.configure); sistemas no lee tarifas ni aplicaciones (tourist_tax.read)", async () => {
    expect403(await call("POST", "/tourist-tax/rates", reception, { payload: { ccaaCode: "ES-L2", establishmentClass: "hotel_4", amountPerPersonNight: "1.0000", validFrom: new Date("2026-01-01T00:00:00.000Z").toISOString() } }), "compliance.configure");
    expect403(await call("GET", "/tourist-tax/rates", systems), "tourist_tax.read");
    expect403(await call("GET", `/properties/${A.propertyA}/tourist-tax/applications?fromDate=2026-10-01&toDate=2026-10-31`, systems), "tourist_tax.read");
    assert.equal(await prisma.touristTaxRate.count({ where: { ccaaCode: "ES-L2" } }), 0, "el catálogo global no se toca");
  });

  it("(3) 404 opaco: recepción de A sobre B, organización B sobre A y cargo de la tasa sobre una reserva de A desde B", async () => {
    expect404(await call("GET", `/properties/${A.propertyB}/tourist-tax/applications?fromDate=2026-10-01&toDate=2026-10-31`, reception));
    expect404(await call("GET", `/properties/${A.propertyA}/tourist-tax/applications?fromDate=2026-10-01&toDate=2026-10-31`, ownerB));
    expect404(await call("POST", "/tourist-tax/apply", receptionB, { propertyId: B.propertyA, payload: { reservationId, ccaaCode: "ES-CT" } }), "Reserva no encontrada.");
    assert.equal(await prisma.touristTaxApplication.count({ where: { propertyId: A.propertyA } }), 1, "B no aplica nada sobre A");
  });
});
