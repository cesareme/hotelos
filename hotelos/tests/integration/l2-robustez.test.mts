/**
 * Tanda L2 · L2-06 · N+1 y catches silenciosos — robustez REAL vía app.inject
 * sobre un tenant AISLADO (helpers/l2-tenant.mts, STRICT_ENV: auth real, sin
 * unión de permisos de demo, RBAC_STRICT=true).
 *
 *   (1) Proyección contable · enlace documento↔asiento (projection.ts): con
 *       `prisma.payment.update` forzado a fallar el cobro NO se proyecta en
 *       silencio: HttpError 500 tipado (`details.code = ACCOUNTING_LINK_FAILED`
 *       con correlationId) y el log de error lleva el correlationId; con un
 *       P2025 simulado (la fila desapareció) la proyección termina `posted` y
 *       solo avisa (warn con el código y el correlationId).
 *   (2) Los 33 `GET /dashboards/*` de server.ts responden 200 al owner de la
 *       organización aislada con `propertyId=A`; `degraded` es un array vacío en
 *       los servicios que pasan por createDegradedCollector; el receptionist
 *       obtiene 200 o 403 exactamente según el manifiesto (claves requeridas ⊆
 *       concedidas) y un 404 opaco en el hotel B (fuera de su ámbito); el owner
 *       recibe un 404 opaco con una propiedad de otra organización.
 *   (3) `/search?q=` y `POST /copilot/ask` responden 200 y nombran en
 *       `degraded[]` la consulta que falló (monkeypatch de un delegado Prisma,
 *       restaurado siempre) — y `[]` cuando nada falla.
 *   (4) Contador de operaciones Prisma por petición ≤ umbral FIJO con 5 reservas
 *       alojadas (+ 3 llegadas): preflight del cierre del día, liberación de
 *       cupos (5 cupos × 3 días) y actividad de la reserva (5 conversaciones).
 *       Los umbrales están por debajo de lo que consumía el código con N+1.
 *
 * Nunca escribe fuera de su organización; Faranda se compara antes y después.
 * Run: cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/l2-robustez.test.mts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { after, before, describe, it } from "node:test";

const {
  createIsolatedTenant,
  loginOrThrow,
  cleanupTenant,
  STRICT_ENV,
  withEnv,
  farandaInvariants,
  newRunId
} = await import("./helpers/l2-tenant.mts");
type IsolatedTenant = Awaited<ReturnType<typeof createIsolatedTenant>>;
type Session = Awaited<ReturnType<typeof loginOrThrow>>;

const { prisma } = await import("@hotelos/database");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const projection = await import("../../apps/api/src/modules/accounting/projection.js");
const { releaseExpired } = await import("../../apps/api/src/modules/allotment/allotment.service.js");
const { HttpError } = await import("../../apps/api/src/lib/http-error.js");
const { routePermissionManifest } = await import("../../apps/api/src/security/route-permissions.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Headers = Record<string, string>;

const RUN = newRunId();
/** Hotel real de otra organización (Faranda · Rías Altas). Si no existe en la BD el 404 opaco es el mismo. */
const FOREIGN_PROPERTY_ID = "cmrhw9jy40003fyvbuu2ec2w7";
const OPAQUE_404 = "Propiedad no encontrada.";

/** Rutas /dashboards/* cuyo servicio pasa por createDegradedCollector (previas + las de este lote y L2-05). */
const DEGRADED_DASHBOARDS = [
  "/dashboards/general-manager",
  "/dashboards/operations-director",
  "/dashboards/shift-manager",
  "/dashboards/front-desk-queue",
  "/dashboards/room-rack",
  "/dashboards/housekeeping-mobile",
  "/dashboards/channel-performance",
  "/dashboards/maintenance-mobile",
  "/dashboards/surveys",
  "/dashboards/reputation"
] as const;

