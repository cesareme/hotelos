// Faranda → CELUISMA S.A. migration CLI (Tanda 6b · L8 · estructura societaria).
//
// Orchestrates the eleven steps of docs/design/FINANZAS-ESTRUCTURA-SOCIETARIA.md
// §5.5 for the Faranda organisation (cmrhw9jy30002fyvb6tsdiugt) REUSING the
// services of the structure layer — this file plans and sequences, it does not
// re-implement them:
//
//   1  Preconditions (read-only): organisation, default sociedad, RA + LT coded,
//      backfill post-conditions (backfill-legal-structure.ts verifyOrganization),
//      VERIFACTU_MODE, fiscal invariants snapshot (invoices, envíos, asientos).
//   2  Sociedad: FAR «Faranda Hotels & Resorts» B99999997 → CEL «CELUISMA S.A.»
//      A33615980, legalForm sa, CNAE 5510. Domicilio FISCAL and domicilio SOCIAL
//      are PARAMETRISED and NEVER defaulted (--fiscal-address gijon|madrid|florida,
//      --registered-office idem, default = fiscal): the public sources disagree
//      (Empresia: «PORTUGAL, 7 33207 GIJON», RM de Madrid, previous address
//      C/ General Ampudia 8 Madrid until 2014; eInforma: «PASEO FLORIDA, 5 28008
//      MADRID», RM de Madrid) and an RM de Madrid inscription is incompatible with
//      a domicilio social in Gijón, so without the flags the 9 address columns are
//      left untouched (dry-run) and --apply refuses to run (exit 2) until César
//      confirms with the 036 / escrituras.
//      → modules/structure/legal-entity.service.ts patchLegalEntity (high-risk
//      fields with confirmHighRisk, audit LEGAL_ENTITY_UPDATED, warnings with the
//      series blocked by the NIF change). Regime (pgcVariant, largeCompany,
//      siiEnabled, fiscalYearStartMonth) is NOT touched: open decision of César
//      (public data: 62 employees in 2024 → PGC general probable).
//   3  Existing centres: census columns of RA / LT (starRating, plazas, registro
//      turístico: REAT H-CO-000713 · 196 plazas and H-CO-001327 · 176) fill-only
//      → patchEstablishment. Nothing else changes (codes RA / LT and tradeName came
//      from the backfill; the 120 demo rooms of RA vs 103 real are an open item).
//   4  Oficina central: specs/faranda-oficina-central.json (kind office, code OC,
//      no rooms, no series; address PARAMETRISED --office-city madrid|gijon|florida)
//      → property-provisioning.service.ts buildPlan / applyProvisionPlan.
//      Existing centres are identified by the natural key (legalEntityId, code)
//      — the unique index properties_legal_entity_id_code_key — and by name only
//      as a fallback, so renaming a centre (PATCH establishment) never turns a
//      converged spec back into a NEW centre / code clash.
//   5  Five hotels: specs/faranda-{pathos-gijon,marsol-candas,alisas-santander,
//      florida-norte,las-lomas}.json (codes PG MC AS FN LL; series
//      FAC-<COD>-2026- / REC-<COD>-2026- / FS-<COD>-2026-), same service, each in
//      its own transaction; --skip-hotels PG,MC excludes centres.
//      Before 4-5: cross-batch check of centre codes and series prefixes against
//      the ACTIVE series of the sociedad (backfill detectPrefixClashes): 0 clashes
//      or nothing is applied.
//   6  Series of Rías Altas: FAC-2026- / REC-2026- (sandbox, three test NIFs)
//      → active = false and sequence_code FAC-SANDBOX / REC-SANDBOX (frees the key
//      (propertyId, sequenceCode, year); prefix, nextNumber and padding untouched
//      — NOTHING is renumbered); then FAC-RA-2026- / REC-RA-2026- / FS-RA-2026-
//      opened through backoffice.service.ts patchBillingSettings (advisory lock,
//      SERIES_PREFIX_CLASH guard, audit InvoiceSequenceCreated).
//   7  IVA y ejercicio: NO write. VatSettings, FiscalYear 2026, SII / gran empresa
//      / PGC and the residual sii_enabled of RA are decisions of César (informe §8
//      filas 5-6): reported as open items.
//   8  VeriFactu: policy per_center (already the sociedad's). Design §5.5 step 8:
//      the installation of a hotel is opened «al activar cada hotel», so a centre
//      with verifactuEnabled = false gets NOTHING here (deferred; RA keeps DEV-001,
//      the office bills nothing). A hotel already enabled and without an active
//      installation gets the sandbox filler `DEV-001-<COD>` (SANDBOX_INSTALL_NUMBER
//      + code, backfill convention) ONLY while VERIFACTU_MODE = sandbox; the
//      opt-in --sandbox-installations extends the filler to the disabled hotels
//      (demo convenience; every filler is a permanent, immutable row to retire
//      before preproduction). Outside sandbox nothing is opened (the real
//      numbers of the registro del productor are César's).
//   9  Contabilidad: read-only check — 0 posted entries without work centre.
//  10  Personas: Carmen (Owner, accounting.entity.read + organization.structure.manage)
//      gets her role in every new centre through the specs' `owners`; the
//      Owner role permissions are verified, nothing else is written.
//  11  Verification: 8 centres (mode multi_center), series per centre, 0 prefix
//      clashes, 0 series blocked by the new NIF, backfill post-conditions OK,
//      fiscal invariants identical (25 invoices · 33 envíos · 61 asientos).
//
// Usage (from apps/api, DATABASE_URL in env or ../../.env):
//   node --env-file-if-exists=../../.env --import tsx src/scripts/migrate-faranda-celuisma.ts \
//     [--dry-run | --apply --confirm cmrhw9jy30002fyvb6tsdiugt --fiscal-address gijon|madrid|florida] \
//     [--registered-office gijon|madrid|florida] [--office-city madrid|gijon|florida] \
//     [--sandbox-installations] [--skip-hotels PG,MC] [--json] [--print-rollback]
//
//   --dry-run              (default) print the whole plan step by step with counts and clashes; write nothing
//   --apply                write, step by step (each step = its own transaction / service call); requires
//                          --confirm AND --fiscal-address (exit 2 otherwise)
//   --confirm <orgId>      exact Faranda organisation id — guards against another database
//   --fiscal-address       domicilio fiscal of the sociedad: gijon | madrid | florida — NO default («confirmar»)
//   --registered-office    domicilio social: gijon | madrid | florida (default = --fiscal-address)
//   --office-city          where the oficina central is (default madrid; «confirmar»)
//   --sandbox-installations open the sandbox filler DEV-001-<COD> also for hotels with verifactuEnabled = false
//   --skip-hotels <codes>  comma-separated centre codes to leave out (PG, MC, AS, FN, LL)
//   --json                 machine-readable summary
//   --print-rollback       read-only: list what --apply wrote (audit trail, correlation
//                          corr_faranda_celuisma_l8) and how to undo it; never writes
//   --help, -h             this usage
//
// Every exit of --apply (happy path, failed step, unexpected error) flushes the
// audit queue (step marks + the services' LEGAL_ENTITY_UPDATED /
// PROPERTY_PROVISIONED / InvoiceSequenceCreated / VERIFACTU_INSTALLATION_OPENED)
// to Postgres before disconnecting, so --print-rollback sees a partial apply.
//
// Idempotent: every step converges (a second run plans 0 writes). Reversible:
// see printRollback / runbook §17.13 — the sociedad patch is reversed with the
// beforeJson of its LEGAL_ENTITY_UPDATED event, the new centres are archived
// (status archived; never deleted once they carry invoices or installations,
// trigger R10.5), the filler installations are retired (active = false,
// retired_at), the sandbox series get their sequence_code back and the new RA
// series are closed. Nothing fiscal is ever rewritten: issued invoices keep
// their snapshot (trigger invoices_issuer_inmutable), numbers are never reused.
//
// The real NIF A33615980 enters the LOCAL demo only with César's consent and is
// never sent to the AEAT: the script refuses to open filler installations
// outside sandbox and never flips verifactuEnabled.
//
// Exit codes: 0 ok · 1 failure (precondition, conflict, clash, post-condition,
// DB error) · 2 unknown flag / usage.

import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "@hotelos/database";
import { normalizeTaxId, resolveVerifactuMode, type VerifactuSubmissionMode } from "@hotelos/compliance";
import type { PermissionKey, PropertyKind, StructureMode, VerifactuChainScope } from "@hotelos/shared";
import type { UserContext } from "../lib/demo-store.js";
import { deriveStructureMode } from "../lib/finance-scope.js";
import { createId } from "../lib/ids.js";
import { SANDBOX_INSTALL_NUMBER, detectPrefixClashes, loadSnapshot as loadBackfillSnapshot, verifyOrganization, type BackfillWarning, type Verification } from "./backfill-legal-structure.js";
import { establishmentPatchSchema, legalEntityPatchSchema, type EstablishmentPatchInput, type LegalEntityPatchInput } from "../modules/structure/structure.schemas.js";
import { HIGH_RISK_LEGAL_ENTITY_FIELDS, resolveTaxIdChange, type HighRiskLegalEntityField } from "../modules/structure/legal-entity.service.js";
import {
  buildPlan,
  diffConverge,
  formatPlannedWrites,
  hotelInventoryOf,
  isHotelKind,
  planRooms,
  summarizePlan,
  validateSpec,
  type FieldConflict,
  type PilotSpec,
  type ProvisionPlan
} from "../modules/structure/property-provisioning.service.js";

// ---------------------------------------------------------------------------
// Constants (Faranda demo tenant as the local DB holds it on 2026-09-16)
// ---------------------------------------------------------------------------

export const FARANDA_ORGANIZATION_ID = "cmrhw9jy30002fyvb6tsdiugt";
export const RIAS_ALTAS_PROPERTY_ID = "cmrhw9jy40003fyvbuu2ec2w7";
export const LOS_TILOS_PROPERTY_ID = "cmu1mifcp0000fyo1wzvq7txo";
export const CARMEN_USER_ID = "cmrhw9jyb0005fyvb4ykaumyc";
export const OWNER_ROLE_ID = "cmrhw9jy60004fyvbjvur0uqt";
export const CORRELATION_ID = "corr_faranda_celuisma_l8";
export const SYSTEM_USER_ID = "usr_system_faranda_celuisma";
export const AUDIT_ACTION = "FARANDA_CELUISMA_MIGRATION_STEP";
export const SERIES_YEAR = 2026;
export const RIAS_ALTAS_CODE = "RA";
/** Closed sandbox series keep their prefix and counters; only the code moves out of the (property, code, year) key (informe §8 fila 11). */
export const SANDBOX_SERIES_SUFFIX = "-SANDBOX";

/**
 * CELUISMA S.A. as confirmed by César on 2026-09-16 (checksum of the CIF
 * verified) plus the public registry data consulted the same day (Empresia and
 * eInforma agree on the Registro Mercantil de MADRID; tomo / folio / hoja are
 * not public → mercantileRegistry stays null until the escrituras / nota simple).
 */
export const CELUISMA = {
  legalName: "CELUISMA S.A.",
  taxId: "A33615980",
  code: "CEL",
  legalForm: "sa" as const,
  cnae: "5510",
  incorporated: "1981-02-10",
  /** Informational only (not a column): both public sources place the inscription in the RM de Madrid. */
  mercantileRegistryOffice: "Registro Mercantil de Madrid (Empresia y eInforma, 2026-09-16)",
  /** tomo / folio / hoja unknown: left null, never asserted (open item). */
  mercantileRegistry: null as string | null,
  /** Public figures that orient the regime decision (eInforma, ejercicio 2024); NOT written anywhere. */
  publicFigures: { employees2024: 62, shareCapitalEur: "4.735.729,75" }
};

/** The three candidate addresses of the sociedad (and of the oficina central). */
export type AddressOption = "gijon" | "madrid" | "florida";
/** Kept for readers of the first version of this CLI: both flags share the same option set. */
export type FiscalAddressOption = AddressOption;
export type OfficeCityOption = AddressOption;
export const ADDRESS_OPTION_KEYS: readonly AddressOption[] = ["gijon", "madrid", "florida"];
export const FISCAL_ADDRESS_OPTIONS: readonly AddressOption[] = ADDRESS_OPTION_KEYS;
export const OFFICE_CITY_OPTIONS: readonly AddressOption[] = ["madrid", "gijon", "florida"];

export type PostalAddress = { address: string; postalCode: string; municipality: string; ineCode: string; province: string };
export type AddressCandidate = PostalAddress & { label: string; source: string };

/**
 * The candidate addresses with their public evidence (2026-09-16). None is a
 * default for the sociedad: the sources disagree and only the 036 / escrituras
 * settle the domicilio fiscal and the domicilio social.
 *  - gijon:   extracto registral via Empresia «PORTUGAL, 7 33207 GIJON» (no street
 *             type); Yelp / Páginas Amarillas / Anuario: «Avenida de Portugal, 7
 *             (Bajo)». Historical seat of Celuisma. NOT «Calle».
 *  - madrid:  «C/ GENERAL AMPUDIA 8 - BAJO A-DERECHA» = previous domicilio until the
 *             2014 change (Empresia), operating office per Alimarket, same address
 *             as Faranda International Hotels S.L.
 *  - florida: eInforma current domicilio «PASEO FLORIDA, 5 28008 MADRID» = the City
 *             House Florida Norte hotel; consistent with the RM de Madrid inscription.
 */
