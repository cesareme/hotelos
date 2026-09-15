// Demand calendar · Prisma-backed CRUD over `DemandCalendarEvent`.
//
// Replaces the in-memory `demoStore.demandCalendarEvents` legs (advanced
// modules service): events created here survive a restart, are tenant-scoped
// by `propertyId` (the global hook validates the path property; the row must
// hang from it) and feed the rate-grid recommendation engine (high +8 %,
// medium +4 %) and the History & Forecast board. Bodies are validated with
// zod so a bad payload is a typed 400 in Spanish before any DB call.

import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { z } from "zod";
import type { UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { BadRequestError, NotFoundError } from "../../lib/http-error.js";
import { isIsoDate } from "../../lib/query-dates.js";
import { dayUtc, isoDate } from "./actuals.js";
import { zodErrorMapEs } from "../rate-manager/rate-grid.schemas.js";

export const DEMAND_IMPACTS = ["low", "medium", "high"] as const;
export type DemandImpact = (typeof DEMAND_IMPACTS)[number];
/** Event types offered by the admin screen; free text is accepted too (imports). */
export const DEMAND_EVENT_TYPES = ["city_event", "concert", "sports", "conference", "holiday", "fair", "festival", "school_holiday", "weather", "manual", "other"] as const;
export const DEMAND_SOURCES = ["manual", "import", "api", "seed"] as const;

const isoDay = z.string().refine(isIsoDate, { message: "debe ser una fecha YYYY-MM-DD válida" });

export const DemandEventCreateSchema = z
  .object({
    name: z.string().trim().min(1, "name es obligatorio").max(200, "name: máximo 200 caracteres"),
    eventType: z.string().trim().min(1).max(60).default("manual"),
    startDate: isoDay,
    endDate: isoDay,
    expectedImpact: z.enum(DEMAND_IMPACTS).default("medium"),
    impactScore: z.number().min(0, "impactScore debe estar entre 0 y 100").max(100, "impactScore debe estar entre 0 y 100").optional(),
    source: z.string().trim().min(1).max(60).default("manual"),
    metadata: z.record(z.unknown()).optional()
  })
  .strict()
  .refine((v) => v.startDate <= v.endDate, { message: "startDate debe ser igual o anterior a endDate", path: ["endDate"] });

export const DemandEventPatchSchema = z
  .object({
    name: z.string().trim().min(1, "name no puede estar vacío").max(200).optional(),
    eventType: z.string().trim().min(1).max(60).optional(),
    startDate: isoDay.optional(),
    endDate: isoDay.optional(),
    expectedImpact: z.enum(DEMAND_IMPACTS).optional(),
    impactScore: z.number().min(0, "impactScore debe estar entre 0 y 100").max(100, "impactScore debe estar entre 0 y 100").nullable().optional(),
    source: z.string().trim().min(1).max(60).optional(),
    metadata: z.record(z.unknown()).optional()
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "el cuerpo no contiene ningún campo que modificar" });

export const DemandEventListQuerySchema = z
  .object({
    from: isoDay.optional(),
    to: isoDay.optional()
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: "to debe ser igual o posterior a from", path: ["to"] });

export type DemandEventCreateInput = z.infer<typeof DemandEventCreateSchema>;
export type DemandEventPatchInput = z.infer<typeof DemandEventPatchSchema>;

/** Wire shape (matches the admin screen's `DemandEvent` and the legacy in-memory record). */
export type DemandEventDto = {
  id: string;
  propertyId: string;
  name: string;
  eventType: string | null;
  startDate: string;
  endDate: string;
  expectedImpact: string | null;
  impactScore: number | null;
  source: string | null;
  metadataJson: Record<string, unknown>;
  createdAt: string;
};

/** Default score per impact so the engine and the UI always have a number. */
export const IMPACT_SCORE_DEFAULTS: Record<DemandImpact, number> = { low: 25, medium: 50, high: 85 };

/**
 * Parsea con zod y convierte el primer issue en un 400 en español (details lleva
 * todos los issues). Se parsea con `zodErrorMapEs` (rate-manager) para que los
 * textos incrustados de zod — «Required», «Number must be less than or equal
 * to 50», «Unrecognized key(s)»… — nunca lleguen al usuario
 * (api-live-contract#8); los mensajes explícitos de cada schema prevalecen.
 */
export function parseOrBadRequest<T extends z.ZodTypeAny>(schema: T, body: unknown, what = "cuerpo"): z.infer<T> {
  const result = schema.safeParse(body ?? {}, { errorMap: zodErrorMapEs });
  if (result.success) return result.data;
  const issues = result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
  const first = issues[0];
  const err = new BadRequestError(`${what} inválido: ${first.path ? `${first.path}: ` : ""}${first.message}`);
  err.details = { code: "VALIDATION_ERROR", issues };
  throw err;
}

function toDto(row: {
  id: string;
  propertyId: string;
  name: string;
  eventType: string | null;
  startDate: Date;
  endDate: Date;
  expectedImpact: string | null;
  impactScore: Prisma.Decimal | null;
  source: string | null;
  metadataJson: Prisma.JsonValue;
  createdAt: Date;
}): DemandEventDto {
  const meta = row.metadataJson && typeof row.metadataJson === "object" && !Array.isArray(row.metadataJson) ? (row.metadataJson as Record<string, unknown>) : {};
  return {
    id: row.id,
    propertyId: row.propertyId,
    name: row.name,
    eventType: row.eventType,
    startDate: isoDate(dayUtc(row.startDate)),
    endDate: isoDate(dayUtc(row.endDate)),
    expectedImpact: row.expectedImpact,
    impactScore: row.impactScore === null ? null : Number(row.impactScore),
    source: row.source,
    metadataJson: meta,
    createdAt: row.createdAt.toISOString()
  };
}

/** Events overlapping [from, to] (both inclusive), oldest start first. Used by the recommendation engine. */
export async function listDemandEventsInWindow(propertyId: string, from: string, to: string): Promise<DemandEventDto[]> {
  const rows = await prisma.demandCalendarEvent.findMany({
    where: { propertyId, startDate: { lte: dayUtc(to) }, endDate: { gte: dayUtc(from) } },
    orderBy: [{ startDate: "asc" }, { name: "asc" }],
    take: 1000
  });
  return rows.map(toDto);
}

export async function listDemandEvents(input: { propertyId: string; query?: unknown }): Promise<{ items: DemandEventDto[] }> {
  const q = parseOrBadRequest(DemandEventListQuerySchema, input.query ?? {}, "query");
  const where: Prisma.DemandCalendarEventWhereInput = { propertyId: input.propertyId };
  if (q.from) where.endDate = { gte: dayUtc(q.from) };
  if (q.to) where.startDate = { lte: dayUtc(q.to) };
  const rows = await prisma.demandCalendarEvent.findMany({ where, orderBy: [{ startDate: "asc" }, { name: "asc" }], take: 2000 });
  return { items: rows.map(toDto) };
}

export async function createDemandEvent(input: { context: UserContext; propertyId: string; body: unknown; correlationId: string }): Promise<DemandEventDto> {
  requirePermissions(input.context, ["revenue.manage_rates"]);
  const data = parseOrBadRequest(DemandEventCreateSchema, input.body);
  const row = await prisma.demandCalendarEvent.create({
    data: {
      propertyId: input.propertyId,
      name: data.name,
      eventType: data.eventType,
      startDate: dayUtc(data.startDate),
      endDate: dayUtc(data.endDate),
      expectedImpact: data.expectedImpact,
      impactScore: data.impactScore ?? IMPACT_SCORE_DEFAULTS[data.expectedImpact],
      source: data.source,
      metadataJson: (data.metadata ?? {}) as Prisma.InputJsonValue
    }
  });
  const dto = toDto(row);
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "DemandCalendarEventCreated",
    entityType: "demand_calendar_event",
    entityId: row.id,
    afterJson: dto,
    correlationId: input.correlationId
  });
  return dto;
}

