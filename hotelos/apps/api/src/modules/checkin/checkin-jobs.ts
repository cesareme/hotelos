// Jobs del líder del check-in automatizado (Tanda CHK · lote W3-C; diseño §4a
// paso 1 —invitación J-3 y recordatorio J-1—, §4b modo lote de las 18:00 y
// §7.3 purga a 30 días).
//
// Por qué viven en el API y no en apps/worker: el catálogo del worker está
// cerrado a cinco colas pg-boss (tests/worker-integration-contract.test.mjs:56,
// apps/worker/src/__tests__/catalog.test.ts:40) y apps/worker no depende de
// @hotelos/api (no puede importar inviteReservation, runBatchForDate ni el
// contexto de servicio). Mismo patrón que modules/reputation/reputation-sync.job.ts:
// ticks in-process bajo el líder (RUN_SCHEDULERS + holdsSchedulerLease en cada
// vuelta del temporizador; el cableado en server.ts lo hace el lote W4-D con
// shouldStartCheckinJobs / startCheckinJobs) y advisory lock global
// `checkin.jobs` (pg_try_advisory_xact_lock(hashtext('checkin.jobs')) vía
// withAdvisoryLock de reputation-lock.ts) para que dos réplicas no inviten dos
// veces. El trabajo corre FUERA de la transacción del lock (autocommit): cada
// invitación, recordatorio o sugerencia se confirma por sí sola.
//
// Una vuelta (runCheckinJobsTick) recorre las propiedades con política
// `selfCheckInEnabled = true` (property_checkin_policies: el módulo es opt-in
// por propiedad; sin fila o con false no se invita ni se sugiere) y, por cada
// una, con catch propio (QC-06: el fallo va a failed[] y no detiene el resto):
//   1. Invitación: reservas `confirmed` (deletedAt null) con llegada entre hoy y
//      hoy + inviteDaysBefore (días locales Europe/Madrid) sin CheckInSession →
//      inviteReservation (W2-A, plantilla checkin_invitation) con el contexto
//      system:checkin:invitation. Canal pedido "email"; pickInvitationChannel
//      cae a whatsapp (con opt-in) o sms si no hay correo.
//   2. Recordatorio: sesiones `invited` con reminderAt null cuya reserva llega
//      entre hoy y hoy + reminderDaysBefore y que NO se invitaron hoy →
//      inviteReservation con la plantilla `checkin_reminder` (reemite el enlace:
//      los tokens se guardan hasheados y no se pueden recuperar; el anterior
//      queda revocado y el nuevo viaja en el recordatorio) + reminderAt = ahora
//      (una sola vez, aunque no haya destinatario: el motivo queda en la
//      auditoría CheckInReminderSent).
//   3. Lote de asignación: si la hora local ≥ CHECKIN_ASSIGNMENT_RUN_AT y no hay
//      WorkerJobRun `checkin.assignment` (propertyId, scheduledFor = día local)
//      en running|completed → fila running → runBatchForDate(mañana) (W2-C) →
//      completed con el resumen. Un fallo deja la fila `failed` y la siguiente
//      vuelta lo reintenta (visible en la pantalla de jobs por jobName).
//   4. Purga (global): purgeExpiredCaptures (W2-B; vacía fieldsJson/confidenceJson
//      tras purgeAt) y sesiones `invited` cuya reserva ya salió → `expired`
//      con auditoría CheckInSessionExpired (actor system:checkin:purge).
//
// Sin lecturas de entorno fuera de readCheckInConfig (checkin-config.ts);
// shouldStartCheckinJobs es pura sobre opciones ya leídas por server.ts.

import { prisma } from "@hotelos/database";
import type { CheckInChannel } from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { createId } from "../../lib/ids.js";
import { holdsSchedulerLease } from "../../lib/scheduler-leader.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { runBatchForDate, type AssignmentBatchResult } from "../pms/room-assignment.service.js";
import { withAdvisoryLock, type LockDb } from "../reputation/reputation-lock.js";
import { CHECKIN_CONFIG_DEFAULTS, readCheckInConfig, type CheckInConfig } from "./checkin-config.js";
import { inviteReservation, type InvitationResult } from "./checkin-session.service.js";
import { purgeExpiredCaptures } from "./identity-capture.service.js";
import { CHECKIN_SERVICE_DEVICE_ID, checkInServiceContext, serviceUserId, type CheckInActor } from "./service-context.js";

