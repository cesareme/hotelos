// Pilot property provisioning CLI (Faranda · second pilot hotel).
//
// The API has no route to add a property to an EXISTING organisation:
// createTenant (admin-console) creates org + property + owner from scratch and
// bootstrapPilot targets a fresh tenant too. Faranda Hotels & Resorts already
// exists (Rías Altas), so the second hotel — Los Tilos — must be provisioned
// with the same satellites those flows create (user_property_roles,
// departments, settings rows, property_modules, buildings/floors, room types,
// rooms, rate plans, invoice sequences, compliance profile) but attached to the
// existing organisation, its existing Owner role and its existing user.
//
// Driven by a JSON spec (src/scripts/specs/*.json) so the operator reviews
// every value before writing. Idempotent: the property is located by
// (organizationId, name); an existing property CONVERGES — null fields are
// filled, equal fields are skipped, and a field holding a DIFFERENT value is
// reported as a conflict (never overwritten; conflicts block --apply).
// Satellites are matched by their natural keys (code / number / unique) and
// only ever created or filled — nothing is deleted.
//
// Usage (from apps/api, DATABASE_URL in env or ../../.env):
//   node --env-file-if-exists=../../.env --import tsx src/scripts/provision-pilot-property.ts \
//     --spec src/scripts/specs/faranda-los-tilos.json [--dry-run | --apply --confirm <organizationId>] [--json]
//
//   --spec <file>        spec JSON (required)
//   --dry-run            (default) print the plan per table, write nothing
//   --apply              write, inside one transaction; requires --confirm
//   --confirm <orgId>    exact organisation id of the spec — guards against
//                        applying a spec to the wrong database
//   --json               machine-readable summary
//   --help / -h          print this usage and exit 0
//
// Rooms carry their own max_occupancy / standard_occupancy (prop_123 fills
// them; the booking engine and the rooming list read them): new rooms take
// them from the room type (maxOccupancy / baseCapacity) and existing rooms
// with NULL capacities are converged the same way (never overwritten).
//
// Writes go through Prisma (never psql) inside a single transaction, followed
// by ensurePropertySettings (tenant-hydration.ts, outside the transaction
// because it uses the global client and its own tax provisioning) and one
// PROPERTY_PROVISIONED audit event through audit.service so the change is
// chained in the trail. In-memory tenant mirrors are only hydrated at boot:
// the operator restarts the API afterwards.
//
// Exit codes: 0 ok · 1 failure (spec invalid, org/user/role missing,
// conflicts, post-condition mismatch, DB error) · 2 unknown flag / usage.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import { z } from "zod";
import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { normalizeTaxRegion } from "@hotelos/compliance";
import { HOTEL_MODULES } from "@hotelos/product";
import { createId } from "../lib/ids.js";
import { formatPlannedWrites, type PlannedWrite } from "../../../../packages/database/prisma/lib/demo-guard.js";

export const CORRELATION_ID = "corr_pilot_los_tilos";
export const SYSTEM_USER_ID = "usr_system_pilot_provision";
export const AUDIT_ACTION = "PROPERTY_PROVISIONED";
/** Same window as refresh-demo-dataset: ~100 rows per satellite, one property. */
const TX_OPTIONS = { maxWait: 30_000, timeout: 600_000 } as const;

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

export type ProvisionFlags = { spec: string; apply: boolean; confirm: string | null; json: boolean; help: boolean };

export const USAGE = [
  "Uso (desde apps/api, DATABASE_URL en el entorno o ../../.env):",
  "  node --env-file-if-exists=../../.env --import tsx src/scripts/provision-pilot-property.ts \\",
  "    --spec src/scripts/specs/<hotel>.json [--dry-run | --apply --confirm <organizationId>] [--json]",
  "",
  "  --spec <file>        spec JSON (obligatorio)",
  "  --dry-run            (por defecto) imprime el plan por tabla, no escribe nada",
  "  --apply              escribe, en una sola transacción; exige --confirm",
  "  --confirm <orgId>    id exacto de la organización del spec (guarda contra aplicar el spec a otra BD)",
  "  --json               resumen legible por máquina",
  "  --help, -h           esta ayuda",
  "",
  "Códigos de salida: 0 ok · 1 fallo (spec inválido, org/usuario/rol ausente, conflictos, post-condición, BD) · 2 flag desconocido / uso."
].join("\n");