/** The event must hang from the path property; a foreign/unknown id is an opaque 404 (no existence oracle). */
async function loadOwnedEvent(propertyId: string, eventId: string) {
  const row = await prisma.demandCalendarEvent.findUnique({ where: { id: eventId } });
  if (!row || row.propertyId !== propertyId) throw new NotFoundError("Evento de demanda no encontrado.");
  return row;
}

export async function updateDemandEvent(input: { context: UserContext; propertyId: string; eventId: string; body: unknown; correlationId: string }): Promise<DemandEventDto> {
  requirePermissions(input.context, ["revenue.manage_rates"]);
  const patch = parseOrBadRequest(DemandEventPatchSchema, input.body);
  const existing = await loadOwnedEvent(input.propertyId, input.eventId);
  const startDate = patch.startDate ?? isoDate(dayUtc(existing.startDate));
  const endDate = patch.endDate ?? isoDate(dayUtc(existing.endDate));
  if (startDate > endDate) throw new BadRequestError("startDate debe ser igual o anterior a endDate");
  const data: Prisma.DemandCalendarEventUpdateInput = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.eventType !== undefined) data.eventType = patch.eventType;
  if (patch.startDate !== undefined) data.startDate = dayUtc(patch.startDate);
  if (patch.endDate !== undefined) data.endDate = dayUtc(patch.endDate);
  if (patch.expectedImpact !== undefined) data.expectedImpact = patch.expectedImpact;
  if (patch.impactScore !== undefined) data.impactScore = patch.impactScore;
  if (patch.source !== undefined) data.source = patch.source;
  if (patch.metadata !== undefined) data.metadataJson = patch.metadata as Prisma.InputJsonValue;
  const row = await prisma.demandCalendarEvent.update({ where: { id: existing.id }, data });
  const dto = toDto(row);
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "DemandCalendarEventUpdated",
    entityType: "demand_calendar_event",
    entityId: row.id,
    beforeJson: toDto(existing),
    afterJson: dto,
    correlationId: input.correlationId
  });
  return dto;
}

export async function deleteDemandEvent(input: { context: UserContext; propertyId: string; eventId: string; correlationId: string }): Promise<{ id: string; deleted: true }> {
  requirePermissions(input.context, ["revenue.manage_rates"]);
  const existing = await loadOwnedEvent(input.propertyId, input.eventId);
  await prisma.demandCalendarEvent.delete({ where: { id: existing.id } });
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "DemandCalendarEventDeleted",
    entityType: "demand_calendar_event",
    entityId: existing.id,
    beforeJson: toDto(existing),
    correlationId: input.correlationId
  });
  return { id: existing.id, deleted: true };
}
