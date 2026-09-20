// Tanda CHK (lote W2-C) · room-assignment.service con DOBLES de Prisma en memoria
// (sin base de datos): el servicio recibe `deps` (db, assignRoom, quoteAvailability,
// audit, now, businessDate) y aquí se sustituyen todos. El doble de Prisma reutiliza
// `matchWhere` / `nextId` del fake del módulo rbac y añade `groupBy` (rotación y
// llegadas pendientes por tipo). Casos del lote: «expira sugerencias anteriores»,
// «confirmar sin roomId usa la primera candidata», «el lote no repite candidatas
// entre llegadas», «preassign no asigna por defecto», «bloqueo solapado 409», más
// `changed` al elegir otra habitación, 403 sin pms.reservation.modify, par ordenado
// de comunicadas (409) y fechas del lote (400).
// Desde apps/api:
//   node --import tsx --test src/modules/pms/__tests__/room-assignment.service.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PermissionKey } from "@hotelos/shared";
import type { UserContext } from "../../../lib/demo-store.js";
import { matchWhere, nextId, type Row, type Tables } from "../../rbac/__tests__/fake-prisma.mts";
import {
  ASSIGNMENT_SUGGESTION_DECIDED,
  PREASSIGN_DISABLED_NOTE,
  confirmSuggestion,
  createRoomBlock,
  createRoomConnection,
  deleteRoomBlock,
  listRoomBlocks,
  listSuggestionsForReservation,
  runBatchForDate,
  suggestForReservation,
  type AssignmentDb,
  type AssignmentDeps
} from "../room-assignment.service.js";

// ---------------------------------------------------------------------------
// Doble de Prisma (subconjunto que usa el servicio)
// ---------------------------------------------------------------------------

const MODELS = ["property", "reservation", "room", "roomType", "workOrder", "roomBlock", "roomConnection", "propertyCheckInPolicy", "assignmentSuggestion", "reservationGuest", "guest", "stay", "checkInSession"] as const;

type Args = { where?: Record<string, unknown>; orderBy?: unknown; take?: number; data?: Record<string, unknown>; select?: unknown; by?: string[]; _count?: unknown };

function scalar(value: unknown): number | string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" || typeof value === "boolean") return Number(value);
  return String(value);
}

function orderRows(rows: Row[], orderBy: unknown): Row[] {
  if (!orderBy) return rows;
  const clauses = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Array<Record<string, "asc" | "desc">>;
  return rows.slice().sort((a, b) => {
    for (const clause of clauses) {
      for (const [field, direction] of Object.entries(clause)) {
        const x = scalar(a[field]);
        const y = scalar(b[field]);
        if (x === y) continue;
        if (x === null) return 1;
        if (y === null) return -1;
        const result = x < y ? -1 : 1;
        return direction === "desc" ? -result : result;
      }
    }
    return 0;
  });
}

const CLOCK_BASE = Date.UTC(2026, 9, 1, 9, 0, 0);
let tick = 0;

function delegate(tables: Tables, model: string) {
  const rows = (): Row[] => (tables[model] ??= []);
  const query = (args: Args = {}): Row[] => {
    let out = rows().filter((row) => matchWhere(row, args.where));
    out = orderRows(out, args.orderBy);
    if (args.take !== undefined) out = out.slice(0, args.take);
    return out.map((row) => ({ ...row }));
  };
  return {
    findMany: async (args: Args = {}) => query(args),
    findFirst: async (args: Args = {}) => query({ ...args, take: 1 })[0] ?? null,
    findUnique: async (args: Args = {}) => query({ ...args, take: 1 })[0] ?? null,
    count: async (args: Args = {}) => query(args).length,
    create: async (args: Args) => {
      // Reloj monótono: dos filas creadas en el mismo milisegundo se ordenan igual que en Postgres (createdAt, id).
      tick += 1;
      const row: Row = { id: nextId(model), createdAt: new Date(CLOCK_BASE + tick), ...(args.data as Record<string, unknown>) };
      rows().push(row);
      return { ...row };
    },
    update: async (args: Args) => {
      const index = rows().findIndex((row) => matchWhere(row, args.where));
      if (index < 0) throw Object.assign(new Error(`fake prisma: ${model} row not found`), { code: "P2025" });
      rows()[index] = { ...rows()[index], ...(args.data as Record<string, unknown>) };
      return { ...rows()[index] };
    },
    updateMany: async (args: Args) => {
      let count = 0;
      const all = rows();
      for (let index = 0; index < all.length; index += 1) {
        if (!matchWhere(all[index], args.where)) continue;
        all[index] = { ...all[index], ...(args.data as Record<string, unknown>) };
        count += 1;
      }
      return { count };
    },
    deleteMany: async (args: Args = {}) => {
      const before = rows().length;
      tables[model] = rows().filter((row) => !matchWhere(row, args.where));
      return { count: before - tables[model].length };
    },
    groupBy: async (args: Args) => {
      const by = args.by ?? [];
      const groups = new Map<string, Row & { _count: { _all: number } }>();
      for (const row of rows().filter((candidate) => matchWhere(candidate, args.where))) {
        const key = by.map((field) => String(row[field])).join("|");
        const group = groups.get(key) ?? { ...Object.fromEntries(by.map((field) => [field, row[field]])), _count: { _all: 0 } };
        group._count._all += 1;
        groups.set(key, group);
      }
      return Array.from(groups.values());
    }
  };
}

