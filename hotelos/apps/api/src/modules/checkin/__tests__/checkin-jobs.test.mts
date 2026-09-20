// Unit tests · Tanda CHK · lote W3-C — jobs del líder del check-in
// (checkin-jobs.ts) con dobles: base de datos en memoria (política, reservas,
// sesiones, worker_job_runs), invitación/lote/purga/auditoría grabados en
// listas, reloj fijo en Europe/Madrid. Sin base de datos, sin red. Desde apps/api:
//   node --import tsx --test src/modules/checkin/__tests__/checkin-jobs.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { recordAuditEvent } from "../../audit/audit.service.js";
import {
  CHECKIN_ASSIGNMENT_JOB_NAME,
  CHECKIN_JOBS_DEFAULT_INTERVAL_MS,
  CHECKIN_JOBS_LOCK_KEY,
  CHECKIN_JOBS_MIN_INTERVAL_MS,
  CHECKIN_JOBS_QUEUE_NAME,
  CHECKIN_REMINDER_TEMPLATE,
  addDays,
  checkinJobsIntervalMs,
  dateOnly,
  isAssignmentDue,
  localClock,
  runCheckinJobsTick,
  shouldStartCheckinJobs,
  startCheckinJobs,
  type CheckinJobsDb,
  type CheckinJobsDeps
} from "../checkin-jobs.js";
import type { InvitationResult } from "../checkin-session.service.js";
import { CHECKIN_SERVICE_PERMISSIONS, buildServiceContext } from "../service-context.js";

// ── Reloj: 2026-09-19 (sábado) · CEST = UTC+2 ────────────────────────────────
const TODAY = "2026-09-19";
const MORNING = new Date("2026-09-19T08:30:00.000Z"); // 10:30 Madrid
const BEFORE_RUN_AT = new Date("2026-09-19T15:30:00.000Z"); // 17:30 Madrid
const AFTER_RUN_AT = new Date("2026-09-19T16:05:00.000Z"); // 18:05 Madrid
const LATER = new Date("2026-09-19T17:00:00.000Z"); // 19:00 Madrid
const NEXT_DAY = new Date("2026-09-20T16:00:00.000Z"); // 18:00 Madrid del día siguiente
const YESTERDAY_NOON = new Date("2026-09-18T10:00:00.000Z");

const day = (offset: number): Date => dateOnly(addDays(TODAY, offset));

// ── Base de datos en memoria ─────────────────────────────────────────────────

type PolicyRow = { propertyId: string; selfCheckInEnabled: boolean; inviteDaysBefore: number; reminderDaysBefore: number };
type ReservationRow = { id: string; propertyId: string; code: string; status: string; deletedAt: Date | null; arrivalDate: Date; departureDate: Date };
type SessionRow = { id: string; reservationId: string; propertyId: string; organizationId: string; status: string; reminderAt: Date | null; invitedAt: Date | null; createdAt: Date };
type RunRow = Record<string, unknown> & { id: string; jobName: string; propertyId: string | null; scheduledFor: Date | null; status: string };

type State = { policies: PolicyRow[]; reservations: ReservationRow[]; sessions: SessionRow[]; runs: RunRow[] };

function num(value: unknown): number {
  return value instanceof Date ? value.getTime() : typeof value === "number" ? value : Number.NaN;
}

/** Evaluador mínimo de `where` de Prisma para los operadores que usa el job (igualdad, null, in, gte/lte/lt). */
function matches(row: Record<string, unknown>, where: Record<string, unknown> | undefined): boolean {
  for (const [key, cond] of Object.entries(where ?? {})) {
    const value = row[key];
    if (cond === null) {
      if (value !== null && value !== undefined) return false;
      continue;
    }
    if (cond instanceof Date) {
      if (!(value instanceof Date) || value.getTime() !== cond.getTime()) return false;
      continue;
    }
    if (cond && typeof cond === "object") {
      const c = cond as Record<string, unknown>;
      if ("in" in c && !(c.in as unknown[]).includes(value)) return false;
      if ("gte" in c && !(num(value) >= num(c.gte))) return false;
      if ("lte" in c && !(num(value) <= num(c.lte))) return false;
      if ("lt" in c && !(num(value) < num(c.lt))) return false;
      continue;
    }
    if (value !== cond) return false;
  }
  return true;
}

