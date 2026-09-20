// Tanda L2 (L2-03 · motor genérico Prisma-only): persistencia por TABLA PROPIA
// de los tipos de registro del motor de módulos avanzados. Una función de
// lista / alta / transición por tabla, `select` explícito en cada consulta y
// ninguna consulta por fila (los nombres de empleado, las líneas de pedido y
// los autores de pedido se resuelven en UNA consulta por página).
//
// Aislamiento (fail-secure):
//   · toda consulta filtra por `propertyId` (recurso de hotel) y, cuando el
//     modelo lo tiene, por `organizationId` (CrmSegment, CrmCampaign,
//     LoyaltyProgram, MetricDefinition, AnomalyEvent, ScheduledReport);
//   · las tablas hijas sin propietario (IncidentEvidence, SafetyCheckResult,
//     SurveyResponse, EventOrder, UtilityReading→meter, LoyaltyMembership,
//     PurchaseOrderLine) se alcanzan SOLO a través de su padre, que debe
//     colgar de la propiedad / organización de la petición (404 opaco si no);
//   · una transición busca la fila por id + ámbito: si no coincide, 404 opaco
//     («Registro no encontrado.»), nunca se revela que el id existe en otro
//     tenant.
//
// Paginación: keyset por `createdAt desc, id desc` (`take: limit + 1`,
// `buildPage` de lib/pagination.ts; MetricDefinition, sin createdAt, ordena por
// `metricCode asc, id asc`; AnomalyEvent por `detectedAt desc`). El cursor es
// el opaco de lib/pagination.ts; uno inválido es un 400.
//
// Formas de salida:
//   · cuadros operativos (workforce, safety, quality, surveys): el envoltorio
//     `{ id, status, payload, createdAt, updatedAt }` que leen
//     WorkforceDashboard.tsx y SafetyDashboard.tsx (`payload.title`,
//     `payload.staffName`, `payload.action`…); los turnos añaden `warnings`
//     (Tanda RRHH: motor de reglas hr/rules.engine.ts, nunca bloquea);
//   · el resto (CRM, fidelización, eventos, compras, energía, analítica,
//     reseñas): la fila tipada (fechas ISO, decimales como número).

import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import type { HotelModuleCode } from "@hotelos/product";
import type { PermissionKey } from "@hotelos/shared";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../../lib/http-error.js";
import { createId } from "../../lib/ids.js";
import { buildPage, decodeCursor, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, type CursorKey, type Page } from "../../lib/pagination.js";
import { parse } from "../../lib/validate.js";
import { evaluateShifts, type RuleSet, type RuleViolation } from "../hr/rules.engine.js";
import {
  AbsenceCreateSchema,
  AbsenceListFilterSchema,
  AbsenceTransitionSchema,
  AnomalyTransitionSchema,
  assertTransitionAllowed,
  CrmCampaignCreateSchema,
  CrmCampaignUpdateSchema,
  CrmSegmentCreateSchema,
  CrmSegmentUpdateSchema,
  EventOrderCreateSchema,
  EvidenceCreateSchema,
  GuestReviewRespondSchema,
  INVALID_TRANSITION_CODE,
  STATE_MACHINES,
  IncidentCreateSchema,
  IncidentUpdateSchema,
  LoyaltyMembershipUpdateSchema,
  LoyaltyProgramCreateSchema,
  MetricDefinitionCreateSchema,
  PurchaseOrderCreateSchema,
  PurchaseOrderTransitionSchema,
  QualityCaseCreateSchema,
  QualityCaseUpdateSchema,
  SafetyCheckCreateSchema,
  SafetyCheckResultCreateSchema,
  ScheduledReportCreateSchema,
  ShiftCreateSchema,
  ShiftUpdateSchema,
  SurveyCreateSchema,
  SurveyResponseCreateSchema,
  SustainabilityActionCreateSchema,
  TimeClockCreateSchema,
  UNSUPPORTED_RECORD_TYPE_MESSAGE,
  UtilityMeterCreateSchema,
  UtilityReadingCreateSchema,
  type ShiftCreateInput,
  type TimeClockCreateInput,
  type AbsenceCreateInput
} from "./advanced-record-schemas.js";

// ---------------------------------------------------------------------------
// Ámbito, paginación y utilidades
// ---------------------------------------------------------------------------

export type StoreScope = {
  organizationId: string;
  propertyId: string;
  moduleCode: HotelModuleCode;
  userId: string;
  deviceId?: string;
  /** Acción de auditoría de la ruta (p. ej. StaffClockedOut decide el sentido del fichaje sin `action`). */
  auditAction?: string;
  /**
   * Claves del actor (corrector RRHH · RF-01): el fichaje con solo
   * `workforce.timeclock.use` es SIEMPRE sobre la ficha del propio actor y con
   * la hora del servidor; `workforce.timeclock.manage` ficha por terceros y
   * fija `at`. Sin lista (lectores, scripts) no se restringe nada.
   */
  permissions?: readonly PermissionKey[];
  /** Solo getRecord: restringe la lista a un id (una consulta, mismo ámbito). */
  onlyId?: string;
};

/**
 * `status`: filtro opcional de las listas que lo admiten (hoy `workforce_labor:absence_requests`); las demás lo ignoran.
 * `staffProfileIds` (corrector RRHH · RF-03): restringe las listas de personas (`absence_requests`,
 * `time_clock_entries`) a esas fichas — el empleado solo ve lo suyo; lista vacía = página vacía.
 */
export type PageInput = { limit?: number; cursor?: string | null; status?: string | null; staffProfileIds?: readonly string[] | null };
type NormalizedPage = { limit: number; cursor: CursorKey | null; status?: string; staffProfileIds?: readonly string[] };

export const RECORD_NOT_FOUND = "Registro no encontrado.";

/** `limit` por defecto 100, máximo 500 (recortado sin error); no entero o < 1 → 400. */
export function normalizePage(page?: PageInput): NormalizedPage {
  let limit = DEFAULT_PAGE_LIMIT;
  if (page?.limit !== undefined) {
    if (!Number.isInteger(page.limit) || page.limit < 1) throw new BadRequestError("El parámetro limit debe ser un entero positivo.");
    limit = Math.min(page.limit, MAX_PAGE_LIMIT);
  }
  if (page?.status !== undefined && page.status !== null && typeof page.status !== "string") throw new BadRequestError("El parámetro status no es válido.");
  const status = typeof page?.status === "string" && page.status.trim().length > 0 ? page.status.trim() : undefined;
  const staffProfileIds = Array.isArray(page?.staffProfileIds) ? page.staffProfileIds.filter((id): id is string => typeof id === "string" && id.length > 0) : undefined;
  return { limit, cursor: decodeCursor(page?.cursor ?? null), ...(status ? { status } : {}), ...(staffProfileIds ? { staffProfileIds } : {}) };
}

type DateKeyset = { OR?: Array<{ createdAt?: Date | { lt: Date }; id?: { lt: string } }> };
type DetectedAtKeyset = { OR?: Array<{ detectedAt?: Date | { lt: Date }; id?: { lt: string } }> };
type CodeKeyset = { OR?: Array<{ metricCode?: string | { gt: string }; id?: { gt: string } }> };

function cursorDate(cursor: CursorKey): Date {
  const value = new Date(cursor.k);
  if (Number.isNaN(value.getTime())) throw new BadRequestError("El cursor de paginación no es válido.");
  return value;
}

/** Filas posteriores al cursor en orden `createdAt desc, id desc`. */
function afterCreatedAt(cursor: CursorKey | null): DateKeyset {
  if (!cursor) return {};
  const k = cursorDate(cursor);
  return { OR: [{ createdAt: { lt: k } }, { createdAt: k, id: { lt: cursor.id } }] };
}

function afterDetectedAt(cursor: CursorKey | null): DetectedAtKeyset {
  if (!cursor) return {};
  const k = cursorDate(cursor);
  return { OR: [{ detectedAt: { lt: k } }, { detectedAt: k, id: { lt: cursor.id } }] };
}

function afterMetricCode(cursor: CursorKey | null): CodeKeyset {
  if (!cursor) return {};
  return { OR: [{ metricCode: { gt: cursor.k } }, { metricCode: cursor.k, id: { gt: cursor.id } }] };
}

const NEWEST_FIRST: Array<{ createdAt?: Prisma.SortOrder; id?: Prisma.SortOrder }> = [{ createdAt: "desc" }, { id: "desc" }];
const createdAtKey = (row: { createdAt: Date }) => row.createdAt.toISOString();

function mapPage<R extends { id: string }, I>(page: Page<R>, map: (row: R) => I): Page<I> {
  return { items: page.items.map(map), nextCursor: page.nextCursor, total: page.total };
}

const idFilter = (scope: StoreScope): { id?: string } => (scope.onlyId ? { id: scope.onlyId } : {});
/** Filtro por fichas de la página (RF-03): sin lista no filtra; lista vacía → `in: []` (ninguna fila). */
const staffFilter = (page: NormalizedPage): { staffProfileId?: { in: string[] } } => (page.staffProfileIds ? { staffProfileId: { in: [...page.staffProfileIds] } } : {});
const iso = (value: Date | null | undefined): string | undefined => (value ? value.toISOString() : undefined);
const isoOrNull = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);
const dec = (value: { toString(): string } | null | undefined): number | null => (value === null || value === undefined ? null : Number(value.toString()));
const toJson = (value: unknown): Prisma.InputJsonValue => (value ?? {}) as Prisma.InputJsonValue;
const asObject = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const dateOf = (value: string): Date => new Date(value);
const utcDayStart = (date: Date): Date => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
const orgOrProperty = (scope: StoreScope) => ({ OR: [{ propertyId: scope.propertyId }, { propertyId: null }] });

/**
 * Estado destino de una transición: el del cuerpo si viene; si no, el de la
 * ruta («approved», «received»…) o, en las rutas genéricas («updated»), el
 * actual (edición de campos sin cambio de estado, idempotente). Reaplicar la
 * transición de una ruta sobre un registro que ya está en ese estado es un
 * 409 (una ausencia no se aprueba dos veces); todo destino pasa por la
 * máquina del tipo.
 */
function targetStatus(entityType: string, current: string, routeStatus: string, requested: string | undefined): string {
  const target = requested ?? (routeStatus === "updated" ? current : routeStatus);
  if (requested === undefined && routeStatus !== "updated" && target === current) {
    throw new ConflictError(`El registro ya está en estado ${current}.`, { code: INVALID_TRANSITION_CODE, entityType, from: current, to: target, allowed: STATE_MACHINES[entityType]?.transitions[current] ?? [] });
  }
  assertTransitionAllowed(entityType, current, target);
  return target;
}