/** Tableros de dirección/finanzas: se informa (diagnóstico) cuando el receptionist los abre con las claves del manifiesto. */
const MANAGEMENT_DASHBOARDS = new Set([
  "/dashboards/general-manager",
  "/dashboards/operations-director",
  "/dashboards/finance-position",
  "/dashboards/portfolio",
  "/dashboards/sales-pipeline",
  "/dashboards/workforce",
  "/dashboards/analytics-center",
  "/dashboards/room-profitability",
  "/dashboards/property-overview"
]);

// Umbrales FIJOS de operaciones Prisma por petición, medidos con el código
// agregado (actividad 21 · preflight 27 · liberación 4; en las peticiones HTTP
// ~12 son de auth/ámbito: sesión, usuario, organización, asignaciones). El
// código N+1 anterior consumía, con estos mismos datos, +10 en actividad (2 por
// conversación), +9 en preflight (1 línea por alojada + 2 por llegada) y +17 en
// la liberación de cupos (1 lectura por cupo + 1 escritura por día): todos por
// encima del umbral.
const MAX_OPS_GUEST_ACTIVITY = 24;
const MAX_OPS_PREFLIGHT = 30;
const MAX_OPS_ALLOTMENT_RELEASE = 6;

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function utcDay(offsetDays: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays));
}

async function getJson<T>(app: ApiApp, url: string, headers: Headers): Promise<{ status: number; body: T | null; text: string }> {
  const res = await app.inject({ method: "GET", url, headers });
  let body: T | null = null;
  try {
    body = JSON.parse(res.body) as T;
  } catch {
    body = null;
  }
  return { status: res.statusCode, body, text: res.body };
}

function dashboardRoutesFromServer(): string[] {
  const source = readFileSync(new URL("../../apps/api/src/server.ts", import.meta.url), "utf8");
  const routes = new Set<string>();
  for (const match of source.matchAll(/app\.get\("(\/dashboards\/[a-z-]+)"/g)) routes.add(match[1]!);
  return Array.from(routes).sort();
}

/** Sustituye un método de un delegado Prisma mientras dura `run`; siempre lo restaura. */
async function withPrismaPatch<T>(delegateName: string, method: string, replacement: (...args: unknown[]) => unknown, run: () => Promise<T>): Promise<T> {
  const delegate = (prisma as unknown as Record<string, Record<string, unknown>>)[delegateName];
  assert.ok(delegate && typeof delegate[method] === "function", `prisma.${delegateName}.${method} no existe`);
  const original = delegate[method];
  delegate[method] = replacement;
  try {
    return await run();
  } finally {
    delegate[method] = original;
  }
}

/** Captura los argumentos de console[level] mientras dura `run`; siempre lo restaura. */
async function captureConsole<T>(level: "error" | "warn", run: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console[level];
  console[level] = (...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  };
  try {
    return { result: await run(), lines };
  } finally {
    console[level] = original;
  }
}

const PRISMA_OPS = [
  "findMany", "findFirst", "findFirstOrThrow", "findUnique", "findUniqueOrThrow", "count", "aggregate", "groupBy",
  "create", "createMany", "createManyAndReturn", "update", "updateMany", "upsert", "delete", "deleteMany"
] as const;

function prismaModelNames(): string[] {
  const requireFromDatabase = createRequire(new URL(import.meta.resolve("@hotelos/database")));
  const { Prisma } = requireFromDatabase("@prisma/client") as { Prisma: { dmmf: { datamodel: { models: Array<{ name: string }> } } } };
  return Prisma.dmmf.datamodel.models.map((model) => model.name);
}

const lowerFirst = (value: string): string => value.charAt(0).toLowerCase() + value.slice(1);

/**
 * Cuenta las operaciones Prisma (findMany, count, update…) de TODOS los
 * delegados del cliente mientras dura `run`: envuelve cada método y lo
 * restaura al terminar. Los delegados del cliente extendido son objetos
 * estables (prisma.payment === prisma.payment), así que el parche alcanza a
 * los servicios que importan el mismo `prisma`.
 */
async function countPrismaOps<T>(run: () => Promise<T>): Promise<{ result: T; total: number; byOp: Record<string, number> }> {
  const restores: Array<() => void> = [];
  let total = 0;
  const byOp: Record<string, number> = {};
  for (const name of prismaModelNames()) {
    const delegate = (prisma as unknown as Record<string, Record<string, unknown> | undefined>)[lowerFirst(name)];
    if (!delegate) continue;
    for (const op of PRISMA_OPS) {
      const original = delegate[op];
      if (typeof original !== "function") continue;
      const key = `${lowerFirst(name)}.${op}`;
      delegate[op] = function (this: unknown, ...args: unknown[]) {
        total += 1;
        byOp[key] = (byOp[key] ?? 0) + 1;
        return (original as (...inner: unknown[]) => unknown).apply(this, args);
      };
      restores.push(() => {
        delegate[op] = original;
      });
    }
  }
  try {
    const result = await run();
    return { result, total, byOp };
  } finally {
    for (const restore of restores) restore();
  }
}

const describeOps = (byOp: Record<string, number>): string =>
  Object.entries(byOp)
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `${key}×${count}`)
    .join(", ");

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let app: ApiApp;
let tenant: IsolatedTenant;
let owner: Session;
let reception: Session;
let invariantsBefore: Awaited<ReturnType<typeof farandaInvariants>>;
/** Reserva alojada con 5 conversaciones (actividad) y folio abierto (proyección). */
let activityReservationId = "";
let activityFolioId = "";