type StubOptions = { locked?: boolean; failReservationsFor?: string };

/** Ids de WorkerJobRun únicos entre stubs (varias vueltas comparten el mismo `state`). */
let runSeq = 0;

function stubDb(state: State, options: StubOptions = {}): { db: CheckinJobsDb; calls: string[] } {
  const calls: string[] = [];
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(`lock:${String(values[0])}`);
      assert.match(strings.join("?"), /pg_try_advisory_xact_lock\(hashtext\(\?\)\)/);
      return [{ locked: options.locked ?? true }];
    }
  };
  const db = {
    $transaction: async (fn: (client: unknown) => Promise<unknown>) => fn(tx),
    propertyCheckInPolicy: {
      findMany: async (args: { where?: Record<string, unknown> }) => state.policies.filter((row) => matches(row, args.where))
    },
    reservation: {
      findMany: async (args: { where?: Record<string, unknown> }) => {
        if (options.failReservationsFor && args.where?.propertyId === options.failReservationsFor) throw new Error("db down");
        return state.reservations.filter((row) => matches(row, args.where));
      }
    },
    checkInSession: {
      findMany: async (args: { where?: Record<string, unknown> }) => state.sessions.filter((row) => matches(row, args.where)),
      update: async (args: { where: { id: string }; data: Partial<SessionRow> }) => {
        const row = state.sessions.find((session) => session.id === args.where.id);
        if (!row) throw new Error("session not found");
        Object.assign(row, args.data);
        calls.push(`session.update:${row.id}`);
        return row;
      },
      updateMany: async (args: { where?: Record<string, unknown>; data: Partial<SessionRow> }) => {
        const rows = state.sessions.filter((row) => matches(row, args.where));
        for (const row of rows) Object.assign(row, args.data);
        calls.push(`session.updateMany:${rows.map((row) => row.id).join(",")}`);
        return { count: rows.length };
      }
    },
    workerJobRun: {
      findFirst: async (args: { where?: Record<string, unknown> }) => state.runs.find((row) => matches(row, args.where)) ?? null,
      create: async (args: { data: Record<string, unknown> }) => {
        const row = { id: `run_${++runSeq}`, ...args.data } as RunRow;
        state.runs.push(row);
        calls.push(`run.create:${row.id}`);
        return { id: row.id };
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = state.runs.find((run) => run.id === args.where.id);
        if (!row) throw new Error("run not found");
        Object.assign(row, args.data);
        calls.push(`run.update:${row.id}:${String(args.data.status)}`);
        return row;
      }
    }
  } as unknown as CheckinJobsDb;
  return { db, calls };
}

// ── Dobles del resto de dependencias ─────────────────────────────────────────

type InviteCall = { reservationId: string; channel: string; userId: string; propertyId: string; templateCode: string | undefined; correlationId: string };
type BatchCall = { propertyId: string; date: string; userId: string };
type AuditCall = Parameters<typeof recordAuditEvent>[0];

type Harness = {
  deps: Partial<CheckinJobsDeps>;
  invites: InviteCall[];
  batches: BatchCall[];
  audits: AuditCall[];
  purgeCalls: Date[];
  calls: string[];
};

