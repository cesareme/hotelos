// Legal-structure backfill CLI (Tanda 6b · L1 · estructura societaria).
//
// Migration 20260916100000 created the sociedad layer (legal_entities,
// verifactu_installations, Property.kind/code/tradeName, legal_entity_id on
// properties / invoice_sequences / invoices / bank_accounts, installation_id on
// invoices / verifactu_submissions) as NULLABLE columns. This command converges
// every existing tenant onto it, one organisation at a time:
//
//   1. ONE implicit LegalEntity per organisation (isDefault): legalName =
//      Organization.legalName ?? name; taxId = the normalised Organization.taxId
//      when it passes the checksum, is not the sandbox placeholder and no other
//      legal entity holds it — otherwise NULL plus a warning (the unique index on
//      legal_entities.tax_id never blocks the run); code derived from the legal
//      name; pgcVariant pymes, verifactuChainScope per_center (defaults).
//   2. Every Property: legalEntityId = that entity; kind stays `hotel` (column
//      default: every existing property is a hotel); code = initials of the
//      commercial name minus brand / generic words (Rías Altas → RA, Los Tilos →
//      LT, Anfitorio Madrid Centro → AMC; numeric suffix on collision);
//      tradeName = the deprecated Property.legalName when it differs from the
//      razón social (it was the hotel's commercial name, never the issuer).
//   3. One VerifactuInstallation per property that ALREADY has VeriFactu
//      submissions (the others get theirs when VeriFactu is activated, L3):
//      numeroInstalacion = the NumeroInstalacion actually declared in those
//      records (software_json), else --install-number / VERIFACTU_INSTALL_NUMBER,
//      else the sandbox filler DEV-001 (warning). A second property of the same
//      entity with the same number gets `<number>-<code>` (warning: the pair
//      (obligado; instalación) must be unique — Orden HAC/1177/2024 7.c). The
//      chained invoices and the submissions of that property are linked to it.
//   4. InvoiceSequence.legalEntityId, Invoice.legalEntityId and
//      BankAccount.legalEntityId filled where NULL.
//   5. Report per organisation: prefix clashes per legal entity (upper(prefix),
//      year), duplicated invoice numbers under the same NIF, SII flags left on
//      properties (the regime belongs to the sociedad: reviewed in L8, never
//      flipped here). The deferred unique indexes of migration 20260916101000
//      are created only once this report is clean.
//
// Nothing fiscal is rewritten: issuer snapshots of issued invoices are immutable
// by trigger, numbers are never renumbered, series are never closed here.
// Reversible: every write is a new row or a NULL → value fill of the new columns.
//
// Usage (from apps/api, DATABASE_URL in env or ../../.env):
//   node --env-file-if-exists=../../.env --import tsx src/scripts/backfill-legal-structure.ts \
//     [--dry-run | --apply --confirm <orgId|all> [--confirm <orgId>]] [--org <orgId>] \
//     [--install-number <numero>] [--json]
//
//   --dry-run              (default) print the plan per organisation, write nothing
//   --apply                write; ONLY the organisations named with --confirm (or all with "all")
//   --confirm <orgId|all>  exact organisation id (repeatable) or the literal "all"
//   --org <orgId>          limit the run to these organisations (repeatable; default: every one)
//   --install-number <n>   NumeroInstalacion to inherit when the records do not carry one
//                          (default: VERIFACTU_INSTALL_NUMBER, then DEV-001 with a warning)
//   --json                 machine-readable output
//   --help, -h             this usage
//
// Idempotent: a second run plans 0 writes (fields already holding a value are
// never rewritten; installations are matched by property). One transaction and
// one LEGAL_STRUCTURE_BACKFILLED audit event per organisation (audit.service,
// so the change is chained in the trail). In-memory tenant mirrors are only
// hydrated at boot: the operator restarts the API afterwards.
//
// Exit codes: 0 ok · 1 failure (organisation missing, post-condition, DB error) ·
// 2 unknown flag / usage.

import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { SPANISH_TAX_ID_PLACEHOLDER, isValidSpanishTaxId, normalizeTaxId } from "@hotelos/compliance";
import { createId } from "../lib/ids.js";

export const CORRELATION_ID = "corr_legal_structure_backfill";
export const SYSTEM_USER_ID = "usr_system_legal_structure";
export const AUDIT_ACTION = "LEGAL_STRUCTURE_BACKFILLED";
/** Sandbox filler of packages/compliance/src/spain/verifactu/software.ts (VERIFACTU_SOFTWARE_DEFAULTS.numeroInstalacion). */
export const SANDBOX_INSTALL_NUMBER = "DEV-001";
/** LegalEntity.code / Property.code: 2-6 upper-case letters or digits. */
export const CODE_MAX_LENGTH = 6;
const TX_OPTIONS = { maxWait: 30_000, timeout: 300_000 } as const;

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

export type BackfillFlags = {
  apply: boolean;
  confirm: string[];
  orgs: string[];
  installNumber: string | null;
  json: boolean;
  help: boolean;
};

export const USAGE = [
  "Uso (desde apps/api, DATABASE_URL en el entorno o ../../.env):",
  "  node --env-file-if-exists=../../.env --import tsx src/scripts/backfill-legal-structure.ts \\",
  "    [--dry-run | --apply --confirm <orgId|all> [--confirm <orgId>]] [--org <orgId>] [--install-number <n>] [--json]",
  "",
  "  --dry-run              (por defecto) imprime el plan por organización, no escribe nada",
  "  --apply                escribe; SOLO las organizaciones nombradas con --confirm (o todas con \"all\")",
  "  --confirm <orgId|all>  id exacto de la organización (repetible) o el literal all",
  "  --org <orgId>          limita la ejecución a estas organizaciones (repetible; por defecto todas)",
  "  --install-number <n>   NumeroInstalacion heredado cuando los envíos no lo llevan (por defecto VERIFACTU_INSTALL_NUMBER, luego DEV-001 con aviso)",
  "  --json                 salida legible por máquina",
  "  --help, -h             esta ayuda",
  "",
  "Códigos de salida: 0 ok · 1 fallo (organización ausente, post-condición, BD) · 2 flag desconocido / uso."
].join("\n");