/** Envoltorio de los cuadros operativos (WorkforceDashboard / SafetyDashboard leen `payload.*`, `status`, `createdAt`). */
export type BoardItem = {
  id: string;
  propertyId: string;
  moduleCode: HotelModuleCode;
  entityType: string;
  status: string;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  /** Tanda RRHH (RRHH-4): avisos del motor de reglas (hr/rules.engine.ts) al crear o mover un turno; nunca bloquean. */
  warnings?: RuleViolation[];
};

function boardItem(
  scope: StoreScope,
  entityType: string,
  row: { id: string; createdAt: Date; updatedAt?: Date | null },
  status: string,
  payload: Record<string, unknown>
): BoardItem {
  const clean = Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined && value !== null));
  return {
    id: row.id,
    propertyId: scope.propertyId,
    moduleCode: scope.moduleCode,
    entityType,
    status,
    payload: clean,
    createdAt: row.createdAt.toISOString(),
    updatedAt: (row.updatedAt ?? row.createdAt).toISOString()
  };
}

// ---------------------------------------------------------------------------
// Padres: la ruta no puede avalar un id que llega en el cuerpo (incidentId,
// safetyCheckId, surveyId, eventId, meterId): debe colgar de la propiedad de
// la petición o es un 404 opaco (SEC-2), nunca una fila colgada de otro tenant.
// ---------------------------------------------------------------------------

const PARENT_NOT_FOUND = {
  safetyIncident: "Incidencia no encontrada.",
  safetyCheck: "Control de seguridad no encontrado.",
  survey: "Encuesta no encontrada.",
  event: "Evento no encontrado.",
  utilityMeter: "Contador no encontrado."
} as const;

async function assertParentInProperty(kind: keyof typeof PARENT_NOT_FOUND, id: string, propertyId: string): Promise<void> {
  const where = { id, propertyId };
  const select = { id: true } as const;
  const row =
    kind === "safetyIncident"
      ? await prisma.safetyIncident.findFirst({ where, select })
      : kind === "safetyCheck"
        ? await prisma.safetyCheck.findFirst({ where, select })
        : kind === "survey"
          ? await prisma.survey.findFirst({ where, select })
          : kind === "event"
            ? await prisma.event.findFirst({ where, select })
            : await prisma.utilityMeter.findFirst({ where, select });
  if (!row) throw new NotFoundError(PARENT_NOT_FOUND[kind]);
}

// ---------------------------------------------------------------------------
// workforce_labor · Shift / TimeClockEntry / AbsenceRequest
// ---------------------------------------------------------------------------

const SHIFT_SELECT = {
  id: true,
  propertyId: true,
  staffProfileId: true,
  departmentId: true,
  shiftDate: true,
  startAt: true,
  endAt: true,
  status: true,
  roleLabel: true,
  createdAt: true
} satisfies Prisma.ShiftSelect;
type ShiftRow = Prisma.ShiftGetPayload<{ select: typeof SHIFT_SELECT }>;

const CLOCK_SELECT = { id: true, propertyId: true, staffProfileId: true, clockType: true, clockAt: true, source: true, metadataJson: true, createdAt: true } satisfies Prisma.TimeClockEntrySelect;
type ClockRow = Prisma.TimeClockEntryGetPayload<{ select: typeof CLOCK_SELECT }>;

const ABSENCE_SELECT = {
  id: true,
  propertyId: true,
  staffProfileId: true,
  absenceType: true,
  startDate: true,
  endDate: true,
  status: true,
  approvedBy: true,
  requestedBy: true,
  decidedAt: true,
  reason: true,
  createdAt: true
} satisfies Prisma.AbsenceRequestSelect;
type AbsenceRow = Prisma.AbsenceRequestGetPayload<{ select: typeof ABSENCE_SELECT }>;

/**
 * Nombre visible por StaffProfile (una consulta de perfiles + una de usuarios
 * por página, ambas en el ámbito). Un id sin perfil (fila legada anterior a la
 * Tanda RRHH, cuando el nombre libre se guardaba como referencia) se muestra
 * tal cual.
 */
async function staffDisplayNames(scope: StoreScope, ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const unique = Array.from(new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0)));
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  const profiles = await prisma.staffProfile.findMany({
    where: { id: { in: unique }, propertyId: scope.propertyId },
    select: { id: true, userId: true, employeeCode: true }
  });
  const userIds = Array.from(new Set(profiles.map((profile) => profile.userId)));
  const users =
    userIds.length === 0
      ? []
      : await prisma.user.findMany({ where: { id: { in: userIds }, organizationId: scope.organizationId }, select: { id: true, fullName: true } });
  const nameByUser = new Map(users.map((user) => [user.id, user.fullName]));
  for (const profile of profiles) out.set(profile.id, nameByUser.get(profile.userId) ?? profile.employeeCode ?? profile.userId);
  return out;
}

export const HR_EMPLOYEE_REQUIRED_CODE = "HR_EMPLOYEE_REQUIRED";
export const APPROVAL_SELF_DECISION_CODE = "APPROVAL_SELF_DECISION";

/** 400 tipado con `details.code` (BadRequestError no admite details en el constructor). */
function badRequestWithCode(message: string, code: string, extra: Record<string, unknown> = {}): BadRequestError {
  const error = new BadRequestError(message);
  error.details = { code, ...extra };
  return error;
}

/**
 * Tanda RRHH (RRHH-4): la persona de un turno, fichaje o ausencia es SIEMPRE
 * una ficha (StaffProfile) de la propiedad. `staffProfileId` debe existir en
 * la propiedad (404 opaco si no); `staffName` es un ALIAS resoluble —
 * código de empleado de la ficha o nombre completo de un usuario de la
 * organización con ficha en la propiedad, exacto e insensible a mayúsculas —
 * que se convierte en el id real. Sin resolución → 400 HR_EMPLOYEE_REQUIRED:
 * el texto nunca se guarda como id ni como referencia.
 */
async function resolveStaff(scope: StoreScope, input: Pick<ShiftCreateInput, "staffProfileId" | "staffName">): Promise<{ staffProfileId: string }> {
  if (input.staffProfileId) {
    const profile = await prisma.staffProfile.findFirst({ where: { id: input.staffProfileId, propertyId: scope.propertyId }, select: { id: true } });
    if (!profile) throw new NotFoundError("Empleado no encontrado.");
    return { staffProfileId: profile.id };
  }
  const alias = (input.staffName ?? "").trim();
  if (alias.length === 0) throw badRequestWithCode("Indica la ficha de personal (staffProfileId o alias).", HR_EMPLOYEE_REQUIRED_CODE);
  const activeFirst = [{ active: "desc" }, { createdAt: "desc" }] satisfies Prisma.StaffProfileOrderByWithRelationInput[];
  const byCode = await prisma.staffProfile.findFirst({
    where: { propertyId: scope.propertyId, employeeCode: { equals: alias, mode: "insensitive" } },
    orderBy: activeFirst,
    select: { id: true }
  });
  if (byCode) return { staffProfileId: byCode.id };
  const users = await prisma.user.findMany({
    where: { organizationId: scope.organizationId, fullName: { equals: alias, mode: "insensitive" } },
    select: { id: true },
    take: 50
  });
  if (users.length > 0) {
    const byUser = await prisma.staffProfile.findFirst({
      where: { propertyId: scope.propertyId, userId: { in: users.map((user) => user.id) } },
      orderBy: activeFirst,
      select: { id: true }
    });
    if (byUser) return { staffProfileId: byUser.id };
  }
  throw badRequestWithCode("No hay ninguna ficha de personal con ese código o nombre en la propiedad.", HR_EMPLOYEE_REQUIRED_CODE);
}

const RULE_KEYS_FOR_SHIFTS: ReadonlyArray<keyof RuleSet> = ["annual_hours", "max_daily_hours", "rest_between_shifts_h", "weekly_rest_days", "overtime_max_year"];

/**
 * Avisos del motor de reglas para la persona del turno: sus turnos del mismo
 * año natural (una consulta), su contrato activo (jornada) y las reglas del
 * convenio del contrato o, en su defecto, de la propiedad (vigentes en la
 * fecha del turno). Sin convenio, defectos del ET. Nunca bloquea.
 */
async function shiftWarnings(scope: StoreScope, staffProfileId: string, shiftDate: Date): Promise<RuleViolation[]> {
  const yearStart = new Date(Date.UTC(shiftDate.getUTCFullYear(), 0, 1));
  const yearEnd = new Date(Date.UTC(shiftDate.getUTCFullYear() + 1, 0, 1));
  const [shifts, contract] = await Promise.all([
    prisma.shift.findMany({
      where: { propertyId: scope.propertyId, staffProfileId, startAt: { gte: yearStart, lt: yearEnd }, status: { not: "cancelled" } },
      select: { id: true, startAt: true, endAt: true },
      orderBy: { startAt: "asc" }
    }),
    prisma.employmentContract.findFirst({
      where: { staffProfileId, active: true, organizationId: scope.organizationId },
      orderBy: { startDate: "desc" },
      select: { weeklyHours: true, partTimePct: true, agreementId: true }
    })
  ]);
  let agreementId = contract?.agreementId ?? null;
  if (!agreementId) {
    const property = await prisma.property.findFirst({ where: { id: scope.propertyId, organizationId: scope.organizationId }, select: { agreementId: true } });
    agreementId = property?.agreementId ?? null;
  }
  const rules: Partial<Record<keyof RuleSet, unknown>> = {};
  if (agreementId) {
    const rows = await prisma.agreementRule.findMany({
      where: { agreementId, key: { in: [...RULE_KEYS_FOR_SHIFTS] }, validFrom: { lte: shiftDate }, OR: [{ validTo: null }, { validTo: { gte: shiftDate } }] },
      orderBy: { validFrom: "desc" },
      select: { key: true, valueJson: true }
    });
    for (const row of rows) if (!(row.key in rules)) rules[row.key as keyof RuleSet] = row.valueJson;
  }
  return evaluateShifts(shifts, { weeklyHours: dec(contract?.weeklyHours), partTimePct: dec(contract?.partTimePct) }, rules);
}

function shiftItem(scope: StoreScope, row: ShiftRow, names: Map<string, string>): BoardItem {
  return boardItem(scope, "shift", row, row.status, {
    staffProfileId: row.staffProfileId,
    staffName: row.staffProfileId ? names.get(row.staffProfileId) ?? row.staffProfileId : undefined,
    departmentId: row.departmentId,
    role: row.roleLabel,
    shiftDate: row.shiftDate.toISOString().slice(0, 10),
    startAt: row.startAt.toISOString(),
    endAt: row.endAt.toISOString(),
    status: row.status
  });
}