function harness(state: State, now: Date, options: StubOptions & { inviteThrowsFor?: string; batchThrows?: boolean; purged?: number } = {}): Harness {
  const { db, calls } = stubDb(state, options);
  const invites: InviteCall[] = [];
  const batches: BatchCall[] = [];
  const audits: AuditCall[] = [];
  const purgeCalls: Date[] = [];
  let ids = 0;
  const deps: Partial<CheckinJobsDeps> = {
    db,
    now: () => now,
    config: () => ({ assignmentRunAt: "18:00" }),
    createId: (prefix) => `${prefix}_${++ids}`,
    serviceContext: async (propertyId, actor) => buildServiceContext({ organizationId: `org_of_${propertyId}`, propertyId, actor, permissions: CHECKIN_SERVICE_PERMISSIONS }),
    invite: async (input) => {
      if (options.inviteThrowsFor && input.context.propertyId === options.inviteThrowsFor) throw new Error("template_not_found");
      invites.push({ reservationId: input.reservationId, channel: input.channel, userId: input.context.userId, propertyId: input.context.propertyId, templateCode: input.templateCode, correlationId: input.correlationId });
      const result: InvitationResult = {
        session: { id: "s_x" } as unknown as InvitationResult["session"],
        notification: { dispatched: true, simulated: true, channel: "email", recipient: "a***@x.test", reason: null, deliveryId: "del_1" }
      };
      return result;
    },
    runBatch: async (input) => {
      if (options.batchThrows) throw new Error("engine exploded");
      batches.push({ propertyId: input.propertyId, date: input.date, userId: input.context.userId });
      return { suggested: 2, skipped: 1, failed: [{ reservationId: "res_bad", code: "CHK-99", error: "sin candidatas" }] };
    },
    purgeCaptures: async (at) => {
      purgeCalls.push(at);
      return { purged: options.purged ?? 0 };
    },
    audit: ((input: AuditCall) => {
      audits.push(input);
      return { id: `aud_${audits.length}` } as unknown as ReturnType<typeof recordAuditEvent>;
    }) as typeof recordAuditEvent
  };
  return { deps, invites, batches, audits, purgeCalls, calls };
}

const policy = (propertyId: string, enabled = true, inviteDaysBefore = 3, reminderDaysBefore = 1): PolicyRow => ({ propertyId, selfCheckInEnabled: enabled, inviteDaysBefore, reminderDaysBefore });
const reservation = (id: string, propertyId: string, arrivalOffset: number, extra: Partial<ReservationRow> = {}): ReservationRow => ({
  id,
  propertyId,
  code: id.toUpperCase(),
  status: "confirmed",
  deletedAt: null,
  arrivalDate: day(arrivalOffset),
  departureDate: day(arrivalOffset + 2),
  ...extra
});
const session = (id: string, reservationId: string, propertyId: string, extra: Partial<SessionRow> = {}): SessionRow => ({
  id,
  reservationId,
  propertyId,
  organizationId: `org_of_${propertyId}`,
  status: "invited",
  reminderAt: null,
  invitedAt: YESTERDAY_NOON,
  createdAt: YESTERDAY_NOON,
  ...extra
});

// ── Puras ────────────────────────────────────────────────────────────────────

describe("puras: arranque, intervalo, reloj local", () => {
  it("shouldStartCheckinJobs solo con runSchedulers=true y disabled=false", () => {
    assert.equal(shouldStartCheckinJobs({ runSchedulers: true, disabled: false }), true);
    assert.equal(shouldStartCheckinJobs({ runSchedulers: false, disabled: false }), false);
    assert.equal(shouldStartCheckinJobs({ runSchedulers: true, disabled: true }), false);
  });

  it("intervalo: 1 h por defecto; no finito o < 60 s vuelve al defecto", () => {
    assert.equal(CHECKIN_JOBS_DEFAULT_INTERVAL_MS, 3_600_000);
    assert.equal(CHECKIN_JOBS_MIN_INTERVAL_MS, 60_000);
    assert.equal(checkinJobsIntervalMs(undefined), 3_600_000);
    assert.equal(checkinJobsIntervalMs(Number.NaN), 3_600_000);
    assert.equal(checkinJobsIntervalMs(1_000), 3_600_000);
    assert.equal(checkinJobsIntervalMs(120_000), 120_000);
  });

  it("localClock en Europe/Madrid respeta el horario de verano y el cambio de día", () => {
    assert.deepEqual(localClock(new Date("2026-09-19T16:30:00.000Z")), { day: "2026-09-19", time: "18:30" });
    assert.deepEqual(localClock(new Date("2026-01-15T17:30:00.000Z")), { day: "2026-01-15", time: "18:30" });
    assert.deepEqual(localClock(new Date("2026-09-19T22:30:00.000Z")), { day: "2026-09-20", time: "00:30" });
    assert.deepEqual(localClock(new Date("2026-09-19T22:30:00.000Z"), "UTC"), { day: "2026-09-19", time: "22:30" });
    assert.equal(isAssignmentDue("17:59", "18:00"), false);
    assert.equal(isAssignmentDue("18:00", "18:00"), true);
    assert.equal(isAssignmentDue("23:15", "18:00"), true);
    assert.equal(addDays("2026-09-30", 1), "2026-10-01");
    assert.equal(addDays("2026-03-01", -1), "2026-02-28");
    assert.equal(dateOnly("2026-09-19").toISOString(), "2026-09-19T00:00:00.000Z");
    assert.equal(CHECKIN_JOBS_LOCK_KEY, "checkin.jobs");
    assert.equal(CHECKIN_ASSIGNMENT_JOB_NAME, "checkin.assignment");
    assert.equal(CHECKIN_REMINDER_TEMPLATE, "checkin_reminder");
  });
});

