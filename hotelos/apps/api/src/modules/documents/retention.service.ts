// Documentos · retención → bloqueo → purga, bloqueo/desbloqueo/purga manual y
// gancho GDPR (Tanda T9 · lote T9-13; diseño §3.2, §3.4, §7.5, §9
// block / unblock / purge).
//
// Ciclo (§7.5): `retentionUntil` se fija al archivar (actions.service.ts) →
// al vencer, `blockedAt` (el documento deja de verse salvo documents.admin con
// motivo auditado: archive.service.ts) → 12 meses después, purga real: los
// ficheros salen del almacén (storage.delete por clave), `searchText`,
// `emailMetaJson`, `reviewedFieldsJson` y la propuesta se vacían, el texto de
// las páginas se anula, los campos extraídos se pseudonimizan y la fila queda
// con `deletedAt` (nunca se borra: registro, hash, tamaño y auditoría
// sobreviven). `legalHold` impide bloqueo y purga. Todo auditado
// (DOCUMENT_BLOCKED, DOCUMENT_UNBLOCKED, DOCUMENT_PURGED, actorType system en
// el job y user en las rutas de administración).
//
// `runRetentionSweep({ now })` (job diario, documents-retention.job.ts) barre
// además la extracción atascada (extractionStatus pending desde hace más de 10
// minutos → runDocumentPipeline, T9-06a) y aplica la decisión autónoma de
// T9-08 (applyAutonomousDecision) a los documentos cuya propuesta la lleva.
// Devuelve contadores { blocked, purged, reextracted, autonomous, failed[] }:
// QC-06, cada fallo se registra con el documento y el paso, nunca se traga y
// nunca detiene el resto del barrido.
//
// Gancho GDPR (§3.4, §7.5): `eraseGuestDocuments` — documentos con `guestId`
// del sujeto → searchText / título / campos extraídos / texto de páginas
// pseudonimizados (nombre, DNI, e-mail: valores del sujeto y claves
// personales) y, si el tipo no tiene efecto fiscal (kind ∉ invoice |
// delivery_note | receipt), purga del fichero. Lo llama executeErasure
// (modules/gdpr/gdpr.service.ts) ANTES de pseudonimizar la fila Guest, para
// conocer los valores a suprimir.
//
// Sin lecturas de entorno; `db`, `storage`, `now`, `runPipeline` y
// `applyAutonomous` inyectables (retention.test.mts corre sin Postgres).

import { prisma } from "@hotelos/database";
import { Prisma, type DocumentExtraction, type IncomingDocument } from "@prisma/client";
import type { ActorType, IncomingDocumentRecord, PermissionKey } from "@hotelos/shared";
import { z } from "zod";
import type { UserContext } from "../../lib/demo-store.js";
import { HttpError } from "../../lib/http-error.js";
import { createId } from "../../lib/ids.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import { applyAutonomousDecision as applyAutonomousDecisionDefault } from "./actions.service.js";
import { DOCUMENT_AUDIT_ENTITY, documentAuditSummary } from "./documents-audit.js";
import { toIncomingDocumentRecord, type RecordExtras } from "./documents-dto.js";
import { getDocumentStorage } from "./documents.config.js";
import { DEFAULT_OFFICE_SLA_BUSINESS_DAYS, dueAtOf, isSlaBreached } from "./documents.service.js";
import { notifySlaBreaches } from "./office-notifications.js";
import { runDocumentPipeline as runDocumentPipelineDefault } from "./pipeline.service.js";
import { retentionKindOf, retentionUntilFor, type RetentionSettings } from "./retention-rules.js";
import type { DocumentStorage } from "./storage/storage.js";

type Db = typeof prisma;
type Tx = Prisma.TransactionClient;

export const DOCUMENT_RETENTION_AUDIT_ACTIONS = Object.freeze({
  blocked: "DOCUMENT_BLOCKED",
  unblocked: "DOCUMENT_UNBLOCKED",
  purged: "DOCUMENT_PURGED",
  gdprErased: "DOCUMENT_GDPR_ERASED"
} as const);