type Fake = Record<(typeof MODELS)[number], ReturnType<typeof delegate>> & { $tables: Tables };

function fakeDb(seed: Partial<Tables>): Fake {
  const tables: Tables = {};
  for (const model of MODELS) tables[model] = (seed[model] ?? []).map((row) => ({ ...row }));
  const client = { $tables: tables } as Record<string, unknown>;
  for (const model of MODELS) client[model] = delegate(tables, model);
  return client as Fake;
}

// ---------------------------------------------------------------------------
// Fixture: hotel de 9 habitaciones (6 DBL + 3 SUP), 3 llegadas DBL el 2026-10-02
// ---------------------------------------------------------------------------

const ORG = "org_ra";
const PROP = "prop_ra";
const DBL = "rt_ra_dbl";
const SUP = "rt_ra_sup";
const ARRIVAL = "2026-10-02";
const DEPARTURE = "2026-10-04";
const NOW = new Date("2026-10-01T10:00:00.000Z");

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function room(number: string, roomTypeId: string, extra: Partial<Row> = {}): Row {
  return {
    id: `room_${number}`,
    propertyId: PROP,
    roomTypeId,
    number,
    floor: number.slice(0, 1),
    floorId: null,
    viewType: Number(number) % 2 === 1 ? "sea" : "city",
    maxOccupancy: null,
    bedConfigurationJson: {},
    featuresJson: {},
    accessibilityJson: {},
    status: "clean",
    housekeepingStatus: "clean",
    maintenanceStatus: "ok",
    sellable: true,
    active: true,
    ...extra
  };
}

function reservation(code: string, extra: Partial<Row> = {}): Row {
  return {
    id: `res_${code}`,
    propertyId: PROP,
    code,
    status: "confirmed",
    arrivalDate: day(ARRIVAL),
    departureDate: day(DEPARTURE),
    adults: 2,
    children: 0,
    roomTypeId: DBL,
    assignedRoomId: null,
    eta: null,
    estimatedArrivalTime: null,
    vipFlag: false,
    accessibilityNeeds: null,
    groupCode: null,
    groupBookingId: null,
    specialRequests: null,
    deletedAt: null,
    ...extra
  };
}

type Setup = {
  db: Fake;
  deps: Partial<AssignmentDeps>;
  audit: Array<Record<string, unknown>>;
  assignCalls: Array<{ reservationId: string; roomId: string }>;
  ctx: (permissions: readonly PermissionKey[], userId?: string) => UserContext;
};

