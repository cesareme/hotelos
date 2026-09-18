// OPERA Cloud · modo sombra (Tanda 7b · L3) — servicio de perfil, cortes
// (`PmsShadowRun`), alertas (`PmsShadowAlert`), panel y reconciliación diaria
// (diseño §5.4, §5.5, §6.5 y §10). El núcleo es `ingestPmsShadowFile`: recibe un
// fichero (clave de API, correo, subida manual, CLI), lo clasifica, crea el run
// en `processing` y lo despacha al importador de reservas en modo `sync` (L1) o
// al importador de ingresos (L2); el run se cierra EN LÍNEA (`done` · `partial` ·
// `failed`): no existe cola de runs `received` pendientes (§10 nº 11 y corrección d).
//
// Reglas fijas:
//   · GDPR: el fichero NUNCA se persiste ni se loguea; el run guarda nombre, hash,
//     contadores y alertas; las alertas citan nº de confirmación, códigos, métricas e
//     importes, nunca nombre / e-mail / documento.
//   · Aislamiento: toda consulta filtra por organizationId Y propertyId; los 404 son
//     opacos (PMS_SHADOW_RUN_NOT_FOUND / _ALERT_NOT_FOUND / _PROFILE_NOT_FOUND).
//   · Idempotencia del run: (propertyId, feed, businessDate, contentHash) bajo
//     pg_advisory_xact_lock por propiedad; un run `failed` se reutiliza (vuelve a
//     `processing`), uno `done` | `partial` solo con `force` (contadores a 0 y
//     `force` propagado a los importadores); si no → 409 PMS_SHADOW_RUN_DUPLICATE.
//   · Permisos: el borde (manifiesto) exige integrations.* / accounting.*; aquí se
//     repite la clave de lectura / escritura y, en el ingest, las que exigen los
//     importadores según el feed (las 4 pms.* del sync, accounting.journal.post de
//     ingresos) ANTES de crear el run — así un usuario sin clave recibe 403 y no un
//     run fallido.
//   · Business date por defecto: `getCurrentBusinessDate` (night-audit.service.ts)
//     + `businessDateOffset` del feed en scheduleJson; en `revenue` gana la fecha que
//     declara el propio fichero (GEN_XMLBO_REVENUE `date`). En modo sombra el
//     business date de Anfitorio no avanza (el night audit ocurre en OPERA): los
//     orígenes automáticos deberían pasarlo explícito (el correo lo hace).

import { createHash } from "node:crypto";
import { prisma } from "@hotelos/database";
import { Prisma } from "@prisma/client";
import type {
  IsoDate,
  PermissionKey,
  PmsShadowAlertCode,
  PmsShadowAlertRecord,
  PmsShadowAlertSeverity,
  PmsShadowErrorCode,
  PmsShadowFeed,
  PmsShadowFeedState,
  PmsShadowFeedStatus,
  PmsShadowOverview,
  PmsShadowProfileRecord,
  PmsShadowProfileStatus,
  PmsShadowPropertyMapping,
  PmsShadowReconciliationRow,
  PmsShadowRunAlert,
  PmsShadowRunRecord,
  PmsShadowRunSource,
  PmsShadowRunStatus,
  PmsShadowSchedule,
  PmsShadowSystem,
  PmsShadowTrxCodeMapping,
  ReservationImportPreviewBody
} from "@hotelos/shared";
import { OPERA_CLOUD_PROFILE, PMS_SHADOW_ALERT_LABELS_ES, PMS_SHADOW_ALERT_SEVERITY, PMS_SHADOW_MAX_FILE_BYTES, PMS_SHADOW_SYSTEM_USER_ID } from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/http-error.js";
import { decodeXmlBytes } from "../../lib/xml-lite.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { requireAnyPermission } from "../treasury/permissions.js";
import { getCurrentBusinessDate } from "../night-audit/night-audit.service.js";
import { assertPropertyInOrg } from "../pms/pms.service.js";
import { importReservations } from "../pms/reservation-import.service.js";
import type { Db } from "../treasury/ledger-bridge.js";
import { dec, money } from "../treasury/money.js";
import {
  DEFAULT_PMS_SHADOW_SCHEDULE,
  PMS_SHADOW_STALE_RUN_MINUTES,
  PMS_SHADOW_UNRECOGNIZED_FEED,
  addDaysIso,
  buildAlertsFromSyncResult,
  classifyFeed,
  compareReconciliation,
  computeLateFeeds,
  headerOverrideFor,
  isIsoDate,
  localDateTime,
  isKnownFeed,
  isReservationFeed,
  lateFeedKey,
  mapRunSourceToImportSource,
  normalizeDeclaredStats,
  parseDeclaredStats,
  reconciliationAlertMessage,
  reconciliationMismatches,
  scheduleFeedsOf,
  type PmsShadowComputedStats,
  type PmsShadowDeclaredStats
} from "./pms-shadow.rules.js";
import { parseRevenueFile, revenueFileHead } from "./revenue-import.parser.js";
import { importPmsShadowRevenue, loadPmsShadowRevenueImport, reconciliationForDay, type PmsShadowRevenueDeclared } from "./revenue-import.service.js";

const SYSTEM: PmsShadowSystem = "opera_cloud";
const LOG = "[pms-shadow]";
const READ_KEYS: PermissionKey[] = ["integrations.read"];
const WRITE_KEYS: PermissionKey[] = ["integrations.connect"];
/** Borde: `accounting.read` del partial remapeada a `accounting.reports.read` (security/route-permissions.ts); el servicio admite cualquiera de las dos. */
const RECON_READ_KEYS: PermissionKey[] = ["accounting.reports.read", "accounting.read"];
const SYNC_KEYS: PermissionKey[] = ["pms.reservation.create", "pms.reservation.modify", "pms.checkin.execute", "pms.checkout.execute"];
const REVENUE_KEYS: PermissionKey[] = ["accounting.journal.post"];
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const RUN_NOT_FOUND = "Corte OPERA no encontrado.";
const ALERT_NOT_FOUND = "Alerta no encontrada.";
const PROFILE_NOT_FOUND = "Esta propiedad no tiene configurado el modo sombra.";
const TX_OPTIONS = { maxWait: 15_000, timeout: 60_000 } as const;

type ProfileRow = NonNullable<Awaited<ReturnType<typeof prisma.pmsShadowProfile.findUnique>>>;
type RunRow = NonNullable<Awaited<ReturnType<typeof prisma.pmsShadowRun.findUnique>>>;
type AlertRow = NonNullable<Awaited<ReturnType<typeof prisma.pmsShadowAlert.findUnique>>>;

export type PmsShadowRunCounts = { created: number; updated: number; unchanged: number; transitioned: number; skipped: number; error: number };

const ZERO_COUNTS: PmsShadowRunCounts = Object.freeze({ created: 0, updated: 0, unchanged: 0, transitioned: 0, skipped: 0, error: 0 });

// ---------------------------------------------------------------------------
// Errores tipados (details.code de PMS_SHADOW_ERROR_CODES)
// ---------------------------------------------------------------------------

function shadowBadRequest(code: PmsShadowErrorCode, message: string, extra: Record<string, unknown> = {}): BadRequestError {
  const error = new BadRequestError(message);
  error.details = { ...extra, code };
  return error;
}

function shadowConflict(code: PmsShadowErrorCode, message: string, extra: Record<string, unknown> = {}): ConflictError {
  return new ConflictError(message, { ...extra, code });
}

function shadowNotFound(code: PmsShadowErrorCode, message: string, extra: Record<string, unknown> = {}): NotFoundError {
  const error = new NotFoundError(message);
  error.details = { ...extra, code };
  return error;
}