async function seedOperationalData(): Promise<void> {
  const A = tenant.propertyA;
  // 5 reservas alojadas (llegaron ayer, salen pasado mañana) con folio abierto y habitación.
  for (let i = 0; i < 5; i += 1) {
    const reservation = await prisma.reservation.create({
      data: {
        propertyId: A,
        code: `L2R-${RUN}-${i + 1}`,
        channel: "direct",
        status: "checked_in",
        arrivalDate: utcDay(-1),
        departureDate: utcDay(2),
        roomTypeId: tenant.roomTypeA,
        assignedRoomId: tenant.roomsA[i % tenant.roomsA.length]
      },
      select: { id: true }
    });
    const folio = await prisma.folio.create({ data: { reservationId: reservation.id, status: "open" }, select: { id: true } });
    if (i === 0) {
      activityReservationId = reservation.id;
      activityFolioId = folio.id;
    }
  }
  // 3 llegadas de hoy (confirmed) con huésped principal: alimentan «arrivals_pending» del preflight.
  for (let i = 0; i < 3; i += 1) {
    const guest = await prisma.guest.create({
      data: { organizationId: tenant.organizationId, firstName: `Llegada${i + 1}`, surname1: `L2 ${RUN}` },
      select: { id: true }
    });
    const reservation = await prisma.reservation.create({
      data: { propertyId: A, code: `L2ARR-${RUN}-${i + 1}`, channel: "direct", status: "confirmed", arrivalDate: utcDay(0), departureDate: utcDay(3), roomTypeId: tenant.roomTypeA },
      select: { id: true }
    });
    await prisma.reservationGuest.create({ data: { reservationId: reservation.id, guestId: guest.id, isPrimary: true } });
  }
  // Huésped principal + 5 conversaciones (2 mensajes cada una) de la reserva de actividad.
  const primary = await prisma.guest.create({
    data: { organizationId: tenant.organizationId, firstName: "Actividad", surname1: `L2 ${RUN}` },
    select: { id: true }
  });
  await prisma.reservationGuest.create({ data: { reservationId: activityReservationId, guestId: primary.id, isPrimary: true } });
  for (let i = 0; i < 5; i += 1) {
    const conversation = await prisma.conversation.create({
      data: { propertyId: A, reservationId: activityReservationId, guestId: primary.id, channel: "whatsapp", status: "open" },
      select: { id: true }
    });
    await prisma.message.createMany({
      data: [
        { conversationId: conversation.id, senderType: "guest", body: `Hola ${i + 1}`, sentAt: new Date(Date.now() - 120_000 - i * 1000) },
        { conversationId: conversation.id, senderType: "staff", body: `Respuesta ${i + 1}`, sentAt: new Date(Date.now() - 60_000 - i * 1000) }
      ]
    });
  }
  // 5 cupos activos × 3 días dentro de la ventana de liberación (releaseDays 14).
  for (let i = 0; i < 5; i += 1) {
    const allotment = await prisma.allotment.create({
      data: {
        propertyId: A,
        code: `L2A-${RUN}-${i + 1}`,
        name: `Cupo L2 ${i + 1}`,
        roomTypeId: tenant.roomTypeA,
        validFrom: utcDay(0),
        validTo: utcDay(30),
        totalRooms: 2,
        releaseDays: 14,
        status: "active"
      },
      select: { id: true }
    });
    await prisma.allotmentDay.createMany({
      data: [1, 2, 3].map((offset) => ({ allotmentId: allotment.id, date: utcDay(offset), blockedRooms: 2, pickedUpRooms: offset === 2 ? 1 : 0 }))
    });
  }
}