function setup(options: { policy?: Partial<Row>; extraRows?: Partial<Tables> } = {}): Setup {
  const db = fakeDb({
    property: [{ id: PROP, organizationId: ORG }, { id: "prop_other", organizationId: "org_other" }],
    roomType: [
      { id: DBL, propertyId: PROP, code: "DBL", displayOrder: 1, maxOccupancy: 2 },
      { id: SUP, propertyId: PROP, code: "SUP", displayOrder: 2, maxOccupancy: 3 }
    ],
    room: [room("101", DBL), room("102", DBL), room("103", DBL), room("104", DBL), room("105", DBL), room("106", DBL), room("201", SUP), room("202", SUP), room("203", SUP)],
    reservation: [reservation("R1"), reservation("R2"), reservation("R3")],
    reservationGuest: [
      { id: "rg_1", reservationId: "res_R1", guestId: "g_1", isPrimary: true },
      { id: "rg_2", reservationId: "res_R2", guestId: "g_2", isPrimary: true },
      { id: "rg_3", reservationId: "res_R3", guestId: "g_3", isPrimary: true }
    ],
    guest: [
      { id: "g_1", organizationId: ORG, vipCode: null, loyaltyTier: null, preferencesJson: ["view_sea"], deletedAt: null },
      { id: "g_2", organizationId: ORG, vipCode: null, loyaltyTier: null, preferencesJson: null, deletedAt: null },
      { id: "g_3", organizationId: ORG, vipCode: null, loyaltyTier: null, preferencesJson: null, deletedAt: null }
    ],
    // Fila completa (toPolicyDto de W2-A lee todas las columnas del modelo).
    propertyCheckInPolicy: options.policy
      ? [
          {
            id: "pol_1",
            propertyId: PROP,
            selfCheckInEnabled: false,
            inviteDaysBefore: 3,
            reminderDaysBefore: 1,
            allowedVerificationMethodsJson: ["visual_reception"],
            requireVisualCheckAtKiosk: true,
            requireInspectedRoom: false,
            depositPolicy: "balance",
            depositAmount: null,
            allowWalkIn: false,
            allowUpgradeSuggestion: true,
            autoAssignLevel: "suggest_and_confirm",
            assignmentWeightsJson: {},
            welcomeChannelOrderJson: ["email"],
            guestConsentText: null,
            aiDisclosureText: null,
            createdAt: NOW,
            updatedAt: NOW,
            ...options.policy
          }
        ]
      : [],
    ...(options.extraRows ?? {})
  });
  const audit: Array<Record<string, unknown>> = [];
  const assignCalls: Array<{ reservationId: string; roomId: string }> = [];
  const deps: Partial<AssignmentDeps> = {
    db: db as unknown as AssignmentDb,
    now: () => NOW,
    businessDate: async () => "2026-10-01",
    audit: ((input: Record<string, unknown>) => {
      audit.push(input);
      return input;
    }) as unknown as AssignmentDeps["audit"],
    quoteAvailability: async () => [],
    assignRoom: (async (input: { reservationId: string; roomId: string }) => {
      assignCalls.push({ reservationId: input.reservationId, roomId: input.roomId });
      const updated = await db.reservation.update({ where: { id: input.reservationId }, data: { assignedRoomId: input.roomId } });
      return updated;
    }) as unknown as AssignmentDeps["assignRoom"]
  };
  const ctx = (permissions: readonly PermissionKey[], userId = "usr_recepcion"): UserContext => ({ organizationId: ORG, propertyId: PROP, userId, fullName: userId, deviceId: "dev", permissions: [...permissions] });
  return { db, deps, audit, assignCalls, ctx };
}

const READ: PermissionKey[] = ["pms.reservation.read"];
const MODIFY: PermissionKey[] = ["pms.reservation.read", "pms.reservation.modify"];
const status = (error: unknown) => (error as { statusCode?: number }).statusCode;
const code = (error: unknown) => (error as { details?: { code?: string } }).details?.code;

// ---------------------------------------------------------------------------