// ── Invitaciones ─────────────────────────────────────────────────────────────

describe("invita solo propiedades con self check-in y solo reservas sin sesión", () => {
  it("prop_a activa: llegadas de hoy a hoy+3 confirmadas, no borradas y sin sesión; prop_b desactivada y prop_c sin política no se tocan", async () => {
    const state: State = {
      policies: [policy("prop_a"), policy("prop_b", false)],
      reservations: [
        reservation("r_today", "prop_a", 0),
        reservation("r_plus2", "prop_a", 2),
        reservation("r_with_session", "prop_a", 1),
        reservation("r_plus4", "prop_a", 4),
        reservation("r_cancelled", "prop_a", 1, { status: "cancelled" }),
        reservation("r_deleted", "prop_a", 1, { deletedAt: new Date("2026-09-01T00:00:00.000Z") }),
        reservation("r_checked_in", "prop_a", 0, { status: "checked_in" }),
        reservation("r_b", "prop_b", 1),
        reservation("r_c", "prop_c", 1)
      ],
      // s_existing ya recibió su recordatorio: este test mira solo la invitación.
      sessions: [session("s_existing", "r_with_session", "prop_a", { reminderAt: YESTERDAY_NOON })],
      runs: []
    };
    const h = harness(state, MORNING);
    const result = await runCheckinJobsTick(h.deps);
    assert.equal(result.skipped, false);
    const summary = result.summary;
    assert.ok(summary);
    assert.equal(summary.invited, 2);
    assert.equal(summary.reminded, 0);
    assert.deepEqual(summary.failed, []);
    assert.equal(summary.details.properties, 1);
    assert.deepEqual(summary.details.localDay, TODAY);
    assert.deepEqual(h.invites.map((call) => call.reservationId).sort(), ["r_plus2", "r_today"]);
    for (const call of h.invites) {
      assert.equal(call.channel, "email");
      assert.equal(call.propertyId, "prop_a");
      assert.equal(call.userId, "system:checkin:invitation");
      assert.equal(call.templateCode, undefined, "la invitación usa la plantilla por defecto checkin_invitation");
      assert.match(call.correlationId, /^corr_\d+$/);
    }
    assert.equal(h.calls[0], "lock:checkin.jobs");
    assert.deepEqual(h.batches, [], "a las 10:30 no toca el lote de las 18:00");
    assert.equal(summary.details.assignmentDue, false);
  });

  it("inviteDaysBefore de la política manda: con 1 día solo entran hoy y mañana", async () => {
    const state: State = {
      policies: [policy("prop_a", true, 1)],
      reservations: [reservation("r0", "prop_a", 0), reservation("r1", "prop_a", 1), reservation("r2", "prop_a", 2)],
      sessions: [],
      runs: []
    };
    const h = harness(state, MORNING);
    const result = await runCheckinJobsTick(h.deps);
    assert.deepEqual(h.invites.map((call) => call.reservationId).sort(), ["r0", "r1"]);
    assert.equal(result.summary?.invited, 2);
  });
});