export const CHECKIN_JOBS_LOCK_KEY = "checkin.jobs";
/** Tope de la transacción que sostiene el lock global (red de seguridad, no un límite del trabajo). */
export const CHECKIN_JOBS_LOCK_TIMEOUT_MS = 30 * 60_000;
export const CHECKIN_JOBS_MIN_INTERVAL_MS = 60_000;
export const CHECKIN_JOBS_DEFAULT_INTERVAL_MS = CHECKIN_CONFIG_DEFAULTS.invitationIntervalMs;
export const CHECKIN_JOBS_TIMEZONE = "Europe/Madrid";
/** WorkerJobRun.jobName del lote diario de asignación (una fila por propiedad y día local). */
export const CHECKIN_ASSIGNMENT_JOB_NAME = "checkin.assignment";
export const CHECKIN_JOBS_QUEUE_NAME = "api.checkin";
export const CHECKIN_REMINDER_TEMPLATE = "checkin_reminder";
/** Canal que se pide a inviteReservation; pickInvitationChannel elige el disponible con consentimiento. */
export const CHECKIN_JOBS_REQUESTED_CHANNEL: CheckInChannel = "email";
const LOG = "[checkin.jobs]";

export type CheckinJobsLogger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

export const silentCheckinJobsLog: CheckinJobsLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const defaultLog: CheckinJobsLogger = {
  info: (obj, msg) => console.info(msg ?? LOG, obj),
  warn: (obj, msg) => console.warn(msg ?? LOG, obj),
  error: (obj, msg) => console.error(msg ?? LOG, obj)
};

// ── Funciones puras (tests sin BD) ───────────────────────────────────────────

/** Puro: el job arranca solo en el líder (RUN_SCHEDULERS) y sin CHECKIN_INVITATION_DISABLED. */
export function shouldStartCheckinJobs(options: { runSchedulers: boolean; disabled: boolean }): boolean {
  return options.runSchedulers === true && options.disabled !== true;
}

/** Periodo efectivo: valores no finitos o por debajo del mínimo vuelven al defecto (1 h). */
export function checkinJobsIntervalMs(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= CHECKIN_JOBS_MIN_INTERVAL_MS ? value : CHECKIN_JOBS_DEFAULT_INTERVAL_MS;
}

export type LocalClock = { day: string; time: string };

/** Día (YYYY-MM-DD) y hora (HH:MM, 00-23) de `now` en la zona indicada, sin dependencias. */
export function localClock(now: Date, timeZone: string = CHECKIN_JOBS_TIMEZONE): LocalClock {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "00";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}

/** true cuando la hora local (HH:MM) ya alcanzó CHECKIN_ASSIGNMENT_RUN_AT. */
export function isAssignmentDue(localTime: string, runAt: string): boolean {
  return localTime >= runAt;
}

