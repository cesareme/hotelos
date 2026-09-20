// Documentos · ajustes por organización (Tanda T9 · lote T9-13; diseño §9
// `GET/PATCH /organizations/:organizationId/documents/settings`, §6.3 SLA,
// §7.2 tolerancias del cotejo, §3.2 retención, §3.4 aiAllowedKinds).
//
//   · una fila `DocumentSettings` por organización (upsert en el PATCH; el GET
//     sin fila devuelve los valores por defecto de la tanda con updatedAt null);
//   · cuerpo del PATCH validado con zod `.strict()` (al menos un campo);
//     decimales como cadena («2.00», «0.000») o número, normalizados a la
//     escala de la columna;
//   · `aiAllowedKinds` por defecto [invoice, delivery_note, receipt] (§3.4: las
//     cartas y notificaciones solo van al proveedor de IA cuando la
//     organización las incluye); `[]` se guarda tal cual (documents-ai.port.ts
//     lo lee como «todos los que permita ai-core»);
//   · permisos: el manifiesto exige documents.admin (high); el servicio lo
//     recomprueba (mismo 403 del gate) para las llamadas directas;
//   · auditoría DOCUMENT_SETTINGS_UPDATED (entityType document_settings) con
//     los campos cambiados (antes / después), nunca más.
//
// `db` y `now` inyectables (settings.test.mts corre sin Postgres).