async function listShifts(scope: StoreScope, page: NormalizedPage): Promise<Page<BoardItem>> {
  const where: Prisma.ShiftWhereInput = { propertyId: scope.propertyId, ...idFilter(scope) };
  const [rows, total] = await Promise.all([
    prisma.shift.findMany({ where: { ...where, ...afterCreatedAt(page.cursor) }, orderBy: NEWEST_FIRST, take: page.limit + 1, select: SHIFT_SELECT }),
    prisma.shift.count({ where })
  ]);
  const built = buildPage(rows, page.limit, total, createdAtKey);
  const names = await staffDisplayNames(scope, built.items.map((row) => row.staffProfileId));
  return mapPage(built, (row) => shiftItem(scope, row, names));
}

async function createShift(scope: StoreScope, payload: unknown, id: string): Promise<BoardItem> {
  const data = parse(ShiftCreateSchema, payload, "body");
  const staff = await resolveStaff(scope, data);
  const startAt = dateOf(data.startAt);
  const row = await prisma.shift.create({
    data: {
      id,
      propertyId: scope.propertyId,
      staffProfileId: staff.staffProfileId,
      departmentId: data.departmentId ?? null,
      shiftDate: utcDayStart(startAt),
      startAt,
      endAt: dateOf(data.endAt),
      status: data.status ?? "scheduled",
      roleLabel: data.role ?? null
    },
    select: SHIFT_SELECT
  });
  const [names, warnings] = await Promise.all([staffDisplayNames(scope, [row.staffProfileId]), shiftWarnings(scope, staff.staffProfileId, startAt)]);
  return { ...shiftItem(scope, row, names), warnings };
}

async function transitionShift(scope: StoreScope, id: string, routeStatus: string, payload: unknown): Promise<BoardItem> {
  const data = parse(ShiftUpdateSchema, payload, "body");
  const row = await prisma.shift.findFirst({ where: { id, propertyId: scope.propertyId }, select: SHIFT_SELECT });
  if (!row) throw new NotFoundError(RECORD_NOT_FOUND);
  const target = targetStatus("shift", row.status, routeStatus, data.status);
  if (data.staffProfileId) await resolveStaff(scope, { staffProfileId: data.staffProfileId });
  const startAt = data.startAt ? dateOf(data.startAt) : row.startAt;
  const endAt = data.endAt ? dateOf(data.endAt) : row.endAt;
  if (endAt.getTime() <= startAt.getTime()) throw new BadRequestError("endAt debe ser posterior a startAt.");
  const updated = await prisma.shift.update({
    where: { id: row.id },
    data: {
      status: target,
      startAt,
      endAt,
      shiftDate: utcDayStart(startAt),
      ...(data.staffProfileId ? { staffProfileId: data.staffProfileId } : {}),
      ...(data.departmentId ? { departmentId: data.departmentId } : {}),
      ...(data.role ? { roleLabel: data.role } : {})
    },
    select: SHIFT_SELECT
  });
  const names = await staffDisplayNames(scope, [updated.staffProfileId]);
  const warnings = updated.staffProfileId ? await shiftWarnings(scope, updated.staffProfileId, startAt) : [];
  return { ...shiftItem(scope, updated, names), warnings };
}

function clockItem(scope: StoreScope, row: ClockRow, names: Map<string, string>): BoardItem {
  const meta = asObject(row.metadataJson);
  const action = row.clockType === "out" ? "out" : "in";
  // El nombre sale SIEMPRE de la ficha; `meta.staffName` solo existe en filas legadas (antes de la Tanda RRHH).
  return boardItem(scope, "time_clock_entry", row, action, {
    ...meta,
    staffName: names.get(row.staffProfileId) ?? (typeof meta.staffName === "string" ? meta.staffName : row.staffProfileId),
    action,
    at: row.clockAt.toISOString(),
    staffProfileId: row.staffProfileId,
    clockType: row.clockType,
    source: row.source
  });
}

async function listTimeClock(scope: StoreScope, page: NormalizedPage): Promise<Page<BoardItem>> {
  const where: Prisma.TimeClockEntryWhereInput = { propertyId: scope.propertyId, ...idFilter(scope), ...staffFilter(page) };
  const [rows, total] = await Promise.all([
    prisma.timeClockEntry.findMany({ where: { ...where, ...afterCreatedAt(page.cursor) }, orderBy: NEWEST_FIRST, take: page.limit + 1, select: CLOCK_SELECT }),
    prisma.timeClockEntry.count({ where })
  ]);
  const built = buildPage(rows, page.limit, total, createdAtKey);
  const names = await staffDisplayNames(scope, built.items.map((row) => row.staffProfileId));
  return mapPage(built, (row) => clockItem(scope, row, names));
}

export const HR_TIMECLOCK_SELF_ONLY_CODE = "HR_TIMECLOCK_SELF_ONLY";
const TIMECLOCK_MANAGE_KEY: PermissionKey = "workforce.timeclock.manage";

/** ¿El actor ficha por terceros y fija la hora? Solo con `workforce.timeclock.manage` (o sin lista de claves: llamadores internos). */
export function canClockForOthers(scope: Pick<StoreScope, "permissions">): boolean {
  return scope.permissions === undefined || scope.permissions.includes(TIMECLOCK_MANAGE_KEY);
}

/**
 * Fichas ACTIVAS del actor en la propiedad (RF-03 / RF-01): la persona que ficha o
 * que consulta «lo suyo». Un usuario sin ficha en el centro → lista vacía.
 */
export async function ownStaffProfileIds(scope: Pick<StoreScope, "propertyId" | "userId">): Promise<string[]> {
  if (!scope.userId) return [];
  const rows = await prisma.staffProfile.findMany({ where: { propertyId: scope.propertyId, userId: scope.userId, active: true }, select: { id: true }, orderBy: { createdAt: "desc" } });
  return rows.map((row) => row.id);
}

/**
 * Fichaje (D §8 ET 34.9, registro «por persona» e inmutable; corrector RRHH · RF-01):
 * con solo `workforce.timeclock.use` la ficha es la del propio actor en el centro
 * (400 HR_EMPLOYEE_REQUIRED si no tiene ninguna activa), un `staffProfileId` o alias
 * que resuelva a OTRA ficha es un 403 HR_TIMECLOCK_SELF_ONLY y `at` se ignora (hora
 * del servidor: nadie fabrica un fichaje retroactivo). Con `workforce.timeclock.manage`
 * (gobernanta, jefatura, RRHH) se ficha por terceros y se admite `at` (corrección
 * manual, auditada por la ruta).
 */
async function createTimeClock(scope: StoreScope, payload: unknown, id: string): Promise<BoardItem> {
  const data: TimeClockCreateInput = parse(TimeClockCreateSchema, payload, "body");
  if (data.propertyId && data.propertyId !== scope.propertyId) throw new BadRequestError("propertyId no coincide con la propiedad de la petición.");
  const manages = canClockForOthers(scope);
  let staffProfileId: string;
  if (manages) {
    staffProfileId = (await resolveStaff(scope, data)).staffProfileId;
  } else {
    const own = await ownStaffProfileIds(scope);
    if (own.length === 0) throw badRequestWithCode("No tienes ficha de personal activa en este centro: pide a RRHH que la cree antes de fichar.", HR_EMPLOYEE_REQUIRED_CODE);
    const requested = data.staffProfileId || (data.staffName ?? "").trim() ? (await resolveStaff(scope, data)).staffProfileId : own[0]!;
    if (!own.includes(requested)) {
      throw new ForbiddenError("Solo puedes fichar con tu propia ficha de personal; fichar por otra persona exige workforce.timeclock.manage.", { code: HR_TIMECLOCK_SELF_ONLY_CODE, staffProfileId: requested });
    }
    staffProfileId = requested;
  }
  const action = data.action ?? (scope.auditAction === "StaffClockedOut" ? "out" : "in");
  const row = await prisma.timeClockEntry.create({
    data: {
      id,
      propertyId: scope.propertyId,
      staffProfileId,
      clockType: action,
      clockAt: manages && data.at ? dateOf(data.at) : new Date(),
      source: data.source ?? "api",
      deviceId: scope.deviceId ?? null,
      metadataJson: toJson({ action })
    },
    select: CLOCK_SELECT
  });
  return clockItem(scope, row, await staffDisplayNames(scope, [row.staffProfileId]));
}

function absenceItem(scope: StoreScope, row: AbsenceRow, names: Map<string, string>): BoardItem {
  return boardItem(scope, "absence_request", row, row.status, {
    staffProfileId: row.staffProfileId,
    staffName: names.get(row.staffProfileId) ?? row.staffProfileId,
    absenceType: row.absenceType,
    startDate: row.startDate.toISOString().slice(0, 10),
    endDate: row.endDate.toISOString().slice(0, 10),
    approvedBy: row.approvedBy,
    requestedBy: row.requestedBy,
    decidedAt: isoOrNull(row.decidedAt),
    reason: row.reason,
    status: row.status
  });
}

/** Lista de ausencias de la propiedad (`workforce_labor:absence_requests`), con filtro opcional `status` (400 si no es un estado de la máquina). */
async function listAbsences(scope: StoreScope, page: NormalizedPage): Promise<Page<BoardItem>> {
  const filter = parse(AbsenceListFilterSchema, page.status ? { status: page.status } : {}, "query");
  const where: Prisma.AbsenceRequestWhereInput = { propertyId: scope.propertyId, ...(filter.status ? { status: filter.status } : {}), ...idFilter(scope), ...staffFilter(page) };
  const [rows, total] = await Promise.all([
    prisma.absenceRequest.findMany({ where: { ...where, ...afterCreatedAt(page.cursor) }, orderBy: NEWEST_FIRST, take: page.limit + 1, select: ABSENCE_SELECT }),
    prisma.absenceRequest.count({ where })
  ]);
  const built = buildPage(rows, page.limit, total, createdAtKey);
  const names = await staffDisplayNames(scope, built.items.map((row) => row.staffProfileId));
  return mapPage(built, (row) => absenceItem(scope, row, names));
}

/** Alta de ausencia: ficha resuelta, tipo tasado, motivo y solicitante (= actor de la petición, nunca del cuerpo). */
async function createAbsence(scope: StoreScope, payload: unknown, id: string): Promise<BoardItem> {
  const data: AbsenceCreateInput = parse(AbsenceCreateSchema, payload, "body");
  const staff = await resolveStaff(scope, data);
  const row = await prisma.absenceRequest.create({
    data: {
      id,
      propertyId: scope.propertyId,
      staffProfileId: staff.staffProfileId,
      absenceType: data.absenceType,
      startDate: utcDayStart(dateOf(data.startDate)),
      endDate: utcDayStart(dateOf(data.endDate)),
      status: "pending",
      requestedBy: scope.userId,
      reason: data.reason ?? null
    },
    select: ABSENCE_SELECT
  });
  return absenceItem(scope, row, await staffDisplayNames(scope, [row.staffProfileId]));
}