export const ADDRESS_OPTIONS: Record<AddressOption, AddressCandidate> = {
  gijon: {
    address: "Avenida de Portugal, 7",
    postalCode: "33207",
    municipality: "Gijón",
    ineCode: "33024",
    province: "Asturias",
    label: "sede histórica de Celuisma",
    source: "Empresia (extracto: «PORTUGAL, 7 33207 GIJON»); Yelp / Páginas Amarillas / Anuario: «Avenida de Portugal, 7 (Bajo)»"
  },
  madrid: {
    address: "Calle General Ampudia, 8, bajo A-dcha",
    postalCode: "28003",
    municipality: "Madrid",
    ineCode: "28079",
    province: "Madrid",
    label: "domicilio anterior (hasta el cambio de 2014) y oficina operativa",
    source: "Empresia (dirección anterior «C/ GENERAL AMPUDIA 8 - BAJO A-DERECHA (MADRID)»); Alimarket (oficina operativa, misma dirección que Faranda International Hotels S.L.)"
  },
  florida: {
    address: "Paseo de la Florida, 5",
    postalCode: "28008",
    municipality: "Madrid",
    ineCode: "28079",
    province: "Madrid",
    label: "domicilio actual según eInforma (sede del City House Florida Norte)",
    source: "eInforma (domicilio «PASEO FLORIDA, 5 28008 MADRID», Registro Mercantil de Madrid)"
  }
};

/** One-line description of a candidate for the plan and the open decisions. */
export function describeAddress(option: AddressOption): string {
  const a = ADDRESS_OPTIONS[option];
  return `${option} = ${a.address}, ${a.postalCode} ${a.municipality} (${a.province}; INE ${a.ineCode}) — ${a.label}`;
}

export const OFFICE_SPEC_FILE = "faranda-oficina-central.json";
export const HOTEL_SPEC_FILES: Readonly<Record<string, string>> = {
  PG: "faranda-pathos-gijon.json",
  MC: "faranda-marsol-candas.json",
  AS: "faranda-alisas-santander.json",
  FN: "faranda-florida-norte.json",
  LL: "faranda-las-lomas.json"
};
export const HOTEL_CODES: readonly string[] = Object.keys(HOTEL_SPEC_FILES);
export const EXISTING_CENTRE_CODES: readonly string[] = ["RA", "LT"];
export const OFFICE_CODE = "OC";
/** The eight centres of §5.5 step 11 in the order the plan prints them. */
export const EXPECTED_CENTRE_CODES: readonly string[] = ["RA", "LT", ...HOTEL_CODES, OFFICE_CODE];

/** Fill-only census of the two centres that already exist (REAT / web oficial; never overwrites a value). */
export const EXISTING_CENTRE_CENSUS: Readonly<Record<string, { code: string; label: string; census: Record<string, unknown> }>> = {
  [RIAS_ALTAS_PROPERTY_ID]: {
    code: "RA",
    label: "Faranda Rías Altas",
    // REAT H-CO-000713 · 3★ · 103 habitaciones · 196 plazas (docs/pilots/FARANDA-LOS-TILOS-2026-09-14.md §7,
    // reat_faranda_galicia.csv). The 120 demo rooms in the DB are NOT touched here (open item).
    census: { starRating: 3, bedCapacity: 196, tourismRegistryNumber: "H-CO-000713" }
  },
  [LOS_TILOS_PROPERTY_ID]: {
    code: "LT",
    label: "Faranda Los Tilos",
    // REAT H-CO-001327 · 4★ · 176 plazas (docs/pilots/FARANDA-LOS-TILOS-2026-09-14.md).
    census: { starRating: 4, bedCapacity: 176, tourismRegistryNumber: "H-CO-001327" }
  }
};

/** Rooms of Rías Altas per REAT H-CO-000713 / OTAs; the DB holds 120 demo rooms nobody supports (open item, never touched here). */
export const RIAS_ALTAS_REAT_ROOMS = 103;

/** Series the sociedad opens in Rías Altas once the sandbox ones are closed (§5.5 step 6). */
export const RIAS_ALTAS_TARGET_SERIES: ReadonlyArray<{ sequenceCode: string; invoiceType: string; prefix: string }> = [
  { sequenceCode: "FAC", invoiceType: "F1", prefix: `FAC-${RIAS_ALTAS_CODE}-${SERIES_YEAR}-` },
  { sequenceCode: "REC", invoiceType: "R1", prefix: `REC-${RIAS_ALTAS_CODE}-${SERIES_YEAR}-` },
  { sequenceCode: "SIM", invoiceType: "F2", prefix: `FS-${RIAS_ALTAS_CODE}-${SERIES_YEAR}-` }
];

const MIGRATION_PERMISSIONS: readonly PermissionKey[] = ["organization.structure.manage", "ai.high_risk.confirm", "billing.configure"];
const ENTITY_WIDE_KEYS: readonly string[] = ["accounting.entity.read", "organization.structure.manage"];

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

export type MigrationFlags = {
  apply: boolean;
  confirm: string | null;
  officeCity: OfficeCityOption;
  /** Domicilio fiscal of the sociedad. null = not chosen: the address columns are not written (dry-run) and --apply refuses. */
  fiscalAddress: AddressOption | null;
  /** Domicilio social. null = same as fiscalAddress (art. 48 LGT: the fiscal domicile of a company is its registered office by default). */
  registeredOffice: AddressOption | null;
  /** Opt-in: open the sandbox filler DEV-001-<COD> also for hotels with verifactuEnabled = false (design: at activation). */
  sandboxInstallations: boolean;
  skipHotels: string[];
  json: boolean;
  printRollback: boolean;
  help: boolean;
};

export const USAGE = [
  "Uso (desde apps/api, DATABASE_URL en el entorno o ../../.env):",
  "  node --env-file-if-exists=../../.env --import tsx src/scripts/migrate-faranda-celuisma.ts \\",
  `    [--dry-run | --apply --confirm ${FARANDA_ORGANIZATION_ID} --fiscal-address gijon|madrid|florida] \\`,
  "    [--registered-office gijon|madrid|florida] [--office-city madrid|gijon|florida] [--sandbox-installations] \\",
  "    [--skip-hotels PG,MC] [--json] [--print-rollback]",
  "",
  "  --dry-run              (por defecto) imprime el plan completo paso a paso (conteos y colisiones); no escribe nada",
  "  --apply                escribe paso a paso (cada paso = su propia transacción / servicio); exige --confirm Y --fiscal-address",
  "  --confirm <orgId>      id exacto de la organización Faranda (guarda contra aplicar en otra BD)",
  "  --fiscal-address       domicilio FISCAL de la sociedad: gijon | madrid | florida — SIN valor por defecto (las fuentes públicas",
  "                         discrepan); sin él el dry-run no planifica las 9 columnas de dirección y --apply se niega (salida 2)",
  "  --registered-office    domicilio SOCIAL: gijon | madrid | florida — por defecto el mismo que --fiscal-address",
  "  --office-city          sede de la oficina central (centro OC): madrid (por defecto) | gijon | florida — CONFIRMAR con César",
  "  --sandbox-installations abre el relleno sandbox DEV-001-<COD> también en los hoteles con verifactuEnabled=false",
  "                         (por defecto solo los hoteles ya activados: diseño §5.5 paso 8 «al activar cada hotel»)",
  `  --skip-hotels <códigos> códigos de centro separados por comas que NO se dan de alta (${HOTEL_CODES.join(", ")})`,
  "  --json                 resumen legible por máquina",
  `  --print-rollback       solo lectura: qué escribió --apply (auditoría ${CORRELATION_ID}) y cómo deshacerlo`,
  "  --help, -h             esta ayuda",
  "",
  `Candidatos de dirección (2026-09-16): ${ADDRESS_OPTION_KEYS.map((k) => describeAddress(k)).join(" · ")}`,
  "",
  "Códigos de salida: 0 ok · 1 fallo (precondición, conflicto, colisión, post-condición, BD) · 2 flag desconocido / uso."
].join("\n");

const VALUE_FLAGS = new Set(["--confirm", "--office-city", "--fiscal-address", "--registered-office", "--skip-hotels"]);

function parseAddressOption(flag: string, value: string, allowed: readonly AddressOption[]): AddressOption {
  if (!(allowed as readonly string[]).includes(value)) throw new Error(`${flag} must be one of ${allowed.join("|")} (got "${value}").`);
  return value as AddressOption;
}

export function parseFlags(argv: readonly string[]): MigrationFlags {
  const flags: MigrationFlags = { apply: false, confirm: null, officeCity: "madrid", fiscalAddress: null, registeredOffice: null, sandboxInstallations: false, skipHotels: [], json: false, printRollback: false, help: false };
  let sawDryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") return { ...flags, help: true };
    if (arg === "--dry-run") sawDryRun = true;
    else if (arg === "--apply") flags.apply = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--print-rollback") flags.printRollback = true;
    else if (arg === "--sandbox-installations") flags.sandboxInstallations = true;
    else if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--") || value.trim() === "") throw new Error(`Flag "${arg}" requires a value.`);
      const trimmed = value.trim();
      if (arg === "--confirm") {
        if (flags.confirm !== null) throw new Error("--confirm may be given only once (one migration = one organisation).");
        flags.confirm = trimmed;
      } else if (arg === "--office-city") flags.officeCity = parseAddressOption(arg, trimmed, OFFICE_CITY_OPTIONS);
      else if (arg === "--fiscal-address") flags.fiscalAddress = parseAddressOption(arg, trimmed, FISCAL_ADDRESS_OPTIONS);
      else if (arg === "--registered-office") flags.registeredOffice = parseAddressOption(arg, trimmed, FISCAL_ADDRESS_OPTIONS);
      else {
        const codes = trimmed.split(",").map((c) => c.trim().toUpperCase()).filter((c) => c.length > 0);
        const unknown = codes.filter((c) => !HOTEL_CODES.includes(c));
        if (unknown.length > 0) throw new Error(`--skip-hotels names unknown centre codes: ${unknown.join(", ")}. Known: ${HOTEL_CODES.join(", ")}.`);
        for (const code of codes) if (!flags.skipHotels.includes(code)) flags.skipHotels.push(code);
      }
      i++;
    } else if (arg === "--") continue;
    else throw new Error(`Unknown flag "${arg}". Known: --dry-run, --apply, --confirm <orgId>, --fiscal-address, --registered-office, --office-city, --sandbox-installations, --skip-hotels, --json, --print-rollback, --help.`);
  }
  if (sawDryRun && flags.apply) throw new Error("--dry-run and --apply are mutually exclusive.");
  if (flags.printRollback && flags.apply) throw new Error("--print-rollback is read-only and cannot be combined with --apply.");
  if (flags.apply && flags.confirm === null) throw new Error(`--apply requires --confirm ${FARANDA_ORGANIZATION_ID}.`);
  if (!flags.apply && flags.confirm !== null) throw new Error("--confirm only makes sense with --apply.");
  if (flags.apply && flags.fiscalAddress === null) {
    throw new Error(`--apply requires --fiscal-address ${FISCAL_ADDRESS_OPTIONS.join("|")}: the domicilio fiscal of CELUISMA S.A. has no default (the public sources disagree; confirm it with the 036 / escrituras). Nothing written.`);
  }
  return flags;
}

/** The domicilio social actually planned: the explicit flag, else the fiscal one (null when neither was given). */
export function effectiveRegisteredOffice(flags: Pick<MigrationFlags, "fiscalAddress" | "registeredOffice">): AddressOption | null {
  return flags.registeredOffice ?? flags.fiscalAddress;
}

/** --confirm must name exactly the Faranda organisation (typo / wrong DB guard). */
export function assertConfirmMatches(flags: Pick<MigrationFlags, "apply" | "confirm">, organizationId: string = FARANDA_ORGANIZATION_ID): void {
  if (!flags.apply) return;
  if (flags.confirm !== organizationId) throw new Error(`--confirm "${flags.confirm}" does not match the Faranda organizationId "${organizationId}". Nothing written.`);
}

/** System actor of the CLI: the structure services check permissions on the context, not on the database. */
export function systemContext(organizationId: string, propertyId: string): UserContext {
  return {
    organizationId,
    propertyId,
    userId: SYSTEM_USER_ID,
    fullName: "Migración Faranda → CELUISMA (L8)",
    deviceId: "cli:migrate-faranda-celuisma",
    permissions: [...MIGRATION_PERMISSIONS],
    isPlatformAdmin: false
  };
}

// ---------------------------------------------------------------------------
// Specs (pure once read)
// ---------------------------------------------------------------------------

export function specsDir(): string {
  return resolvePath(dirname(fileURLToPath(import.meta.url)), "specs");
}

export type RawSpec = Record<string, unknown> & { _notes?: Record<string, unknown>; property?: Record<string, unknown>; profile?: Record<string, unknown> };

/**
 * Pure: the office spec carries both candidate addresses in
 * `_notes.addressOptions`; the chosen city replaces the property address
 * fields before validation (CP / INE coherence is re-checked by validateSpec).
 */