export function parseFlags(argv: readonly string[]): ProvisionFlags {
  const flags: ProvisionFlags = { spec: "", apply: false, confirm: null, json: false, help: false };
  let sawDryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // --help wins over everything else (also over a missing --spec): the
    // operator asking for usage must never get a validation error instead.
    if (arg === "--help" || arg === "-h") return { ...flags, help: true };
    if (arg === "--dry-run") sawDryRun = true;
    else if (arg === "--apply") flags.apply = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--spec" || arg === "--confirm") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`Flag "${arg}" requires a value.`);
      if (arg === "--spec") flags.spec = v;
      else if (flags.confirm !== null) throw new Error("--confirm may be given only once (one spec = one organisation).");
      else flags.confirm = v;
      i++;
    } else if (arg === "--") continue;
    else throw new Error(`Unknown flag "${arg}". Known: --spec <file>, --dry-run, --apply, --confirm <orgId>, --json, --help.`);
  }
  if (sawDryRun && flags.apply) throw new Error("--dry-run and --apply are mutually exclusive.");
  if (!flags.spec) throw new Error("--spec <file> is required.");
  if (flags.apply && flags.confirm === null) throw new Error("--apply requires --confirm <organizationId> (the organizationId of the spec).");
  if (!flags.apply && flags.confirm !== null) throw new Error("--confirm only makes sense with --apply.");
  return flags;
}

/** --confirm must name exactly the organisation of the spec (typo / wrong DB guard). */
export function assertConfirmMatches(flags: ProvisionFlags, organizationId: string): void {
  if (!flags.apply) return;
  if (flags.confirm !== organizationId) {
    throw new Error(`--confirm "${flags.confirm}" does not match the spec organizationId "${organizationId}". Nothing written.`);
  }
}

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

const FISCAL_TERRITORIES = ["common", "bizkaia", "gipuzkoa", "araba", "navarra"] as const;
const HOTEL_MODULE_CODES = new Set<string>(HOTEL_MODULES.map((m) => m.code));
const nonEmpty = z.string().trim().min(1);

const SpecSchema = z.object({
  _notes: z.unknown().optional(),
  organizationId: nonEmpty,
  property: z.object({
    name: nonEmpty,
    legalName: nonEmpty.nullable().default(null),
    address: nonEmpty.nullable().default(null),
    municipality: nonEmpty.nullable().default(null),
    province: nonEmpty.nullable().default(null),
    country: nonEmpty.default("ES"),
    postalCode: nonEmpty.nullable().default(null),
    ineMunicipalityCode: nonEmpty.nullable().default(null),
    taxRegion: nonEmpty.nullable().default(null),
    fiscalTerritory: z.enum(FISCAL_TERRITORIES).nullable().default(null),
    timezone: nonEmpty.default("Europe/Madrid"),
    sesHospedajesEnabled: z.boolean().default(false),
    verifactuEnabled: z.boolean().default(false)
  }),
  profile: z
    .object({
      hotelType: nonEmpty.nullable().default(null),
      autonomousCommunity: nonEmpty.nullable().default(null),
      hasRestaurant: z.boolean().default(false),
      hasKitchen: z.boolean().default(false),
      hasPool: z.boolean().default(false),
      hasSpa: z.boolean().default(false),
      hasParking: z.boolean().default(false),
      hasEvents: z.boolean().default(false),
      hasTerrace: z.boolean().default(false),
      hasLaundry: z.boolean().default(false),
      buildingProtected: z.boolean().default(false)
    })
    .passthrough(),
  owners: z.array(z.object({ userId: nonEmpty, roleId: nonEmpty })).min(1),
  modules: z.array(nonEmpty).min(1),
  building: z.object({ name: nonEmpty, code: nonEmpty, floors: z.number().int().min(1).max(50) }),
  totalRooms: z.number().int().min(1),
  roomTypes: z.object({
    _estimated: z.boolean().optional(),
    _estimatedReason: z.string().optional(),
    items: z
      .array(
        z.object({
          code: nonEmpty,
          name: nonEmpty,
          baseCapacity: z.number().int().min(1),
          maxOccupancy: z.number().int().min(1),
          count: z.number().int().min(0),
          defaultRateCategory: nonEmpty.nullable().default(null)
        })
      )
      .min(1)
  }),
  /** Optional explicit rooming list; when absent planRooms derives it deterministically. */
  rooms: z.array(z.object({ number: nonEmpty, roomTypeCode: nonEmpty, floorNumber: z.number().int().optional() })).optional(),
  ratePlans: z.array(z.object({ code: nonEmpty, name: nonEmpty, ratePlanType: nonEmpty, mealPlan: nonEmpty.nullable().default(null) })),
  invoiceSequences: z.array(
    z.object({
      sequenceCode: nonEmpty,
      invoiceType: nonEmpty,
      prefix: nonEmpty,
      year: z.number().int().min(2000).max(2100),
      padding: z.number().int().min(1).max(10).default(6)
    })
  ),
  departments: z.array(z.object({ code: nonEmpty, name: nonEmpty, users: z.array(z.object({ userId: nonEmpty, roleLabel: nonEmpty.nullable().default(null) })).default([]) }))
});