// ---------------------------------------------------------------------------
// Helpers de JSON y de mapeo a los DTO wire
// ---------------------------------------------------------------------------

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function jsonArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function isoOf(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function isoDateOf(value: Date | null | undefined): IsoDate | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function dateOnlyUtc(iso: IsoDate): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function toProfileRecord(row: ProfileRow): PmsShadowProfileRecord {
  const schedule = jsonObject(row.scheduleJson);
  return {
    id: row.id,
    organizationId: row.organizationId,
    propertyId: row.propertyId,
    system: row.system as PmsShadowSystem,
    operaHotelCode: row.operaHotelCode,
    status: row.status as PmsShadowProfileStatus,
    mapping: jsonObject(row.mappingJson) as PmsShadowPropertyMapping,
    trxMapping: jsonArray<PmsShadowTrxCodeMapping>(row.trxMappingJson),
    schedule: { feeds: scheduleFeedsOf(schedule) } as PmsShadowSchedule,
    inboxEmail: row.inboxEmail,
    sftpFolder: row.sftpFolder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

export function toRunRecord(row: RunRow): PmsShadowRunRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    propertyId: row.propertyId,
    // `unknown` (PMS_SHADOW_UNRECOGNIZED_FEED) solo en runs fallidos por fichero no reconocible.
    feed: row.feed as PmsShadowFeed,
    source: row.source as PmsShadowRunSource,
    businessDate: isoDateOf(row.businessDate),
    fileName: row.fileName,
    contentHash: row.contentHash,
    status: row.status as PmsShadowRunStatus,
    reservationImportId: row.reservationImportId,
    revenueImportId: row.revenueImportId,
    createdCount: row.createdCount,
    updatedCount: row.updatedCount,
    unchangedCount: row.unchangedCount,
    transitionedCount: row.transitionedCount,
    skippedCount: row.skippedCount,
    errorCount: row.errorCount,
    result: jsonObject(row.resultJson),
    alerts: jsonArray<PmsShadowRunAlert>(row.alertsJson),
    errorMessage: row.errorMessage,
    correlationId: row.correlationId,
    createdBy: row.createdBy,
    startedAt: isoOf(row.startedAt),
    finishedAt: isoOf(row.finishedAt),
    createdAt: row.createdAt.toISOString()
  };
}

export function toAlertRecord(row: AlertRow): PmsShadowAlertRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    propertyId: row.propertyId,
    businessDate: isoDateOf(row.businessDate),
    code: row.code as PmsShadowAlertCode,
    severity: row.severity as PmsShadowAlertSeverity,
    message: row.message,
    expected: jsonObject(row.expectedJson),
    actual: jsonObject(row.actualJson),
    runId: row.runId,
    confirmationNo: row.confirmationNo,
    resolvedAt: isoOf(row.resolvedAt),
    resolvedBy: row.resolvedBy,
    resolutionNote: row.resolutionNote,
    createdAt: row.createdAt.toISOString()
  };
}

function countsOf(row: RunRow): PmsShadowRunCounts {
  return { created: row.createdCount, updated: row.updatedCount, unchanged: row.unchangedCount, transitioned: row.transitionedCount, skipped: row.skippedCount, error: row.errorCount };
}

function describeError(error: unknown): { statusCode: number | null; code: string | null; message: string; details: Record<string, unknown> } {
  const typed = (error ?? {}) as { statusCode?: unknown; details?: unknown; message?: unknown };
  const statusCode = typeof typed.statusCode === "number" ? typed.statusCode : null;
  const details = jsonObject(typed.details);
  const code = typeof details.code === "string" ? details.code : null;
  const message = typeof typed.message === "string" && typed.message.trim() ? typed.message.trim() : "Error al procesar el corte.";
  return { statusCode, code, message, details };
}

// ---------------------------------------------------------------------------
// Perfil
// ---------------------------------------------------------------------------

/** Perfil de la propiedad (aislado por organización); null si no existe. Sin permisos: para el ingest, el job y el correo. */
export async function findProfile(organizationId: string, propertyId: string, db: Db = prisma): Promise<ProfileRow | null> {
  const row = await db.pmsShadowProfile.findUnique({ where: { propertyId_system: { propertyId, system: SYSTEM } } });
  if (!row || row.organizationId !== organizationId) return null;
  return row;
}

/** `GET …/pms-shadow/profile` (integrations.read): 404 PMS_SHADOW_PROFILE_NOT_FOUND si la propiedad no lo tiene. */
export async function getProfile(input: { context: UserContext; propertyId: string }): Promise<PmsShadowProfileRecord> {
  requirePermissions(input.context, READ_KEYS);
  await assertPropertyInOrg(input.propertyId, input.context.organizationId);
  const row = await findProfile(input.context.organizationId, input.propertyId);
  if (!row) throw shadowNotFound("PMS_SHADOW_PROFILE_NOT_FOUND", PROFILE_NOT_FOUND);
  return toProfileRecord(row);
}

/**
 * Perfil existente o uno nuevo con valores por defecto (código OPERA = código del
 * centro, programación DEFAULT_PMS_SHADOW_SCHEDULE, sin mapeos). Para el CLI, L6 y
 * `upsertProfile`; no comprueba permisos.
 */
export async function getOrCreateProfile(input: { organizationId: string; propertyId: string; operaHotelCode?: string | null; db?: Db }): Promise<ProfileRow> {
  const db = input.db ?? prisma;
  const existing = await findProfile(input.organizationId, input.propertyId, db);
  if (existing) return existing;
  const property = await db.property.findUnique({ where: { id: input.propertyId }, select: { organizationId: true, code: true } });
  if (!property || property.organizationId !== input.organizationId) throw new NotFoundError("Propiedad no encontrada.");
  return db.pmsShadowProfile.create({
    data: {
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      system: SYSTEM,
      operaHotelCode: (input.operaHotelCode ?? property.code ?? "OPERA").trim().slice(0, 20) || "OPERA",
      status: "active",
      mappingJson: {},
      trxMappingJson: [],
      scheduleJson: DEFAULT_PMS_SHADOW_SCHEDULE as unknown as Prisma.InputJsonValue
    }
  });
}

export type ProfileUpsertBody = {
  operaHotelCode: string;
  status?: PmsShadowProfileStatus;
  mappingJson?: PmsShadowPropertyMapping;
  trxMappingJson?: PmsShadowTrxCodeMapping[];
  scheduleJson?: PmsShadowSchedule;
  inboxEmail?: string | null;
  sftpFolder?: string | null;
};

function profileSummary(row: ProfileRow | null): Record<string, unknown> | null {
  if (!row) return null;
  return {
    operaHotelCode: row.operaHotelCode,
    status: row.status,
    mappingKeys: Object.keys(jsonObject(row.mappingJson)),
    trxMappings: jsonArray(row.trxMappingJson).length,
    scheduledFeeds: scheduleFeedsOf(row.scheduleJson).map((feed) => feed.feed),
    inboxEmail: row.inboxEmail,
    sftpFolder: row.sftpFolder
  };
}

/** `PUT …/pms-shadow/profile` (integrations.connect): crea o edita; `null` en inboxEmail / sftpFolder los vacía. Auditoría PMS_SHADOW_PROFILE_UPDATED. */
export async function upsertProfile(input: { context: UserContext; propertyId: string; body: ProfileUpsertBody; correlationId: string }): Promise<PmsShadowProfileRecord> {
  requirePermissions(input.context, WRITE_KEYS);
  const organizationId = input.context.organizationId;
  await assertPropertyInOrg(input.propertyId, organizationId);
  const existing = await findProfile(organizationId, input.propertyId);
  const body = input.body;
  const operaHotelCode = body.operaHotelCode.trim();
  const update: Prisma.PmsShadowProfileUpdateInput = {
    operaHotelCode,
    ...(body.status !== undefined ? { status: body.status } : {}),
    ...(body.mappingJson !== undefined ? { mappingJson: body.mappingJson as unknown as Prisma.InputJsonValue } : {}),
    ...(body.trxMappingJson !== undefined ? { trxMappingJson: body.trxMappingJson as unknown as Prisma.InputJsonValue } : {}),
    ...(body.scheduleJson !== undefined ? { scheduleJson: body.scheduleJson as unknown as Prisma.InputJsonValue } : {}),
    ...(body.inboxEmail !== undefined ? { inboxEmail: body.inboxEmail } : {}),
    ...(body.sftpFolder !== undefined ? { sftpFolder: body.sftpFolder } : {})
  };
  const row = await prisma.pmsShadowProfile.upsert({
    where: { propertyId_system: { propertyId: input.propertyId, system: SYSTEM } },
    create: {
      organizationId,
      propertyId: input.propertyId,
      system: SYSTEM,
      operaHotelCode,
      status: body.status ?? "active",
      mappingJson: (body.mappingJson ?? {}) as unknown as Prisma.InputJsonValue,
      trxMappingJson: (body.trxMappingJson ?? []) as unknown as Prisma.InputJsonValue,
      scheduleJson: (body.scheduleJson ?? DEFAULT_PMS_SHADOW_SCHEDULE) as unknown as Prisma.InputJsonValue,
      inboxEmail: body.inboxEmail ?? null,
      sftpFolder: body.sftpFolder ?? null
    },
    update
  });
  recordAuditEvent({
    organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "PMS_SHADOW_PROFILE_UPDATED",
    entityType: "pms_shadow_profile",
    entityId: row.id,
    beforeJson: profileSummary(existing),
    afterJson: profileSummary(row),
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });
  return toProfileRecord(row);
}