// ── Recordatorio ─────────────────────────────────────────────────────────────

describe("recordatorio una vez", () => {
  it("solo sesiones invited con reminderAt null, invitadas otro día, cuya reserva llega en ≤ reminderDaysBefore; fija reminderAt y audita; la segunda vuelta no repite", async () => {
    const state: State = {
      policies: [policy("prop_a")],
      reservations: [
        reservation("r_due", "prop_a", 1),
        reservation("r_invited_today", "prop_a", 1),
        reservation("r_already", "prop_a", 1),
        reservation("r_far", "prop_a", 3),
        reservation("r_progress", "prop_a", 1),
        reservation("r_today", "prop_a", 0)
      ],
      sessions: [
        session("s_due", "r_due", "prop_a"),
        session("s_invited_today", "r_invited_today", "prop_a", { invitedAt: new Date("2026-09-19T06:00:00.000Z"), createdAt: new Date("2026-09-19T06:00:00.000Z") }),
        session("s_already", "r_already", "prop_a", { reminderAt: YESTERDAY_NOON }),
        session("s_far", "r_far", "prop_a"),
        session("s_progress", "r_progress", "prop_a", { status: "in_progress" }),
        session("s_today", "r_today", "prop_a")
      ],
      runs: []
    };
    const h = harness(state, MORNING);
    const first = await runCheckinJobsTick(h.deps);
    assert.equal(first.summary?.invited, 0, "todas las reservas ya tienen sesión");
    assert.equal(first.summary?.reminded, 2);
    assert.deepEqual(first.summary?.failed, []);
    const reminders = h.invites.filter((call) => call.templateCode === CHECKIN_REMINDER_TEMPLATE);
    assert.deepEqual(reminders.map((call) => call.reservationId).sort(), ["r_due", "r_today"]);
    assert.equal(reminders[0]?.userId, "system:checkin:reminder");
    assert.equal(h.invites.length, 2, "ningún otro envío");
    assert.equal(state.sessions.find((row) => row.id === "s_due")?.reminderAt, MORNING);
    assert.equal(state.sessions.find((row) => row.id === "s_today")?.reminderAt, MORNING);
    assert.equal(state.sessions.find((row) => row.id === "s_invited_today")?.reminderAt, null, "invitada hoy: sin recordatorio el mismo día");
    assert.equal(state.sessions.find((row) => row.id === "s_far")?.reminderAt, null);
    const audits = h.audits.filter((event) => event.action === "CheckInReminderSent");
    assert.equal(audits.length, 2);
    assert.deepEqual(audits.map((event) => event.entityId).sort(), ["s_due", "s_today"]);
    assert.equal(audits[0]?.actorType, "system");
    assert.equal(audits[0]?.actorUserId, "system:checkin:reminder");
    assert.deepEqual(audits[0]?.afterJson, { reservationId: audits[0]?.entityId === "s_due" ? "r_due" : "r_today", channel: "email", dispatched: true, simulated: true, reason: null });

    const second = await runCheckinJobsTick(h.deps);
    assert.equal(second.summary?.reminded, 0);
    assert.equal(h.invites.length, 2, "reminderAt ya fijado: ni un envío más");
  });
});

// ── Lote de asignación ───────────────────────────────────────────────────────