export type PilotSpec = z.infer<typeof SpecSchema>;
export type RoomTypeSpec = PilotSpec["roomTypes"]["items"][number];

/**
 * Postal / INE coherence replicated from backoffice.service.ts
 * (validatePostalCode, validateIneMunicipalityCode, assertPostalAndIneCoherent):
 * importing backoffice.service drags demoStore, audit, auth and invitations
 * into a CLI that must stay unit-testable without a database. Same rules:
 * 5 digits, province prefix 01–52, CP and INE share the province prefix.
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

/** Series ↔ AEAT type rule of patchBillingSettings (assertSeriesCodeMatchesType) + prefix/year agreement. */
export function assertInvoiceSequenceCoherent(seq: { sequenceCode: string; invoiceType: string; prefix: string; year: number }): void {
  const code = seq.sequenceCode.toUpperCase();
  if (!/^[A-Z0-9_-]{1,12}$/.test(code)) throw new Error(`Código de serie no válido («${seq.sequenceCode}»): hasta 12 caracteres alfanuméricos.`);
  if (!/^(F[123]|R[1-5]?)$/.test(seq.invoiceType)) throw new Error(`Tipo de factura no válido («${seq.invoiceType}») en la serie ${code}: F1/F2/F3/R/R1–R5.`);
  const expected: Record<string, RegExp> = { FAC: /^F[13]$/, SIM: /^F2$/, REC: /^R[1-5]?$/ };
  const rule = expected[code];
  if (rule && !rule.test(seq.invoiceType)) throw new Error(`La serie ${code} no admite facturas de tipo ${seq.invoiceType}.`);
  const match = /(?:^|\D)(20\d{2})(?:\D|$)/.exec(seq.prefix);
  if (match && Number(match[1]) !== seq.year) throw new Error(`El prefijo «${seq.prefix}» lleva el año ${match[1]} pero la serie es del ejercicio ${seq.year}.`);
}

/** Parse + cross-field validation of a raw spec object (throws with a Spanish, actionable message). */
export function validateSpec(raw: unknown): PilotSpec {
  const parsed = SpecSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`Spec inválido: ${issues}`);
  }
  const spec = parsed.data;
  assertFiscalLocationCoherent(spec.property.postalCode, spec.property.ineMunicipalityCode);
  if (spec.property.taxRegion !== null && normalizeTaxRegion(spec.property.taxRegion, null) !== spec.property.taxRegion) {
    throw new Error(`Región fiscal no canónica («${spec.property.taxRegion}»): usa el valor canónico (p.ej. ES_PENINSULA_BALEARES).`);
  }
  const unknownModules = spec.modules.filter((code) => !HOTEL_MODULE_CODES.has(code));
  if (unknownModules.length > 0) throw new Error(`Módulos desconocidos en el catálogo HOTEL_MODULES: ${unknownModules.join(", ")}.`);
  if (new Set(spec.modules).size !== spec.modules.length) throw new Error("Módulos repetidos en el spec.");

  const codes = spec.roomTypes.items.map((t) => t.code);
  if (new Set(codes).size !== codes.length) throw new Error("Códigos de tipo de habitación repetidos en el spec.");
  for (const t of spec.roomTypes.items) {
    if (t.maxOccupancy < t.baseCapacity) throw new Error(`Tipo ${t.code}: maxOccupancy (${t.maxOccupancy}) < baseCapacity (${t.baseCapacity}).`);
  }
  const sum = spec.roomTypes.items.reduce((acc, t) => acc + t.count, 0);
  if (sum !== spec.totalRooms) throw new Error(`Σ roomTypes.count = ${sum} ≠ totalRooms = ${spec.totalRooms}.`);
  if (spec.rooms === undefined && spec.totalRooms % spec.building.floors !== 0) {
    throw new Error(`totalRooms (${spec.totalRooms}) no es divisible entre building.floors (${spec.building.floors}); fija «rooms» explícitamente.`);
  }
  for (const seq of spec.invoiceSequences) assertInvoiceSequenceCoherent(seq);
  const seqKeys = spec.invoiceSequences.map((s) => `${s.sequenceCode.toUpperCase()}/${s.year}`);
  if (new Set(seqKeys).size !== seqKeys.length) throw new Error("Series de factura repetidas (sequenceCode + year) en el spec.");
  const planCodes = spec.ratePlans.map((p) => p.code);
  if (new Set(planCodes).size !== planCodes.length) throw new Error("Códigos de plan tarifario repetidos en el spec.");
  // Room list (explicit or derived) must reconcile with the per-type counts.
  const rooms = planRooms(spec);
  const byType = new Map<string, number>();
  for (const r of rooms) byType.set(r.roomTypeCode, (byType.get(r.roomTypeCode) ?? 0) + 1);
  for (const t of spec.roomTypes.items) {
    const n = byType.get(t.code) ?? 0;
    if (n !== t.count) throw new Error(`Numeración: el tipo ${t.code} recibe ${n} habitaciones pero el spec declara count ${t.count}.`);
  }
  for (const code of byType.keys()) if (!codes.includes(code)) throw new Error(`Numeración: tipo de habitación desconocido «${code}».`);
  return spec;
}