before(async () => {
  invariantsBefore = await farandaInvariants();
  tenant = await createIsolatedTenant(RUN);
  await seedOperationalData();
  app = await buildApiServer();
  await app.ready();
  await withEnv(STRICT_ENV, async () => {
    owner = await loginOrThrow(app, tenant.users.owner.email, tenant.password, "l2-06-owner");
    reception = await loginOrThrow(app, tenant.users.receptionist.email, tenant.password, "l2-06-reception");
  });
});

after(async () => {
  try {
    await flushAuditQueues();
    await projection.flushAccountingProjection();
    await cleanupTenant(tenant.organizationId);
  } finally {
    await app.close();
  }
  const invariantsAfter = await farandaInvariants();
  assert.deepEqual(invariantsAfter, invariantsBefore, "Faranda debe quedar idéntica");
  assert.equal(await prisma.organization.count({ where: { id: tenant.organizationId } }), 0, "la organización aislada debe desaparecer");
});

// ---------------------------------------------------------------------------
// (1) Proyección contable · enlace documento↔asiento
// ---------------------------------------------------------------------------

describe("L2-06 · (1) proyección contable: el enlace cobro↔asiento nunca falla en silencio", () => {
  it("con payment.update roto → HttpError 500 tipado ACCOUNTING_LINK_FAILED y log de error con correlationId", async () => {
    const payment = await prisma.payment.create({
      data: { propertyId: tenant.propertyA, folioId: activityFolioId, amount: "50.00", method: "cash", methodCode: "cash", status: "captured" },
      select: { id: true }
    });
    const correlationId = `corr_l2_06_link_${RUN}`;
    const { result: outcome, lines } = await captureConsole("error", () =>
      withPrismaPatch("payment", "update", () => Promise.reject(new Error("fallo simulado de almacenamiento")), async () => {
        try {
          await projection.postPaymentCapture({ paymentId: payment.id, correlationId });
          return null;
        } catch (error) {
          return error;
        }
      })
    );
    assert.ok(outcome instanceof HttpError, `debe relanzar un HttpError tipado, no ${String(outcome)}`);
    assert.equal(outcome.statusCode, 500);
    const details = outcome.details as { code?: string; sourceType?: string; sourceId?: string; journalEntryId?: string; correlationId?: string };
    assert.equal(details.code, "ACCOUNTING_LINK_FAILED");
    assert.equal(details.sourceType, "payment");
    assert.equal(details.sourceId, payment.id);
    assert.equal(details.correlationId, correlationId);
    assert.ok(typeof details.journalEntryId === "string" && details.journalEntryId.length > 0, "el asiento ya contabilizado viaja en details");
    assert.ok(lines.some((line) => line.includes(correlationId) && line.includes("link failed")), `el log de error debe llevar el correlationId: ${lines.join(" | ").slice(0, 300)}`);
    assert.ok(lines.some((line) => line.includes(payment.id)), "el log de error debe llevar el sourceId");
    // El asiento existe (está contabilizado) pero el cobro sigue sin enlace: la re-proyección lo encontrará por su clave.
    const entry = await prisma.journalEntry.findFirst({ where: { organizationId: tenant.organizationId, sourceType: "payment", sourceId: payment.id }, select: { id: true } });
    assert.ok(entry, "el asiento del cobro debe existir");
    assert.equal(entry.id, details.journalEntryId);
    const row = await prisma.payment.findUnique({ where: { id: payment.id }, select: { journalEntryId: true } });
    assert.equal(row?.journalEntryId, null);
  });

  it("con un P2025 simulado (la fila desapareció) → outcome posted + warn con el código y el correlationId", async () => {
    const payment = await prisma.payment.create({
      data: { propertyId: tenant.propertyA, folioId: activityFolioId, amount: "20.00", method: "card", methodCode: "card_terminal", status: "captured" },
      select: { id: true }
    });
    const correlationId = `corr_l2_06_p2025_${RUN}`;
    const notFound = Object.assign(new Error("Record to update not found."), { code: "P2025" });
    const { result: outcome, lines } = await captureConsole("warn", () =>
      withPrismaPatch("payment", "update", () => Promise.reject(notFound), () => projection.postPaymentCapture({ paymentId: payment.id, correlationId }))
    );
    assert.equal(outcome.outcome, "posted");
    assert.equal(outcome.journalEntryIds.length, 1);
    assert.ok(lines.some((line) => line.includes("P2025") && line.includes(correlationId)), `el warn debe llevar el código y el correlationId: ${lines.join(" | ").slice(0, 300)}`);
    const row = await prisma.payment.findUnique({ where: { id: payment.id }, select: { journalEntryId: true } });
    assert.equal(row?.journalEntryId, null, "el parche impidió el enlace: la proyección lo tolera");
  });

  it("sin parche el enlace se escribe (control)", async () => {
    const payment = await prisma.payment.create({
      data: { propertyId: tenant.propertyA, folioId: activityFolioId, amount: "10.00", method: "cash", methodCode: "cash", status: "captured" },
      select: { id: true }
    });
    const outcome = await projection.postPaymentCapture({ paymentId: payment.id, correlationId: `corr_l2_06_ok_${RUN}` });
    assert.equal(outcome.outcome, "posted");
    const row = await prisma.payment.findUnique({ where: { id: payment.id }, select: { journalEntryId: true } });
    assert.equal(row?.journalEntryId, outcome.journalEntryIds[0]);
  });
});