import { prisma } from "@hotelos/database";
import type { DocumentSettings, Prisma } from "@prisma/client";
import { INCOMING_DOCUMENT_KINDS, type DocumentSettingsDto, type IncomingDocumentKind, type PermissionKey } from "@hotelos/shared";
import { z } from "zod";
import type { UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";

type Db = typeof prisma;

export const DOCUMENT_SETTINGS_AUDIT_ENTITY = "document_settings";
export const DOCUMENT_SETTINGS_AUDIT_ACTIONS = Object.freeze({ updated: "DOCUMENT_SETTINGS_UPDATED" } as const);
const ADMIN_PERMISSION: PermissionKey = "documents.admin";

/** §3.4: tipos que van a la IA por defecto (cartas y notificaciones solo si la organización las incluye). */
export const DEFAULT_AI_ALLOWED_KINDS: readonly IncomingDocumentKind[] = Object.freeze(["invoice", "delivery_note", "receipt"]);

/** Valores por defecto de la tanda (mismos que los `@default` del modelo DocumentSettings). */
export const DEFAULT_DOCUMENT_SETTINGS = Object.freeze({
  officeSlaBusinessDays: 2,
  autoSendToOffice: false,
  aiAllowedKinds: DEFAULT_AI_ALLOWED_KINDS,
  priceTolerancePct: "2.00",
  quantityTolerance: "0.000",
  amountToleranceAbs: "1.00",
  requireMatchForApproval: false,
  retentionYearsDefault: 6,
  // Correspondencia de proveedores: 6 años (art. 30 CCom; diseño §3.2 / §8). Los 4 años de la
  // AEPD 148/2019 solo se aplican a cartas / «otro» con datos personales sin efecto fiscal
  // (guestId informado), regla fija de retention-rules.ts.
  letterRetentionYears: 6,
  extendedRetentionYears: 10
});

// ---------------------------------------------------------------------------
// Esquema del PATCH
// ---------------------------------------------------------------------------

const kindSchema = z.enum(INCOMING_DOCUMENT_KINDS, { errorMap: () => ({ message: `aiAllowedKinds debe contener valores de: ${INCOMING_DOCUMENT_KINDS.join(", ")}.` }) });

/** Decimal no negativo como cadena («2.5») o número, normalizado a `scale` decimales; `max` inclusive. */
function decimalInput(name: string, scale: number, max: number): z.ZodType<string, z.ZodTypeDef, string | number> {
  return z
    .union([z.string().trim(), z.number()], { errorMap: () => ({ message: `${name} debe ser un decimal no negativo.` }) })
    .transform((value, ctx) => {
      const raw = typeof value === "number" ? String(value) : value.replace(",", ".");
      if (!/^\d{1,9}(\.\d{1,6})?$/.test(raw)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${name} debe ser un decimal no negativo con como máximo ${scale} decimales.` });
        return z.NEVER;
      }
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed > max) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${name} no puede superar ${max}.` });
        return z.NEVER;
      }
      const normalized = parsed.toFixed(scale);
      if (Number(normalized) !== parsed) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${name} admite como máximo ${scale} decimales.` });
        return z.NEVER;
      }
      return normalized;
    });
}

const yearsSchema = (name: string) =>
  z
    .number({ invalid_type_error: `${name} debe ser un entero de años.` })
    .int({ message: `${name} debe ser un entero de años.` })
    .min(1, { message: `${name} debe estar entre 1 y 30.` })
    .max(30, { message: `${name} debe estar entre 1 y 30.` });

export const DocumentSettingsPatchSchema = z
  .object({
    officeSlaBusinessDays: z
      .number({ invalid_type_error: "officeSlaBusinessDays debe ser un entero de días laborables." })
      .int({ message: "officeSlaBusinessDays debe ser un entero de días laborables." })
      .min(0, { message: "officeSlaBusinessDays debe estar entre 0 y 30." })
      .max(30, { message: "officeSlaBusinessDays debe estar entre 0 y 30." })
      .optional(),
    autoSendToOffice: z.boolean({ invalid_type_error: "autoSendToOffice debe ser booleano." }).optional(),
    aiAllowedKinds: z
      .array(kindSchema, { invalid_type_error: "aiAllowedKinds debe ser una lista de tipos." })
      .max(INCOMING_DOCUMENT_KINDS.length)
      .transform((kinds) => [...new Set(kinds)])
      .optional(),
    priceTolerancePct: decimalInput("priceTolerancePct", 2, 100).optional(),
    quantityTolerance: decimalInput("quantityTolerance", 3, 1_000_000).optional(),
    amountToleranceAbs: decimalInput("amountToleranceAbs", 2, 1_000_000).optional(),
    requireMatchForApproval: z.boolean({ invalid_type_error: "requireMatchForApproval debe ser booleano." }).optional(),
    retentionYearsDefault: yearsSchema("retentionYearsDefault").optional(),
    letterRetentionYears: yearsSchema("letterRetentionYears").optional()
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: "Indica al menos un ajuste." });

export type DocumentSettingsPatchInput = z.output<typeof DocumentSettingsPatchSchema>;

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

/** `aiAllowedKindsJson` → lista de tipos válidos del catálogo (valores extraños se descartan). */
export function aiAllowedKindsOf(raw: unknown): IncomingDocumentKind[] {
  if (!Array.isArray(raw)) return [...DEFAULT_AI_ALLOWED_KINDS];
  const valid = new Set<string>(INCOMING_DOCUMENT_KINDS);
  return [...new Set(raw.filter((value): value is IncomingDocumentKind => typeof value === "string" && valid.has(value)))];
}

export function toDocumentSettingsDto(row: DocumentSettings | null, organizationId: string): DocumentSettingsDto {
  if (!row) {
    return {
      organizationId,
      officeSlaBusinessDays: DEFAULT_DOCUMENT_SETTINGS.officeSlaBusinessDays,
      autoSendToOffice: DEFAULT_DOCUMENT_SETTINGS.autoSendToOffice,
      aiAllowedKinds: [...DEFAULT_AI_ALLOWED_KINDS],
      priceTolerancePct: DEFAULT_DOCUMENT_SETTINGS.priceTolerancePct,
      quantityTolerance: DEFAULT_DOCUMENT_SETTINGS.quantityTolerance,
      amountToleranceAbs: DEFAULT_DOCUMENT_SETTINGS.amountToleranceAbs,
      requireMatchForApproval: DEFAULT_DOCUMENT_SETTINGS.requireMatchForApproval,
      retentionYearsDefault: DEFAULT_DOCUMENT_SETTINGS.retentionYearsDefault,
      letterRetentionYears: DEFAULT_DOCUMENT_SETTINGS.letterRetentionYears,
      updatedAt: null
    };
  }
  return {
    organizationId: row.organizationId,
    officeSlaBusinessDays: row.officeSlaBusinessDays,
    autoSendToOffice: row.autoSendToOffice,
    aiAllowedKinds: aiAllowedKindsOf(row.aiAllowedKindsJson),
    priceTolerancePct: row.priceTolerancePct.toFixed(2),
    quantityTolerance: row.quantityTolerance.toFixed(3),
    amountToleranceAbs: row.amountToleranceAbs.toFixed(2),
    requireMatchForApproval: row.requireMatchForApproval,
    retentionYearsDefault: row.retentionYearsDefault,
    letterRetentionYears: row.letterRetentionYears,
    updatedAt: row.updatedAt.toISOString()
  };
}

/** Datos de creación de la fila (defaults de la tanda + el PATCH). */
export function settingsCreateData(organizationId: string, patch: DocumentSettingsPatchInput): Prisma.DocumentSettingsUncheckedCreateInput {
  const data: Prisma.DocumentSettingsUncheckedCreateInput = {
    organizationId,
    aiAllowedKindsJson: (patch.aiAllowedKinds ?? [...DEFAULT_AI_ALLOWED_KINDS]) as unknown as Prisma.InputJsonValue
  };
  if (patch.officeSlaBusinessDays !== undefined) data.officeSlaBusinessDays = patch.officeSlaBusinessDays;
  if (patch.autoSendToOffice !== undefined) data.autoSendToOffice = patch.autoSendToOffice;
  if (patch.priceTolerancePct !== undefined) data.priceTolerancePct = patch.priceTolerancePct;
  if (patch.quantityTolerance !== undefined) data.quantityTolerance = patch.quantityTolerance;
  if (patch.amountToleranceAbs !== undefined) data.amountToleranceAbs = patch.amountToleranceAbs;
  if (patch.requireMatchForApproval !== undefined) data.requireMatchForApproval = patch.requireMatchForApproval;
  if (patch.retentionYearsDefault !== undefined) data.retentionYearsDefault = patch.retentionYearsDefault;
  if (patch.letterRetentionYears !== undefined) data.letterRetentionYears = patch.letterRetentionYears;
  return data;
}

/** Solo los campos presentes en el PATCH. */
export function settingsUpdateData(patch: DocumentSettingsPatchInput): Prisma.DocumentSettingsUncheckedUpdateInput {
  const data: Prisma.DocumentSettingsUncheckedUpdateInput = {};
  if (patch.officeSlaBusinessDays !== undefined) data.officeSlaBusinessDays = patch.officeSlaBusinessDays;
  if (patch.autoSendToOffice !== undefined) data.autoSendToOffice = patch.autoSendToOffice;
  if (patch.aiAllowedKinds !== undefined) data.aiAllowedKindsJson = patch.aiAllowedKinds as unknown as Prisma.InputJsonValue;
  if (patch.priceTolerancePct !== undefined) data.priceTolerancePct = patch.priceTolerancePct;
  if (patch.quantityTolerance !== undefined) data.quantityTolerance = patch.quantityTolerance;
  if (patch.amountToleranceAbs !== undefined) data.amountToleranceAbs = patch.amountToleranceAbs;
  if (patch.requireMatchForApproval !== undefined) data.requireMatchForApproval = patch.requireMatchForApproval;
  if (patch.retentionYearsDefault !== undefined) data.retentionYearsDefault = patch.retentionYearsDefault;
  if (patch.letterRetentionYears !== undefined) data.letterRetentionYears = patch.letterRetentionYears;
  return data;
}

/** Campos del DTO que cambian entre `before` y `after` (para la auditoría). */
export function changedSettings(before: DocumentSettingsDto, after: DocumentSettingsDto): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const outBefore: Record<string, unknown> = {};
  const outAfter: Record<string, unknown> = {};
  for (const key of Object.keys(after) as Array<keyof DocumentSettingsDto>) {
    if (key === "organizationId" || key === "updatedAt") continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      outBefore[key] = before[key];
      outAfter[key] = after[key];
    }
  }
  return { before: outBefore, after: outAfter };
}

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

export type DocumentSettingsServiceDeps = { db?: Db; audit?: typeof recordAuditEvent };
export type SettingsActorInput = { context: UserContext; organizationId: string; correlationId?: string; ipAddress?: string };

export function createDocumentSettingsService(deps: DocumentSettingsServiceDeps = {}) {
  const db: Db = deps.db ?? prisma;
  const recordAudit = deps.audit ?? recordAuditEvent;

  async function getDocumentSettings(input: SettingsActorInput): Promise<DocumentSettingsDto> {
    requirePermissions(input.context, [ADMIN_PERMISSION]);
    const row = await db.documentSettings.findUnique({ where: { organizationId: input.organizationId } });
    return toDocumentSettingsDto(row, input.organizationId);
  }

  async function patchDocumentSettings(input: SettingsActorInput & { body: unknown }): Promise<DocumentSettingsDto> {
    requirePermissions(input.context, [ADMIN_PERMISSION]);
    const patch = parseOr400(DocumentSettingsPatchSchema, input.body ?? {}, "Ajustes de documentos");
    const existing = await db.documentSettings.findUnique({ where: { organizationId: input.organizationId } });
    const before = toDocumentSettingsDto(existing, input.organizationId);
    const row = await db.documentSettings.upsert({
      where: { organizationId: input.organizationId },
      create: settingsCreateData(input.organizationId, patch),
      update: settingsUpdateData(patch)
    });
    const after = toDocumentSettingsDto(row, input.organizationId);
    const changed = changedSettings(before, after);
    recordAudit({
      organizationId: input.organizationId,
      propertyId: input.context.propertyId,
      actorUserId: input.context.userId,
      actorType: "user",
      action: DOCUMENT_SETTINGS_AUDIT_ACTIONS.updated,
      entityType: DOCUMENT_SETTINGS_AUDIT_ENTITY,
      entityId: row.id,
      beforeJson: changed.before,
      afterJson: changed.after,
      ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}),
      ...(input.context.deviceId ? { deviceId: input.context.deviceId } : {}),
      ...(input.correlationId ? { correlationId: input.correlationId } : {})
    });
    return after;
  }

  return { getDocumentSettings, patchDocumentSettings };
}

export type DocumentSettingsService = ReturnType<typeof createDocumentSettingsService>;

let defaultService: DocumentSettingsService | null = null;
export function getDocumentSettingsService(): DocumentSettingsService {
  if (!defaultService) defaultService = createDocumentSettingsService();
  return defaultService;
}

export const getDocumentSettings = (input: SettingsActorInput): Promise<DocumentSettingsDto> => getDocumentSettingsService().getDocumentSettings(input);
export const patchDocumentSettings = (input: SettingsActorInput & { body: unknown }): Promise<DocumentSettingsDto> => getDocumentSettingsService().patchDocumentSettings(input);