/**
 * Decisión sobre una ausencia. Separación de funciones (diseño §9, CHECK
 * absence_requests_requested_ne_approved): quien la solicitó no la aprueba ni
 * la rechaza (409 APPROVAL_SELF_DECISION); sí puede cancelarla. Toda salida de
 * `pending` fija `decidedAt`; `approvedBy` solo en la aprobación.
 */
async function transitionAbsence(scope: StoreScope, id: string, routeStatus: string, payload: unknown): Promise<BoardItem> {
  const data = parse(AbsenceTransitionSchema, payload, "body");
  const row = await prisma.absenceRequest.findFirst({ where: { id, propertyId: scope.propertyId }, select: ABSENCE_SELECT });
  if (!row) throw new NotFoundError(RECORD_NOT_FOUND);
  const target = targetStatus("absence_request", row.status, routeStatus, data.status);
  if ((target === "approved" || target === "rejected") && row.requestedBy && row.requestedBy === scope.userId) {
    throw new ConflictError("Quien solicita no puede aprobar su propia solicitud.", { code: APPROVAL_SELF_DECISION_CODE, entityType: "absence_request", requestedBy: row.requestedBy });
  }
  const decided = target !== row.status && target !== "pending";
  const updated = await prisma.absenceRequest.update({
    where: { id: row.id },
    data: { status: target, ...(target === "approved" ? { approvedBy: scope.userId } : {}), ...(decided ? { decidedAt: new Date() } : {}) },
    select: ABSENCE_SELECT
  });
  return absenceItem(scope, updated, await staffDisplayNames(scope, [updated.staffProfileId]));
}

// ---------------------------------------------------------------------------
// safety_incident_management · SafetyIncident / IncidentEvidence / SafetyCheck / SafetyCheckResult
// ---------------------------------------------------------------------------

const INCIDENT_SELECT = {
  id: true,
  propertyId: true,
  incidentType: true,
  severity: true,
  status: true,
  title: true,
  description: true,
  locationEntityType: true,
  locationEntityId: true,
  guestId: true,
  reservationId: true,
  reportedBy: true,
  assignedTo: true,
  occurredAt: true,
  createdAt: true,
  resolvedAt: true
} satisfies Prisma.SafetyIncidentSelect;
type IncidentRow = Prisma.SafetyIncidentGetPayload<{ select: typeof INCIDENT_SELECT }>;

const CHECK_SELECT = {
  id: true,
  propertyId: true,
  checkType: true,
  title: true,
  frequency: true,
  locationEntityType: true,
  locationEntityId: true,
  assignedTo: true,
  nextDueDate: true,
  active: true,
  createdAt: true
} satisfies Prisma.SafetyCheckSelect;
type CheckRow = Prisma.SafetyCheckGetPayload<{ select: typeof CHECK_SELECT }>;

const CLOSED_STATUSES = new Set(["resolved", "closed"]);

function incidentItem(scope: StoreScope, row: IncidentRow): BoardItem {
  return boardItem(scope, "safety_incident", { id: row.id, createdAt: row.createdAt, updatedAt: row.resolvedAt }, row.status, {
    title: row.title,
    severity: row.severity,
    incidentType: row.incidentType,
    description: row.description,
    location: row.locationEntityType === "label" ? row.locationEntityId : undefined,
    locationEntityType: row.locationEntityType === "label" ? undefined : row.locationEntityType,
    locationEntityId: row.locationEntityType === "label" ? undefined : row.locationEntityId,
    guestId: row.guestId,
    reservationId: row.reservationId,
    reportedBy: row.reportedBy,
    assignedTo: row.assignedTo,
    occurredAt: iso(row.occurredAt),
    resolvedAt: iso(row.resolvedAt),
    status: row.status
  });
}

async function listIncidents(scope: StoreScope, page: NormalizedPage): Promise<Page<BoardItem>> {
  const where: Prisma.SafetyIncidentWhereInput = { propertyId: scope.propertyId, ...idFilter(scope) };
  const [rows, total] = await Promise.all([
    prisma.safetyIncident.findMany({ where: { ...where, ...afterCreatedAt(page.cursor) }, orderBy: NEWEST_FIRST, take: page.limit + 1, select: INCIDENT_SELECT }),
    prisma.safetyIncident.count({ where })
  ]);
  return mapPage(buildPage(rows, page.limit, total, createdAtKey), (row) => incidentItem(scope, row));
}

async function createIncident(scope: StoreScope, payload: unknown, id: string): Promise<BoardItem> {
  const data = parse(IncidentCreateSchema, payload, "body");
  const row = await prisma.safetyIncident.create({
    data: {
      id,
      propertyId: scope.propertyId,
      incidentType: data.incidentType ?? "other",
      severity: data.severity ?? "medium",
      status: "open",
      title: data.title,
      description: data.description ?? null,
      locationEntityType: data.location ? "label" : null,
      locationEntityId: data.location ?? null,
      guestId: data.guestId ?? null,
      reservationId: data.reservationId ?? null,
      reportedBy: scope.userId,
      assignedTo: data.assignedTo ?? null,
      occurredAt: data.occurredAt ? dateOf(data.occurredAt) : new Date()
    },
    select: INCIDENT_SELECT
  });
  return incidentItem(scope, row);
}

async function transitionIncident(scope: StoreScope, id: string, routeStatus: string, payload: unknown): Promise<BoardItem> {
  const data = parse(IncidentUpdateSchema, payload, "body");
  const row = await prisma.safetyIncident.findFirst({ where: { id, propertyId: scope.propertyId }, select: INCIDENT_SELECT });
  if (!row) throw new NotFoundError(RECORD_NOT_FOUND);
  const target = targetStatus("safety_incident", row.status, routeStatus, data.status);
  const closing = CLOSED_STATUSES.has(target);
  const updated = await prisma.safetyIncident.update({
    where: { id: row.id },
    data: {
      status: target,
      ...(data.severity ? { severity: data.severity } : {}),
      ...(data.title ? { title: data.title } : {}),
      ...(data.description ? { description: data.description } : {}),
      ...(data.assignedTo ? { assignedTo: data.assignedTo } : {}),
      resolvedAt: closing ? dateOf(data.resolvedAt ?? data.handledAt ?? new Date().toISOString()) : target === "open" ? null : row.resolvedAt
    },
    select: INCIDENT_SELECT
  });
  return incidentItem(scope, updated);
}

async function createEvidence(scope: StoreScope, payload: unknown, id: string): Promise<BoardItem> {
  const data = parse(EvidenceCreateSchema, payload, "body");
  await assertParentInProperty("safetyIncident", data.incidentId, scope.propertyId);
  const row = await prisma.incidentEvidence.create({
    data: { id, incidentId: data.incidentId, evidenceType: data.evidenceType ?? "note", objectKey: data.objectKey ?? null, notes: data.notes ?? null, createdBy: scope.userId },
    select: { id: true, incidentId: true, evidenceType: true, objectKey: true, notes: true, createdBy: true, createdAt: true }
  });
  return boardItem(scope, "incident_evidence", row, "attached", {
    incidentId: row.incidentId,
    evidenceType: row.evidenceType,
    objectKey: row.objectKey,
    notes: row.notes,
    createdBy: row.createdBy
  });
}

function checkItem(scope: StoreScope, row: CheckRow): BoardItem {
  return boardItem(scope, "safety_check", row, row.active ? "active" : "inactive", {
    title: row.title,
    name: row.title,
    checkType: row.checkType,
    frequency: row.frequency,
    location: row.locationEntityType === "label" ? row.locationEntityId : undefined,
    assignedTo: row.assignedTo,
    nextDueDate: iso(row.nextDueDate),
    active: row.active
  });
}

async function listSafetyChecks(scope: StoreScope, page: NormalizedPage): Promise<Page<BoardItem>> {
  const where: Prisma.SafetyCheckWhereInput = { propertyId: scope.propertyId, ...idFilter(scope) };
  const [rows, total] = await Promise.all([
    prisma.safetyCheck.findMany({ where: { ...where, ...afterCreatedAt(page.cursor) }, orderBy: NEWEST_FIRST, take: page.limit + 1, select: CHECK_SELECT }),
    prisma.safetyCheck.count({ where })
  ]);
  return mapPage(buildPage(rows, page.limit, total, createdAtKey), (row) => checkItem(scope, row));
}

async function createSafetyCheck(scope: StoreScope, payload: unknown, id: string): Promise<BoardItem> {
  const data = parse(SafetyCheckCreateSchema, payload, "body");
  const row = await prisma.safetyCheck.create({
    data: {
      id,
      propertyId: scope.propertyId,
      checkType: data.checkType ?? "general",
      title: (data.title ?? data.name) as string,
      frequency: data.frequency ?? null,
      locationEntityType: data.location ? "label" : null,
      locationEntityId: data.location ?? null,
      assignedTo: data.assignedTo ?? null,
      nextDueDate: data.nextDueDate ? dateOf(data.nextDueDate) : null,
      active: data.active ?? true
    },
    select: CHECK_SELECT
  });
  return checkItem(scope, row);
}

async function createCheckResult(scope: StoreScope, payload: unknown, id: string): Promise<BoardItem> {
  const data = parse(SafetyCheckResultCreateSchema, payload, "body");
  await assertParentInProperty("safetyCheck", data.safetyCheckId, scope.propertyId);
  const row = await prisma.safetyCheckResult.create({
    data: { id, safetyCheckId: data.safetyCheckId, status: data.status, notes: data.notes ?? null, completedBy: scope.userId, completedAt: data.completedAt ? dateOf(data.completedAt) : new Date() },
    select: { id: true, safetyCheckId: true, status: true, notes: true, completedBy: true, completedAt: true }
  });
  return boardItem(scope, "safety_check_result", { id: row.id, createdAt: row.completedAt }, row.status, {
    safetyCheckId: row.safetyCheckId,
    status: row.status,
    notes: row.notes,
    completedBy: row.completedBy,
    completedAt: row.completedAt.toISOString()
  });
}

// ---------------------------------------------------------------------------
// reputation_quality · QualityCase / Survey / SurveyResponse / GuestReview
// ---------------------------------------------------------------------------

const QUALITY_SELECT = {
  id: true,
  propertyId: true,
  reservationId: true,
  guestId: true,
  roomId: true,
  caseType: true,
  priority: true,
  status: true,
  title: true,
  description: true,
  ownerUserId: true,
  slaTargetAt: true,
  rootCause: true,
  createdAt: true,
  resolvedAt: true
} satisfies Prisma.QualityCaseSelect;
type QualityRow = Prisma.QualityCaseGetPayload<{ select: typeof QUALITY_SELECT }>;

const SURVEY_SELECT = { id: true, propertyId: true, name: true, surveyType: true, questionsJson: true, active: true, createdAt: true } satisfies Prisma.SurveySelect;
type SurveyRow = Prisma.SurveyGetPayload<{ select: typeof SURVEY_SELECT }>;