describe("lote solo tras la hora y una vez al día", () => {
  it("antes de las 18:00 no corre; a las 18:05 corre para mañana y deja WorkerJobRun completed; a las 19:00 se salta; al día siguiente vuelve a correr", async () => {
    const state: State = { policies: [policy("prop_a"), policy("prop_off", false)], reservations: [], sessions: [], runs: [] };

    const early = harness(state, BEFORE_RUN_AT);
    const earlyResult = await runCheckinJobsTick(early.deps);
    assert.equal(earlyResult.summary?.details.assignmentDue, false);
    assert.deepEqual(early.batches, []);
    assert.equal(state.runs.length, 0);

    const due = harness(state, AFTER_RUN_AT);
    const dueResult = await runCheckinJobsTick(due.deps);
    assert.equal(dueResult.summary?.details.assignmentDue, true);
    assert.deepEqual(due.batches, [{ propertyId: "prop_a", date: "2026-09-20", userId: "system:checkin:assignment" }]);
    assert.equal(dueResult.summary?.suggested, 2);
    assert.equal(dueResult.summary?.details.batchRuns, 1);
    assert.deepEqual(dueResult.summary?.failed, [{ propertyId: "prop_a", step: "assign", entityId: "res_bad", error: "sin candidatas" }], "los fallos por reserva del lote se propagan al resumen");
    assert.equal(state.runs.length, 1);
    const run = state.runs[0]!;
    assert.equal(run.jobName, CHECKIN_ASSIGNMENT_JOB_NAME);
    assert.equal(run.queueName, CHECKIN_JOBS_QUEUE_NAME);
    assert.equal(run.propertyId, "prop_a");
    assert.equal(run.organizationId, "org_of_prop_a");
    assert.equal(run.status, "completed");
    assert.equal((run.scheduledFor as Date).toISOString(), "2026-09-19T00:00:00.000Z");
    assert.deepEqual(run.payloadJson, { propertyId: "prop_a", date: "2026-09-20", localDay: "2026-09-19", trigger: "scheduler" });
    assert.deepEqual(run.resultJson, { date: "2026-09-20", suggested: 2, skipped: 1, failed: 1 });
    assert.equal(run.startedAt, AFTER_RUN_AT);
    assert.equal(run.finishedAt, AFTER_RUN_AT);

    const later = harness(state, LATER);
    const laterResult = await runCheckinJobsTick(later.deps);
    assert.deepEqual(later.batches, [], "ya corrió hoy");
    assert.equal(laterResult.summary?.details.batchSkipped, 1);
    assert.equal(laterResult.summary?.suggested, 0);
    assert.equal(state.runs.length, 1);

    const tomorrow = harness(state, NEXT_DAY);
    await runCheckinJobsTick(tomorrow.deps);
    assert.deepEqual(tomorrow.batches, [{ propertyId: "prop_a", date: "2026-09-21", userId: "system:checkin:assignment" }]);
    assert.equal(state.runs.length, 2);
  });

  it("un lote que revienta deja la fila failed con lastError, va a failed[] y la siguiente vuelta lo reintenta", async () => {
    const state: State = { policies: [policy("prop_a")], reservations: [], sessions: [], runs: [] };
    const broken = harness(state, AFTER_RUN_AT, { batchThrows: true });
    const result = await runCheckinJobsTick(broken.deps);
    assert.equal(result.summary?.suggested, 0);
    assert.deepEqual(result.summary?.failed, [{ propertyId: "prop_a", step: "assign", entityId: null, error: "Error: engine exploded" }]);
    assert.equal(state.runs.length, 1);
    assert.equal(state.runs[0]?.status, "failed");
    assert.equal(state.runs[0]?.lastError, "Error: engine exploded");
    assert.equal(state.runs[0]?.finishedAt, AFTER_RUN_AT);

    const retry = harness(state, LATER);
    const retried = await runCheckinJobsTick(retry.deps);
    assert.equal(retry.batches.length, 1, "la fila failed no bloquea el reintento");
    assert.equal(retried.summary?.suggested, 2);
    assert.deepEqual(state.runs.map((run) => run.status), ["failed", "completed"]);
  });
});

// ── QC-06: fallo por propiedad ───────────────────────────────────────────────