export function parseFlags(argv: readonly string[]): BackfillFlags {
  const flags: BackfillFlags = { apply: false, confirm: [], orgs: [], installNumber: null, json: false, help: false };
  let sawDryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { ...flags, help: true };
    if (arg === "--dry-run") sawDryRun = true;
    else if (arg === "--apply") flags.apply = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--confirm" || arg === "--org" || arg === "--install-number") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--") || value.trim() === "") throw new Error(`Flag "${arg}" requires a value.`);
      if (arg === "--confirm") flags.confirm.push(value.trim());
      else if (arg === "--org") flags.orgs.push(value.trim());
      else flags.installNumber = value.trim();
      i++;
    } else if (arg === "--") continue;
    else throw new Error(`Unknown flag "${arg}". Known: --dry-run, --apply, --confirm <orgId|all>, --org <orgId>, --install-number <n>, --json, --help.`);
  }
  if (sawDryRun && flags.apply) throw new Error("--dry-run and --apply are mutually exclusive.");
  if (flags.apply && flags.confirm.length === 0) throw new Error('--apply requires --confirm <orgId> (repeatable) or --confirm all.');
  if (!flags.apply && flags.confirm.length > 0) throw new Error("--confirm only makes sense with --apply.");
  if (flags.confirm.includes("all") && flags.confirm.length > 1) throw new Error('--confirm all cannot be combined with organisation ids.');
  return flags;
}

/** True when the organisation was named with --confirm (or "all" was given). */
export function confirmsOrganization(flags: Pick<BackfillFlags, "confirm">, organizationId: string): boolean {
  return flags.confirm.includes("all") || flags.confirm.includes(organizationId);
}

// ---------------------------------------------------------------------------
// Snapshot (what the planner reads) and plan (what the applier writes)
// ---------------------------------------------------------------------------

export type OrgSnapshot = {
  organization: { id: string; name: string; legalName: string | null; taxId: string | null };
  /** Existing default legal entity, or null before the first run. */
  legalEntity: { id: string; code: string; legalName: string; taxId: string | null } | null;
  properties: Array<{
    id: string;
    name: string;
    legalName: string | null;
    kind: string;
    code: string | null;
    tradeName: string | null;
    legalEntityId: string | null;
    createdAt: Date;
  }>;
  installations: Array<{ id: string; legalEntityId: string; propertyId: string | null; numeroInstalacion: string; active: boolean }>;
  sequences: Array<{ id: string; propertyId: string; sequenceCode: string; prefix: string | null; year: number | null; active: boolean; legalEntityId: string | null }>;
  invoices: Array<{ propertyId: string; total: number; missingEntity: number; chained: number; chainedMissingInstallation: number }>;
  /** Issued, non-deleted invoice numbers (duplicate report under the same NIF). */
  issuedNumbers: Array<{ propertyId: string; invoiceNumber: string }>;
  submissions: Array<{ propertyId: string; total: number; missingInstallation: number; installNumbers: string[] }>;
  bankAccounts: { total: number; missingEntity: number };
  /** Properties whose compliance settings still carry sii_enabled = true. */
  siiProperties: string[];
  /** NIFs already held by legal entities of OTHER organisations (unique index). */
  foreignTaxIds: string[];
};

export type BackfillWarningCode =
  | "TAX_ID_MISSING"
  | "TAX_ID_INVALID"
  | "TAX_ID_PLACEHOLDER"
  | "TAX_ID_DUPLICATE"
  | "SERIES_PREFIX_CLASH"
  | "INVOICE_NUMBER_DUPLICATE"
  | "INSTALLATION_NUMBER_SUFFIXED"
  | "INSTALLATION_NUMBER_SANDBOX_DEFAULT"
  | "SII_FLAG_ON_PROPERTY"
  | "PROPERTY_CODE_SUFFIXED"
  | "PROPERTY_ENTITY_MISMATCH";

export type BackfillWarning = { code: BackfillWarningCode; message: string; details?: Record<string, unknown> };

export type PropertyPlan = {
  id: string;
  name: string;
  kind: string;
  /** Final code (existing or derived). */
  code: string;
  set: { legalEntityId?: string; code?: string; tradeName?: string };
  action: "update" | "skip";
};

export type InstallationPlan = {
  propertyId: string;
  numeroInstalacion: string;
  action: "create" | "exists";
  id: string | null;
  invoicesToLink: number;
  submissionsToLink: number;
};

export type OrgPlan = {
  organizationId: string;
  label: string;
  legalEntity: { action: "create" | "exists"; id: string; code: string; legalName: string; taxId: string | null };
  properties: PropertyPlan[];
  installations: InstallationPlan[];
  sequences: { total: number; toLink: number };
  invoices: { total: number; toLink: number };
  bankAccounts: { total: number; toLink: number };
  warnings: BackfillWarning[];
  /** Planned row writes (0 = converged). */
  writes: number;
};

// ---------------------------------------------------------------------------
// Pure helpers: codes
// ---------------------------------------------------------------------------

/** Words that never make it into a code: lodging words, legal forms, connectors. */
export const GENERIC_CODE_TOKENS: ReadonlySet<string> = new Set([
  "hotel", "hotels", "hoteles", "hostal", "hostel", "apartahotel", "aparthotel", "apartamentos", "apartments",
  "resort", "resorts", "collection", "group", "grupo", "by", "and", "the",
  "sl", "sa", "slu", "sau", "coop", "scoop", "sociedad", "limitada", "anonima"
]);

