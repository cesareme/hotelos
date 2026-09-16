// Estructura societaria · L2 · alta de centro de trabajo (property provisioning).
//
// Reusable service extracted from the pilot CLI (apps/api/src/scripts/
// provision-pilot-property.ts, which now delegates here): ONE plan/apply for a
// hotel, an office or another centre of an existing legal entity, driven by a
// spec (structure.schemas.ts `centreSpecSchema`) that the product sends as the
// body of POST /legal-entities/:legalEntityId/properties and the operator keeps
// in a JSON file. Same semantics as the CLI:
//   · idempotent: the property is located by (organizationId, name); an existing
//     one CONVERGES (null fields filled, equal skipped, different → conflict,
//     never overwritten); satellites are matched by natural key and only created
//     or filled — nothing is deleted;
//   · one transaction, ensurePropertySettings afterwards, one audit event
//     (PROPERTY_PROVISIONED) chained in the trail.
// What the structure adds (design §5.1, §5.2):
//   · the centre hangs from the organization's DEFAULT legal entity (created
//     implicitly when the tenant predates the backfill — never a second one);
//   · `kind` (hotel · office · other), `code` (unique per legal entity: given or
//     derived from the name; 409 CODE_IN_USE), `tradeName` and the census columns;
//   · an office / other centre has no building, rooms, room types nor rate plans
//     (R6); it may still carry series when it bills explicitly;
//   · series prefixes follow R3 (default `${serie}-${año}-` with one billing
//     centre, `${serie}-${código}-${año}-` with several) and are checked against
//     the sister centres (409 SERIES_PREFIX_CLASH; the dry-run lists them);
//   · `Property.legalName` is deprecated: a spec's `legalName` becomes the
//     `tradeName` and the column is never written.
// Pure helpers (planRooms, diffConverge, stableStringify, planRoomCapacityFill,
// splitProfile, resolveSeriesPrefixes, summarizePlan) take no database.

import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { normalizeTaxRegion } from "@hotelos/compliance";
import { HOTEL_MODULES } from "@hotelos/product";
import { recordAuditEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { defaultSeriesPrefix, findPrefixClash, seriesPrefixClashError, type SeriesPrefixRow } from "../invoicing/series-prefix.service.js";
import { createId } from "../../lib/ids.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/http-error.js";
import type { UserContext } from "../../lib/demo-store.js";
import { ensurePropertySettings, mirrorProperty } from "../../lib/tenant-hydration.js";
import { formatPlannedWrites, type PlannedWrite } from "../../../../../packages/database/prisma/lib/demo-guard.js";
import type { PropertyKind } from "@hotelos/shared";
import {
  STRUCTURE_MANAGE,
  codeInUse,
  createImplicitLegalEntity,
  planPropertyCode,
  requireLegalEntity,
  toEstablishmentDto,
  type StructureErrorCode
} from "./legal-entity.service.js";
import { centreSpecSchema, type CensusInput, type CentreSpec, type EstablishmentPatchInput } from "./structure.schemas.js";
import { z } from "zod";

export { formatPlannedWrites };
export type { PlannedWrite };

/** Operator spec of the CLI: a centre spec plus the organization it belongs to. */
export const pilotSpecSchema = centreSpecSchema.extend({ organizationId: z.string().trim().min(1) });
export type PilotSpec = z.output<typeof pilotSpecSchema>;
export type RoomTypeSpec = NonNullable<CentreSpec["roomTypes"]>["items"][number];

/** The sections a hotel must carry (checked by validateCentreSpec; typed for planRooms). */
export type HotelInventorySpec = {
  building: NonNullable<CentreSpec["building"]>;
  totalRooms: number;
  roomTypes: NonNullable<CentreSpec["roomTypes"]>;
  rooms?: CentreSpec["rooms"];
};

export const AUDIT_ACTION = "PROPERTY_PROVISIONED";
/** Same window as refresh-demo-dataset: ~100 rows per satellite, one property. */
const TX_OPTIONS = { maxWait: 30_000, timeout: 600_000 } as const;
const HOTEL_MODULE_CODES = new Set<string>(HOTEL_MODULES.map((m) => m.code));

// ---------------------------------------------------------------------------
// Spec validation (cross-field; the shape is zod's)
// ---------------------------------------------------------------------------

/**
 * Postal / INE coherence replicated from backoffice.service.ts
 * (validatePostalCode, validateIneMunicipalityCode, assertPostalAndIneCoherent):
 * importing backoffice.service drags demoStore, audit, auth and invitations into
 * a CLI that must stay unit-testable without a database. Same rules: 5 digits,
 * province prefix 01–52, CP and INE share the province prefix.
 */
const POSTAL_CODE_PATTERN = /^\d{5}$/;
const PROVINCE_CODE_PATTERN = /^(0[1-9]|[1-4]\d|5[0-2])$/;

export function assertFiscalLocationCoherent(postalCode: string | null, ineMunicipalityCode: string | null): void {
  if (postalCode !== null && (!POSTAL_CODE_PATTERN.test(postalCode) || !PROVINCE_CODE_PATTERN.test(postalCode.slice(0, 2)))) {
    throw new Error(`Código postal no válido («${postalCode}»): deben ser 5 dígitos y empezar por el código de provincia (01–52).`);
  }
  if (ineMunicipalityCode !== null && (!POSTAL_CODE_PATTERN.test(ineMunicipalityCode) || !PROVINCE_CODE_PATTERN.test(ineMunicipalityCode.slice(0, 2)))) {
    throw new Error(`Código INE de municipio no válido («${ineMunicipalityCode}»): deben ser 5 dígitos (2 de provincia + 3 de municipio).`);
  }
  if (postalCode !== null && ineMunicipalityCode !== null && postalCode.slice(0, 2) !== ineMunicipalityCode.slice(0, 2)) {
    throw new Error(
      `El código postal (${postalCode}) y el código INE (${ineMunicipalityCode}) pertenecen a provincias distintas (${postalCode.slice(0, 2)} ≠ ${ineMunicipalityCode.slice(0, 2)}).`
    );
  }
}

/** Series ↔ AEAT type rule of patchBillingSettings (assertSeriesCodeMatchesType) + prefix/year agreement (prefix optional: R3 default). */
export function assertInvoiceSequenceCoherent(seq: { sequenceCode: string; invoiceType: string; prefix?: string | null; year: number }): void {
  const code = seq.sequenceCode.toUpperCase();
  if (!/^[A-Z0-9_-]{1,12}$/.test(code)) throw new Error(`Código de serie no válido («${seq.sequenceCode}»): hasta 12 caracteres alfanuméricos.`);
  if (!/^(F[123]|R[1-5]?)$/.test(seq.invoiceType)) throw new Error(`Tipo de factura no válido («${seq.invoiceType}») en la serie ${code}: F1/F2/F3/R/R1–R5.`);
  const expected: Record<string, RegExp> = { FAC: /^F[13]$/, SIM: /^F2$/, REC: /^R[1-5]?$/ };
  const rule = expected[code];
  if (rule && !rule.test(seq.invoiceType)) throw new Error(`La serie ${code} no admite facturas de tipo ${seq.invoiceType}.`);
  if (seq.prefix) {
    const match = /(?:^|\D)(20\d{2})(?:\D|$)/.exec(seq.prefix);
    if (match && Number(match[1]) !== seq.year) throw new Error(`El prefijo «${seq.prefix}» lleva el año ${match[1]} pero la serie es del ejercicio ${seq.year}.`);
  }
}

export function isHotelKind(kind: PropertyKind): boolean {
  return kind === "hotel";
}

/** Narrow a validated hotel spec to the inventory sections planRooms needs. */
export function hotelInventoryOf(spec: CentreSpec): HotelInventorySpec {
  if (!spec.building || spec.totalRooms === undefined || !spec.roomTypes) {
    throw new Error("Spec inválido: un centro de tipo hotel necesita building, totalRooms y roomTypes.");
  }
  return { building: spec.building, totalRooms: spec.totalRooms, roomTypes: spec.roomTypes, rooms: spec.rooms };
}

/**
 * Cross-field validation of a parsed centre spec (throws with a Spanish,
 * actionable message). A hotel needs its inventory sections and at least one
 * owner; an office / other centre must not carry rooms, room types, rate plans
 * nor the SES flag (R6). Series are validated for every kind (an office may
 * bill explicitly).
 */
export function validateCentreSpec(spec: CentreSpec): CentreSpec {
  assertFiscalLocationCoherent(spec.property.postalCode, spec.property.ineMunicipalityCode);
  if (spec.property.taxRegion !== null && normalizeTaxRegion(spec.property.taxRegion, null) !== spec.property.taxRegion) {
    throw new Error(`Región fiscal no canónica («${spec.property.taxRegion}»): usa el valor canónico (p.ej. ES_PENINSULA_BALEARES).`);
  }
  const unknownModules = spec.modules.filter((code) => !HOTEL_MODULE_CODES.has(code));
  if (unknownModules.length > 0) throw new Error(`Módulos desconocidos en el catálogo HOTEL_MODULES: ${unknownModules.join(", ")}.`);
  if (new Set(spec.modules).size !== spec.modules.length) throw new Error("Módulos repetidos en el spec.");
  for (const seq of spec.invoiceSequences) assertInvoiceSequenceCoherent(seq);
  const seqKeys = spec.invoiceSequences.map((s) => `${s.sequenceCode.toUpperCase()}/${s.year}`);
  if (new Set(seqKeys).size !== seqKeys.length) throw new Error("Series de factura repetidas (sequenceCode + year) en el spec.");
  const planCodes = spec.ratePlans.map((p) => p.code);
  if (new Set(planCodes).size !== planCodes.length) throw new Error("Códigos de plan tarifario repetidos en el spec.");

  if (!isHotelKind(spec.property.kind)) {
    const label = spec.property.kind === "office" ? "oficina" : "otro";
    if (spec.building || spec.totalRooms !== undefined || spec.roomTypes || spec.rooms || spec.ratePlans.length > 0) {
      throw new Error(`Spec inválido: un centro de tipo ${label} no tiene edificio, habitaciones, tipos de habitación ni tarifas (R6).`);
    }
    if (spec.property.sesHospedajesEnabled) throw new Error(`Spec inválido: un centro de tipo ${label} no envía partes SES.HOSPEDAJES.`);
    return spec;
  }

  if (spec.owners.length === 0) throw new Error("Spec inválido: owners: un hotel necesita al menos un usuario con rol (user_property_roles).");
  const inventory = hotelInventoryOf(spec);
  const codes = inventory.roomTypes.items.map((t) => t.code);
  if (new Set(codes).size !== codes.length) throw new Error("Códigos de tipo de habitación repetidos en el spec.");
  for (const t of inventory.roomTypes.items) {
    if (t.maxOccupancy < t.baseCapacity) throw new Error(`Tipo ${t.code}: maxOccupancy (${t.maxOccupancy}) < baseCapacity (${t.baseCapacity}).`);
  }
  const sum = inventory.roomTypes.items.reduce((acc, t) => acc + t.count, 0);
  if (sum !== inventory.totalRooms) throw new Error(`Σ roomTypes.count = ${sum} ≠ totalRooms = ${inventory.totalRooms}.`);
  if (inventory.rooms === undefined && inventory.totalRooms % inventory.building.floors !== 0) {
    throw new Error(`totalRooms (${inventory.totalRooms}) no es divisible entre building.floors (${inventory.building.floors}); fija «rooms» explícitamente.`);
  }
  // Room list (explicit or derived) must reconcile with the per-type counts.
  const rooms = planRooms(inventory);
  const byType = new Map<string, number>();
  for (const r of rooms) byType.set(r.roomTypeCode, (byType.get(r.roomTypeCode) ?? 0) + 1);
  for (const t of inventory.roomTypes.items) {
    const n = byType.get(t.code) ?? 0;
    if (n !== t.count) throw new Error(`Numeración: el tipo ${t.code} recibe ${n} habitaciones pero el spec declara count ${t.count}.`);
  }
  for (const code of byType.keys()) if (!codes.includes(code)) throw new Error(`Numeración: tipo de habitación desconocido «${code}».`);
  return spec;
}

/** Parse + cross-field validation of a raw operator spec (CLI): the organization id is part of the file. */
export function validateSpec(raw: unknown): PilotSpec {
  const parsed = pilotSpecSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`Spec inválido: ${issues}`);
  }
  validateCentreSpec(parsed.data);
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Room numbering (pure)
// ---------------------------------------------------------------------------