// ---------------------------------------------------------------------------
// (2) Los 33 GET /dashboards/*
// ---------------------------------------------------------------------------

describe("L2-06 · (2) los 33 GET /dashboards/* con tenant aislado y RBAC estricto", () => {
  const routes = dashboardRoutesFromServer();

  it("server.ts registra exactamente 33 GET /dashboards/* y todos están en el manifiesto", () => {
    assert.equal(routes.length, 33, routes.join(", "));
    for (const route of routes) {
      assert.ok(routePermissionManifest.some((entry) => entry.method === "GET" && entry.path === route), `${route} sin entrada en el manifiesto`);
    }
  });

  it("owner · 200 en los 33 con propertyId=A; degraded=[] en los servicios con collector", async () => {
    await withEnv(STRICT_ENV, async () => {
      const failures: string[] = [];
      for (const route of routes) {
        const res = await getJson<{ degraded?: unknown }>(app, `${route}?propertyId=${tenant.propertyA}`, owner.headers);
        if (res.status !== 200) failures.push(`${route} → ${res.status} ${res.text.slice(0, 160)}`);
        if ((DEGRADED_DASHBOARDS as readonly string[]).includes(route)) {
          if (!Array.isArray(res.body?.degraded)) failures.push(`${route}: degraded no es array (${res.text.slice(0, 120)})`);
          else if ((res.body!.degraded as unknown[]).length !== 0) failures.push(`${route}: degraded no vacío ${JSON.stringify(res.body!.degraded)}`);
        }
      }
      assert.deepEqual(failures, []);
    });
  });

  it("receptionist · 200 o 403 exactamente según el manifiesto (claves requeridas ⊆ concedidas en A)", async (t) => {
    await withEnv(STRICT_ENV, async () => {
      const me = await getJson<{ grantedPermissions: string[]; activePropertyId: string }>(app, "/users/me", reception.headers);
      assert.equal(me.status, 200, me.text.slice(0, 160));
      const granted = new Set(me.body?.grantedPermissions ?? []);
      const mismatches: string[] = [];
      const openedManagement: string[] = [];
      let forbidden = 0;
      for (const route of routes) {
        const required = routePermissionManifest.find((entry) => entry.method === "GET" && entry.path === route)?.permissions ?? [];
        const expected = required.every((key) => granted.has(key)) ? 200 : 403;
        const res = await getJson<{ message?: string }>(app, `${route}?propertyId=${tenant.propertyA}`, reception.headers);
        if (res.status !== expected) mismatches.push(`${route}: esperado ${expected} (requiere ${required.join("+") || "—"}), obtenido ${res.status} ${res.text.slice(0, 120)}`);
        if (res.status === 403) forbidden += 1;
        if (res.status === 200 && MANAGEMENT_DASHBOARDS.has(route)) openedManagement.push(route);
      }
      assert.deepEqual(mismatches, []);
      t.diagnostic(`receptionist: ${routes.length - forbidden} × 200 · ${forbidden} × 403 sobre ${routes.length} tableros`);
      if (openedManagement.length > 0) {
        t.diagnostic(`manifiesto: el receptionist abre tableros de dirección/finanzas con analytics.read → ${openedManagement.join(", ")} (clave dedicada pendiente en route-permissions.ts)`);
      }
    });
  });

  it("receptionist · 404 opaco en el hotel B (misma organización, fuera de su ámbito) en los 33", async () => {
    await withEnv(STRICT_ENV, async () => {
      const failures: string[] = [];
      for (const route of routes) {
        const res = await getJson<{ message?: string }>(app, `${route}?propertyId=${tenant.propertyB}`, reception.headers);
        if (res.status !== 404 || res.body?.message !== OPAQUE_404 || res.text.includes(tenant.propertyB)) failures.push(`${route} → ${res.status} ${res.text.slice(0, 120)}`);
      }
      assert.deepEqual(failures, []);
    });
  });

  it("owner · 404 opaco con una propiedad de otra organización en los 33", async () => {
    await withEnv(STRICT_ENV, async () => {
      const failures: string[] = [];
      for (const route of routes) {
        const res = await getJson<{ message?: string }>(app, `${route}?propertyId=${FOREIGN_PROPERTY_ID}`, owner.headers);
        if (res.status !== 404 || res.body?.message !== OPAQUE_404 || res.text.includes(FOREIGN_PROPERTY_ID)) failures.push(`${route} → ${res.status} ${res.text.slice(0, 120)}`);
      }
      assert.deepEqual(failures, []);
    });
  });
});