describe("CHK W2-C · suggestForReservation", () => {
  it("persiste top-3 con motivos en español y expira las sugerencias anteriores de la reserva", async () => {
    const { db, deps, ctx } = setup();
    const first = await suggestForReservation({ context: ctx(READ), reservationId: "res_R1" }, deps);
    assert.equal(first.persisted, true);
    assert.equal(first.status, "suggested");
    assert.equal(first.automationLevel, "suggest_and_confirm");
    assert.equal(first.candidates.length, 3);
    assert.ok(first.candidates.every((candidate) => candidate.reasons.some((reason) => reason.detail === "Limpia")));
    // g_1 prefiere vista al mar: las impares (101, 103, 105) puntúan más que las pares.
    assert.deepEqual(first.candidates.map((candidate) => candidate.number), ["101", "103", "105"]);
    assert.ok(first.candidates[0]!.reasons.some((reason) => reason.detail === "Vista al mar como pidió"));
    // Las SUP quedan rechazadas porque quedan DBL (mejora solo sin tipo reservado).
    assert.ok(first.rejected.some((rejection) => rejection.number === "201" && /Tipo superior/.test(rejection.reason)));
    assert.equal(first.rejectedCount, first.rejected.length);

    const second = await suggestForReservation({ context: ctx(READ), reservationId: "res_R1" }, deps);
    assert.notEqual(second.id, first.id);
    const rows = db.$tables.assignmentSuggestion!.filter((row) => row.reservationId === "res_R1");
    assert.equal(rows.length, 2);
    assert.equal(rows.find((row) => row.id === first.id)!.status, "expired");
    assert.equal(rows.find((row) => row.id === second.id)!.status, "suggested");

    const list = await listSuggestionsForReservation({ context: ctx(READ), reservationId: "res_R1" }, deps);
    assert.deepEqual(list.map((item) => item.status), ["suggested", "expired"]);
  });

  it("persist:false no escribe y devuelve id vacío", async () => {
    const { db, deps, ctx } = setup();
    const out = await suggestForReservation({ context: ctx(READ), reservationId: "res_R1", persist: false }, deps);
    assert.equal(out.persisted, false);
    assert.equal(out.id, "");
    assert.equal(out.candidates.length, 3);
    assert.equal(db.$tables.assignmentSuggestion!.length, 0);
  });

  it("aplica la política: requireInspectedRoom deja fuera las limpias y allowUpgrade=false rechaza las SUP", async () => {
    const { deps, ctx } = setup({ policy: { requireInspectedRoom: true, allowUpgradeSuggestion: false } });
    const out = await suggestForReservation({ context: ctx(READ), reservationId: "res_R1" }, deps);
    assert.equal(out.candidates.length, 0);
    assert.ok(out.rejected.some((rejection) => /exige habitación inspeccionada/.test(rejection.reason)));
    assert.ok(out.rejected.some((rejection) => rejection.number === "201" && /la política no permite mejora/.test(rejection.reason)));
    assert.ok(out.dataNotes.includes("ninguna habitación cumple los filtros"));
  });

  it("una habitación bloqueada en las fechas nunca aparece; una con orden de trabajo abierta tampoco", async () => {
    const { deps, ctx } = setup({
      extraRows: {
        roomBlock: [{ id: "blk_1", propertyId: PROP, roomId: "room_101", fromDate: day("2026-10-03"), toDate: day("2026-10-05"), reason: "maintenance", createdBy: "u", workOrderId: null, note: null }],
        workOrder: [{ id: "wo_1", propertyId: PROP, roomId: "room_103", status: "open" }]
      }
    });
    const out = await suggestForReservation({ context: ctx(READ), reservationId: "res_R1" }, deps);
    assert.ok(!out.candidates.some((candidate) => candidate.number === "101"));
    assert.ok(!out.candidates.some((candidate) => candidate.number === "103"));
    assert.ok(out.rejected.some((rejection) => rejection.number === "101" && rejection.reason === "Bloqueada del 2026-10-03 al 2026-10-05"));
    assert.ok(out.rejected.some((rejection) => rejection.number === "103" && rejection.reason === "Orden de trabajo abierta"));
  });

  it("protección de inventario: solo para tipos distintos del reservado (la mejora a la última SUP con llegada pendiente se penaliza)", async () => {
    const { deps, ctx } = setup({
      extraRows: {
        reservation: [
          reservation("R1"),
          reservation("R2"),
          reservation("R9", { roomTypeId: SUP }),
          // Las 6 DBL están asignadas a otras reservas solapadas → R1 solo puede ir a una SUP (mejora).
          ...["101", "102", "103", "104", "105", "106"].map((number) => reservation(`T${number}`, { assignedRoomId: `room_${number}` }))
        ]
      }
    });
    const quoting: Partial<AssignmentDeps> = {
      ...deps,
      quoteAvailability: (async () => [
        { roomTypeId: DBL, availableRooms: 0 },
        { roomTypeId: SUP, availableRooms: 1 }
      ]) as unknown as AssignmentDeps["quoteAvailability"]
    };
    // R1 (DBL, sin DBL libres): candidatas SUP con mejora −10 y protección −20 (última SUP, R9 pendiente).
    const upgraded = await suggestForReservation({ context: ctx(READ), reservationId: "res_R1" }, quoting);
    // g_1 prefiere vista al mar (impares): 201 y 203 antes que 202.
    assert.deepEqual(upgraded.candidates.map((candidate) => candidate.number), ["201", "203", "202"]);
    for (const candidate of upgraded.candidates) {
      assert.ok(candidate.reasons.some((reason) => reason.rule === "free_upgrade" && reason.weight === -10));
      assert.ok(candidate.reasons.some((reason) => reason.rule === "inventory_protection" && /1 llegada pendiente/.test(reason.detail)));
    }
    // R9 (SUP, su propio tipo con available 1 y R1 pendiente de DBL): NUNCA se penaliza a sí misma.
    const own = await suggestForReservation({ context: ctx(READ), reservationId: "res_R9" }, quoting);
    assert.equal(own.candidates.length, 3);
    assert.ok(own.candidates.every((candidate) => !candidate.reasons.some((reason) => reason.rule === "inventory_protection")));
  });

  it("404 opaco con reserva de otra organización; 403 sin pms.reservation.read", async () => {
    const { deps, ctx } = setup({ extraRows: { reservation: [reservation("R1"), reservation("X1", { id: "res_X1", propertyId: "prop_other" })] } });
    await assert.rejects(suggestForReservation({ context: ctx(READ), reservationId: "res_X1" }, deps), (error: unknown) => status(error) === 404);
    await assert.rejects(suggestForReservation({ context: ctx([]), reservationId: "res_R1" }, deps), (error: Error) => error.name === "PermissionDeniedError");
  });
});

