// Importación masiva de reservas (Tanda 7 · L2) — servicio: previsualización,
// commit fila a fila, lote (`ReservationImport`), deshacer y lecturas.
//
// Un lote = un fichero (csv | xlsx) importado en UNA propiedad, identificado por
// el sha256 de sus filas normalizadas. Cada fila válida se convierte en reserva
// por el MISMO camino que una reserva de recepción (`createReservation`: lock
// por (propiedad, tipo), disponibilidad, código con reintento, huésped
// principal, folio, auditoría), nunca con `tx.reservation.create` directo; la
// habitación pedida se asigna con `assignRoom` y una fila «cancelada» pasa por
// `transitionReservation`. `bookingSource = "import:<importId>"` es la clave de
// pertenencia al lote y del deshacer.
//
// Orden de `importReservations` (diseño §6.1; cada guarda falla antes de escribir):
//   1. permisos (`pms.reservation.create` + `pms.reservation.modify`) → 403; tenencia → 404 opaco;
//   2. `analyse({ strict: true })` — el MISMO análisis que la preview: parseo → 400
//      (UNREADABLE / TOO_LARGE / TOO_MANY_ROWS / EMPTY), mapeo → 400
//      (MAPPING_INCOMPLETE / MAPPING_CONFLICT), catálogos de la propiedad en pocas
//      consultas, normalización pura (L1), duplicados contra la BD (referencia,
//      huésped, heurística), habitación (`canAssignRoom`), permisos por fila,
//      cotización (`quoteReservationTotal`) y disponibilidad (`planAvailability`,
//      regla de rango del PMS); errores de fila sin `omitirInvalidas` → 400
//      RESERVATION_IMPORT_INVALID; 0 a crear → 400 RESERVATION_IMPORT_EMPTY;
//   3. transacción CORTA bajo `pg_advisory_xact_lock('reservation_import:<propertyId>')`:
//      mismo hash en un lote no deshecho ni fallido → 409 RESERVATION_IMPORT_DUPLICATE
//      salvo `force`; alta del lote en `processing` (el id existe ANTES de la primera reserva);
//   4. bucle ESTRICTAMENTE secuencial por fila (el lock por tipo y el código de
//      reserva serializan igual): `resolveGuest` → `createReservation` → `assignRoom`
//      → `transitionReservation` (cancelada); cada fila en su try/catch
//      (`sanitizeRowError`: 409 de disponibilidad → NO_AVAILABILITY,
//      RESERVATION_CODE_CONFLICT → CODE_CONFLICT, HttpError → CREATE_FAILED con el
//      mensaje del servicio, Prisma → `describePrismaError`, otro → mensaje neutro);
//      filas persistidas por bloques de 100 SIN datos personales;
//   5. cierre: contadores, rango de llegadas, Σ importes, `durationMs`, estado
//      `imported | partial | failed` (`deriveImportStatus`); si el proceso muere el
//      lote queda `processing` («Interrumpida») y sigue siendo deshacible;
//   6. auditoría RESERVATION_IMPORT_COMMITTED fuera de la transacción.
//
// Deshacer (`undoReservationImport`): reclamación atómica (`updateMany` con
// ventana de 15 min → 409 RESERVATION_IMPORT_UNDO_IN_PROGRESS), reservas por
// `bookingSource` (no por las filas persistidas: un corte a medias no deja
// reservas sin deshacer), draft | confirmed → cancelada (motivo «Importación
// deshecha (lote …)»), checked_in | checked_out (históricas incluidas) → kept,
// cancelled | no_show → skipped; idempotente (`alreadyUndone`).
//
// GDPR: el fichero nunca se persiste; la fila del lote guarda nº de fila,
// referencia, fechas, tipo/tarifa, unidades, código de reserva o código de error;
// todo mensaje pasa por `stripRowValues`. Sin correos: nunca se rellena `bookerEmail`.

import { prisma } from "@hotelos/database";
import { Prisma } from "@prisma/client";
import {
  RESERVATION_IMPORT_BOOKING_SOURCE_PREFIX,
  RESERVATION_IMPORT_DEFAULT_SAMPLE_SIZE,
  RESERVATION_IMPORT_ERROR_LABELS_ES,
  RESERVATION_IMPORT_LABELS_ES,
  RESERVATION_IMPORT_LIST_DEFAULT_LIMIT,
  RESERVATION_IMPORT_LIST_MAX_LIMIT,
  RESERVATION_IMPORT_MAX_ERROR_MESSAGE,
  RESERVATION_IMPORT_MAX_SAMPLE_SIZE,
  RESERVATION_IMPORT_MAX_UNDO_REASON,
  RESERVATION_IMPORT_ROW_BATCH_SIZE,
  RESERVATION_IMPORT_ROW_CODE_SEVERITY,
  RESERVATION_IMPORT_UNDO_CLAIM_MINUTES,
  RESERVATION_IMPORT_UNDO_DEFAULT_REASON,
  type IsoDate,
  type MoneyString,
  type NormalizedReservationRow,
  type ReservationImportAvailability,
  type ReservationImportBlocker,
  type ReservationImportCatalog,
  type ReservationImportDetail,
  type ReservationImportDuplicateRef,
  type ReservationImportDuplicates,
  type ReservationImportEncoding,
  type ReservationImportErrorCode,
  type ReservationImportField,
  type ReservationImportFormat,
  type ReservationImportGuestFields,
  type ReservationImportGuestReuse,
  type ReservationImportIssue,
  type ReservationImportListQuery,
  type ReservationImportMapping,
  type ReservationImportMappingSource,
  type ReservationImportOptions,
  type ReservationImportPreview,
  type ReservationImportPreviewBody,
  type ReservationImportPreviewRow,
  type ReservationImportRecord,
  type ReservationImportResult,
  type ReservationImportRowAvailability,
  type ReservationImportRowCode,
  type ReservationImportRowOutcome,
  type ReservationImportRowRecord,
  type ReservationImportRowResolved,
  type ReservationImportSource,
  type ReservationImportStatus,
  type ReservationImportStoredOptions,
  type ReservationImportSummary,
  type ReservationImportTotals,
  type ReservationImportUndoOutcome,
  type ReservationImportUndoResult
} from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError, ConflictError, HttpError, NotFoundError, describePrismaError } from "../../lib/http-error.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { getCurrentBusinessDate } from "../night-audit/night-audit.service.js";
import { canAssignRoom } from "./inventory.engine.js";
import { assertPropertyInOrg, assignRoom, createReservation, todayInTimezone, transitionReservation } from "./pms.service.js";
import { planAvailability, type AvailabilityInventory, type AvailabilityPlanRow } from "./reservation-import.availability.js";
import { applyMapping, foldValue } from "./reservation-import.mapping.js";
import {
  contentHashRowsOf,
  normalizeTable,
  personalValuesOf,
  reservationImportContentHash,
  resolvedOf,
  rowStatusFromIssues,
  stripRowValues,
  type NormalizedTableRow,
  type ReservationImportCatalogs
} from "./reservation-import.normalize.js";
import { ReservationImportParseError, parseReservationImportFile, type ParsedTable } from "./reservation-import.parser.js";
import { quoteReservationTotal } from "./room-charge.service.js";

// ---------------------------------------------------------------------------
// Constantes y tipos internos
// ---------------------------------------------------------------------------

const IMPORT_NOT_FOUND = "Importación de reservas no encontrada.";
const PREVIEW_RESERVATION_ID = "import-preview";
const LOG = "[reservation-import]";
const ZERO = new Prisma.Decimal(0);

type Db = Prisma.TransactionClient | typeof prisma;
type ImportRow = NonNullable<Awaited<ReturnType<typeof prisma.reservationImport.findUnique>>>;
type ImportRowRow = NonNullable<Awaited<ReturnType<typeof prisma.reservationImportRow.findFirst>>>;
type CreateReservationInput = Parameters<typeof createReservation>[0];

/** Catálogos de la propiedad ya cargados (normalización + planificador + DTO de la preview). */
type LoadedCatalogs = ReservationImportCatalogs & {
  timezone: string;
  inventory: AvailabilityInventory[];
  wire: ReservationImportCatalog;
};

/** Fila analizada: la fila normalizada de L1 más lo que solo la BD sabe. */
type AnalysedRow = NormalizedTableRow & {
  /** Valores personales de la fila (`personalValuesOf`): lo único que `stripRowValues` borra de un mensaje (T7-FUN-02). */
  personalValues: string[];
  /** Huésped existente hallado en la preview (documento > e-mail); el commit lo vuelve a resolver fila a fila. */
  guestId?: string;
  guestReuse: ReservationImportGuestReuse | null;
  availability?: ReservationImportRowAvailability;
};

type Analysis = {
  propertyId: string;
  format: ReservationImportFormat;
  fileName: string | null;
  contentHash: string;
  encoding: ReservationImportEncoding;
  delimiter?: string;
  sheetName?: string;
  header: string[];
  mapping: ReservationImportMapping;
  mappingSource: ReservationImportMappingSource;
  unmappedColumns: string[];
  missingRequired: ReservationImportField[];
  splitName: boolean;
  catalogs: LoadedCatalogs;
  rows: AnalysedRow[];
  summary: ReservationImportSummary;
  availability: ReservationImportAvailability;
  duplicates: ReservationImportDuplicates;
  totals: ReservationImportTotals;
  options: ReservationImportOptions;
  canImport: boolean;
  blockers: ReservationImportBlocker[];
  warnings: string[];
};