/** Meses entre el bloqueo y la purga real (§3.2 / §7.5). */
export const RETENTION_BLOCK_TO_PURGE_MONTHS = 12;
/** Minutos que una extracción puede seguir `pending` antes de relanzarse. */
export const RETENTION_PENDING_REEXTRACT_MINUTES = 10;
/** Documentos por paso y vuelta (un barrido nunca carga toda la tabla). */
export const RETENTION_SWEEP_BATCH = 500;
export const RETENTION_REEXTRACT_BATCH = 50;
export const RETENTION_AUTONOMOUS_BATCH = 100;
/** Tipos con efecto fiscal: nunca se purgan por GDPR (RD 1619/2012 art. 19, CCom art. 30). */
export const FISCAL_DOCUMENT_KINDS: ReadonlySet<string> = new Set(["invoice", "delivery_note", "receipt"]);
export const PURGED_PLACEHOLDER = "[purgado]";
export const ERASED_PLACEHOLDER = "[suprimido]";
const ADMIN_PERMISSION: PermissionKey = "documents.admin";
const LOG = "[documents.retention]";

export type RetentionSweepStep = "retention" | "block" | "purge" | "reextract" | "autonomous" | "sla";
export type RetentionSweepFailure = { documentId: string; step: RetentionSweepStep; error: string };
export type RetentionSweepResult = {
  /** Documentos `posted` sin retentionUntil que reciben su fecha (RV-04: contabilizados antes del gancho). */
  retentionAssigned: number;
  blocked: number;
  purged: number;
  reextracted: number;
  autonomous: number;
  /** Avisos diarios a documents.admin por documentos con el SLA de la oficina vencido (§6.3, RV-10). */
  slaNotified: number;
  failed: RetentionSweepFailure[];
  startedAt: string;
  finishedAt: string;
};

export type RetentionLogger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

export const silentRetentionLog: RetentionLogger = { info: () => {}, warn: () => {}, error: () => {} };

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

function typed(statusCode: number, code: string, message: string, extra: Record<string, unknown> = {}): HttpError {
  return new HttpError(statusCode, message, true, { code, ...extra });
}

function notFoundDocument(): HttpError {
  return typed(404, "DOCUMENT_NOT_FOUND", "Documento no encontrado.");
}

// ---------------------------------------------------------------------------
// Funciones puras (exportadas para los unit tests)
// ---------------------------------------------------------------------------

/** `date` + `months` meses en calendario UTC (el día se conserva; 31/01 + 1 → 03/03 como Date nativo). */
export function addMonthsUtc(date: Date, months: number): Date {
  const out = new Date(date.getTime());
  out.setUTCMonth(out.getUTCMonth() + months);
  return out;
}

/** Instante a partir del cual un `blockedAt` cumple los 12 meses (blockedAt ≤ cota). */
export function purgeCutoff(now: Date): Date {
  return addMonthsUtc(now, -RETENTION_BLOCK_TO_PURGE_MONTHS);
}

/** `capturedAt` ≤ cota ⇔ la extracción lleva más de 10 minutos pendiente. */
export function pendingReextractCutoff(now: Date): Date {
  return new Date(now.getTime() - RETENTION_PENDING_REEXTRACT_MINUTES * 60_000);
}