describe("CHK W2-C · confirmSuggestion", () => {
  it("confirmar sin roomId usa la primera candidata: assignRoom, confirmed, decidedBy/decidedAt y auditoría", async () => {
    const { db, deps, ctx, audit, assignCalls } = setup();
    const suggestion = await suggestForReservation({ context: ctx(READ), reservationId: "res_R1" }, deps);
    const out = await confirmSuggestion({ context: ctx(MODIFY, "usr_jefa"), suggestionId: suggestion.id }, deps);
    assert.deepEqual(assignCalls, [{ reservationId: "res_R1", roomId: "room_101" }]);
    assert.equal(out.suggestion.status, "confirmed");
    assert.equal(out.suggestion.chosenRoomId, "room_101");
    assert.equal(out.suggestion.decidedBy, "usr_jefa");
    assert.equal(out.suggestion.decidedAt, NOW.toISOString());
    assert.equal(db.$tables.reservation!.find((row) => row.id === "res_R1")!.assignedRoomId, "room_101");
    const event = audit.find((item) => item.action === ASSIGNMENT_SUGGESTION_DECIDED);
    assert.ok(event, "auditoría ASSIGNMENT_SUGGESTION_DECIDED");
    assert.equal(event!.entityType, "assignment_suggestion");
    assert.equal(event!.entityId, suggestion.id);
    assert.equal((event!.beforeJson as { status: string }).status, "suggested");
    assert.equal((event!.afterJson as { status: string }).status, "confirmed");

    // Segunda decisión sobre la misma sugerencia → 409, sin nueva asignación.
    await assert.rejects(confirmSuggestion({ context: ctx(MODIFY), suggestionId: suggestion.id }, deps), (error: unknown) => status(error) === 409 && code(error) === "ASSIGNMENT_SUGGESTION_DECIDED");
    assert.equal(assignCalls.length, 1);
  });

  it("changed cuando se elige una habitación que no estaba entre las candidatas", async () => {
    const { deps, ctx, assignCalls } = setup();
    const suggestion = await suggestForReservation({ context: ctx(READ), reservationId: "res_R1" }, deps);
    const out = await confirmSuggestion({ context: ctx(MODIFY), suggestionId: suggestion.id, roomId: "room_106" }, deps);
    assert.equal(out.suggestion.status, "changed");
    assert.equal(out.suggestion.chosenRoomId, "room_106");
    assert.deepEqual(assignCalls, [{ reservationId: "res_R1", roomId: "room_106" }]);
  });

  it("confirmed también cuando se elige la segunda o tercera candidata", async () => {
    const { deps, ctx } = setup();
    const suggestion = await suggestForReservation({ context: ctx(READ), reservationId: "res_R1" }, deps);
    const out = await confirmSuggestion({ context: ctx(MODIFY), suggestionId: suggestion.id, roomId: suggestion.candidates[2]!.roomId }, deps);
    assert.equal(out.suggestion.status, "confirmed");
  });

  it("sin pms.reservation.modify no confirma (PermissionDeniedError, sin llamar a assignRoom)", async () => {
    const { deps, ctx, assignCalls } = setup();
    const suggestion = await suggestForReservation({ context: ctx(READ), reservationId: "res_R1" }, deps);
    await assert.rejects(confirmSuggestion({ context: ctx(READ), suggestionId: suggestion.id }, deps), (error: Error) => error.name === "PermissionDeniedError");
    assert.equal(assignCalls.length, 0);
  });

  it("si assignRoom falla (409 de solape) la sugerencia sigue suggested", async () => {
    const { db, deps, ctx } = setup();
    const suggestion = await suggestForReservation({ context: ctx(READ), reservationId: "res_R1" }, deps);
    const failing: Partial<AssignmentDeps> = {
      ...deps,
      assignRoom: (async () => {
        throw Object.assign(new Error("No se puede asignar la habitación 101: solapa."), { statusCode: 409 });
      }) as unknown as AssignmentDeps["assignRoom"]
    };
    await assert.rejects(confirmSuggestion({ context: ctx(MODIFY), suggestionId: suggestion.id }, failing), (error: unknown) => status(error) === 409);
    assert.equal(db.$tables.assignmentSuggestion!.find((row) => row.id === suggestion.id)!.status, "suggested");
  });
});