// ---------------------------------------------------------------------------
// (3) degraded[] en /search y en el copiloto
// ---------------------------------------------------------------------------

describe("L2-06 · (3) /search y /copilot/ask nombran la consulta que falló en degraded[]", () => {
  it("/search?q= → 200 con degraded=[] y, con guest.findMany roto, degraded=[\"guest\"]", async () => {
    await withEnv(STRICT_ENV, async () => {
      const healthy = await getJson<{ items: unknown[]; degraded: string[] }>(app, `/search?q=L2R&propertyId=${tenant.propertyA}`, owner.headers);
      assert.equal(healthy.status, 200, healthy.text.slice(0, 160));
      assert.deepEqual(healthy.body?.degraded, []);
      assert.ok((healthy.body?.items.length ?? 0) >= 5, "las 5 reservas L2R-* deben aparecer");

      const { result: broken, lines } = await captureConsole("warn", () =>
        withPrismaPatch("guest", "findMany", () => Promise.reject(new Error("índice de huéspedes roto")), () =>
          getJson<{ items: unknown[]; degraded: string[] }>(app, `/search?q=L2R&propertyId=${tenant.propertyA}`, owner.headers)
        )
      );
      assert.equal(broken.status, 200, broken.text.slice(0, 160));
      assert.deepEqual(broken.body?.degraded, ["guest"]);
      assert.ok((broken.body?.items.length ?? 0) >= 5, "los demás índices siguen respondiendo");
      assert.ok(lines.some((line) => line.includes("[search.global] guest failed")), lines.join(" | ").slice(0, 300));
    });
  });

  it("POST /copilot/ask → 200 con degraded=[] y, con workOrder.findMany roto, degraded=[\"work_orders\"]", async () => {
    await withEnv(STRICT_ENV, async () => {
      const ask = () =>
        app.inject({ method: "POST", url: "/copilot/ask", headers: owner.headers, payload: { propertyId: tenant.propertyA, question: "¿qué incidencias abiertas hay?" } });
      const healthy = await ask();
      assert.equal(healthy.statusCode, 200, healthy.body.slice(0, 160));
      const healthyBody = JSON.parse(healthy.body) as { intent: string; degraded: string[]; items: unknown[] };
      assert.equal(healthyBody.intent, "open_incidents");
      assert.deepEqual(healthyBody.degraded, []);

      const { result: broken, lines } = await captureConsole("warn", () =>
        withPrismaPatch("workOrder", "findMany", () => Promise.reject(new Error("tabla de incidencias rota")), ask)
      );
      assert.equal(broken.statusCode, 200, broken.body.slice(0, 160));
      const brokenBody = JSON.parse(broken.body) as { intent: string; degraded: string[]; items: unknown[] };
      assert.equal(brokenBody.intent, "open_incidents");
      assert.deepEqual(brokenBody.degraded, ["work_orders"]);
      assert.deepEqual(brokenBody.items, []);
      assert.ok(lines.some((line) => line.includes("[copilot.ask] work_orders failed")), lines.join(" | ").slice(0, 300));
    });
  });
});