/** YYYY-MM-DD + n días (aritmética UTC sobre la fecha civil). */
export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Fecha civil → instante que Prisma compara con columnas @db.Date. */
export function dateOnly(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

// ── Dependencias (inyectables en los tests) ──────────────────────────────────

export type CheckinJobsDb = LockDb & Pick<typeof prisma, "propertyCheckInPolicy" | "reservation" | "checkInSession" | "workerJobRun">;

export type CheckinJobsDeps = {
  db: CheckinJobsDb;
  now: () => Date;
  config: () => Pick<CheckInConfig, "assignmentRunAt">;
  timeZone: string;
  createId: (prefix: string) => string;
  serviceContext: (propertyId: string, actor: CheckInActor) => Promise<UserContext>;
  invite: (input: { reservationId: string; channel: CheckInChannel; context: UserContext; correlationId: string; templateCode?: string }) => Promise<InvitationResult>;
  runBatch: (input: { context: UserContext; propertyId: string; date: string }) => Promise<Pick<AssignmentBatchResult, "suggested" | "skipped" | "failed">>;
  purgeCaptures: (now: Date) => Promise<{ purged: number }>;
  audit: typeof recordAuditEvent;
  log: CheckinJobsLogger;
};

export function defaultCheckinJobsDeps(): CheckinJobsDeps {
  return {
    db: prisma as CheckinJobsDb,
    now: () => new Date(),
    config: () => readCheckInConfig(),
    timeZone: CHECKIN_JOBS_TIMEZONE,
    createId,
    serviceContext: checkInServiceContext,
    invite: inviteReservation,
    runBatch: (input) => runBatchForDate(input),
    purgeCaptures: purgeExpiredCaptures,
    audit: recordAuditEvent,
    log: silentCheckinJobsLog
  };
}

export function withCheckinJobsDeps(deps?: Partial<CheckinJobsDeps>): CheckinJobsDeps {
  return { ...defaultCheckinJobsDeps(), ...(deps ?? {}) };
}

// ── Resumen de una vuelta ────────────────────────────────────────────────────

export type CheckinJobStep = "invite" | "remind" | "assign" | "purge";

export type CheckinJobFailure = { propertyId: string | null; step: CheckinJobStep; entityId: string | null; error: string };

export type CheckinJobsTickSummary = {
  invited: number;
  reminded: number;
  suggested: number;
  /** Capturas vaciadas + sesiones expiradas. */
  purged: number;
  failed: CheckinJobFailure[];
  details: {
    localDay: string;
    localTime: string;
    assignmentRunAt: string;
    assignmentDue: boolean;
    properties: number;
    purgedCaptures: number;
    expiredSessions: number;
    batchRuns: number;
    batchSkipped: number;
  };
};

export type CheckinJobsTickResult = {
  skipped: boolean;
  startedAt: string;
  finishedAt: string;
  summary: CheckinJobsTickSummary | null;
  lockExpired?: boolean;
};

type EnabledProperty = { propertyId: string; inviteDaysBefore: number; reminderDaysBefore: number };

// ── Pasos ────────────────────────────────────────────────────────────────────

async function enabledProperties(d: CheckinJobsDeps): Promise<EnabledProperty[]> {
  const rows = await d.db.propertyCheckInPolicy.findMany({
    where: { selfCheckInEnabled: true },
    select: { propertyId: true, inviteDaysBefore: true, reminderDaysBefore: true },
    orderBy: { propertyId: "asc" }
  });
  return rows.map((row) => ({ propertyId: row.propertyId, inviteDaysBefore: Math.max(0, row.inviteDaysBefore), reminderDaysBefore: Math.max(0, row.reminderDaysBefore) }));
}

async function inviteProperty(d: CheckinJobsDeps, property: EnabledProperty, clock: LocalClock, summary: CheckinJobsTickSummary): Promise<void> {
  const reservations = await d.db.reservation.findMany({
    where: { propertyId: property.propertyId, status: "confirmed", deletedAt: null, arrivalDate: { gte: dateOnly(clock.day), lte: dateOnly(addDays(clock.day, property.inviteDaysBefore)) } },
    select: { id: true },
    orderBy: [{ arrivalDate: "asc" }, { code: "asc" }]
  });
  if (reservations.length === 0) return;
  const sessions = await d.db.checkInSession.findMany({ where: { reservationId: { in: reservations.map((row) => row.id) } }, select: { reservationId: true } });
  const withSession = new Set(sessions.map((row) => row.reservationId));
  let context: UserContext | null = null;
  for (const reservation of reservations) {
    if (withSession.has(reservation.id)) continue;
    try {
      context ??= await d.serviceContext(property.propertyId, { kind: "system", job: "invitation" });
      await d.invite({ reservationId: reservation.id, channel: CHECKIN_JOBS_REQUESTED_CHANNEL, context, correlationId: d.createId("corr") });
      summary.invited += 1;
    } catch (error) {
      summary.failed.push({ propertyId: property.propertyId, step: "invite", entityId: reservation.id, error: describeError(error) });
    }
  }
}

async function remindProperty(d: CheckinJobsDeps, property: EnabledProperty, clock: LocalClock, summary: CheckinJobsTickSummary): Promise<void> {
  const sessions = await d.db.checkInSession.findMany({
    where: { propertyId: property.propertyId, status: "invited", reminderAt: null },
    select: { id: true, reservationId: true, invitedAt: true, createdAt: true }
  });
  // Nunca el mismo día local que la invitación (evita invitación + recordatorio en la misma vuelta).
  const candidates = sessions.filter((session) => localClock(session.invitedAt ?? session.createdAt, d.timeZone).day < clock.day);
  if (candidates.length === 0) return;
  const due = await d.db.reservation.findMany({
    where: { id: { in: candidates.map((session) => session.reservationId) }, status: "confirmed", deletedAt: null, arrivalDate: { gte: dateOnly(clock.day), lte: dateOnly(addDays(clock.day, property.reminderDaysBefore)) } },
    select: { id: true }
  });
  const dueIds = new Set(due.map((row) => row.id));
  let context: UserContext | null = null;
  for (const session of candidates) {
    if (!dueIds.has(session.reservationId)) continue;
    try {
      context ??= await d.serviceContext(property.propertyId, { kind: "system", job: "reminder" });
      const correlationId = d.createId("corr");
      const result = await d.invite({ reservationId: session.reservationId, channel: CHECKIN_JOBS_REQUESTED_CHANNEL, context, correlationId, templateCode: CHECKIN_REMINDER_TEMPLATE });
      await d.db.checkInSession.update({ where: { id: session.id }, data: { reminderAt: d.now() } });
      d.audit({
        organizationId: context.organizationId,
        propertyId: property.propertyId,
        actorUserId: context.userId,
        actorType: "system",
        action: "CheckInReminderSent",
        entityType: "checkin_session",
        entityId: session.id,
        afterJson: {
          reservationId: session.reservationId,
          channel: result.notification.channel,
          dispatched: result.notification.dispatched,
          simulated: result.notification.simulated,
          reason: result.notification.reason
        },
        deviceId: context.deviceId,
        correlationId
      });
      summary.reminded += 1;
    } catch (error) {
      summary.failed.push({ propertyId: property.propertyId, step: "remind", entityId: session.id, error: describeError(error) });
    }
  }
}

async function assignProperty(d: CheckinJobsDeps, property: EnabledProperty, clock: LocalClock, summary: CheckinJobsTickSummary): Promise<void> {
  const dayKey = dateOnly(clock.day);
  const existing = await d.db.workerJobRun.findFirst({
    where: { jobName: CHECKIN_ASSIGNMENT_JOB_NAME, propertyId: property.propertyId, scheduledFor: dayKey, status: { in: ["running", "completed"] } },
    select: { id: true, status: true }
  });
  if (existing) {
    summary.details.batchSkipped += 1;
    return;
  }
  const context = await d.serviceContext(property.propertyId, { kind: "system", job: "assignment" });
  const date = addDays(clock.day, 1);
  const correlationId = d.createId("corr");
  const run = await d.db.workerJobRun.create({
    data: {
      organizationId: context.organizationId,
      propertyId: property.propertyId,
      jobName: CHECKIN_ASSIGNMENT_JOB_NAME,
      queueName: CHECKIN_JOBS_QUEUE_NAME,
      payloadJson: { propertyId: property.propertyId, date, localDay: clock.day, trigger: "scheduler" },
      status: "running",
      attempts: 1,
      correlationId,
      scheduledFor: dayKey,
      startedAt: d.now()
    },
    select: { id: true }
  });
  try {
    const result = await d.runBatch({ context, propertyId: property.propertyId, date });
    await d.db.workerJobRun.update({
      where: { id: run.id },
      data: { status: "completed", finishedAt: d.now(), resultJson: { date, suggested: result.suggested, skipped: result.skipped, failed: result.failed.length } }
    });
    summary.suggested += result.suggested;
    summary.details.batchRuns += 1;
    for (const failure of result.failed) summary.failed.push({ propertyId: property.propertyId, step: "assign", entityId: failure.reservationId, error: failure.error });
  } catch (error) {
    await d.db.workerJobRun.update({ where: { id: run.id }, data: { status: "failed", finishedAt: d.now(), lastError: describeError(error).slice(0, 2000) } }).catch((updateError: unknown) => {
      d.log.warn({ runId: run.id, err: describeError(updateError) }, `${LOG} no se pudo marcar el lote como failed`);
    });
    throw error;
  }
}

async function purgeAll(d: CheckinJobsDeps, clock: LocalClock, summary: CheckinJobsTickSummary): Promise<void> {
  try {
    const { purged } = await d.purgeCaptures(d.now());
    summary.details.purgedCaptures = purged;
    summary.purged += purged;
  } catch (error) {
    summary.failed.push({ propertyId: null, step: "purge", entityId: "document_captures", error: describeError(error) });
  }
  try {
    const sessions = await d.db.checkInSession.findMany({
      where: { status: "invited" },
      select: { id: true, reservationId: true, organizationId: true, propertyId: true }
    });
    if (sessions.length === 0) return;
    const departed = await d.db.reservation.findMany({
      where: { id: { in: sessions.map((session) => session.reservationId) }, departureDate: { lt: dateOnly(clock.day) } },
      select: { id: true }
    });
    const departedIds = new Set(departed.map((row) => row.id));
    const toExpire = sessions.filter((session) => departedIds.has(session.reservationId));
    if (toExpire.length === 0) return;
    const updated = await d.db.checkInSession.updateMany({ where: { id: { in: toExpire.map((session) => session.id) }, status: "invited" }, data: { status: "expired" } });
    summary.details.expiredSessions = updated.count;
    summary.purged += updated.count;
    const correlationId = d.createId("corr");
    for (const session of toExpire) {
      d.audit({
        organizationId: session.organizationId,
        propertyId: session.propertyId,
        actorUserId: serviceUserId({ kind: "system", job: "purge" }),
        actorType: "system",
        action: "CheckInSessionExpired",
        entityType: "checkin_session",
        entityId: session.id,
        beforeJson: { status: "invited" },
        afterJson: { status: "expired", reservationId: session.reservationId, reason: "departure_passed" },
        deviceId: CHECKIN_SERVICE_DEVICE_ID,
        correlationId
      });
    }
  } catch (error) {
    summary.failed.push({ propertyId: null, step: "purge", entityId: "checkin_sessions", error: describeError(error) });
  }
}

async function runTickWork(d: CheckinJobsDeps): Promise<CheckinJobsTickSummary> {
  const now = d.now();
  const clock = localClock(now, d.timeZone);
  const runAt = d.config().assignmentRunAt;
  const assignmentDue = isAssignmentDue(clock.time, runAt);
  const summary: CheckinJobsTickSummary = {
    invited: 0,
    reminded: 0,
    suggested: 0,
    purged: 0,
    failed: [],
    details: { localDay: clock.day, localTime: clock.time, assignmentRunAt: runAt, assignmentDue, properties: 0, purgedCaptures: 0, expiredSessions: 0, batchRuns: 0, batchSkipped: 0 }
  };
  const properties = await enabledProperties(d);
  summary.details.properties = properties.length;
  for (const property of properties) {
    try {
      await inviteProperty(d, property, clock, summary);
    } catch (error) {
      summary.failed.push({ propertyId: property.propertyId, step: "invite", entityId: null, error: describeError(error) });
    }
    try {
      await remindProperty(d, property, clock, summary);
    } catch (error) {
      summary.failed.push({ propertyId: property.propertyId, step: "remind", entityId: null, error: describeError(error) });
    }
    if (assignmentDue) {
      try {
        await assignProperty(d, property, clock, summary);
      } catch (error) {
        summary.failed.push({ propertyId: property.propertyId, step: "assign", entityId: null, error: describeError(error) });
      }
    }
  }
  await purgeAll(d, clock, summary);
  return summary;
}

// ── Vuelta con lock global ───────────────────────────────────────────────────

/**
 * Una vuelta: advisory lock `checkin.jobs` (skip si otra réplica lo tiene) +
 * trabajo FUERA de la transacción del lock. `now`, `db` y el resto de
 * dependencias se inyectan en los tests (dobles sin base de datos).
 */
export async function runCheckinJobsTick(options: Partial<CheckinJobsDeps> = {}): Promise<CheckinJobsTickResult> {
  const d = withCheckinJobsDeps(options);
  const startedAt = new Date().toISOString();
  const outcome = await withAdvisoryLock({ db: d.db, key: CHECKIN_JOBS_LOCK_KEY, timeoutMs: CHECKIN_JOBS_LOCK_TIMEOUT_MS, log: d.log, run: () => runTickWork(d) });
  const finishedAt = new Date().toISOString();
  if (!outcome.locked) return { skipped: true, summary: null, startedAt, finishedAt };
  return { skipped: false, summary: outcome.result, startedAt, finishedAt, ...(outcome.lockExpired ? { lockExpired: true } : {}) };
}

export type StartCheckinJobsOptions = Partial<Omit<CheckinJobsDeps, "log">> & {
  log?: CheckinJobsLogger;
  /** CHECKIN_INVITATION_INTERVAL_MS (por defecto 1 h; mínimo 1 min). */
  intervalMs?: number;
  /** Ejecuta una vuelta al arrancar (por defecto true). */
  runAtBoot?: boolean;
  /** Lease del líder comprobado en cada vuelta del temporizador (por defecto holdsSchedulerLease). */
  holdsLease?: () => Promise<boolean>;
};

/**
 * Arranca el job (server.ts, bloque de schedulers, tras shouldStartCheckinJobs).
 * Cada vuelta del temporizador exige el lease del líder; `runNow()` la fuerza
 * sin lease (null si ya hay una en curso: flag anti-solape) y `stop()` para el
 * temporizador.
 */
export function startCheckinJobs(options: StartCheckinJobsOptions = {}): { runNow: () => Promise<CheckinJobsTickResult | null>; stop: () => void } {
  const { log: logOption, intervalMs: intervalOption, runAtBoot: bootOption, holdsLease: leaseOption, ...deps } = options;
  const log = logOption ?? defaultLog;
  const intervalMs = checkinJobsIntervalMs(intervalOption);
  const runAtBoot = bootOption ?? true;
  const holdsLease = leaseOption ?? (() => holdsSchedulerLease());
  let running = false;
  const runNow = async (): Promise<CheckinJobsTickResult | null> => {
    if (running) return null;
    running = true;
    try {
      const result = await runCheckinJobsTick({ ...deps, log });
      if (result.skipped) log.info({ checkin: result }, `${LOG} tick skipped (another replica holds the lock)`);
      else if (result.summary && result.summary.failed.length > 0) log.warn({ checkin: result.summary }, `${LOG} tick with failures`);
      else log.info({ checkin: result.summary }, `${LOG} tick`);
      return result;
    } catch (error) {
      // QC-06: un fallo del tick se registra con contexto y no tumba el intervalo.
      log.error({ err: describeError(error) }, `${LOG} tick failed`);
      return null;
    } finally {
      running = false;
    }
  };
  const leaderTick = async (): Promise<void> => {
    let leader = false;
    try {
      leader = await holdsLease();
    } catch (error) {
      log.error({ err: describeError(error) }, `${LOG} lease check failed (tick skipped)`);
      return;
    }
    if (!leader) return;
    await runNow();
  };
  const timer = setInterval(() => void leaderTick(), intervalMs);
  timer.unref?.();
  log.info({ intervalMs, runAtBoot }, `${LOG} enabled (every ${Math.round(intervalMs / 1000)}s · invitación J-3 + recordatorio J-1 + lote de asignación + purga)`);
  if (runAtBoot) void leaderTick();
  return { runNow, stop: () => clearInterval(timer) };
}