describe("CHK W2-C · runBatchForDate", () => {
  it("el lote no repite candidatas entre llegadas y crea una sugerencia por llegada", async () => {
    const { db, deps, ctx } = setup();
    const out = await runBatchForDate({ context: ctx(MODIFY), propertyId: PROP, date: ARRIVAL }, deps);
    assert.equal(out.suggested, 3);
    assert.equal(out.skipped, 0);
    assert.deepEqual(out.failed, []);
    assert.equal(out.automationLevel, "suggest_and_confirm");
    const proposed = out.items.map((item) => item.proposedRoomNumber);
    assert.equal(new Set(proposed).size, 3, `candidatas repetidas: ${proposed.join(", ")}`);
    assert.equal(db.$tables.assignmentSuggestion!.filter((row) => row.status === "suggested").length, 3);
    // La segunda llegada ve la 101 (propuesta a R1) como rechazada con motivo de lote.
    const second = db.$tables.assignmentSuggestion!.find((row) => row.reservationId === "res_R2")!;
    assert.ok(!(second.candidatesJson as Array<{ number: string }>).some((candidate) => candidate.number === proposed[0]));
    assert.ok(out.items[1]!.rejected >= 1);
    // Nadie queda asignado: el lote solo sugiere.
    assert.ok(db.$tables.reservation!.every((row) => row.assignedRoomId === null));
  });

  it("preassign no asigna por defecto (D4): sugerencias con automationLevel preassign y nota, sin assignRoom", async () => {
    const { db, deps, ctx, assignCalls } = setup({ policy: { autoAssignLevel: "preassign" } });
    const out = await runBatchForDate({ context: ctx(MODIFY), propertyId: PROP, date: ARRIVAL }, deps);
    assert.equal(out.automationLevel, "preassign");
    assert.equal(out.suggested, 3);
    assert.ok(out.items.every((item) => item.dataNotes.includes(PREASSIGN_DISABLED_NOTE)));
    assert.equal(assignCalls.length, 0);
    assert.ok(db.$tables.reservation!.every((row) => row.assignedRoomId === null));
    assert.ok(db.$tables.assignmentSuggestion!.every((row) => row.automationLevel === "preassign" && row.status === "suggested"));
  });

  it("sin date usa el día siguiente a la fecha de negocio; date inválida → 400; ya asignadas y de otro día no entran", async () => {
    const { deps, ctx } = setup({
      extraRows: {
        reservation: [
          reservation("R1"),
          reservation("R2", { assignedRoomId: "room_106" }),
          reservation("R3", { arrivalDate: day("2026-10-03"), departureDate: day("2026-10-05") }),
          reservation("R4", { status: "checked_in", assignedRoomId: "room_105", arrivalDate: day("2026-10-01") })
        ]
      }
    });
    const out = await runBatchForDate({ context: ctx(MODIFY), propertyId: PROP }, deps);
    assert.equal(out.date, ARRIVAL);
    assert.deepEqual(out.items.map((item) => item.code), ["R1"]);
    // La 105 (in-house) y la 106 (asignada a R2) nunca son candidatas.
    assert.ok(!["105", "106"].includes(out.items[0]!.proposedRoomNumber ?? ""));
    await assert.rejects(runBatchForDate({ context: ctx(MODIFY), propertyId: PROP, date: "02/10/2026" }, deps), (error: unknown) => status(error) === 400);
  });

  it("catch honesto (QC-06): una reserva que falla al persistir cuenta en failed con su motivo y el resto sigue", async () => {
    const { db, deps, ctx } = setup();
    const create = db.assignmentSuggestion.create;
    db.assignmentSuggestion.create = async (args) => {
      if ((args.data as { reservationId: string }).reservationId === "res_R2") throw new Error("fallo simulado al persistir");
      return create(args);
    };
    const out = await runBatchForDate({ context: ctx(MODIFY), propertyId: PROP, date: ARRIVAL }, deps);
    assert.equal(out.suggested, 2);
    assert.equal(out.skipped, 0);
    assert.deepEqual(out.failed, [{ reservationId: "res_R2", code: "R2", error: "fallo simulado al persistir" }]);
    assert.deepEqual(out.items.map((item) => item.code), ["R1", "R3"]);
    assert.equal(db.$tables.assignmentSuggestion!.length, 2);
  });

  it("skipped cuando ninguna habitación cumple los filtros (sin fila persistida)", async () => {
    const { db, deps, ctx } = setup({ policy: { requireInspectedRoom: true, allowUpgradeSuggestion: false } });
    const out = await runBatchForDate({ context: ctx(MODIFY), propertyId: PROP, date: ARRIVAL }, deps);
    assert.equal(out.suggested, 0);
    assert.equal(out.skipped, 3);
    assert.ok(out.items.every((item) => item.suggestionId === null && item.candidates === 0 && item.rejected > 0));
    assert.equal(db.$tables.assignmentSuggestion!.length, 0);
  });
});