// ---------------------------------------------------------------------------
// (4) Contador de operaciones Prisma por petición
// ---------------------------------------------------------------------------

describe("L2-06 · (4) operaciones Prisma por petición bajo umbral fijo (N+1 resueltos)", () => {
  it(`GET /reservations/:id/activity con 5 conversaciones ≤ ${MAX_OPS_GUEST_ACTIVITY}`, async (t) => {
    await withEnv(STRICT_ENV, async () => {
      // El contador intercepta TODO el cliente Prisma: se vacían antes las colas de persistencia de
      // auditoría/eventos (encadenadas en segundo plano por peticiones de suites anteriores) para que
      // solo cuenten las operaciones de esta petición.
      await flushAuditQueues();
      const { result, total, byOp } = await countPrismaOps(() =>
        getJson<{ counts: { messages: number }; items: Array<{ kind: string }> }>(app, `/reservations/${activityReservationId}/activity`, owner.headers)
      );
      assert.equal(result.status, 200, result.text.slice(0, 160));
      assert.equal(result.body?.counts.messages, 10);
      assert.equal(result.body?.items.filter((item) => item.kind === "message").length, 5);
      t.diagnostic(`activity: ${total} operaciones (${describeOps(byOp)})`);
      assert.ok(total <= MAX_OPS_GUEST_ACTIVITY, `${total} operaciones Prisma > ${MAX_OPS_GUEST_ACTIVITY}: ${describeOps(byOp)}`);
      assert.equal(byOp["message.groupBy"] ?? 0, 1);
      assert.equal(byOp["message.findMany"] ?? 0, 1);
      assert.equal(byOp["message.count"] ?? 0, 0);
    });
  });

  it(`GET /properties/A/night-audit/preflight con 5 alojadas + 3 llegadas ≤ ${MAX_OPS_PREFLIGHT}`, async (t) => {
    await withEnv(STRICT_ENV, async () => {
      await flushAuditQueues(); // mismo motivo que en /activity: solo las operaciones de esta petición
      const { result, total, byOp } = await countPrismaOps(() =>
        getJson<{ checks: Array<{ id: string; count: number | null; items?: Array<{ label: string }> }> }>(app, `/properties/${tenant.propertyA}/night-audit/preflight`, owner.headers)
      );
      assert.equal(result.status, 200, result.text.slice(0, 160));
      const check = (id: string) => result.body?.checks.find((c) => c.id === id);
      assert.equal(check("unposted_room_charges")?.count, 5, "las 5 alojadas no tienen cargo de habitación hoy");
      assert.equal(check("arrivals_pending")?.count, 3);
      assert.ok(check("arrivals_pending")?.items?.every((item) => /Llegada\d L2/.test(item.label)), JSON.stringify(check("arrivals_pending")?.items));
      t.diagnostic(`preflight: ${total} operaciones (${describeOps(byOp)})`);
      assert.ok(total <= MAX_OPS_PREFLIGHT, `${total} operaciones Prisma > ${MAX_OPS_PREFLIGHT}: ${describeOps(byOp)}`);
      assert.equal(byOp["folioLine.findFirst"] ?? 0, 0, "ninguna consulta de línea por reserva");
      assert.ok((byOp["reservationGuest.findMany"] ?? 0) <= 4 && (byOp["reservationGuest.findFirst"] ?? 0) === 0, "nombres de huésped en lote");
    });
  });

  it(`releaseExpired con 5 cupos × 3 días ≤ ${MAX_OPS_ALLOTMENT_RELEASE} y libera 15 días / 25 habitaciones`, async (t) => {
    await flushAuditQueues(); // mismo motivo que en /activity
    const { result, total, byOp } = await countPrismaOps(() => releaseExpired({ propertyId: tenant.propertyA }));
    t.diagnostic(`release: ${total} operaciones (${describeOps(byOp)})`);
    assert.deepEqual(result, { releasedDays: 15, releasedRooms: 25 });
    assert.ok(total <= MAX_OPS_ALLOTMENT_RELEASE, `${total} operaciones Prisma > ${MAX_OPS_ALLOTMENT_RELEASE}: ${describeOps(byOp)}`);
    assert.equal(byOp["allotmentDay.update"] ?? 0, 0, "ninguna escritura por día");
    // Idempotente: una segunda pasada no libera nada.
    assert.deepEqual(await releaseExpired({ propertyId: tenant.propertyA }), { releasedDays: 0, releasedRooms: 0 });
    const allotmentIds = (await prisma.allotment.findMany({ where: { propertyId: tenant.propertyA, code: { startsWith: `L2A-${RUN}-` } }, select: { id: true } })).map((a) => a.id);
    const released = await prisma.allotmentDay.findMany({ where: { allotmentId: { in: allotmentIds } }, select: { blockedRooms: true, pickedUpRooms: true, releasedRooms: true } });
    assert.equal(released.length, 15);
    for (const day of released) assert.equal(day.releasedRooms, day.blockedRooms - day.pickedUpRooms);
  });
});