export type PlannedRoom = { number: string; floorNumber: number; roomTypeCode: string };

/**
 * Deterministic rooming list when the spec carries no explicit `rooms`.
 * Numbers: floor f (1..F) gets f01..f<P> with P = totalRooms / F.
 * Types, in this order (each step consumes rooms not yet assigned):
 *   1. IND-like types (baseCapacity 1) → the first rooms of every floor,
 *      count/F per floor (must divide evenly), e.g. x01, x02.
 *   2. Suite-like types (defaultRateCategory "Suite") → the LAST room of the
 *      floors counted from the top (423, 323, 223 for count 3): the ground
 *      floor keeps no suite.
 *   3. Remaining types in spec order: with exactly two of them (DBL/DBM) an
 *      odd number → first, even → second; with one, all remaining rooms;
 *      more than two are filled in blocks in number order.
 * The result is checked against spec counts by validateCentreSpec: a spec whose
 * counts cannot be honoured by this rule fails loudly instead of silently
 * producing a different inventory.
 */
export function planRooms(spec: HotelInventorySpec): PlannedRoom[] {
  if (spec.rooms !== undefined) {
    const numbers = spec.rooms.map((r) => r.number);
    if (new Set(numbers).size !== numbers.length) throw new Error("Numeración explícita con números repetidos.");
    if (numbers.length !== spec.totalRooms) throw new Error(`Numeración explícita con ${numbers.length} habitaciones ≠ totalRooms ${spec.totalRooms}.`);
    return spec.rooms.map((r) => ({
      number: r.number,
      floorNumber: r.floorNumber ?? (Number(r.number.slice(0, -2)) || 1),
      roomTypeCode: r.roomTypeCode
    }));
  }
  const floors = spec.building.floors;
  const perFloor = spec.totalRooms / floors;
  if (!Number.isInteger(perFloor)) throw new Error(`totalRooms (${spec.totalRooms}) no es divisible entre ${floors} plantas.`);
  const rooms: PlannedRoom[] = [];
  for (let f = 1; f <= floors; f++) {
    for (let i = 1; i <= perFloor; i++) rooms.push({ number: `${f}${String(i).padStart(2, "0")}`, floorNumber: f, roomTypeCode: "" });
  }
  const single = spec.roomTypes.items.filter((t) => t.baseCapacity === 1);
  const suites = spec.roomTypes.items.filter((t) => t.baseCapacity !== 1 && (t.defaultRateCategory ?? "").toLowerCase() === "suite");
  const others = spec.roomTypes.items.filter((t) => !single.includes(t) && !suites.includes(t));

  const free = (): PlannedRoom[] => rooms.filter((r) => r.roomTypeCode === "");
  for (const t of single) {
    if (t.count % floors !== 0) throw new Error(`Tipo ${t.code}: count ${t.count} no es divisible entre ${floors} plantas (regla x01, x02…).`);
    const perFloorSingles = t.count / floors;
    for (let f = 1; f <= floors; f++) {
      const candidates = free().filter((r) => r.floorNumber === f).slice(0, perFloorSingles);
      if (candidates.length < perFloorSingles) throw new Error(`Tipo ${t.code}: no quedan habitaciones libres en la planta ${f}.`);
      for (const r of candidates) r.roomTypeCode = t.code;
    }
  }
  for (const t of suites) {
    let remaining = t.count;
    for (let f = floors; f >= 1 && remaining > 0; f--) {
      const last = free().filter((r) => r.floorNumber === f).at(-1);
      if (!last) throw new Error(`Tipo ${t.code}: no quedan habitaciones libres en la planta ${f}.`);
      last.roomTypeCode = t.code;
      remaining--;
    }
    if (remaining > 0) throw new Error(`Tipo ${t.code}: count ${t.count} supera el número de plantas (${floors}); fija «rooms».`);
  }
  const rest = free();
  if (others.length === 1) {
    for (const r of rest) r.roomTypeCode = others[0]!.code;
  } else if (others.length === 2) {
    for (const r of rest) r.roomTypeCode = Number(r.number) % 2 === 1 ? others[0]!.code : others[1]!.code;
  } else if (others.length > 2) {
    let cursor = 0;
    for (const t of others) for (let i = 0; i < t.count && cursor < rest.length; i++) rest[cursor++]!.roomTypeCode = t.code;
  }
  const unassigned = rooms.filter((r) => r.roomTypeCode === "");
  if (unassigned.length > 0) throw new Error(`Numeración: ${unassigned.length} habitaciones sin tipo (${unassigned.slice(0, 5).map((r) => r.number).join(", ")}…).`);
  return rooms;
}

// ---------------------------------------------------------------------------
// Convergence diff (pure)
// ---------------------------------------------------------------------------

export type FieldConflict = { field: string; current: unknown; desired: unknown };
export type ConvergeDiff = { fill: Record<string, unknown>; same: string[]; conflicts: FieldConflict[] };

const isEmpty = (v: unknown): boolean => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

/**
 * JSON serialisation with object keys sorted recursively. Postgres jsonb
 * stores object keys in its own order (shorter first, then bytewise), so a
 * blob read back (configurationJson.pilotProfile) never matches the spec's
 * key order byte for byte and a plain JSON.stringify comparison reported a
 * permanent false conflict on every re-run. Same JSON semantics otherwise:
 * toJSON is honoured (Date, Prisma Decimal), undefined properties are dropped,
 * array order is kept (it is meaningful).
 */