// ---------------------------------------------------------------------------
// Alertas
// ---------------------------------------------------------------------------

export type CreateAlertInput = {
  organizationId: string;
  propertyId: string;
  code: PmsShadowAlertCode;
  businessDate?: IsoDate | null;
  confirmationNo?: string | null;
  expected?: Record<string, unknown>;
  actual?: Record<string, unknown>;
  runId?: string | null;
  /** Español, sin datos personales; por defecto la etiqueta del código. */
  message?: string;
  severity?: PmsShadowAlertSeverity;
};

/**
 * Crea la alerta salvo que ya exista una ABIERTA con el mismo (propiedad, código,
 * business date, nº de confirmación): una alerta por hecho, no una por corte.
 * SC-06: las alertas POR RESERVA (`confirmationNo` presente: OPERA_MISSING_IN_SNAPSHOT,
 * OPERA_CONFLICT_LOCAL_RESERVATION, OPERA_CHECKIN_WITHOUT_ROOM) se deduplican por
 * (propiedad, código, nº de confirmación) sin el business date —una ausencia que dura
 * tres cortes es UNA alerta, no tres— y la abierta se refresca con el business date,
 * la severidad, el mensaje y el `actual` del último corte (la racha 1 → 2 sube a error).
 */
export async function createAlertIfOpen(input: CreateAlertInput, db: Db = prisma): Promise<{ alert: AlertRow; created: boolean }> {
  const businessDate = input.businessDate ? dateOnlyUtc(input.businessDate) : null;
  const confirmationNo = input.confirmationNo ?? null;
  const open = await db.pmsShadowAlert.findFirst({
    where: { organizationId: input.organizationId, propertyId: input.propertyId, code: input.code, ...(confirmationNo ? {} : { businessDate }), confirmationNo, resolvedAt: null },
    orderBy: { createdAt: "desc" }
  });
  if (open && confirmationNo) {
    const refreshed = await db.pmsShadowAlert.update({
      where: { id: open.id },
      data: {
        businessDate: businessDate ?? open.businessDate,
        severity: input.severity ?? open.severity,
        message: input.message ?? open.message,
        ...(input.actual ? { actualJson: input.actual as Prisma.InputJsonValue } : {}),
        ...(input.runId ? { runId: input.runId } : {})
      }
    });
    return { alert: refreshed, created: false };
  }
  if (open) return { alert: open, created: false };
  const alert = await db.pmsShadowAlert.create({
    data: {
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      businessDate,
      code: input.code,
      severity: input.severity ?? PMS_SHADOW_ALERT_SEVERITY[input.code],
      message: input.message ?? PMS_SHADOW_ALERT_LABELS_ES[input.code],
      expectedJson: (input.expected ?? {}) as Prisma.InputJsonValue,
      actualJson: (input.actual ?? {}) as Prisma.InputJsonValue,
      runId: input.runId ?? null,
      confirmationNo
    }
  });
  return { alert, created: true };
}

/** Persiste las alertas de un run (dedupe por createAlertIfOpen); devuelve cuántas son nuevas. */
async function persistRunAlerts(input: { organizationId: string; propertyId: string; runId: string; businessDate: IsoDate | null; alerts: readonly PmsShadowRunAlert[] }): Promise<number> {
  let created = 0;
  for (const alert of input.alerts) {
    const details = alert.details ?? {};
    const result = await createAlertIfOpen({
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      code: alert.code,
      businessDate: input.businessDate,
      confirmationNo: alert.confirmationNo ?? null,
      expected: jsonObject(details.expected) ,
      actual: Object.keys(jsonObject(details.actual)).length > 0 ? jsonObject(details.actual) : details,
      runId: input.runId,
      message: alert.message,
      severity: alert.severity
    });
    if (result.created) created += 1;
  }
  return created;
}

export type AlertsQuery = { open?: boolean; code?: PmsShadowAlertCode; businessDate?: IsoDate; limit?: number };