describe("fallo de una propiedad no detiene el tick y va a failed[]", () => {
  it("la invitación de prop_a lanza (por reserva) y prop_b se invita igual", async () => {
    const state: State = {
      policies: [policy("prop_a"), policy("prop_b")],
      reservations: [reservation("r_a", "prop_a", 1), reservation("r_b", "prop_b", 1)],
      sessions: [],
      runs: []
    };
    const h = harness(state, MORNING, { inviteThrowsFor: "prop_a" });
    const result = await runCheckinJobsTick(h.deps);
    assert.equal(result.summary?.invited, 1);
    assert.deepEqual(h.invites.map((call) => call.reservationId), ["r_b"]);
    assert.deepEqual(result.summary?.failed, [{ propertyId: "prop_a", step: "invite", entityId: "r_a", error: "Error: template_not_found" }]);
  });

  it("la base de datos falla al leer las llegadas de prop_a: su invitación va a failed[] (sin entidad), su recordatorio y prop_b siguen; la purga también corre", async () => {
    const state: State = {
      policies: [policy("prop_a"), policy("prop_b")],
      reservations: [reservation("r_a", "prop_a", 1), reservation("r_a2", "prop_a", 2), reservation("r_b", "prop_b", 1)],
      sessions: [session("s_a", "r_a", "prop_a")],
      runs: []
    };
    // La consulta de llegadas lleva propertyId (falla); la del recordatorio filtra por id (no falla).
    const h = harness(state, MORNING, { failReservationsFor: "prop_a", purged: 1 });
    const result = await runCheckinJobsTick(h.deps);
    assert.equal(result.summary?.invited, 1);
    assert.equal(result.summary?.reminded, 1);
    assert.deepEqual(h.invites.filter((call) => call.templateCode === undefined).map((call) => call.reservationId), ["r_b"], "r_a2 no se invita: su consulta falló");
    assert.deepEqual(h.invites.filter((call) => call.templateCode === CHECKIN_REMINDER_TEMPLATE).map((call) => call.reservationId), ["r_a"]);
    assert.deepEqual(result.summary?.failed, [{ propertyId: "prop_a", step: "invite", entityId: null, error: "Error: db down" }]);
    assert.equal(result.summary?.purged, 1, "la purga corre aunque una propiedad falle");
    assert.deepEqual(h.purgeCalls, [MORNING]);
  });
});

// ── Purga ────────────────────────────────────────────────────────────────────

describe("purga vacía capturas caducadas y expira sesiones", () => {
  it("purgeExpiredCaptures con el reloj del tick; sesiones invited con salida pasada → expired con auditoría; el resto intacto", async () => {
    const state: State = {
      policies: [],
      reservations: [
        reservation("r_gone", "prop_z", -5),
        reservation("r_gone_progress", "prop_z", -5),
        reservation("r_leaving_today", "prop_z", -2),
        reservation("r_future", "prop_z", 1)
      ],
      sessions: [
        session("s_gone", "r_gone", "prop_z"),
        session("s_gone_progress", "r_gone_progress", "prop_z", { status: "in_progress" }),
        session("s_leaving_today", "r_leaving_today", "prop_z"),
        session("s_future", "r_future", "prop_z")
      ],
      runs: []
    };
    // r_gone sale hoy-3, r_leaving_today sale hoy (no ha pasado), r_future sale hoy+3.
    const h = harness(state, MORNING, { purged: 3 });
    const result = await runCheckinJobsTick(h.deps);
    assert.deepEqual(h.purgeCalls, [MORNING]);
    assert.equal(result.summary?.details.properties, 0, "sin políticas activas la purga corre igual");
    assert.equal(result.summary?.details.purgedCaptures, 3);
    assert.equal(result.summary?.details.expiredSessions, 1);
    assert.equal(result.summary?.purged, 4);
    assert.deepEqual(result.summary?.failed, []);
    assert.deepEqual(
      state.sessions.map((row) => [row.id, row.status]),
      [
        ["s_gone", "expired"],
        ["s_gone_progress", "in_progress"],
        ["s_leaving_today", "invited"],
        ["s_future", "invited"]
      ]
    );
    const audits = h.audits.filter((event) => event.action === "CheckInSessionExpired");
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.entityId, "s_gone");
    assert.equal(audits[0]?.entityType, "checkin_session");
    assert.equal(audits[0]?.organizationId, "org_of_prop_z");
    assert.equal(audits[0]?.propertyId, "prop_z");
    assert.equal(audits[0]?.actorType, "system");
    assert.equal(audits[0]?.actorUserId, "system:checkin:purge");
    assert.deepEqual(audits[0]?.afterJson, { status: "expired", reservationId: "r_gone", reason: "departure_passed" });
    assert.ok(h.calls.includes("session.updateMany:s_gone"));
  });

  it("si la purga de capturas falla, la expiración de sesiones sigue y el fallo queda en failed[]", async () => {
    const state: State = { policies: [], reservations: [reservation("r_gone", "prop_z", -5)], sessions: [session("s_gone", "r_gone", "prop_z")], runs: [] };
    const h = harness(state, MORNING);
    h.deps.purgeCaptures = async () => {
      throw new Error("purge down");
    };
    const result = await runCheckinJobsTick(h.deps);
    assert.deepEqual(result.summary?.failed, [{ propertyId: null, step: "purge", entityId: "document_captures", error: "Error: purge down" }]);
    assert.equal(result.summary?.details.expiredSessions, 1);
    assert.equal(state.sessions[0]?.status, "expired");
  });
});