/** Resultado de una fila durante el commit (lo que se persiste, sin datos personales). */
type RowOutcome = {
  rowNumber: number;
  outcome: ReservationImportRowOutcome;
  resolved?: ReservationImportRowResolved;
  reservationId?: string;
  reservationCode?: string;
  errorCode?: ReservationImportRowCode;
  errorMessage?: string;
  warnings: ReservationImportIssue[];
  /** Importe de la reserva creada (Σ del lote). */
  totalAmount?: MoneyString;
};

// ---------------------------------------------------------------------------
// Errores tipados (forma de accounting.service.ts: `details.code` siempre)
// ---------------------------------------------------------------------------

/** 400 con `details.code`. */
export function importBadRequest(code: ReservationImportErrorCode, message: string, extra: Record<string, unknown> = {}): BadRequestError {
  const error = new BadRequestError(message);
  error.details = { ...extra, code };
  return error;
}

/** 409 con `details.code`. */
export function importConflict(code: ReservationImportErrorCode, message: string, extra: Record<string, unknown> = {}): ConflictError {
  return new ConflictError(message, { ...extra, code });
}

/** 404 opaco con `details.code` (nunca dice si el lote existe en otra propiedad u organización). */
export function importNotFound(code: ReservationImportErrorCode, message: string, extra: Record<string, unknown> = {}): NotFoundError {
  const error = new NotFoundError(message);
  error.details = { ...extra, code };
  return error;
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function isoDate(value: Date): IsoDate {
  return value.toISOString().slice(0, 10);
}

function dateOnly(iso: IsoDate): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function money(value: Prisma.Decimal | string | number | null | undefined): MoneyString {
  if (value === null || value === undefined) return "0.00";
  return new Prisma.Decimal(value).toFixed(2);
}

function label(field: ReservationImportField): string {
  return `«${RESERVATION_IMPORT_LABELS_ES[field]}»`;
}

function severityOf(code: ReservationImportRowCode): "error" | "skipped" | "warning" {
  return RESERVATION_IMPORT_ROW_CODE_SEVERITY[code];
}

function pushIssue(row: AnalysedRow, code: ReservationImportRowCode, text: string, column?: ReservationImportField, details?: Record<string, unknown>): void {
  if (row.issues.some((issue) => issue.code === code && issue.column === column)) return;
  const issue: ReservationImportIssue = { code, message: stripRowValues(`Fila ${row.rowNumber}: ${text}`, row.personalValues) };
  if (column) issue.column = column;
  if (details) issue.details = details;
  row.issues.push(issue);
}

function refreshStatus(row: AnalysedRow): void {
  row.status = rowStatusFromIssues(row.issues);
}

function isPlanned(row: AnalysedRow): row is AnalysedRow & { normalized: NormalizedReservationRow } {
  return row.normalized !== undefined && row.status !== "error" && row.status !== "skipped";
}

function clip(text: string, max = RESERVATION_IMPORT_MAX_ERROR_MESSAGE): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function unique(values: Iterable<string | undefined>): string[] {
  const out = new Set<string>();
  for (const value of values) if (value) out.add(value);
  return Array.from(out);
}

function optionsOf(body: ReservationImportPreviewBody): ReservationImportOptions {
  return {
    omitirInvalidas: body.omitirInvalidas === true,
    permitirOverbooking: body.permitirOverbooking === true,
    historico: body.historico === true,
    force: body.force === true
  };
}

function sampleSizeOf(body: ReservationImportPreviewBody): number {
  const raw = body.sampleSize;
  if (raw === undefined || !Number.isFinite(raw)) return RESERVATION_IMPORT_DEFAULT_SAMPLE_SIZE;
  return Math.min(Math.max(Math.trunc(raw), 1), RESERVATION_IMPORT_MAX_SAMPLE_SIZE);
}

function bookingSourceOf(importId: string): string {
  return `${RESERVATION_IMPORT_BOOKING_SOURCE_PREFIX}${importId}`;
}

async function lockProperty(tx: Prisma.TransactionClient, propertyId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`reservation_import:${propertyId}`}))`;
}

// ---------------------------------------------------------------------------
// Catálogos de la propiedad (pocas consultas, nunca por fila)
// ---------------------------------------------------------------------------

async function loadCatalogs(propertyId: string): Promise<LoadedCatalogs> {
  const property = await prisma.property.findUnique({ where: { id: propertyId }, select: { currency: true, timezone: true } });
  if (!property) throw new NotFoundError("Propiedad no encontrada.");
  const businessDate = await getCurrentBusinessDate(propertyId);
  // Frontera de «llegada pasada»: el hoy de la propiedad, como createReservation (T7-FUN-01).
  const today = todayInTimezone(property.timezone);
  const [roomTypes, roomCounts, ratePlans, rooms] = await Promise.all([
    prisma.roomType.findMany({
      where: { propertyId },
      select: { id: true, code: true, name: true, maxOccupancy: true, active: true },
      orderBy: [{ displayOrder: "asc" }, { code: "asc" }]
    }),
    // El cupo con la MISMA consulta que `createReservation` (vendibles y no bloqueadas).
    prisma.room.groupBy({
      by: ["roomTypeId"],
      where: { propertyId, sellable: true, maintenanceStatus: { not: "blocked" } },
      _count: { _all: true }
    }),
    prisma.ratePlan.findMany({
      where: { propertyId },
      select: { id: true, code: true, name: true, active: true, ratePlanType: true },
      orderBy: [{ code: "asc" }]
    }),
    prisma.room.findMany({ where: { propertyId }, select: { id: true, number: true, roomTypeId: true }, orderBy: [{ number: "asc" }] })
  ]);
  const totalByType = new Map(roomCounts.map((row) => [row.roomTypeId, row._count._all]));
  // Plan BAR activo con menor código (mismo criterio que `quoteNightlyRate`); si no hay tipo «bar», el código BAR activo.
  const defaultPlan =
    ratePlans.find((plan) => plan.active && plan.ratePlanType === "bar") ?? ratePlans.find((plan) => plan.active && plan.code.toUpperCase() === "BAR") ?? null;
  const inventory: AvailabilityInventory[] = roomTypes.map((type) => ({ roomTypeId: type.id, code: type.code, name: type.name, totalRooms: totalByType.get(type.id) ?? 0 }));
  return {
    roomTypes: roomTypes.map((type) => ({ id: type.id, code: type.code, name: type.name, maxOccupancy: type.maxOccupancy, active: type.active })),
    ratePlans: ratePlans.map((plan) => ({ id: plan.id, code: plan.code, name: plan.name, active: plan.active })),
    rooms: rooms.map((room) => ({ id: room.id, number: room.number, roomTypeId: room.roomTypeId })),
    defaultRatePlanId: defaultPlan?.id ?? null,
    currency: property.currency || "EUR",
    businessDate,
    today,
    timezone: property.timezone,
    inventory,
    wire: {
      roomTypes: roomTypes.map((type) => ({ id: type.id, code: type.code, name: type.name, maxOccupancy: type.maxOccupancy, totalRooms: totalByType.get(type.id) ?? 0, active: type.active })),
      ratePlans: ratePlans.map((plan) => ({ id: plan.id, code: plan.code, name: plan.name, active: plan.active })),
      defaultRatePlanCode: defaultPlan?.code ?? null,
      currency: property.currency || "EUR"
    }
  };
}

// ---------------------------------------------------------------------------
// Duplicados contra la BD, huéspedes, habitación, permisos, estado y totales
// ---------------------------------------------------------------------------

/** Referencia externa ya presente en la propiedad: activa → omitida; solo cancelada / no-show → aviso. */
async function annotateReferences(rows: AnalysedRow[], propertyId: string): Promise<void> {
  const references = unique(rows.map((row) => row.normalized?.externalReference?.trim()));
  if (references.length === 0) return;
  // Sin distinguir mayúsculas, como el chequeo dentro del fichero: «bk-1» y «BK-1» son el mismo localizador (T7-FUN-04).
  const found = await prisma.reservation.findMany({
    where: { propertyId, deletedAt: null, externalReference: { in: references, mode: "insensitive" } },
    select: { code: true, status: true, externalReference: true },
    orderBy: [{ createdAt: "asc" }]
  });
  const active = new Map<string, string>();
  const inactive = new Map<string, string>();
  for (const reservation of found) {
    const key = (reservation.externalReference ?? "").trim().toLowerCase();
    if (reservation.status === "cancelled" || reservation.status === "no_show") {
      if (!inactive.has(key)) inactive.set(key, reservation.code);
    } else if (!active.has(key)) active.set(key, reservation.code);
  }
  for (const row of rows) {
    const reference = row.normalized?.externalReference?.trim();
    if (!reference || row.status === "skipped") continue;
    const key = reference.toLowerCase();
    const activeCode = active.get(key);
    if (activeCode) {
      pushIssue(row, "RESERVATION_IMPORT_ROW_DUPLICATE_REFERENCE", `${label("referencia_externa")} ya existe en la reserva ${activeCode}: se omite esta fila.`, "referencia_externa", { reservationCode: activeCode });
      continue;
    }
    const inactiveCode = inactive.get(key);
    if (inactiveCode) {
      pushIssue(row, "RESERVATION_IMPORT_ROW_REFERENCE_REUSED_CANCELLED", `${label("referencia_externa")} existía en la reserva cancelada o no-show ${inactiveCode}: se crea una reserva nueva.`, "referencia_externa", { reservationCode: inactiveCode });
    }
  }
}

function documentKey(value: string | null | undefined): string {
  return (value ?? "").toUpperCase().replace(/\s+/g, "");
}

/** Huésped existente de la organización por documento o e-mail (nunca por nombre); la ficha nunca se sobreescribe. */
async function annotateGuests(rows: AnalysedRow[], organizationId: string): Promise<void> {
  const documents = unique(rows.map((row) => row.normalized?.guest.documentNumber));
  const emails = unique(rows.map((row) => row.normalized?.guest.email));
  if (documents.length === 0 && emails.length === 0) return;
  const clauses: Prisma.GuestWhereInput[] = [];
  if (documents.length > 0) clauses.push({ documentNumber: { in: documents } });
  if (emails.length > 0) clauses.push({ email: { in: emails } });
  const found = await prisma.guest.findMany({
    where: { organizationId, deletedAt: null, OR: clauses },
    select: { id: true, documentNumber: true, email: true, surname1: true },
    orderBy: [{ createdAt: "asc" }]
  });
  const byDocument = new Map<string, { id: string; surname1: string | null }>();
  const byEmail = new Map<string, { id: string; surname1: string | null }>();
  for (const guest of found) {
    const document = documentKey(guest.documentNumber);
    if (document && !byDocument.has(document)) byDocument.set(document, guest);
    const email = (guest.email ?? "").trim().toLowerCase();
    if (email && !byEmail.has(email)) byEmail.set(email, guest);
  }
  for (const row of rows) {
    const guest = row.normalized?.guest;
    if (!guest) continue;
    const match = (guest.documentNumber && byDocument.get(documentKey(guest.documentNumber))) || null;
    const reuse: ReservationImportGuestReuse | null = match ? "document" : guest.email && byEmail.has(guest.email.toLowerCase()) ? "email" : null;
    const existing = match ?? (guest.email ? byEmail.get(guest.email.toLowerCase()) : undefined);
    if (!existing || !reuse) continue;
    row.guestId = existing.id;
    row.guestReuse = reuse;
    pushIssue(row, "RESERVATION_IMPORT_ROW_GUEST_REUSED", `huésped existente reutilizado por ${reuse === "document" ? "documento" : "e-mail"} (la ficha no se modifica).`, reuse === "document" ? "documento_numero" : "email", { reuse });
    if (foldValue(existing.surname1 ?? "") !== foldValue(guest.surname1)) {
      pushIssue(row, "RESERVATION_IMPORT_ROW_GUEST_NAME_MISMATCH", `${label("apellidos")} difiere del apellido de la ficha reutilizada: revisa la ficha del huésped.`, "apellidos");
    }
  }
}

/** Mismo huésped (ya existente) + misma llegada + mismo tipo en una reserva activa de la propiedad. */
async function annotatePossibleDuplicates(rows: AnalysedRow[], propertyId: string): Promise<void> {
  const candidates = rows.filter((row) => row.guestId && row.normalized);
  if (candidates.length === 0) return;
  const guestIds = unique(candidates.map((row) => row.guestId));
  const arrivals = unique(candidates.map((row) => row.normalized?.arrivalDate));
  const found = await prisma.reservation.findMany({
    where: {
      propertyId,
      deletedAt: null,
      status: { notIn: ["cancelled", "no_show"] },
      arrivalDate: { in: arrivals.map(dateOnly) },
      reservationGuests: { some: { guestId: { in: guestIds } } }
    },
    select: { code: true, arrivalDate: true, roomTypeId: true, reservationGuests: { select: { guestId: true } } }
  });
  const index = new Map<string, string>();
  for (const reservation of found) {
    for (const link of reservation.reservationGuests) {
      const key = `${link.guestId}|${isoDate(reservation.arrivalDate)}|${reservation.roomTypeId ?? ""}`;
      if (!index.has(key)) index.set(key, reservation.code);
    }
  }
  for (const row of candidates) {
    const code = index.get(`${row.guestId}|${row.normalized!.arrivalDate}|${row.normalized!.roomTypeId}`);
    if (code) pushIssue(row, "RESERVATION_IMPORT_ROW_POSSIBLE_DUPLICATE", `mismo huésped, llegada y tipo que la reserva ${code}: comprueba que no sea un duplicado.`, "nombre", { reservationCode: code });
  }
}

/** La habitación pedida debe estar libre en esas fechas (`canAssignRoom`, la misma comprobación de recepción). */
async function annotateRooms(rows: AnalysedRow[], propertyId: string): Promise<void> {
  for (const row of rows) {
    if (!isPlanned(row) || !row.normalized.roomId) continue;
    const validation = await canAssignRoom({
      propertyId,
      reservationId: PREVIEW_RESERVATION_ID,
      roomId: row.normalized.roomId,
      arrivalDate: row.normalized.arrivalDate,
      departureDate: row.normalized.departureDate
    });
    if (!validation.allowed) {
      pushIssue(row, "RESERVATION_IMPORT_ROW_ROOM_UNAVAILABLE", `${label("habitacion")} no disponible en esas fechas: ${validation.warnings.join(" ")} Déjala vacía y asígnala después.`, "habitacion");
      refreshStatus(row);
    }
  }
}

/** Defensa en profundidad: cancelar y asignar habitación exigen `pms.reservation.modify` (el manifiesto ya lo exige al importar). */
function annotatePermissions(rows: AnalysedRow[], context: UserContext): void {
  const canModify = context.permissions.includes("pms.reservation.modify");
  if (canModify) return;
  for (const row of rows) {
    if (!isPlanned(row) || row.normalized.historical) continue;
    if (row.normalized.estado === "cancelada" || row.normalized.roomId) {
      pushIssue(row, "RESERVATION_IMPORT_ROW_PERMISSION", "cancelar o asignar habitación exige el permiso pms.reservation.modify.", row.normalized.roomId ? "habitacion" : "estado");
      refreshStatus(row);
    }
  }
}

/** Avisos de estado: tentativa → confirmada con nota interna; cancelada → creada y cancelada en el mismo lote. */
function annotateEstado(rows: AnalysedRow[]): void {
  for (const row of rows) {
    if (!isPlanned(row) || row.normalized.historical) continue;
    if (row.normalized.estado === "tentativa") {
      pushIssue(row, "RESERVATION_IMPORT_ROW_TENTATIVE_AS_CONFIRMED", `${label("estado")} tentativa: se crea confirmada con la nota interna «confirmar con el cliente».`, "estado");
    } else if (row.normalized.estado === "cancelada") {
      pushIssue(row, "RESERVATION_IMPORT_ROW_CANCELLED_AT_IMPORT", `${label("estado")} cancelada: se crea y se cancela en el mismo lote.`, "estado");
    }
  }
}

/** Importe vacío → cotización con la tarifa (`quoteReservationTotal` × habitaciones); sin precio → 0 con aviso. */
async function annotateTotals(rows: AnalysedRow[], propertyId: string): Promise<void> {
  const quotes = new Map<string, Awaited<ReturnType<typeof quoteReservationTotal>>>();
  for (const row of rows) {
    if (!isPlanned(row) || row.normalized.totalSource !== "none") continue;
    const normalized = row.normalized;
    const key = `${normalized.roomTypeId}|${normalized.ratePlanId ?? ""}|${normalized.arrivalDate}|${normalized.departureDate}`;
    let quote = quotes.get(key);
    if (!quote) {
      quote = await quoteReservationTotal({ propertyId, roomTypeId: normalized.roomTypeId, ratePlanId: normalized.ratePlanId ?? null, arrivalDate: normalized.arrivalDate, departureDate: normalized.departureDate });
      quotes.set(key, quote);
    }
    if (quote.priceSource === "rate_plan") {
      normalized.totalAmount = money(new Prisma.Decimal(quote.total).mul(normalized.roomsCount));
      normalized.totalSource = "quoted";
      pushIssue(row, "RESERVATION_IMPORT_ROW_TOTAL_QUOTED", `${label("importe_total")} vacío: se cotiza con la tarifa (${normalized.nights} noches × ${normalized.roomsCount}).`, "importe_total", { total: normalized.totalAmount });
    } else {
      pushIssue(row, "RESERVATION_IMPORT_ROW_TOTAL_NOT_QUOTED", `${label("importe_total")} vacío y la tarifa no tiene precio para todas las noches: se guarda 0.`, "importe_total", { nightsWithoutRate: quote.nightsWithoutRate });
    }
    row.resolved = resolvedOf(normalized);
  }
}

/** Regla de rango del PMS sobre BD + filas anteriores (planificador puro) → error NO_AVAILABILITY o aviso OVERBOOKING. */
async function annotateAvailability(rows: AnalysedRow[], propertyId: string, catalogs: LoadedCatalogs, options: ReservationImportOptions): Promise<ReservationImportAvailability> {
  const planned = rows.filter((row): row is AnalysedRow & { normalized: NormalizedReservationRow } => isPlanned(row) && !row.normalized.historical);
  if (planned.length === 0) return { byRoomType: [], overbookingRows: [] };
  const typeIds = unique(planned.map((row) => row.normalized.roomTypeId));
  const minArrival = planned.map((row) => row.normalized.arrivalDate).sort()[0]!;
  const maxDeparture = planned.map((row) => row.normalized.departureDate).sort().at(-1)!;
  // Sin filtrar `deletedAt`: la misma consulta que `createReservation`.
  const existing = await prisma.reservation.findMany({
    where: {
      propertyId,
      roomTypeId: { in: typeIds },
      status: { in: ["confirmed", "checked_in"] },
      arrivalDate: { lt: dateOnly(maxDeparture) },
      departureDate: { gt: dateOnly(minArrival) }
    },
    select: { roomTypeId: true, arrivalDate: true, departureDate: true, roomsCount: true }
  });
  const plan = planAvailability({
    rows: planned.map(
      (row): AvailabilityPlanRow => ({
        rowNumber: row.rowNumber,
        roomTypeId: row.normalized.roomTypeId,
        arrivalDate: row.normalized.arrivalDate,
        departureDate: row.normalized.departureDate,
        roomsCount: row.normalized.roomsCount,
        estado: row.normalized.estado,
        historical: false
      })
    ),
    inventory: catalogs.inventory,
    existing: existing
      .filter((reservation): reservation is typeof reservation & { roomTypeId: string } => reservation.roomTypeId !== null)
      .map((reservation) => ({ roomTypeId: reservation.roomTypeId, arrivalDate: isoDate(reservation.arrivalDate), departureDate: isoDate(reservation.departureDate), roomsCount: reservation.roomsCount })),
    permitirOverbooking: options.permitirOverbooking
  });
  for (const row of planned) {
    const availability = plan.perRow.get(row.rowNumber);
    if (!availability) continue;
    row.availability = availability;
    if (!availability.exceeds) continue;
    const detail = `tipo ${row.normalized.roomTypeCode}: cupo ${availability.totalRooms}, ${availability.bookedDb} ya reservadas en la BD y ${availability.bookedFile} en filas anteriores del fichero, ${row.normalized.roomsCount} solicitadas`;
    if (options.permitirOverbooking) {
      pushIssue(row, "RESERVATION_IMPORT_ROW_OVERBOOKING", `se creará por encima del cupo (${detail}).`, "tipo_habitacion", { ...availability });
    } else {
      pushIssue(row, "RESERVATION_IMPORT_ROW_NO_AVAILABILITY", `sin disponibilidad según la regla de rango del PMS (${detail}): reduce, cambia fechas o tipo, o activa «permitir overbooking».`, "tipo_habitacion", { ...availability });
      refreshStatus(row);
    }
  }
  return { byRoomType: plan.byRoomType, overbookingRows: plan.overbookingRows };
}

// ---------------------------------------------------------------------------
// Análisis (parseo + mapeo + catálogos + BD): compartido por preview y commit
// ---------------------------------------------------------------------------

function duplicateRefOf(row: ImportRow): ReservationImportDuplicateRef {
  return { importId: row.id, createdAt: row.createdAt.toISOString(), status: row.status as ReservationImportStatus, fileName: row.fileName ?? null };
}

/** Lote vivo (ni deshecho ni fallido) con el mismo contenido en la propiedad. */
async function findLiveImport(db: Db, propertyId: string, contentHash: string): Promise<ImportRow | null> {
  return db.reservationImport.findFirst({ where: { propertyId, contentHash, status: { notIn: ["undone", "failed"] } }, orderBy: { createdAt: "desc" } });
}

function summarize(rows: readonly AnalysedRow[]): ReservationImportSummary {
  const summary: ReservationImportSummary = { valid: 0, warning: 0, error: 0, skipped: 0, historical: 0, toCreate: 0 };
  for (const row of rows) {
    summary[row.status] += 1;
    if (row.status === "valid" || row.status === "warning") {
      summary.toCreate += 1;
      if (row.normalized?.historical) summary.historical += 1;
    }
  }
  return summary;
}

function rowsWithCode(rows: readonly AnalysedRow[], code: ReservationImportRowCode): number[] {
  return rows.filter((row) => row.issues.some((issue) => issue.code === code)).map((row) => row.rowNumber);
}

function totalsOf(rows: readonly AnalysedRow[], currency: string): ReservationImportTotals {
  let fromFile: Prisma.Decimal = ZERO;
  let quoted: Prisma.Decimal = ZERO;
  for (const row of rows) {
    if (!isPlanned(row)) continue;
    if (row.normalized.totalSource === "file") fromFile = fromFile.plus(row.normalized.totalAmount);
    else if (row.normalized.totalSource === "quoted") quoted = quoted.plus(row.normalized.totalAmount);
  }
  return { fromFile: money(fromFile), quoted: money(quoted), currency };
}

function emptyAnalysis(base: Pick<Analysis, "propertyId" | "format" | "fileName" | "catalogs" | "options" | "blockers" | "warnings">): Analysis {
  return {
    ...base,
    contentHash: "",
    encoding: "utf-8",
    header: [],
    mapping: {},
    mappingSource: {},
    unmappedColumns: [],
    missingRequired: [],
    splitName: false,
    rows: [],
    summary: { valid: 0, warning: 0, error: 0, skipped: 0, historical: 0, toCreate: 0 },
    availability: { byRoomType: [], overbookingRows: [] },
    duplicates: { byReferenceRows: [], inFileRows: [], possibleRows: [], ofImport: null },
    totals: { fromFile: "0.00", quoted: "0.00", currency: base.catalogs.currency },
    canImport: false
  };
}

/**
 * Pipeline determinista compartido por `previewReservationImport` y
 * `importReservations`: con `strict` los impedimentos de fichero, mapeo, filas
 * inválidas, lote vacío y duplicado se lanzan como 400/409; sin `strict` se
 * devuelven como `blockers` con `canImport = false`. Nunca escribe (salvo la
 * fila `business_dates` que `getCurrentBusinessDate` crea si falta).
 */
export async function analyse(input: { context: UserContext; propertyId: string; body: ReservationImportPreviewBody; strict: boolean }): Promise<Analysis> {
  requirePermissions(input.context, ["pms.reservation.create"]);
  await assertPropertyInOrg(input.propertyId, input.context.organizationId);
  const { body, strict, propertyId } = input;
  const options = optionsOf(body);
  const fileName = body.fileName?.trim() || null;
  const blockers: ReservationImportBlocker[] = [];
  const warnings: string[] = [];
  const catalogs = await loadCatalogs(propertyId);

  let parsed: ParsedTable;
  try {
    parsed = parseReservationImportFile({ format: body.format, fileName: fileName ?? undefined, content: body.content, contentBase64: body.contentBase64, sheetName: body.sheetName });
  } catch (error) {
    if (!(error instanceof ReservationImportParseError)) throw error;
    if (strict) throw importBadRequest(error.code, error.message, error.details ?? {});
    blockers.push({ code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) });
    return emptyAnalysis({ propertyId, format: body.format ?? "csv", fileName, catalogs, options, blockers, warnings });
  }
  warnings.push(...parsed.warnings);

  const applied = applyMapping(parsed.header, body.mapping);
  warnings.push(...applied.warnings);
  if (applied.conflicts.length > 0) {
    const first = applied.conflicts[0]!;
    const details = { field: first.field, columns: first.columns, conflicts: applied.conflicts.map((conflict) => ({ field: conflict.field, columns: conflict.columns })) };
    if (strict) throw importBadRequest("RESERVATION_IMPORT_MAPPING_CONFLICT", first.message, details);
    blockers.push({ code: "RESERVATION_IMPORT_MAPPING_CONFLICT", message: first.message, details });
  }
  if (applied.missingRequired.length > 0) {
    const message = `Faltan columnas obligatorias por mapear: ${applied.missingRequired.map(label).join(", ")}.`;
    if (strict) throw importBadRequest("RESERVATION_IMPORT_MAPPING_INCOMPLETE", message, { missing: applied.missingRequired });
    blockers.push({ code: "RESERVATION_IMPORT_MAPPING_INCOMPLETE", message, details: { missing: applied.missingRequired } });
  }
  if (applied.unmappedColumns.length > 0) {
    warnings.push(`${applied.unmappedColumns.length} columna(s) del fichero sin mapear se ignoran: ${applied.unmappedColumns.map((column) => `«${column}»`).join(", ")}.`);
  }

  // Fecha de negocio por detrás del calendario (días sin cerrar): se avisa, pero la
  // frontera de «llegada pasada» es el hoy de la propiedad, no la fecha de negocio (T7-FUN-01).
  if (catalogs.businessDate < catalogs.today) {
    warnings.push(
      `La fecha de negocio de la propiedad (${catalogs.businessDate}) va por detrás del calendario (hoy ${catalogs.today}): hay días sin cerrar en la auditoría nocturna. Las llegadas anteriores a hoy se tratan como pasadas; ciérralos antes de importar si quieres que la auditoría procese esos días con las reservas nuevas.`
    );
  }

  const table = normalizeTable(parsed, body.mapping, catalogs, { historico: options.historico });
  const rows: AnalysedRow[] = table.rows.map((row) => ({ ...row, issues: [...row.issues], personalValues: personalValuesOf(row.cells, table.mappingByIndex), guestReuse: null }));

  await annotateReferences(rows, propertyId);
  for (const row of rows) refreshStatus(row);
  await annotateGuests(rows, input.context.organizationId);
  await annotatePossibleDuplicates(rows, propertyId);
  await annotateRooms(rows, propertyId);
  annotatePermissions(rows, input.context);
  annotateEstado(rows);
  await annotateTotals(rows, propertyId);
  const availability = await annotateAvailability(rows, propertyId, catalogs, options);
  for (const row of rows) refreshStatus(row);

  const summary = summarize(rows);
  // Hash sin frontera temporal ni opción «histórico» (T7-FUN-03): el mismo fichero es el mismo lote con cualquier opción.
  const contentHash = reservationImportContentHash(contentHashRowsOf(parsed, body.mapping, catalogs));
  const ofImport = rows.length > 0 ? await findLiveImport(prisma, propertyId, contentHash) : null;
  const duplicates: ReservationImportDuplicates = {
    byReferenceRows: rowsWithCode(rows, "RESERVATION_IMPORT_ROW_DUPLICATE_REFERENCE"),
    inFileRows: rowsWithCode(rows, "RESERVATION_IMPORT_ROW_DUPLICATE_IN_FILE"),
    possibleRows: rowsWithCode(rows, "RESERVATION_IMPORT_ROW_POSSIBLE_DUPLICATE"),
    ofImport: ofImport ? duplicateRefOf(ofImport) : null
  };

  if (strict) {
    if (summary.error > 0 && !options.omitirInvalidas) {
      const invalid = rows.filter((row) => row.status === "error");
      throw importBadRequest("RESERVATION_IMPORT_INVALID", `Hay ${summary.error} fila(s) con errores: corrígelas o activa «Omitir filas inválidas».`, {
        errorCount: summary.error,
        rows: invalid.slice(0, 50).map((row) => ({ rowNumber: row.rowNumber, code: row.issues.find((issue) => severityOf(issue.code) === "error")?.code ?? null }))
      });
    }
    if (summary.toCreate === 0) throw importBadRequest("RESERVATION_IMPORT_EMPTY", "No hay ninguna reserva que crear: todas las filas están omitidas o tienen errores.");
    if (ofImport && !options.force) {
      throw importConflict("RESERVATION_IMPORT_DUPLICATE", `Este fichero ya se importó (lote ${ofImport.id}): deshaz el lote anterior o activa «Importar de todos modos».`, duplicateRefOf(ofImport) as unknown as Record<string, unknown>);
    }
  } else {
    if (summary.error > 0 && !options.omitirInvalidas) {
      blockers.push({ code: "RESERVATION_IMPORT_INVALID", message: `Hay ${summary.error} fila(s) con errores: corrígelas o activa «Omitir filas inválidas».`, details: { errorCount: summary.error } });
    }
    if (rows.length > 0 && summary.toCreate === 0) {
      blockers.push({ code: "RESERVATION_IMPORT_EMPTY", message: RESERVATION_IMPORT_ERROR_LABELS_ES.RESERVATION_IMPORT_EMPTY });
    }
    if (ofImport && !options.force) {
      blockers.push({ code: "RESERVATION_IMPORT_DUPLICATE", message: `Este fichero ya se importó (lote ${ofImport.id}, ${duplicateRefOf(ofImport).createdAt.slice(0, 10)}): deshaz el lote anterior o activa «Importar de todos modos».`, details: duplicateRefOf(ofImport) as unknown as Record<string, unknown> });
    }
  }
  if (ofImport && options.force) warnings.push(`Este fichero ya se importó (lote ${ofImport.id}); con «Importar de todos modos» se creará un lote nuevo.`);

  const canImport = blockers.length === 0 && summary.toCreate > 0;
  return {
    propertyId,
    format: parsed.format,
    fileName,
    contentHash,
    encoding: parsed.encoding ?? "utf-8",
    ...(parsed.delimiter !== undefined ? { delimiter: parsed.delimiter } : {}),
    ...(parsed.sheetName !== undefined ? { sheetName: parsed.sheetName } : {}),
    header: parsed.header,
    mapping: applied.mapping,
    mappingSource: applied.mappingSource,
    unmappedColumns: applied.unmappedColumns,
    missingRequired: applied.missingRequired,
    splitName: applied.splitName,
    catalogs,
    rows,
    summary,
    availability,
    duplicates,
    totals: totalsOf(rows, catalogs.currency),
    options,
    canImport,
    blockers,
    warnings
  };
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

/** Tope por celda de la muestra cruda de la preview (FUX-04): un ejemplo, no el fichero. */
const PREVIEW_CELL_MAX_CHARS = 200;

function previewRowOf(row: AnalysedRow, withSample: boolean): ReservationImportPreviewRow {
  const out: ReservationImportPreviewRow = { rowNumber: row.rowNumber, line: row.line, status: row.status, issues: row.issues, guestReuse: row.guestReuse };
  if (row.resolved) out.resolved = row.resolved;
  if (withSample) {
    if (row.normalized) out.normalized = row.normalized;
    // Celdas crudas (mismo alcance que `normalized`: solo la muestra, nunca persistidas) para el ejemplo del mapeo.
    out.cells = row.cells.map((cell) => (cell.length > PREVIEW_CELL_MAX_CHARS ? `${cell.slice(0, PREVIEW_CELL_MAX_CHARS - 1)}…` : cell));
  }
  if (row.availability) out.availability = row.availability;
  return out;
}

function toPreview(analysis: Analysis, sampleSize: number): ReservationImportPreview {
  return {
    propertyId: analysis.propertyId,
    format: analysis.format,
    fileName: analysis.fileName,
    contentHash: analysis.contentHash,
    encoding: analysis.encoding,
    ...(analysis.delimiter !== undefined ? { delimiter: analysis.delimiter } : {}),
    ...(analysis.sheetName !== undefined ? { sheetName: analysis.sheetName } : {}),
    header: analysis.header,
    mapping: analysis.mapping,
    mappingSource: analysis.mappingSource,
    unmappedColumns: analysis.unmappedColumns,
    missingRequired: analysis.missingRequired,
    splitName: analysis.splitName,
    catalog: analysis.catalogs.wire,
    businessDate: analysis.catalogs.businessDate,
    today: analysis.catalogs.today,
    rowCount: analysis.rows.length,
    summary: analysis.summary,
    rows: analysis.rows.map((row, index) => previewRowOf(row, index < sampleSize)),
    sampleSize: Math.min(sampleSize, analysis.rows.length),
    availability: analysis.availability,
    duplicates: analysis.duplicates,
    totals: analysis.totals,
    options: analysis.options,
    canImport: analysis.canImport,
    blockers: analysis.blockers,
    warnings: analysis.warnings
  };
}

function formatOf(value: string): ReservationImportFormat {
  return value === "xlsx" ? "xlsx" : "csv";
}

function mappingOf(raw: Prisma.JsonValue): ReservationImportMapping {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: ReservationImportMapping = {};
  for (const [column, field] of Object.entries(raw as Record<string, unknown>)) {
    out[column] = typeof field === "string" ? (field as ReservationImportField) : null;
  }
  return out;
}

function storedOptionsOf(raw: Prisma.JsonValue): ReservationImportStoredOptions {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const bool = (key: string): boolean => value[key] === true;
  const text = (key: string): string | undefined => (typeof value[key] === "string" ? (value[key] as string) : undefined);
  const out: ReservationImportStoredOptions = {
    omitirInvalidas: bool("omitirInvalidas"),
    permitirOverbooking: bool("permitirOverbooking"),
    historico: bool("historico"),
    force: bool("force"),
    source: value.source === "cli" ? "cli" : "http"
  };
  const encoding = text("encoding");
  if (encoding === "utf-8" || encoding === "windows-1252") out.encoding = encoding;
  const delimiter = text("delimiter");
  if (delimiter !== undefined) out.delimiter = delimiter;
  const sheetName = text("sheetName");
  if (sheetName !== undefined) out.sheetName = sheetName;
  const duplicateOfImportId = text("duplicateOfImportId");
  if (duplicateOfImportId !== undefined) out.duplicateOfImportId = duplicateOfImportId;
  if (typeof value.durationMs === "number") out.durationMs = value.durationMs;
  return out;
}

function toImportRecord(row: ImportRow): ReservationImportRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    propertyId: row.propertyId,
    format: formatOf(row.format),
    fileName: row.fileName ?? null,
    contentHash: row.contentHash,
    status: row.status as ReservationImportStatus,
    rowCount: row.rowCount,
    createdCount: row.createdCount,
    skippedCount: row.skippedCount,
    errorCount: row.errorCount,
    warningCount: row.warningCount,
    mapping: mappingOf(row.mappingJson),
    options: storedOptionsOf(row.optionsJson),
    arrivalFrom: row.arrivalFrom ? isoDate(row.arrivalFrom) : null,
    arrivalTo: row.arrivalTo ? isoDate(row.arrivalTo) : null,
    totalAmount: money(row.totalAmount),
    currency: row.currency,
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt.toISOString(),
    undoneAt: row.undoneAt ? row.undoneAt.toISOString() : null,
    undoneBy: row.undoneBy ?? null,
    undoReason: row.undoReason ?? null,
    undoneCount: row.undoneCount,
    undoKeptCount: row.undoKeptCount
  };
}

function warningsOf(raw: Prisma.JsonValue): ReservationImportIssue[] {
  if (!Array.isArray(raw)) return [];
  const out: ReservationImportIssue[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const value = item as Record<string, unknown>;
    if (typeof value.code !== "string" || typeof value.message !== "string") continue;
    const issue: ReservationImportIssue = { code: value.code as ReservationImportRowCode, message: value.message };
    if (typeof value.column === "string") issue.column = value.column as ReservationImportField;
    if (value.details && typeof value.details === "object" && !Array.isArray(value.details)) issue.details = value.details as Record<string, unknown>;
    out.push(issue);
  }
  return out;
}

function toRowRecord(row: ImportRowRow): ReservationImportRowRecord {
  return {
    id: row.id,
    importId: row.importId,
    rowNumber: row.rowNumber,
    outcome: row.outcome as ReservationImportRowOutcome,
    externalReference: row.externalReference ?? null,
    arrivalDate: row.arrivalDate ? isoDate(row.arrivalDate) : null,
    departureDate: row.departureDate ? isoDate(row.departureDate) : null,
    roomTypeCode: row.roomTypeCode ?? null,
    ratePlanCode: row.ratePlanCode ?? null,
    roomsCount: row.roomsCount,
    reservationId: row.reservationId ?? null,
    reservationCode: row.reservationCode ?? null,
    errorCode: (row.errorCode as ReservationImportRowCode | null) ?? null,
    errorMessage: row.errorMessage ?? null,
    warnings: warningsOf(row.warningsJson),
    undoOutcome: (row.undoOutcome as ReservationImportUndoOutcome | null) ?? null
  };
}

async function loadImportOrThrow(db: Db, context: UserContext, propertyId: string, importId: string): Promise<ImportRow> {
  const row = await db.reservationImport.findFirst({ where: { id: importId, propertyId, organizationId: context.organizationId } });
  if (!row) throw importNotFound("RESERVATION_IMPORT_NOT_FOUND", IMPORT_NOT_FOUND);
  return row;
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/** `POST …/reservations/imports/preview`: nunca escribe; `normalized` solo en la muestra. */
export async function previewReservationImport(input: { context: UserContext; propertyId: string; body: ReservationImportPreviewBody }): Promise<ReservationImportPreview> {
  const analysis = await analyse({ context: input.context, propertyId: input.propertyId, body: input.body, strict: false });
  return toPreview(analysis, sampleSizeOf(input.body));
}

// ---------------------------------------------------------------------------
// Commit: helpers puros (exportados para los tests)
// ---------------------------------------------------------------------------

/** Estado final del lote a partir de los contadores. */
export function deriveImportStatus(counts: { createdCount: number; skippedCount: number; errorCount: number }): Extract<ReservationImportStatus, "imported" | "partial" | "failed"> {
  if (counts.createdCount === 0) return "failed";
  return counts.errorCount + counts.skippedCount > 0 ? "partial" : "imported";
}

/**
 * Traduce el error de una fila del commit a un código de fila y un mensaje en
 * español SIN valores del fichero (`stripRowValues`) ni texto de invocación de
 * Prisma. El mensaje NO lleva el prefijo «Fila n:» (lo añade quien persiste).
 */
export function sanitizeRowError(error: unknown, cells: readonly string[] = []): { code: ReservationImportRowCode; message: string } {
  const clean = (text: string): string => clip(stripRowValues(text, cells));
  if (error instanceof HttpError) {
    const details = (error.details && typeof error.details === "object" ? error.details : {}) as Record<string, unknown>;
    if (details.code === "RESERVATION_CODE_CONFLICT") {
      return { code: "RESERVATION_IMPORT_ROW_CODE_CONFLICT", message: clean("conflicto de código de reserva tras varios intentos: reimporta la fila.") };
    }
    if (error instanceof ConflictError && /disponibilidad/i.test(error.message)) {
      return { code: "RESERVATION_IMPORT_ROW_NO_AVAILABILITY", message: clean(error.message) };
    }
    return { code: "RESERVATION_IMPORT_ROW_CREATE_FAILED", message: clean(`el PMS rechazó la reserva: ${error.message}`) };
  }
  const prismaDescription = describePrismaError(error);
  if (prismaDescription) {
    return { code: "RESERVATION_IMPORT_ROW_CREATE_FAILED", message: clean(`el PMS rechazó la reserva: ${prismaDescription.message}`) };
  }
  if (error && typeof error === "object" && typeof (error as { statusCode?: unknown }).statusCode === "number" && error instanceof Error) {
    // Errores tipados de otras capas (p. ej. PermissionDeniedError 403 de @hotelos/shared).
    return { code: "RESERVATION_IMPORT_ROW_CREATE_FAILED", message: clean(`el PMS rechazó la reserva: ${error.message}`) };
  }
  return { code: "RESERVATION_IMPORT_ROW_CREATE_FAILED", message: "Error interno al crear la reserva." };
}

/**
 * Entrada de `createReservation` a partir de la fila normalizada (diseño §6.2):
 * `bookingSource import:<importId>`, `bookerName` «Nombre Apellidos», NUNCA
 * `bookerEmail` (evita la plantilla `reservation_confirmed` por cada fila),
 * `primaryGuestId` si el huésped ya existe o `primaryGuest` si se da de alta,
 * `historical` con `assignedRoomId` solo en filas históricas (las demás pasan
 * por `assignRoom`), `allowOverbooking` tal como lo decida quien llama (el
 * commit lo pasa siempre que la opción «permitir overbooking» esté activa).
 */
export function buildCreateReservationInput(input: {
  context: UserContext;
  propertyId: string;
  importId: string;
  row: NormalizedReservationRow;
  guestId?: string | null;
  allowOverbooking?: boolean;
  correlationId: string;
}): CreateReservationInput {
  const { row } = input;
  const surnames = [row.guest.surname1, row.guest.surname2].filter((value): value is string => Boolean(value)).join(" ");
  const out: CreateReservationInput = {
    context: input.context,
    propertyId: input.propertyId,
    roomTypeId: row.roomTypeId,
    arrivalDate: row.arrivalDate,
    departureDate: row.departureDate,
    adults: row.adults,
    children: row.children,
    infants: row.infants,
    roomsCount: row.roomsCount,
    channel: row.channel,
    totalAmount: Number(row.totalAmount),
    currency: row.currency,
    bookingSource: bookingSourceOf(input.importId),
    bookerName: `${row.guest.firstName} ${surnames}`.trim(),
    vipFlag: row.vipFlag,
    correlationId: input.correlationId
  };
  if (row.ratePlanId) out.ratePlanId = row.ratePlanId;
  if (row.boardType) out.boardType = row.boardType;
  if (row.marketSegment) out.marketSegment = row.marketSegment;
  if (row.sourceCode) out.sourceCode = row.sourceCode;
  if (row.externalReference) out.externalReference = row.externalReference;
  if (row.companyName) out.companyName = row.companyName;
  if (row.travelAgentName) out.travelAgentName = row.travelAgentName;
  if (row.groupCode) out.groupCode = row.groupCode;
  if (row.specialRequests) out.specialRequests = row.specialRequests;
  if (row.notes) out.notes = row.notes;
  if (row.estimatedArrivalTime) {
    out.estimatedArrivalTime = row.estimatedArrivalTime;
    out.eta = row.estimatedArrivalTime;
  }
  if (row.paymentMethod) out.paymentMethod = row.paymentMethod;
  if (row.depositAmount !== undefined) out.depositAmount = Number(row.depositAmount);
  if (row.estado === "tentativa" && !row.historical) {
    out.internalNotes = `Importada como tentativa: confirmar con el cliente (lote ${input.importId})`;
  }
  if (input.guestId) {
    out.primaryGuestId = input.guestId;
  } else {
    const guest: ReservationImportGuestFields = row.guest;
    out.primaryGuest = {
      firstName: guest.firstName,
      surname1: guest.surname1,
      ...(guest.surname2 ? { surname2: guest.surname2 } : {}),
      ...(guest.email ? { email: guest.email } : {}),
      ...(guest.phone ? { phone: guest.phone } : {}),
      ...(guest.nationality ? { nationality: guest.nationality } : {}),
      ...(guest.documentType ? { documentType: guest.documentType } : {}),
      ...(guest.documentNumber ? { documentNumber: guest.documentNumber } : {}),
      ...(row.companyName ? { company: row.companyName } : {})
    };
  }
  if (input.allowOverbooking) out.allowOverbooking = true;
  if (row.historical) {
    out.historical = true;
    if (row.roomId) out.assignedRoomId = row.roomId;
  }
  return out;
}

/**
 * Huésped existente de la organización: por documento y, si no, por e-mail;
 * NUNCA por nombre y NUNCA se actualiza la ficha. Sin coincidencia → null
 * (`createReservation` dará de alta el huésped con los datos del fichero). Un
 * e-mail repetido dentro del fichero reutiliza el huésped creado por la
 * primera fila porque el commit es secuencial.
 */
export async function resolveGuest(input: { organizationId: string; guest: ReservationImportGuestFields; db?: Db }): Promise<{ guestId: string; reuse: ReservationImportGuestReuse } | null> {
  const db = input.db ?? prisma;
  if (input.guest.documentNumber) {
    const byDocument = await db.guest.findFirst({
      where: { organizationId: input.organizationId, deletedAt: null, documentNumber: input.guest.documentNumber },
      select: { id: true },
      orderBy: [{ createdAt: "asc" }]
    });
    if (byDocument) return { guestId: byDocument.id, reuse: "document" };
  }
  if (input.guest.email) {
    const byEmail = await db.guest.findFirst({
      where: { organizationId: input.organizationId, deletedAt: null, email: input.guest.email },
      select: { id: true },
      orderBy: [{ createdAt: "asc" }]
    });
    if (byEmail) return { guestId: byEmail.id, reuse: "email" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

function rowData(importId: string, organizationId: string, propertyId: string, outcome: RowOutcome): Prisma.ReservationImportRowCreateManyInput {
  const resolved = outcome.resolved;
  return {
    importId,
    organizationId,
    propertyId,
    rowNumber: outcome.rowNumber,
    outcome: outcome.outcome,
    externalReference: resolved?.externalReference ?? null,
    arrivalDate: resolved ? dateOnly(resolved.arrivalDate) : null,
    departureDate: resolved ? dateOnly(resolved.departureDate) : null,
    roomTypeCode: resolved?.roomTypeCode ?? null,
    ratePlanCode: resolved?.ratePlanCode ?? null,
    roomsCount: resolved?.roomsCount ?? 1,
    reservationId: outcome.reservationId ?? null,
    reservationCode: outcome.reservationCode ?? null,
    errorCode: outcome.errorCode ?? null,
    errorMessage: outcome.errorMessage ? clip(outcome.errorMessage) : null,
    warningsJson: outcome.warnings as unknown as Prisma.InputJsonValue
  };
}

async function commitRow(params: { context: UserContext; propertyId: string; importId: string; row: AnalysedRow; options: ReservationImportOptions; correlationId: string }): Promise<RowOutcome> {
  const { row, importId, context, correlationId } = params;
  const n = row.rowNumber;
  const warnings = row.issues.filter((issue) => severityOf(issue.code) === "warning");
  const base: RowOutcome = { rowNumber: n, outcome: "skipped", warnings, ...(row.resolved ? { resolved: row.resolved } : {}) };

  if (row.status === "skipped") {
    const issue = row.issues.find((candidate) => severityOf(candidate.code) === "skipped")!;
    return { ...base, errorCode: issue.code, errorMessage: issue.message };
  }
  if (row.status === "error" || !row.normalized) {
    const first = row.issues.find((candidate) => severityOf(candidate.code) === "error") ?? row.issues[0];
    return {
      ...base,
      errorCode: "RESERVATION_IMPORT_ROW_INVALID_SKIPPED",
      errorMessage: stripRowValues(`Fila ${n}: omitida por «Omitir filas inválidas»${first ? ` (${first.code}: ${first.message.replace(/^Fila \d+: /, "")})` : "."}`, row.personalValues)
    };
  }

  const normalized = row.normalized;
  let created: Awaited<ReturnType<typeof createReservation>> | undefined;
  try {
    const guest = await resolveGuest({ organizationId: context.organizationId, guest: normalized.guest });
    created = await createReservation(
      buildCreateReservationInput({
        context,
        propertyId: params.propertyId,
        importId,
        row: normalized,
        guestId: guest?.guestId ?? null,
        // T7-FUN-07: con «permitir overbooking» la fila se crea aunque el cupo se haya
        // agotado entre el análisis y este momento (createReservation solo registra
        // `overbooking` en la auditoría cuando de verdad excede el cupo).
        allowOverbooking: params.options.permitirOverbooking,
        correlationId
      })
    );
    if (!normalized.historical && normalized.roomId) {
      try {
        await assignRoom({ context, reservationId: created.id, roomId: normalized.roomId, correlationId });
      } catch (error) {
        const sanitized = sanitizeRowError(error, row.personalValues);
        console.error(`${LOG} row ${n} of import ${importId}: room assignment failed (correlation ${correlationId}): ${sanitized.message}`);
        warnings.push({
          code: "RESERVATION_IMPORT_ROW_ROOM_ASSIGN_FAILED",
          message: stripRowValues(`Fila ${n}: la reserva ${created.code} se creó sin la habitación pedida (${sanitized.message}): asígnala desde recepción.`, row.personalValues),
          column: "habitacion"
        });
      }
    }
    if (!normalized.historical && normalized.estado === "cancelada") {
      await transitionReservation({ context, reservationId: created.id, status: "cancelled", reason: `Importada como cancelada (lote ${importId})`, correlationId });
    }
    return { ...base, outcome: "created", reservationId: created.id, reservationCode: created.code, totalAmount: normalized.totalAmount, warnings };
  } catch (error) {
    const sanitized = sanitizeRowError(error, row.personalValues);
    if (sanitized.code === "RESERVATION_IMPORT_ROW_CREATE_FAILED" && sanitized.message === "Error interno al crear la reserva.") {
      console.error(`${LOG} row ${n} of import ${importId} failed (correlation ${correlationId}):`, error);
    }
    const suffix = created ? ` La reserva ${created.code} quedó creada: revísala desde recepción.` : "";
    return {
      ...base,
      outcome: "error",
      errorCode: sanitized.code,
      errorMessage: stripRowValues(`Fila ${n}: ${sanitized.message}${suffix}`, row.personalValues),
      ...(created ? { reservationId: created.id, reservationCode: created.code } : {})
    };
  }
}

/**
 * `POST …/reservations/imports` (y `--apply` del CLI): analiza en modo estricto,
 * crea el lote bajo lock ANTES de la primera reserva y recorre las filas en
 * orden con `createReservation`. Devuelve el lote con sus filas (201 siempre que
 * el lote exista, incluso `failed`).
 */
export async function importReservations(input: {
  context: UserContext;
  propertyId: string;
  body: ReservationImportPreviewBody;
  createdBy?: string | null;
  correlationId: string;
  source?: ReservationImportSource;
}): Promise<ReservationImportResult> {
  requirePermissions(input.context, ["pms.reservation.create", "pms.reservation.modify"]);
  await assertPropertyInOrg(input.propertyId, input.context.organizationId);
  const startedAt = Date.now();
  const { context, propertyId, correlationId } = input;
  const analysis = await analyse({ context, propertyId, body: input.body, strict: true });
  const createdBy = input.createdBy === undefined ? context.userId : input.createdBy;
  const storedOptions: ReservationImportStoredOptions = {
    ...analysis.options,
    encoding: analysis.encoding,
    ...(analysis.delimiter !== undefined ? { delimiter: analysis.delimiter } : {}),
    ...(analysis.sheetName !== undefined ? { sheetName: analysis.sheetName } : {}),
    source: input.source ?? "http"
  };

  // Transacción corta: hash bajo lock por propiedad + alta del lote en `processing`.
  const lote = await prisma.$transaction(async (tx) => {
    await lockProperty(tx, propertyId);
    const duplicate = await findLiveImport(tx, propertyId, analysis.contentHash);
    if (duplicate) {
      if (!analysis.options.force) {
        throw importConflict("RESERVATION_IMPORT_DUPLICATE", `Este fichero ya se importó (lote ${duplicate.id}): deshaz el lote anterior o activa «Importar de todos modos».`, duplicateRefOf(duplicate) as unknown as Record<string, unknown>);
      }
      storedOptions.duplicateOfImportId = duplicate.id;
    }
    return tx.reservationImport.create({
      data: {
        organizationId: context.organizationId,
        propertyId,
        format: analysis.format,
        fileName: analysis.fileName,
        contentHash: analysis.contentHash,
        status: "processing",
        rowCount: analysis.rows.length,
        mappingJson: analysis.mapping as unknown as Prisma.InputJsonValue,
        optionsJson: storedOptions as unknown as Prisma.InputJsonValue,
        currency: analysis.catalogs.currency,
        createdBy
      }
    });
  });
  const importId = lote.id;

  // Bucle secuencial por fila; filas persistidas por bloques.
  const outcomes: RowOutcome[] = [];
  let pending: RowOutcome[] = [];
  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    await prisma.reservationImportRow.createMany({ data: pending.map((outcome) => rowData(importId, context.organizationId, propertyId, outcome)) });
    pending = [];
  };
  for (const row of analysis.rows) {
    const outcome = await commitRow({ context, propertyId, importId, row, options: analysis.options, correlationId });
    outcomes.push(outcome);
    pending.push(outcome);
    if (pending.length >= RESERVATION_IMPORT_ROW_BATCH_SIZE) await flush();
  }
  await flush();

  // Cierre del lote.
  const created = outcomes.filter((outcome) => outcome.outcome === "created");
  const counts = {
    createdCount: created.length,
    skippedCount: outcomes.filter((outcome) => outcome.outcome === "skipped").length,
    errorCount: outcomes.filter((outcome) => outcome.outcome === "error").length,
    warningCount: outcomes.filter((outcome) => outcome.warnings.length > 0).length
  };
  const arrivals = created.map((outcome) => outcome.resolved?.arrivalDate).filter((value): value is IsoDate => Boolean(value)).sort();
  let totalAmount: Prisma.Decimal = ZERO;
  for (const outcome of created) totalAmount = totalAmount.plus(outcome.totalAmount ?? "0");
  const status = deriveImportStatus(counts);
  storedOptions.durationMs = Date.now() - startedAt;
  await prisma.reservationImport.update({
    where: { id: importId },
    data: {
      ...counts,
      arrivalFrom: arrivals.length > 0 ? dateOnly(arrivals[0]!) : null,
      arrivalTo: arrivals.length > 0 ? dateOnly(arrivals[arrivals.length - 1]!) : null,
      totalAmount,
      optionsJson: storedOptions as unknown as Prisma.InputJsonValue
    }
  });
  // El estado final solo si el lote sigue `processing`: un deshacer sobre un lote
  // estancado no se pisa; las reservas creadas después de ese deshacer se cancelan
  // ahora y el lote sigue `undone` (T7-FUN-06).
  const finished = await prisma.reservationImport.updateMany({ where: { id: importId, status: "processing" }, data: { status } });
  if (finished.count === 0) {
    const late = await cancelLateCreations({ context, propertyId, importId, correlationId });
    console.warn(`${LOG} import ${importId} was undone while processing (correlation ${correlationId}): ${late} late reservation(s) cancelled`);
  }
  const closed = await prisma.reservationImport.findUniqueOrThrow({ where: { id: importId } });

  recordAuditEvent({
    organizationId: context.organizationId,
    propertyId,
    actorUserId: context.userId,
    actorType: "user",
    action: "RESERVATION_IMPORT_COMMITTED",
    entityType: "reservation_import",
    entityId: importId,
    afterJson: {
      status,
      rowCount: analysis.rows.length,
      ...counts,
      mapping: analysis.mapping,
      options: storedOptions,
      contentHash: analysis.contentHash,
      fileName: analysis.fileName,
      arrivalFrom: arrivals[0] ?? null,
      arrivalTo: arrivals[arrivals.length - 1] ?? null,
      totalAmount: money(totalAmount)
    },
    deviceId: context.deviceId,
    correlationId
  });

  const rows = await prisma.reservationImportRow.findMany({ where: { importId }, orderBy: { rowNumber: "asc" } });
  return { ...toImportRecord(closed), rows: rows.map(toRowRecord), warnings: analysis.warnings };
}

/**
 * El lote se deshizo mientras seguía importándose (deshacer sobre un `processing`
 * estancado): las reservas del lote que siguen `draft | confirmed` —creadas
 * después de ese deshacer— se cancelan ahora con el mismo motivo, sus filas
 * quedan `cancelled` y `undoneCount` se actualiza; el lote sigue `undone`
 * (T7-FUN-06). Devuelve cuántas se han cancelado.
 */
async function cancelLateCreations(input: { context: UserContext; propertyId: string; importId: string; correlationId: string }): Promise<number> {
  const { context, propertyId, importId, correlationId } = input;
  const reservations = await prisma.reservation.findMany({
    where: { propertyId, bookingSource: bookingSourceOf(importId), deletedAt: null, status: { in: ["draft", "confirmed"] } },
    select: { id: true, code: true },
    orderBy: [{ code: "asc" }]
  });
  const cancelled: string[] = [];
  for (const reservation of reservations) {
    try {
      await transitionReservation({ context, reservationId: reservation.id, status: "cancelled", reason: `${RESERVATION_IMPORT_UNDO_DEFAULT_REASON} (lote ${importId})`, correlationId });
      cancelled.push(reservation.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${LOG} late undo of import ${importId}: reservation ${reservation.code} could not be cancelled (correlation ${correlationId}): ${message}`);
    }
  }
  if (cancelled.length > 0) {
    await prisma.reservationImportRow.updateMany({ where: { importId, reservationId: { in: cancelled } }, data: { undoOutcome: "cancelled" } });
    await prisma.reservationImport.update({ where: { id: importId }, data: { undoneCount: { increment: cancelled.length } } });
  }
  return cancelled.length;
}