export function loadSpec(path: string): PilotSpec {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`No se pudo leer el spec ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateSpec(raw);
}

// ---------------------------------------------------------------------------
// Room numbering
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
 * The result is checked against spec counts by validateSpec: a spec whose
 * counts cannot be honoured by this rule fails loudly instead of silently
 * producing a different inventory.
 */
export function planRooms(spec: Pick<PilotSpec, "building" | "totalRooms" | "roomTypes" | "rooms">): PlannedRoom[] {
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
 * non-empty value is a conflict — the script never overwrites another
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
// Plan
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

export type ProvisionPlan = {
  organization: { id: string; name: string };
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
  ratePlans: Converged<PilotSpec["ratePlans"][number]>[];
  invoiceSequences: (Converged<PilotSpec["invoiceSequences"][number]> & { prefixClash: string | null })[];
  profile: { existingId: string | null; create: boolean; fill: Record<string, unknown>; conflicts: FieldConflict[] };
  settings: { aiExists: boolean; complianceExists: boolean; pilotProfile: "create" | "skip" | "conflict" };
  countsBefore: Record<string, number>;
};

/** Columns of CompliancePropertyProfile (schema.prisma) — everything else in `profile` goes to configurationJson.pilotProfile. */
const PROFILE_COLUMNS = ["autonomousCommunity", "hotelType", "hasRestaurant", "hasKitchen", "hasPool", "hasSpa", "hasParking", "hasEvents", "hasTerrace", "hasLaundry", "buildingProtected"] as const;

export function splitProfile(profile: PilotSpec["profile"]): { columns: Record<string, unknown>; pilotProfile: Record<string, unknown> } {
  const columns: Record<string, unknown> = {};
  const pilotProfile: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(profile)) {
    if ((PROFILE_COLUMNS as readonly string[]).includes(key)) columns[key] = value;
    else pilotProfile[key] = value;
  }
  return { columns, pilotProfile };
}

/** Property columns asserted by the spec (Property.name is the lookup key, not converged). */
function desiredPropertyFields(spec: PilotSpec): Record<string, unknown> {
  const p = spec.property;
  return {
    legalName: p.legalName,
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

export async function buildPlan(spec: PilotSpec): Promise<ProvisionPlan> {
  const organization = await prisma.organization.findUnique({ where: { id: spec.organizationId }, select: { id: true, name: true } });
  if (!organization) throw new Error(`Organización ${spec.organizationId} no encontrada.`);

  // Owners / department users must belong to the organisation; roles are per
  // organisation. A wrong id would otherwise silently grant access across tenants.
  const userIds = [...new Set([...spec.owners.map((o) => o.userId), ...spec.departments.flatMap((d) => d.users.map((u) => u.userId))])];
  const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, organizationId: true, email: true } });
  for (const id of userIds) {
    const u = users.find((x) => x.id === id);
    if (!u) throw new Error(`Usuario ${id} no encontrado.`);
    if (u.organizationId !== spec.organizationId) throw new Error(`Usuario ${id} (${u.email}) pertenece a otra organización (${u.organizationId}).`);
  }
  const roleIds = [...new Set(spec.owners.map((o) => o.roleId))];
  const roles = await prisma.role.findMany({ where: { id: { in: roleIds } }, select: { id: true, organizationId: true, name: true } });
  for (const id of roleIds) {
    const r = roles.find((x) => x.id === id);
    if (!r) throw new Error(`Rol ${id} no encontrado.`);
    if (r.organizationId !== spec.organizationId) throw new Error(`Rol ${id} (${r.name}) pertenece a otra organización (${r.organizationId}).`);
  }

  const existing = await prisma.property.findFirst({ where: { organizationId: spec.organizationId, name: spec.property.name } });
  const propertyId = existing?.id ?? null;
  const desired = desiredPropertyFields(spec);
  const propertyDiff = existing ? diffConverge(existing as unknown as Record<string, unknown>, desired) : { fill: {}, same: [], conflicts: [] };

  const plan: ProvisionPlan = {
    organization,
    property: {
      existingId: propertyId,
      create: existing
        ? null
        : ({ organizationId: spec.organizationId, name: spec.property.name, ...desired } as Prisma.PropertyUncheckedCreateInput),
      fill: propertyDiff.fill,
      conflicts: propertyDiff.conflicts
    },
    owners: { create: [], skip: 0 },
    departments: [],
    modules: [],
    building: { existingId: null, create: true, floors: Array.from({ length: spec.building.floors }, (_, i) => ({ floorNumber: i + 1, existingId: null })) },
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
  const moduleRows = await prisma.module.findMany({ where: { code: { in: spec.modules } }, select: { id: true, code: true } });
  const propertyModules = propertyId ? await prisma.propertyModule.findMany({ where: { propertyId } }) : [];
  for (const code of spec.modules) {
    const row = moduleRows.find((m) => m.code === code) ?? null;
    const pm = row ? propertyModules.find((x) => x.moduleId === row.id) : undefined;
    plan.modules.push({ code, moduleId: row?.id ?? null, materialize: row === null, action: !pm ? "create" : pm.status === "enabled" ? "skip" : "enable" });
  }

  const rooms = planRooms(spec);
  const { columns: profileColumns } = splitProfile(spec.profile);

  if (!existing) {
    plan.owners.create = spec.owners.map((o) => ({ userId: o.userId, roleId: o.roleId }));
    plan.departments = spec.departments.map((d) => ({ code: d.code, name: d.name, existingId: null, users: d.users.map((u) => ({ userId: u.userId, roleLabel: u.roleLabel, action: "create" as const })) }));
    plan.roomTypes = spec.roomTypes.items.map((t) => ({ key: t.code, existingId: null, create: t, fill: {}, conflicts: [] }));
    plan.rooms.create = rooms;
    plan.ratePlans = spec.ratePlans.map((p) => ({ key: p.code, existingId: null, create: p, fill: {}, conflicts: [] }));
    plan.invoiceSequences = spec.invoiceSequences.map((s) => ({ key: `${s.sequenceCode.toUpperCase()}/${s.year}`, existingId: null, create: s, fill: {}, conflicts: [], prefixClash: null }));
    plan.profile = { existingId: null, create: true, fill: {}, conflicts: [] };
    plan.countsBefore = { properties: 0, rooms: 0, roomsWithoutCapacity: 0, roomTypes: 0, userPropertyRoles: 0, propertyModulesEnabled: 0, invoiceSequences: 0, ratePlans: 0 };
  } else {
    const propertyId = existing.id;
    const [uprs, departments, userDepartments, buildings, floors, roomTypes, roomRows, ratePlans, sequences, profile, ai, compliance] = await Promise.all([
      prisma.userPropertyRole.findMany({ where: { propertyId } }),
      prisma.department.findMany({ where: { propertyId } }),
      prisma.userDepartment.findMany({ where: { userId: { in: userIds } } }),
      prisma.building.findMany({ where: { propertyId } }),
      prisma.floor.findMany({ where: { propertyId } }),
      prisma.roomType.findMany({ where: { propertyId } }),
      prisma.room.findMany({ where: { propertyId }, select: { id: true, number: true, roomTypeId: true, sellable: true, maxOccupancy: true, standardOccupancy: true } }),
      prisma.ratePlan.findMany({ where: { propertyId } }),
      prisma.invoiceSequence.findMany({ where: { propertyId } }),
      prisma.compliancePropertyProfile.findUnique({ where: { propertyId } }),
      prisma.propertyAiSetting.findUnique({ where: { propertyId }, select: { id: true } }),
      prisma.propertyComplianceSetting.findUnique({ where: { propertyId }, select: { id: true, configurationJson: true } })
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
    const building = buildings.find((b) => b.code === spec.building.code) ?? null;
    plan.building = {
      existingId: building?.id ?? null,
      create: building === null,
      floors: Array.from({ length: spec.building.floors }, (_, i) => {
        const n = i + 1;
        const fl = building ? floors.find((f) => f.buildingId === building.id && f.floorNumber === n) : undefined;
        return { floorNumber: n, existingId: fl?.id ?? null };
      })
    };
    plan.roomTypes = spec.roomTypes.items.map((t) => {
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
    plan.invoiceSequences = spec.invoiceSequences.map((s) => {
      const code = s.sequenceCode.toUpperCase();
      const row = sequences.find((x) => x.sequenceCode === code && x.year === s.year) ?? null;
      if (!row) return { key: `${code}/${s.year}`, existingId: null, create: s, fill: {}, conflicts: [], prefixClash: null };
      const diff = diffConverge(row as unknown as Record<string, unknown>, { prefix: s.prefix, invoiceType: s.invoiceType, padding: s.padding, active: true });
      return { key: `${code}/${s.year}`, existingId: row.id, create: null, fill: diff.fill, conflicts: diff.conflicts, prefixClash: null };
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

  // Same issuer NIF for every property of the organisation: an invoice
  // number prefix reused by a sister property would collide in the fiscal
  // trail (VeriFactu numbering is per issuer). Reported as a conflict.
  const siblingIds = (await prisma.property.findMany({ where: { organizationId: spec.organizationId, ...(propertyId ? { id: { not: propertyId } } : {}) }, select: { id: true } })).map((p) => p.id);
  if (siblingIds.length > 0) {
    const clashes = await prisma.invoiceSequence.findMany({
      where: { propertyId: { in: siblingIds }, prefix: { in: spec.invoiceSequences.map((s) => s.prefix) } },
      select: { propertyId: true, prefix: true }
    });
    for (const entry of plan.invoiceSequences) {
      const want = spec.invoiceSequences.find((s) => `${s.sequenceCode.toUpperCase()}/${s.year}` === entry.key)!;
      const clash = clashes.find((c) => c.prefix === want.prefix);
      if (clash) entry.prefixClash = `prefijo «${want.prefix}» ya usado por la propiedad ${clash.propertyId}`;
    }
  }
  return plan;
}

export type PlanSummary = { writes: PlannedWrite[]; skips: string[]; conflicts: string[] };

/** Flatten the plan into demo-guard style planned writes + skips + conflicts (dry-run and --json both use it). */
export function summarizePlan(plan: ProvisionPlan): PlanSummary {
  const writes: PlannedWrite[] = [];
  const skips: string[] = [];
  const conflicts: string[] = [];
  const conflictLines = (table: string, key: string, list: FieldConflict[]) => {
    for (const c of list) conflicts.push(`${table} ${key} · ${c.field}: actual ${JSON.stringify(c.current)} ≠ spec ${JSON.stringify(c.desired)}`);
  };

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
  if (plan.building.create) writes.push({ table: "buildings", op: "create", count: 1, where: "Edificio principal" });
  else skips.push(`buildings ×1 — id=${plan.building.existingId}`);
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
// Apply
// ---------------------------------------------------------------------------

type Tx = Prisma.TransactionClient;

async function applyPlan(tx: Tx, spec: PilotSpec, plan: ProvisionPlan): Promise<{ propertyId: string }> {
  // Property ------------------------------------------------------------------
  let propertyId: string;
  if (plan.property.create) {
    propertyId = (await tx.property.create({ data: plan.property.create, select: { id: true } })).id;
  } else {
    propertyId = plan.property.existingId!;
    if (Object.keys(plan.property.fill).length > 0) await tx.property.update({ where: { id: propertyId }, data: plan.property.fill as Prisma.PropertyUncheckedUpdateInput });
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

  // Building + floors (createBuilding / createFloor shapes, prefixed ids) -----
  let buildingId = plan.building.existingId;
  if (!buildingId) {
    buildingId = createId("bld");
    await tx.building.create({ data: { id: buildingId, propertyId, name: spec.building.name, code: spec.building.code, sortOrder: 1, active: true } });
  }
  const floorIds = new Map<number, string>();
  for (const f of plan.building.floors) {
    if (f.existingId) {
      floorIds.set(f.floorNumber, f.existingId);
      continue;
    }
    const id = createId("floor");
    await tx.floor.create({
      data: { id, propertyId, buildingId, name: `Planta ${f.floorNumber}`, floorNumber: f.floorNumber, code: `P${f.floorNumber}`, sortOrder: f.floorNumber, active: true }
    });
    floorIds.set(f.floorNumber, id);
  }

  // Room types (createBackOfficeRoomType shape, rt_ ids) ---------------------
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

  // Rooms (bulkCreateRooms shape: RM<n> / Room <n> / clean / sortOrder n) -----
  if (plan.rooms.create.length > 0) {
    await tx.room.createMany({
      data: plan.rooms.create.map((r) => {
        const roomTypeId = roomTypeIds.get(r.roomTypeCode);
        const roomType = spec.roomTypes.items.find((t) => t.code === r.roomTypeCode);
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

  // Invoice sequences (patchBillingSettings shape; nextNumber never touched) --
  for (const s of plan.invoiceSequences) {
    if (s.create) {
      await tx.invoiceSequence.create({
        data: {
          id: createId("seq"),
          propertyId,
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

  return { propertyId };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export type PostCondition = { check: string; expected: number; actual: number; ok: boolean };

export type ProvisionSummary = {
  dryRun: boolean;
  specPath: string;
  organization: { id: string; name: string };
  property: { name: string; id: string | null; existed: boolean };
  rooms: { total: number; byType: Record<string, number>; sample: string[] };
  plan: PlanSummary;
  countsBefore: Record<string, number>;
  applied: { propertyId: string; countsAfter: Record<string, number>; postConditions: PostCondition[]; auditEventId: string } | null;
  warnings: string[];
  errors: string[];
  durationMs: number;
};

async function countsFor(propertyId: string): Promise<Record<string, number>> {
  const [rooms, roomsWithoutCapacity, roomTypes, userPropertyRoles, propertyModulesEnabled, invoiceSequences, ratePlans] = await Promise.all([
    prisma.room.count({ where: { propertyId, sellable: true } }),
    prisma.room.count({ where: { propertyId, OR: [{ maxOccupancy: null }, { standardOccupancy: null }] } }),
    prisma.roomType.count({ where: { propertyId } }),
    prisma.userPropertyRole.count({ where: { propertyId } }),
    prisma.propertyModule.count({ where: { propertyId, status: "enabled" } }),
    prisma.invoiceSequence.count({ where: { propertyId } }),
    prisma.ratePlan.count({ where: { propertyId } })
  ]);
  return { properties: 1, rooms, roomsWithoutCapacity, roomTypes, userPropertyRoles, propertyModulesEnabled, invoiceSequences, ratePlans };
}

function stripNotes(spec: PilotSpec): Record<string, unknown> {
  const { _notes: _ignored, ...rest } = spec;
  return rest;
}

export async function runProvision(flags: ProvisionFlags): Promise<ProvisionSummary> {
  const start = Date.now();
  const spec = loadSpec(flags.spec);
  assertConfirmMatches(flags, spec.organizationId);
  const plan = await buildPlan(spec);
  const planSummary = summarizePlan(plan);
  const rooms = planRooms(spec);
  const byType: Record<string, number> = {};
  for (const r of rooms) byType[r.roomTypeCode] = (byType[r.roomTypeCode] ?? 0) + 1;

  const summary: ProvisionSummary = {
    dryRun: !flags.apply,
    specPath: flags.spec,
    organization: plan.organization,
    property: { name: spec.property.name, id: plan.property.existingId, existed: plan.property.existingId !== null },
    rooms: { total: rooms.length, byType, sample: [...rooms.slice(0, 3), ...rooms.filter((r) => r.roomTypeCode === "SUI")].map((r) => `${r.number}:${r.roomTypeCode}`) },
    plan: planSummary,
    countsBefore: plan.countsBefore,
    applied: null,
    warnings: [],
    errors: [],
    durationMs: 0
  };
  if (spec.roomTypes._estimated) summary.warnings.push(`Reparto de tipos ESTIMADO: ${spec.roomTypes._estimatedReason ?? "sin explicación en el spec"}`);
  if (planSummary.conflicts.length > 0) {
    summary.errors.push(`${planSummary.conflicts.length} conflictos entre spec y BD: resuélvelos antes de --apply (nunca se sobrescribe).`);
  }
  if (!flags.apply || summary.errors.length > 0) {
    summary.durationMs = Date.now() - start;
    return summary;
  }

  // Hash-chained audit: the in-memory tip must be the Postgres tip BEFORE
  // sealing the new event, otherwise the chain forks.
  const audit = await import("../modules/audit/audit.service.js");
  await audit.hydrateAuditChainFromPostgres();

  const { propertyId } = await prisma.$transaction((tx) => applyPlan(tx, spec, plan), TX_OPTIONS);

  // Settings rows through the shared provisioning helper (global client, own
  // tax provisioning with its own error reporting) — after the commit so the
  // property row is visible to it. Idempotent: a re-run converges.
  const hydration = await import("../lib/tenant-hydration.js");
  await hydration.ensurePropertySettings(propertyId);
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
  const postConditions: PostCondition[] = [
    { check: "rooms sellable", expected: spec.totalRooms, actual: countsAfter.rooms! },
    { check: "rooms sin capacidad (max/standard NULL)", expected: 0, actual: countsAfter.roomsWithoutCapacity! },
    { check: "room_types", expected: spec.roomTypes.items.length, actual: countsAfter.roomTypes! },
    { check: "user_property_roles", expected: spec.owners.length, actual: countsAfter.userPropertyRoles! },
    { check: "property_modules enabled", expected: spec.modules.length, actual: countsAfter.propertyModulesEnabled! }
  ].map((c) => ({ ...c, ok: c.expected === c.actual }));
  for (const c of postConditions) if (!c.ok) summary.errors.push(`Post-condición ${c.check}: esperado ${c.expected}, real ${c.actual}.`);

  const event = audit.recordAuditEvent({
    organizationId: spec.organizationId,
    propertyId,
    actorUserId: SYSTEM_USER_ID,
    actorType: "system",
    action: AUDIT_ACTION,
    entityType: "property",
    entityId: propertyId,
    beforeJson: { counts: plan.countsBefore },
    afterJson: { spec: stripNotes(spec), plan: planSummary.writes, counts: countsAfter, postConditions },
    correlationId: CORRELATION_ID
  });
  await audit.flushAuditQueues();

  summary.property.id = propertyId;
  summary.applied = { propertyId, countsAfter, postConditions, auditEventId: event.id };
  summary.durationMs = Date.now() - start;
  return summary;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export function printHuman(summary: ProvisionSummary): void {
  const lines: string[] = [];
  lines.push(`[pilot:provision-property] ${summary.dryRun ? "DRY-RUN (no writes)" : "APPLIED"} · spec ${summary.specPath} · ${summary.durationMs} ms`);
  lines.push(`  Organización: ${summary.organization.name} (${summary.organization.id})`);
  lines.push(`  Propiedad: «${summary.property.name}» → ${summary.property.existed ? `EXISTE (${summary.property.id}), converge` : summary.property.id ? `CREADA ${summary.property.id}` : "NUEVA (se creará)"}`);
  lines.push(`  Habitaciones planificadas: ${summary.rooms.total} · ${Object.entries(summary.rooms.byType).map(([c, n]) => `${c}=${n}`).join(" · ")} · muestra ${summary.rooms.sample.join(", ")}`);
  lines.push(`  Escrituras previstas por tabla (${summary.plan.writes.length}):`);
  lines.push(...formatPlannedWrites(summary.plan.writes));
  lines.push(`  Sin cambios (${summary.plan.skips.length}):`);
  for (const s of summary.plan.skips) lines.push(`  ${"skip".padEnd(10)} ${s}`);
  if (summary.plan.skips.length === 0) lines.push("  (nada que saltar: propiedad nueva)");
  lines.push(`  Conflictos (${summary.plan.conflicts.length}):`);
  for (const c of summary.plan.conflicts) lines.push(`  ${"CONFLICT".padEnd(10)} ${c}`);
  if (summary.plan.conflicts.length === 0) lines.push("  (ninguno)");
  lines.push(`  Conteos antes: ${Object.entries(summary.countsBefore).map(([t, n]) => `${t}=${n}`).join(" · ")}`);
  if (summary.applied) {
    lines.push(`  Conteos después: ${Object.entries(summary.applied.countsAfter).map(([t, n]) => `${t}=${n}`).join(" · ")}`);
    lines.push("  Post-condiciones:");
    for (const c of summary.applied.postConditions) lines.push(`    ${c.ok ? "OK  " : "FAIL"} ${c.check}: ${c.actual} (esperado ${c.expected})`);
    lines.push(`  Audit ${AUDIT_ACTION} ${summary.applied.auditEventId} · correlation ${CORRELATION_ID}`);
  }
  for (const w of summary.warnings) lines.push(`  WARN ${w}`);
  for (const e of summary.errors) lines.push(`  ERROR ${e}`);
  if (summary.dryRun) {
    lines.push(`  Nada escrito. Repite con --apply --confirm ${summary.organization.id} (haz backup antes: bash scripts/backup-postgres.sh).`);
  } else if (summary.applied) {
    lines.push("  Reinicia el API (:3400/:3000): los espejos de tenants solo se cargan al arrancar.");
    lines.push(
      `  Siguiente paso, SOLO tras reiniciar: corepack pnpm --filter @hotelos/api import:pms-history-forecast -- --property ${summary.applied.propertyId} --file <tilos-history-forecast.csv> --source opera_hf_2026-09-14 --publish-bar BAR (dry-run por defecto; --apply --confirm ${summary.applied.propertyId})`
    );
  }
  console.log(lines.join("\n"));
}

const entryFile = resolvePath(fileURLToPath(import.meta.url));
const argFile = process.argv[1] ? resolvePath(process.argv[1]) : "";
if (entryFile === argFile) {
  let flags: ProvisionFlags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (error) {
    console.error(`[pilot:provision-property] ${(error as Error).message}`);
    process.exit(2);
  }
  if (flags.help) {
    console.log(USAGE);
    process.exit(0);
  }
  runProvision(flags)
    .then(async (summary) => {
      if (flags.json) console.log(JSON.stringify(summary, null, 2));
      else printHuman(summary);
      await prisma.$disconnect();
      return summary.errors.length;
    })
    .then((failed) => process.exit(failed > 0 ? 1 : 0))
    .catch(async (error) => {
      console.error("[pilot:provision-property] failed:", error);
      await prisma.$disconnect().catch(() => undefined);
      process.exit(1);
    });
}