describe("CHK W2-C · bloqueos y comunicadas", () => {
  it("bloqueo solapado 409; fechas inválidas 400; borrar y listar", async () => {
    const { deps, ctx, audit } = setup();
    const created = await createRoomBlock({ context: ctx(MODIFY), propertyId: PROP, roomId: "room_101", fromDate: "2026-10-05", toDate: "2026-10-07", reason: "deep_clean", note: "  limpieza a fondo " }, deps);
    assert.equal(created.fromDate, "2026-10-05");
    assert.equal(created.toDate, "2026-10-07");
    assert.equal(created.note, "limpieza a fondo");
    assert.equal(created.createdBy, "usr_recepcion");
    assert.ok(audit.some((event) => event.action === "ROOM_BLOCK_CREATED" && event.entityId === created.id));

    await assert.rejects(
      createRoomBlock({ context: ctx(MODIFY), propertyId: PROP, roomId: "room_101", fromDate: "2026-10-07", toDate: "2026-10-09", reason: "maintenance" }, deps),
      (error: unknown) => status(error) === 409 && code(error) === "ROOM_BLOCK_OVERLAP"
    );
    await assert.rejects(createRoomBlock({ context: ctx(MODIFY), propertyId: PROP, roomId: "room_101", fromDate: "2026-10-09", toDate: "2026-10-08", reason: "maintenance" }, deps), (error: unknown) => status(error) === 400);
    await assert.rejects(createRoomBlock({ context: ctx(MODIFY), propertyId: PROP, roomId: "room_101", fromDate: "2026-10-09", toDate: "2026-10-10", reason: "fiesta" }, deps), (error: unknown) => status(error) === 400);
    await assert.rejects(createRoomBlock({ context: ctx(MODIFY), propertyId: PROP, roomId: "room_999", fromDate: "2026-10-09", toDate: "2026-10-10", reason: "owner" }, deps), (error: unknown) => status(error) === 404);
    // Otra habitación con las mismas fechas sí.
    const other = await createRoomBlock({ context: ctx(MODIFY), propertyId: PROP, roomId: "room_102", fromDate: "2026-10-05", toDate: "2026-10-07", reason: "event" }, deps);
    // El día siguiente al bloqueo de la 101 ya no solapa.
    await createRoomBlock({ context: ctx(MODIFY), propertyId: PROP, roomId: "room_101", fromDate: "2026-10-08", toDate: "2026-10-08", reason: "other" }, deps);

    const all = await listRoomBlocks({ context: ctx(READ), propertyId: PROP }, deps);
    assert.equal(all.length, 3);
    const window = await listRoomBlocks({ context: ctx(READ), propertyId: PROP, from: "2026-10-08", to: "2026-10-09" }, deps);
    assert.deepEqual(window.map((block) => block.roomId), ["room_101"]);

    await deleteRoomBlock({ context: ctx(MODIFY), blockId: other.id }, deps);
    assert.equal((await listRoomBlocks({ context: ctx(READ), propertyId: PROP }, deps)).length, 2);
    await assert.rejects(deleteRoomBlock({ context: ctx(MODIFY), blockId: other.id }, deps), (error: unknown) => status(error) === 404);
    await assert.rejects(createRoomBlock({ context: ctx(READ), propertyId: PROP, roomId: "room_103", fromDate: "2026-10-09", toDate: "2026-10-10", reason: "owner" }, deps), (error: Error) => error.name === "PermissionDeniedError");
  });

  it("comunicadas: par ordenado por propiedad (409 al repetir en cualquier orden), misma habitación 400, tipo inválido 400", async () => {
    const { deps, ctx } = setup();
    const created = await createRoomConnection({ context: ctx(MODIFY), propertyId: PROP, roomAId: "room_102", roomBId: "room_101", kind: "connecting" }, deps);
    assert.deepEqual([created.roomAId, created.roomBId], ["room_101", "room_102"]);
    await assert.rejects(createRoomConnection({ context: ctx(MODIFY), propertyId: PROP, roomAId: "room_101", roomBId: "room_102", kind: "adjacent" }, deps), (error: unknown) => status(error) === 409 && code(error) === "ROOM_CONNECTION_EXISTS");
    await assert.rejects(createRoomConnection({ context: ctx(MODIFY), propertyId: PROP, roomAId: "room_101", roomBId: "room_101", kind: "connecting" }, deps), (error: unknown) => status(error) === 400);
    await assert.rejects(createRoomConnection({ context: ctx(MODIFY), propertyId: PROP, roomAId: "room_101", roomBId: "room_103", kind: "puerta" }, deps), (error: unknown) => status(error) === 400);
    await assert.rejects(createRoomConnection({ context: ctx(MODIFY), propertyId: PROP, roomAId: "room_101", roomBId: "room_999", kind: "connecting" }, deps), (error: unknown) => status(error) === 404);

    // La conexión alimenta la preferencia «connecting» del motor.
    const { db } = setup({ extraRows: { guest: [{ id: "g_1", organizationId: ORG, vipCode: null, loyaltyTier: null, preferencesJson: ["connecting"], deletedAt: null }] } });
    db.$tables.roomConnection!.push({ id: "rc_1", propertyId: PROP, roomAId: "room_101", roomBId: "room_102", kind: "connecting" });
    const out = await suggestForReservation({ context: ctx(READ), reservationId: "res_R1" }, { ...deps, db: db as unknown as AssignmentDb });
    assert.ok(out.candidates.slice(0, 2).every((candidate) => ["101", "102"].includes(candidate.number)));
    assert.ok(out.candidates[0]!.reasons.some((reason) => reason.detail === "Comunicada con una habitación libre como pidió"));
  });
});