// ---------------------------------------------------------------------------
// Deshacer
// ---------------------------------------------------------------------------

/**
 * `POST …/reservations/imports/:id/undo`: cancela las reservas del lote que
 * sigan `draft | confirmed` (las ya alojadas o históricas se conservan), marca
 * el lote `undone` e informa por fila. Idempotente y con reclamación atómica.
 */
export async function undoReservationImport(input: { context: UserContext; propertyId: string; importId: string; reason?: string | null; correlationId: string }): Promise<ReservationImportUndoResult> {
  requirePermissions(input.context, ["pms.reservation.modify"]);
  await assertPropertyInOrg(input.propertyId, input.context.organizationId);
  const { context, propertyId, importId, correlationId } = input;
  const existing = await loadImportOrThrow(prisma, context, propertyId, importId);
  if (existing.status === "undone") return { ...toImportRecord(existing), alreadyUndone: true, cancelledReservationIds: [] };

  const reason = (input.reason ?? "").trim().slice(0, RESERVATION_IMPORT_MAX_UNDO_REASON) || RESERVATION_IMPORT_UNDO_DEFAULT_REASON;
  const now = new Date();
  const staleBefore = new Date(now.getTime() - RESERVATION_IMPORT_UNDO_CLAIM_MINUTES * 60_000);
  // Un lote `processing` reciente sigue importándose: deshacerlo a medias dejaría
  // reservas creadas después del deshacer (T7-FUN-06). Pasada la ventana se
  // considera interrumpido y sí se deshace (y el cierre tardío ya no lo pisa).
  if (existing.status === "processing" && existing.createdAt > staleBefore) {
    throw importConflict(
      "RESERVATION_IMPORT_UNDO_IN_PROGRESS",
      `El lote todavía se está importando: espera a que termine (o ${RESERVATION_IMPORT_UNDO_CLAIM_MINUTES} minutos desde su creación si el proceso se interrumpió) antes de deshacerlo.`,
      { importId, createdAt: existing.createdAt.toISOString(), processing: true }
    );
  }
  const claimed = await prisma.reservationImport.updateMany({
    where: { id: importId, propertyId, status: { not: "undone" }, OR: [{ undoneAt: null }, { undoneAt: { lt: staleBefore } }] },
    data: { undoneAt: now, undoneBy: context.userId, undoReason: reason }
  });
  if (claimed.count === 0) {
    const current = await loadImportOrThrow(prisma, context, propertyId, importId);
    if (current.status === "undone") return { ...toImportRecord(current), alreadyUndone: true, cancelledReservationIds: [] };
    throw importConflict("RESERVATION_IMPORT_UNDO_IN_PROGRESS", RESERVATION_IMPORT_ERROR_LABELS_ES.RESERVATION_IMPORT_UNDO_IN_PROGRESS, { importId, undoneAt: current.undoneAt ? current.undoneAt.toISOString() : null });
  }

  // Fuente de verdad: las reservas del lote por `bookingSource` (no las filas persistidas).
  const reservations = await prisma.reservation.findMany({
    where: { propertyId, bookingSource: bookingSourceOf(importId), deletedAt: null },
    select: { id: true, status: true, code: true },
    orderBy: [{ code: "asc" }]
  });
  const cancelled: string[] = [];
  const kept: string[] = [];
  const skipped: string[] = [];
  const cancelReason = `${RESERVATION_IMPORT_UNDO_DEFAULT_REASON} (lote ${importId})${reason !== RESERVATION_IMPORT_UNDO_DEFAULT_REASON ? `: ${reason}` : ""}`;
  for (const reservation of reservations) {
    if (reservation.status === "draft" || reservation.status === "confirmed") {
      try {
        await transitionReservation({ context, reservationId: reservation.id, status: "cancelled", reason: cancelReason, correlationId });
        cancelled.push(reservation.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`${LOG} undo of import ${importId}: reservation ${reservation.code} could not be cancelled (correlation ${correlationId}): ${message}`);
        kept.push(reservation.id);
      }
    } else if (reservation.status === "cancelled" || reservation.status === "no_show") {
      skipped.push(reservation.id);
    } else {
      kept.push(reservation.id);
    }
  }
  const markRows = async (ids: string[], undoOutcome: ReservationImportUndoOutcome): Promise<void> => {
    if (ids.length === 0) return;
    await prisma.reservationImportRow.updateMany({ where: { importId, reservationId: { in: ids } }, data: { undoOutcome } });
  };
  await markRows(cancelled, "cancelled");
  await markRows(kept, "kept");
  await markRows(skipped, "skipped");
  const closed = await prisma.reservationImport.update({
    where: { id: importId },
    data: { status: "undone", undoneAt: now, undoneBy: context.userId, undoReason: reason, undoneCount: cancelled.length, undoKeptCount: kept.length }
  });

  recordAuditEvent({
    organizationId: context.organizationId,
    propertyId,
    actorUserId: context.userId,
    actorType: "user",
    action: "RESERVATION_IMPORT_UNDONE",
    entityType: "reservation_import",
    entityId: importId,
    beforeJson: { status: existing.status, createdCount: existing.createdCount },
    afterJson: { status: "undone", reason, cancelled: cancelled.length, kept: kept.length, skipped: skipped.length, cancelledReservationIds: cancelled },
    deviceId: context.deviceId,
    correlationId
  });
  return { ...toImportRecord(closed), alreadyUndone: false, cancelledReservationIds: cancelled };
}