// ── Lock y arranque ──────────────────────────────────────────────────────────

describe("lock global y startCheckinJobs", () => {
  it("sin el advisory lock la vuelta se salta sin tocar nada", async () => {
    const state: State = { policies: [policy("prop_a")], reservations: [reservation("r_a", "prop_a", 1)], sessions: [], runs: [] };
    const h = harness(state, MORNING, { locked: false });
    const result = await runCheckinJobsTick(h.deps);
    assert.equal(result.skipped, true);
    assert.equal(result.summary, null);
    assert.deepEqual(h.invites, []);
    assert.deepEqual(h.purgeCalls, []);
    assert.deepEqual(h.calls, ["lock:checkin.jobs"]);
  });

  it("startCheckinJobs: runNow ejecuta una vuelta con las dependencias inyectadas, el temporizador exige el lease, stop lo para", async () => {
    const state: State = { policies: [policy("prop_a")], reservations: [reservation("r_a", "prop_a", 1)], sessions: [], runs: [] };
    const h = harness(state, MORNING);
    const logs: string[] = [];
    const log = { info: (_obj: unknown, msg?: string) => logs.push(`info:${msg ?? ""}`), warn: (_obj: unknown, msg?: string) => logs.push(`warn:${msg ?? ""}`), error: (_obj: unknown, msg?: string) => logs.push(`error:${msg ?? ""}`) };
    let leaseChecks = 0;
    const job = startCheckinJobs({ ...h.deps, log, intervalMs: 60_000, runAtBoot: false, holdsLease: async () => (++leaseChecks, false) });
    try {
      assert.equal(h.invites.length, 0, "runAtBoot=false: nada al arrancar");
      const result = await job.runNow();
      assert.equal(result?.skipped, false);
      assert.equal(result?.summary?.invited, 1);
      assert.equal(h.invites.length, 1);
      assert.equal(leaseChecks, 0, "runNow no exige el lease (lo exige el temporizador)");
      assert.ok(logs.some((line) => line.startsWith("info:[checkin.jobs] enabled")));
      assert.ok(logs.some((line) => line === "info:[checkin.jobs] tick"));
    } finally {
      job.stop();
    }
  });

  it("startCheckinJobs: flag anti-solape (una segunda runNow concurrente devuelve null)", async () => {
    const state: State = { policies: [policy("prop_a")], reservations: [reservation("r_a", "prop_a", 1)], sessions: [], runs: [] };
    const h = harness(state, MORNING);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowInvite = h.deps.invite!;
    h.deps.invite = async (input) => {
      await gate;
      return slowInvite(input);
    };
    const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const job = startCheckinJobs({ ...h.deps, log: silent, intervalMs: 60_000, runAtBoot: false, holdsLease: async () => true });
    try {
      const first = job.runNow();
      const second = await job.runNow();
      assert.equal(second, null);
      release();
      const done = await first;
      assert.equal(done?.summary?.invited, 1);
    } finally {
      job.stop();
    }
  });
});