export function applyOfficeAddress(raw: RawSpec, city: OfficeCityOption): RawSpec {
  const options = (raw._notes?.addressOptions ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const option = options[city];
  if (!option) throw new Error(`El spec de la oficina no define _notes.addressOptions.${city}.`);
  const property = { ...(raw.property ?? {}) };
  for (const key of ["address", "municipality", "province", "postalCode", "ineMunicipalityCode"]) {
    if (option[key] === undefined) throw new Error(`_notes.addressOptions.${city}.${key} falta en el spec de la oficina.`);
    property[key] = option[key];
  }
  const profile = { ...(raw.profile ?? {}) };
  if (option.autonomousCommunity !== undefined) profile.autonomousCommunity = option.autonomousCommunity;
  return { ...raw, property, profile };
}

export function readRawSpec(path: string): RawSpec {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RawSpec;
  } catch (error) {
    throw new Error(`No se pudo leer el spec ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The office spec must describe a non-billing office of Faranda (kind office, code OC, no series). */
export function assertOfficeSpec(spec: PilotSpec, file: string = OFFICE_SPEC_FILE): void {
  if (spec.property.kind !== "office") throw new Error(`${file}: la oficina central debe ser kind office (es «${spec.property.kind}»).`);
  if (spec.property.code !== OFFICE_CODE) throw new Error(`${file}: property.code «${spec.property.code}» ≠ ${OFFICE_CODE}.`);
  if (spec.invoiceSequences.length > 0) throw new Error(`${file}: la oficina no factura (invoiceSequences debe estar vacío).`);
  if (spec.organizationId !== FARANDA_ORGANIZATION_ID) throw new Error(`${file}: organizationId ≠ Faranda.`);
}

/** Every hotel spec must be a hotel of Faranda with its expected code and the three coded series of the year. */
export function assertHotelSpec(spec: PilotSpec, code: string, file: string): void {
  if (spec.organizationId !== FARANDA_ORGANIZATION_ID) throw new Error(`${file}: organizationId ≠ Faranda.`);
  if (spec.property.code !== code) throw new Error(`${file}: property.code «${spec.property.code}» ≠ código esperado «${code}».`);
  if (!isHotelKind(spec.property.kind)) throw new Error(`${file}: un hotel de la lista tiene kind «${spec.property.kind}».`);
  const expected = new Set([`FAC-${code}-${SERIES_YEAR}-`, `REC-${code}-${SERIES_YEAR}-`, `FS-${code}-${SERIES_YEAR}-`]);
  const got = new Set(spec.invoiceSequences.map((s) => (s.prefix ?? "").toUpperCase()));
  for (const prefix of expected) if (!got.has(prefix)) throw new Error(`${file}: falta la serie con prefijo ${prefix} (R3: cada centro facturador lleva su código).`);
  if (spec.owners.length === 0) throw new Error(`${file}: owners vacío (Carmen debe tener su rol en el centro nuevo, paso 10).`);
}

export type LoadedSpecs = {
  office: { file: string; spec: PilotSpec };
  hotels: Array<{ code: string; file: string; spec: PilotSpec }>;
  skipped: string[];
};

export function loadMigrationSpecs(options: { officeCity: OfficeCityOption; skipHotels: readonly string[]; dir?: string }): LoadedSpecs {
  const dir = options.dir ?? specsDir();
  const office = validateSpec(applyOfficeAddress(readRawSpec(resolvePath(dir, OFFICE_SPEC_FILE)), options.officeCity));
  assertOfficeSpec(office);
  const hotels: LoadedSpecs["hotels"] = [];
  const skipped: string[] = [];
  for (const code of HOTEL_CODES) {
    if (options.skipHotels.includes(code)) {
      skipped.push(code);
      continue;
    }
    const file = HOTEL_SPEC_FILES[code]!;
    const spec = validateSpec(readRawSpec(resolvePath(dir, file)));
    assertHotelSpec(spec, code, file);
    hotels.push({ code, file, spec });
  }
  return { office: { file: OFFICE_SPEC_FILE, spec: office }, hotels, skipped };
}

/** Pure: centre codes of the batch plus the existing ones must be unique inside the sociedad. */
export function detectCodeClashes(existingCodes: readonly string[], specs: readonly PilotSpec[]): string[] {
  const seen = new Set(existingCodes.map((c) => c.toUpperCase()));
  const clashes: string[] = [];
  for (const spec of specs) {
    const code = (spec.property.code ?? "").toUpperCase();
    if (!code) continue;
    if (seen.has(code)) clashes.push(code);
    seen.add(code);
  }
  return clashes;
}

// ---------------------------------------------------------------------------
// Step 2 · Sociedad (pure planner over the current row)
// ---------------------------------------------------------------------------

export type LegalEntityCurrent = {
  id: string;
  code: string;
  legalName: string;
  taxId: string | null;
  legalForm: string | null;
  cnae: string | null;
  fiscalAddress: string | null;
  fiscalPostalCode: string | null;
  fiscalMunicipality: string | null;
  fiscalIneCode: string | null;
  fiscalProvince: string | null;
  registeredOfficeAddress: string | null;
  registeredOfficePostalCode: string | null;
  registeredOfficeMunicipality: string | null;
  registeredOfficeProvince: string | null;
  mercantileRegistry: string | null;
  pgcVariant: string;
  fiscalYearStartMonth: number;
  largeCompany: boolean;
  siiEnabled: boolean;
  verifactuChainScope: string;
};

export type LegalEntityChange = { field: string; from: unknown; to: unknown; highRisk: boolean };

/** The 9 address columns of the sociedad (5 fiscal + 4 registered office); null = not chosen, never asserted. */
export const LEGAL_ENTITY_ADDRESS_FIELDS: readonly string[] = ["fiscalAddress", "fiscalPostalCode", "fiscalMunicipality", "fiscalIneCode", "fiscalProvince", "registeredOfficeAddress", "registeredOfficePostalCode", "registeredOfficeMunicipality", "registeredOfficeProvince"];

/**
 * Target values of the sociedad: everything César confirmed, the regime fields
 * deliberately absent, and the two domiciles ONLY when chosen explicitly
 * (`null` → the 9 address columns are not asserted; `registered` defaults to
 * `fiscal`, the legal presumption of art. 48.2.b LGT).
 */
export function desiredLegalEntity(fiscal: AddressOption | null, registered: AddressOption | null = fiscal): Record<string, string | null> {
  const address = fiscal ? ADDRESS_OPTIONS[fiscal] : null;
  const office = registered ? ADDRESS_OPTIONS[registered] : null;
  return {
    legalName: CELUISMA.legalName,
    taxId: CELUISMA.taxId,
    code: CELUISMA.code,
    legalForm: CELUISMA.legalForm,
    cnae: CELUISMA.cnae,
    fiscalAddress: address?.address ?? null,
    fiscalPostalCode: address?.postalCode ?? null,
    fiscalMunicipality: address?.municipality ?? null,
    fiscalIneCode: address?.ineCode ?? null,
    fiscalProvince: address?.province ?? null,
    registeredOfficeAddress: office?.address ?? null,
    registeredOfficePostalCode: office?.postalCode ?? null,
    registeredOfficeMunicipality: office?.municipality ?? null,
    registeredOfficeProvince: office?.province ?? null,
    mercantileRegistry: CELUISMA.mercantileRegistry
  };
}

/**
 * Pure: the PATCH body patchLegalEntity needs (only the fields that change;
 * confirmHighRisk when a high-risk field is among them) and the list of
 * changes for the operator. A null target asserts nothing (mercantileRegistry
 * unknown, domiciles not chosen). Same-value writes are not changes, so a
 * second run yields {}.
 */
export function planLegalEntityPatch(current: LegalEntityCurrent, fiscal: AddressOption | null, registered: AddressOption | null = fiscal): { body: LegalEntityPatchInput | null; changes: LegalEntityChange[]; highRiskFields: HighRiskLegalEntityField[] } {
  const desired = desiredLegalEntity(fiscal, registered);
  const body: Record<string, unknown> = {};
  const changes: LegalEntityChange[] = [];
  const highRisk = new Set<string>(HIGH_RISK_LEGAL_ENTITY_FIELDS);
  for (const [field, target] of Object.entries(desired)) {
    if (target === null) continue;
    if (field === "taxId") {
      const change = resolveTaxIdChange(current.taxId, target);
      if (!change.changed) continue;
      body.taxId = target;
      changes.push({ field, from: normalizeTaxId(current.taxId), to: change.next, highRisk: true });
      continue;
    }
    const have = ((current as unknown as Record<string, unknown>)[field] ?? null) as string | null;
    const haveNorm = typeof have === "string" ? have.trim() : have;
    if (haveNorm === target) continue;
    body[field] = target;
    changes.push({ field, from: have, to: target, highRisk: highRisk.has(field) });
  }
  const highRiskFields = HIGH_RISK_LEGAL_ENTITY_FIELDS.filter((field) => field in body);
  if (Object.keys(body).length === 0) return { body: null, changes, highRiskFields };
  if (highRiskFields.length > 0) body.confirmHighRisk = true;
  return { body: legalEntityPatchSchema.parse(body), changes, highRiskFields };
}

/** Pure: the sociedad row after the patch (idempotency oracle of the tests). */
export function applyLegalEntityPatchToRow(current: LegalEntityCurrent, body: LegalEntityPatchInput | null): LegalEntityCurrent {
  if (!body) return current;
  const { confirmHighRisk: _confirm, ...rest } = body;
  const next: Record<string, unknown> = { ...current };
  for (const [field, value] of Object.entries(rest)) if (value !== undefined) next[field] = field === "taxId" ? normalizeTaxId(value as string | null) : value;
  return next as LegalEntityCurrent;
}

// ---------------------------------------------------------------------------
// Step 3 · Existing centres (fill-only census; reuses diffConverge)
// ---------------------------------------------------------------------------

export type CensusFillPlan = { propertyId: string; code: string; label: string; patch: EstablishmentPatchInput | null; same: string[]; conflicts: FieldConflict[] };

export function planCensusFill(propertyId: string, current: Record<string, unknown>): CensusFillPlan {
  const target = EXISTING_CENTRE_CENSUS[propertyId];
  if (!target) throw new Error(`Centro ${propertyId} sin censo previsto.`);
  const diff = diffConverge(current, target.census);
  const patch = Object.keys(diff.fill).length > 0 ? establishmentPatchSchema.parse(diff.fill) : null;
  return { propertyId, code: target.code, label: target.label, patch, same: diff.same, conflicts: diff.conflicts };
}

// ---------------------------------------------------------------------------
// Step 6 · Series of Rías Altas (pure planner)
// ---------------------------------------------------------------------------

export type SeriesRow = {
  id: string;
  propertyId: string;
  sequenceCode: string;
  invoiceType: string;
  prefix: string | null;
  year: number | null;
  nextNumber: number;
  padding: number;
  active: boolean;
};

export type SeriesClose = { id: string; sequenceCode: string; prefix: string | null; nextNumber: number; toSequenceCode: string };
export type SeriesOpen = { sequenceCode: string; invoiceType: string; prefix: string; action: "create" | "reopen"; existingId: string | null };
export type SeriesPlan = { close: SeriesClose[]; open: SeriesOpen[]; skip: string[]; blocked: string[] };

const norm = (prefix: string | null | undefined): string => (prefix ?? "").trim().toUpperCase();

/**
 * Pure: which RA rows of the year are sandbox series (prefix without the centre
 * code: `FAC-2026-`) to close and rename, and which coded series to open or
 * re-open. A row of the same (code, year) with ANOTHER prefix that is not the
 * sandbox one is a conflict the operator resolves by hand (never overwritten).
 */
export function planRiasAltasSeries(rows: readonly SeriesRow[], propertyId: string = RIAS_ALTAS_PROPERTY_ID, year: number = SERIES_YEAR): SeriesPlan {
  const plan: SeriesPlan = { close: [], open: [], skip: [], blocked: [] };
  const own = rows.filter((row) => row.propertyId === propertyId);
  const closing = new Set<string>();
  for (const target of RIAS_ALTAS_TARGET_SERIES) {
    const legacyPrefix = `${target.sequenceCode}-${year}-`;
    const legacy = own.find((row) => row.sequenceCode === target.sequenceCode && row.year === year && row.active && norm(row.prefix) === legacyPrefix);
    if (legacy) {
      const toSequenceCode = `${target.sequenceCode}${SANDBOX_SERIES_SUFFIX}`;
      if (own.some((row) => row.sequenceCode === toSequenceCode && row.year === year)) {
        plan.blocked.push(`${target.sequenceCode}/${year}: ya existe una fila ${toSequenceCode} del mismo ejercicio; renombra la serie sandbox a mano antes de repetir.`);
        continue;
      }
      plan.close.push({ id: legacy.id, sequenceCode: legacy.sequenceCode, prefix: legacy.prefix, nextNumber: legacy.nextNumber, toSequenceCode });
      closing.add(legacy.id);
    }
    const existing = own.find((row) => row.sequenceCode === target.sequenceCode && row.year === year && !closing.has(row.id));
    if (!existing) {
      plan.open.push({ ...target, action: "create", existingId: null });
      continue;
    }
    if (norm(existing.prefix) !== norm(target.prefix)) {
      plan.blocked.push(`${target.sequenceCode}/${year}: la fila ${existing.id} usa el prefijo «${existing.prefix ?? "—"}» (esperado ${target.prefix}); resuélvelo a mano (nunca se renumera).`);
      continue;
    }
    if (existing.active) plan.skip.push(`${target.sequenceCode}/${year} ${target.prefix} ya activa (siguiente ${existing.nextNumber})`);
    else plan.open.push({ ...target, action: "reopen", existingId: existing.id });
  }
  return plan;
}

/** Pure post-state of a series plan (idempotency oracle). */
export function applySeriesPlanToRows(rows: readonly SeriesRow[], plan: SeriesPlan, propertyId: string = RIAS_ALTAS_PROPERTY_ID, year: number = SERIES_YEAR): SeriesRow[] {
  const closed = new Map(plan.close.map((c) => [c.id, c.toSequenceCode]));
  const next: SeriesRow[] = rows.map((row) => (closed.has(row.id) ? { ...row, sequenceCode: closed.get(row.id)!, active: false } : row));
  for (const open of plan.open) {
    if (open.action === "reopen" && open.existingId) {
      const index = next.findIndex((row) => row.id === open.existingId);
      if (index >= 0) next[index] = { ...next[index]!, active: true };
      continue;
    }
    next.push({ id: `seq_planned_${open.sequenceCode.toLowerCase()}`, propertyId, sequenceCode: open.sequenceCode, invoiceType: open.invoiceType, prefix: open.prefix, year, nextNumber: 1, padding: 6, active: true });
  }
  return next;
}

// ---------------------------------------------------------------------------
// Step 8 · VeriFactu installations (pure planner)
// ---------------------------------------------------------------------------

export type CentreForInstallation = { id: string; code: string; kind: PropertyKind | string; hasActiveInstallation: boolean; verifactuEnabled: boolean };
export type InstallationCreate = { propertyId: string; code: string; numeroInstalacion: string };
export type InstallationPlan = {
  create: InstallationCreate[];
  skip: string[];
  /** Hotels with verifactuEnabled = false: their installation is opened when VeriFactu is activated (design §5.5 step 8). */
  deferred: string[];
  /** Hotels enabled but outside sandbox: the real number of the registro del productor is missing. */
  pending: string[];
  warnings: BackfillWarning[];
};

/**
 * Pure: with per_center, one installation per ENABLED hotel centre that has none:
 * the sandbox filler `DEV-001-<CODE>` while VERIFACTU_MODE = sandbox, nothing
 * outside sandbox (the real numbers of the registro del productor are César's,
 * informe §8 fila 10). A hotel with verifactuEnabled = false is DEFERRED — the
 * design opens its installation «al activar cada hotel» and every filler is a
 * permanent immutable row — unless `fillerForDisabled` (--sandbox-installations)
 * asks for the filler anyway. With per_entity the sociedad shares one
 * installation and this planner steps aside.
 */
export function planSandboxInstallations(input: { centres: readonly CentreForInstallation[]; mode: VerifactuSubmissionMode; chainScope: VerifactuChainScope | string; takenNumbers: readonly string[]; fillerForDisabled?: boolean }): InstallationPlan {
  const plan: InstallationPlan = { create: [], skip: [], deferred: [], pending: [], warnings: [] };
  if (input.chainScope !== "per_center") {
    plan.warnings.push({ code: "INSTALLATION_NUMBER_SANDBOX_DEFAULT", message: `La sociedad tiene política de cadena «${input.chainScope}»: una sola instalación por sociedad, este paso no abre instalaciones por centro.` });
    return plan;
  }
  const taken = new Set(input.takenNumbers);
  for (const centre of input.centres) {
    if (!isHotelKind(centre.kind as PropertyKind)) {
      plan.skip.push(`${centre.code}: centro no facturador (${centre.kind}), sin instalación`);
      continue;
    }
    if (centre.hasActiveInstallation) {
      plan.skip.push(`${centre.code}: ya tiene instalación activa`);
      continue;
    }
    if (!centre.verifactuEnabled && !input.fillerForDisabled) {
      plan.deferred.push(`${centre.code}: verifactuEnabled=false → la instalación se abre al activar VeriFactu en el centro (§5.5 paso 8); relleno sandbox solo con --sandbox-installations`);
      continue;
    }
    if (input.mode !== "sandbox") {
      plan.pending.push(`${centre.code}: VERIFACTU_MODE=${input.mode}: no se abre relleno; falta el número real del registro del productor`);
      continue;
    }
    let numero = `${SANDBOX_INSTALL_NUMBER}-${centre.code}`;
    for (let n = 2; taken.has(numero); n++) numero = `${SANDBOX_INSTALL_NUMBER}-${centre.code}${n}`;
    taken.add(numero);
    plan.create.push({ propertyId: centre.id, code: centre.code, numeroInstalacion: numero });
  }
  if (plan.create.length > 0) {
    plan.warnings.push({
      code: "INSTALLATION_NUMBER_SANDBOX_DEFAULT",
      message: `${plan.create.length} instalación/es de RELLENO sandbox (${SANDBOX_INSTALL_NUMBER}-<código>): filas permanentes (número inmutable, nunca se reutiliza); retirarlas (active = false, retired_at) y abrir las reales antes de VERIFACTU_MODE=preproduction — comprobación previa: SELECT count(*) FROM verifactu_installations WHERE active AND numero_instalacion LIKE '${SANDBOX_INSTALL_NUMBER.slice(0, 4)}%' debe dar 0.`,
      details: { numbers: plan.create.map((c) => c.numeroInstalacion) }
    });
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Cross-batch series clash check (pure; reuses backfill detectPrefixClashes)
// ---------------------------------------------------------------------------

export type ActiveSeriesRow = { propertyId: string; prefix: string | null; year: number | null; active: boolean };

/**
 * Pure: the ACTIVE series of the sociedad as they will be after the whole
 * batch (RA sandbox closed, RA coded opened, every new centre's series) — the
 * input of detectPrefixClashes. A planned centre is keyed by `new:<code>`.
 */
export function plannedActiveSeries(input: { existing: readonly ActiveSeriesRow[]; seriesPlan: SeriesPlan; specs: readonly PilotSpec[]; riasAltasId?: string }): ActiveSeriesRow[] {
  const riasAltasId = input.riasAltasId ?? RIAS_ALTAS_PROPERTY_ID;
  const closedIds = new Set(input.seriesPlan.close.map((c) => c.id));
  const rows: ActiveSeriesRow[] = input.existing
    .filter((row) => row.active)
    .filter((row) => !(("id" in row) && closedIds.has((row as { id: string }).id)))
    .map((row) => ({ propertyId: row.propertyId, prefix: row.prefix, year: row.year, active: true }));
  for (const open of input.seriesPlan.open) rows.push({ propertyId: riasAltasId, prefix: open.prefix, year: SERIES_YEAR, active: true });
  for (const spec of input.specs) {
    for (const seq of spec.invoiceSequences) rows.push({ propertyId: `new:${spec.property.code}`, prefix: seq.prefix ?? `${seq.sequenceCode.toUpperCase()}-${spec.property.code}-${seq.year}-`, year: seq.year, active: true });
  }
  return rows;
}

export function detectBatchPrefixClashes(rows: readonly ActiveSeriesRow[]): BackfillWarning[] {
  return detectPrefixClashes(rows);
}

// ---------------------------------------------------------------------------
// Identity of an existing centre (pure)
// ---------------------------------------------------------------------------

export type CentreIdentity = { id: string; name: string; code: string | null; tradeName: string | null; legalEntityId: string | null };

/**
 * Pure: the row a spec converges on. The natural key is (legalEntityId, code)
 * — the unique index properties_legal_entity_id_code_key — so a renamed centre
 * (PATCH establishment on name / tradeName, e.g. Las Lomas «Faranda Express» →
 * «City House») is still the same centre and never a NEW one / a code clash.
 * The name is only a fallback for rows that still have no code (pre-backfill).
 */
export function findExistingCentre<T extends CentreIdentity>(properties: readonly T[], spec: Pick<PilotSpec, "property">, legalEntityId: string | null): T | null {
  const code = (spec.property.code ?? "").trim().toUpperCase();
  if (code) {
    const byCode = properties.find((p) => (p.code ?? "").toUpperCase() === code && (legalEntityId === null || p.legalEntityId === null || p.legalEntityId === legalEntityId));
    if (byCode) return byCode;
  }
  return properties.find((p) => p.name === spec.property.name) ?? null;
}

/**
 * Pure: the spec buildPlan must see so that it converges on `existing` even after
 * a rename — property-provisioning.service.ts still resolves the row by `name`
 * (out of this lot: its owner should accept (legalEntityId, code) too), so the
 * DB name / tradeName replace the spec's. Nothing else of the spec changes.
 */
export function specForExistingCentre<T extends Pick<PilotSpec, "property">>(spec: T, existing: CentreIdentity | null): { spec: T; renamed: boolean } {
  if (!existing || (existing.name === spec.property.name && (existing.tradeName === null || existing.tradeName === spec.property.tradeName))) return { spec, renamed: false };
  return {
    spec: { ...spec, property: { ...spec.property, name: existing.name, tradeName: existing.tradeName ?? spec.property.tradeName } },
    renamed: true
  };
}

// ---------------------------------------------------------------------------
// Snapshot (database reads only)
// ---------------------------------------------------------------------------

export type FiscalInvariants = { invoices: number; issuedInvoices: number; verifactuSubmissions: number; journalEntries: number; journalLines: number };

export type PropertySnapshot = {
  id: string;
  name: string;
  code: string | null;
  kind: PropertyKind;
  status: string;
  tradeName: string | null;
  municipality: string | null;
  province: string | null;
  address: string | null;
  legalEntityId: string | null;
  verifactuEnabled: boolean;
  starRating: number | null;
  bedCapacity: number | null;
  tourismRegistryNumber: string | null;
};

export type MigrationSnapshot = {
  organization: { id: string; name: string } | null;
  legalEntity: LegalEntityCurrent | null;
  properties: PropertySnapshot[];
  sequences: Array<SeriesRow & { legalEntityId: string | null }>;
  installations: Array<{ id: string; propertyId: string | null; numeroInstalacion: string; active: boolean }>;
  invariants: FiscalInvariants;
  postedEntriesWithoutCentre: number;
  vatSettings: boolean;
  fiscalYears: number;
  siiFlaggedProperties: string[];
  ownerRolePermissionKeys: string[];
  carmenPropertyIds: string[];
  verification: Verification;
};

export type MigrationDb = Pick<
  typeof prisma,
  "organization" | "legalEntity" | "property" | "invoiceSequence" | "verifactuInstallation" | "invoice" | "verifactuSubmission" | "journalEntry" | "journalLine" | "vatSettings" | "fiscalYear" | "permission" | "rolePermission" | "userPropertyRole" | "bankAccount"
>;

export async function loadFiscalInvariants(propertyIds: readonly string[], organizationId: string, db: MigrationDb = prisma): Promise<FiscalInvariants> {
  const ids: string[] = [...propertyIds];
  const entryIds = (await db.journalEntry.findMany({ where: { organizationId }, select: { id: true } })).map((row) => row.id);
  const [invoices, issuedInvoices, verifactuSubmissions, journalLines] = await Promise.all([
    ids.length ? db.invoice.count({ where: { propertyId: { in: ids } } }) : Promise.resolve(0),
    ids.length ? db.invoice.count({ where: { propertyId: { in: ids }, status: { not: "draft" } } }) : Promise.resolve(0),
    ids.length ? db.verifactuSubmission.count({ where: { propertyId: { in: ids } } }) : Promise.resolve(0),
    // JournalLine has no relation field to its entry: count through the entry ids (61 entries in Faranda).
    entryIds.length ? db.journalLine.count({ where: { journalEntryId: { in: entryIds } } }) : Promise.resolve(0)
  ]);
  return { invoices, issuedInvoices, verifactuSubmissions, journalEntries: entryIds.length, journalLines };
}

export async function loadSnapshot(organizationId: string, db: MigrationDb = prisma): Promise<MigrationSnapshot | null> {
  const organization = await db.organization.findUnique({ where: { id: organizationId }, select: { id: true, name: true } });
  if (!organization) return null;
  const entityRow = await db.legalEntity.findFirst({ where: { organizationId, isDefault: true, status: "active" }, orderBy: { createdAt: "asc" } });
  const legalEntity: LegalEntityCurrent | null = entityRow
    ? {
        id: entityRow.id,
        code: entityRow.code,
        legalName: entityRow.legalName,
        taxId: entityRow.taxId ?? null,
        legalForm: entityRow.legalForm ?? null,
        cnae: entityRow.cnae ?? null,
        fiscalAddress: entityRow.fiscalAddress ?? null,
        fiscalPostalCode: entityRow.fiscalPostalCode ?? null,
        fiscalMunicipality: entityRow.fiscalMunicipality ?? null,
        fiscalIneCode: entityRow.fiscalIneCode ?? null,
        fiscalProvince: entityRow.fiscalProvince ?? null,
        registeredOfficeAddress: entityRow.registeredOfficeAddress ?? null,
        registeredOfficePostalCode: entityRow.registeredOfficePostalCode ?? null,
        registeredOfficeMunicipality: entityRow.registeredOfficeMunicipality ?? null,
        registeredOfficeProvince: entityRow.registeredOfficeProvince ?? null,
        mercantileRegistry: entityRow.mercantileRegistry ?? null,
        pgcVariant: entityRow.pgcVariant,
        fiscalYearStartMonth: entityRow.fiscalYearStartMonth,
        largeCompany: entityRow.largeCompany,
        siiEnabled: entityRow.siiEnabled,
        verifactuChainScope: entityRow.verifactuChainScope
      }
    : null;
  const propertyRows = await db.property.findMany({
    where: { organizationId },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, code: true, kind: true, status: true, tradeName: true, municipality: true, province: true, address: true, legalEntityId: true, verifactuEnabled: true, starRating: true, bedCapacity: true, tourismRegistryNumber: true }
  });
  const properties: PropertySnapshot[] = propertyRows.map((row) => ({ ...row, code: row.code ?? null, tradeName: row.tradeName ?? null, municipality: row.municipality ?? null, province: row.province ?? null, address: row.address ?? null, legalEntityId: row.legalEntityId ?? null, starRating: row.starRating ?? null, bedCapacity: row.bedCapacity ?? null, tourismRegistryNumber: row.tourismRegistryNumber ?? null }));
  const propertyIds = properties.map((p) => p.id);
  const sequences = propertyIds.length
    ? await db.invoiceSequence.findMany({
        where: { propertyId: { in: propertyIds } },
        select: { id: true, propertyId: true, sequenceCode: true, invoiceType: true, prefix: true, year: true, nextNumber: true, padding: true, active: true, legalEntityId: true },
        orderBy: [{ propertyId: "asc" }, { sequenceCode: "asc" }, { year: "desc" }]
      })
    : [];
  const installations = legalEntity
    ? await db.verifactuInstallation.findMany({ where: { legalEntityId: legalEntity.id }, select: { id: true, propertyId: true, numeroInstalacion: true, active: true }, orderBy: { createdAt: "asc" } })
    : [];
  // The residual per-property SII flag (deprecated) is reported by the backfill's
  // own snapshot (`siiProperties`, warning SII_FLAG_ON_PROPERTY): this CLI reuses
  // that reader instead of becoming a new one (contract tests/legal-structure-contract).
  const [invariants, postedEntriesWithoutCentre, vat, fiscalYears, backfillSnapshot, ownerPerms, carmenRoles, verification] = await Promise.all([
    loadFiscalInvariants(propertyIds, organizationId, db),
    db.journalEntry.count({ where: { organizationId, status: "posted", propertyId: null } }),
    db.vatSettings.findUnique({ where: { organizationId }, select: { id: true } }),
    db.fiscalYear.count({ where: { organizationId } }),
    loadBackfillSnapshot(organizationId),
    db.rolePermission.findMany({ where: { roleId: OWNER_ROLE_ID }, select: { permissionId: true } }),
    db.userPropertyRole.findMany({ where: { userId: CARMEN_USER_ID }, select: { propertyId: true } }),
    // Backfill helpers read through the global client (their BackfillDb includes the deprecated SII table this CLI never touches).
    verifyOrganization(organizationId)
  ]);
  const permissionIds = ownerPerms.map((row) => row.permissionId);
  const permissionKeys = permissionIds.length ? await db.permission.findMany({ where: { id: { in: permissionIds }, key: { in: [...ENTITY_WIDE_KEYS, "ai.high_risk.confirm", "billing.configure"] } }, select: { key: true } }) : [];
  return {
    organization,
    legalEntity,
    properties,
    sequences: sequences.map((row) => ({ ...row, prefix: row.prefix ?? null, year: row.year ?? null, legalEntityId: row.legalEntityId ?? null })),
    installations: installations.map((row) => ({ ...row, propertyId: row.propertyId ?? null })),
    invariants,
    postedEntriesWithoutCentre,
    vatSettings: vat !== null,
    fiscalYears,
    siiFlaggedProperties: [...(backfillSnapshot?.siiProperties ?? [])].sort(),
    ownerRolePermissionKeys: permissionKeys.map((row) => row.key).sort(),
    carmenPropertyIds: [...new Set(carmenRoles.map((row) => row.propertyId))],
    verification
  };
}

// ---------------------------------------------------------------------------
// Summary types
// ---------------------------------------------------------------------------

export type StepStatus = "ok" | "planned" | "applied" | "skipped" | "pending_decision" | "blocked" | "failed";

export type StepReport = {
  step: number;
  title: string;
  status: StepStatus;
  /** Planned (dry-run) or performed (apply) row writes. */
  writes: number;
  lines: string[];
  warnings: string[];
  errors: string[];
};

export type CentreRow = {
  code: string;
  kind: PropertyKind | string;
  name: string;
  municipality: string | null;
  province: string | null;
  stars: number | null;
  rooms: number | null;
  series: string[];
  installation: string | null;
  action: "existe" | "crear" | "converge" | "omitido";
  propertyId: string | null;
};

export type MigrationSummary = {
  dryRun: boolean;
  organizationId: string;
  options: { officeCity: OfficeCityOption; fiscalAddress: AddressOption | null; registeredOffice: AddressOption | null; sandboxInstallations: boolean; skipHotels: string[] };
  verifactuMode: VerifactuSubmissionMode;
  steps: StepReport[];
  centres: CentreRow[];
  collisions: { prefixes: number; codes: number; specConflicts: number };
  openDecisions: string[];
  invariants: { before: FiscalInvariants | null; after: FiscalInvariants | null; unchanged: boolean | null };
  expectedMode: StructureMode | null;
  totals: { writes: number; errors: number };
  /** --apply only: whether the audit queue reached Postgres before the process ended (null in dry-run). */
  audit: { flushed: boolean | null; error: string | null };
  durationMs: number;
};

const step = (n: number, title: string): StepReport => ({ step: n, title, status: "ok", writes: 0, lines: [], warnings: [], errors: [] });

/** The decisions that only César can take (informe §8) — printed with every plan. */
export function openDecisions(snapshot: MigrationSnapshot, flags: Pick<MigrationFlags, "officeCity" | "fiscalAddress" | "registeredOffice">, extras: { roomsByProperty?: ReadonlyMap<string, number> } = {}): string[] {
  const entity = snapshot.legalEntity;
  const rias = snapshot.properties.find((p) => p.id === RIAS_ALTAS_PROPERTY_ID);
  const registered = effectiveRegisteredOffice(flags);
  const candidates = ADDRESS_OPTION_KEYS.map((k) => describeAddress(k)).join("; ");
  const riasRooms = extras.roomsByProperty?.get(RIAS_ALTAS_PROPERTY_ID) ?? null;
  const items = [
    flags.fiscalAddress
      ? `Domicilio FISCAL de la sociedad: se aplica «${flags.fiscalAddress}» (${ADDRESS_OPTIONS[flags.fiscalAddress].address}, ${ADDRESS_OPTIONS[flags.fiscalAddress].municipality}) y domicilio SOCIAL «${registered}» (${ADDRESS_OPTIONS[registered!].address}, ${ADDRESS_OPTIONS[registered!].municipality}) — CONFIRMAR con el 036 / escrituras. Candidatos: ${candidates}. Fuentes públicas (2026-09-16): Empresia y eInforma sitúan la inscripción en el Registro Mercantil de MADRID (incompatible con un domicilio social en Gijón, que se inscribiría en el RM de Asturias); eInforma da como domicilio actual Paseo de la Florida 5 (sede del Florida Norte); General Ampudia 8 es la dirección anterior al cambio de 2014; Portugal 7 (Gijón) es la sede histórica.`
      : `Domicilio FISCAL y SOCIAL de la sociedad: SIN DECIDIR — este dry-run no planifica las 9 columnas de dirección y --apply exige --fiscal-address (y opcionalmente --registered-office, por defecto el mismo). Candidatos: ${candidates}. Fuentes públicas (2026-09-16): Empresia y eInforma sitúan la inscripción en el Registro Mercantil de MADRID (incompatible con un domicilio social en Gijón, que se inscribiría en el RM de Asturias); eInforma da como domicilio actual Paseo de la Florida 5 (sede del Florida Norte); General Ampudia 8 es la dirección anterior al cambio de 2014; Portugal 7 (Gijón) es la sede histórica. Confirmar con el 036 / escrituras.`,
    `Sede de la oficina central (OC): se da de alta en «${flags.officeCity}» — CONFIRMAR (--office-city madrid|gijon|florida); superficie, CCC provincial y epígrafe IAE pendientes (census null).`,
    `Registro Mercantil de CELUISMA S.A.: de MADRID según Empresia y eInforma (2026-09-16); tomo / folio / hoja no son públicos → mercantileRegistry queda ${entity?.mercantileRegistry ? `«${entity.mercantileRegistry}»` : "null"} hasta la nota simple / escrituras (no se escribe nada sin ellas).`,
    `Régimen: pgcVariant «${entity?.pgcVariant ?? "?"}», gran empresa ${entity?.largeCompany ?? "?"}, SII ${entity?.siiEnabled ?? "?"}, inicio de ejercicio mes ${entity?.fiscalYearStartMonth ?? "?"} — se conservan. Datos públicos (eInforma, ejercicio 2024): ${CELUISMA.publicFigures.employees2024} empleados y capital social ${CELUISMA.publicFigures.shareCapitalEur} € → PGC GENERAL probable (Pymes exige no superar dos de tres: activo 4 M€, cifra de negocios 8 M€, 50 empleados de media; con 62 empleados y ~815 habitaciones en 7 hoteles el criterio de plantilla ya se supera); confirmar activo y cifra de negocios 2024-25. SII/mensual si la cifra supera 6.010.121,04 € (y entonces VeriFactu no aplica).`,
    `IVA y ejercicio (paso 7): VatSettings ${snapshot.vatSettings ? "existe" : "NO existe"}, FiscalYear ${snapshot.fiscalYears} fila(s) — no se crean sin la periodicidad (trimestral/mensual), prorrata e inicio de ejercicio confirmados.`,
    `sii_enabled residual en property_compliance_settings (${snapshot.siiFlaggedProperties.length} centro/s: ${snapshot.siiFlaggedProperties.map((id) => snapshot.properties.find((p) => p.id === id)?.code ?? id).join(", ") || "ninguno"}): columna deprecada y no leída; se limpia con la decisión del régimen SII.`,
    `Clave de reparto de la oficina central (corporateAllocation: none | revenue | rooms_available | headcount | manual): pendiente; hoy no hay reparto.`,
    `Política de cadena VeriFactu del asesor: hoy «${entity?.verifactuChainScope ?? "?"}» (una instalación por hotel); números REALES del registro del productor por hotel y certificado del representante: pendientes. Las instalaciones de los hoteles nuevos se abren al activar VeriFactu en cada centro (§5.5 paso 8); el relleno sandbox DEV-001-<COD> solo con --sandbox-installations y se retira antes de preproducción.`,
    `Dirección de Rías Altas: la BD tiene «${rias?.address ?? "—"}» y la lista de César dice «Av. de las Américas 57, 15172 Perillo (Oleiros)»: NO se sobrescribe (fill-only); corregir con PATCH /properties/${RIAS_ALTAS_PROPERTY_ID}/establishment si procede.`,
    `Inventario de Rías Altas: ${riasRooms ?? "120"} habitaciones vendibles de demo en la BD (DBL 60 + DSV 30 + JSU 15 + IND 10 + SRA 5, ninguna fuente lo respalda) frente a ${RIAS_ALTAS_REAT_ROOMS} según el REAT H-CO-000713 y las OTAs: sustituir por la rooming list real antes de operar (este script solo rellena starRating 3, bedCapacity 196 y el registro H-CO-000713; no toca habitaciones).`,
    "Categoría de Alisas Santander (2★ según la web, confirmar), nombre comercial de Las Lomas (Faranda Express vs City House; un rename posterior con PATCH establishment no rompe la convergencia: el script identifica el centro por (sociedad, código)), reparto real por tipo de habitación y plazas de PG / MC / AS / FN (estimados) y registros turísticos / códigos SES de los 7 hoteles.",
    "Otra sociedad del grupo con relación económica (Faranda International Hotels S.L., B87303095: alquileres / servicios): pendiente; afectaría a la fase grupo (409 MULTI_ENTITY_NOT_ENABLED hoy).",
    "Personas (paso 10): directores de hotel limitados a su centro y contratos de la oficina (propertyId = OC) los asigna el integrador tras el apply; este script solo da a Carmen su rol Owner en los centros nuevos.",
    "org_123 (demo): cerrar FAC-2026- de prop_canary y decidir la factura FAC-2026-000001 duplicada antes de crear los índices únicos (fuera de este script)."
  ];
  return items;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

type AuditModule = typeof import("../modules/audit/audit.service.js");

async function recordStep(audit: AuditModule | null, organizationId: string, entityId: string, report: StepReport, details: unknown): Promise<void> {
  if (!audit) return;
  audit.recordAuditEvent({
    organizationId,
    actorUserId: SYSTEM_USER_ID,
    actorType: "system",
    action: AUDIT_ACTION,
    entityType: "legal_entity",
    entityId,
    afterJson: { step: report.step, title: report.title, status: report.status, writes: report.writes, warnings: report.warnings, details },
    correlationId: CORRELATION_ID
  });
}

function centreRowFromSnapshot(property: PropertySnapshot, snapshot: MigrationSnapshot, roomsByProperty: Map<string, number>): CentreRow {
  const series = snapshot.sequences.filter((s) => s.propertyId === property.id && s.active).map((s) => s.prefix ?? s.sequenceCode);
  const installation = snapshot.installations.find((i) => i.propertyId === property.id && i.active)?.numeroInstalacion ?? null;
  return {
    code: property.code ?? "—",
    kind: property.kind,
    name: property.name,
    municipality: property.municipality,
    province: property.province,
    stars: property.starRating,
    rooms: roomsByProperty.get(property.id) ?? null,
    series,
    installation,
    action: "existe",
    propertyId: property.id
  };
}

function centreRowFromSpec(spec: PilotSpec, plan: ProvisionPlan | null, action: CentreRow["action"]): CentreRow {
  const rooms = isHotelKind(spec.property.kind) ? planRooms(hotelInventoryOf(spec)).length : 0;
  return {
    code: spec.property.code ?? plan?.code?.value ?? "—",
    kind: spec.property.kind,
    name: spec.property.name,
    municipality: spec.property.municipality,
    province: spec.property.province,
    stars: (spec.property.census?.starRating as number | null | undefined) ?? null,
    rooms,
    series: plan ? plan.invoiceSequences.map((s) => s.create?.prefix ?? (s.fill.prefix as string | undefined) ?? s.key) : spec.invoiceSequences.map((s) => s.prefix ?? s.sequenceCode),
    installation: null,
    action,
    propertyId: plan?.property.existingId ?? null
  };
}

export async function runMigration(flags: MigrationFlags): Promise<MigrationSummary> {
  const start = Date.now();
  assertConfirmMatches(flags);
  const organizationId = FARANDA_ORGANIZATION_ID;
  const verifactuMode = resolveVerifactuMode();
  const registeredOffice = effectiveRegisteredOffice(flags);
  const summary: MigrationSummary = {
    dryRun: !flags.apply,
    organizationId,
    options: { officeCity: flags.officeCity, fiscalAddress: flags.fiscalAddress, registeredOffice, sandboxInstallations: flags.sandboxInstallations, skipHotels: [...flags.skipHotels] },
    verifactuMode,
    steps: [],
    centres: [],
    collisions: { prefixes: 0, codes: 0, specConflicts: 0 },
    openDecisions: [],
    invariants: { before: null, after: null, unchanged: null },
    expectedMode: null,
    totals: { writes: 0, errors: 0 },
    audit: { flushed: null, error: null },
    durationMs: 0
  };
  const fail = (report: StepReport, message: string): void => {
    report.status = "failed";
    report.errors.push(message);
  };
  const done = (report: StepReport): boolean => {
    summary.steps.push(report);
    summary.totals.writes += report.writes;
    summary.totals.errors += report.errors.length;
    return report.errors.length === 0;
  };

  // Audit chain only when writing (the tip in memory must be the Postgres tip).
  const audit: AuditModule | null = flags.apply ? await import("../modules/audit/audit.service.js") : null;
  if (audit) await audit.hydrateAuditChainFromPostgres();
  // EVERY exit below (happy path and each failed step) goes through finalize():
  // it flushes the fire-and-forget audit queue to Postgres so that a partial
  // --apply is visible to --print-rollback.
  const finalize = (): Promise<MigrationSummary> => finalizeSummary(summary, start, audit);

  // ── 1 · Preconditions ──────────────────────────────────────────────────────
  const s1 = step(1, "Copia de seguridad y precondiciones (solo lectura)");
  const snapshot = await loadSnapshot(organizationId);
  if (!snapshot || !snapshot.organization) {
    fail(s1, `Organización ${organizationId} no encontrada.`);
    done(s1);
    return finalize();
  }
  s1.lines.push(`Organización: ${snapshot.organization.name} (${organizationId})`);
  if (!snapshot.legalEntity) fail(s1, "La organización no tiene sociedad por defecto: ejecuta antes backfill-legal-structure.ts --apply.");
  else s1.lines.push(`Sociedad actual: ${snapshot.legalEntity.code} «${snapshot.legalEntity.legalName}» NIF ${snapshot.legalEntity.taxId ?? "pendiente"} · ${snapshot.legalEntity.pgcVariant} · cadena ${snapshot.legalEntity.verifactuChainScope} (${snapshot.legalEntity.id})`);
  for (const [id, code] of [[RIAS_ALTAS_PROPERTY_ID, "RA"], [LOS_TILOS_PROPERTY_ID, "LT"]] as const) {
    const row = snapshot.properties.find((p) => p.id === id);
    if (!row) fail(s1, `Centro ${code} (${id}) no encontrado.`);
    else if (row.code !== code) fail(s1, `Centro ${id} tiene código «${row.code ?? "—"}» (esperado ${code}): ejecuta el backfill antes.`);
    else s1.lines.push(`Centro ${code}: «${row.name}» · ${row.kind} · ${row.municipality ?? "—"} (${row.id})`);
  }
  if (!snapshot.verification.ok) fail(s1, `Post-condiciones del backfill incumplidas: ${JSON.stringify(snapshot.verification)}`);
  else s1.lines.push("Post-condiciones del backfill: OK (sociedad única, centros y series enlazados, instalación de RA presente)");
  s1.lines.push(`VERIFACTU_MODE=${verifactuMode}${verifactuMode === "sandbox" ? " (relleno DEV-* admitido)" : " (NO se abren instalaciones de relleno)"}`);
  summary.invariants.before = snapshot.invariants;
  s1.lines.push(`Invariantes fiscales antes: ${snapshot.invariants.invoices} facturas (${snapshot.invariants.issuedInvoices} emitidas) · ${snapshot.invariants.verifactuSubmissions} envíos VeriFactu · ${snapshot.invariants.journalEntries} asientos / ${snapshot.invariants.journalLines} líneas — nada de esto se reescribe.`);
  s1.lines.push(flags.apply ? "Backup: se asume hecho por el integrador (bash scripts/backup-postgres.sh) con los API :3000/:3400 parados." : "Antes del apply: pg_dump / bash scripts/backup-postgres.sh y parar los API (:3000/:3400).");
  if (!done(s1) || !snapshot.legalEntity) return finalize();
  const entity = snapshot.legalEntity;
  const roomsByProperty = new Map<string, number>();
  for (const property of snapshot.properties) roomsByProperty.set(property.id, await prisma.room.count({ where: { propertyId: property.id, sellable: true } }));

  // ── Specs + cross-batch checks (before any write) ────────────────────────
  let specs: LoadedSpecs;
  const s0 = step(0, "Specs y comprobación cruzada de códigos y prefijos");
  try {
    specs = loadMigrationSpecs({ officeCity: flags.officeCity, skipHotels: flags.skipHotels });
  } catch (error) {
    fail(s0, error instanceof Error ? error.message : String(error));
    done(s0);
    return finalize();
  }
  const batchSpecs = [specs.office.spec, ...specs.hotels.map((h) => h.spec)];
  // Identity of a centre = (sociedad, código); the name is only a fallback (l8#7).
  const isNewCentre = (spec: PilotSpec, properties: readonly PropertySnapshot[] = snapshot.properties): boolean => findExistingCentre(properties, spec, entity.id) === null;
  const newSpecs = batchSpecs.filter((spec) => isNewCentre(spec));
  const existingCodes = snapshot.properties.map((p) => p.code).filter((c): c is string => c !== null);
  const codeClashes = detectCodeClashes(existingCodes, newSpecs);
  const seriesPlan = planRiasAltasSeries(snapshot.sequences);
  const plannedRows = plannedActiveSeries({ existing: snapshot.sequences, seriesPlan, specs: newSpecs });
  const prefixClashes = detectBatchPrefixClashes(plannedRows);
  summary.collisions.codes = codeClashes.length;
  summary.collisions.prefixes = prefixClashes.length;
  s0.lines.push(`Specs: oficina ${specs.office.file} (${flags.officeCity}) + ${specs.hotels.length} hoteles (${specs.hotels.map((h) => h.code).join(", ") || "ninguno"})${specs.skipped.length ? ` · omitidos: ${specs.skipped.join(", ")}` : ""}`);
  s0.lines.push(`Códigos de centro tras el lote: ${[...existingCodes, ...newSpecs.map((s) => s.property.code)].join(" · ")} → colisiones ${codeClashes.length} (identidad de centro = (sociedad, código); nombre solo como respaldo)`);
  s0.lines.push(`Series activas tras el lote: ${plannedRows.length} · colisiones de prefijo (sociedad, upper(prefix), año): ${prefixClashes.length}`);
  for (const clash of codeClashes) fail(s0, `Código de centro repetido: ${clash}`);
  for (const clash of prefixClashes) fail(s0, `${clash.code}: ${clash.message}`);
  if (!done(s0)) return finalize();

  // ── 2 · Sociedad ──────────────────────────────────────────────────────────
  const s2 = step(2, "Sociedad: FAR → CEL «CELUISMA S.A.» A33615980");
  const entityPlan = planLegalEntityPatch(entity, flags.fiscalAddress, registeredOffice);
  for (const change of entityPlan.changes) s2.lines.push(`${change.highRisk ? "ALTO RIESGO " : ""}${change.field}: ${JSON.stringify(change.from)} → ${JSON.stringify(change.to)}`);
  if (flags.fiscalAddress) {
    s2.lines.push(`Domicilio fiscal «${flags.fiscalAddress}» (${ADDRESS_OPTIONS[flags.fiscalAddress].source}) · domicilio social «${registeredOffice}»${flags.registeredOffice ? "" : " (= fiscal, sin --registered-office)"} — CONFIRMAR con el 036 / escrituras`);
  } else {
    s2.lines.push(`Domicilio fiscal y social: SIN FLAG → las ${LEGAL_ENTITY_ADDRESS_FIELDS.length} columnas de dirección NO se planifican (quedan como están: ${LEGAL_ENTITY_ADDRESS_FIELDS.map((f) => `${f}=${JSON.stringify((entity as unknown as Record<string, unknown>)[f] ?? null)}`).join(", ")}); --apply exige --fiscal-address gijon|madrid|florida`);
    for (const key of ADDRESS_OPTION_KEYS) s2.lines.push(`  candidato ${describeAddress(key)} · fuente: ${ADDRESS_OPTIONS[key].source}`);
    s2.warnings.push("Fuentes públicas (2026-09-16): Empresia y eInforma inscriben CELUISMA S.A. en el Registro Mercantil de MADRID (un domicilio social en Gijón se inscribiría en el RM de Asturias); eInforma da Paseo de la Florida 5 como domicilio actual. Sin confirmación de César no se escribe ninguna dirección.");
  }
  s2.lines.push(`Sin cambios: pgcVariant ${entity.pgcVariant}, largeCompany ${entity.largeCompany}, siiEnabled ${entity.siiEnabled}, fiscalYearStartMonth ${entity.fiscalYearStartMonth}, verifactuChainScope ${entity.verifactuChainScope} (decisiones abiertas)`);
  if (!entityPlan.body) {
    s2.status = "skipped";
    s2.lines.push("La sociedad ya es CELUISMA S.A. con los datos confirmados: 0 cambios.");
  } else {
    s2.writes = 1;
    s2.status = flags.apply ? "applied" : "planned";
    s2.lines.push(`PATCH legal-entities/${entity.id} vía patchLegalEntity (${entityPlan.changes.length} campos; confirmHighRisk ${entityPlan.highRiskFields.length > 0 ? `= true por ${entityPlan.highRiskFields.join(", ")}` : "no necesario"})`);
    if (flags.apply) {
      try {
        const { patchLegalEntity } = await import("../modules/structure/legal-entity.service.js");
        const result = await patchLegalEntity({ context: systemContext(organizationId, RIAS_ALTAS_PROPERTY_ID), legalEntityId: entity.id, body: entityPlan.body, correlationId: CORRELATION_ID });
        s2.lines.push(`Sociedad ahora: ${result.code} «${result.legalName}» NIF ${result.taxId ?? "pendiente"} (${result.taxIdValid ? "checksum OK" : "checksum KO"})`);
        for (const warning of result.warnings) s2.warnings.push(warning);
      } catch (error) {
        fail(s2, error instanceof Error ? error.message : String(error));
      }
    } else {
      const legacy = seriesPlan.close.map((c) => `${c.prefix} (siguiente ${c.nextNumber})`);
      if (legacy.length) s2.warnings.push(`Tras el cambio de NIF las series ${legacy.join(" y ")} quedan bloqueadas (ISSUER_TAX_ID_SERIES_MISMATCH): el paso 6 las cierra y abre las de RA.`);
    }
  }
  await recordStep(audit, organizationId, entity.id, s2, { changes: entityPlan.changes, fiscalAddress: flags.fiscalAddress, registeredOffice });
  if (!done(s2)) return finalize();

  // ── 3 · Centros existentes ────────────────────────────────────────────────
  const s3 = step(3, "Centros existentes RA y LT: censo fill-only (código y nombre comercial ya vienen del backfill)");
  const censusPlans: CensusFillPlan[] = [];
  for (const propertyId of Object.keys(EXISTING_CENTRE_CENSUS)) {
    const row = snapshot.properties.find((p) => p.id === propertyId)!;
    const plan = planCensusFill(propertyId, { starRating: row.starRating, bedCapacity: row.bedCapacity, tourismRegistryNumber: row.tourismRegistryNumber });
    censusPlans.push(plan);
    const fill = plan.patch ? Object.entries(plan.patch).map(([k, v]) => `${k}=${JSON.stringify(v)}`) : [];
    s3.lines.push(`${plan.code} «${plan.label}»: ${fill.length ? `rellena ${fill.join(", ")}` : "sin campos vacíos que rellenar"}${plan.same.length ? ` · iguales: ${plan.same.join(", ")}` : ""}`);
    for (const c of plan.conflicts) s3.warnings.push(`${plan.code} · ${c.field}: actual ${JSON.stringify(c.current)} ≠ previsto ${JSON.stringify(c.desired)} (se conserva el actual)`);
    if (plan.patch) s3.writes += 1;
  }
  s3.status = s3.writes === 0 ? "skipped" : flags.apply ? "applied" : "planned";
  if (flags.apply && s3.writes > 0) {
    try {
      const { patchEstablishment } = await import("../modules/structure/property-provisioning.service.js");
      for (const plan of censusPlans) {
        if (!plan.patch) continue;
        await patchEstablishment({ context: systemContext(organizationId, plan.propertyId), propertyId: plan.propertyId, patch: plan.patch, correlationId: CORRELATION_ID });
      }
    } catch (error) {
      fail(s3, error instanceof Error ? error.message : String(error));
    }
  }
  await recordStep(audit, organizationId, entity.id, s3, { census: censusPlans.map((p) => ({ propertyId: p.propertyId, patch: p.patch, conflicts: p.conflicts })) });
  if (!done(s3)) return finalize();

  // ── 4 · Oficina central + 5 · Cinco hoteles (same service) ───────────────
  const provisionCentre = async (report: StepReport, entry: { code: string; file: string; spec: PilotSpec }): Promise<void> => {
    // The centre is identified by (sociedad, código); buildPlan still resolves by
    // name, so a renamed centre is handed to it under its current DB name.
    const known = findExistingCentre(snapshot.properties, entry.spec, entity.id);
    const { spec, renamed } = specForExistingCentre(entry.spec, known);
    const plan = await buildPlan(spec, organizationId);
    const planSummary = summarizePlan(plan);
    const existed = plan.property.existingId !== null;
    const writes = planSummary.writes.reduce((sum, w) => sum + (w.count ?? 1), 0);
    report.lines.push(`${entry.code} «${entry.spec.property.name}» (${entry.file}): ${existed ? `EXISTE ${plan.property.existingId}, converge` : "NUEVO"} · ${planSummary.writes.length} escrituras por tabla (${writes} filas) · ${planSummary.skips.length} sin cambios · ${planSummary.conflicts.length} conflictos`);
    if (renamed && known) report.lines.push(`  identidad por (sociedad, código ${entry.code}): en BD se llama «${known.name}»${known.tradeName ? ` / «${known.tradeName}»` : ""} (spec «${entry.spec.property.name}»): el nombre NO se toca (rename = PATCH establishment)`);
    if (isHotelKind(spec.property.kind)) {
      const rooms = planRooms(hotelInventoryOf(spec));
      const byType: Record<string, number> = {};
      for (const r of rooms) byType[r.roomTypeCode] = (byType[r.roomTypeCode] ?? 0) + 1;
      report.lines.push(`  habitaciones ${rooms.length}: ${Object.entries(byType).map(([c, n]) => `${c}=${n}`).join(" · ")}${spec.roomTypes?._estimated ? " (reparto ESTIMADO)" : " (reparto público)"} · plazas ${spec.property.census?.bedCapacity ?? "—"} · ${spec.property.census?.starRating ?? "—"}★`);
    } else {
      report.lines.push("  sin edificio, habitaciones, tipos, tarifas ni series (R6: centro no alojativo, no factura)");
    }
    for (const line of formatPlannedWrites(planSummary.writes)) report.lines.push(`  ${line.trim()}`);
    for (const conflict of planSummary.conflicts) report.errors.push(`${entry.code}: ${conflict}`);
    for (const seq of plan.invoiceSequences) if (seq.prefixClash) report.errors.push(`${entry.code}: ${seq.prefixClash}`);
    summary.collisions.specConflicts += planSummary.conflicts.length;
    summary.centres.push(centreRowFromSpec(spec, plan, existed ? (writes > 0 ? "converge" : "existe") : "crear"));
    if (writes === 0) return;
    report.writes += writes;
    if (report.errors.length > 0) return;
    if (flags.apply) {
      const { applyProvisionPlan } = await import("../modules/structure/property-provisioning.service.js");
      const applied = await applyProvisionPlan({ spec, plan, organizationId, actor: { userId: SYSTEM_USER_ID, actorType: "system" }, correlationId: CORRELATION_ID, planSummary });
      const failed = applied.postConditions.filter((c) => !c.ok);
      for (const c of failed) report.errors.push(`${entry.code}: post-condición ${c.check}: esperado ${c.expected}, real ${c.actual}`);
      report.lines.push(`  → creado/convergido ${applied.propertyId} · audit PROPERTY_PROVISIONED ${applied.auditEventId}`);
      const row = summary.centres.find((c) => c.code === entry.code);
      if (row) row.propertyId = applied.propertyId;
    }
  };

  const s4 = step(4, `Oficina central (kind office, code ${OFFICE_CODE}, ${flags.officeCity}, sin series)`);
  try {
    await provisionCentre(s4, { code: OFFICE_CODE, file: specs.office.file, spec: specs.office.spec });
  } catch (error) {
    fail(s4, error instanceof Error ? error.message : String(error));
  }
  s4.status = s4.errors.length ? "failed" : s4.writes === 0 ? "skipped" : flags.apply ? "applied" : "planned";
  await recordStep(audit, organizationId, entity.id, s4, { centre: OFFICE_CODE });
  if (!done(s4)) return finalize();

  const s5 = step(5, `Cinco hoteles desde specs parametrizados (${specs.hotels.map((h) => h.code).join(", ") || "ninguno"})`);
  for (const hotel of specs.hotels) {
    try {
      await provisionCentre(s5, hotel);
    } catch (error) {
      fail(s5, `${hotel.code}: ${error instanceof Error ? error.message : String(error)}`);
      break;
    }
  }
  for (const code of specs.skipped) {
    s5.lines.push(`${code}: OMITIDO (--skip-hotels)`);
    const raw = readRawSpec(resolvePath(specsDir(), HOTEL_SPEC_FILES[code]!));
    summary.centres.push(centreRowFromSpec(validateSpec(raw), null, "omitido"));
  }
  s5.status = s5.errors.length ? "failed" : s5.writes === 0 ? "skipped" : flags.apply ? "applied" : "planned";
  await recordStep(audit, organizationId, entity.id, s5, { hotels: specs.hotels.map((h) => h.code), skipped: specs.skipped });
  if (!done(s5)) return finalize();

  // ── 6 · Series de Rías Altas ──────────────────────────────────────────────
  const s6 = step(6, "Series de Rías Altas: cerrar FAC-2026- / REC-2026- (sandbox) y abrir FAC-RA-2026- / REC-RA-2026- / FS-RA-2026-");
  for (const close of seriesPlan.close) s6.lines.push(`CERRAR ${close.sequenceCode}/${SERIES_YEAR} «${close.prefix}» (siguiente ${close.nextNumber}, ${close.nextNumber - 1} emitidas): active=false, sequence_code → ${close.toSequenceCode}; prefijo, padding y nextNumber intactos, ninguna factura se renumera`);
  for (const open of seriesPlan.open) s6.lines.push(`${open.action === "create" ? "ABRIR" : "REABRIR"} ${open.sequenceCode}/${SERIES_YEAR} «${open.prefix}» (${open.invoiceType}, nextNumber 1, padding 6) vía patchBillingSettings (lock + SERIES_PREFIX_CLASH)`);
  for (const skip of seriesPlan.skip) s6.lines.push(`skip ${skip}`);
  for (const blocked of seriesPlan.blocked) fail(s6, blocked);
  s6.writes = seriesPlan.close.length + seriesPlan.open.length;
  s6.status = s6.errors.length ? "failed" : s6.writes === 0 ? "skipped" : flags.apply ? "applied" : "planned";
  if (flags.apply && s6.errors.length === 0 && s6.writes > 0) {
    try {
      if (seriesPlan.close.length > 0) {
        await prisma.$transaction(async (tx) => {
          for (const close of seriesPlan.close) {
            await tx.invoiceSequence.update({ where: { id: close.id }, data: { active: false, sequenceCode: close.toSequenceCode } });
          }
        });
        audit?.recordAuditEvent({
          organizationId,
          propertyId: RIAS_ALTAS_PROPERTY_ID,
          actorUserId: SYSTEM_USER_ID,
          actorType: "system",
          action: "INVOICE_SEQUENCE_CLOSED_SANDBOX",
          entityType: "invoice_sequence",
          entityId: seriesPlan.close.map((c) => c.id).join(","),
          beforeJson: seriesPlan.close.map((c) => ({ id: c.id, sequenceCode: c.sequenceCode, prefix: c.prefix, nextNumber: c.nextNumber, active: true })),
          afterJson: seriesPlan.close.map((c) => ({ id: c.id, sequenceCode: c.toSequenceCode, prefix: c.prefix, nextNumber: c.nextNumber, active: false })),
          correlationId: CORRELATION_ID
        });
      }
      const { patchBillingSettings } = await import("../modules/backoffice/backoffice.service.js");
      for (const open of seriesPlan.open) {
        await patchBillingSettings({
          context: systemContext(organizationId, RIAS_ALTAS_PROPERTY_ID),
          propertyId: RIAS_ALTAS_PROPERTY_ID,
          correlationId: CORRELATION_ID,
          invoiceSequence: { sequenceCode: open.sequenceCode, invoiceType: open.invoiceType, prefix: open.prefix, year: SERIES_YEAR, active: true }
        });
      }
    } catch (error) {
      fail(s6, error instanceof Error ? error.message : String(error));
    }
  }
  await recordStep(audit, organizationId, entity.id, s6, { close: seriesPlan.close, open: seriesPlan.open });
  if (!done(s6)) return finalize();

  // ── 7 · IVA y ejercicio (decisions) ───────────────────────────────────────
  const s7 = step(7, "IVA y ejercicio: sin escrituras (decisiones de César)");
  s7.status = "pending_decision";
  s7.lines.push(`VatSettings: ${snapshot.vatSettings ? "existe" : "no existe"} · FiscalYear: ${snapshot.fiscalYears} · sii_enabled residual en ${snapshot.siiFlaggedProperties.length} centro/s · sociedad: pgcVariant ${entity.pgcVariant}, largeCompany ${entity.largeCompany}, siiEnabled ${entity.siiEnabled}`);
  s7.lines.push("Cuando César confirme régimen y ejercicio: PATCH /legal-entities/:id { siiEnabled | largeCompany | pgcVariant | fiscalYearStartMonth, confirmHighRisk } (+ accounting.configure), PUT /fiscal/vat-settings, POST /accounting/fiscal-years 2026.");
  done(s7);

  // ── 8 · VeriFactu installations ───────────────────────────────────────────
  const s8 = step(8, `Instalaciones VeriFactu por centro (política ${entity.verifactuChainScope}; se abren al activar cada hotel — §5.5 paso 8; relleno ${SANDBOX_INSTALL_NUMBER}-<COD> solo en sandbox${flags.sandboxInstallations ? " y con --sandbox-installations también en los desactivados" : ""})`);
  const afterCentres = flags.apply ? (await loadSnapshot(organizationId))! : null;
  const centreList: CentreForInstallation[] = [];
  const knownProperties = (afterCentres ?? snapshot).properties;
  const knownInstallations = (afterCentres ?? snapshot).installations;
  for (const property of knownProperties) {
    if (property.status === "archived") continue;
    centreList.push({ id: property.id, code: property.code ?? property.id, kind: property.kind, hasActiveInstallation: knownInstallations.some((i) => i.propertyId === property.id && i.active), verifactuEnabled: property.verifactuEnabled });
  }
  if (!flags.apply) {
    for (const spec of batchSpecs) {
      if (!isNewCentre(spec, knownProperties)) continue;
      centreList.push({ id: `new:${spec.property.code}`, code: spec.property.code ?? "—", kind: spec.property.kind, hasActiveInstallation: false, verifactuEnabled: spec.property.verifactuEnabled });
    }
  }
  const installationPlan = planSandboxInstallations({ centres: centreList, mode: verifactuMode, chainScope: entity.verifactuChainScope, takenNumbers: knownInstallations.map((i) => i.numeroInstalacion), fillerForDisabled: flags.sandboxInstallations });
  for (const create of installationPlan.create) s8.lines.push(`CREAR instalación «${create.numeroInstalacion}» → centro ${create.code} (route verifactu, active) — relleno sandbox, nunca se remite con A33615980`);
  for (const skip of installationPlan.skip) s8.lines.push(`skip ${skip}`);
  for (const deferred of installationPlan.deferred) s8.lines.push(`DIFERIDO ${deferred}`);
  for (const pending of installationPlan.pending) s8.lines.push(`PENDIENTE ${pending}`);
  if (installationPlan.deferred.length > 0 && installationPlan.create.length === 0) s8.lines.push(`Ninguna instalación nueva: los ${installationPlan.deferred.length} hoteles sin instalación tienen verifactuEnabled=false; al activar VeriFactu en cada centro se abre la suya (número real del registro del productor fuera de sandbox).`);
  for (const warning of installationPlan.warnings) s8.warnings.push(`${warning.code}: ${warning.message}`);
  s8.writes = installationPlan.create.length;
  s8.status = installationPlan.pending.length > 0 && installationPlan.create.length === 0 ? "pending_decision" : s8.writes === 0 ? "skipped" : flags.apply ? "applied" : "planned";
  if (flags.apply && installationPlan.create.length > 0) {
    try {
      for (const create of installationPlan.create) {
        const row = await prisma.verifactuInstallation.create({
          data: { id: createId("vfi"), legalEntityId: entity.id, propertyId: create.propertyId, numeroInstalacion: create.numeroInstalacion, route: "verifactu", active: true },
          select: { id: true }
        });
        audit?.recordAuditEvent({
          organizationId,
          propertyId: create.propertyId,
          actorUserId: SYSTEM_USER_ID,
          actorType: "system",
          action: "VERIFACTU_INSTALLATION_OPENED",
          entityType: "verifactu_installation",
          entityId: row.id,
          afterJson: { numeroInstalacion: create.numeroInstalacion, route: "verifactu", sandboxFiller: true, chainScope: entity.verifactuChainScope },
          correlationId: CORRELATION_ID
        });
        s8.lines.push(`  → ${row.id} «${create.numeroInstalacion}»`);
      }
    } catch (error) {
      fail(s8, error instanceof Error ? error.message : String(error));
    }
  }
  await recordStep(audit, organizationId, entity.id, s8, { create: installationPlan.create, deferred: installationPlan.deferred, pending: installationPlan.pending });
  if (!done(s8)) return finalize();

  // ── 9 · Contabilidad (read-only) ──────────────────────────────────────────
  const s9 = step(9, "Contabilidad: centro obligatorio en 6/7 (solo lectura)");
  s9.lines.push(`Asientos posted sin centro: ${snapshot.postedEntriesWithoutCentre} (debe ser 0) · asientos totales ${snapshot.invariants.journalEntries} (todos con property_id RA) · asientos futuros de la sede → OC`);
  if (snapshot.postedEntriesWithoutCentre > 0) s9.warnings.push("Hay asientos posted sin centro: revisar antes de activar la regla R4 en producción.");
  done(s9);

  // ── 10 · Personas ─────────────────────────────────────────────────────────
  const s10 = step(10, "Personas: Carmen Owner en todos los centros (vía owners de los specs); permisos de sociedad del rol Owner");
  const hasEntityWide = ENTITY_WIDE_KEYS.every((key) => snapshot.ownerRolePermissionKeys.includes(key));
  s10.lines.push(`Rol Owner (${OWNER_ROLE_ID}) lleva ${snapshot.ownerRolePermissionKeys.join(", ") || "ninguna de las claves de estructura"} → ${hasEntityWide ? "lectura de toda la sociedad + estructura OK" : "FALTAN claves: ejecutar rbac:sync"}`);
  s10.lines.push(`Carmen (${CARMEN_USER_ID}) tiene rol en ${snapshot.carmenPropertyIds.length} centro/s antes del lote; los specs añaden user_property_roles en ${newSpecs.length} centro/s nuevos (departamento MGMT, roleLabel owner)`);
  s10.lines.push("recepcion.tilos@faranda.test: sin cambios. Directores por hotel y contratos de la oficina (propertyId = OC): decisión de César tras el apply.");
  if (!hasEntityWide) s10.warnings.push("El rol Owner no tiene accounting.entity.read / organization.structure.manage: Carmen vería la estructura redactada hasta rbac:sync.");
  done(s10);

  // ── 11 · Verificación ─────────────────────────────────────────────────────
  const s11 = step(11, "Verificación: 8 centros, series por centro, 0 colisiones, invariantes fiscales");
  const after = flags.apply ? (await loadSnapshot(organizationId))! : snapshot;
  const expectedCentres = snapshot.properties.length + newSpecs.length;
  const centresAfter = flags.apply ? after.properties.length : expectedCentres;
  summary.expectedMode = deriveStructureMode({ legalEntities: 1, properties: centresAfter });
  s11.lines.push(`Centros ${flags.apply ? "" : "previstos "}tras el lote: ${centresAfter} (${flags.apply ? after.properties.filter((p) => p.kind === "hotel").length : snapshot.properties.filter((p) => p.kind === "hotel").length + specs.hotels.length} hoteles · ${flags.apply ? after.properties.filter((p) => p.kind === "office").length : 1} oficina) → mode ${summary.expectedMode}${specs.skipped.length ? ` (${specs.skipped.length} omitidos)` : ""}`);
  const activeAfter: ActiveSeriesRow[] = flags.apply ? after.sequences.filter((s) => s.active) : plannedRows;
  const clashesAfter = detectBatchPrefixClashes(activeAfter);
  s11.lines.push(`Series activas ${flags.apply ? "" : "previstas "}: ${activeAfter.length} · colisiones de prefijo: ${clashesAfter.length}`);
  for (const clash of clashesAfter) fail(s11, `${clash.code}: ${clash.message}`);
  if (flags.apply) {
    const { findSeriesBlockedByTaxIdChange } = await import("../modules/invoicing/invoice.service.js");
    const blocked = await findSeriesBlockedByTaxIdChange({ organizationId, legalEntityId: entity.id, nextTaxId: after.legalEntity?.taxId ?? null });
    s11.lines.push(`Series activas bloqueadas por el NIF ${after.legalEntity?.taxId ?? "—"}: ${blocked.length} (debe ser 0)`);
    for (const row of blocked) fail(s11, `Serie ${row.prefix} (${row.propertyId}) emitida con ${row.seriesTaxId}: ciérrala antes de emitir.`);
    if (!after.verification.ok) fail(s11, `Post-condiciones del backfill tras el apply: ${JSON.stringify(after.verification)}`);
    else s11.lines.push("Post-condiciones del backfill (verifyOrganization): OK");
    summary.invariants.after = after.invariants;
    const unchanged = JSON.stringify(after.invariants) === JSON.stringify(snapshot.invariants);
    summary.invariants.unchanged = unchanged;
    s11.lines.push(`Invariantes fiscales después: ${after.invariants.invoices} facturas · ${after.invariants.verifactuSubmissions} envíos · ${after.invariants.journalEntries} asientos / ${after.invariants.journalLines} líneas → ${unchanged ? "IDÉNTICOS" : "DIFIEREN"}`);
    if (!unchanged) fail(s11, "Los invariantes fiscales cambiaron: revisar (nada de esto debía tocarse).");
    for (const property of after.properties) {
      const series = after.sequences.filter((s) => s.propertyId === property.id && s.active).map((s) => s.prefix).join(", ");
      const installation = after.installations.find((i) => i.propertyId === property.id && i.active)?.numeroInstalacion ?? "—";
      s11.lines.push(`  ${property.code ?? "—"} · ${property.kind} · series [${series || "ninguna"}] · instalación ${installation}`);
    }
  } else {
    s11.lines.push(`Invariantes fiscales: no se tocan en ningún paso (${snapshot.invariants.invoices} facturas · ${snapshot.invariants.verifactuSubmissions} envíos · ${snapshot.invariants.journalEntries} asientos).`);
    s11.lines.push(`Comprobación tras el apply: GET /organizations/me/structure → mode multi_center y ${expectedCentres} centros; SQL de colisiones (runbook §17.9) = 0 filas; 303 del trimestre con declarante CELUISMA S.A.; libro de facturas idéntico.`);
  }
  s11.status = s11.errors.length ? "failed" : "ok";
  await recordStep(audit, organizationId, entity.id, s11, { centres: centresAfter, mode: summary.expectedMode, invariants: summary.invariants });
  done(s11);

  // Centre table (existing first, in creation order) and open decisions.
  const existingRows = (flags.apply ? after : snapshot).properties.map((p) => centreRowFromSnapshot(p, flags.apply ? after : snapshot, roomsByProperty));
  const plannedRowsByCode = new Map(summary.centres.map((c) => [c.code, c]));
  const merged: CentreRow[] = [];
  for (const code of EXPECTED_CENTRE_CODES) {
    const fromDb = existingRows.find((r) => r.code === code);
    const planned = plannedRowsByCode.get(code);
    if (fromDb && planned && flags.apply) merged.push({ ...fromDb, action: planned.action, rooms: fromDb.rooms ?? planned.rooms });
    else if (fromDb) merged.push(fromDb);
    else if (planned) merged.push(planned);
  }
  for (const row of existingRows) if (!merged.some((m) => m.code === row.code)) merged.push(row);
  summary.centres = merged;
  summary.openDecisions = openDecisions(snapshot, flags, { roomsByProperty });
  return finalize();
}

/** The only thing finalizeSummary needs from the audit module (mockable in the unit tests). */
export type AuditFlusher = { flushAuditQueues(): Promise<void> };

/**
 * Closes a run: waits for the fire-and-forget audit queue (step marks and the
 * services' own events, all persisted through queueAuditPersist) so that they
 * are in Postgres BEFORE the caller disconnects — on the happy path AND on
 * every failed step, otherwise --print-rollback would claim «nada que deshacer»
 * after a partial apply. A flush failure never hides the summary: it is
 * recorded in summary.audit and on the last step, and logged.
 */
export async function finalizeSummary(summary: MigrationSummary, startedAt: number, audit: AuditFlusher | null): Promise<MigrationSummary> {
  try {
    if (audit) {
      await audit.flushAuditQueues();
      summary.audit = { flushed: true, error: null };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    summary.audit = { flushed: false, error: message };
    summary.steps.at(-1)?.warnings.push(`La cola de auditoría no llegó a Postgres: ${message}. Antes de --print-rollback comprueba audit_events con correlación ${CORRELATION_ID}.`);
    console.error(`[structure:migrate-faranda-celuisma] audit flush failed: ${message}`);
  } finally {
    summary.durationMs = Date.now() - startedAt;
  }
  return summary;
}

/** Entry-point safety net: when --apply dies with an unexpected error, still push the audit queue to Postgres. */
async function flushAuditForExit(apply: boolean): Promise<void> {
  if (!apply) return;
  try {
    const audit = await import("../modules/audit/audit.service.js");
    await audit.flushAuditQueues();
  } catch (error) {
    console.error(`[structure:migrate-faranda-celuisma] audit flush on exit failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Rollback (read-only listing of what --apply wrote and how to undo it)
// ---------------------------------------------------------------------------

export type RollbackReport = { events: number; lines: string[] };

export async function buildRollbackReport(organizationId: string = FARANDA_ORGANIZATION_ID): Promise<RollbackReport> {
  const events = await prisma.auditEvent.findMany({
    where: { organizationId, correlationId: CORRELATION_ID },
    orderBy: { createdAt: "asc" },
    select: { id: true, action: true, entityType: true, entityId: true, beforeJson: true, afterJson: true, createdAt: true }
  });
  const lines: string[] = [];
  if (events.length === 0) {
    lines.push(`Sin eventos con correlación ${CORRELATION_ID}: la migración no se ha aplicado en esta BD; nada que deshacer.`);
    return { events: 0, lines };
  }
  lines.push(`${events.length} eventos de auditoría con correlación ${CORRELATION_ID} (el orden inverso es el orden del rollback):`);
  for (const event of [...events].reverse()) {
    const when = event.createdAt.toISOString();
    switch (event.action) {
      case "LEGAL_ENTITY_UPDATED": {
        const before = (event.beforeJson ?? {}) as Record<string, unknown>;
        const fields = ["legalName", "taxId", "code", "legalForm", "cnae", "fiscalAddress", "fiscalPostalCode", "fiscalMunicipality", "fiscalIneCode", "fiscalProvince", "registeredOfficeAddress", "registeredOfficePostalCode", "registeredOfficeMunicipality", "registeredOfficeProvince", "mercantileRegistry"];
        const body = Object.fromEntries(fields.filter((f) => f in before).map((f) => [f, before[f]]));
        lines.push(`${when} ${event.action} ${event.entityId}: deshacer con PATCH /legal-entities/${event.entityId} ${JSON.stringify({ ...body, confirmHighRisk: true })} (las facturas emitidas conservan su emisor).`);
        break;
      }
      case "PROPERTY_PROVISIONED":
        lines.push(`${when} ${event.action} ${event.entityId}: centro nuevo → baja lógica (UPDATE properties SET status = 'archived' WHERE id = '${event.entityId}'); solo si NO tiene facturas ni instalación se puede borrar con sus satélites (trigger R10.5).`);
        break;
      case "INVOICE_SEQUENCE_CLOSED_SANDBOX": {
        const before = (event.beforeJson ?? []) as Array<{ id: string; sequenceCode: string }>;
        for (const row of before) lines.push(`${when} ${event.action} ${row.id}: deshacer con UPDATE invoice_sequences SET sequence_code = '${row.sequenceCode}', active = true WHERE id = '${row.id}' — SOLO tras cerrar la serie ${row.sequenceCode}-RA-2026- (clave única por código y año).`);
        break;
      }
      case "InvoiceSequenceCreated":
      case "InvoiceSequenceUpdated":
        lines.push(`${when} ${event.action} ${event.entityId}: serie de RA abierta por la migración → cerrar (PATCH /backoffice/properties/${RIAS_ALTAS_PROPERTY_ID}/billing-settings { active: false }); nunca borrar si ya numeró.`);
        break;
      case "VERIFACTU_INSTALLATION_OPENED":
        lines.push(`${when} ${event.action} ${event.entityId}: retirar la instalación de relleno (UPDATE verifactu_installations SET active = false, retired_at = now() WHERE id = '${event.entityId}'); el número es inmutable y no se reutiliza.`);
        break;
      case "ESTABLISHMENT_UPDATED":
        lines.push(`${when} ${event.action} ${event.entityId}: censo rellenado → restaurar beforeJson con PATCH /properties/${event.entityId}/establishment si procede.`);
        break;
      case AUDIT_ACTION:
        lines.push(`${when} ${event.action}: paso ${(event.afterJson as { step?: number } | null)?.step ?? "?"} (marca de la migración; no requiere acción).`);
        break;
      default:
        lines.push(`${when} ${event.action} ${event.entityType} ${event.entityId ?? ""}: revisar a mano.`);
    }
  }
  lines.push("Los eventos de auditoría nunca se borran (cadena hash). Nada fiscal emitido se toca en ningún sentido.");
  return { events: events.length, lines };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<StepStatus, string> = {
  ok: "OK",
  planned: "PREVISTO",
  applied: "APLICADO",
  skipped: "SIN CAMBIOS",
  pending_decision: "PENDIENTE DE CÉSAR",
  blocked: "BLOQUEADO",
  failed: "FALLO"
};

export function formatCentreTable(centres: readonly CentreRow[]): string[] {
  const header = ["Código", "Tipo", "Centro", "Municipio", "Prov.", "★", "Hab.", "Series activas", "Instalación", "Acción"];
  const rows = centres.map((c) => [c.code, c.kind, c.name, c.municipality ?? "—", c.province ?? "—", c.stars === null ? "—" : String(c.stars), c.rooms === null ? "—" : String(c.rooms), c.series.length ? c.series.join(" ") : "—", c.installation ?? "—", c.action]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => `| ${cells.map((cell, i) => cell.padEnd(widths[i]!)).join(" | ")} |`;
  return [line(header), `|${widths.map((w) => "-".repeat(w + 2)).join("|")}|`, ...rows.map(line)];
}

export function printHuman(summary: MigrationSummary): void {
  const lines: string[] = [];
  lines.push(`[structure:migrate-faranda-celuisma] ${summary.dryRun ? "DRY-RUN (no escribe)" : "APPLY"} · org ${summary.organizationId} · oficina ${summary.options.officeCity} · domicilio fiscal ${summary.options.fiscalAddress ?? "SIN DECIDIR"} · domicilio social ${summary.options.registeredOffice ?? "SIN DECIDIR"}${summary.options.sandboxInstallations ? " · relleno sandbox en desactivados" : ""}${summary.options.skipHotels.length ? ` · omitidos ${summary.options.skipHotels.join(",")}` : ""} · VERIFACTU_MODE=${summary.verifactuMode} · ${summary.durationMs} ms`);
  for (const report of summary.steps) {
    lines.push("");
    lines.push(`Paso ${report.step} · ${report.title} → ${STATUS_LABEL[report.status]}${report.writes ? ` (${report.writes} escrituras)` : ""}`);
    for (const l of report.lines) lines.push(`  ${l}`);
    for (const w of report.warnings) lines.push(`  AVISO ${w}`);
    for (const e of report.errors) lines.push(`  ERROR ${e}`);
  }
  lines.push("");
  lines.push(`Centros (${summary.centres.length}) → mode ${summary.expectedMode ?? "?"}:`);
  lines.push(...formatCentreTable(summary.centres));
  lines.push("");
  lines.push(`Colisiones: prefijos ${summary.collisions.prefixes} · códigos ${summary.collisions.codes} · conflictos spec↔BD ${summary.collisions.specConflicts}`);
  lines.push(`Escrituras ${summary.dryRun ? "previstas" : "realizadas"}: ${summary.totals.writes} · errores: ${summary.totals.errors}`);
  if (summary.invariants.before) {
    const b = summary.invariants.before;
    lines.push(`Invariantes fiscales: ${b.invoices} facturas · ${b.verifactuSubmissions} envíos · ${b.journalEntries} asientos / ${b.journalLines} líneas${summary.invariants.unchanged === null ? " (no se tocan)" : summary.invariants.unchanged ? " → idénticos tras el apply" : " → DIFIEREN tras el apply"}`);
  }
  if (summary.openDecisions.length) {
    lines.push("");
    lines.push("Decisiones abiertas (solo César):");
    summary.openDecisions.forEach((d, i) => lines.push(`  ${i + 1}. ${d}`));
  }
  lines.push("");
  if (summary.dryRun) {
    lines.push(`Nada escrito. Tras la confirmación de César: backup + API parados + --apply --confirm ${summary.organizationId} --fiscal-address gijon|madrid|florida [--registered-office …] [--office-city …] [--sandbox-installations]; después reiniciar UNA instancia del API y repetir el dry-run con los mismos flags (debe dar 0 escrituras).`);
  } else {
    lines.push(`Auditoría volcada a Postgres: ${summary.audit.flushed === true ? "sí" : `NO (${summary.audit.error ?? "?"})`}. Reinicia el API (:3000, una sola instancia: espejos in-memory y clave del lock de cadena). Repite el dry-run con los mismos flags: debe planificar 0 escrituras. Rollback: --print-rollback.`);
  }
  console.log(lines.join("\n"));
}

const entryFile = resolvePath(fileURLToPath(import.meta.url));
const argFile = process.argv[1] ? resolvePath(process.argv[1]) : "";
if (entryFile === argFile) {
  let flags: MigrationFlags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (error) {
    console.error(`[structure:migrate-faranda-celuisma] ${(error as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (flags.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const run = flags.printRollback
    ? buildRollbackReport().then((report) => {
        if (flags.json) console.log(JSON.stringify(report, null, 2));
        else console.log(report.lines.join("\n"));
        return 0;
      })
    : runMigration(flags).then((summary) => {
        if (flags.json) console.log(JSON.stringify(summary, null, 2));
        else printHuman(summary);
        return summary.totals.errors;
      });
  run
    .then(async (failed) => {
      await prisma.$disconnect();
      process.exit(failed > 0 ? 1 : 0);
    })
    .catch(async (error) => {
      console.error("[structure:migrate-faranda-celuisma] failed:", error);
      // A step that threw outside its own try/catch must not lose the audit trail of the steps already applied.
      await flushAuditForExit(flags.apply);
      await prisma.$disconnect().catch(() => undefined);
      process.exit(1);
    });
}