// ---------------------------------------------------------------------------
// Lecturas
// ---------------------------------------------------------------------------

/** `GET …/reservations/imports`: lotes de la propiedad, más recientes primero. */
export async function listReservationImports(input: { context: UserContext; propertyId: string; query?: ReservationImportListQuery }): Promise<ReservationImportRecord[]> {
  requirePermissions(input.context, ["pms.reservation.read"]);
  await assertPropertyInOrg(input.propertyId, input.context.organizationId);
  const query = input.query ?? {};
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? RESERVATION_IMPORT_LIST_DEFAULT_LIMIT), 1), RESERVATION_IMPORT_LIST_MAX_LIMIT);
  const rows = await prisma.reservationImport.findMany({
    where: { propertyId: input.propertyId, organizationId: input.context.organizationId, ...(query.status ? { status: query.status } : {}) },
    orderBy: { createdAt: "desc" },
    take: limit
  });
  return rows.map(toImportRecord);
}

/** `GET …/reservations/imports/:id`: lote + filas por `rowNumber` (sin datos personales). */
export async function getReservationImport(input: { context: UserContext; propertyId: string; importId: string }): Promise<ReservationImportDetail> {
  requirePermissions(input.context, ["pms.reservation.read"]);
  await assertPropertyInOrg(input.propertyId, input.context.organizationId);
  const row = await loadImportOrThrow(prisma, input.context, input.propertyId, input.importId);
  const rows = await prisma.reservationImportRow.findMany({ where: { importId: row.id }, orderBy: { rowNumber: "asc" } });
  return { ...toImportRecord(row), rows: rows.map(toRowRecord) };
}