const REVIEW_SELECT = {
  id: true,
  propertyId: true,
  reservationId: true,
  guestId: true,
  source: true,
  rating: true,
  title: true,
  body: true,
  language: true,
  sentiment: true,
  topicsJson: true,
  externalReference: true,
  receivedAt: true,
  respondedAt: true,
  responseBody: true,
  createdAt: true
} satisfies Prisma.GuestReviewSelect;
type ReviewRow = Prisma.GuestReviewGetPayload<{ select: typeof REVIEW_SELECT }>;

function qualityItem(scope: StoreScope, row: QualityRow): BoardItem {
  return boardItem(scope, "quality_case", { id: row.id, createdAt: row.createdAt, updatedAt: row.resolvedAt }, row.status, {
    title: row.title,
    caseType: row.caseType,
    priority: row.priority,
    description: row.description,
    rootCause: row.rootCause,
    reservationId: row.reservationId,
    guestId: row.guestId,
    roomId: row.roomId,
    ownerUserId: row.ownerUserId,
    slaTargetAt: iso(row.slaTargetAt),
    resolvedAt: iso(row.resolvedAt),
    status: row.status
  });
}

async function listQualityCases(scope: StoreScope, page: NormalizedPage): Promise<Page<BoardItem>> {
  const where: Prisma.QualityCaseWhereInput = { propertyId: scope.propertyId, ...idFilter(scope) };
  const [rows, total] = await Promise.all([
    prisma.qualityCase.findMany({ where: { ...where, ...afterCreatedAt(page.cursor) }, orderBy: NEWEST_FIRST, take: page.limit + 1, select: QUALITY_SELECT }),
    prisma.qualityCase.count({ where })
  ]);
  return mapPage(buildPage(rows, page.limit, total, createdAtKey), (row) => qualityItem(scope, row));
}

async function createQualityCase(scope: StoreScope, payload: unknown, id: string): Promise<BoardItem> {
  const data = parse(QualityCaseCreateSchema, payload, "body");
  const row = await prisma.qualityCase.create({
    data: {
      id,
      propertyId: scope.propertyId,
      reservationId: data.reservationId ?? null,
      guestId: data.guestId ?? null,
      roomId: data.roomId ?? null,
      caseType: data.caseType ?? "complaint",
      priority: data.priority ?? "normal",
      status: "open",
      title: data.title,
      description: data.description ?? null,
      ownerUserId: data.ownerUserId ?? scope.userId,
      slaTargetAt: data.slaTargetAt ? dateOf(data.slaTargetAt) : null,
      rootCause: data.rootCause ?? null
    },
    select: QUALITY_SELECT
  });
  return qualityItem(scope, row);
}

async function transitionQualityCase(scope: StoreScope, id: string, routeStatus: string, payload: unknown): Promise<BoardItem> {
  const data = parse(QualityCaseUpdateSchema, payload, "body");
  const row = await prisma.qualityCase.findFirst({ where: { id, propertyId: scope.propertyId }, select: QUALITY_SELECT });
  if (!row) throw new NotFoundError(RECORD_NOT_FOUND);
  const target = targetStatus("quality_case", row.status, routeStatus, data.status);
  const closing = CLOSED_STATUSES.has(target);
  const updated = await prisma.qualityCase.update({
    where: { id: row.id },
    data: {
      status: target,
      ...(data.priority ? { priority: data.priority } : {}),
      ...(data.title ? { title: data.title } : {}),
      ...(data.description ? { description: data.description } : {}),
      ...(data.rootCause ? { rootCause: data.rootCause } : {}),
      ...(data.ownerUserId ? { ownerUserId: data.ownerUserId } : {}),
      resolvedAt: closing ? dateOf(data.resolvedAt ?? new Date().toISOString()) : target === "open" ? null : row.resolvedAt
    },
    select: QUALITY_SELECT
  });
  return qualityItem(scope, updated);
}

function surveyItem(scope: StoreScope, row: SurveyRow): BoardItem {
  return boardItem(scope, "survey", row, row.active ? "active" : "archived", {
    name: row.name,
    surveyType: row.surveyType,
    questions: Array.isArray(row.questionsJson) ? row.questionsJson : [],
    active: row.active
  });
}

async function listSurveys(scope: StoreScope, page: NormalizedPage): Promise<Page<BoardItem>> {
  const where: Prisma.SurveyWhereInput = { propertyId: scope.propertyId, ...idFilter(scope) };
  const [rows, total] = await Promise.all([
    prisma.survey.findMany({ where: { ...where, ...afterCreatedAt(page.cursor) }, orderBy: NEWEST_FIRST, take: page.limit + 1, select: SURVEY_SELECT }),
    prisma.survey.count({ where })
  ]);
  return mapPage(buildPage(rows, page.limit, total, createdAtKey), (row) => surveyItem(scope, row));
}

async function createSurvey(scope: StoreScope, payload: unknown, id: string): Promise<BoardItem> {
  const data = parse(SurveyCreateSchema, payload, "body");
  const row = await prisma.survey.create({
    data: { id, propertyId: scope.propertyId, name: data.name, surveyType: data.surveyType ?? "post_stay", questionsJson: toJson(data.questions ?? []), active: data.active ?? true },
    select: SURVEY_SELECT
  });
  return surveyItem(scope, row);
}

async function createSurveyResponse(scope: StoreScope, payload: unknown, id: string): Promise<BoardItem> {
  const data = parse(SurveyResponseCreateSchema, payload, "body");
  await assertParentInProperty("survey", data.surveyId, scope.propertyId);
  const row = await prisma.surveyResponse.create({
    data: { id, surveyId: data.surveyId, reservationId: data.reservationId ?? null, guestId: data.guestId ?? null, responsesJson: toJson(data.answers ?? {}), score: data.score ?? null },
    select: { id: true, surveyId: true, reservationId: true, guestId: true, responsesJson: true, score: true, createdAt: true }
  });
  return boardItem(scope, "survey_response", row, "received", {
    surveyId: row.surveyId,
    reservationId: row.reservationId,
    guestId: row.guestId,
    answers: asObject(row.responsesJson),
    score: dec(row.score)
  });
}

function reviewItem(row: ReviewRow) {
  return {
    id: row.id,
    propertyId: row.propertyId,
    reservationId: row.reservationId,
    guestId: row.guestId,
    source: row.source,
    rating: dec(row.rating),
    title: row.title,
    body: row.body,
    language: row.language,
    sentiment: row.sentiment,
    topicsJson: asObject(row.topicsJson),
    externalReference: row.externalReference,
    receivedAt: isoOrNull(row.receivedAt),
    respondedAt: isoOrNull(row.respondedAt),
    responseBody: row.responseBody,
    status: row.respondedAt ? "responded" : "pending",
    createdAt: row.createdAt.toISOString()
  };
}

async function listGuestReviews(scope: StoreScope, page: NormalizedPage) {
  const where: Prisma.GuestReviewWhereInput = { propertyId: scope.propertyId, ...idFilter(scope) };
  const [rows, total] = await Promise.all([
    prisma.guestReview.findMany({ where: { ...where, ...afterCreatedAt(page.cursor) }, orderBy: NEWEST_FIRST, take: page.limit + 1, select: REVIEW_SELECT }),
    prisma.guestReview.count({ where })
  ]);
  return mapPage(buildPage(rows, page.limit, total, createdAtKey), reviewItem);
}

async function respondGuestReview(scope: StoreScope, id: string, routeStatus: string, payload: unknown) {
  const data = parse(GuestReviewRespondSchema, payload, "body");
  const row = await prisma.guestReview.findFirst({ where: { id, propertyId: scope.propertyId }, select: REVIEW_SELECT });
  if (!row) throw new NotFoundError(RECORD_NOT_FOUND);
  const target = routeStatus === "updated" ? "responded" : routeStatus;
  // Una reseña se responde una sola vez: la segunda respuesta es un 409 (no
  // vale la idempotencia «mismo estado» de la máquina), la edición no existe.
  if (row.respondedAt) throw new ConflictError("La reseña ya tiene respuesta.", { code: INVALID_TRANSITION_CODE, entityType: "guest_review", from: "responded", to: target, allowed: [] });
  assertTransitionAllowed("guest_review", "pending", target);
  // T8-L0 (reputación): la columna `status` acompaña a respondedAt para que coincida con la meta de topicsJson.
  const updated = await prisma.guestReview.update({ where: { id: row.id }, data: { responseBody: data.responseBody, respondedAt: new Date(), status: "responded" }, select: REVIEW_SELECT });
  return reviewItem(updated);
}

// ---------------------------------------------------------------------------
// guest_data_crm_loyalty · CrmSegment / CrmCampaign / LoyaltyProgram / LoyaltyMembership (ámbito organización)
// ---------------------------------------------------------------------------

const SEGMENT_SELECT = { id: true, organizationId: true, name: true, description: true, rulesJson: true, active: true, createdAt: true } satisfies Prisma.CrmSegmentSelect;
const CAMPAIGN_SELECT = { id: true, organizationId: true, name: true, campaignType: true, segmentId: true, channel: true, status: true, scheduleJson: true, contentJson: true, createdAt: true } satisfies Prisma.CrmCampaignSelect;
const PROGRAM_SELECT = { id: true, organizationId: true, name: true, configurationJson: true, active: true, createdAt: true } satisfies Prisma.LoyaltyProgramSelect;
const MEMBERSHIP_SELECT = { id: true, loyaltyProgramId: true, guestProfileId: true, tier: true, pointsBalance: true, status: true, joinedAt: true } satisfies Prisma.LoyaltyMembershipSelect;

const segmentItem = (row: Prisma.CrmSegmentGetPayload<{ select: typeof SEGMENT_SELECT }>) => ({
  id: row.id,
  organizationId: row.organizationId,
  name: row.name,
  description: row.description ?? undefined,
  rulesJson: asObject(row.rulesJson),
  active: row.active,
  createdAt: row.createdAt.toISOString()
});

const campaignItem = (row: Prisma.CrmCampaignGetPayload<{ select: typeof CAMPAIGN_SELECT }>) => ({
  id: row.id,
  organizationId: row.organizationId,
  name: row.name,
  campaignType: row.campaignType,
  segmentId: row.segmentId ?? undefined,
  channel: row.channel,
  status: row.status,
  scheduleJson: asObject(row.scheduleJson),
  contentJson: asObject(row.contentJson),
  createdAt: row.createdAt.toISOString()
});

const membershipItem = (row: Prisma.LoyaltyMembershipGetPayload<{ select: typeof MEMBERSHIP_SELECT }>) => ({
  id: row.id,
  loyaltyProgramId: row.loyaltyProgramId,
  guestProfileId: row.guestProfileId,
  tier: row.tier ?? undefined,
  pointsBalance: row.pointsBalance,
  status: row.status,
  joinedAt: row.joinedAt.toISOString()
});