export function stableStringify(value: unknown): string {
  if (value !== null && typeof value === "object") {
    const withToJson = value as { toJSON?: () => unknown };
    if (typeof withToJson.toJSON === "function") return stableStringify(withToJson.toJSON());
    if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : stableStringify(v))).join(",")}]`;
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .filter((k) => record[k] !== undefined && typeof record[k] !== "function")
      .map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/** Structural equality (key order agnostic) — the comparison every convergence decision rests on. */
export const sameValue = (a: unknown, b: unknown): boolean => stableStringify(a) === stableStringify(b);

/**
 * Fill-only convergence: a desired null is ignored (nothing to assert), an
 * empty current value is filled, an equal value is a no-op, and a DIFFERENT
 * non-empty value is a conflict — the service never overwrites another
 * writer's data (same contract as fix-demo-legal-identity fillIfEmpty).
 */
export function diffConverge(current: Record<string, unknown>, desired: Record<string, unknown>): ConvergeDiff {
  const out: ConvergeDiff = { fill: {}, same: [], conflicts: [] };
  for (const [field, want] of Object.entries(desired)) {
    if (want === null || want === undefined) continue;
    const have = current[field];
    if (isEmpty(have)) out.fill[field] = want;
    else if (sameValue(have, want)) out.same.push(field);
    else out.conflicts.push({ field, current: have, desired: want });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Plan (types)
// ---------------------------------------------------------------------------

type Converged<T> = { key: string; existingId: string | null; create: T | null; fill: Record<string, unknown>; conflicts: FieldConflict[] };

export type RoomCapacity = { maxOccupancy?: number; standardOccupancy?: number };
export type RoomCapacityFill = { number: string; roomId: string; fill: RoomCapacity };

/**
 * Pure fill-only decision for one room: a NULL capacity column takes the
 * value of the room's type (Room.maxOccupancy ← RoomType.maxOccupancy,
 * Room.standardOccupancy ← RoomType.baseCapacity); a non-null value is kept
 * even when it differs from the type (a room may legitimately sleep fewer
 * than its type). Returns null when there is nothing to fill.
 */
export function planRoomCapacityFill(
  room: { maxOccupancy: number | null; standardOccupancy: number | null },
  roomType: { maxOccupancy: number; baseCapacity: number } | null | undefined
): RoomCapacity | null {
  if (!roomType) return null;
  const fill: RoomCapacity = {};
  if (room.maxOccupancy === null) fill.maxOccupancy = roomType.maxOccupancy;
  if (room.standardOccupancy === null) fill.standardOccupancy = roomType.baseCapacity;
  return Object.keys(fill).length > 0 ? fill : null;
}

export type PlannedSequence = Converged<CentreSpec["invoiceSequences"][number] & { prefix: string }> & {
  /** Human line for the operator (CLI conflicts) or null. */
  prefixClash: string | null;
  /** The clashing sister row (drives the 409 SERIES_PREFIX_CLASH of the product route). */
  clashRow?: SeriesPrefixRow | null;
  /** Where the prefix came from: the spec or the R3 default. */
  prefixSource?: "spec" | "default";
};

export type ProvisionPlan = {
  organization: { id: string; name: string };
  /** Default legal entity the centre hangs from (created implicitly when missing). Optional for legacy plan literals. */
  legalEntity?: { id: string | null; code: string; legalName: string; action: "exists" | "create" };
  /** Resolved centre code (spec, existing row or derived from the name) and whether a sister centre already uses it. */
  code?: { value: string; source: "spec" | "existing" | "derived"; inUse: boolean };
  kind?: PropertyKind;
  property: { existingId: string | null; create: Prisma.PropertyUncheckedCreateInput | null; fill: Record<string, unknown>; conflicts: FieldConflict[] };
  owners: { create: { userId: string; roleId: string }[]; skip: number };
  departments: {
    code: string;
    name: string;
    existingId: string | null;
    users: { userId: string; roleLabel: string | null; action: "create" | "update" | "skip" }[];
  }[];
  modules: { code: string; moduleId: string | null; materialize: boolean; action: "create" | "enable" | "skip" }[];
  building: { existingId: string | null; create: boolean; floors: { floorNumber: number; existingId: string | null }[] };
  roomTypes: Converged<RoomTypeSpec>[];
  rooms: {
    create: PlannedRoom[];
    skip: string[];
    typeMismatch: { number: string; currentType: string | null; desiredType: string }[];
    /** Existing rooms whose max/standard occupancy is NULL: filled from their CURRENT room type (fill-only, never overwritten). */
    capacityFill: RoomCapacityFill[];
  };
  ratePlans: Converged<CentreSpec["ratePlans"][number]>[];
  invoiceSequences: PlannedSequence[];
  profile: { existingId: string | null; create: boolean; fill: Record<string, unknown>; conflicts: FieldConflict[] };
  settings: { aiExists: boolean; complianceExists: boolean; pilotProfile: "create" | "skip" | "conflict" };
  countsBefore: Record<string, number>;
};

/** Columns of CompliancePropertyProfile (schema.prisma) — everything else in `profile` goes to configurationJson.pilotProfile. */
const PROFILE_COLUMNS = ["autonomousCommunity", "hotelType", "hasRestaurant", "hasKitchen", "hasPool", "hasSpa", "hasParking", "hasEvents", "hasTerrace", "hasLaundry", "buildingProtected"] as const;

export function splitProfile(profile: CentreSpec["profile"]): { columns: Record<string, unknown>; pilotProfile: Record<string, unknown> } {
  const columns: Record<string, unknown> = {};
  const pilotProfile: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(profile)) {
    if ((PROFILE_COLUMNS as readonly string[]).includes(key)) columns[key] = value;
    else pilotProfile[key] = value;
  }
  return { columns, pilotProfile };
}

/** Census columns of the spec as Prisma data (fill-only on converge; the Decimal is passed as string). */
export function censusData(census: CensusInput | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!census) return out;
  for (const [key, value] of Object.entries(census)) if (value !== undefined && value !== null) out[key] = value;
  return out;
}

/**
 * Property columns asserted by the spec (Property.name is the lookup key, not
 * converged). `legalName` is deprecated: it feeds `tradeName` and the column is
 * never written. Census columns are fill-only (separately, see buildPlan).
 */
export function desiredPropertyFields(spec: CentreSpec): Record<string, unknown> {
  const p = spec.property;
  return {
    kind: p.kind,
    tradeName: p.tradeName ?? p.legalName,
    address: p.address,
    municipality: p.municipality,
    province: p.province,
    country: p.country,
    taxRegion: p.taxRegion,
    postalCode: p.postalCode,
    ineMunicipalityCode: p.ineMunicipalityCode,
    fiscalTerritory: p.fiscalTerritory,
    timezone: p.timezone,
    sesHospedajesEnabled: p.sesHospedajesEnabled,
    verifactuEnabled: p.verifactuEnabled
  };
}

// ---------------------------------------------------------------------------
// Series prefixes (pure, R3)
// ---------------------------------------------------------------------------

export type SiblingCentre = { id: string; code: string | null; kind: PropertyKind; hasActiveSeries: boolean };

/** Billing centres of the legal entity (R3): hotels and other centres always; an office only when it already bills. */
export function countBillingCentres(siblings: readonly SiblingCentre[]): number {
  return siblings.filter((s) => s.kind !== "office" || s.hasActiveSeries).length;
}

/**
 * Pure: resolve the prefix of every planned series (spec value or the R3
 * default) and detect clashes with the sister centres' ACTIVE series.
 */
export function resolveSeriesPrefixes(input: {
  sequences: CentreSpec["invoiceSequences"];
  propertyCode: string;
  propertyId: string | null;
  siblings: readonly SiblingCentre[];
  siblingSeries: readonly SeriesPrefixRow[];
}): Array<{ sequence: CentreSpec["invoiceSequences"][number]; prefix: string; prefixSource: "spec" | "default"; clash: SeriesPrefixRow | null }> {
  // The centre being planned always bills when it carries series (+1).
  const billingCentres = countBillingCentres(input.siblings) + 1;
  return input.sequences.map((sequence) => {
    const prefix = sequence.prefix ?? defaultSeriesPrefix({ series: sequence.sequenceCode, year: sequence.year, propertyCode: input.propertyCode, billingCentres });
    const clash = findPrefixClash(input.siblingSeries, { propertyId: input.propertyId ?? "__new_centre__", prefix, year: sequence.year });
    return { sequence, prefix, prefixSource: sequence.prefix ? "spec" : "default", clash };
  });
}

// ---------------------------------------------------------------------------
// Plan (database reads only)
// ---------------------------------------------------------------------------

type Db = Prisma.TransactionClient | typeof prisma;

export async function buildPlan(spec: CentreSpec, organizationId: string, db: Db = prisma): Promise<ProvisionPlan> {
  const organization = await db.organization.findUnique({ where: { id: organizationId }, select: { id: true, name: true, legalName: true, taxId: true } });
  if (!organization) throw new Error(`Organización ${organizationId} no encontrada.`);
  const kind = spec.property.kind;
  const hotel = isHotelKind(kind);

  // Owners / department users must belong to the organisation; roles are per
  // organisation. A wrong id would otherwise silently grant access across tenants.
  const userIds = [...new Set([...spec.owners.map((o) => o.userId), ...spec.departments.flatMap((d) => d.users.map((u) => u.userId))])];
  const users = userIds.length === 0 ? [] : await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, organizationId: true, email: true } });
  for (const id of userIds) {
    const u = users.find((x) => x.id === id);
    if (!u) throw new Error(`Usuario ${id} no encontrado.`);
    if (u.organizationId !== organizationId) throw new Error(`Usuario ${id} (${u.email}) pertenece a otra organización (${u.organizationId}).`);
  }
  const roleIds = [...new Set(spec.owners.map((o) => o.roleId))];
  const roles = roleIds.length === 0 ? [] : await db.role.findMany({ where: { id: { in: roleIds } }, select: { id: true, organizationId: true, name: true } });
  for (const id of roleIds) {
    const r = roles.find((x) => x.id === id);
    if (!r) throw new Error(`Rol ${id} no encontrado.`);
    if (r.organizationId !== organizationId) throw new Error(`Rol ${id} (${r.name}) pertenece a otra organización (${r.organizationId}).`);
  }

  // Legal entity: the organization's default one, or an implicit one planned for the apply.
  const entity = await db.legalEntity.findFirst({ where: { organizationId, isDefault: true, status: "active" }, orderBy: { createdAt: "asc" } });
  const entityLegalName = entity?.legalName ?? organization.legalName ?? organization.name;

  const existing = await db.property.findFirst({ where: { organizationId, name: spec.property.name } });
  const propertyId = existing?.id ?? null;

  // Sister centres of the legal entity (or of the organization while unlinked): codes, billing centres, active series.
  const siblingRows = await db.property.findMany({
    where: {
      ...(entity ? { OR: [{ legalEntityId: entity.id }, { legalEntityId: null, organizationId }] } : { organizationId }),
      ...(propertyId ? { id: { not: propertyId } } : {})
    },
    select: { id: true, code: true, kind: true }
  });
  const siblingSeries: SeriesPrefixRow[] =
    siblingRows.length === 0
      ? []
      : await db.invoiceSequence.findMany({
          where: { propertyId: { in: siblingRows.map((s) => s.id) }, active: true },
          select: { id: true, propertyId: true, prefix: true, year: true, active: true }
        });
  const activeSeriesProperties = new Set(siblingSeries.map((row) => row.propertyId));
  const siblings: SiblingCentre[] = siblingRows.map((row) => ({ id: row.id, code: row.code ?? null, kind: row.kind, hasActiveSeries: activeSeriesProperties.has(row.id) }));
  const takenCodes = new Set(siblings.map((s) => s.code).filter((c): c is string => c !== null));
  const codeSource: "spec" | "existing" | "derived" = spec.property.code ? "spec" : existing?.code ? "existing" : "derived";
  const codeValue =
    codeSource === "spec"
      ? spec.property.code!
      : codeSource === "existing"
        ? existing!.code!
        : planPropertyCode(spec.property.name, { name: organization.name, legalName: entityLegalName }, takenCodes);

  const desired = desiredPropertyFields(spec);
  const census = censusData(spec.property.census);
  const propertyDiff = existing ? diffConverge(existing as unknown as Record<string, unknown>, { ...desired, ...census }) : { fill: {}, same: [], conflicts: [] };
  if (existing && existing.legalEntityId === null && entity) propertyDiff.fill.legalEntityId = entity.id;
  if (existing && existing.code === null) propertyDiff.fill.code = codeValue;

  const plan: ProvisionPlan = {
    organization: { id: organization.id, name: organization.name },
    legalEntity: entity
      ? { id: entity.id, code: entity.code, legalName: entity.legalName, action: "exists" }
      : { id: null, code: "", legalName: entityLegalName, action: "create" },
    code: { value: codeValue, source: codeSource, inUse: takenCodes.has(codeValue) },
    kind,
    property: {
      existingId: propertyId,
      create: existing
        ? null
        : ({
            organizationId,
            name: spec.property.name,
            ...desired,
            ...census,
            code: codeValue,
            ...(entity ? { legalEntityId: entity.id } : {})
          } as Prisma.PropertyUncheckedCreateInput),
      fill: propertyDiff.fill,
      conflicts: propertyDiff.conflicts
    },
    owners: { create: [], skip: 0 },
    departments: [],
    modules: [],
    building: hotel && spec.building
      ? { existingId: null, create: true, floors: Array.from({ length: spec.building.floors }, (_, i) => ({ floorNumber: i + 1, existingId: null })) }
      : { existingId: null, create: false, floors: [] },
    roomTypes: [],
    rooms: { create: [], skip: [], typeMismatch: [], capacityFill: [] },
    ratePlans: [],
    invoiceSequences: [],
    profile: { existingId: null, create: true, fill: {}, conflicts: [] },
    settings: { aiExists: false, complianceExists: false, pilotProfile: "create" },
    countsBefore: {}
  };

  // Module catalogue rows: materialised from HOTEL_MODULES when missing (same
  // rule as createTenant — the `modules` table may lag behind the manifest).
  const moduleRows = spec.modules.length === 0 ? [] : await db.module.findMany({ where: { code: { in: spec.modules } }, select: { id: true, code: true } });
  const propertyModules = propertyId ? await db.propertyModule.findMany({ where: { propertyId } }) : [];
  for (const code of spec.modules) {
    const row = moduleRows.find((m) => m.code === code) ?? null;
    const pm = row ? propertyModules.find((x) => x.moduleId === row.id) : undefined;
    plan.modules.push({ code, moduleId: row?.id ?? null, materialize: row === null, action: !pm ? "create" : pm.status === "enabled" ? "skip" : "enable" });
  }

  const rooms = hotel ? planRooms(hotelInventoryOf(spec)) : [];
  const { columns: profileColumns } = splitProfile(spec.profile);
  const roomTypeItems = hotel ? hotelInventoryOf(spec).roomTypes.items : [];
  const resolvedSeries = resolveSeriesPrefixes({ sequences: spec.invoiceSequences, propertyCode: codeValue, propertyId, siblings, siblingSeries });
  const clashLine = (clash: SeriesPrefixRow | null, prefix: string): string | null => (clash ? `prefijo «${prefix}» ya usado por la propiedad ${clash.propertyId}` : null);

  if (!existing) {
    plan.owners.create = spec.owners.map((o) => ({ userId: o.userId, roleId: o.roleId }));
    plan.departments = spec.departments.map((d) => ({ code: d.code, name: d.name, existingId: null, users: d.users.map((u) => ({ userId: u.userId, roleLabel: u.roleLabel, action: "create" as const })) }));
    plan.roomTypes = roomTypeItems.map((t) => ({ key: t.code, existingId: null, create: t, fill: {}, conflicts: [] }));
    plan.rooms.create = rooms;
    plan.ratePlans = spec.ratePlans.map((p) => ({ key: p.code, existingId: null, create: p, fill: {}, conflicts: [] }));
    plan.invoiceSequences = resolvedSeries.map((r) => ({
      key: `${r.sequence.sequenceCode.toUpperCase()}/${r.sequence.year}`,
      existingId: null,
      create: { ...r.sequence, prefix: r.prefix },
      fill: {},
      conflicts: [],
      prefixClash: clashLine(r.clash, r.prefix),
      clashRow: r.clash,
      prefixSource: r.prefixSource
    }));
    plan.profile = { existingId: null, create: true, fill: {}, conflicts: [] };
    plan.countsBefore = { properties: 0, rooms: 0, roomsWithoutCapacity: 0, roomTypes: 0, userPropertyRoles: 0, propertyModulesEnabled: 0, invoiceSequences: 0, ratePlans: 0 };
  } else {
    const propertyId = existing.id;
    const [uprs, departments, userDepartments, buildings, floors, roomTypes, roomRows, ratePlans, sequences, profile, ai, compliance] = await Promise.all([
      db.userPropertyRole.findMany({ where: { propertyId } }),
      db.department.findMany({ where: { propertyId } }),
      userIds.length === 0 ? Promise.resolve([]) : db.userDepartment.findMany({ where: { userId: { in: userIds } } }),
      db.building.findMany({ where: { propertyId } }),
      db.floor.findMany({ where: { propertyId } }),
      db.roomType.findMany({ where: { propertyId } }),
      db.room.findMany({ where: { propertyId }, select: { id: true, number: true, roomTypeId: true, sellable: true, maxOccupancy: true, standardOccupancy: true } }),
      db.ratePlan.findMany({ where: { propertyId } }),
      db.invoiceSequence.findMany({ where: { propertyId } }),
      db.compliancePropertyProfile.findUnique({ where: { propertyId } }),
      db.propertyAiSetting.findUnique({ where: { propertyId }, select: { id: true } }),
      db.propertyComplianceSetting.findUnique({ where: { propertyId }, select: { id: true, configurationJson: true } })
    ]);
    for (const o of spec.owners) {
      if (uprs.some((u) => u.userId === o.userId && u.roleId === o.roleId)) plan.owners.skip++;
      else plan.owners.create.push({ userId: o.userId, roleId: o.roleId });
    }
    plan.departments = spec.departments.map((d) => {
      const dep = departments.find((x) => x.code === d.code) ?? null;
      return {
        code: d.code,
        name: d.name,
        existingId: dep?.id ?? null,
        users: d.users.map((u) => {
          const ud = dep ? userDepartments.find((x) => x.userId === u.userId && x.departmentId === dep.id) : undefined;
          const action = !ud ? "create" : ud.roleLabel === u.roleLabel && ud.active ? "skip" : "update";
          return { userId: u.userId, roleLabel: u.roleLabel, action };
        })
      };
    });
    if (hotel && spec.building) {
      const building = buildings.find((b) => b.code === spec.building!.code) ?? null;
      plan.building = {
        existingId: building?.id ?? null,
        create: building === null,
        floors: Array.from({ length: spec.building.floors }, (_, i) => {
          const n = i + 1;
          const fl = building ? floors.find((f) => f.buildingId === building.id && f.floorNumber === n) : undefined;
          return { floorNumber: n, existingId: fl?.id ?? null };
        })
      };
    }
    plan.roomTypes = roomTypeItems.map((t) => {
      const rt = roomTypes.find((x) => x.code === t.code) ?? null;
      if (!rt) return { key: t.code, existingId: null, create: t, fill: {}, conflicts: [] };
      const diff = diffConverge(rt as unknown as Record<string, unknown>, { name: t.name, maxOccupancy: t.maxOccupancy, baseCapacity: t.baseCapacity, defaultRateCategory: t.defaultRateCategory, sellable: true, active: true });
      return { key: t.code, existingId: rt.id, create: null, fill: diff.fill, conflicts: diff.conflicts };
    });
    for (const r of rooms) {
      const row = roomRows.find((x) => x.number === r.number);
      if (!row) plan.rooms.create.push(r);
      else {
        plan.rooms.skip.push(r.number);
        const currentType = roomTypes.find((x) => x.id === row.roomTypeId)?.code ?? null;
        if (currentType !== r.roomTypeCode) plan.rooms.typeMismatch.push({ number: r.number, currentType, desiredType: r.roomTypeCode });
      }
    }
    // Capacity convergence over EVERY room of the property (not only the
    // spec's rooming list): the source is the room's current type in the DB,
    // never the spec type — rooms are never retyped.
    for (const row of roomRows) {
      const fill = planRoomCapacityFill(row, roomTypes.find((x) => x.id === row.roomTypeId));
      if (fill) plan.rooms.capacityFill.push({ number: row.number, roomId: row.id, fill });
    }
    plan.ratePlans = spec.ratePlans.map((p) => {
      const rp = ratePlans.find((x) => x.code === p.code) ?? null;
      if (!rp) return { key: p.code, existingId: null, create: p, fill: {}, conflicts: [] };
      const diff = diffConverge(rp as unknown as Record<string, unknown>, { name: p.name, ratePlanType: p.ratePlanType, mealPlan: p.mealPlan, active: true });
      return { key: p.code, existingId: rp.id, create: null, fill: diff.fill, conflicts: diff.conflicts };
    });
    plan.invoiceSequences = resolvedSeries.map((r) => {
      const code = r.sequence.sequenceCode.toUpperCase();
      const row = sequences.find((x) => x.sequenceCode === code && x.year === r.sequence.year) ?? null;
      const key = `${code}/${r.sequence.year}`;
      if (!row) return { key, existingId: null, create: { ...r.sequence, prefix: r.prefix }, fill: {}, conflicts: [], prefixClash: clashLine(r.clash, r.prefix), clashRow: r.clash, prefixSource: r.prefixSource };
      const diff = diffConverge(row as unknown as Record<string, unknown>, { prefix: r.prefix, invoiceType: r.sequence.invoiceType, padding: r.sequence.padding, active: true });
      if (row.legalEntityId === null && entity) diff.fill.legalEntityId = entity.id;
      return { key, existingId: row.id, create: null, fill: diff.fill, conflicts: diff.conflicts, prefixClash: clashLine(r.clash, r.prefix), clashRow: r.clash, prefixSource: r.prefixSource };
    });
    if (profile) {
      const diff = diffConverge(profile as unknown as Record<string, unknown>, profileColumns);
      plan.profile = { existingId: profile.id, create: false, fill: diff.fill, conflicts: diff.conflicts };
    }
    plan.settings.aiExists = ai !== null;
    plan.settings.complianceExists = compliance !== null;
    if (compliance) {
      const cfg = (compliance.configurationJson ?? {}) as Record<string, unknown>;
      const { pilotProfile } = splitProfile(spec.profile);
      plan.settings.pilotProfile = cfg.pilotProfile === undefined ? "create" : sameValue(cfg.pilotProfile, pilotProfile) ? "skip" : "conflict";
    }
    plan.countsBefore = {
      properties: 1,
      rooms: roomRows.filter((r) => r.sellable).length,
      roomsWithoutCapacity: roomRows.filter((r) => r.maxOccupancy === null || r.standardOccupancy === null).length,
      roomTypes: roomTypes.length,
      userPropertyRoles: uprs.length,
      propertyModulesEnabled: propertyModules.filter((pm) => pm.status === "enabled").length,
      invoiceSequences: sequences.length,
      ratePlans: ratePlans.length
    };
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Summary (pure)
// ---------------------------------------------------------------------------

export type PlanSummary = { writes: PlannedWrite[]; skips: string[]; conflicts: string[] };

/** Flatten the plan into demo-guard style planned writes + skips + conflicts (dry-run and --json both use it). */
export function summarizePlan(plan: ProvisionPlan): PlanSummary {
  const writes: PlannedWrite[] = [];
  const skips: string[] = [];
  const conflicts: string[] = [];
  const conflictLines = (table: string, key: string, list: FieldConflict[]) => {
    for (const c of list) conflicts.push(`${table} ${key} · ${c.field}: actual ${JSON.stringify(c.current)} ≠ spec ${JSON.stringify(c.desired)}`);
  };

  if (plan.legalEntity?.action === "create") writes.push({ table: "legal_entities", op: "create", count: 1, where: `sociedad implícita «${plan.legalEntity.legalName}»` });
  if (plan.code?.inUse) conflicts.push(`properties · code «${plan.code.value}» ya usado por otro centro de la misma sociedad`);
  if (plan.property.create) writes.push({ table: "properties", op: "create", count: 1, where: `name=${JSON.stringify(plan.property.create.name)}` });
  else {
    const fields = Object.keys(plan.property.fill);
    if (fields.length > 0) writes.push({ table: "properties", op: "update", count: 1, where: `id=${plan.property.existingId} · rellena ${fields.join(", ")}` });
    else skips.push(`properties ×1 — id=${plan.property.existingId} (sin campos vacíos que rellenar)`);
    conflictLines("properties", plan.property.existingId ?? "", plan.property.conflicts);
  }
  if (plan.owners.create.length > 0) writes.push({ table: "user_property_roles", op: "create", count: plan.owners.create.length, where: plan.owners.create.map((o) => `user=${o.userId} role=${o.roleId}`).join("; ") });
  if (plan.owners.skip > 0) skips.push(`user_property_roles ×${plan.owners.skip} — ya asignados`);
  for (const d of plan.departments) {
    if (!d.existingId) writes.push({ table: "departments", op: "create", count: 1, where: `code=${d.code}` });
    else skips.push(`departments ×1 — code=${d.code}`);
    const creates = d.users.filter((u) => u.action === "create");
    const updates = d.users.filter((u) => u.action === "update");
    const same = d.users.filter((u) => u.action === "skip");
    if (creates.length) writes.push({ table: "user_departments", op: "create", count: creates.length, where: creates.map((u) => `${u.userId}→${d.code} (${u.roleLabel ?? "—"})`).join("; ") });
    if (updates.length) writes.push({ table: "user_departments", op: "update", count: updates.length, where: updates.map((u) => `${u.userId}→${d.code} roleLabel=${u.roleLabel ?? "—"} active=true`).join("; ") });
    if (same.length) skips.push(`user_departments ×${same.length} — ${d.code}`);
  }
  const materialize = plan.modules.filter((m) => m.materialize);
  if (materialize.length) writes.push({ table: "modules", op: "upsert", count: materialize.length, where: `catálogo HOTEL_MODULES: ${materialize.map((m) => m.code).join(", ")}` });
  const pmCreate = plan.modules.filter((m) => m.action === "create");
  const pmEnable = plan.modules.filter((m) => m.action === "enable");
  const pmSkip = plan.modules.filter((m) => m.action === "skip");
  if (pmCreate.length) writes.push({ table: "property_modules", op: "create", count: pmCreate.length, where: `enabled: ${pmCreate.map((m) => m.code).join(", ")}` });
  if (pmEnable.length) writes.push({ table: "property_modules", op: "update", count: pmEnable.length, where: `→ enabled: ${pmEnable.map((m) => m.code).join(", ")}` });
  if (pmSkip.length) skips.push(`property_modules ×${pmSkip.length} — ya enabled: ${pmSkip.map((m) => m.code).join(", ")}`);
  const hotel = plan.kind === undefined || plan.kind === "hotel";
  if (plan.building.create) writes.push({ table: "buildings", op: "create", count: 1, where: "Edificio principal" });
  else if (hotel) skips.push(`buildings ×1 — id=${plan.building.existingId}`);
  const newFloors = plan.building.floors.filter((f) => !f.existingId);
  if (newFloors.length) writes.push({ table: "floors", op: "create", count: newFloors.length, where: `plantas ${newFloors.map((f) => f.floorNumber).join(", ")}` });
  if (newFloors.length < plan.building.floors.length) skips.push(`floors ×${plan.building.floors.length - newFloors.length} — existentes`);
  const rtCreate = plan.roomTypes.filter((t) => t.create);
  if (rtCreate.length) writes.push({ table: "room_types", op: "create", count: rtCreate.length, where: rtCreate.map((t) => `${t.key} ×${t.create!.count}`).join(", ") });
  for (const t of plan.roomTypes.filter((t) => !t.create)) {
    const fields = Object.keys(t.fill);
    if (fields.length) writes.push({ table: "room_types", op: "update", count: 1, where: `code=${t.key} · rellena ${fields.join(", ")}` });
    else skips.push(`room_types ×1 — code=${t.key}`);
    conflictLines("room_types", t.key, t.conflicts);
  }
  if (plan.rooms.create.length) {
    const byType = new Map<string, number>();
    for (const r of plan.rooms.create) byType.set(r.roomTypeCode, (byType.get(r.roomTypeCode) ?? 0) + 1);
    writes.push({ table: "rooms", op: "createMany", count: plan.rooms.create.length, where: [...byType.entries()].map(([c, n]) => `${c}=${n}`).join(" · ") });
  }
  if (plan.rooms.skip.length) skips.push(`rooms ×${plan.rooms.skip.length} — existentes (nunca se borran ni se retipan)`);
  if (plan.rooms.capacityFill.length) {
    const fields = new Set(plan.rooms.capacityFill.flatMap((r) => Object.keys(r.fill)));
    writes.push({ table: "rooms", op: "update", count: plan.rooms.capacityFill.length, where: `capacidad desde el tipo (${[...fields].join(", ")}; solo columnas NULL)` });
  }
  for (const m of plan.rooms.typeMismatch) conflicts.push(`rooms ${m.number} · tipo actual ${m.currentType ?? "—"} ≠ spec ${m.desiredType} (se conserva el actual)`);
  const rpCreate = plan.ratePlans.filter((p) => p.create);
  if (rpCreate.length) writes.push({ table: "rate_plans", op: "create", count: rpCreate.length, where: rpCreate.map((p) => p.key).join(", ") });
  for (const p of plan.ratePlans.filter((p) => !p.create)) {
    const fields = Object.keys(p.fill);
    if (fields.length) writes.push({ table: "rate_plans", op: "update", count: 1, where: `code=${p.key} · rellena ${fields.join(", ")}` });
    else skips.push(`rate_plans ×1 — code=${p.key}`);
    conflictLines("rate_plans", p.key, p.conflicts);
  }
  const seqCreate = plan.invoiceSequences.filter((s) => s.create);
  if (seqCreate.length) writes.push({ table: "invoice_sequences", op: "create", count: seqCreate.length, where: seqCreate.map((s) => `${s.key} ${s.create!.prefix}`).join(", ") });
  for (const s of plan.invoiceSequences) {
    if (!s.create) {
      const fields = Object.keys(s.fill);
      if (fields.length) writes.push({ table: "invoice_sequences", op: "update", count: 1, where: `${s.key} · rellena ${fields.join(", ")}` });
      else skips.push(`invoice_sequences ×1 — ${s.key} (nextNumber intacto)`);
      conflictLines("invoice_sequences", s.key, s.conflicts);
    }
    if (s.prefixClash) conflicts.push(`invoice_sequences ${s.key} · ${s.prefixClash}`);
  }
  if (plan.profile.create) writes.push({ table: "compliance_property_profiles", op: "create", count: 1 });
  else {
    const fields = Object.keys(plan.profile.fill);
    if (fields.length) writes.push({ table: "compliance_property_profiles", op: "update", count: 1, where: `rellena ${fields.join(", ")}` });
    else skips.push("compliance_property_profiles ×1 — sin campos vacíos");
    conflictLines("compliance_property_profiles", plan.profile.existingId ?? "", plan.profile.conflicts);
  }
  if (!plan.settings.aiExists) writes.push({ table: "property_ai_settings", op: "upsert", count: 1, where: "ensurePropertySettings (tenant-hydration)" });
  else skips.push("property_ai_settings ×1 — existente");
  if (!plan.settings.complianceExists) writes.push({ table: "property_compliance_settings", op: "upsert", count: 1, where: "ensurePropertySettings (tenant-hydration) + ensurePropertyTaxes" });
  else skips.push("property_compliance_settings ×1 — existente");
  if (plan.settings.pilotProfile === "create") writes.push({ table: "property_compliance_settings", op: "update", count: 1, where: "configurationJson.pilotProfile" });
  else if (plan.settings.pilotProfile === "skip") skips.push("property_compliance_settings.configurationJson.pilotProfile — igual");
  else conflicts.push("property_compliance_settings · configurationJson.pilotProfile existe con otro contenido (no se sobrescribe)");
  return { writes, skips, conflicts };
}

// ---------------------------------------------------------------------------
// Apply (one transaction)
// ---------------------------------------------------------------------------

type Tx = Prisma.TransactionClient;

export async function applyPlan(tx: Tx, spec: CentreSpec, plan: ProvisionPlan, organizationId: string): Promise<{ propertyId: string; legalEntityId: string | null }> {
  // Legal entity (implicit when the tenant predates the backfill) -----------
  let legalEntityId = plan.legalEntity?.id ?? null;
  if (plan.legalEntity?.action === "create") {
    const created = await createImplicitLegalEntity(tx, { organizationId, organizationName: plan.organization.name, legalName: plan.legalEntity.legalName });
    legalEntityId = created.id;
    plan.legalEntity = { id: created.id, code: created.code, legalName: created.legalName, action: "create" };
  }

  // Property ------------------------------------------------------------------
  let propertyId: string;
  if (plan.property.create) {
    const data: Prisma.PropertyUncheckedCreateInput = { ...plan.property.create, ...(legalEntityId ? { legalEntityId } : {}) };
    propertyId = (await tx.property.create({ data, select: { id: true } })).id;
  } else {
    propertyId = plan.property.existingId!;
    const fill = { ...plan.property.fill, ...(legalEntityId && !plan.property.fill.legalEntityId ? { legalEntityId } : {}) };
    if (Object.keys(fill).length > 0) await tx.property.update({ where: { id: propertyId }, data: fill as Prisma.PropertyUncheckedUpdateInput });
  }

  // Owners --------------------------------------------------------------------
  for (const o of plan.owners.create) {
    await tx.userPropertyRole.upsert({
      where: { userId_propertyId_roleId: { userId: o.userId, propertyId, roleId: o.roleId } },
      update: {},
      create: { userId: o.userId, propertyId, roleId: o.roleId }
    });
  }

  // Departments + memberships (same shape as createTenant) ------------------
  for (const d of plan.departments) {
    const department = await tx.department.upsert({
      where: { propertyId_code: { propertyId, code: d.code } },
      update: {},
      create: { propertyId, code: d.code, name: d.name }
    });
    for (const u of d.users) {
      if (u.action === "skip") continue;
      await tx.userDepartment.upsert({
        where: { userId_departmentId: { userId: u.userId, departmentId: department.id } },
        update: { roleLabel: u.roleLabel, active: true },
        create: { userId: u.userId, departmentId: department.id, roleLabel: u.roleLabel, active: true }
      });
    }
  }

  // Modules (createTenant block: materialise the catalogue row, then enable) --
  for (const m of plan.modules) {
    let moduleId = m.moduleId;
    if (!moduleId) {
      const manifest = HOTEL_MODULES.find((x) => x.code === m.code);
      if (!manifest) throw new Error(`Módulo ${m.code} no está en HOTEL_MODULES.`);
      moduleId = (
        await tx.module.upsert({
          where: { code: m.code },
          update: {},
          create: { code: manifest.code, name: manifest.name, description: manifest.description, category: manifest.category, isCore: manifest.isCore }
        })
      ).id;
    }
    if (m.action === "skip") continue;
    await tx.propertyModule.upsert({
      where: { propertyId_moduleId: { propertyId, moduleId } },
      update: { status: "enabled", enabledAt: new Date(), disabledAt: null },
      create: { propertyId, moduleId, status: "enabled", enabledAt: new Date() }
    });
  }

  // Building + floors + room types + rooms: hotels only (R6) ---------------
  const hotel = isHotelKind(spec.property.kind) && spec.building !== undefined;
  const floorIds = new Map<number, string>();
  let buildingId = plan.building.existingId;
  if (hotel) {
    if (!buildingId && plan.building.create) {
      buildingId = createId("bld");
      await tx.building.create({ data: { id: buildingId, propertyId, name: spec.building!.name, code: spec.building!.code, sortOrder: 1, active: true } });
    }
    for (const f of plan.building.floors) {
      if (f.existingId) {
        floorIds.set(f.floorNumber, f.existingId);
        continue;
      }
      const id = createId("floor");
      await tx.floor.create({
        data: { id, propertyId, buildingId: buildingId!, name: `Planta ${f.floorNumber}`, floorNumber: f.floorNumber, code: `P${f.floorNumber}`, sortOrder: f.floorNumber, active: true }
      });
      floorIds.set(f.floorNumber, id);
    }
  }

  const roomTypeIds = new Map<string, string>();
  for (const [index, t] of plan.roomTypes.entries()) {
    if (t.create) {
      const id = createId("rt");
      await tx.roomType.create({
        data: {
          id,
          propertyId,
          name: t.create.name,
          code: t.create.code,
          maxOccupancy: t.create.maxOccupancy,
          baseCapacity: t.create.baseCapacity,
          defaultRateCategory: t.create.defaultRateCategory,
          sellable: true,
          active: true,
          displayOrder: index + 1
        }
      });
      roomTypeIds.set(t.key, id);
    } else {
      roomTypeIds.set(t.key, t.existingId!);
      if (Object.keys(t.fill).length > 0) await tx.roomType.update({ where: { id: t.existingId! }, data: t.fill as Prisma.RoomTypeUncheckedUpdateInput });
    }
  }

  if (plan.rooms.create.length > 0) {
    const roomTypeItems = hotel ? hotelInventoryOf(spec).roomTypes.items : [];
    await tx.room.createMany({
      data: plan.rooms.create.map((r) => {
        const roomTypeId = roomTypeIds.get(r.roomTypeCode);
        const roomType = roomTypeItems.find((t) => t.code === r.roomTypeCode);
        if (!roomTypeId || !roomType) throw new Error(`Habitación ${r.number}: tipo ${r.roomTypeCode} sin id resuelto.`);
        return {
          propertyId,
          roomTypeId,
          buildingId,
          floorId: floorIds.get(r.floorNumber) ?? null,
          number: r.number,
          maxOccupancy: roomType.maxOccupancy,
          standardOccupancy: roomType.baseCapacity,
          floor: `Planta ${r.floorNumber}`,
          roomCode: `RM${r.number}`,
          displayName: `Room ${r.number}`,
          status: "clean" as const,
          housekeepingStatus: "clean",
          maintenanceStatus: "ok",
          sellable: true,
          active: true,
          sortOrder: Number(r.number) || 0
        };
      })
    });
  }
  // Existing rooms: fill-only capacity convergence (one update per room; ~100 rows, inside the same transaction).
  for (const r of plan.rooms.capacityFill) {
    await tx.room.update({ where: { id: r.roomId }, data: r.fill });
  }

  // Rate plans (rate-plan.service createRatePlan shape) ----------------------
  for (const p of plan.ratePlans) {
    if (p.create) {
      await tx.ratePlan.create({
        data: { propertyId, code: p.create.code, name: p.create.name, ratePlanType: p.create.ratePlanType, mealPlan: p.create.mealPlan, derivationJson: {}, active: true }
      });
    } else if (Object.keys(p.fill).length > 0) {
      await tx.ratePlan.update({ where: { id: p.existingId! }, data: p.fill as Prisma.RatePlanUncheckedUpdateInput });
    }
  }

  // Invoice sequences (patchBillingSettings shape; nextNumber never touched; legalEntityId stamped) --
  for (const s of plan.invoiceSequences) {
    if (s.create) {
      await tx.invoiceSequence.create({
        data: {
          id: createId("seq"),
          propertyId,
          legalEntityId,
          sequenceCode: s.create.sequenceCode.toUpperCase(),
          prefix: s.create.prefix,
          nextNumber: 1,
          padding: s.create.padding,
          invoiceType: s.create.invoiceType,
          active: true,
          year: s.create.year
        }
      });
    } else if (Object.keys(s.fill).length > 0) {
      await tx.invoiceSequence.update({ where: { id: s.existingId! }, data: s.fill as Prisma.InvoiceSequenceUncheckedUpdateInput });
    }
  }

  // Compliance profile (compliance-center updateComplianceProfile columns) ---
  const { columns } = splitProfile(spec.profile);
  if (plan.profile.create) {
    await tx.compliancePropertyProfile.create({ data: { ...(columns as Omit<Prisma.CompliancePropertyProfileUncheckedCreateInput, "propertyId">), propertyId } });
  } else if (Object.keys(plan.profile.fill).length > 0) {
    await tx.compliancePropertyProfile.update({ where: { propertyId }, data: plan.profile.fill as Prisma.CompliancePropertyProfileUncheckedUpdateInput });
  }

  return { propertyId, legalEntityId };
}

// ---------------------------------------------------------------------------
// Post-conditions, counts, audit
// ---------------------------------------------------------------------------

export type PostCondition = { check: string; expected: number; actual: number; ok: boolean };

export async function countsFor(propertyId: string, db: Db = prisma): Promise<Record<string, number>> {
  const [rooms, roomsWithoutCapacity, roomTypes, userPropertyRoles, propertyModulesEnabled, invoiceSequences, ratePlans] = await Promise.all([
    db.room.count({ where: { propertyId, sellable: true } }),
    db.room.count({ where: { propertyId, OR: [{ maxOccupancy: null }, { standardOccupancy: null }] } }),
    db.roomType.count({ where: { propertyId } }),
    db.userPropertyRole.count({ where: { propertyId } }),
    db.propertyModule.count({ where: { propertyId, status: "enabled" } }),
    db.invoiceSequence.count({ where: { propertyId } }),
    db.ratePlan.count({ where: { propertyId } })
  ]);
  return { properties: 1, rooms, roomsWithoutCapacity, roomTypes, userPropertyRoles, propertyModulesEnabled, invoiceSequences, ratePlans };
}

function stripNotes(spec: CentreSpec): Record<string, unknown> {
  const { _notes: _ignored, ...rest } = spec;
  return rest;
}

export type ApplyResult = {
  propertyId: string;
  legalEntityId: string | null;
  countsAfter: Record<string, number>;
  postConditions: PostCondition[];
  auditEventId: string;
};

/**
 * Write a built plan: one transaction, then ensurePropertySettings (global
 * client, own tax provisioning) and the pilotProfile blob, post-conditions,
 * one PROPERTY_PROVISIONED audit event, in-memory property mirror. The caller
 * decides about the audit chain hydration (the CLI hydrates first; the API
 * server is already hydrated).
 */
export async function applyProvisionPlan(input: {
  spec: CentreSpec;
  plan: ProvisionPlan;
  organizationId: string;
  actor: { userId: string; actorType: "user" | "system"; deviceId?: string };
  correlationId: string;
  planSummary?: PlanSummary;
}): Promise<ApplyResult> {
  const { spec, plan, organizationId } = input;
  const planSummary = input.planSummary ?? summarizePlan(plan);
  const { propertyId, legalEntityId } = await prisma.$transaction((tx) => applyPlan(tx, spec, plan, organizationId), TX_OPTIONS);

  // Settings rows through the shared provisioning helper (global client, own
  // tax provisioning with its own error reporting) — after the commit so the
  // property row is visible to it. Idempotent: a re-run converges.
  await ensurePropertySettings(propertyId);
  if (plan.settings.pilotProfile === "create") {
    const row = await prisma.propertyComplianceSetting.findUnique({ where: { propertyId }, select: { configurationJson: true } });
    if (!row) throw new Error(`property_compliance_settings no existe para ${propertyId} tras ensurePropertySettings.`);
    const cfg = (row.configurationJson ?? {}) as Record<string, unknown>;
    if (cfg.pilotProfile === undefined) {
      const { pilotProfile } = splitProfile(spec.profile);
      await prisma.propertyComplianceSetting.update({
        where: { propertyId },
        data: { configurationJson: { ...cfg, pilotProfile } as Prisma.InputJsonValue }
      });
    }
  }

  const countsAfter = await countsFor(propertyId);
  const hotel = isHotelKind(spec.property.kind);
  const postConditions: PostCondition[] = [
    ...(hotel && spec.totalRooms !== undefined
      ? [
          { check: "rooms sellable", expected: spec.totalRooms, actual: countsAfter.rooms! },
          { check: "rooms sin capacidad (max/standard NULL)", expected: 0, actual: countsAfter.roomsWithoutCapacity! },
          { check: "room_types", expected: spec.roomTypes?.items.length ?? 0, actual: countsAfter.roomTypes! }
        ]
      : [{ check: "rooms (centro no alojativo)", expected: 0, actual: countsAfter.rooms! }]),
    { check: "user_property_roles", expected: spec.owners.length, actual: countsAfter.userPropertyRoles! },
    { check: "property_modules enabled", expected: spec.modules.length, actual: countsAfter.propertyModulesEnabled! },
    { check: "invoice_sequences", expected: spec.invoiceSequences.length, actual: countsAfter.invoiceSequences! }
  ].map((c) => ({ ...c, ok: c.expected === c.actual }));

  const event = recordAuditEvent({
    organizationId,
    propertyId,
    actorUserId: input.actor.userId,
    actorType: input.actor.actorType,
    action: AUDIT_ACTION,
    entityType: "property",
    entityId: propertyId,
    beforeJson: { counts: plan.countsBefore },
    afterJson: {
      spec: stripNotes(spec),
      plan: planSummary.writes,
      counts: countsAfter,
      postConditions,
      legalEntityId,
      code: plan.code?.value ?? null,
      kind: spec.property.kind
    },
    deviceId: input.actor.deviceId,
    correlationId: input.correlationId
  });

  const row = await prisma.property.findUnique({ where: { id: propertyId } });
  if (row) mirrorProperty(row);
  return { propertyId, legalEntityId, countsAfter, postConditions, auditEventId: event.id };
}

// ---------------------------------------------------------------------------
// Product route: POST /legal-entities/:legalEntityId/properties
// ---------------------------------------------------------------------------

export type ProvisionCentreResult = {
  dryRun: boolean;
  legalEntity: { id: string; code: string; legalName: string };
  property: { id: string | null; name: string; kind: PropertyKind; code: string; existed: boolean };
  plan: PlanSummary;
  series: Array<{ sequenceCode: string; year: number; prefix: string; prefixSource: "spec" | "default"; clash: { propertyId: string; sequenceId: string } | null }>;
  /** Series whose prefix a sister centre already uses (409 SERIES_PREFIX_CLASH on apply). */
  prefixClash: Array<{ sequenceCode: string; year: number; prefix: string; conflictingPropertyId: string; conflictingSequenceId: string }>;
  applied: (ApplyResult & { establishment: ReturnType<typeof toEstablishmentDto> }) | null;
};

/**
 * Alta de centro from the product. `dryRun: true` validates in the wizard
 * (plan, resolved prefixes, clashes, code) and writes nothing. On apply: 409
 * PROPERTY_NAME_IN_USE (a centre of that name exists — the product never
 * converges silently), 409 CODE_IN_USE, 409 SERIES_PREFIX_CLASH; owners
 * default to the caller's roles in their active property so the creator can
 * switch to the new centre.
 */
export async function provisionCentre(input: {
  context: UserContext;
  legalEntityId: string;
  body: CentreSpec & { dryRun?: boolean };
  correlationId: string;
}): Promise<ProvisionCentreResult> {
  requirePermissions(input.context, [...STRUCTURE_MANAGE]);
  const entity = await requireLegalEntity(input.context, input.legalEntityId);
  const { dryRun, ...rawSpec } = input.body;
  let spec: CentreSpec = rawSpec;
  if (spec.owners.length === 0) {
    const callerRoles = await prisma.userPropertyRole.findMany({ where: { userId: input.context.userId, propertyId: input.context.propertyId }, select: { roleId: true } });
    const owners = [...new Set(callerRoles.map((r) => r.roleId))].map((roleId) => ({ userId: input.context.userId, roleId }));
    spec = { ...spec, owners };
  }
  if (spec.departments.length === 0 && spec.owners.length > 0) {
    spec = { ...spec, departments: [{ code: "MGMT", name: "Management", users: spec.owners.map((o) => ({ userId: o.userId, roleLabel: "owner" })) }] };
  }
  try {
    validateCentreSpec(spec);
  } catch (error) {
    // Cross-field spec errors are client errors (400) with the Spanish message of the rule.
    const bad = new BadRequestError((error as Error).message);
    bad.details = { code: "VALIDATION_ERROR" };
    throw bad;
  }
  const plan = await buildPlan(spec, entity.organizationId);
  const summary = summarizePlan(plan);
  const series = plan.invoiceSequences.map((s) => ({
    sequenceCode: s.key.split("/")[0]!,
    year: Number(s.key.split("/")[1]),
    prefix: s.create?.prefix ?? (s.fill.prefix as string | undefined) ?? "",
    prefixSource: s.prefixSource ?? "spec",
    clash: s.clashRow ? { propertyId: s.clashRow.propertyId, sequenceId: s.clashRow.id } : null
  }));
  const prefixClash = plan.invoiceSequences
    .filter((s) => s.clashRow)
    .map((s) => ({
      sequenceCode: s.key.split("/")[0]!,
      year: Number(s.key.split("/")[1]),
      prefix: s.create?.prefix ?? "",
      conflictingPropertyId: s.clashRow!.propertyId,
      conflictingSequenceId: s.clashRow!.id
    }));
  const result: ProvisionCentreResult = {
    dryRun: dryRun === true,
    legalEntity: { id: entity.id, code: entity.code, legalName: entity.legalName },
    property: { id: plan.property.existingId, name: spec.property.name, kind: spec.property.kind, code: plan.code?.value ?? "", existed: plan.property.existingId !== null },
    plan: summary,
    series,
    prefixClash,
    applied: null
  };
  if (dryRun === true) return result;

  if (plan.property.existingId) {
    throw new ConflictError(`Ya existe un centro llamado «${spec.property.name}» en esta organización.`, {
      code: "PROPERTY_NAME_IN_USE" satisfies StructureErrorCode,
      propertyId: plan.property.existingId
    });
  }
  if (plan.code?.inUse) throw codeInUse("property", plan.code.value);
  const firstClash = plan.invoiceSequences.find((s) => s.clashRow);
  if (firstClash?.clashRow) {
    throw seriesPrefixClashError(firstClash.clashRow, { propertyId: "__new_centre__", prefix: firstClash.create?.prefix ?? "", year: Number(firstClash.key.split("/")[1]) });
  }
  const applied = await applyProvisionPlan({
    spec,
    plan,
    organizationId: entity.organizationId,
    actor: { userId: input.context.userId, actorType: "user", deviceId: input.context.deviceId },
    correlationId: input.correlationId,
    planSummary: summary
  });
  const row = await prisma.property.findUniqueOrThrow({ where: { id: applied.propertyId } });
  return { ...result, property: { ...result.property, id: applied.propertyId }, applied: { ...applied, establishment: toEstablishmentDto(row) } };
}

// ---------------------------------------------------------------------------
// PATCH /properties/:propertyId/establishment
// ---------------------------------------------------------------------------

/**
 * Ficha del centro: kind, code, tradeName and census columns — never the NIF
 * nor the razón social. A hotel with rooms or room types cannot become an
 * office / other centre (409 PROPERTY_KIND_CHANGE_BLOCKED, R10.6); a code must
 * be unique inside the legal entity (409 CODE_IN_USE).
 */
export async function patchEstablishment(input: { context: UserContext; propertyId: string; patch: EstablishmentPatchInput; correlationId: string }) {
  requirePermissions(input.context, [...STRUCTURE_MANAGE]);
  const current = await prisma.property.findUnique({ where: { id: input.propertyId } });
  if (!current || current.organizationId !== input.context.organizationId) throw new NotFoundError("Propiedad no encontrada.");

  const data: Prisma.PropertyUncheckedUpdateInput = {};
  const { kind, code, ...rest } = input.patch;
  if (kind !== undefined && kind !== current.kind) {
    if (!isHotelKind(kind)) {
      const [rooms, roomTypes] = await Promise.all([prisma.room.count({ where: { propertyId: current.id } }), prisma.roomType.count({ where: { propertyId: current.id } })]);
      if (rooms > 0 || roomTypes > 0) {
        throw new ConflictError(
          `«${current.name}» tiene ${rooms} habitación(es) y ${roomTypes} tipo(s) de habitación: un centro de tipo ${kind === "office" ? "oficina" : "otro"} no puede tener inventario alojativo (R6).`,
          { code: "PROPERTY_KIND_CHANGE_BLOCKED" satisfies StructureErrorCode, rooms, roomTypes, currentKind: current.kind, requestedKind: kind }
        );
      }
      // A non-lodging centre never sends SES partes.
      data.sesHospedajesEnabled = false;
    }
    data.kind = kind;
  }
  if (code !== undefined && code !== current.code) {
    const clash = await prisma.property.findFirst({
      where: {
        code,
        id: { not: current.id },
        ...(current.legalEntityId ? { OR: [{ legalEntityId: current.legalEntityId }, { legalEntityId: null, organizationId: current.organizationId }] } : { organizationId: current.organizationId })
      },
      select: { id: true }
    });
    if (clash) throw codeInUse("property", code);
    data.code = code;
  }
  for (const [field, value] of Object.entries(rest)) if (value !== undefined) (data as Record<string, unknown>)[field] = value;
  if (Object.keys(data).length === 0) return toEstablishmentDto(current);

  const updated = await prisma.property.update({ where: { id: current.id }, data });
  recordAuditEvent({
    organizationId: current.organizationId,
    propertyId: current.id,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "ESTABLISHMENT_UPDATED",
    entityType: "property",
    entityId: current.id,
    beforeJson: toEstablishmentDto(current),
    afterJson: toEstablishmentDto(updated),
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });
  mirrorProperty(updated);
  return toEstablishmentDto(updated);
}
