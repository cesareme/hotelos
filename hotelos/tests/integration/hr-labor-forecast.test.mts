/**
 * Previsión de plantilla · Tanda RRHH · RRHH-3 — integración (Postgres, en proceso, sin
 * HTTP). Una organización AISLADA `org_l2_<run>` (helpers/l2-tenant.mts: sociedad + dos
 * hoteles de 3 habitaciones) con datos SINTÉTICOS: 28 cierres top-level pasados, reservas
 * OTB con régimen, una previsión top-level `pms_import:*` y una `deterministic-v1` sin OTB.
 * Recorre los servicios reales (nunca Faranda ni org_123):
 *   · reset-defaults 4★ → 9 estándares (desayunos sala + cocina fundidos: la clave única no lleva unit);
 *   · generate → una fila por día × departamento USALI (4 departamentos × 9 días = 36) con
 *     requiredLaborHours (el dashboard sigue sumándolas), source actual / otb / pms_forecast,
 *     días degradados sin FTE (deterministic sin OTB; sin OTB ni previsión), estimatedCost null
 *     sin lote de coste; regenerar respeta la clave única (mismas 36 filas, generatedAt nuevo);
 *   · list con las tres columnas de comparación (turnos, contratos − ausencias, plan aprobado);
 *   · plan de plantilla: quien lo prepara no lo aprueba (409 APPROVAL_SELF_DECISION), la
 *     dirección sí; aprobado no se reescribe (409); position control avisa sin bloquear;
 *   · KPIs y alertas con degraded[] en vez de ceros; 403 sin clave; 404 opaco fuera del ámbito;
 *   · SELECT directo de labor_forecasts del tenant.
 * Desde el repo:
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/hr-labor-forecast.test.mts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { UserContext } from "../../apps/api/src/lib/demo-store.js";

const { createIsolatedTenant, cleanupTenant, newRunId } = await import("./helpers/l2-tenant.mts");
const { prisma } = await import("@hotelos/database");
const { HttpError } = await import("../../apps/api/src/lib/http-error.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const standards = await import("../../apps/api/src/modules/hr/standards.service.js");
const forecast = await import("../../apps/api/src/modules/hr/labor-forecast.service.js");
const staffing = await import("../../apps/api/src/modules/hr/staffing.service.js");
const kpis = await import("../../apps/api/src/modules/hr/kpis.service.js");
const { dayUtc, addDays, isoDate } = await import("../../apps/api/src/modules/revenue/actuals.js");

const RUN = `hr3${newRunId()}`;
const TODAY = dayUtc(new Date());
const day = (offset: number): Date => addDays(TODAY, offset);
const key = (offset: number): string => isoDate(day(offset));
const CORR = `corr_hr3_${RUN}`;

type Details = Record<string, unknown>;
async function expectCode<T>(promise: Promise<T>, statusCode: number, code?: string): Promise<Details> {
  try {
    await promise;
  } catch (error) {
    // Errores tipados del API: HttpError (400/404/409 con details.code) o PermissionDeniedError (403 de assertPermissions).
    const typed = error as { statusCode?: unknown; details?: unknown; message?: string };
    assert.ok(error instanceof HttpError || typeof typed.statusCode === "number", `expected a typed API error, got ${String(error)}`);
    assert.equal(typed.statusCode, statusCode, `status (${typed.message})`);
    const details = (typed.details ?? {}) as Details;
    if (code) assert.equal(details.code, code, `details.code (${typed.message})`);
    return details;
  }
  assert.fail(`expected ${statusCode} ${code ?? ""}`);
}

let tenant: Awaited<ReturnType<typeof createIsolatedTenant>>;
let rrhh: UserContext;
let direccion: UserContext;
let lector: UserContext;
let soloHotelA: UserContext;
let profileFull = "";
let profileHalf = "";

function context(userId: string, permissions: string[], over: Partial<UserContext> = {}): UserContext {
  return { organizationId: tenant.organizationId, propertyId: tenant.propertyA, userId, fullName: "Persona de prueba", deviceId: "hr3-test", permissions, orgScope: true, ...over } as unknown as UserContext;
}

before(async () => {
  tenant = await createIsolatedTenant(RUN);
  rrhh = context(tenant.users.accountant.id, ["hr.standards.manage", "workforce.schedule.manage", "workforce.read", "payroll.read"]);
  direccion = context(tenant.users.generalManager.id, ["hr.staffing.approve", "workforce.read", "workforce.labor_cost.view", "payroll.read", "payroll.manage"]);
  lector = context(tenant.users.receptionist.id, ["workforce.read"]);
  soloHotelA = context(tenant.users.receptionist.id, ["workforce.schedule.manage", "workforce.read"], { assignedPropertyIds: [tenant.propertyA], orgScope: false });
  await prisma.property.update({ where: { id: tenant.propertyA }, data: { starRating: 4 } });

  // 28 cierres top-level pasados: 2 ocupadas, 1 llegada, 1 salida, 4 pax → LOS 2, pax/hab. 2.
  for (let i = 1; i <= 28; i++) {
    await prisma.revenueDailySnapshot.create({ data: { propertyId: tenant.propertyA, snapshotDate: day(-i), totalOcc: 2, arrivalRooms: 1, departureRooms: 1, adultsChildren: 4, roomRevenue: "200.00", totalRevenue: "200.00", netRoomRevenue: "200.00", occupancyPercent: "66.67", dataSource: "hr3_test" } });
  }
  // Reservas: pasada con régimen BB (cubiertos de los días −2/−1), OTB hoy→+3 (2 hab. HB), +1→+2 (1 hab. BB); cancelada que no cuenta.
  const mk = async (code: string, arrival: number, departure: number, data: Record<string, unknown>) =>
    prisma.reservation.create({ data: { propertyId: tenant.propertyA, code: `HR3-${code}-${RUN}`, channel: "direct", arrivalDate: day(arrival), departureDate: day(departure), ...data } as never });
  await mk("PAST", -3, -1, { status: "checked_out", adults: 2, children: 0, roomsCount: 1, boardType: "BB", totalAmount: "200.00" });
  await mk("OTB1", 0, 4, { status: "confirmed", adults: 3, children: 1, roomsCount: 2, boardType: "HB", totalAmount: "800.00" });
  await mk("OTB2", 1, 3, { status: "confirmed", adults: 2, children: 0, roomsCount: 1, boardType: "BB", totalAmount: "200.00" });
  await mk("CANC", 5, 7, { status: "cancelled", adults: 2, children: 0, roomsCount: 3, boardType: "AI", totalAmount: "600.00" });
  // Previsión top-level del PMS para +1 (3 habitaciones) y deterministic-v1 para +5 (sin OTB → no es driver).
  await prisma.revenueForecast.create({ data: { propertyId: tenant.propertyA, forecastDate: day(1), expectedRoomsSold: "3.00", expectedOccupancy: "100.00", modelVersion: `pms_import:hr3_${RUN}` } });
  await prisma.revenueForecast.create({ data: { propertyId: tenant.propertyA, forecastDate: day(5), expectedRoomsSold: "2.00", expectedOccupancy: "66.67", modelVersion: "deterministic-v1" } });
});

after(async () => {
  try {
    await flushAuditQueues();
    await cleanupTenant(tenant.organizationId);
  } finally {
    await prisma.$disconnect();
  }
});

describe("estándares del centro (standards.service)", () => {
  it("sin estándares el listado está vacío y la banda sale de starRating (4★)", async () => {
    const out = await standards.listLaborStandards({ context: lector, propertyId: tenant.propertyA });
    assert.deepEqual(out.standards, []);
    assert.equal(out.starBand, 4);
  });

  it("reset-defaults siembra 9 estándares sector_default (10 valores 4★ con sala + cocina fundidos); solo hr.standards.manage", async () => {
    await expectCode(standards.resetLaborStandardDefaults({ context: lector, propertyId: tenant.propertyA, correlationId: CORR }), 403);
    // validFrom anterior a la ventana de la previsión (los estándares rigen por fecha: uno vigente desde hoy no cubre ayer).
    const out = await standards.resetLaborStandardDefaults({ context: rrhh, propertyId: tenant.propertyA, validFrom: key(-60), correlationId: CORR });
    assert.equal(out.starBand, 4);
    assert.equal(out.written, 9);
    assert.equal(out.standards.length, 9);
    assert.ok(out.standards.every((s) => s.source === "sector_default"));
    const breakfast = out.standards.filter((s) => s.driver === "covers_breakfast");
    assert.equal(breakfast.length, 1);
    assert.equal(breakfast[0]!.value, "13.067");
    const reception = out.standards.find((s) => s.unit === "posts_by_band")!;
    assert.deepEqual(reception.bands?.[0], { maxOccupiedRooms: 60, posts: [1, 1, 1] });
    assert.equal(await prisma.laborStandard.count({ where: { propertyId: tenant.propertyA } }), 9);
    // Idempotente sobre la misma fecha: sigue habiendo 9 filas activas.
    const again = await standards.resetLaborStandardDefaults({ context: rrhh, propertyId: tenant.propertyA, validFrom: key(-60), correlationId: CORR });
    assert.equal(again.standards.length, 9);
    assert.equal(await prisma.laborStandard.count({ where: { propertyId: tenant.propertyA, validTo: null } }), 9);
  });

  it("PUT con una versión futura cierra las anteriores (validTo = validFrom − 1) y la vigencia se resuelve por fecha", async () => {
    const validFrom = key(400);
    const out = await standards.putLaborStandards({ context: rrhh, propertyId: tenant.propertyA, validFrom, correlationId: CORR, standards: [{ usaliDepartment: "rooms", driver: "departures", unit: "minutes_per_unit", value: 30, allowancePct: 10, coverageFactor: 1.4 }] });
    assert.equal(out.written, 1);
    assert.equal(out.closed, 9);
    assert.equal(out.standards.length, 1);
    const now = await standards.listLaborStandards({ context: lector, propertyId: tenant.propertyA });
    assert.equal(now.standards.length, 9, "hoy siguen vigentes los 9 del sector");
    const future = await standards.listLaborStandards({ context: lector, propertyId: tenant.propertyA, at: validFrom });
    assert.equal(future.standards.length, 1);
    assert.equal(future.standards[0]!.value, "30.000");
    // Se deja el centro como estaba: la versión futura se retira.
    await prisma.laborStandard.deleteMany({ where: { propertyId: tenant.propertyA, validFrom: dayUtc(validFrom) } });
    await prisma.laborStandard.updateMany({ where: { propertyId: tenant.propertyA }, data: { validTo: null } });
    assert.equal(await prisma.laborStandard.count({ where: { propertyId: tenant.propertyA, validTo: null } }), 9);
  });

  it("estándar inválido → 400 HR_STANDARD_INVALID; centro fuera del ámbito u otra organización → 404 opaco PROPERTY_NOT_FOUND", async () => {
    await expectCode(standards.putLaborStandards({ context: rrhh, propertyId: tenant.propertyA, standards: [{ usaliDepartment: "rooms", driver: "rooms_inventory", unit: "minutes_per_unit", value: 1 }] }), 400, "HR_STANDARD_INVALID");
    await expectCode(standards.listLaborStandards({ context: { ...lector, assignedPropertyIds: [tenant.propertyA], orgScope: false } as UserContext, propertyId: tenant.propertyB }), 404, "PROPERTY_NOT_FOUND");
    await expectCode(standards.listLaborStandards({ context: { ...lector, organizationId: "org_hr3_ajena" } as UserContext, propertyId: tenant.propertyA }), 404, "PROPERTY_NOT_FOUND");
  });
});

describe("generar y leer la previsión (labor-forecast.service)", () => {
  const FROM = key(-2);
  const TO = key(6);

  it("403 sin workforce.schedule.manage; ventana > 92 días → 400; 404 opaco en un centro fuera del ámbito", async () => {
    await expectCode(forecast.generateLaborForecast({ context: lector, propertyId: tenant.propertyA, from: FROM, to: TO, correlationId: CORR }), 403);
    await expectCode(forecast.generateLaborForecast({ context: rrhh, propertyId: tenant.propertyA, from: key(0), to: key(100), correlationId: CORR }), 400, "VALIDATION_ERROR");
    await expectCode(forecast.generateLaborForecast({ context: soloHotelA, propertyId: tenant.propertyB, from: FROM, to: TO, correlationId: CORR }), 404, "PROPERTY_NOT_FOUND");
    await expectCode(forecast.listLaborForecast({ context: lector, propertyId: tenant.propertyA, from: TO, to: FROM }), 400, "VALIDATION_ERROR");
  });

  it("generate → 9 días × 4 departamentos = 36 filas con source por día y degradación honesta", async () => {
    const out = await forecast.generateLaborForecast({ context: rrhh, propertyId: tenant.propertyA, from: FROM, to: TO, correlationId: CORR });
    assert.equal(out.days, 9);
    assert.equal(out.written, 36);
    assert.equal(out.deleted, 0);
    assert.equal(out.annualHours, 1792);
    assert.equal(out.annualHoursSource, "default");
    assert.equal(out.costPeriodCode, null);
    assert.ok(out.degraded.some((d) => d.code === "HR_AGREEMENT_MISSING"));
    assert.ok(out.degraded.some((d) => d.code === "HR_LABOR_COST_REFERENCE_MISSING"));
    assert.equal(out.degraded.filter((d) => d.code === "HR_STANDARDS_MISSING").length, 0, "todos los días tienen estándares vigentes");
    assert.deepEqual(Array.from(new Set(out.rows.map((r) => r.usaliDepartment))).sort(), ["admin_general", "fnb", "pom", "rooms"]);

    const byDay = (offset: number, dept: string) => out.rows.find((r) => r.date === key(offset) && r.usaliDepartment === dept)!;
    // Pasado: cierre auditado (2 ocupadas, 1 llegada, 1 salida, 4 pax) → source actual, pisos con cifra.
    const pastRooms = byDay(-2, "rooms");
    assert.equal(pastRooms.source, "actual");
    assert.deepEqual([pastRooms.drivers.rooms, pastRooms.drivers.arrivals, pastRooms.drivers.departures, pastRooms.drivers.pax], [2, 1, 1, 4]);
    assert.equal(pastRooms.degraded, false);
    assert.ok(Number(pastRooms.requiredFte) > 0);
    assert.equal(pastRooms.estimatedCost, null, "sin lote de coste contabilizado no se inventa coste");
    // Hoy: OTB 2 habitaciones HB (OTB1) → source otb; llegadas = 2 / LOS 2 = 1; cubiertos por régimen HB.
    const todayRooms = byDay(0, "rooms");
    assert.equal(todayRooms.source, "otb");
    assert.equal(todayRooms.drivers.rooms, 2);
    assert.equal(todayRooms.drivers.arrivals, 1);
    const todayFnb = byDay(0, "fnb");
    assert.equal(todayFnb.drivers.pax, 4);
    assert.equal(todayFnb.drivers.coversBreakfast, 4);
    assert.equal(todayFnb.drivers.coversRestaurant, 4);
    assert.ok(Number(todayFnb.requiredHours) > 0);
    // +1: previsión top-level del PMS (3) ≥ OTB (3: 2 HB + 1 BB) → source pms_forecast.
    const plus1 = byDay(1, "rooms");
    assert.equal(plus1.source, "pms_forecast");
    assert.equal(plus1.drivers.rooms, 3);
    // +5: deterministic-v1 sin OTB → NUNCA es driver: sin FTE, degradado con el motivo.
    const plus5 = byDay(5, "rooms");
    assert.equal(plus5.source, null);
    assert.equal(plus5.requiredHours, null);
    assert.equal(plus5.requiredFte, null);
    assert.equal(plus5.degraded, true);
    assert.ok(plus5.degradedReasons.includes("deterministic_without_otb"));
    // +6: ni OTB ni previsión → degradado; mantenimiento y dirección sí se calculan (inventario y puestos fijos).
    const plus6 = byDay(6, "rooms");
    assert.equal(plus6.requiredFte, null);
    assert.ok(plus6.degradedReasons.includes("no_otb_no_forecast"));
    assert.equal(byDay(6, "admin_general").requiredFte, "2.00");
    assert.ok(Number(byDay(6, "pom").requiredHours) > 0);
    assert.equal(byDay(6, "fnb").requiredFte, null);
    // Comparación sin cuadrante, fichas ni plan: null, nunca 0.
    assert.equal(todayRooms.plannedHours, null);
    assert.equal(todayRooms.availableFte, null);
    assert.equal(todayRooms.approvedFte, null);
  });

  it("SELECT de labor_forecasts del tenant: 36 filas, 4 departamentos, ninguna «all», requiredLaborHours = horas del motor", async () => {
    const rows = await prisma.laborForecast.findMany({ where: { propertyId: tenant.propertyA }, orderBy: [{ forecastDate: "asc" }, { usaliDepartment: "asc" }] });
    assert.equal(rows.length, 36);
    assert.deepEqual(Array.from(new Set(rows.map((r) => r.usaliDepartment))).sort(), ["admin_general", "fnb", "pom", "rooms"]);
    assert.equal(rows.filter((r) => r.usaliDepartment === "all").length, 0);
    assert.ok(rows.every((r) => r.generatedAt !== null));
    const todayRows = rows.filter((r) => isoDate(r.forecastDate) === key(0));
    assert.equal(todayRows.length, 4);
    assert.ok(todayRows.every((r) => r.source === "otb"));
    const total = todayRows.reduce((acc, r) => acc + Number(r.requiredLaborHours ?? 0), 0);
    assert.ok(total > 0);
    const plus5 = rows.filter((r) => isoDate(r.forecastDate) === key(5) && r.usaliDepartment === "rooms")[0]!;
    assert.equal(plus5.requiredLaborHours, null);
    assert.equal(plus5.requiredFte, null);
    assert.equal(plus5.source, null);
    assert.equal(await prisma.laborForecast.count({ where: { propertyId: tenant.propertyB } }), 0, "el otro hotel no se toca");
  });

  it("regenerar respeta la clave única: mismas 36 filas (upsert), generatedAt del reloj inyectado (sin dormir), sin duplicados", async () => {
    const before = await prisma.laborForecast.findMany({ where: { propertyId: tenant.propertyA }, select: { id: true, generatedAt: true } });
    // Corrector RRHH · SEC-10: dos relojes distintos por `deps.now`, nunca un setTimeout.
    const later = new Date(Math.max(...before.map((r) => r.generatedAt!.getTime())) + 60_000);
    const out = await forecast.generateLaborForecast({ context: rrhh, propertyId: tenant.propertyA, from: FROM, to: TO, correlationId: CORR }, { now: () => later });
    assert.equal(out.written, 36);
    assert.equal(out.generatedAt, later.toISOString());
    const after = await prisma.laborForecast.findMany({ where: { propertyId: tenant.propertyA }, select: { id: true, generatedAt: true } });
    assert.equal(after.length, 36);
    assert.deepEqual(after.map((r) => r.id).sort(), before.map((r) => r.id).sort(), "mismos ids: upsert, no insert");
    assert.ok(after.every((r) => r.generatedAt!.getTime() === later.getTime()), "todas las filas llevan el reloj inyectado");
    const grouped = await prisma.laborForecast.groupBy({ by: ["forecastDate", "usaliDepartment"], where: { propertyId: tenant.propertyA }, _count: { _all: true } });
    assert.ok(grouped.every((g) => g._count._all === 1));
  });

  it("list con workforce.read: 36 filas, HR_FORECAST_MISSING solo si faltan días; ventana parcial sin previsión lo declara", async () => {
    const out = await forecast.listLaborForecast({ context: lector, propertyId: tenant.propertyA, from: FROM, to: TO });
    assert.equal(out.rows.length, 36);
    assert.equal(out.degraded.filter((d) => d.code === "HR_FORECAST_MISSING").length, 0);
    assert.ok(!("activeFte" in out.rows[0]!), "activeFte es interno: no viaja en el DTO");
    const wider = await forecast.listLaborForecast({ context: lector, propertyId: tenant.propertyA, from: FROM, to: key(8) });
    assert.equal(wider.rows.length, 36);
    assert.equal(wider.degraded.find((d) => d.code === "HR_FORECAST_MISSING")?.message, "2 día(s) de la ventana sin previsión generada.");
  });
});

describe("comparación con plantilla real: turnos, contratos, ausencias y plan aprobado", () => {
  it("fichas con departamento, contratos (100 % y 50 %), una ausencia aprobada hoy y un turno de 8 h → columnas calculadas", async () => {
    const full = await prisma.staffProfile.create({ data: { userId: tenant.users.receptionist.id, propertyId: tenant.propertyA, employeeCode: "HR3-01", usaliDepartment: "rooms", jobTitle: "Camarera de pisos" }, select: { id: true } });
    const half = await prisma.staffProfile.create({ data: { userId: tenant.users.owner.id, propertyId: tenant.propertyA, employeeCode: "HR3-02", usaliDepartment: "rooms", jobTitle: "Recepcionista" }, select: { id: true } });
    profileFull = full.id;
    profileHalf = half.id;
    await prisma.employmentContract.create({ data: { staffProfileId: full.id, propertyId: tenant.propertyA, organizationId: tenant.organizationId, contractType: "indefinido", startDate: day(-100), grossSalary: "1800.00", partTimePct: "100.00", weeklyHours: "40.00", contributionGroup: 6 } });
    await prisma.employmentContract.create({ data: { staffProfileId: half.id, propertyId: tenant.propertyA, organizationId: tenant.organizationId, contractType: "temporal", startDate: day(-30), endDate: day(20), grossSalary: "900.00", partTimePct: "50.00", weeklyHours: "20.00", fixedDiscontinuous: true } });
    await prisma.absenceRequest.create({ data: { propertyId: tenant.propertyA, staffProfileId: full.id, absenceType: "vacation", startDate: day(0), endDate: day(0), status: "approved", requestedBy: tenant.users.receptionist.id, approvedBy: tenant.users.generalManager.id, decidedAt: new Date() } });
    await prisma.shift.create({ data: { propertyId: tenant.propertyA, staffProfileId: half.id, shiftDate: day(0), startAt: new Date(day(0).getTime() + 8 * 3_600_000), endAt: new Date(day(0).getTime() + 16 * 3_600_000), status: "scheduled", roleLabel: "Recepción" } });

    const out = await forecast.listLaborForecast({ context: lector, propertyId: tenant.propertyA, from: key(0), to: key(1) });
    const todayRooms = out.rows.find((r) => r.date === key(0) && r.usaliDepartment === "rooms")!;
    assert.equal(todayRooms.plannedHours, "8.00");
    assert.equal(todayRooms.availableFte, "0.50", "1,5 FTE activos − 1,0 de vacaciones");
    assert.equal(todayRooms.approvedFte, null, "todavía sin plan aprobado");
    const todayFnb = out.rows.find((r) => r.date === key(0) && r.usaliDepartment === "fnb")!;
    assert.equal(todayFnb.plannedHours, "0.00", "hay cuadrante ese día pero ninguno de F&B");
    assert.equal(todayFnb.availableFte, "0.00");
    const tomorrowRooms = out.rows.find((r) => r.date === key(1) && r.usaliDepartment === "rooms")!;
    assert.equal(tomorrowRooms.plannedHours, null, "mañana no hay cuadrante");
    assert.equal(tomorrowRooms.availableFte, "1.50");
  });

  it("plan de plantilla: rrhh prepara (draft), rrhh no aprueba (409 APPROVAL_SELF_DECISION), dirección aprueba, no se reescribe (409) y el position control avisa sin bloquear", async () => {
    const year = TODAY.getUTCFullYear();
    const month = TODAY.getUTCMonth() + 1;
    const body = { year, season: "high", fromMonth: month, toMonth: month, lines: [{ usaliDepartment: "rooms", maxFte: "7" }, { usaliDepartment: "fnb", maxFte: 9, maxHeadcount: 11 }] };
    await expectCode(staffing.upsertStaffingPlan({ context: direccion, propertyId: tenant.propertyA, body, correlationId: CORR }), 403);
    const draft = await staffing.upsertStaffingPlan({ context: rrhh, propertyId: tenant.propertyA, body, correlationId: CORR });
    assert.equal(draft.status, "draft");
    assert.equal(draft.createdBy, rrhh.userId);
    assert.equal(draft.totalMaxFte, "16.00");
    // Reescritura del borrador: mismo plan, líneas sustituidas.
    const redraft = await staffing.upsertStaffingPlan({ context: rrhh, propertyId: tenant.propertyA, body: { ...body, lines: [{ usaliDepartment: "rooms", maxFte: "1.25" }, { usaliDepartment: "fnb", maxFte: 9 }] }, correlationId: CORR });
    assert.equal(redraft.id, draft.id);
    assert.equal(redraft.totalMaxFte, "10.25");
    assert.equal(await prisma.staffingPlanLine.count({ where: { planId: draft.id } }), 2);

    // Quien preparó el plan, aunque tenga la clave de aprobación (polivalencia), no lo aprueba: SoD dinámica.
    const rrhhConAprobacion = { ...rrhh, permissions: [...rrhh.permissions, "hr.staffing.approve"] } as UserContext;
    const self = await expectCode(staffing.approveStaffingPlan({ context: rrhhConAprobacion, propertyId: tenant.propertyA, planId: draft.id, correlationId: CORR }), 409, "APPROVAL_SELF_DECISION");
    assert.equal(self.rule, "preparer_ne_approver");
    await expectCode(staffing.approveStaffingPlan({ context: { ...direccion, permissions: ["workforce.read"] } as UserContext, propertyId: tenant.propertyA, planId: draft.id, correlationId: CORR }), 403);
    await expectCode(staffing.approveStaffingPlan({ context: direccion, propertyId: tenant.propertyB, planId: draft.id, correlationId: CORR }), 404, "HR_STAFFING_PLAN_NOT_FOUND");
    const approved = await staffing.approveStaffingPlan({ context: direccion, propertyId: tenant.propertyA, planId: draft.id, correlationId: CORR });
    assert.equal(approved.status, "approved");
    assert.equal(approved.approvedBy, direccion.userId);
    assert.ok(approved.approvedAt);
    await expectCode(staffing.approveStaffingPlan({ context: direccion, propertyId: tenant.propertyA, planId: draft.id, correlationId: CORR }), 409, "HR_STAFFING_PLAN_ALREADY_APPROVED");
    await expectCode(staffing.upsertStaffingPlan({ context: rrhh, propertyId: tenant.propertyA, body, correlationId: CORR }), 409, "HR_STAFFING_PLAN_ALREADY_APPROVED");

    const listed = await staffing.listStaffingPlans({ context: lector, propertyId: tenant.propertyA, year });
    assert.equal(listed.plans.length, 1);
    assert.equal(listed.plans[0]!.status, "approved");

    // Position control: 1,5 FTE activos en rooms frente a 1,25 aprobados → aviso, nunca bloqueo.
    const headroom = await staffing.checkStaffingHeadroom({ propertyId: tenant.propertyA, usaliDepartment: "rooms", date: key(0) });
    assert.equal(headroom.approvedMaxFte, "1.25");
    assert.equal(headroom.activeFte, "1.50");
    assert.equal(headroom.exceeded, true);
    assert.equal(headroom.warnings.length, 1);
    assert.match(headroom.warnings[0]!, /supera la plantilla máxima aprobada/);
    const fnb = await staffing.checkStaffingHeadroom({ propertyId: tenant.propertyA, usaliDepartment: "fnb", date: key(0), extraFte: 8 });
    assert.equal(fnb.exceeded, false);
    assert.deepEqual(fnb.warnings, []);

    // La lectura de la previsión ya enseña el máximo aprobado del departamento.
    const out = await forecast.listLaborForecast({ context: lector, propertyId: tenant.propertyA, from: key(0), to: key(0) });
    assert.equal(out.rows.find((r) => r.usaliDepartment === "rooms")!.approvedFte, "1.25");
    assert.equal(out.rows.find((r) => r.usaliDepartment === "fnb")!.approvedFte, "9.00");
    assert.equal(out.rows.find((r) => r.usaliDepartment === "pom")!.approvedFte, null);
  });
});

describe("KPIs y alertas (kpis.service)", () => {
  it("getHrKpis con clave de nómina: plantilla 2 (1,50 FTE; 1 fijo discontinuo; 1 vencimiento a 30 días), disponible 0,50, máximo 10,25, necesario del mes; coste null + degraded", async () => {
    await expectCode(kpis.getHrKpis({ context: { ...lector, permissions: ["pms.reservation.read"] } as UserContext, propertyId: tenant.propertyA }), 403);
    const out = await kpis.getHrKpis({ context: direccion, propertyId: tenant.propertyA });
    assert.equal(out.periodCode, key(0).slice(0, 7));
    assert.equal(out.activeHeadcount, 2);
    assert.equal(out.activeFte, "1.50");
    assert.equal(out.fixedDiscontinuousHeadcount, 1);
    assert.equal(out.availableFte, "0.50");
    assert.equal(out.approvedMaxFte, "10.25");
    assert.equal(out.contractsEndingIn30Days, 1);
    assert.ok(out.requiredFte !== null && Number(out.requiredFte) > 0, "FTE del mes desde labor_forecasts");
    assert.equal(out.monthLaborCost, null);
    assert.equal(out.laborCostPctOfSales, null);
    assert.equal(out.costPerEmployee, null);
    assert.ok(out.degraded.some((d) => d.code === "HR_LABOR_COST_MISSING"));
    assert.ok(!out.degraded.some((d) => d.code === "HR_KPI_QUERY_FAILED"), JSON.stringify(out.degraded));
    assert.ok(out.alertsCount >= 1);
    // Sin clave de nómina el coste no se calcula y se declara.
    const sinNomina = await kpis.getHrKpis({ context: lector, propertyId: tenant.propertyA });
    assert.equal(sinNomina.monthLaborCost, null);
    assert.ok(sinNomina.degraded.some((d) => d.code === "HR_PAYROLL_SCOPE_MISSING"));
    assert.equal(sinNomina.activeHeadcount, 2);
    // Mes futuro sin previsión ni plan: null + degraded, nunca 0.
    const futuro = await kpis.getHrKpis({ context: direccion, propertyId: tenant.propertyA, periodCode: `${TODAY.getUTCFullYear() + 2}-03` });
    assert.equal(futuro.requiredFte, null);
    assert.equal(futuro.approvedMaxFte, null);
    assert.ok(futuro.degraded.some((d) => d.code === "HR_FORECAST_MISSING"));
    assert.ok(futuro.degraded.some((d) => d.code === "HR_STAFFING_PLAN_MISSING"));
    await expectCode(kpis.getHrKpis({ context: direccion, propertyId: tenant.propertyA, periodCode: "2026-13" }), 400, "VALIDATION_ERROR");
  });

  it("listHrAlerts: forecast_degraded (+5 y +6), understaffed critical (necesario > disponible), over_approved (1,5 > 1,25) y contract_expiring sin nombres", async () => {
    const out = await kpis.listHrAlerts({ context: lector, propertyId: tenant.propertyA });
    const kinds = new Set(out.alerts.map((a) => a.kind));
    assert.ok(kinds.has("forecast_degraded"), JSON.stringify(out.alerts.map((a) => a.kind)));
    assert.ok(kinds.has("understaffed"));
    assert.ok(kinds.has("over_approved"));
    assert.ok(kinds.has("contract_expiring"));
    const degradedDates = out.alerts.filter((a) => a.kind === "forecast_degraded").map((a) => a.date);
    assert.ok(degradedDates.includes(key(5)) && degradedDates.includes(key(6)));
    const expiring = out.alerts.find((a) => a.kind === "contract_expiring")!;
    assert.equal(expiring.date, key(20));
    assert.equal(expiring.usaliDepartment, "rooms");
    assert.ok(expiring.employeeId === null, "la ficha no tiene expediente: employeeId null");
    assert.doesNotMatch(JSON.stringify(out.alerts), /Propiedad L2|Recepción L2|Dirección general L2|@faranda\.test/);
    assert.equal(out.alerts[0]!.severity, "critical", "orden: críticas primero");
    assert.ok(!kinds.has("headcount_threshold"));
  });
});