async function listSegments(scope: StoreScope, page: NormalizedPage) {
  const where: Prisma.CrmSegmentWhereInput = { organizationId: scope.organizationId, ...idFilter(scope) };
  const [rows, total] = await Promise.all([
    prisma.crmSegment.findMany({ where: { ...where, ...afterCreatedAt(page.cursor) }, orderBy: NEWEST_FIRST, take: page.limit + 1, select: SEGMENT_SELECT }),
    prisma.crmSegment.count({ where })
  ]);
  return mapPage(buildPage(rows, page.limit, total, createdAtKey), segmentItem);
}

async function createSegment(scope: StoreScope, payload: unknown, id: string) {
  const data = parse(CrmSegmentCreateSchema, payload, "body");
  const row = await prisma.crmSegment.create({
    data: { id, organizationId: scope.organizationId, name: data.name, description: data.description ?? null, rulesJson: toJson(data.rulesJson), active: data.active ?? true },
    select: SEGMENT_SELECT
  });
  return segmentItem(row);
}

async function transitionSegment(scope: StoreScope, id: string, _routeStatus: string, payload: unknown) {
  const data = parse(CrmSegmentUpdateSchema, payload, "body");
  const row = await prisma.crmSegment.findFirst({ where: { id, organizationId: scope.organizationId }, select: { id: true } });
  if (!row) throw new NotFoundError(RECORD_NOT_FOUND);
  const updated = await prisma.crmSegment.update({
    where: { id: row.id },
    data: {
      ...(data.name ? { name: data.name } : {}),
      ...(data.description !== undefined ? { description: data.description } : {}),
      ...(data.rulesJson !== undefined ? { rulesJson: toJson(data.rulesJson) } : {}),
      ...(data.active !== undefined ? { active: data.active } : {})
    },
    select: SEGMENT_SELECT
  });
  return segmentItem(updated);
}

async function listCampaigns(scope: StoreScope, page: NormalizedPage) {
  const where: Prisma.CrmCampaignWhereInput = { organizationId: scope.organizationId, ...idFilter(scope) };
  const [rows, total] = await Promise.all([
    prisma.crmCampaign.findMany({ where: { ...where, ...afterCreatedAt(page.cursor) }, orderBy: NEWEST_FIRST, take: page.limit + 1, select: CAMPAIGN_SELECT }),
    prisma.crmCampaign.count({ where })
  ]);
  return mapPage(buildPage(rows, page.limit, total, createdAtKey), campaignItem);
}

/** El segmento de una campaña debe ser de la misma organización (404 opaco si no). */
async function assertSegmentInOrganization(scope: StoreScope, segmentId: string): Promise<void> {
  const segment = await prisma.crmSegment.findFirst({ where: { id: segmentId, organizationId: scope.organizationId }, select: { id: true } });
  if (!segment) throw new NotFoundError("Segmento no encontrado.");
}

async function createCampaign(scope: StoreScope, payload: unknown, id: string) {
  const data = parse(CrmCampaignCreateSchema, payload, "body");
  if (data.segmentId) await assertSegmentInOrganization(scope, data.segmentId);
  const row = await prisma.crmCampaign.create({
    data: {
      id,
      organizationId: scope.organizationId,
      name: data.name,
      campaignType: data.campaignType,
      segmentId: data.segmentId ?? null,
      channel: data.channel,
      status: "draft",
      scheduleJson: toJson(data.scheduleJson),
      contentJson: toJson({ ...(data.contentJson ?? {}), consentRequired: true })
    },
    select: CAMPAIGN_SELECT
  });
  return campaignItem(row);
}

async function transitionCampaign(scope: StoreScope, id: string, routeStatus: string, payload: unknown) {
  const data = parse(CrmCampaignUpdateSchema, payload, "body");
  const row = await prisma.crmCampaign.findFirst({ where: { id, organizationId: scope.organizationId }, select: CAMPAIGN_SELECT });
  if (!row) throw new NotFoundError(RECORD_NOT_FOUND);
  const target = targetStatus("crm_campaign", row.status, routeStatus, data.status);
  if (data.segmentId) await assertSegmentInOrganization(scope, data.segmentId);
  const updated = await prisma.crmCampaign.update({
    where: { id: row.id },
    data: {
      status: target,
      ...(data.name ? { name: data.name } : {}),
      ...(data.campaignType ? { campaignType: data.campaignType } : {}),
      ...(data.channel ? { channel: data.channel } : {}),
      ...(data.segmentId ? { segmentId: data.segmentId } : {}),
      ...(data.scheduleJson !== undefined ? { scheduleJson: toJson(data.scheduleJson) } : {}),
      ...(data.contentJson !== undefined ? { contentJson: toJson({ ...data.contentJson, consentRequired: true }) } : {})
    },
    select: CAMPAIGN_SELECT
  });
  return campaignItem(updated);
}

async function listLoyalty(scope: StoreScope, page: NormalizedPage) {
  const where: Prisma.LoyaltyProgramWhereInput = { organizationId: scope.organizationId, ...idFilter(scope) };
  const [rows, total] = await Promise.all([
    prisma.loyaltyProgram.findMany({ where: { ...where, ...afterCreatedAt(page.cursor) }, orderBy: NEWEST_FIRST, take: page.limit + 1, select: PROGRAM_SELECT }),
    prisma.loyaltyProgram.count({ where })
  ]);
  const built = buildPage(rows, page.limit, total, createdAtKey);
  const programIds = built.items.map((program) => program.id);
  const memberships =
    programIds.length === 0
      ? []
      : await prisma.loyaltyMembership.findMany({ where: { loyaltyProgramId: { in: programIds } }, orderBy: { joinedAt: "desc" }, select: MEMBERSHIP_SELECT });
  return mapPage(built, (program) => ({
    id: program.id,
    organizationId: program.organizationId,
    name: program.name,
    configurationJson: asObject(program.configurationJson),
    active: program.active,
    createdAt: program.createdAt.toISOString(),
    memberships: memberships.filter((membership) => membership.loyaltyProgramId === program.id).map(membershipItem)
  }));
}

async function createLoyaltyProgram(scope: StoreScope, payload: unknown, id: string) {
  const data = parse(LoyaltyProgramCreateSchema, payload, "body");
  const row = await prisma.loyaltyProgram.create({
    data: { id, organizationId: scope.organizationId, name: data.name, configurationJson: toJson(data.configurationJson), active: data.active ?? true },
    select: PROGRAM_SELECT
  });
  return { id: row.id, organizationId: row.organizationId, name: row.name, configurationJson: asObject(row.configurationJson), active: row.active, createdAt: row.createdAt.toISOString(), memberships: [] };
}

async function transitionMembership(scope: StoreScope, id: string, routeStatus: string, payload: unknown) {
  const data = parse(LoyaltyMembershipUpdateSchema, payload, "body");
  // Sin relación Prisma membresía → programa: la organización se resuelve en
  // dos pasos y una membresía de otra organización es un 404 opaco.
  const row = await prisma.loyaltyMembership.findUnique({ where: { id }, select: MEMBERSHIP_SELECT });
  const program = row ? await prisma.loyaltyProgram.findFirst({ where: { id: row.loyaltyProgramId, organizationId: scope.organizationId }, select: { id: true } }) : null;
  if (!row || !program) throw new NotFoundError(RECORD_NOT_FOUND);
  const target = targetStatus("loyalty_membership", row.status, routeStatus, data.status);
  const updated = await prisma.loyaltyMembership.update({
    where: { id: row.id },
    data: { status: target, ...(data.tier ? { tier: data.tier } : {}), ...(data.pointsBalance !== undefined ? { pointsBalance: data.pointsBalance } : {}) },
    select: MEMBERSHIP_SELECT
  });
  return membershipItem(updated);
}

// ---------------------------------------------------------------------------
// groups_events_sales · Event (calendario) / EventOrder (BEO)
// ---------------------------------------------------------------------------

const EVENT_SELECT = { id: true, propertyId: true, groupBookingId: true, eventSpaceId: true, name: true, eventType: true, startAt: true, endAt: true, status: true, setupJson: true, cateringJson: true, createdAt: true } satisfies Prisma.EventSelect;

async function listEvents(scope: StoreScope, page: NormalizedPage) {
  const where: Prisma.EventWhereInput = { propertyId: scope.propertyId, ...idFilter(scope) };
  const [rows, total] = await Promise.all([
    prisma.event.findMany({ where: { ...where, ...afterCreatedAt(page.cursor) }, orderBy: NEWEST_FIRST, take: page.limit + 1, select: EVENT_SELECT }),
    prisma.event.count({ where })
  ]);
  return mapPage(buildPage(rows, page.limit, total, createdAtKey), (row) => ({
    id: row.id,
    propertyId: row.propertyId,
    groupBookingId: row.groupBookingId ?? undefined,
    eventSpaceId: row.eventSpaceId ?? undefined,
    name: row.name,
    eventType: row.eventType ?? undefined,
    startAt: row.startAt.toISOString(),
    endAt: row.endAt.toISOString(),
    status: row.status,
    setupJson: asObject(row.setupJson),
    cateringJson: asObject(row.cateringJson),
    createdAt: row.createdAt.toISOString()
  }));
}

async function createEventOrder(scope: StoreScope, payload: unknown, id: string) {
  const data = parse(EventOrderCreateSchema, payload, "body");
  await assertParentInProperty("event", data.eventId, scope.propertyId);
  const row = await prisma.eventOrder.create({
    data: { id, eventId: data.eventId, orderType: data.orderType ?? "beo", contentJson: toJson({ ...(data.content ?? {}), notes: data.notes, requiresConfirmation: true }), status: "draft" },
    select: { id: true, eventId: true, orderType: true, contentJson: true, status: true, createdAt: true }
  });
  return { id: row.id, eventId: row.eventId, orderType: row.orderType, contentJson: asObject(row.contentJson), status: row.status, createdAt: row.createdAt.toISOString() };
}

// ---------------------------------------------------------------------------
// procurement_inventory · PurchaseOrder + PurchaseOrderLine (sin relación Prisma: líneas por lote)
// ---------------------------------------------------------------------------

const PO_SELECT = { id: true, propertyId: true, supplierId: true, status: true, total: true, approvedBy: true, orderedAt: true, promisedDate: true, receivedDate: true, receivedAt: true, createdAt: true } satisfies Prisma.PurchaseOrderSelect;
type PurchaseOrderRow = Prisma.PurchaseOrderGetPayload<{ select: typeof PO_SELECT }>;
const PO_LINE_SELECT = { id: true, purchaseOrderId: true, inventoryItemId: true, description: true, quantity: true, unitPrice: true, total: true } satisfies Prisma.PurchaseOrderLineSelect;
type PurchaseOrderLineRow = Prisma.PurchaseOrderLineGetPayload<{ select: typeof PO_LINE_SELECT }>;

export type PurchaseOrderItem = ReturnType<typeof purchaseOrderItem>;