/** `GET …/pms-shadow/alerts` (integrations.read): abiertas por defecto (`open=false` → resueltas), por createdAt desc. */
export async function listAlerts(input: { context: UserContext; propertyId: string; query?: AlertsQuery }): Promise<PmsShadowAlertRecord[]> {
  requirePermissions(input.context, READ_KEYS);
  await assertPropertyInOrg(input.propertyId, input.context.organizationId);
  const query = input.query ?? {};
  const open = query.open ?? true;
  const rows = await prisma.pmsShadowAlert.findMany({
    where: {
      organizationId: input.context.organizationId,
      propertyId: input.propertyId,
      resolvedAt: open ? null : { not: null },
      ...(query.code ? { code: query.code } : {}),
      ...(query.businessDate ? { businessDate: dateOnlyUtc(query.businessDate) } : {})
    },
    orderBy: [{ createdAt: "desc" }],
    take: Math.min(Math.max(query.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT)
  });
  return rows.map(toAlertRecord);
}

/** `POST …/pms-shadow/alerts/:id/resolve` (integrations.connect): 404 opaco, 409 si ya estaba resuelta; auditoría PMS_SHADOW_ALERT_RESOLVED con la nota. */
export async function resolveAlert(input: { context: UserContext; propertyId: string; alertId: string; note: string; correlationId: string }): Promise<PmsShadowAlertRecord> {
  requirePermissions(input.context, WRITE_KEYS);
  const organizationId = input.context.organizationId;
  await assertPropertyInOrg(input.propertyId, organizationId);
  const row = await prisma.pmsShadowAlert.findUnique({ where: { id: input.alertId } });
  if (!row || row.organizationId !== organizationId || row.propertyId !== input.propertyId) throw shadowNotFound("PMS_SHADOW_ALERT_NOT_FOUND", ALERT_NOT_FOUND);
  if (row.resolvedAt) throw shadowConflict("PMS_SHADOW_ALERT_ALREADY_RESOLVED", "La alerta ya estaba resuelta.", { alertId: row.id, resolvedAt: row.resolvedAt.toISOString() });
  const note = input.note.trim();
  const updated = await prisma.pmsShadowAlert.update({ where: { id: row.id }, data: { resolvedAt: new Date(), resolvedBy: input.context.userId, resolutionNote: note } });
  recordAuditEvent({
    organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "PMS_SHADOW_ALERT_RESOLVED",
    entityType: "pms_shadow_alert",
    entityId: row.id,
    beforeJson: { code: row.code, severity: row.severity, businessDate: isoDateOf(row.businessDate), confirmationNo: row.confirmationNo, runId: row.runId },
    afterJson: { resolvedAt: updated.resolvedAt?.toISOString() ?? null, note },
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });
  return toAlertRecord(updated);
}

/** Cierra en bloque las alertas abiertas de un código y día (reconciliación que vuelve a cuadrar, actor de sistema). */
async function resolveOpenAlerts(input: { organizationId: string; propertyId: string; code: PmsShadowAlertCode; businessDate: IsoDate; note: string }, db: Db = prisma): Promise<number> {
  const result = await db.pmsShadowAlert.updateMany({
    where: { organizationId: input.organizationId, propertyId: input.propertyId, code: input.code, businessDate: dateOnlyUtc(input.businessDate), resolvedAt: null },
    data: { resolvedAt: new Date(), resolvedBy: PMS_SHADOW_SYSTEM_USER_ID, resolutionNote: input.note }
  });
  return result.count;
}

// ---------------------------------------------------------------------------
// Cortes (runs)
// ---------------------------------------------------------------------------

export type RunsQuery = { feed?: PmsShadowFeed; status?: PmsShadowRunStatus; businessDate?: IsoDate; limit?: number };

/** `GET …/pms-shadow/runs` (integrations.read): por createdAt desc, `limit` 1..200 (50). */
export async function listRuns(input: { context: UserContext; propertyId: string; query?: RunsQuery }): Promise<PmsShadowRunRecord[]> {
  requirePermissions(input.context, READ_KEYS);
  await assertPropertyInOrg(input.propertyId, input.context.organizationId);
  const query = input.query ?? {};
  const rows = await prisma.pmsShadowRun.findMany({
    where: {
      organizationId: input.context.organizationId,
      propertyId: input.propertyId,
      ...(query.feed ? { feed: query.feed } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.businessDate ? { businessDate: dateOnlyUtc(query.businessDate) } : {})
    },
    orderBy: [{ createdAt: "desc" }],
    take: Math.min(Math.max(query.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT)
  });
  return rows.map(toRunRecord);
}

/** `GET …/pms-shadow/runs/:id` (integrations.read): 404 opaco PMS_SHADOW_RUN_NOT_FOUND fuera de la propiedad / organización. */
export async function getRun(input: { context: UserContext; propertyId: string; runId: string }): Promise<PmsShadowRunRecord> {
  requirePermissions(input.context, READ_KEYS);
  await assertPropertyInOrg(input.propertyId, input.context.organizationId);
  const row = await prisma.pmsShadowRun.findUnique({ where: { id: input.runId } });
  if (!row || row.organizationId !== input.context.organizationId || row.propertyId !== input.propertyId) throw shadowNotFound("PMS_SHADOW_RUN_NOT_FOUND", RUN_NOT_FOUND);
  return toRunRecord(row);
}

/**
 * SEC-09: runs que ESTA instancia del API está procesando ahora mismo. `failStaleRuns` los
 * excluye: un corte lento (fichero grande) no se marca «interrumpido» a los 30 min mientras
 * sigue vivo, porque un run `failed` es reutilizable y el mismo fichero acabaría procesándose
 * dos veces en paralelo. El API es una sola instancia con los schedulers dentro; con varias
 * réplicas el conjunto es local y el corte de 30 min sigue actuando como red de seguridad.
 */
const inFlightRuns = new Set<string>();

/** Job del líder: runs `processing` con `startedAt` anterior a `now − PMS_SHADOW_STALE_RUN_MINUTES` → `failed` «interrumpido». Devuelve cuántos. */
export async function failStaleRuns(input: { now?: Date; db?: Db } = {}): Promise<number> {
  const db = input.db ?? prisma;
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - PMS_SHADOW_STALE_RUN_MINUTES * 60_000);
  const result = await db.pmsShadowRun.updateMany({
    where: { status: "processing", ...(inFlightRuns.size > 0 ? { id: { notIn: [...inFlightRuns] } } : {}), OR: [{ startedAt: { lt: cutoff } }, { startedAt: null, createdAt: { lt: cutoff } }] },
    data: { status: "failed", finishedAt: now, errorMessage: `Corte interrumpido: llevaba más de ${PMS_SHADOW_STALE_RUN_MINUTES} minutos en proceso (reinicio del API a medias). Vuelve a enviar el fichero.` }
  });
  return result.count;
}

// ---------------------------------------------------------------------------
// Reconciliación diaria (§5.4)
// ---------------------------------------------------------------------------

export type PmsShadowReconciliation = {
  propertyId: string;
  businessDate: IsoDate;
  rows: PmsShadowReconciliationRow[];
  /** Sin filas `mismatch` (las `missing` no cuentan: falta un lado). */
  ok: boolean;
  mismatches: { count: number; revenue: number };
  declared: PmsShadowDeclaredStats;
  computed: PmsShadowComputedStats;
  sources: { statsRunId: string | null; revenueImportId: string | null; revenueStatus: string | null };
  alerts: Array<{ code: PmsShadowAlertCode; alertId: string; created: boolean }>;
};

/**
 * `GET …/pms-shadow/reconciliation?businessDate=` (accounting.read). SEC-05: solo lectura —
 * calcula y compara pero NO crea ni cierra alertas (`persistAlerts: false`); las alertas de
 * reconciliación las escribe el ingest al recibir `revenue` / `stats` del día (§6.5).
 */
export async function getReconciliation(input: { context: UserContext; propertyId: string; businessDate: IsoDate }): Promise<PmsShadowReconciliation> {
  requireAnyPermission(input.context, RECON_READ_KEYS);
  await assertPropertyInOrg(input.propertyId, input.context.organizationId);
  return computeReconciliation({ organizationId: input.context.organizationId, propertyId: input.propertyId, businessDate: input.businessDate, persistAlerts: false });
}

/**
 * Lo que Anfitorio calcula (reservas enlazadas y asiento del día) frente a lo que
 * OPERA declara (run `stats` del día + reconciliationJson del lote de ingresos), con
 * las tolerancias de §5.4. Guarda / actualiza OPERA_RECON_COUNT_MISMATCH y
 * OPERA_RECON_REVENUE_MISMATCH (una abierta por código y día) y las cierra cuando
 * vuelve a cuadrar. Sin permisos: el llamador aisló propiedad y organización.
 */
export async function computeReconciliation(input: {
  organizationId: string;
  propertyId: string;
  businessDate: IsoDate;
  runId?: string | null;
  persistAlerts?: boolean;
  /**
   * Integrador 7b: métricas declaradas por el run que DISPARA la reconciliación. Ese run sigue `processing`
   * (se cierra después) y su `resultJson` aún no lleva `declared`: sin este parámetro, la desviación de un
   * Manager Report solo saltaba con el siguiente fichero del día y el Trial Balance nunca cuadraba en su propio run.
   */
  declared?: Record<string, unknown> | null;
}): Promise<PmsShadowReconciliation> {
  const { organizationId, propertyId, businessDate } = input;
  const persistAlerts = input.persistAlerts !== false;
  if (!isIsoDate(businessDate)) throw shadowBadRequest("VALIDATION_ERROR", "businessDate debe ser una fecha AAAA-MM-DD.", { field: "businessDate" });
  const property = await prisma.property.findUnique({ where: { id: propertyId }, select: { organizationId: true, timezone: true } });
  if (!property || property.organizationId !== organizationId) throw new NotFoundError("Propiedad no encontrada.");
  const date = dateOnlyUtc(businessDate);

  // SC-09: «Arrival Rooms» del Manager Report cuenta llegadas efectivas; los no-show van en «No Show Rooms».
  const [arrivals, departures, occupied, noShows, sellableRooms, day] = await Promise.all([
    prisma.reservation.aggregate({ _sum: { roomsCount: true }, where: { propertyId, deletedAt: null, arrivalDate: date, status: { notIn: ["cancelled", "draft", "no_show"] } } }),
    prisma.reservation.aggregate({ _sum: { roomsCount: true }, where: { propertyId, deletedAt: null, departureDate: date, status: { notIn: ["cancelled", "draft", "no_show"] } } }),
    // En casa esa noche: llegada ≤ fecha < salida; `checked_in` hoy, `checked_out` en días ya cerrados.
    prisma.reservation.aggregate({ _sum: { roomsCount: true }, where: { propertyId, deletedAt: null, arrivalDate: { lte: date }, departureDate: { gt: date }, status: { in: ["checked_in", "checked_out"] } } }),
    prisma.reservation.aggregate({ _sum: { roomsCount: true }, where: { propertyId, deletedAt: null, arrivalDate: date, status: "no_show" } }),
    prisma.room.count({ where: { propertyId, sellable: true, active: true } }),
    reconciliationForDay(propertyId, businessDate, { organizationId })
  ]);
  // SC-04: `reservations_made` y `cancellations` NO se calculan con snapshots (§5.2): `Reservation.createdAt`
  // es el día en que el sync creó la reserva en Anfitorio (un corte inicial de 30 días «hace» todas ese día
  // y una reserva hecha ayer en OPERA nace hoy), y la cancelación se ve el día del corte, no el de OPERA.
  // Hasta disponer del feed `changes` (resreservyesterday / rescancel) o del async `dailySummary`
  // (fase 2) quedan `null` → fila `missing` (no comparable), nunca OPERA_RECON_COUNT_MISMATCH.

  const roomsOccupied = dec(occupied._sum.roomsCount ?? 0);
  const totalRooms = dec(sellableRooms);
  const posted = day.importId && day.status === "posted" ? await loadPmsShadowRevenueImport(organizationId, propertyId, day.importId) : null;
  let roomRevenue: Prisma.Decimal | null = null;
  if (posted) {
    roomRevenue = dec(0);
    for (const line of posted.lines) if (line.kind === "revenue" && line.usaliDepartment === "rooms") roomRevenue = roomRevenue.plus(dec(line.amount));
  }
  const computed: PmsShadowComputedStats = {
    arrivalRooms: String(arrivals._sum.roomsCount ?? 0),
    departureRooms: String(departures._sum.roomsCount ?? 0),
    roomsOccupied: roomsOccupied.toFixed(0),
    occupancyPct: totalRooms.gt(0) ? money(roomsOccupied.mul(100).div(totalRooms)) : null,
    noShowRooms: String(noShows._sum.roomsCount ?? 0),
    roomRevenue: roomRevenue ? money(roomRevenue) : null,
    totalRevenue: posted ? day.revenue705 : null,
    taxTotal: posted ? day.tax477 : null,
    adr: roomRevenue && roomsOccupied.gt(0) ? money(roomRevenue.div(roomsOccupied)) : null,
    revpar: roomRevenue && totalRooms.gt(0) ? money(roomRevenue.div(totalRooms)) : null,
    transactionTotalToday: day.check?.sumTotalAmount ?? null,
    reservationsMadeToday: null,
    cancellationsMadeToday: null
  };

  // Declarado: runs del día con `resultJson.declared` (el feed stats primero) + lo que trajo el lote de ingresos.
  const runs = await prisma.pmsShadowRun.findMany({
    where: { organizationId, propertyId, businessDate: date, status: { in: ["done", "partial"] } },
    orderBy: [{ finishedAt: "desc" }],
    select: { id: true, feed: true, resultJson: true },
    take: 500
  });
  const declared: PmsShadowDeclaredStats = {};
  // Lo que trae el propio fichero manda sobre lo declarado por cortes anteriores del mismo día (ver el parámetro).
  const own = normalizeDeclaredStats(input.declared);
  if (own) for (const [key, value] of Object.entries(own)) if (value) (declared as Record<string, string>)[key] = value;
  let statsRunId: string | null = null;
  const fromRuns = [...runs.filter((run) => run.feed === "stats"), ...runs.filter((run) => run.feed !== "stats")];
  for (const run of fromRuns) {
    const normalized = normalizeDeclaredStats(jsonObject(run.resultJson).declared);
    if (!normalized) continue;
    if (run.feed === "stats" && !statsRunId) statsRunId = run.id;
    for (const [key, value] of Object.entries(normalized)) if (value && !(key in declared)) (declared as Record<string, string>)[key] = value;
  }
  const fromRevenue = normalizeDeclaredStats(day.declared as PmsShadowRevenueDeclared as Record<string, unknown>);
  if (fromRevenue) for (const [key, value] of Object.entries(fromRevenue)) if (value && !(key in declared)) (declared as Record<string, string>)[key] = value;

  const rows = compareReconciliation({ declared, computed });
  const mismatches = reconciliationMismatches(rows);
  const alerts: PmsShadowReconciliation["alerts"] = [];
  const alertFor = async (code: "OPERA_RECON_COUNT_MISMATCH" | "OPERA_RECON_REVENUE_MISMATCH", rowsOfKind: PmsShadowReconciliationRow[]): Promise<void> => {
    if (!persistAlerts) return;
    if (rowsOfKind.length === 0) {
      await resolveOpenAlerts({ organizationId, propertyId, code, businessDate, note: "La reconciliación del día vuelve a cuadrar (cierre automático)." });
      return;
    }
    const result = await createAlertIfOpen({
      organizationId,
      propertyId,
      code,
      businessDate,
      expected: Object.fromEntries(rowsOfKind.map((row) => [row.metric, row.opera])),
      actual: Object.fromEntries(rowsOfKind.map((row) => [row.metric, row.anfitorio])),
      runId: input.runId ?? statsRunId ?? null,
      message: reconciliationAlertMessage(code, businessDate, rowsOfKind)
    });
    alerts.push({ code, alertId: result.alert.id, created: result.created });
  };
  await alertFor("OPERA_RECON_COUNT_MISMATCH", mismatches.count);
  await alertFor("OPERA_RECON_REVENUE_MISMATCH", mismatches.revenue);

  return {
    propertyId,
    businessDate,
    rows,
    ok: mismatches.count.length === 0 && mismatches.revenue.length === 0,
    mismatches: { count: mismatches.count.length, revenue: mismatches.revenue.length },
    declared,
    computed,
    sources: { statsRunId, revenueImportId: day.importId, revenueStatus: day.status },
    alerts
  };
}

// ---------------------------------------------------------------------------
// Panel (overview)
// ---------------------------------------------------------------------------

/** `GET …/pms-shadow/overview` (integrations.read): KPIs y tabla de feeds. */
export async function getOverview(input: { context: UserContext; propertyId: string; now?: Date }): Promise<PmsShadowOverview> {
  requirePermissions(input.context, READ_KEYS);
  const organizationId = input.context.organizationId;
  await assertPropertyInOrg(input.propertyId, organizationId);
  const propertyId = input.propertyId;
  const now = input.now ?? new Date();
  const [profile, property, lastRun, linkedReservations, openAlerts, reconciled] = await Promise.all([
    findProfile(organizationId, propertyId),
    prisma.property.findUnique({ where: { id: propertyId }, select: { timezone: true } }),
    prisma.pmsShadowRun.findFirst({ where: { organizationId, propertyId }, orderBy: [{ createdAt: "desc" }], select: { createdAt: true } }),
    prisma.pmsShadowLink.count({ where: { organizationId, propertyId } }),
    prisma.pmsShadowAlert.count({ where: { organizationId, propertyId, resolvedAt: null } }),
    prisma.pmsShadowRun.findFirst({
      where: { organizationId, propertyId, status: { in: ["done", "partial"] }, resultJson: { path: ["reconciliation", "ok"], equals: true } },
      orderBy: [{ businessDate: "desc" }],
      select: { businessDate: true }
    })
  ]);
  const scheduled = profile ? scheduleFeedsOf(profile.scheduleJson) : [];
  const feedNames = new Set<string>(scheduled.map((feed) => feed.feed));
  // L2-05: un groupBy da los feeds con runs y el createdAt del último de cada uno; una consulta más trae esas filas
  // (antes: distinct en memoria + un findFirst por feed).
  const lastByFeed = await prisma.pmsShadowRun.groupBy({ by: ["feed"], where: { organizationId, propertyId }, _max: { createdAt: true } });
  for (const row of lastByFeed) if (isKnownFeed(row.feed)) feedNames.add(row.feed);
  const lastRuns = new Map<string, RunRow>();
  const lastKeys = lastByFeed.filter((row) => feedNames.has(row.feed) && row._max.createdAt !== null).map((row) => ({ feed: row.feed, createdAt: row._max.createdAt as Date }));
  if (lastKeys.length > 0) {
    const rows = await prisma.pmsShadowRun.findMany({ where: { organizationId, propertyId, OR: lastKeys }, orderBy: [{ createdAt: "desc" }], take: lastKeys.length * 4 });
    for (const row of rows) if (!lastRuns.has(row.feed)) lastRuns.set(row.feed, row);
  }
  const runKeys = new Set<string>();
  for (const [feed, row] of lastRuns) {
    const businessDate = isoDateOf(row.businessDate);
    if (businessDate) runKeys.add(lateFeedKey(propertyId, feed, businessDate));
  }
  // Runs de hoy (cualquier estado) para la puntualidad: los de la vista de «último run» pueden ser de otro día.
  const todayRuns = profile
    ? await prisma.pmsShadowRun.findMany({ where: { organizationId, propertyId, createdAt: { gte: new Date(now.getTime() - 2 * 86_400_000) } }, select: { feed: true, businessDate: true }, take: 5_000 })
    : [];
  for (const row of todayRuns) {
    const businessDate = isoDateOf(row.businessDate);
    if (businessDate) runKeys.add(lateFeedKey(propertyId, row.feed, businessDate));
  }
  const late = profile && profile.status === "active" ? computeLateFeeds({ profiles: [{ propertyId, timezone: property?.timezone ?? "Europe/Madrid", schedule: profile.scheduleJson }], runsByPropertyFeedDate: runKeys, now }) : [];
  const lateFeeds = new Set(late.map((entry) => entry.feed));
  const feeds: PmsShadowFeedStatus[] = [];
  const ordered = [...scheduled.map((feed) => feed.feed), ...[...feedNames].filter((feed) => !scheduled.some((entry) => entry.feed === feed))];
  for (const feed of ordered) {
    if (!isKnownFeed(feed)) continue;
    const schedule = scheduled.find((entry) => entry.feed === feed);
    const last = lastRuns.get(feed) ?? null;
    let state: PmsShadowFeedState;
    if (!schedule) state = "unscheduled";
    else if (lateFeeds.has(feed)) state = "late";
    else if (!last) state = "pending";
    else if (last.status === "failed") state = "failed";
    else state = "ok";
    feeds.push({ feed, expectedTime: schedule?.expectedTime ?? null, required: schedule?.required ?? false, state, lastRun: last ? toRunRecord(last) : null });
  }
  return {
    propertyId,
    profile: profile ? toProfileRecord(profile) : null,
    lastRunAt: lastRun ? lastRun.createdAt.toISOString() : null,
    linkedReservations,
    openAlerts,
    lastReconciledDate: isoDateOf(reconciled?.businessDate ?? null),
    feeds
  };
}

// ---------------------------------------------------------------------------
// Ingest: un fichero → un run cerrado en línea
// ---------------------------------------------------------------------------

export type PmsShadowIngestInput = {
  context: UserContext;
  propertyId: string;
  source: PmsShadowRunSource;
  feed: PmsShadowFeed | "auto";
  fileName: string;
  bytes: Buffer;
  businessDate?: IsoDate | null;
  force?: boolean;
  horizonDays?: number | null;
  /** Métricas declaradas por OPERA que acompañan al corte (cuerpo `declared`). */
  declared?: Record<string, unknown> | null;
  /** Trial Balance / Manager Report del día para el importador de ingresos. */
  reconciliation?: PmsShadowRevenueDeclared | null;
  correlationId: string;
  /** Por defecto `context.userId`; el ingest por clave de API pasa `developer_app:<clientId>`. */
  createdBy?: string | null;
};

export type PmsShadowIngestResult = {
  runId: string;
  status: PmsShadowRunStatus;
  counts: PmsShadowRunCounts;
  alerts: PmsShadowRunAlert[];
  run: PmsShadowRunRecord;
};

type Outcome = {
  status: PmsShadowRunStatus;
  counts: PmsShadowRunCounts;
  alerts: PmsShadowRunAlert[];
  result: Record<string, unknown>;
  errorMessage: string | null;
  reservationImportId: string | null;
  revenueImportId: string | null;
};

function requiredKeysFor(feed: string): PermissionKey[] {
  if (isReservationFeed(feed)) return SYNC_KEYS;
  if (feed === "revenue") return REVENUE_KEYS;
  return [];
}

async function resolveBusinessDate(input: { requested: IsoDate | null | undefined; feed: string; profile: ProfileRow; propertyId: string; fileName: string | null; contentBase64: string }): Promise<IsoDate> {
  if (input.requested) {
    if (!isIsoDate(input.requested)) throw shadowBadRequest("VALIDATION_ERROR", "businessDate debe ser una fecha AAAA-MM-DD.", { field: "businessDate" });
    return input.requested;
  }
  if (input.feed === "revenue") {
    try {
      const { parsed } = parseRevenueFile({ fileName: input.fileName, contentBase64: input.contentBase64 });
      if (parsed.businessDate) return parsed.businessDate;
    } catch {
      // El importador de ingresos informará del error real (formato, hotel, fecha).
    }
  }
  // SC-02: en modo sombra `business_dates.current_date` NO avanza (el night audit ocurre en OPERA), así que
  // anclar el corte a él desplaza la ventana del diff y hace que `computeLateFeeds` (hoy local + offset) nunca
  // case con el run → OPERA_FEED_LATE falsa cada día. Como `checkInReservation` (pms.service) y el conector
  // de correo: la referencia es el MÁS RECIENTE entre el business date de Anfitorio y hoy en la zona del hotel.
  const [current, property] = await Promise.all([getCurrentBusinessDate(input.propertyId), prisma.property.findUnique({ where: { id: input.propertyId }, select: { timezone: true } })]);
  const localToday = localDateTime(new Date(), property?.timezone ?? "Europe/Madrid").date;
  const reference = current > localToday ? current : localToday;
  const offset = scheduleFeedsOf(input.profile.scheduleJson).find((entry) => entry.feed === input.feed)?.businessDateOffset ?? 0;
  return addDaysIso(reference, offset);
}

function runAlert(code: PmsShadowAlertCode, message: string, details: Record<string, unknown> = {}): PmsShadowRunAlert {
  return { code, severity: PMS_SHADOW_ALERT_SEVERITY[code], message, details };
}

type FeedInput = Omit<PmsShadowIngestInput, "fileName" | "createdBy"> & { run: RunRow; businessDate: IsoDate; fileName: string | null; createdBy: string | null };

async function processReservationFeed(input: FeedInput & { feed: "arrivals" | "inhouse" | "departures" | "changes"; head: string }, outcome: Outcome): Promise<void> {
  const headerOverride = headerOverrideFor(input.feed, input.head);
  const body: ReservationImportPreviewBody = {
    mode: "sync",
    profile: "opera_cloud",
    feed: input.feed,
    businessDate: input.businessDate,
    ...(input.fileName ? { fileName: input.fileName } : {}),
    contentBase64: input.bytes.toString("base64"),
    omitirInvalidas: true,
    force: input.force === true,
    ...(input.horizonDays ? { horizonDays: input.horizonDays } : {}),
    ...(headerOverride ? { headerOverride } : {})
  };
  const result = await importReservations({ context: input.context, propertyId: input.propertyId, body, createdBy: input.createdBy, correlationId: input.correlationId, source: mapRunSourceToImportSource(input.source), shadowRunId: input.run.id });
  const sync = result.sync;
  outcome.reservationImportId = result.id;
  // SC-05: el feed automático fuerza `omitirInvalidas: true` para que el lote no se pare, pero una fila que no
  // valida (rate code o tipo sin mapear, fecha ilegible, estado nuevo…) es un ERROR del corte, no una omisión
  // de negocio (waitlist, pseudo room, conflicto local): cuenta en `error`, el run queda `partial` y el mensaje
  // agrega los códigos de fila (sin valores) para que el panel muestre «filas … error» (§5.5, §6.6).
  const invalidRows = result.rows.filter((row) => row.errorCode === "RESERVATION_IMPORT_ROW_INVALID_SKIPPED");
  const invalidCodes = new Map<string, number>();
  for (const row of invalidRows) {
    const code = /\((RESERVATION_IMPORT_ROW_[A-Z_]+):/.exec(row.errorMessage ?? "")?.[1] ?? "RESERVATION_IMPORT_ROW_INVALID_SKIPPED";
    invalidCodes.set(code, (invalidCodes.get(code) ?? 0) + 1);
  }
  const errorCount = result.errorCount + invalidRows.length;
  outcome.counts = {
    created: result.createdCount,
    updated: sync?.counts.updated ?? 0,
    unchanged: sync?.counts.unchanged ?? 0,
    transitioned: sync?.counts.transitioned ?? 0,
    skipped: result.skippedCount - invalidRows.length,
    error: errorCount
  };
  outcome.alerts.push(...buildAlertsFromSyncResult(sync, { id: input.run.id, feed: input.feed, businessDate: input.businessDate }));
  const invalidSummary = [...invalidCodes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([code, count]) => `${code} ×${count}`).join(", ");
  outcome.result = {
    ...outcome.result,
    reservationImportId: result.id,
    importStatus: result.status,
    rowCount: result.rowCount,
    headerOverride: headerOverride !== undefined,
    ...(invalidRows.length > 0 ? { invalidRows: invalidRows.length, invalidRowCodes: Object.fromEntries(invalidCodes) } : {}),
    warnings: result.warnings.slice(0, 20)
  };
  if (result.status === "failed") {
    outcome.status = "failed";
    outcome.errorMessage = `El lote de reservas ${result.id} terminó fallido: ${errorCount} fila(s) con error y ninguna aplicada.`;
  } else {
    outcome.status = errorCount > 0 ? "partial" : "done";
    if (errorCount > 0) {
      outcome.errorMessage = `${errorCount} fila(s) con error en el lote ${result.id}${invalidRows.length > 0 ? ` (${invalidRows.length} inválida(s) omitida(s): ${invalidSummary})` : ""} (ver el detalle del lote).`;
    }
  }
}

async function processRevenueFeed(input: FeedInput, outcome: Outcome): Promise<void> {
  const record = await importPmsShadowRevenue({
    context: input.context,
    propertyId: input.propertyId,
    body: {
      source: "auto",
      ...(input.fileName ? { fileName: input.fileName } : {}),
      contentBase64: input.bytes.toString("base64"),
      businessDate: input.businessDate,
      post: true,
      replace: false,
      force: input.force === true,
      ...(input.reconciliation ? { reconciliation: input.reconciliation } : {})
    },
    createdBy: input.createdBy,
    correlationId: input.correlationId,
    shadowRunId: input.run.id
  });
  outcome.revenueImportId = record.id;
  const posted = record.lines.filter((line) => line.kind && line.kind !== "ignore").length;
  outcome.counts = { ...ZERO_COUNTS, created: posted, skipped: record.lines.length - posted };
  outcome.result = { ...outcome.result, revenueImportId: record.id, revenueStatus: record.status, journalEntryIds: record.journalEntryIds, totals: record.totals, trialBalance: record.reconciliation, warnings: record.warnings.slice(0, 20) };
  outcome.status = "done";
}

function processStatsFeed(input: { bytes: Buffer; declared: Record<string, unknown> | null | undefined }, outcome: Outcome): void {
  const text = decodeXmlBytes(new Uint8Array(input.bytes)).text;
  const parsed = parseDeclaredStats(text);
  const declared = { ...(parsed ?? {}), ...(normalizeDeclaredStats(input.declared) ?? {}) };
  if (Object.keys(declared).length === 0) {
    outcome.status = "failed";
    outcome.errorMessage = "No se reconoce ninguna métrica del Manager Report / Trial Balance en el fichero (JSON con las claves de la reconciliación o XML con Arrival Rooms, Rooms Occupied, Room Revenue, Transaction Total Today…).";
    return;
  }
  outcome.result = { ...outcome.result, declared, metrics: Object.keys(declared).length };
  outcome.status = "done";
}

/**
 * Núcleo del modo sombra: fichero → run cerrado. Ver la cabecera del fichero para
 * las guardas (perfil, tamaño, business date, feed, duplicado) y el despacho por feed.
 */
export async function ingestPmsShadowFile(input: PmsShadowIngestInput): Promise<PmsShadowIngestResult> {
  const { context, propertyId, source, correlationId } = input;
  const organizationId = context.organizationId;
  await assertPropertyInOrg(propertyId, organizationId);
  const profile = await findProfile(organizationId, propertyId);
  if (!profile) throw shadowNotFound("PMS_SHADOW_PROFILE_NOT_FOUND", PROFILE_NOT_FOUND);
  if (profile.status === "paused") throw shadowConflict("PMS_SHADOW_PROFILE_PAUSED", "El modo sombra de esta propiedad está en pausa: reactívalo para recibir cortes.", { propertyId });
  const bytes = input.bytes;
  if (bytes.length > PMS_SHADOW_MAX_FILE_BYTES) throw shadowBadRequest("PMS_SHADOW_FILE_TOO_LARGE", `El fichero supera el tamaño admitido (${PMS_SHADOW_MAX_FILE_BYTES} bytes).`, { bytes: bytes.length, max: PMS_SHADOW_MAX_FILE_BYTES });
  if (bytes.length === 0) throw shadowBadRequest("PMS_SHADOW_FILE_UNREADABLE", "El fichero recibido está vacío.", { reason: "empty" });
  const fileName = input.fileName.trim().slice(0, 200) || null;
  const head = revenueFileHead(new Uint8Array(bytes));
  const classified = input.feed === "auto" ? classifyFeed({ fileName, head }) : input.feed;
  const feed: string = classified ?? PMS_SHADOW_UNRECOGNIZED_FEED;
  requirePermissions(context, requiredKeysFor(feed));
  const contentBase64 = bytes.toString("base64");
  const businessDate = await resolveBusinessDate({ requested: input.businessDate, feed, profile, propertyId, fileName, contentBase64 });
  const contentHash = sha256(bytes);
  const createdBy = input.createdBy === undefined ? context.userId : input.createdBy;
  const force = input.force === true;
  const startedAt = new Date();

  const run = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`pms_shadow_run:${propertyId}`}))`;
    const existing = await tx.pmsShadowRun.findFirst({ where: { organizationId, propertyId, feed, businessDate: dateOnlyUtc(businessDate), contentHash } });
    if (existing) {
      const reusable = existing.status === "failed" || (force && (existing.status === "done" || existing.status === "partial"));
      if (!reusable) {
        throw shadowConflict("PMS_SHADOW_RUN_DUPLICATE", `Este fichero ya se recibió para el corte ${feed} del ${businessDate} (run ${existing.id}, ${existing.status}).`, { runId: existing.id, status: existing.status, createdAt: existing.createdAt.toISOString(), feed, businessDate });
      }
      return tx.pmsShadowRun.update({
        where: { id: existing.id },
        data: {
          status: "processing",
          source,
          fileName,
          createdCount: 0,
          updatedCount: 0,
          unchangedCount: 0,
          transitionedCount: 0,
          skippedCount: 0,
          errorCount: 0,
          resultJson: { reusedFrom: existing.status, force } as Prisma.InputJsonValue,
          alertsJson: [],
          errorMessage: null,
          correlationId,
          createdBy,
          startedAt,
          finishedAt: null
        }
      });
    }
    return tx.pmsShadowRun.create({
      data: { organizationId, propertyId, feed, source, businessDate: dateOnlyUtc(businessDate), fileName, contentHash, status: "processing", correlationId, createdBy, startedAt }
    });
  }, TX_OPTIONS);

  const outcome: Outcome = { status: "done", counts: { ...ZERO_COUNTS }, alerts: [], result: { ...jsonObject(run.resultJson), feed, requestedFeed: input.feed, source, fileName }, errorMessage: null, reservationImportId: null, revenueImportId: null };
  const declared = normalizeDeclaredStats(input.declared);
  if (declared && feed !== "stats") outcome.result.declared = declared;
  inFlightRuns.add(run.id);

  try {
    if (feed === PMS_SHADOW_UNRECOGNIZED_FEED) {
      outcome.status = "failed";
      outcome.errorMessage = "No se reconoce el tipo de corte del fichero (ni por el nombre ni por la cabecera): indícalo con `feed` o revisa el fichero.";
      outcome.alerts.push(runAlert("OPERA_FEED_UNRECOGNIZED", `Fichero sin corte reconocible: ${fileName ?? "(sin nombre)"}.`, { actual: { fileName, bytes: bytes.length, source } }));
    } else if (isReservationFeed(feed)) {
      await processReservationFeed({ ...input, run, feed, businessDate, head, fileName, createdBy }, outcome);
    } else if (feed === "revenue") {
      await processRevenueFeed({ ...input, run, businessDate, fileName, createdBy }, outcome);
    } else if (feed === "stats") {
      processStatsFeed({ bytes, declared: input.declared }, outcome);
    } else {
      outcome.status = "failed";
      outcome.errorMessage = `El feed ${feed} no está implementado en esta tanda (perfiles y delta OHIP son fase 2).`;
    }
  } catch (error) {
    const described = describeError(error);
    outcome.status = "failed";
    outcome.result.errorCode = described.code;
    if (described.statusCode === null || described.statusCode >= 500) {
      outcome.errorMessage = "Error interno al procesar el corte; revisa el registro del API con el identificador de correlación.";
      console.error(`${LOG} run ${run.id} (${feed}, ${businessDate}) failed unexpectedly (correlation ${correlationId}): ${described.message}`);
    } else {
      outcome.errorMessage = described.message;
      if (described.code === "RESERVATION_IMPORT_HEADER_MISMATCH") {
        // SEC-02: nunca las columnas recibidas (con «Delimited Data» sin cabecera serían la primera fila de datos:
        // apellidos, nombre, NAME_ON_CARD…): solo la cabecera esperada, conteos y las columnas del perfil ausentes.
        outcome.alerts.push(runAlert("OPERA_FEED_COLUMNS_CHANGED", `La cabecera del fichero del corte ${feed} no coincide con la del perfil OPERA Cloud.`, { expected: { columns: described.details.expected ?? null }, actual: { receivedCount: described.details.receivedCount ?? null, unknownCount: described.details.unknownCount ?? null, missingProfileColumns: described.details.missingProfileColumns ?? null } }));
      } else if (described.code === "OPERA_TRX_CODE_UNMAPPED") {
        const codes = jsonArray<{ code?: string; description?: string; amount?: string }>(described.details.codes);
        outcome.alerts.push(runAlert("OPERA_TRX_CODE_UNMAPPED", `${codes.length} transaction code(s) sin mapear en el perfil: ${codes.map((entry) => entry.code ?? "?").join(", ")}. El día de ingresos queda bloqueado hasta mapearlos.`, { actual: { codes } }));
      } else if (described.code === "PMS_SHADOW_REVENUE_ALREADY_POSTED") {
        outcome.errorMessage = `Los ingresos del ${businessDate} ya están contabilizados (lote ${String(described.details.importId ?? "?")}): revierte el lote o contabiliza con «sustituir» desde el panel de ingresos.`;
      }
    }
  }

  // Reconciliación al recibir revenue / stats (§6.5), nunca fatal para el run.
  if (outcome.status === "done" && (feed === "revenue" || feed === "stats")) {
    try {
      const reconciliation = await computeReconciliation({ organizationId, propertyId, businessDate, runId: run.id, declared: (outcome.result.declared as Record<string, unknown> | undefined) ?? null });
      outcome.result.reconciliation = { ok: reconciliation.ok, mismatches: reconciliation.mismatches, alerts: reconciliation.alerts.map((alert) => alert.code) };
    } catch (error) {
      const described = describeError(error);
      outcome.result.reconciliation = { ok: null, error: described.message };
      console.warn(`${LOG} reconciliation after run ${run.id} failed (correlation ${correlationId}): ${described.message}`);
    }
  }

  inFlightRuns.delete(run.id);
  const newAlerts = await persistRunAlerts({ organizationId, propertyId, runId: run.id, businessDate, alerts: outcome.alerts });
  const closed = await prisma.pmsShadowRun.update({
    where: { id: run.id },
    data: {
      status: outcome.status,
      createdCount: outcome.counts.created,
      updatedCount: outcome.counts.updated,
      unchangedCount: outcome.counts.unchanged,
      transitionedCount: outcome.counts.transitioned,
      skippedCount: outcome.counts.skipped,
      errorCount: outcome.counts.error,
      resultJson: outcome.result as Prisma.InputJsonValue,
      alertsJson: outcome.alerts as unknown as Prisma.InputJsonValue,
      errorMessage: outcome.errorMessage,
      reservationImportId: outcome.reservationImportId,
      ...(outcome.revenueImportId ? { revenueImportId: outcome.revenueImportId } : {}),
      finishedAt: new Date()
    }
  });

  recordAuditEvent({
    organizationId,
    propertyId,
    actorUserId: context.userId,
    actorType: source === "manual" ? "user" : "system",
    action: outcome.status === "failed" ? "PMS_SHADOW_RUN_FAILED" : "PMS_SHADOW_RUN_COMPLETED",
    entityType: "pms_shadow_run",
    entityId: run.id,
    afterJson: {
      feed,
      source,
      businessDate,
      fileName,
      contentHash,
      bytes: bytes.length,
      status: outcome.status,
      counts: outcome.counts,
      reservationImportId: outcome.reservationImportId,
      revenueImportId: closed.revenueImportId,
      alerts: outcome.alerts.map((alert) => alert.code),
      newAlerts,
      errorMessage: outcome.errorMessage,
      createdBy,
      durationMs: Date.now() - startedAt.getTime()
    },
    deviceId: context.deviceId,
    correlationId
  });

  return { runId: closed.id, status: outcome.status, counts: countsOf(closed), alerts: outcome.alerts, run: toRunRecord(closed) };
}

// ---------------------------------------------------------------------------
// Job del líder: feeds tardíos y runs interrumpidos
// ---------------------------------------------------------------------------

export type PmsShadowLateSweepResult = { profiles: number; late: number; alertsCreated: number; staleRuns: number };

/**
 * Una vuelta del job dentro de la transacción del llamador (`db` = tx bajo el
 * advisory lock): perfiles activos → OPERA_FEED_LATE (una por feed y día) y runs
 * `processing` estancados → `failed`.
 */
export async function sweepLateFeeds(input: { db: Db; now?: Date }): Promise<PmsShadowLateSweepResult> {
  const { db } = input;
  const now = input.now ?? new Date();
  const profiles = await db.pmsShadowProfile.findMany({ where: { status: "active" }, select: { organizationId: true, propertyId: true, scheduleJson: true }, take: 5_000 });
  const result: PmsShadowLateSweepResult = { profiles: profiles.length, late: 0, alertsCreated: 0, staleRuns: 0 };
  if (profiles.length > 0) {
    const properties = await db.property.findMany({ where: { id: { in: profiles.map((profile) => profile.propertyId) } }, select: { id: true, timezone: true }, take: profiles.length });
    const timezoneOf = new Map(properties.map((property) => [property.id, property.timezone]));
    const runs = await db.pmsShadowRun.findMany({
      where: { propertyId: { in: profiles.map((profile) => profile.propertyId) }, createdAt: { gte: new Date(now.getTime() - 3 * 86_400_000) } },
      select: { propertyId: true, feed: true, businessDate: true },
      take: 50_000
    });
    const keys = new Set<string>();
    for (const run of runs) {
      const businessDate = isoDateOf(run.businessDate);
      if (businessDate) keys.add(lateFeedKey(run.propertyId, run.feed, businessDate));
    }
    const late = computeLateFeeds({ profiles: profiles.map((profile) => ({ propertyId: profile.propertyId, timezone: timezoneOf.get(profile.propertyId) ?? "Europe/Madrid", schedule: profile.scheduleJson })), runsByPropertyFeedDate: keys, now });
    result.late = late.length;
    for (const entry of late) {
      const organizationId = profiles.find((profile) => profile.propertyId === entry.propertyId)?.organizationId;
      if (!organizationId) continue;
      const created = await createAlertIfOpen(
        {
          organizationId,
          propertyId: entry.propertyId,
          code: "OPERA_FEED_LATE",
          businessDate: entry.businessDate,
          expected: { feed: entry.feed, expectedTime: entry.expectedTime, deliveryDate: entry.deliveryDate },
          actual: { received: false, minutesLate: entry.minutesLate },
          message: `El corte ${entry.feed} del business date ${entry.businessDate} no ha llegado a la hora prevista (${entry.expectedTime} del ${entry.deliveryDate} + gracia). Comprueba el Report Scheduler / SFTP en OPERA o súbelo a mano.`
        },
        db
      );
      if (created.created) result.alertsCreated += 1;
    }
  }
  result.staleRuns = await failStaleRuns({ now, db });
  return result;
}

/** Perfil OPERA preinstalado (para el CLI y el panel: qué feeds tienen columnas confirmadas). */
export const PMS_SHADOW_PROFILE_FEEDS_WITH_COLUMNS = Object.freeze(Object.entries(OPERA_CLOUD_PROFILE.feeds).filter(([, value]) => value !== undefined).map(([feed]) => feed));