/** Lower-case, accent-free, alphanumeric form of a token (Rías → rias). */
export function normalizeToken(token: string): string {
  return token
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Meaningful tokens of a commercial name: the part before the first comma and
 * before « by » (brand collections), minus generic words and the tenant's own
 * brand tokens. Falls back to the less-filtered lists so a name never yields
 * nothing. Articles stay (Los Tilos → LT, as the design expects).
 */
export function codeTokens(name: string, brandTokens: readonly string[] = []): string[] {
  let segment = name.split(",")[0] ?? name;
  segment = segment.replace(/\([^)]*\)/g, " ");
  const byIndex = segment.search(/\bby\b/i);
  if (byIndex > 0) segment = segment.slice(0, byIndex);
  const tokens = segment.split(/[\s\-–—·/]+/).map((t) => t.trim()).filter((t) => normalizeToken(t).length > 0);
  const brand = new Set(brandTokens.map(normalizeToken).filter((t) => t.length > 0));
  const notGeneric = tokens.filter((t) => !GENERIC_CODE_TOKENS.has(normalizeToken(t)));
  const notBrand = notGeneric.filter((t) => !brand.has(normalizeToken(t)));
  if (notBrand.length > 0) return notBrand;
  if (notGeneric.length > 0) return notGeneric;
  return tokens.length > 0 ? tokens : [name];
}

/** Initials of up to three meaningful tokens (RA, LT, AMC); first three letters of a single token (FAR). */
export function deriveCode(name: string, brandTokens: readonly string[] = []): string {
  const tokens = codeTokens(name, brandTokens);
  let code =
    tokens.length === 1
      ? normalizeToken(tokens[0] ?? "").slice(0, 3)
      : tokens
          .slice(0, 3)
          .map((t) => normalizeToken(t).charAt(0))
          .join("");
  code = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length < 2) {
    const pool = normalizeToken(tokens.join("")).toUpperCase();
    code = (code + pool.slice(code.length)).slice(0, 2);
  }
  if (code.length < 2) code = (code + "XX").slice(0, 2);
  return code.slice(0, CODE_MAX_LENGTH);
}