function purchaseOrderItem(row: PurchaseOrderRow, lines: PurchaseOrderLineRow[], createdByUserId: string | null) {
  return {
    id: row.id,
    propertyId: row.propertyId,
    supplierId: row.supplierId,
    status: row.status,
    total: dec(row.total) ?? 0,
    createdByUserId,
    approvedBy: row.approvedBy,
    orderedAt: isoOrNull(row.orderedAt),
    promisedDate: isoOrNull(row.promisedDate),
    receivedDate: isoOrNull(row.receivedDate),
    receivedAt: isoOrNull(row.receivedAt),
    createdAt: row.createdAt.toISOString(),
    lines: lines
      .filter((line) => line.purchaseOrderId === row.id)
      .map((line) => ({ id: line.id, inventoryItemId: line.inventoryItemId, description: line.description, quantity: dec(line.quantity) ?? 0, unitPrice: dec(line.unitPrice) ?? 0, total: dec(line.total) ?? 0 }))
  };
}

/**
 * Autor (solicitante) de cada pedido: `purchase_orders` no tiene columna de
 * autor, así que la fuente durable es el evento de auditoría
 * `PurchaseOrderCreated` (actorUserId) de la misma organización y propiedad.
 * Una consulta por lote de ids; sin evento → autor desconocido (null).
 */
export async function findPurchaseOrderAuthors(scope: Pick<StoreScope, "organizationId" | "propertyId">, ids: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>(ids.map((id) => [id, null]));
  if (ids.length === 0) return out;
  const events = await prisma.auditEvent.findMany({
    where: { organizationId: scope.organizationId, propertyId: scope.propertyId, entityType: "purchase_order", action: "PurchaseOrderCreated", entityId: { in: ids } },
    orderBy: { createdAt: "asc" },
    select: { entityId: true, actorUserId: true }
  });
  for (const event of events) {
    if (event.entityId && out.get(event.entityId) === null) out.set(event.entityId, event.actorUserId ?? null);
  }
  return out;
}

/** Pedido de la propiedad para la puerta de SoD (404 opaco si no cuelga de ella). */
export async function getPurchaseOrderForGate(scope: Pick<StoreScope, "propertyId">, id: string): Promise<{ id: string; status: string; total: number }> {
  const row = await prisma.purchaseOrder.findFirst({ where: { id, propertyId: scope.propertyId }, select: { id: true, status: true, total: true } });
  if (!row) throw new NotFoundError(RECORD_NOT_FOUND);
  return { id: row.id, status: row.status, total: dec(row.total) ?? 0 };
}

async function listPurchaseOrders(scope: StoreScope, page: NormalizedPage) {
  const where: Prisma.PurchaseOrderWhereInput = { propertyId: scope.propertyId, ...idFilter(scope) };
  const [rows, total] = await Promise.all([
    prisma.purchaseOrder.findMany({ where: { ...where, ...afterCreatedAt(page.cursor) }, orderBy: NEWEST_FIRST, take: page.limit + 1, select: PO_SELECT }),
    prisma.purchaseOrder.count({ where })
  ]);
  const built = buildPage(rows, page.limit, total, createdAtKey);
  const ids = built.items.map((row) => row.id);
  const [lines, authors] = await Promise.all([
    ids.length === 0 ? Promise.resolve([] as PurchaseOrderLineRow[]) : prisma.purchaseOrderLine.findMany({ where: { purchaseOrderId: { in: ids } }, orderBy: { id: "asc" }, select: PO_LINE_SELECT }),
    findPurchaseOrderAuthors(scope, ids)
  ]);
  return mapPage(built, (row) => purchaseOrderItem(row, lines, authors.get(row.id) ?? null));
}

async function createPurchaseOrder(scope: StoreScope, payload: unknown, id: string) {
  const data = parse(PurchaseOrderCreateSchema, payload, "body");
  const lines = (data.lines ?? []).map((line) => ({
    id: createId("pol"),
    purchaseOrderId: id,
    inventoryItemId: line.inventoryItemId ?? null,
    description: line.description,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    total: Math.round(line.quantity * line.unitPrice * 100) / 100
  }));
  const total = data.total ?? Math.round(lines.reduce((sum, line) => sum + line.total, 0) * 100) / 100;
  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.purchaseOrder.create({
      data: { id, propertyId: scope.propertyId, supplierId: data.supplierId ?? null, status: "draft", total, promisedDate: data.promisedDate ? dateOf(data.promisedDate) : null },
      select: PO_SELECT
    });
    if (lines.length > 0) await tx.purchaseOrderLine.createMany({ data: lines });
    return created;
  });
  const storedLines = lines.length === 0 ? [] : await prisma.purchaseOrderLine.findMany({ where: { purchaseOrderId: id }, orderBy: { id: "asc" }, select: PO_LINE_SELECT });
  return purchaseOrderItem(row, storedLines, scope.userId);
}

async function transitionPurchaseOrder(scope: StoreScope, id: string, routeStatus: string, payload: unknown) {
  const data = parse(PurchaseOrderTransitionSchema, payload, "body");
  if (routeStatus !== "approved" && routeStatus !== "received" && routeStatus !== "cancelled") throw new BadRequestError("Transición de pedido no soportada.");
  const row = await prisma.purchaseOrder.findFirst({ where: { id, propertyId: scope.propertyId }, select: PO_SELECT });
  if (!row) throw new NotFoundError(RECORD_NOT_FOUND);
  targetStatus("purchase_order", row.status, routeStatus, undefined);
  const now = new Date();
  const updated = await prisma.purchaseOrder.update({
    where: { id: row.id },
    data: {
      status: routeStatus,
      ...(routeStatus === "approved" ? { approvedBy: scope.userId, orderedAt: now } : {}),
      ...(routeStatus === "received" ? { receivedAt: now, receivedDate: data.receivedDate ? utcDayStart(dateOf(data.receivedDate)) : utcDayStart(now) } : {})
    },
    select: PO_SELECT
  });
  const [lines, authors] = await Promise.all([
    prisma.purchaseOrderLine.findMany({ where: { purchaseOrderId: row.id }, orderBy: { id: "asc" }, select: PO_LINE_SELECT }),
    findPurchaseOrderAuthors(scope, [row.id])
  ]);
  return purchaseOrderItem(updated, lines, authors.get(row.id) ?? null);
}

// ---------------------------------------------------------------------------
// energy_sustainability · UtilityMeter / UtilityReading / SustainabilityAction
// ---------------------------------------------------------------------------

const METER_SELECT = { id: true, propertyId: true, meterType: true, name: true, buildingId: true, floorId: true, zoneId: true, unit: true, provider: true, active: true, createdAt: true } satisfies Prisma.UtilityMeterSelect;

const meterItem = (row: Prisma.UtilityMeterGetPayload<{ select: typeof METER_SELECT }>) => ({
  id: row.id,
  propertyId: row.propertyId,
  meterType: row.meterType,
  name: row.name,
  buildingId: row.buildingId,
  floorId: row.floorId,
  zoneId: row.zoneId,
  unit: row.unit,
  provider: row.provider,
  active: row.active,
  status: row.active ? "active" : "inactive",
  createdAt: row.createdAt.toISOString()
});

async function listMeters(scope: StoreScope, page: NormalizedPage) {
  const where: Prisma.UtilityMeterWhereInput = { propertyId: scope.propertyId, ...idFilter(scope) };
  const [rows, total] = await Promise.all([
    prisma.utilityMeter.findMany({ where: { ...where, ...afterCreatedAt(page.cursor) }, orderBy: NEWEST_FIRST, take: page.limit + 1, select: METER_SELECT }),
    prisma.utilityMeter.count({ where })
  ]);
  return mapPage(buildPage(rows, page.limit, total, createdAtKey), meterItem);
}

async function createMeter(scope: StoreScope, payload: unknown, id: string) {
  const data = parse(UtilityMeterCreateSchema, payload, "body");
  const row = await prisma.utilityMeter.create({
    data: {
      id,
      propertyId: scope.propertyId,
      meterType: data.meterType,
      name: data.name,
      buildingId: data.buildingId ?? null,
      floorId: data.floorId ?? null,
      zoneId: data.zoneId ?? null,
      unit: data.unit,
      provider: data.provider ?? null,
      active: data.active ?? true
    },
    select: METER_SELECT
  });
  return meterItem(row);
}

async function createReading(scope: StoreScope, payload: unknown, id: string) {
  const data = parse(UtilityReadingCreateSchema, payload, "body");
  await assertParentInProperty("utilityMeter", data.meterId, scope.propertyId);
  const row = await prisma.utilityReading.create({
    data: { id, propertyId: scope.propertyId, meterId: data.meterId, readingDate: dateOf(data.readingDate), value: data.value, source: data.source ?? "manual" },
    select: { id: true, propertyId: true, meterId: true, readingDate: true, value: true, source: true, createdAt: true }
  });
  return { id: row.id, propertyId: row.propertyId, meterId: row.meterId, readingDate: row.readingDate.toISOString(), value: dec(row.value) ?? 0, source: row.source, createdAt: row.createdAt.toISOString() };
}

async function createSustainabilityAction(scope: StoreScope, payload: unknown, id: string) {
  const data = parse(SustainabilityActionCreateSchema, payload, "body");
  const row = await prisma.sustainabilityAction.create({
    data: {
      id,
      propertyId: scope.propertyId,
      title: data.title,
      description: data.description ?? null,
      category: data.category ?? null,
      status: data.status ?? "planned",
      estimatedCost: data.estimatedCost ?? null,
      estimatedSavings: data.estimatedSavings ?? null,
      linkedCapexProjectId: data.linkedCapexProjectId ?? null
    },
    select: { id: true, propertyId: true, title: true, description: true, category: true, status: true, estimatedCost: true, estimatedSavings: true, linkedCapexProjectId: true, createdAt: true }
  });
  return {
    id: row.id,
    propertyId: row.propertyId,
    title: row.title,
    description: row.description,
    category: row.category,
    status: row.status,
    estimatedCost: dec(row.estimatedCost),
    estimatedSavings: dec(row.estimatedSavings),
    linkedCapexProjectId: row.linkedCapexProjectId,
    createdAt: row.createdAt.toISOString()
  };
}

// ---------------------------------------------------------------------------
// hotel_intelligence_platform · MetricDefinition / AnomalyEvent / ScheduledReport (ámbito organización + propiedad)
// ---------------------------------------------------------------------------

const METRIC_SELECT = { id: true, organizationId: true, metricCode: true, name: true, description: true, formulaJson: true, category: true, active: true } satisfies Prisma.MetricDefinitionSelect;
const ANOMALY_SELECT = { id: true, organizationId: true, propertyId: true, anomalyType: true, metricCode: true, severity: true, title: true, description: true, detectedAt: true, status: true } satisfies Prisma.AnomalyEventSelect;
const REPORT_SELECT = { id: true, organizationId: true, propertyId: true, name: true, reportType: true, scheduleJson: true, recipientsJson: true, active: true, createdAt: true } satisfies Prisma.ScheduledReportSelect;