export function isFiscalKind(kind: string): boolean {
  return FISCAL_DOCUMENT_KINDS.has(kind);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Valores del sujeto útiles para buscar (≥ 3 caracteres, sin repetidos, los más largos primero). */
export function subjectValuesOf(values: ReadonlyArray<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const value of values) {
    const trimmed = (value ?? "").trim();
    if (trimmed.length >= 3) out.add(trimmed);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** Sustituye cada valor del sujeto (sin distinguir mayúsculas) por «[suprimido]». */
export function scrubText(text: string | null | undefined, values: readonly string[]): string | null {
  if (text == null) return null;
  let out = text;
  for (const value of values) {
    if (value.length < 3) continue;
    out = out.replace(new RegExp(escapeRegExp(value), "gi"), ERASED_PLACEHOLDER);
  }
  return out;
}

/** Claves que llevan datos de una persona (huésped / empleado); las de proveedor, emisor o comercio no se tocan. */
const PERSONAL_KEY_RE = /(name|nombre|apellido|surname|holder|guest|huesped|customer|cliente|titular|dni|nie|nif|passport|pasaporte|document(number|id)|idnumber|email|correo|phone|telefono|mobile|movil|address|direccion|domicilio|iban|birth|nacimiento)/i;
const BUSINESS_KEY_RE = /^(supplier|issuer|merchant|vendor|proveedor|emisor|sender|remitente)/i;

export function isPersonalKey(key: string): boolean {
  return PERSONAL_KEY_RE.test(key) && !BUSINESS_KEY_RE.test(key);
}

export type ScrubOptions = { mode: "purge" } | { mode: "erasure"; values: readonly string[] };

/**
 * Pseudonimiza un JSON (campos extraídos, propuesta, campos revisados, meta del
 * correo): `purge` sustituye TODA cadena por «[purgado]» (los números, fechas y
 * booleanos se conservan: importes y fechas no identifican a nadie y siguen
 * siendo útiles como huella del documento); `erasure` sustituye las hojas bajo
 * una clave personal por «[suprimido]» y, en el resto de cadenas, solo los
 * valores del sujeto. La estructura (claves, arrays) se conserva.
 */
export function scrubPersonalFields(value: unknown, options: ScrubOptions): unknown {
  const walk = (node: unknown, underPersonalKey: boolean): unknown => {
    if (node === null || node === undefined) return node;
    if (typeof node === "string") {
      if (options.mode === "purge") return node.length === 0 ? node : PURGED_PLACEHOLDER;
      if (underPersonalKey) return node.length === 0 ? node : ERASED_PLACEHOLDER;
      return scrubText(node, options.values);
    }
    if (typeof node === "number" || typeof node === "boolean") {
      return options.mode === "erasure" && underPersonalKey ? ERASED_PLACEHOLDER : node;
    }
    if (Array.isArray(node)) return node.map((item) => walk(item, underPersonalKey));
    if (typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        out[key] = walk(child, underPersonalKey || (options.mode === "erasure" && isPersonalKey(key)));
      }
      return out;
    }
    return node;
  };
  return walk(value, false);
}

function jsonInput(value: unknown): Prisma.InputJsonValue {
  return (value ?? {}) as Prisma.InputJsonValue;
}

function nullableJsonInput(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null || value === undefined ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Cuerpos (§9: block / unblock / purge)
// ---------------------------------------------------------------------------

export const DocumentAdminActionSchema = z
  .object({
    reason: z
      .string({ invalid_type_error: "reason debe ser un texto." })
      .trim()
      .min(3, { message: "reason debe tener al menos 3 caracteres." })
      .max(2000, { message: "reason no puede superar 2000 caracteres." }),
    /** Al bloquear o desbloquear: fija o retira la retención legal (legalHold) en la misma petición. */
    legalHold: z.boolean({ invalid_type_error: "legalHold debe ser booleano." }).optional()
  })
  .strict();
export type DocumentAdminActionInput = z.output<typeof DocumentAdminActionSchema>;

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

export type DocumentRetentionServiceDeps = {
  db?: Db;
  storage?: () => DocumentStorage;
  now?: () => Date;
  runPipeline?: typeof runDocumentPipelineDefault;
  applyAutonomous?: typeof applyAutonomousDecisionDefault;
  /** Auditoría (recordAuditEvent por defecto; espía en los unit tests). */
  audit?: typeof recordAuditEvent;
  log?: RetentionLogger;
};

export type RetentionSweepInput = { now?: Date; correlationId?: string };
export type AdminActionInput = { context: UserContext; organizationId: string; id: string; body: unknown; correlationId?: string; ipAddress?: string };
export type EraseGuestDocumentsInput = {
  organizationId: string;
  guestIds: readonly string[];
  /** Nombre, apellidos, DNI, e-mail, teléfono… del sujeto (tal como están en Guest antes de pseudonimizar; nulos se ignoran). */
  subjectValues: ReadonlyArray<string | null | undefined>;
  actorUserId?: string;
  correlationId?: string;
};
export type EraseGuestDocumentsResult = { pseudonymized: number; purged: number; documentIds: string[] };

type PurgeMeta = { reason: string; actorType: ActorType; actorUserId?: string; deviceId?: string; ipAddress?: string; correlationId: string };

export function createDocumentRetentionService(deps: DocumentRetentionServiceDeps = {}) {
  const db: Db = deps.db ?? prisma;
  const storage = deps.storage ?? getDocumentStorage;
  const now = deps.now ?? (() => new Date());
  const runPipeline = deps.runPipeline ?? runDocumentPipelineDefault;
  const applyAutonomous = deps.applyAutonomous ?? applyAutonomousDecisionDefault;
  const recordAudit = deps.audit ?? recordAuditEvent;
  const log = deps.log ?? silentRetentionLog;

  // ── helpers ─────────────────────────────────────────────────────────────

  function audit(input: { action: string; row: IncomingDocument; actorType: ActorType; actorUserId?: string; deviceId?: string; ipAddress?: string; correlationId: string; beforeJson?: Record<string, unknown>; afterJson?: Record<string, unknown> }): void {
    recordAudit({
      organizationId: input.row.organizationId,
      propertyId: input.row.propertyId,
      ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
      actorType: input.actorType,
      action: input.action,
      entityType: DOCUMENT_AUDIT_ENTITY,
      entityId: input.row.id,
      ...(input.beforeJson ? { beforeJson: input.beforeJson } : {}),
      ...(input.afterJson ? { afterJson: input.afterJson } : {}),
      ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}),
      ...(input.deviceId ? { deviceId: input.deviceId } : {}),
      correlationId: input.correlationId
    });
  }

  async function officeSla(organizationId: string): Promise<number> {
    const settings = await db.documentSettings.findUnique({ where: { organizationId }, select: { officeSlaBusinessDays: true } });
    return settings?.officeSlaBusinessDays ?? DEFAULT_OFFICE_SLA_BUSINESS_DAYS;
  }

  async function recordOf(row: IncomingDocument): Promise<IncomingDocumentRecord> {
    const [sla, actions, supplier] = await Promise.all([
      officeSla(row.organizationId),
      db.documentAction.findMany({ where: { documentId: row.id, status: "open" }, select: { dueAt: true } }),
      row.supplierId ? db.supplier.findUnique({ where: { id: row.supplierId }, select: { name: true } }) : Promise.resolve(null)
    ]);
    const extras: RecordExtras = { supplierName: supplier?.name ?? null, dueAt: dueAtOf(row, actions.map((action) => action.dueAt)), slaBreached: isSlaBreached(row, sla, now()) };
    return toIncomingDocumentRecord(row, extras);
  }

  async function requireOrganizationDocument(organizationId: string, id: string): Promise<IncomingDocument> {
    const row = await db.incomingDocument.findFirst({ where: { id, organizationId, deletedAt: null } });
    if (!row) throw notFoundDocument();
    return row;
  }

  /**
   * Purga real de un documento: primero el almacén (idempotente; si falla, la
   * BD no se toca y el barrido lo reintenta), después una transacción que vacía
   * inline / texto de páginas / campos extraídos / searchText / propuesta y fija
   * deletedAt. Devuelve la fila purgada.
   */
  async function purgeRow(row: IncomingDocument, meta: PurgeMeta): Promise<IncomingDocument> {
    const at = now();
    const files = await db.documentFile.findMany({ where: { documentId: row.id }, select: { id: true, storageKind: true, storageKey: true } });
    let filesDeleted = 0;
    const store = storage();
    for (const file of files) {
      if (file.storageKind === "inline" || !file.storageKey) continue;
      await store.delete(file.storageKey);
      filesDeleted += 1;
    }
    const extractions = await db.documentExtraction.findMany({ where: { documentId: row.id }, select: { id: true, fieldsJson: true } });
    const purged = await db.$transaction(async (tx: Tx) => {
      await tx.documentFile.updateMany({ where: { documentId: row.id }, data: { inline: null } });
      await tx.documentPage.updateMany({ where: { documentId: row.id }, data: { textExtracted: null } });
      for (const extraction of extractions) {
        await tx.documentExtraction.update({ where: { id: extraction.id }, data: { fieldsJson: jsonInput(scrubPersonalFields(extraction.fieldsJson, { mode: "purge" })), confidenceJson: {} } });
      }
      return tx.incomingDocument.update({
        where: { id: row.id },
        data: { searchText: null, emailMetaJson: Prisma.DbNull, reviewedFieldsJson: Prisma.DbNull, proposedActionJson: {}, deletedAt: at }
      });
    });
    audit({
      action: DOCUMENT_RETENTION_AUDIT_ACTIONS.purged,
      row: purged,
      actorType: meta.actorType,
      ...(meta.actorUserId ? { actorUserId: meta.actorUserId } : {}),
      ...(meta.deviceId ? { deviceId: meta.deviceId } : {}),
      ...(meta.ipAddress ? { ipAddress: meta.ipAddress } : {}),
      correlationId: meta.correlationId,
      beforeJson: { blockedAt: row.blockedAt?.toISOString() ?? null, retentionUntil: row.retentionUntil?.toISOString() ?? null },
      afterJson: { ...documentAuditSummary(purged), filesDeleted, deletedAt: at.toISOString(), reason: meta.reason }
    });
    return purged;
  }

  /** Pseudonimización sin purga (documentos con efecto fiscal del sujeto GDPR). */
  async function pseudonymizeRow(row: IncomingDocument, values: readonly string[], meta: PurgeMeta): Promise<IncomingDocument> {
    const scrub: ScrubOptions = { mode: "erasure", values };
    const [extractions, pages] = await Promise.all([
      db.documentExtraction.findMany({ where: { documentId: row.id }, select: { id: true, fieldsJson: true } }),
      db.documentPage.findMany({ where: { documentId: row.id }, select: { id: true, textExtracted: true } })
    ]);
    const updated = await db.$transaction(async (tx: Tx) => {
      for (const extraction of extractions) {
        await tx.documentExtraction.update({ where: { id: extraction.id }, data: { fieldsJson: jsonInput(scrubPersonalFields(extraction.fieldsJson, scrub)) } });
      }
      for (const page of pages) {
        if (page.textExtracted == null) continue;
        await tx.documentPage.update({ where: { id: page.id }, data: { textExtracted: scrubText(page.textExtracted, values) } });
      }
      return tx.incomingDocument.update({
        where: { id: row.id },
        data: {
          searchText: scrubText(row.searchText, values),
          title: scrubText(row.title, values),
          reviewedFieldsJson: nullableJsonInput(row.reviewedFieldsJson === null ? null : scrubPersonalFields(row.reviewedFieldsJson, scrub)),
          emailMetaJson: nullableJsonInput(row.emailMetaJson === null ? null : scrubPersonalFields(row.emailMetaJson, scrub)),
          proposedActionJson: jsonInput(scrubPersonalFields(row.proposedActionJson, scrub))
        }
      });
    });
    audit({
      action: DOCUMENT_RETENTION_AUDIT_ACTIONS.gdprErased,
      row: updated,
      actorType: meta.actorType,
      ...(meta.actorUserId ? { actorUserId: meta.actorUserId } : {}),
      correlationId: meta.correlationId,
      afterJson: { ...documentAuditSummary(updated), extractions: extractions.length, pages: pages.length, reason: meta.reason }
    });
    return updated;
  }

  // ── barrido diario ──────────────────────────────────────────────────────

  async function runRetentionSweep(input: RetentionSweepInput = {}): Promise<RetentionSweepResult> {
    const at = input.now ?? now();
    const correlationId = input.correlationId ?? createId("corr");
    const result: RetentionSweepResult = { retentionAssigned: 0, blocked: 0, purged: 0, reextracted: 0, autonomous: 0, slaNotified: 0, failed: [], startedAt: at.toISOString(), finishedAt: at.toISOString() };
    const fail = (step: RetentionSweepStep, documentId: string, error: unknown): void => {
      const message = errorMessage(error);
      result.failed.push({ documentId, step, error: message });
      log.warn({ step, documentId, correlationId, err: message }, `${LOG} paso fallido`);
    };

    // 0. Contabilizados sin retención (RV-04): 31/12 del ejercicio + años del tipo, como el gancho posted.
    try {
      const missing = await db.incomingDocument.findMany({
        where: { deletedAt: null, status: "posted", retentionUntil: null },
        select: { id: true, organizationId: true, kind: true, documentDate: true, capturedAt: true, extendedRetention: true, guestId: true },
        orderBy: [{ postedAt: "asc" }, { id: "asc" }],
        take: RETENTION_SWEEP_BATCH
      });
      const settingsByOrganization = new Map<string, RetentionSettings | null>();
      for (const row of missing) {
        try {
          if (!settingsByOrganization.has(row.organizationId)) {
            const settings = await db.documentSettings.findUnique({ where: { organizationId: row.organizationId }, select: { retentionYearsDefault: true, letterRetentionYears: true, extendedRetentionYears: true } });
            settingsByOrganization.set(row.organizationId, settings ? { retentionYears: settings.retentionYearsDefault, letterRetentionYears: settings.letterRetentionYears, extendedRetentionYears: settings.extendedRetentionYears } : null);
          }
          const retentionUntil = retentionUntilFor({ kind: retentionKindOf(row.kind), documentDate: row.documentDate ?? row.capturedAt, extendedRetention: row.extendedRetention, personalData: row.guestId !== null, settings: settingsByOrganization.get(row.organizationId) ?? null });
          const updated = await db.incomingDocument.updateMany({ where: { id: row.id, status: "posted", retentionUntil: null }, data: { retentionUntil } });
          if (updated.count === 1) result.retentionAssigned += 1;
        } catch (error) {
          fail("retention", row.id, error);
        }
      }
    } catch (error) {
      fail("retention", "*", error);
    }

    // 1. Bloqueo al vencer la retención (sin legalHold).
    try {
      const due = await db.incomingDocument.findMany({
        where: { deletedAt: null, blockedAt: null, legalHold: false, retentionUntil: { lte: at } },
        orderBy: [{ retentionUntil: "asc" }, { id: "asc" }],
        take: RETENTION_SWEEP_BATCH
      });
      for (const row of due) {
        try {
          const updated = await db.incomingDocument.updateMany({ where: { id: row.id, blockedAt: null, deletedAt: null, legalHold: false }, data: { blockedAt: at } });
          if (updated.count !== 1) continue;
          audit({
            action: DOCUMENT_RETENTION_AUDIT_ACTIONS.blocked,
            row,
            actorType: "system",
            correlationId,
            beforeJson: { blockedAt: null, retentionUntil: row.retentionUntil?.toISOString() ?? null },
            afterJson: { ...documentAuditSummary(row), blockedAt: at.toISOString(), reason: "retention_expired" }
          });
          result.blocked += 1;
        } catch (error) {
          fail("block", row.id, error);
        }
      }
    } catch (error) {
      fail("block", "*", error);
    }

    // 2. Purga a los 12 meses de bloqueo (sin legalHold).
    try {
      const cutoff = purgeCutoff(at);
      const expired = await db.incomingDocument.findMany({
        where: { deletedAt: null, legalHold: false, blockedAt: { lte: cutoff } },
        orderBy: [{ blockedAt: "asc" }, { id: "asc" }],
        take: RETENTION_SWEEP_BATCH
      });
      for (const row of expired) {
        try {
          await purgeRow(row, { reason: "retention_purge", actorType: "system", correlationId });
          result.purged += 1;
        } catch (error) {
          fail("purge", row.id, error);
        }
      }
    } catch (error) {
      fail("purge", "*", error);
    }

    // 3. Extracción atascada (> 10 min pending) → volver a lanzar el pipeline.
    try {
      const stuck = await db.incomingDocument.findMany({
        where: { deletedAt: null, blockedAt: null, extractionStatus: "pending", capturedAt: { lte: pendingReextractCutoff(at) } },
        orderBy: [{ capturedAt: "asc" }, { id: "asc" }],
        select: { id: true },
        take: RETENTION_REEXTRACT_BATCH
      });
      for (const row of stuck) {
        try {
          await runPipeline(row.id, { trigger: "manual", correlationId });
          result.reextracted += 1;
        } catch (error) {
          // El pipeline ya deja extractionStatus = failed; aquí solo se cuenta.
          fail("reextract", row.id, error);
        }
      }
    } catch (error) {
      fail("reextract", "*", error);
    }

    // 4. Decisión autónoma (§5.1) sobre los documentos cuya propuesta la lleva.
    try {
      const candidates = await db.incomingDocument.findMany({
        where: {
          deletedAt: null,
          blockedAt: null,
          status: { in: ["sent_to_office", "in_review"] },
          proposedActionJson: { path: ["autonomy", "level"], equals: "autonomous" }
        },
        orderBy: [{ sentAt: "asc" }, { id: "asc" }],
        select: { id: true },
        take: RETENTION_AUTONOMOUS_BATCH
      });
      for (const row of candidates) {
        try {
          const outcome = await applyAutonomous(row.id, { correlationId });
          if (outcome.applied) result.autonomous += 1;
        } catch (error) {
          fail("autonomous", row.id, error);
        }
      }
    } catch (error) {
      fail("autonomous", "*", error);
    }

    // 5. SLA de la oficina vencido (§6.3, RV-10): aviso diario a documents.admin de cada organización (enlace, nunca adjunto).
    try {
      const pending = await db.incomingDocument.findMany({
        where: { deletedAt: null, blockedAt: null, status: { in: ["sent_to_office", "in_review"] }, sentAt: { not: null } },
        select: { id: true, organizationId: true, propertyId: true, registryNumber: true, sentAt: true, status: true },
        orderBy: [{ sentAt: "asc" }, { id: "asc" }],
        take: RETENTION_SWEEP_BATCH
      });
      const byOrganization = new Map<string, typeof pending>();
      for (const row of pending) byOrganization.set(row.organizationId, [...(byOrganization.get(row.organizationId) ?? []), row]);
      for (const [organizationId, rows] of byOrganization) {
        try {
          const slaBusinessDays = await officeSla(organizationId);
          const breached = rows.filter((row) => isSlaBreached(row, slaBusinessDays, at));
          if (breached.length === 0) continue;
          const outcome = await notifySlaBreaches(db, { organizationId, breached, slaBusinessDays, at });
          result.slaNotified += outcome.notified.length;
        } catch (error) {
          fail("sla", organizationId, error);
        }
      }
    } catch (error) {
      fail("sla", "*", error);
    }

    result.finishedAt = now().toISOString();
    return result;
  }

  // ── administración (§9: block / unblock / purge, documents.admin, critical) ──

  async function blockDocument(input: AdminActionInput): Promise<IncomingDocumentRecord> {
    requirePermissions(input.context, [ADMIN_PERMISSION]);
    const body = parseOr400(DocumentAdminActionSchema, input.body ?? {}, "Bloqueo");
    const row = await requireOrganizationDocument(input.organizationId, input.id);
    if (row.blockedAt) throw typed(409, "DOCUMENT_BLOCKED", "El documento ya está bloqueado.", { blockedAt: row.blockedAt.toISOString() });
    const at = now();
    const previousLegalHold = row.legalHold;
    const updated = await db.incomingDocument.update({ where: { id: row.id }, data: { blockedAt: at, ...(body.legalHold !== undefined ? { legalHold: body.legalHold } : {}) } });
    audit({
      action: DOCUMENT_RETENTION_AUDIT_ACTIONS.blocked,
      row: updated,
      actorType: "user",
      actorUserId: input.context.userId,
      ...(input.context.deviceId ? { deviceId: input.context.deviceId } : {}),
      ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}),
      correlationId: input.correlationId ?? createId("corr"),
      beforeJson: { blockedAt: null, legalHold: previousLegalHold },
      afterJson: { ...documentAuditSummary(updated), blockedAt: at.toISOString(), legalHold: updated.legalHold, reason: body.reason }
    });
    return recordOf(updated);
  }

  async function unblockDocument(input: AdminActionInput): Promise<IncomingDocumentRecord> {
    requirePermissions(input.context, [ADMIN_PERMISSION]);
    const body = parseOr400(DocumentAdminActionSchema, input.body ?? {}, "Desbloqueo");
    const row = await requireOrganizationDocument(input.organizationId, input.id);
    if (!row.blockedAt) throw typed(409, "DOCUMENT_STATUS_TRANSITION", "El documento no está bloqueado.", { from: "not_blocked", action: "unblock" });
    const previous = { blockedAt: row.blockedAt.toISOString(), legalHold: row.legalHold };
    const updated = await db.incomingDocument.update({ where: { id: row.id }, data: { blockedAt: null, ...(body.legalHold !== undefined ? { legalHold: body.legalHold } : {}) } });
    audit({
      action: DOCUMENT_RETENTION_AUDIT_ACTIONS.unblocked,
      row: updated,
      actorType: "user",
      actorUserId: input.context.userId,
      ...(input.context.deviceId ? { deviceId: input.context.deviceId } : {}),
      ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}),
      correlationId: input.correlationId ?? createId("corr"),
      beforeJson: previous,
      afterJson: { ...documentAuditSummary(updated), blockedAt: null, legalHold: updated.legalHold, reason: body.reason }
    });
    return recordOf(updated);
  }

  async function purgeDocument(input: AdminActionInput): Promise<IncomingDocumentRecord> {
    requirePermissions(input.context, [ADMIN_PERMISSION]);
    const body = parseOr400(DocumentAdminActionSchema, input.body ?? {}, "Purga");
    const row = await requireOrganizationDocument(input.organizationId, input.id);
    if (!row.blockedAt) throw typed(409, "DOCUMENT_STATUS_TRANSITION", "Solo se purga un documento bloqueado.", { from: "not_blocked", action: "purge" });
    if (row.legalHold) throw typed(409, "DOCUMENT_LEGAL_HOLD", "El documento está bajo retención legal (legalHold): no se puede purgar.", { registryNumber: row.registryNumber });
    const purged = await purgeRow(row, {
      reason: body.reason,
      actorType: "user",
      actorUserId: input.context.userId,
      ...(input.context.deviceId ? { deviceId: input.context.deviceId } : {}),
      ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}),
      correlationId: input.correlationId ?? createId("corr")
    });
    return recordOf(purged);
  }

  // ── gancho GDPR (executeErasure) ────────────────────────────────────────

  async function eraseGuestDocuments(input: EraseGuestDocumentsInput): Promise<EraseGuestDocumentsResult> {
    const result: EraseGuestDocumentsResult = { pseudonymized: 0, purged: 0, documentIds: [] };
    if (input.guestIds.length === 0) return result;
    const values = subjectValuesOf(input.subjectValues);
    const correlationId = input.correlationId ?? createId("corr");
    const rows = await db.incomingDocument.findMany({ where: { organizationId: input.organizationId, guestId: { in: [...input.guestIds] }, deletedAt: null }, orderBy: { capturedAt: "asc" } });
    for (const row of rows) {
      const meta: PurgeMeta = { reason: "gdpr_erasure", actorType: "user", ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}), correlationId };
      if (isFiscalKind(row.kind)) {
        await pseudonymizeRow(row, values, meta);
        result.pseudonymized += 1;
      } else {
        // Sin efecto fiscal: se pseudonimiza lo que sobrevive a la purga (campos extraídos) y el fichero desaparece.
        await purgeRow(row, meta);
        result.purged += 1;
      }
      result.documentIds.push(row.id);
    }
    return result;
  }

  return { runRetentionSweep, blockDocument, unblockDocument, purgeDocument, eraseGuestDocuments, purgeRow };
}

export type DocumentRetentionService = ReturnType<typeof createDocumentRetentionService>;

let defaultService: DocumentRetentionService | null = null;
export function getDocumentRetentionService(): DocumentRetentionService {
  if (!defaultService) defaultService = createDocumentRetentionService();
  return defaultService;
}

export const runRetentionSweep = (input?: RetentionSweepInput): Promise<RetentionSweepResult> => getDocumentRetentionService().runRetentionSweep(input);
export const blockDocument = (input: AdminActionInput): Promise<IncomingDocumentRecord> => getDocumentRetentionService().blockDocument(input);
export const unblockDocument = (input: AdminActionInput): Promise<IncomingDocumentRecord> => getDocumentRetentionService().unblockDocument(input);
export const purgeDocument = (input: AdminActionInput): Promise<IncomingDocumentRecord> => getDocumentRetentionService().purgeDocument(input);
export const eraseGuestDocuments = (input: EraseGuestDocumentsInput): Promise<EraseGuestDocumentsResult> => getDocumentRetentionService().eraseGuestDocuments(input);
