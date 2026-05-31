// Notification template management (Sprint 26).
//
// Templates are keyed by `(organizationId, propertyId|null, code, channel,
// language)`. `propertyId=null` means "organization-wide default" — the
// dispatcher resolves a property-scoped template first and falls back to the
// org-wide default.

import { prisma, type Prisma } from "@hotelos/database";
import { listTemplateTokensForTemplate } from "./template-renderer.service.js";

export type NotificationTemplateRecord = {
  id: string;
  organizationId: string;
  propertyId: string | null;
  code: string;
  channel: string;
  language: string;
  subject: string | null;
  body: string;
  variablesJson: unknown;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  tokens: string[];
};

type Row = {
  id: string;
  organizationId: string;
  propertyId: string | null;
  code: string;
  channel: string;
  language: string;
  subject: string | null;
  body: string;
  variablesJson: Prisma.JsonValue | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function toRecord(row: Row): NotificationTemplateRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    propertyId: row.propertyId,
    code: row.code,
    channel: row.channel,
    language: row.language,
    subject: row.subject,
    body: row.body,
    variablesJson: row.variablesJson,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    tokens: listTemplateTokensForTemplate({ body: row.body, subject: row.subject })
  };
}

export async function listTemplates(
  organizationId: string,
  propertyId?: string,
  channel?: string
): Promise<NotificationTemplateRecord[]> {
  const where: Prisma.NotificationTemplateWhereInput = { organizationId };
  if (propertyId !== undefined) {
    // Show both property-scoped and org-wide (propertyId null) templates so
    // operators see which org-wide defaults a property inherits.
    where.OR = [{ propertyId }, { propertyId: null }];
  }
  if (channel) where.channel = channel;

  const rows = await prisma.notificationTemplate.findMany({
    where,
    orderBy: [{ active: "desc" }, { code: "asc" }, { channel: "asc" }, { language: "asc" }]
  });
  return rows.map(toRecord);
}

export type UpsertTemplateInput = {
  organizationId: string;
  propertyId?: string | null;
  code: string;
  channel: string;
  language?: string;
  subject?: string | null;
  body: string;
  variablesJson?: unknown;
  active?: boolean;
};

/**
 * Upsert by the natural key (organizationId, propertyId, code, channel,
 * language). Property-scoped variants override org-wide defaults.
 *
 * Implemented as findFirst → update | create rather than `prisma.upsert`
 * because Prisma's compound unique helper does not accept `null` for the
 * propertyId column, even though the underlying index treats nulls as part
 * of the constraint.
 */
export async function createTemplate(input: UpsertTemplateInput): Promise<NotificationTemplateRecord> {
  if (!input.code.trim()) throw new Error("Template code is required.");
  if (!input.channel.trim()) throw new Error("Template channel is required.");
  if (!input.body || !input.body.trim()) throw new Error("Template body cannot be empty.");

  const language = input.language ?? "es";
  const propertyId = input.propertyId ?? null;
  const variablesJson =
    input.variablesJson === undefined ? undefined : (input.variablesJson as Prisma.InputJsonValue);

  const existing = await prisma.notificationTemplate.findFirst({
    where: {
      organizationId: input.organizationId,
      propertyId,
      code: input.code,
      channel: input.channel,
      language
    }
  });

  if (existing) {
    const updated = await prisma.notificationTemplate.update({
      where: { id: existing.id },
      data: {
        subject: input.subject ?? null,
        body: input.body,
        variablesJson,
        active: input.active ?? true
      }
    });
    return toRecord(updated as Row);
  }

  const created = await prisma.notificationTemplate.create({
    data: {
      organizationId: input.organizationId,
      propertyId,
      code: input.code,
      channel: input.channel,
      language,
      subject: input.subject ?? null,
      body: input.body,
      variablesJson,
      active: input.active ?? true
    }
  });
  return toRecord(created as Row);
}

export async function deactivateTemplate(id: string): Promise<NotificationTemplateRecord> {
  const row = await prisma.notificationTemplate.update({
    where: { id },
    data: { active: false }
  });
  return toRecord(row as Row);
}

/**
 * Resolve the active template that should fire for a given dispatch. Tries
 * the property-scoped row first, then falls back to the org-wide default
 * (propertyId null). Language preference order: requested language, then "es"
 * (system default), then anything else for the same code/channel.
 */
export async function resolveTemplate(input: {
  organizationId: string;
  propertyId?: string | null;
  code: string;
  channel: string;
  language?: string;
}): Promise<NotificationTemplateRecord | null> {
  const language = input.language ?? "es";

  const candidates = await prisma.notificationTemplate.findMany({
    where: {
      organizationId: input.organizationId,
      code: input.code,
      channel: input.channel,
      active: true,
      OR: [{ propertyId: input.propertyId ?? null }, { propertyId: null }]
    }
  });
  if (candidates.length === 0) return null;

  // Sort: property-scoped wins over org-wide, then exact language match wins
  // over "es" fallback, then any other language.
  const scored = candidates
    .map((row) => {
      const propertyScore = row.propertyId === (input.propertyId ?? null) && row.propertyId !== null ? 2 : 1;
      const languageScore = row.language === language ? 2 : row.language === "es" ? 1 : 0;
      return { row, score: propertyScore * 10 + languageScore };
    })
    .sort((a, b) => b.score - a.score);
  return toRecord(scored[0]!.row as Row);
}