const metricItem = (row: Prisma.MetricDefinitionGetPayload<{ select: typeof METRIC_SELECT }>) => ({
  id: row.id,
  organizationId: row.organizationId,
  metricCode: row.metricCode,
  name: row.name,
  description: row.description,
  formulaJson: asObject(row.formulaJson),
  category: row.category,
  active: row.active,
  status: row.active ? "active" : "inactive"
});

const anomalyItem = (row: Prisma.AnomalyEventGetPayload<{ select: typeof ANOMALY_SELECT }>) => ({
  id: row.id,
  organizationId: row.organizationId,
  propertyId: row.propertyId,
  anomalyType: row.anomalyType,
  metricCode: row.metricCode,
  severity: row.severity,
  title: row.title,
  description: row.description,
  detectedAt: row.detectedAt.toISOString(),
  status: row.status
});

const reportItem = (row: Prisma.ScheduledReportGetPayload<{ select: typeof REPORT_SELECT }>) => ({
  id: row.id,
  organizationId: row.organizationId,
  propertyId: row.propertyId,
  name: row.name,
  reportType: row.reportType,
  scheduleJson: asObject(row.scheduleJson),
  recipients: Array.isArray(row.recipientsJson) ? row.recipientsJson : [],
  active: row.active,
  status: row.active ? "active" : "inactive",
  createdAt: row.createdAt.toISOString()
});

async function listMetrics(scope: StoreScope, page: NormalizedPage) {
  const where: Prisma.MetricDefinitionWhereInput = { organizationId: scope.organizationId, ...idFilter(scope) };
  const [rows, total] = await Promise.all([
    prisma.metricDefinition.findMany({ where: { ...where, ...afterMetricCode(page.cursor) }, orderBy: [{ metricCode: "asc" }, { id: "asc" }], take: page.limit + 1, select: METRIC_SELECT }),
    prisma.metricDefinition.count({ where })
  ]);
  return mapPage(
    buildPage(rows, page.limit, total, (row) => row.metricCode),
    metricItem
  );
}

async function createMetricDefinition(scope: StoreScope, payload: unknown, id: string) {
  const data = parse(MetricDefinitionCreateSchema, payload, "body");
  // (organizationId, metricCode) es único: un duplicado es el 409 P2002 del manejador global.
  const row = await prisma.metricDefinition.create({
    data: { id, organizationId: scope.organizationId, metricCode: data.metricCode, name: data.name, description: data.description ?? null, formulaJson: toJson(data.formulaJson), category: data.category ?? null, active: data.active ?? true },
    select: METRIC_SELECT
  });
  return metricItem(row);
}

async function listAnomalies(scope: StoreScope, page: NormalizedPage) {
  const where: Prisma.AnomalyEventWhereInput = { organizationId: scope.organizationId, ...orgOrProperty(scope), ...idFilter(scope) };
  const [rows, total] = await Promise.all([
    prisma.anomalyEvent.findMany({ where: { ...where, AND: [afterDetectedAt(page.cursor)] }, orderBy: [{ detectedAt: "desc" }, { id: "desc" }], take: page.limit + 1, select: ANOMALY_SELECT }),
    prisma.anomalyEvent.count({ where })
  ]);
  return mapPage(
    buildPage(rows, page.limit, total, (row) => row.detectedAt.toISOString()),
    anomalyItem
  );
}

async function transitionAnomaly(scope: StoreScope, id: string, routeStatus: string, payload: unknown) {
  const data = parse(AnomalyTransitionSchema, payload, "body");
  const row = await prisma.anomalyEvent.findFirst({ where: { id, organizationId: scope.organizationId, ...orgOrProperty(scope) }, select: ANOMALY_SELECT });
  if (!row) throw new NotFoundError(RECORD_NOT_FOUND);
  targetStatus("anomaly_event", row.status, routeStatus, data.status);
  const updated = await prisma.anomalyEvent.update({ where: { id: row.id }, data: { status: data.status }, select: ANOMALY_SELECT });
  return anomalyItem(updated);
}

async function listScheduledReports(scope: StoreScope, page: NormalizedPage) {
  const where: Prisma.ScheduledReportWhereInput = { organizationId: scope.organizationId, ...orgOrProperty(scope), ...idFilter(scope) };
  const [rows, total] = await Promise.all([
    prisma.scheduledReport.findMany({ where: { ...where, AND: [afterCreatedAt(page.cursor)] }, orderBy: NEWEST_FIRST, take: page.limit + 1, select: REPORT_SELECT }),
    prisma.scheduledReport.count({ where })
  ]);
  return mapPage(buildPage(rows, page.limit, total, createdAtKey), reportItem);
}

async function createScheduledReport(scope: StoreScope, payload: unknown, id: string) {
  const data = parse(ScheduledReportCreateSchema, payload, "body");
  const row = await prisma.scheduledReport.create({
    data: {
      id,
      organizationId: scope.organizationId,
      propertyId: scope.propertyId,
      name: data.name,
      reportType: data.reportType,
      scheduleJson: toJson(data.scheduleJson),
      recipientsJson: toJson(data.recipients ?? []),
      active: data.active ?? true
    },
    select: REPORT_SELECT
  });
  return reportItem(row);
}

// ---------------------------------------------------------------------------
// Despacho por clave `${moduleCode}:${recordType|entityType}`
// ---------------------------------------------------------------------------

type ListFn = (scope: StoreScope, page: NormalizedPage) => Promise<Page<unknown>>;
type CreateFn = (scope: StoreScope, payload: unknown, id: string) => Promise<unknown>;
type TransitionFn = (scope: StoreScope, id: string, routeStatus: string, payload: unknown) => Promise<unknown>;

const LISTS: Readonly<Record<string, ListFn>> = {
  "workforce_labor:schedule": listShifts,
  "workforce_labor:time_clock_entries": listTimeClock,
  "workforce_labor:absence_requests": listAbsences,
  "safety_incident_management:safety_incidents": listIncidents,
  "safety_incident_management:safety_checks": listSafetyChecks,
  "reputation_quality:quality_cases": listQualityCases,
  "reputation_quality:surveys": listSurveys,
  "reputation_quality:guest_reviews": listGuestReviews,
  "guest_data_crm_loyalty:crm_segments": listSegments,
  "guest_data_crm_loyalty:crm_campaigns": listCampaigns,
  "guest_data_crm_loyalty:loyalty": listLoyalty,
  "groups_events_sales:events_calendar": listEvents,
  "procurement_inventory:purchase_orders": listPurchaseOrders,
  "energy_sustainability:utility_meters": listMeters,
  "hotel_intelligence_platform:metrics": listMetrics,
  "hotel_intelligence_platform:anomalies": listAnomalies,
  "hotel_intelligence_platform:scheduled_reports": listScheduledReports
};

const CREATES: Readonly<Record<string, CreateFn>> = {
  "workforce_labor:shift": createShift,
  "workforce_labor:time_clock_entry": createTimeClock,
  "workforce_labor:absence_request": createAbsence,
  "safety_incident_management:safety_incident": createIncident,
  "safety_incident_management:incident_evidence": createEvidence,
  "safety_incident_management:safety_check": createSafetyCheck,
  "safety_incident_management:safety_check_result": createCheckResult,
  "reputation_quality:quality_case": createQualityCase,
  "reputation_quality:survey": createSurvey,
  "reputation_quality:survey_response": createSurveyResponse,
  "guest_data_crm_loyalty:crm_segment": createSegment,
  "guest_data_crm_loyalty:crm_campaign": createCampaign,
  "guest_data_crm_loyalty:loyalty_program": createLoyaltyProgram,
  "groups_events_sales:event_order": createEventOrder,
  "procurement_inventory:purchase_order": createPurchaseOrder,
  "energy_sustainability:utility_meter": createMeter,
  "energy_sustainability:utility_reading": createReading,
  "energy_sustainability:sustainability_action": createSustainabilityAction,
  "hotel_intelligence_platform:metric_definition": createMetricDefinition,
  "hotel_intelligence_platform:scheduled_report": createScheduledReport
};

const TRANSITIONS: Readonly<Record<string, TransitionFn>> = {
  "workforce_labor:shift": transitionShift,
  "workforce_labor:absence_request": transitionAbsence,
  "safety_incident_management:safety_incident": transitionIncident,
  "reputation_quality:quality_case": transitionQualityCase,
  "reputation_quality:guest_review": respondGuestReview,
  "guest_data_crm_loyalty:crm_segment": transitionSegment,
  "guest_data_crm_loyalty:crm_campaign": transitionCampaign,
  "guest_data_crm_loyalty:loyalty_membership": transitionMembership,
  "procurement_inventory:purchase_order": transitionPurchaseOrder,
  "hotel_intelligence_platform:anomaly_event": transitionAnomaly
};

const handlerOf = <T>(table: Readonly<Record<string, T>>, key: string): T => {
  const handler = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
  if (!handler) throw new BadRequestError(UNSUPPORTED_RECORD_TYPE_MESSAGE);
  return handler;
};

export const supportsList = (key: string): boolean => Object.prototype.hasOwnProperty.call(LISTS, key);
export const supportsCreate = (key: string): boolean => Object.prototype.hasOwnProperty.call(CREATES, key);
export const supportsTransition = (key: string): boolean => Object.prototype.hasOwnProperty.call(TRANSITIONS, key);

/** Página de registros del tipo de lista `key` en el ámbito (400 si el tipo no existe). */
export function listRecords(key: string, scope: StoreScope, page: NormalizedPage): Promise<Page<unknown>> {
  return handlerOf(LISTS, key)(scope, page);
}

/** Un registro por id dentro del ámbito, mediante la misma consulta de lista (404 opaco). */
export async function getRecord(key: string, scope: StoreScope, id: string): Promise<unknown> {
  const page = await handlerOf(LISTS, key)({ ...scope, onlyId: id }, { limit: 1, cursor: null });
  const record = page.items[0];
  if (record === undefined) throw new NotFoundError(RECORD_NOT_FOUND);
  return record;
}

/** Valida el cuerpo con el esquema del tipo y persiste la fila con el id dado. */
export function createRecord(key: string, scope: StoreScope, payload: unknown, id: string): Promise<unknown> {
  return handlerOf(CREATES, key)(scope, payload, id);
}

/** Valida el cuerpo, comprueba la máquina de estados y aplica la transición sobre la fila del ámbito. */
export function transitionRecord(key: string, scope: StoreScope, id: string, routeStatus: string, payload: unknown): Promise<unknown> {
  return handlerOf(TRANSITIONS, key)(scope, id, routeStatus, payload);
}