/** `desired` when free, else desired + 2, 3… (RA → RA2), always within CODE_MAX_LENGTH. */
export function uniqueCode(desired: string, taken: ReadonlySet<string>): string {
  if (!taken.has(desired)) return desired;
  for (let n = 2; n < 1000; n++) {
    const suffix = String(n);
    const candidate = `${desired.slice(0, CODE_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`No hay código libre para «${desired}».`);
}

/** Tokens of the organisation's names: they are the brand, not the centre (Faranda Hotels & Resorts → faranda, hotels, resorts). */
export function brandTokensOf(organization: { name: string; legalName: string | null }): string[] {
  return `${organization.name} ${organization.legalName ?? ""}`.split(/[\s\-–—·/,&]+/).map((t) => t.trim()).filter((t) => normalizeToken(t).length > 0);
}

// ---------------------------------------------------------------------------
// Pure helpers: NIF, clashes, installations
// ---------------------------------------------------------------------------

/** Copy the organisation NIF only when it is a real, valid, unclaimed identifier. */
export function resolveEntityTaxId(raw: string | null | undefined, claimed: ReadonlySet<string>): { taxId: string | null; warning: BackfillWarning | null } {
  const normalized = normalizeTaxId(raw);
  if (!normalized) {
    return { taxId: null, warning: { code: "TAX_ID_MISSING", message: "La organización no tiene NIF: la sociedad se crea con NIF pendiente (409 ISSUER_TAX_ID_MISSING al emitir en modo real)." } };
  }
  if (normalized === SPANISH_TAX_ID_PLACEHOLDER) {
    return { taxId: null, warning: { code: "TAX_ID_PLACEHOLDER", message: `El NIF ${normalized} es el relleno de sandbox: la sociedad se crea con NIF pendiente.`, details: { taxId: normalized } } };
  }
  if (!isValidSpanishTaxId(normalized)) {
    return { taxId: null, warning: { code: "TAX_ID_INVALID", message: `El NIF ${normalized} no supera el dígito de control: la sociedad se crea con NIF pendiente (misma semántica que el 409 actual).`, details: { taxId: normalized } } };
  }
  if (claimed.has(normalized)) {
    return { taxId: null, warning: { code: "TAX_ID_DUPLICATE", message: `El NIF ${normalized} ya pertenece a otra sociedad (índice único legal_entities.tax_id): la sociedad se crea con NIF pendiente.`, details: { taxId: normalized } } };
  }
  return { taxId: normalized, warning: null };
}

/** Active series of DIFFERENT properties sharing upper(prefix) and year under the same legal entity. */
export function detectPrefixClashes(sequences: readonly { propertyId: string; prefix: string | null; year: number | null; active: boolean }[]): BackfillWarning[] {
  const groups = new Map<string, { prefix: string; year: number | null; propertyIds: Set<string> }>();
  for (const row of sequences) {
    if (!row.active || !row.prefix) continue;
    const key = `${row.prefix.trim().toUpperCase()}|${row.year ?? ""}`;
    const group = groups.get(key) ?? { prefix: row.prefix.trim().toUpperCase(), year: row.year, propertyIds: new Set<string>() };
    group.propertyIds.add(row.propertyId);
    groups.set(key, group);
  }
  const warnings: BackfillWarning[] = [];
  for (const group of groups.values()) {
    if (group.propertyIds.size < 2) continue;
    const propertyIds = [...group.propertyIds].sort();
    warnings.push({
      code: "SERIES_PREFIX_CLASH",
      message: `El prefijo «${group.prefix}»${group.year ? ` (${group.year})` : ""} está activo en ${propertyIds.length} centros de la misma sociedad: el índice único (legal_entity_id, upper(prefix), year) no se puede crear hasta cerrar una de las series (nunca renumerar).`,
      details: { prefix: group.prefix, year: group.year, propertyIds }
    });
  }
  return warnings;
}

/** Issued invoice numbers repeated across properties of the same legal entity. */
export function detectInvoiceNumberDuplicates(numbers: readonly { propertyId: string; invoiceNumber: string }[]): BackfillWarning[] {
  const groups = new Map<string, Set<string>>();
  for (const row of numbers) {
    const set = groups.get(row.invoiceNumber) ?? new Set<string>();
    set.add(row.propertyId);
    groups.set(row.invoiceNumber, set);
  }
  const warnings: BackfillWarning[] = [];
  for (const [invoiceNumber, propertyIds] of groups) {
    if (propertyIds.size < 2) continue;
    warnings.push({
      code: "INVOICE_NUMBER_DUPLICATE",
      message: `El número «${invoiceNumber}» está emitido en ${propertyIds.size} centros de la misma sociedad: el índice único parcial (legal_entity_id, invoice_number) queda aplazado.`,
      details: { invoiceNumber, propertyIds: [...propertyIds].sort() }
    });
  }
  return warnings;
}

export type InstallationPlanInput = {
  /** Properties in creation order with their final code. */
  properties: ReadonlyArray<{ id: string; code: string }>;
  submissions: OrgSnapshot["submissions"];
  invoices: OrgSnapshot["invoices"];
  existing: OrgSnapshot["installations"];
  /** --install-number or VERIFACTU_INSTALL_NUMBER, or null. */
  declaredNumber: string | null;
};

/**
 * One installation per property that already has VeriFactu submissions. The
 * number is the one those records declared (software_json.numeroInstalacion)
 * when it is unique, else the declared one, else the sandbox filler. A second
 * property with the same number in the same entity gets `<number>-<code>`.
 */
export function planInstallations(input: InstallationPlanInput): { plans: InstallationPlan[]; warnings: BackfillWarning[] } {
  const plans: InstallationPlan[] = [];
  const warnings: BackfillWarning[] = [];
  const taken = new Set(input.existing.map((row) => row.numeroInstalacion));
  for (const property of input.properties) {
    const submissions = input.submissions.find((row) => row.propertyId === property.id);
    if (!submissions || submissions.total === 0) continue;
    const invoices = input.invoices.find((row) => row.propertyId === property.id);
    const invoicesToLink = invoices?.chainedMissingInstallation ?? 0;
    const existing = input.existing.find((row) => row.propertyId === property.id && row.active);
    if (existing) {
      plans.push({ propertyId: property.id, numeroInstalacion: existing.numeroInstalacion, action: "exists", id: existing.id, invoicesToLink, submissionsToLink: submissions.missingInstallation });
      continue;
    }
    const declaredInRecords = submissions.installNumbers.length === 1 ? submissions.installNumbers[0] ?? null : null;
    let base = declaredInRecords ?? input.declaredNumber;
    if (!base) {
      base = SANDBOX_INSTALL_NUMBER;
      warnings.push({
        code: "INSTALLATION_NUMBER_SANDBOX_DEFAULT",
        message: `La propiedad ${property.id} tiene ${submissions.total} envíos sin NumeroInstalacion declarado y no hay --install-number ni VERIFACTU_INSTALL_NUMBER: se usa el relleno de sandbox ${SANDBOX_INSTALL_NUMBER}.`,
        details: { propertyId: property.id, installNumbers: submissions.installNumbers }
      });
    }
    let numero = base;
    if (taken.has(numero)) {
      numero = `${base}-${property.code}`;
      for (let n = 2; taken.has(numero); n++) numero = `${base}-${property.code}${n}`;
      warnings.push({
        code: "INSTALLATION_NUMBER_SUFFIXED",
        message: `El número de instalación «${base}» ya lo usa otro centro de la misma sociedad: la propiedad ${property.id} recibe «${numero}» (el par obligado + instalación debe ser único; los envíos previos son sandbox).`,
        details: { propertyId: property.id, base, numeroInstalacion: numero }
      });
    }
    taken.add(numero);
    plans.push({ propertyId: property.id, numeroInstalacion: numero, action: "create", id: null, invoicesToLink, submissionsToLink: submissions.missingInstallation });
  }
  return { plans, warnings };
}

// ---------------------------------------------------------------------------
// Pure planner
// ---------------------------------------------------------------------------

export type PlanOptions = {
  declaredInstallNumber: string | null;
  /** NIFs claimed by entities planned earlier in the same run (mutated). */
  claimedTaxIds: Set<string>;
};

export function planOrganization(snapshot: OrgSnapshot, options: PlanOptions): OrgPlan {
  const organization = snapshot.organization;
  const warnings: BackfillWarning[] = [];
  const legalName = (organization.legalName?.trim() || organization.name).trim();

  let legalEntity: OrgPlan["legalEntity"];
  if (snapshot.legalEntity) {
    legalEntity = { action: "exists", ...snapshot.legalEntity };
  } else {
    const claimed = new Set<string>([...options.claimedTaxIds, ...snapshot.foreignTaxIds.map((id) => normalizeTaxId(id) ?? id)]);
    const resolved = resolveEntityTaxId(organization.taxId, claimed);
    if (resolved.warning) warnings.push(resolved.warning);
    legalEntity = { action: "create", id: createId("le"), code: deriveCode(legalName), legalName, taxId: resolved.taxId };
  }
  if (legalEntity.taxId) options.claimedTaxIds.add(legalEntity.taxId);

  const brand = brandTokensOf(organization);
  const taken = new Set<string>(snapshot.properties.map((p) => p.code).filter((c): c is string => typeof c === "string" && c.length > 0));
  const ordered = [...snapshot.properties].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  const properties: PropertyPlan[] = ordered.map((property) => {
    const set: PropertyPlan["set"] = {};
    let code = property.code;
    if (!code) {
      const desired = deriveCode(property.name, brand);
      code = uniqueCode(desired, taken);
      taken.add(code);
      set.code = code;
      if (code !== desired) {
        warnings.push({ code: "PROPERTY_CODE_SUFFIXED", message: `El código «${desired}» ya existe en la sociedad: la propiedad ${property.id} recibe «${code}».`, details: { propertyId: property.id, desired, code } });
      }
    }
    if (!property.legalEntityId) set.legalEntityId = legalEntity.id;
    else if (property.legalEntityId !== legalEntity.id) {
      warnings.push({ code: "PROPERTY_ENTITY_MISMATCH", message: `La propiedad ${property.id} apunta a otra sociedad (${property.legalEntityId}); no se toca (invariante R10.1).`, details: { propertyId: property.id, legalEntityId: property.legalEntityId } });
    }
    const commercial = property.legalName?.trim() ?? "";
    if (!property.tradeName && commercial.length > 0 && commercial !== legalName) set.tradeName = commercial;
    return { id: property.id, name: property.name, kind: property.kind, code, set, action: Object.keys(set).length > 0 ? "update" : "skip" };
  });

  const installations = planInstallations({
    properties: properties.map((p) => ({ id: p.id, code: p.code })),
    submissions: snapshot.submissions,
    invoices: snapshot.invoices,
    existing: snapshot.installations,
    declaredNumber: options.declaredInstallNumber
  });
  warnings.push(...installations.warnings);

  const sequences = { total: snapshot.sequences.length, toLink: snapshot.sequences.filter((s) => !s.legalEntityId).length };
  warnings.push(...detectPrefixClashes(snapshot.sequences));
  const invoices = {
    total: snapshot.invoices.reduce((sum, row) => sum + row.total, 0),
    toLink: snapshot.invoices.reduce((sum, row) => sum + row.missingEntity, 0)
  };
  warnings.push(...detectInvoiceNumberDuplicates(snapshot.issuedNumbers));
  const bankAccounts = { total: snapshot.bankAccounts.total, toLink: snapshot.bankAccounts.missingEntity };
  if (snapshot.siiProperties.length > 0) {
    warnings.push({
      code: "SII_FLAG_ON_PROPERTY",
      message: `${snapshot.siiProperties.length} propiedad/es llevan sii_enabled = true en su perfil de cumplimiento; el régimen SII es de la sociedad (LegalEntity.siiEnabled, RIVA 62.6) y se revisa en L8: aquí no se activa.`,
      details: { propertyIds: [...snapshot.siiProperties].sort() }
    });
  }

  const writes =
    (legalEntity.action === "create" ? 1 : 0) +
    properties.filter((p) => p.action === "update").length +
    installations.plans.filter((p) => p.action === "create").length +
    installations.plans.reduce((sum, p) => sum + p.invoicesToLink + p.submissionsToLink, 0) +
    sequences.toLink +
    invoices.toLink +
    bankAccounts.toLink;

  return {
    organizationId: organization.id,
    label: organization.name,
    legalEntity,
    properties,
    installations: installations.plans,
    sequences,
    invoices,
    bankAccounts,
    warnings,
    writes
  };
}

/** Pure post-state of a plan (what loadSnapshot returns after applyPlan): the idempotency oracle. */
export function applyPlanToSnapshot(snapshot: OrgSnapshot, plan: OrgPlan): OrgSnapshot {
  const entityId = plan.legalEntity.id;
  const installed = new Set(plan.installations.map((p) => p.propertyId));
  return {
    ...snapshot,
    legalEntity: { id: entityId, code: plan.legalEntity.code, legalName: plan.legalEntity.legalName, taxId: plan.legalEntity.taxId },
    properties: snapshot.properties.map((property) => {
      const planned = plan.properties.find((p) => p.id === property.id);
      return planned ? { ...property, ...planned.set } : property;
    }),
    installations: [
      ...snapshot.installations,
      ...plan.installations
        .filter((p) => p.action === "create")
        .map((p, index) => ({ id: `inst_planned_${index}`, legalEntityId: entityId, propertyId: p.propertyId, numeroInstalacion: p.numeroInstalacion, active: true }))
    ],
    sequences: snapshot.sequences.map((row) => ({ ...row, legalEntityId: row.legalEntityId ?? entityId })),
    invoices: snapshot.invoices.map((row) => ({ ...row, missingEntity: 0, chainedMissingInstallation: installed.has(row.propertyId) ? 0 : row.chainedMissingInstallation })),
    submissions: snapshot.submissions.map((row) => ({ ...row, missingInstallation: installed.has(row.propertyId) ? 0 : row.missingInstallation })),
    bankAccounts: { ...snapshot.bankAccounts, missingEntity: 0 }
  };
}

// ---------------------------------------------------------------------------
// Database: snapshot, apply, verify
// ---------------------------------------------------------------------------

export type BackfillDb = Pick<
  Prisma.TransactionClient,
  "organization" | "legalEntity" | "property" | "verifactuInstallation" | "invoiceSequence" | "invoice" | "verifactuSubmission" | "bankAccount" | "propertyComplianceSetting"
>;

/** Invoices that sit in a VeriFactu chain (an alta or an anulación was generated). */
const CHAINED_INVOICE: Prisma.InvoiceWhereInput = { OR: [{ verifactuHash: { not: null } }, { cancellationHash: { not: null } }] };

export async function loadSnapshot(organizationId: string, db: BackfillDb = prisma): Promise<OrgSnapshot | null> {
  const organization = await db.organization.findUnique({ where: { id: organizationId }, select: { id: true, name: true, legalName: true, taxId: true } });
  if (!organization) return null;
  const legalEntity = await db.legalEntity.findFirst({
    where: { organizationId, isDefault: true },
    orderBy: { createdAt: "asc" },
    select: { id: true, code: true, legalName: true, taxId: true }
  });
  const properties = await db.property.findMany({
    where: { organizationId },
    select: { id: true, name: true, legalName: true, kind: true, code: true, tradeName: true, legalEntityId: true, createdAt: true },
    orderBy: { createdAt: "asc" }
  });
  const propertyIds = properties.map((p) => p.id);
  const installations = legalEntity
    ? await db.verifactuInstallation.findMany({ where: { legalEntityId: legalEntity.id }, select: { id: true, legalEntityId: true, propertyId: true, numeroInstalacion: true, active: true } })
    : [];
  const sequences = propertyIds.length
    ? await db.invoiceSequence.findMany({
        where: { propertyId: { in: propertyIds } },
        select: { id: true, propertyId: true, sequenceCode: true, prefix: true, year: true, active: true, legalEntityId: true }
      })
    : [];
  const invoices: OrgSnapshot["invoices"] = [];
  const submissions: OrgSnapshot["submissions"] = [];
  for (const propertyId of propertyIds) {
    const [total, missingEntity, chained, chainedMissingInstallation] = await Promise.all([
      db.invoice.count({ where: { propertyId } }),
      db.invoice.count({ where: { propertyId, legalEntityId: null } }),
      db.invoice.count({ where: { propertyId, ...CHAINED_INVOICE } }),
      db.invoice.count({ where: { propertyId, installationId: null, ...CHAINED_INVOICE } })
    ]);
    invoices.push({ propertyId, total, missingEntity, chained, chainedMissingInstallation });
    const [subTotal, subMissing, subRows] = await Promise.all([
      db.verifactuSubmission.count({ where: { propertyId } }),
      db.verifactuSubmission.count({ where: { propertyId, installationId: null } }),
      db.verifactuSubmission.findMany({ where: { propertyId }, select: { softwareJson: true } })
    ]);
    const installNumbers = new Set<string>();
    for (const row of subRows) {
      const software = row.softwareJson;
      if (software && typeof software === "object" && !Array.isArray(software)) {
        const value = (software as Record<string, unknown>).numeroInstalacion;
        if (typeof value === "string" && value.trim().length > 0) installNumbers.add(value.trim());
      }
    }
    submissions.push({ propertyId, total: subTotal, missingInstallation: subMissing, installNumbers: [...installNumbers].sort() });
  }
  const issuedNumbers = propertyIds.length
    ? (
        await db.invoice.findMany({
          where: { propertyId: { in: propertyIds }, deletedAt: null, status: { not: "draft" }, invoiceNumber: { not: null } },
          select: { propertyId: true, invoiceNumber: true }
        })
      ).flatMap((row) => (row.invoiceNumber ? [{ propertyId: row.propertyId, invoiceNumber: row.invoiceNumber }] : []))
    : [];
  const [bankTotal, bankMissing] = await Promise.all([
    db.bankAccount.count({ where: { organizationId } }),
    db.bankAccount.count({ where: { organizationId, legalEntityId: null } })
  ]);
  const siiRows = propertyIds.length ? await db.propertyComplianceSetting.findMany({ where: { propertyId: { in: propertyIds }, siiEnabled: true }, select: { propertyId: true } }) : [];
  const foreign = await db.legalEntity.findMany({ where: { organizationId: { not: organizationId }, taxId: { not: null } }, select: { taxId: true } });
  return {
    organization,
    legalEntity,
    properties,
    installations,
    sequences,
    invoices,
    issuedNumbers,
    submissions,
    bankAccounts: { total: bankTotal, missingEntity: bankMissing },
    siiProperties: siiRows.map((row) => row.propertyId),
    foreignTaxIds: foreign.flatMap((row) => (row.taxId ? [row.taxId] : []))
  };
}

export type ApplyCounts = {
  legalEntityCreated: number;
  propertiesUpdated: number;
  installationsCreated: number;
  invoiceInstallationsLinked: number;
  submissionsLinked: number;
  sequencesLinked: number;
  invoicesLinked: number;
  bankAccountsLinked: number;
};

/** Writes the plan inside the caller's transaction. Every statement is a create or a NULL → value fill. */
export async function applyPlan(plan: OrgPlan, tx: BackfillDb): Promise<ApplyCounts> {
  const counts: ApplyCounts = { legalEntityCreated: 0, propertiesUpdated: 0, installationsCreated: 0, invoiceInstallationsLinked: 0, submissionsLinked: 0, sequencesLinked: 0, invoicesLinked: 0, bankAccountsLinked: 0 };
  const entityId = plan.legalEntity.id;
  if (plan.legalEntity.action === "create") {
    await tx.legalEntity.create({
      data: { id: entityId, organizationId: plan.organizationId, code: plan.legalEntity.code, legalName: plan.legalEntity.legalName, taxId: plan.legalEntity.taxId, isDefault: true, status: "active" }
    });
    counts.legalEntityCreated = 1;
  }
  for (const property of plan.properties) {
    if (property.action !== "update") continue;
    await tx.property.update({ where: { id: property.id }, data: property.set });
    counts.propertiesUpdated += 1;
  }
  for (const installation of plan.installations) {
    let installationId = installation.id;
    if (installation.action === "create") {
      const created = await tx.verifactuInstallation.create({
        data: { id: createId("vfi"), legalEntityId: entityId, propertyId: installation.propertyId, numeroInstalacion: installation.numeroInstalacion, route: "verifactu", active: true },
        select: { id: true }
      });
      installationId = created.id;
      counts.installationsCreated += 1;
    }
    if (!installationId) continue;
    const linkedInvoices = await tx.invoice.updateMany({ where: { propertyId: installation.propertyId, installationId: null, ...CHAINED_INVOICE }, data: { installationId } });
    counts.invoiceInstallationsLinked += linkedInvoices.count;
    const linkedSubmissions = await tx.verifactuSubmission.updateMany({ where: { propertyId: installation.propertyId, installationId: null }, data: { installationId } });
    counts.submissionsLinked += linkedSubmissions.count;
  }
  const propertyIds = plan.properties.map((p) => p.id);
  if (propertyIds.length > 0) {
    const sequences = await tx.invoiceSequence.updateMany({ where: { propertyId: { in: propertyIds }, legalEntityId: null }, data: { legalEntityId: entityId } });
    counts.sequencesLinked = sequences.count;
    const invoices = await tx.invoice.updateMany({ where: { propertyId: { in: propertyIds }, legalEntityId: null }, data: { legalEntityId: entityId } });
    counts.invoicesLinked = invoices.count;
  }
  const banks = await tx.bankAccount.updateMany({ where: { organizationId: plan.organizationId, legalEntityId: null }, data: { legalEntityId: entityId } });
  counts.bankAccountsLinked = banks.count;
  return counts;
}

export type Verification = {
  ok: boolean;
  legalEntities: number;
  propertiesWithoutEntity: number;
  /** Centres whose legal entity belongs to another organisation (R10.1; must be 0). */
  propertiesInForeignEntity: number;
  propertiesWithoutCode: number;
  sequencesWithoutEntity: number;
  invoicesWithoutEntity: number;
  chainedInvoicesWithoutInstallation: number;
  submissionsWithoutInstallation: number;
  bankAccountsWithoutEntity: number;
};

/** Post-conditions after --apply (also the converged state a dry-run re-run must report). */
export async function verifyOrganization(organizationId: string, db: BackfillDb = prisma): Promise<Verification> {
  const propertyIds = (await db.property.findMany({ where: { organizationId }, select: { id: true } })).map((p) => p.id);
  const inProps = { propertyId: { in: propertyIds } } as const;
  const [legalEntities, propertiesWithoutEntity, propertiesInForeignEntity, propertiesWithoutCode, sequencesWithoutEntity, invoicesWithoutEntity, bankAccountsWithoutEntity] = await Promise.all([
    db.legalEntity.count({ where: { organizationId, isDefault: true, status: "active" } }),
    db.property.count({ where: { organizationId, legalEntityId: null } }),
    // R10.1 (trigger properties_sociedad_inmutable, 20260916102000): rows written before the trigger are reported here.
    db.property.count({ where: { organizationId, legalEntity: { is: { organizationId: { not: organizationId } } } } }),
    db.property.count({ where: { organizationId, code: null } }),
    propertyIds.length ? db.invoiceSequence.count({ where: { ...inProps, legalEntityId: null } }) : Promise.resolve(0),
    propertyIds.length ? db.invoice.count({ where: { ...inProps, legalEntityId: null } }) : Promise.resolve(0),
    db.bankAccount.count({ where: { organizationId, legalEntityId: null } })
  ]);
  // Installations exist only for properties with submissions: measure the gap on those.
  const withSubmissions = propertyIds.length
    ? (await db.verifactuSubmission.groupBy({ by: ["propertyId"], where: inProps, _count: { _all: true } })).map((row) => row.propertyId)
    : [];
  const [chainedInvoicesWithoutInstallation, submissionsWithoutInstallation] = await Promise.all([
    withSubmissions.length ? db.invoice.count({ where: { propertyId: { in: withSubmissions }, installationId: null, ...CHAINED_INVOICE } }) : Promise.resolve(0),
    withSubmissions.length ? db.verifactuSubmission.count({ where: { propertyId: { in: withSubmissions }, installationId: null } }) : Promise.resolve(0)
  ]);
  return {
    ok:
      legalEntities === 1 &&
      propertiesWithoutEntity === 0 &&
      propertiesInForeignEntity === 0 &&
      propertiesWithoutCode === 0 &&
      sequencesWithoutEntity === 0 &&
      invoicesWithoutEntity === 0 &&
      chainedInvoicesWithoutInstallation === 0 &&
      submissionsWithoutInstallation === 0 &&
      bankAccountsWithoutEntity === 0,
    legalEntities,
    propertiesWithoutEntity,
    propertiesInForeignEntity,
    propertiesWithoutCode,
    sequencesWithoutEntity,
    invoicesWithoutEntity,
    chainedInvoicesWithoutInstallation,
    submissionsWithoutInstallation,
    bankAccountsWithoutEntity
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export type OrgSummary = {
  organizationId: string;
  label: string;
  confirmed: boolean;
  plan: OrgPlan | null;
  applied: boolean;
  counts: ApplyCounts | null;
  verification: Verification | null;
  error?: string;
};

export type BackfillSummary = {
  dryRun: boolean;
  installNumberSource: "flag" | "env" | "none";
  organizations: OrgSummary[];
  durationMs: number;
};

/** VERIFACTU_INSTALL_NUMBER when set (the value the deployment declares), else null. */
export function envInstallNumber(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.VERIFACTU_INSTALL_NUMBER?.trim();
  return value ? value : null;
}

export async function runBackfill(flags: BackfillFlags): Promise<BackfillSummary> {
  const start = Date.now();
  const fromEnv = envInstallNumber();
  const declaredInstallNumber = flags.installNumber ?? fromEnv;
  const summary: BackfillSummary = {
    dryRun: !flags.apply,
    installNumberSource: flags.installNumber ? "flag" : fromEnv ? "env" : "none",
    organizations: [],
    durationMs: 0
  };
  const audit = flags.apply ? await import("../modules/audit/audit.service.js") : null;
  if (audit) await audit.hydrateAuditChainFromPostgres();

  const organizations = await prisma.organization.findMany({
    where: flags.orgs.length > 0 ? { id: { in: flags.orgs } } : {},
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" }
  });
  const found = new Set(organizations.map((o) => o.id));
  for (const id of [...flags.orgs, ...flags.confirm.filter((c) => c !== "all")]) {
    if (!found.has(id) && !summary.organizations.some((o) => o.organizationId === id)) {
      summary.organizations.push({ organizationId: id, label: id, confirmed: confirmsOrganization(flags, id), plan: null, applied: false, counts: null, verification: null, error: "organización no encontrada" });
    }
  }

  const claimedTaxIds = new Set<string>();
  for (const organization of organizations) {
    const confirmed = confirmsOrganization(flags, organization.id);
    const entry: OrgSummary = { organizationId: organization.id, label: organization.name, confirmed, plan: null, applied: false, counts: null, verification: null };
    summary.organizations.push(entry);
    try {
      const snapshot = await loadSnapshot(organization.id);
      if (!snapshot) {
        entry.error = "organización no encontrada";
        continue;
      }
      const plan = planOrganization(snapshot, { declaredInstallNumber, claimedTaxIds });
      entry.plan = plan;
      if (!flags.apply || !confirmed) continue;
      if (plan.writes > 0) {
        entry.counts = await prisma.$transaction((tx) => applyPlan(plan, tx), TX_OPTIONS);
        entry.applied = true;
        audit?.recordAuditEvent({
          organizationId: organization.id,
          actorUserId: SYSTEM_USER_ID,
          actorType: "system",
          action: AUDIT_ACTION,
          entityType: "legal_entity",
          entityId: plan.legalEntity.id,
          beforeJson: {
            legalEntity: snapshot.legalEntity?.id ?? null,
            propertiesWithoutEntity: snapshot.properties.filter((p) => !p.legalEntityId).length,
            sequencesWithoutEntity: plan.sequences.toLink,
            invoicesWithoutEntity: plan.invoices.toLink,
            bankAccountsWithoutEntity: plan.bankAccounts.toLink
          },
          afterJson: {
            legalEntity: { id: plan.legalEntity.id, code: plan.legalEntity.code, legalName: plan.legalEntity.legalName, taxId: plan.legalEntity.taxId },
            properties: plan.properties.map((p) => ({ id: p.id, code: p.code, kind: p.kind, set: p.set })),
            installations: plan.installations.map((i) => ({ propertyId: i.propertyId, numeroInstalacion: i.numeroInstalacion, action: i.action })),
            counts: entry.counts,
            warnings: plan.warnings.map((w) => w.code)
          },
          correlationId: CORRELATION_ID
        });
      }
      entry.verification = await verifyOrganization(organization.id);
      if (!entry.verification.ok) entry.error = "post-condición incumplida (ver verification)";
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
    }
  }
  if (audit) await audit.flushAuditQueues();
  summary.durationMs = Date.now() - start;
  return summary;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export function printHuman(summary: BackfillSummary): void {
  const lines = [
    `[backfill:legal-structure] ${summary.dryRun ? "DRY-RUN (no escribe)" : "APPLY"} · ${summary.organizations.length} organización/es · nº instalación heredado: ${summary.installNumberSource === "none" ? `ninguno (relleno ${SANDBOX_INSTALL_NUMBER} si hace falta)` : summary.installNumberSource === "flag" ? "--install-number" : "VERIFACTU_INSTALL_NUMBER"} · ${summary.durationMs} ms`
  ];
  for (const entry of summary.organizations) {
    const state = entry.error
      ? `ERROR ${entry.error}`
      : !entry.plan
        ? "sin plan"
        : entry.plan.writes === 0
          ? "convergida (0 escrituras)"
          : summary.dryRun
            ? `${entry.plan.writes} escrituras previstas`
            : entry.confirmed
              ? entry.applied
                ? "aplicado"
                : "no aplicado"
              : "pendiente (falta --confirm)";
    lines.push(`  ${entry.label} (${entry.organizationId}): ${state}`);
    const plan = entry.plan;
    if (!plan) continue;
    const entity = plan.legalEntity;
    lines.push(`    sociedad: ${entity.action === "create" ? "CREAR" : "existe"} ${entity.code} «${entity.legalName}» NIF ${entity.taxId ?? "pendiente"} (${entity.id})`);
    for (const property of plan.properties) {
      const changes = Object.entries(property.set).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
      lines.push(`    centro ${property.code} · ${property.kind} · «${property.name}» (${property.id}): ${changes.length > 0 ? changes.join(", ") : "sin cambios"}`);
    }
    for (const installation of plan.installations) {
      lines.push(`    instalación VeriFactu ${installation.action === "create" ? "CREAR" : "existe"} «${installation.numeroInstalacion}» → propiedad ${installation.propertyId} · enlaza ${installation.invoicesToLink} facturas encadenadas y ${installation.submissionsToLink} envíos`);
    }
    lines.push(`    series ${plan.sequences.toLink}/${plan.sequences.total} por enlazar · facturas ${plan.invoices.toLink}/${plan.invoices.total} · bancos ${plan.bankAccounts.toLink}/${plan.bankAccounts.total}`);
    for (const warning of plan.warnings) lines.push(`    AVISO ${warning.code}: ${warning.message}`);
    if (entry.counts) lines.push(`    escrito: ${JSON.stringify(entry.counts)}`);
    if (entry.verification) lines.push(`    verificación: ${entry.verification.ok ? "OK" : "FALLA"} ${JSON.stringify(entry.verification)}`);
  }
  if (summary.dryRun) lines.push("  Nada escrito. Repite con --apply --confirm <orgId> (repetible) o --confirm all. Reinicia el API después (espejos in-memory).");
  console.log(lines.join("\n"));
}

const entryFile = resolvePath(fileURLToPath(import.meta.url));
const argFile = process.argv[1] ? resolvePath(process.argv[1]) : "";
if (entryFile === argFile) {
  let flags: BackfillFlags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (error) {
    console.error(`[backfill:legal-structure] ${(error as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (flags.help) {
    console.log(USAGE);
    process.exit(0);
  }
  runBackfill(flags)
    .then(async (summary) => {
      if (flags.json) console.log(JSON.stringify(summary, null, 2));
      else printHuman(summary);
      await prisma.$disconnect();
      return summary.organizations.filter((o) => o.error).length;
    })
    .then((failed) => process.exit(failed > 0 ? 1 : 0))
    .catch(async (error) => {
      console.error("[backfill:legal-structure] failed:", error);
      await prisma.$disconnect().catch(() => undefined);
      process.exit(1);
    });
}
