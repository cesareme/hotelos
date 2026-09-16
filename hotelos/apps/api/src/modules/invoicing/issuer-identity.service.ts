// Issuer identity — the ONE place that decides which NIF / razón social goes
// on an invoice, a VeriFactu / TicketBAI / IGIC registro or an SES Hospedajes
// comunicación (Tanda 2 · FISC-03; Tanda 6b · L3 · estructura societaria).
//
// Rules:
//   * The issuer is the SOCIEDAD (design §5.2 R2): NIF, razón social and
//     domicilio fiscal come from `resolveLegalIdentity(organizationId)`
//     (apps/api/src/lib/finance-scope.ts — the single reader of the identity,
//     with the deprecated Organization columns as its own fallback). The
//     property contributes the ESTABLISHMENT block only (RD 1619/2012
//     6.1.e): code, nombre comercial (`tradeName ?? name`) and address. The
//     deprecated Property.legalName is never read here (contract test
//     tests/legal-identity-readers-contract.test.mjs).
//   * Fiscal mode = VERIFACTU_MODE === "production" (the same switch the AEAT
//     submitter and the QR builder read). Since the finanzas lote
//     (2026-09-15) an invalid / missing NIF blocks issuance with a 409
//     ISSUER_TAX_ID_MISSING in EVERY mode: the sandbox placeholder
//     (SPANISH_TAX_ID_PLACEHOLDER, B00000000) is never stamped on a new
//     document any more. The placeholder constant survives only to recognise
//     the legacy invoices that were issued with it before this change.
//   * Once an invoice is issued its identity is a SNAPSHOT (Invoice.issuerTaxId
//     / issuerLegalName / issuerTaxIdPlaceholder, immutable by trigger
//     invoices_issuer_inmutable): hash, QR and every XML must be reproducible
//     even if the sociedad changes its NIF afterwards. Invoices issued before
//     the snapshot columns existed carry the NIF that was really hashed inside
//     their qr_payload (`nif=`), which is what the legacy fallback and the
//     backfill read.
//   * VeriFactu chain scope (design §5.2 R7): one chain per (obligado;
//     instalación). `resolveVerifactuChainScope` turns a property into the
//     VerifactuInstallation whose chain its records belong to — its own
//     centre with `per_center`, the legal entity's single installation with
//     `per_entity` — and the advisory-lock key both invoice.service.ts and
//     verifactu-submission.service.ts take. It lives here (not in
//     invoice.service.ts) so the submission service can import it without an
//     import cycle.
//   * SII (design §5.2 R7 / R8, fix t6b#2): `LegalEntity.siiEnabled` is the
//     ONE switch that takes the sociedad out of the RRSIF (RD 1007/2023 art.
//     3.3). `verifactuExclusionFor` turns it into a typed exclusion that the
//     issue / rectify / simplified paths read (no huella, no QR, no chain link)
//     and the submission service enforces (no registro queued or sent, manual
//     retry 409). The motivo is the same sentence resolveFiscalRegime prints.

import {
  isValidSpanishTaxId,
  normalizeTaxId,
  SPANISH_TAX_ID_PLACEHOLDER,
  spanishTaxIdValidationMessage,
  VERIFACTU_EXCLUDED_BY_SII_CODE,
  VERIFACTU_EXCLUDED_BY_SII_MOTIVO
} from "@hotelos/compliance";
import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { ConflictError, NotFoundError } from "../../lib/http-error.js";
import { resolveLegalIdentity, type LegalIdentity } from "../../lib/finance-scope.js";
import type { PropertyKind, VerifactuChainScope as VerifactuChainPolicy, VerifactuRoute } from "@hotelos/shared";

export const ISSUER_TAX_ID_PLACEHOLDER = SPANISH_TAX_ID_PLACEHOLDER;
export const ISSUER_TAX_ID_MISSING_CODE = "ISSUER_TAX_ID_MISSING";

/** Where the operator fixes the sociedad's NIF / razón social (design §5.3: the only screen that writes them). */
export const LEGAL_IDENTITY_SCREEN = "Configuración › Estructura societaria › Datos fiscales";
/** Where the operator closes / opens series, sets centre codes and sees the VeriFactu installations (design §5.3). */
export const SERIES_SCREEN = "Configuración › Estructura societaria › Series y VeriFactu";
/** Where the operator codes a work centre (Property.code) and edits its establishment data (design §5.3). */
export const WORK_CENTERS_SCREEN = "Configuración › Estructura societaria › Centros";

/**
 * Why the sociedad's invoices carry no VeriFactu record. Today the only cause
 * is the SII (RD 1007/2023 art. 3.3); the shape leaves room for others.
 */
export type VerifactuExclusion = {
  code: typeof VERIFACTU_EXCLUDED_BY_SII_CODE;
  /** Spanish sentence shown on the invoice, the PDF and the readiness. */
  motivo: string;
};

/** Pure: the RRSIF exclusion of a sociedad from its flags (null = VeriFactu applies). */
export function verifactuExclusionFor(identity: Pick<LegalIdentity, "siiEnabled">): VerifactuExclusion | null {
  return identity.siiEnabled ? { code: VERIFACTU_EXCLUDED_BY_SII_CODE, motivo: VERIFACTU_EXCLUDED_BY_SII_MOTIVO } : null;
}

/** Warning persisted in Invoice.warningsJson for a document issued without a VeriFactu record. Pure. */
export function verifactuExclusionWarning(exclusion: VerifactuExclusion): string {
  return `${exclusion.code}: ${exclusion.motivo} La factura se expide sin huella, sin registro de facturación ni código QR tributario.`;
}

export type FiscalMode = "production" | "sandbox";

/** Fiscal mode shared with the AEAT submitter and the QR builder. */
export function resolveFiscalMode(): FiscalMode {
  return process.env.VERIFACTU_MODE === "production" ? "production" : "sandbox";
}

/**
 * Establishment block of an invoice (RD 1619/2012 art. 6.1.e): the work
 * centre that issued it. Never carries a NIF or a razón social of its own.
 */
export type IssuerEstablishment = {
  propertyId: string;
  /** Property.code (RA, LT, OC…); null until the centre is coded (L2 / backfill). */
  code: string | null;
  /** Property.name (operational name). */
  name: string;
  /** Nombre comercial printed on the document: Property.tradeName, else the name. */
  tradeName: string;
  kind: PropertyKind;
  address: string | null;
  postalCode: string | null;
  municipality: string | null;
  province: string | null;
  country: string;
  /** "Paseo Marítimo 1, 15172 Perillo (Oleiros), A Coruña" or null when nothing is known. */
  addressLine: string | null;
};

export type IssuerIdentity = {
  propertyId: string;
  organizationId: string;
  /** LegalEntity that issues; null for a tenant whose implicit sociedad has not been backfilled yet. */
  legalEntityId: string | null;
  propertyName: string;
  /** Razón social of the sociedad (LegalEntity.legalName; Organization.legalName ?? name before the backfill). NEVER Property.legalName. */
  legalName: string;
  /** Normalised NIF of the sociedad, or null when not configured. */
  taxId: string | null;
  /** Checksum-valid DNI / NIE / CIF (false for null or a placeholder-like value). */
  taxIdValid: boolean;
  /** Why taxId is what it is: the sociedad row, the deprecated organization columns (fallback) or nothing. */
  taxIdSource: "legal_entity" | "organization" | "missing";
  /** Reader that answered (`organization_fallback` = tenant without a backfilled LegalEntity). */
  identitySource: LegalIdentity["source"];
  /** Domicilio fiscal of the sociedad on one line (header of the invoice); null while the sociedad has none. */
  fiscalAddress: string | null;
  /** Address line of the ESTABLISHMENT (kept for callers that predate the block; same value as establishment.addressLine). */
  address: string | null;
  establishment: IssuerEstablishment;
  /** VeriFactu chain policy of the sociedad (R7): one installation per centre or per legal entity. */
  verifactuChainScope: VerifactuChainPolicy;
  /** LegalEntity.siiEnabled (R8): the sociedad reports its books through the SII. */
  siiEnabled: boolean;
  /** Null when VeriFactu applies; the typed reason (SII) when the sociedad is outside the RRSIF and no record is generated (R7 / R8). */
  verifactuExclusion: VerifactuExclusion | null;
  country: string;
  taxRegion: string | null;
  logoUrl: string | null;
  legalFooter: string | null;
};

/** Identity ready for a fiscal document: taxId is always a string. */
export type IssuerFiscalIdentity = IssuerIdentity & {
  taxId: string;
  /** True when taxId is the sandbox placeholder (never in production). */
  placeholder: boolean;
  fiscalMode: FiscalMode;
};

export type InvoiceIssuerSnapshot = {
  taxId: string;
  legalName: string;
  placeholder: boolean;
  /** snapshot = Invoice columns · qr_payload = legacy invoice · resolver = live sociedad */
  source: "snapshot" | "qr_payload" | "resolver";
};

// Accepts the shared client or a transaction client.
type IssuerDb = Pick<Prisma.TransactionClient, "property" | "organization" | "legalEntity">;

function withDetails<T extends Error>(error: T, details: Record<string, unknown>): T {
  return Object.assign(error, { details });
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

/** "Calle 1, 15172 Perillo (Oleiros), A Coruña": street · postal code + municipality · province. Pure. */
export function formatAddressLine(parts: { address?: string | null; postalCode?: string | null; municipality?: string | null; province?: string | null }): string | null {
  const municipality = clean(parts.municipality);
  const province = clean(parts.province);
  const locality = [clean(parts.postalCode), municipality].filter(Boolean).join(" ");
  // A province equal to the municipality (A Coruña, A Coruña) is printed once.
  const provinceSegment = province && province.toLowerCase() !== municipality?.toLowerCase() ? province : null;
  const segments = [clean(parts.address), locality || null, provinceSegment].filter((s): s is string => Boolean(s));
  const deduped = segments.filter((segment, index) => segments.indexOf(segment) === index);
  return deduped.length > 0 ? deduped.join(", ") : null;
}

/** Domicilio fiscal of the sociedad on one line. Pure. */
export function formatFiscalAddress(identity: Pick<LegalIdentity, "fiscalAddress" | "fiscalPostalCode" | "fiscalMunicipality" | "fiscalProvince">): string | null {
  return formatAddressLine({ address: identity.fiscalAddress, postalCode: identity.fiscalPostalCode, municipality: identity.fiscalMunicipality, province: identity.fiscalProvince });
}

const ESTABLISHMENT_SELECT = {
  id: true,
  organizationId: true,
  legalEntityId: true,
  name: true,
  code: true,
  tradeName: true,
  kind: true,
  address: true,
  postalCode: true,
  municipality: true,
  province: true,
  country: true,
  taxRegion: true,
  invoiceLogoUrl: true,
  invoiceLegalFooter: true
} as const;

type EstablishmentRow = Prisma.PropertyGetPayload<{ select: typeof ESTABLISHMENT_SELECT }>;

/** Establishment block from a property row. Pure. */
export function establishmentFromProperty(row: Pick<EstablishmentRow, "id" | "name" | "code" | "tradeName" | "kind" | "address" | "postalCode" | "municipality" | "province" | "country">): IssuerEstablishment {
  return {
    propertyId: row.id,
    code: clean(row.code),
    name: row.name,
    tradeName: clean(row.tradeName) ?? row.name,
    kind: row.kind,
    address: clean(row.address),
    postalCode: clean(row.postalCode),
    municipality: clean(row.municipality),
    province: clean(row.province),
    country: row.country,
    addressLine: formatAddressLine(row)
  };
}

/**
 * Compose the issuer identity from the sociedad (resolveLegalIdentity) and
 * the establishment (property row). Pure; exported for unit tests.
 */
export function composeIssuerIdentity(identity: LegalIdentity, row: EstablishmentRow): IssuerIdentity {
  const establishment = establishmentFromProperty(row);
  const taxId = normalizeTaxId(identity.taxId);
  return {
    propertyId: row.id,
    organizationId: row.organizationId,
    legalEntityId: row.legalEntityId ?? identity.legalEntityId,
    propertyName: row.name,
    legalName: identity.legalName,
    taxId,
    taxIdValid: isValidSpanishTaxId(taxId),
    taxIdSource: taxId ? (identity.source === "legal_entity" ? "legal_entity" : "organization") : "missing",
    identitySource: identity.source,
    fiscalAddress: formatFiscalAddress(identity),
    address: establishment.addressLine,
    establishment,
    verifactuChainScope: identity.verifactuChainScope,
    siiEnabled: identity.siiEnabled,
    verifactuExclusion: verifactuExclusionFor(identity),
    country: row.country,
    taxRegion: row.taxRegion ?? null,
    logoUrl: row.invoiceLogoUrl ?? null,
    legalFooter: row.invoiceLegalFooter ?? null
  };
}

/**
 * Live identity of a property's issuer: the sociedad of its organization plus
 * the establishment block of the property. Null when the property does not
 * exist. Never throws for a missing NIF: callers decide (see
 * requireIssuerIdentity).
 */
export async function resolveIssuerIdentity(propertyId: string, db: IssuerDb = prisma): Promise<IssuerIdentity | null> {
  const row = await db.property.findUnique({ where: { id: propertyId }, select: ESTABLISHMENT_SELECT });
  if (!row) return null;
  const identity = await resolveLegalIdentity(row.organizationId, db);
  if (!identity) return null;
  return composeIssuerIdentity(identity, row);
}

/**
 * RRSIF exclusion of the sociedad a property belongs to (null when VeriFactu
 * applies, or when the property does not exist — the callers already 404 on
 * that). Read by the submission service before building or sending a registro.
 */
export async function verifactuExclusionForProperty(propertyId: string, db: IssuerDb = prisma): Promise<VerifactuExclusion | null> {
  const identity = await resolveIssuerIdentity(propertyId, db);
  return identity?.verifactuExclusion ?? null;
}

/** Message shown when there is no valid NIF to issue with. */
export function issuerTaxIdMissingMessage(identity: Pick<IssuerIdentity, "taxId">): string {
  return identity.taxId
    ? `No se puede emitir: el NIF emisor configurado (${identity.taxId}) no es válido. Corrígelo en ${LEGAL_IDENTITY_SCREEN}; ninguna factura sale con NIF de relleno.`
    : `No se puede emitir: la sociedad no tiene NIF emisor configurado. Complétalo en ${LEGAL_IDENTITY_SCREEN}; ninguna factura sale con NIF de relleno.`;
}

/**
 * Warnings for a draft / preview whose issuer has no usable NIF (FISC-03).
 * Empty when the configured NIF is checksum-valid. Pure: the fiscal mode is a
 * parameter so the message can be unit-tested for both modes.
 */
export function issuerIdentityWarnings(identity: Pick<IssuerIdentity, "taxId" | "taxIdValid">, fiscalMode: FiscalMode = resolveFiscalMode()): string[] {
  if (identity.taxIdValid && identity.taxId) return [];
  const consequence =
    `La emisión de facturas se bloquea (${ISSUER_TAX_ID_MISSING_CODE}) en cualquier modo fiscal hasta corregirlo en ${LEGAL_IDENTITY_SCREEN}: ` +
    `ninguna factura nueva sale con el NIF de relleno ${ISSUER_TAX_ID_PLACEHOLDER}. Modo fiscal actual: ${fiscalMode}.`;
  if (!identity.taxId) {
    return [`La sociedad no tiene NIF emisor configurado. ${consequence}`];
  }
  const reason = spanishTaxIdValidationMessage(identity.taxId) ?? "no supera la validación";
  return [`El NIF emisor configurado («${identity.taxId}») no es válido: ${reason} ${consequence}`];
}

export type IssuerTaxIdPreview = {
  /** NIF the document will carry when issued now: the valid configured NIF. When `placeholder` is true issuance is BLOCKED and this is the placeholder constant only so the UI can label the state. */
  taxId: string;
  /** True when no valid NIF is configured: issuance answers 409 ISSUER_TAX_ID_MISSING (no document is ever stamped with the placeholder). */
  placeholder: boolean;
  /** Normalised NIF of the sociedad as configured, valid or not (null when not configured). */
  configured: string | null;
  warnings: string[];
};

/**
 * What issuance would stamp for this identity (FISC-03 preview): the same
 * decision as requireIssuerIdentity minus the production 409, so GET
 * /invoices/:draft and GET /invoice-branding never show an invalid NIF as if
 * it were going to be printed. Pure.
 */
export function previewIssuerTaxId(identity: Pick<IssuerIdentity, "taxId" | "taxIdValid">, fiscalMode: FiscalMode = resolveFiscalMode()): IssuerTaxIdPreview {
  if (identity.taxIdValid && identity.taxId) {
    return { taxId: identity.taxId, placeholder: false, configured: identity.taxId, warnings: [] };
  }
  return {
    taxId: ISSUER_TAX_ID_PLACEHOLDER,
    placeholder: true,
    configured: identity.taxId,
    warnings: issuerIdentityWarnings(identity, fiscalMode)
  };
}

/**
 * Identity for a fiscal document: 409 (ISSUER_TAX_ID_MISSING, details.reason
 * = "missing" | "invalid") when the sociedad has no checksum-valid NIF — in
 * every fiscal mode. The placeholder is never returned for a new document;
 * `placeholder` stays in the type because issuerForInvoice reports it for the
 * legacy invoices that were issued with it.
 */
export async function requireIssuerIdentity(propertyId: string, db: IssuerDb = prisma): Promise<IssuerFiscalIdentity> {
  const identity = await resolveIssuerIdentity(propertyId, db);
  if (!identity) throw new NotFoundError("Propiedad no encontrada.");
  const fiscalMode = resolveFiscalMode();
  if (identity.taxIdValid && identity.taxId) {
    return { ...identity, taxId: identity.taxId, placeholder: false, fiscalMode };
  }
  throw withDetails(new ConflictError(issuerTaxIdMissingMessage(identity)), {
    code: ISSUER_TAX_ID_MISSING_CODE,
    reason: identity.taxId ? "invalid" : "missing",
    propertyId,
    organizationId: identity.organizationId,
    legalEntityId: identity.legalEntityId,
    identitySource: identity.identitySource,
    taxId: identity.taxId,
    fiscalMode
  });
}

/** The `nif=` the AEAT QR of an already-issued invoice was built with (legacy snapshot). */
export function taxIdFromQrPayload(qrPayload: string | null | undefined): string | null {
  if (!qrPayload) return null;
  try {
    return normalizeTaxId(new URL(qrPayload).searchParams.get("nif"));
  } catch {
    const match = /[?&]nif=([^&#]+)/i.exec(qrPayload);
    return match ? normalizeTaxId(decodeURIComponent(match[1]!)) : null;
  }
}

type InvoiceIssuerFields = {
  propertyId: string;
  issuerTaxId: string | null;
  issuerLegalName: string | null;
  issuerTaxIdPlaceholder: boolean;
  qrPayload: string | null;
};

/**
 * Identity to reproduce an issued invoice's registro (VeriFactu / TBAI / IGIC
 * XML, retries from the worker or the sweep). Snapshot first; for invoices
 * issued before the snapshot columns, the NIF hashed into their QR; only then
 * the live resolver (which applies the 409 policy). Never a regex over the
 * legal name.
 */
export async function issuerForInvoice(invoice: InvoiceIssuerFields, db: IssuerDb = prisma): Promise<InvoiceIssuerSnapshot> {
  if (invoice.issuerTaxId) {
    const legalName = invoice.issuerLegalName ?? (await resolveIssuerIdentity(invoice.propertyId, db))?.legalName ?? null;
    if (legalName === null) throw new NotFoundError("Propiedad no encontrada.");
    return { taxId: invoice.issuerTaxId, legalName, placeholder: invoice.issuerTaxIdPlaceholder, source: "snapshot" };
  }
  const legacyTaxId = taxIdFromQrPayload(invoice.qrPayload);
  if (legacyTaxId) {
    const identity = await resolveIssuerIdentity(invoice.propertyId, db);
    if (!identity) throw new NotFoundError("Propiedad no encontrada.");
    return {
      taxId: legacyTaxId,
      legalName: invoice.issuerLegalName ?? identity.legalName,
      placeholder: legacyTaxId === ISSUER_TAX_ID_PLACEHOLDER,
      source: "qr_payload"
    };
  }
  const identity = await requireIssuerIdentity(invoice.propertyId, db);
  return { taxId: identity.taxId, legalName: invoice.issuerLegalName ?? identity.legalName, placeholder: identity.placeholder, source: "resolver" };
}

// ---------------------------------------------------------------------------
// VeriFactu chain scope (design §5.2 R7: one chain per obligado + instalación)
// ---------------------------------------------------------------------------

export type VerifactuChainRoute = VerifactuRoute;

export type VerifactuChainInstallation = {
  id: string;
  legalEntityId: string;
  /** Billing centre with `per_center`; null with `per_entity`. */
  propertyId: string | null;
  /** Immutable NumeroInstalacion declared by the producer (trigger verifactu_installations_numero_inmutable). */
  numeroInstalacion: string;
  route: VerifactuChainRoute;
  territory: string | null;
};

/**
 * The chain a property's records belong to. `propertyIds` are the centres
 * whose records form the chain (the centre itself with `per_center`, every
 * centre of the sociedad with `per_entity`); `lockKey` is what the advisory
 * lock hashes — identical for every writer of the chain (issue, rectify,
 * cancel, anulación huella, legacy reconciliation).
 */
export type VerifactuChainScope = {
  propertyId: string;
  organizationId: string;
  legalEntityId: string | null;
  policy: VerifactuChainPolicy;
  route: VerifactuChainRoute;
  /** Declared installation, or null (sandbox tenant without one: chain keyed by the centre, env fallback for the number). */
  installation: VerifactuChainInstallation | null;
  propertyIds: string[];
  lockKey: string;
};

const CHAIN_LOCK_SUFFIX = ":verifactu-chain";

type ChainScopeDb = Pick<Prisma.TransactionClient, "property" | "organization" | "legalEntity" | "verifactuInstallation">;

/**
 * Advisory-lock key of a chain. Pure. A centre without installation keeps the
 * pre-Tanda-6b key (`<propertyId>:verifactu-chain`), so nothing re-locks
 * differently across the deploy; a declared installation moves the key to the
 * installation, and a `per_entity` sociedad without one yet locks per sociedad.
 */
export function verifactuChainLockKey(scope: Pick<VerifactuChainScope, "propertyId" | "legalEntityId" | "policy" | "installation">): string {
  if (scope.installation) return `installation:${scope.installation.id}`;
  if (scope.policy === "per_entity" && scope.legalEntityId) return `entity:${scope.legalEntityId}`;
  return scope.propertyId;
}

/**
 * Prisma filter selecting the invoices of a chain: the records linked to the
 * installation plus, for continuity, the records of the chain's centres that
 * were issued before any installation was linked (`installationId IS NULL`).
 * Records of a RETIRED installation are excluded: a new installation starts a
 * new chain (R7 — «cambiar de ámbito nunca re-encadena»). Pure.
 */
export function chainInvoiceWhere(scope: Pick<VerifactuChainScope, "installation" | "propertyIds">): Prisma.InvoiceWhereInput {
  if (!scope.installation) return { propertyId: { in: scope.propertyIds } };
  return { OR: [{ installationId: scope.installation.id }, { installationId: null, propertyId: { in: scope.propertyIds } }] };
}

/**
 * Resolve the chain scope of a property for a route (VeriFactu by default;
 * TicketBAI and IGIC keep their own installations). Reads the sociedad's
 * policy through resolveLegalIdentity; a tenant without a backfilled
 * LegalEntity resolves to the legacy per-centre chain without installation.
 */
export async function resolveVerifactuChainScope(db: ChainScopeDb, propertyId: string, route: VerifactuChainRoute = "verifactu"): Promise<VerifactuChainScope> {
  const property = await db.property.findUnique({ where: { id: propertyId }, select: { id: true, organizationId: true, legalEntityId: true } });
  if (!property) throw new NotFoundError("Propiedad no encontrada.");
  const identity = await resolveLegalIdentity(property.organizationId, db);
  const policy: VerifactuChainPolicy = identity?.verifactuChainScope ?? "per_center";
  const legalEntityId = property.legalEntityId ?? identity?.legalEntityId ?? null;

  let installation: VerifactuChainInstallation | null = null;
  let propertyIds = [property.id];
  if (legalEntityId) {
    installation = await db.verifactuInstallation.findFirst({
      where: { legalEntityId, route, active: true, retiredAt: null, propertyId: policy === "per_center" ? property.id : null },
      orderBy: { createdAt: "asc" },
      select: { id: true, legalEntityId: true, propertyId: true, numeroInstalacion: true, route: true, territory: true }
    });
    if (policy === "per_entity") {
      const centres = await db.property.findMany({ where: { legalEntityId }, select: { id: true } });
      const ids = centres.map((row) => row.id);
      propertyIds = ids.includes(property.id) ? ids : [...ids, property.id];
    }
  }
  const base = { propertyId: property.id, organizationId: property.organizationId, legalEntityId, policy, route, installation, propertyIds };
  return { ...base, lockKey: verifactuChainLockKey(base) };
}

/**
 * Serialise every chain mutation (issue / rectify / cancel / anulación huella)
 * for the rest of the transaction. Re-entrant inside one transaction
 * (pg_advisory_xact_lock), so the cancel path may lock and then let
 * prepareVerifactuAnulacion lock again.
 */
export async function lockVerifactuChainScope(tx: Pick<Prisma.TransactionClient, "$executeRaw">, scope: Pick<VerifactuChainScope, "lockKey">): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${scope.lockKey + CHAIN_LOCK_SUFFIX}))`;
}

/**
 * Self-healing link (idempotent, NULL → value only): hashed records of the
 * chain's centres that predate the installation — or that a writer outside
 * this module created without the columns — are linked to the installation
 * and the sociedad, so every reader (RegistroAnterior, submissions, reports)
 * sees one chain. Runs under the chain lock. Returns the rows linked.
 */
export async function adoptOrphanChainRecords(
  tx: Pick<Prisma.TransactionClient, "invoice" | "verifactuSubmission">,
  scope: Pick<VerifactuChainScope, "installation" | "legalEntityId" | "propertyIds">
): Promise<{ invoices: number; submissions: number }> {
  let invoices = 0;
  let submissions = 0;
  if (scope.legalEntityId) {
    const linked = await tx.invoice.updateMany({
      where: { propertyId: { in: scope.propertyIds }, legalEntityId: null, verifactuHash: { not: null } },
      data: { legalEntityId: scope.legalEntityId }
    });
    invoices += linked.count;
  }
  if (scope.installation) {
    const linked = await tx.invoice.updateMany({
      where: { propertyId: { in: scope.propertyIds }, installationId: null, verifactuHash: { not: null } },
      data: { installationId: scope.installation.id }
    });
    invoices += linked.count;
    const linkedSubmissions = await tx.verifactuSubmission.updateMany({
      where: { propertyId: { in: scope.propertyIds }, installationId: null },
      data: { installationId: scope.installation.id }
    });
    submissions = linkedSubmissions.count;
  }
  return { invoices, submissions };
}

// ---------------------------------------------------------------------------
// Issuer snapshot backfill (invoices issued before the snapshot columns)
// ---------------------------------------------------------------------------

export type IssuerSnapshotBackfillResult = {
  scanned: number;
  updated: number;
  /** Invoices with neither a QR `nif=` nor a resolvable identity (left untouched). */
  skipped: number;
  dryRun: boolean;
};

/**
 * One-shot backfill of Invoice.issuerTaxId / issuerLegalName /
 * issuerTaxIdPlaceholder for invoices issued before the snapshot columns
 * existed. The NIF comes from the invoice's own qr_payload (`nif=`), i.e. the
 * value that was really hashed — never from the current sociedad — so
 * retries and XML rebuilds reproduce the original huella. Drafts (no QR) are
 * skipped: they get their snapshot when issued. Idempotent; dry-run by default.
 * The trigger invoices_issuer_inmutable allows exactly this NULL → value fill.
 *
 *   cd apps/api && node --env-file=../../.env --import tsx -e \
 *     "import('./src/modules/invoicing/issuer-identity.service.ts').then(m => m.backfillInvoiceIssuerSnapshots({ dryRun: false })).then(r => { console.log(r); process.exit(0); })"
 */
export async function backfillInvoiceIssuerSnapshots(options: { dryRun?: boolean; propertyId?: string; batchSize?: number } = {}): Promise<IssuerSnapshotBackfillResult> {
  const dryRun = options.dryRun ?? true;
  const batchSize = options.batchSize ?? 200;
  const result: IssuerSnapshotBackfillResult = { scanned: 0, updated: 0, skipped: 0, dryRun };
  const legalNameByProperty = new Map<string, string | null>();
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.invoice.findMany({
      where: {
        issuerTaxId: null,
        qrPayload: { not: null },
        ...(options.propertyId ? { propertyId: options.propertyId } : {})
      },
      select: { id: true, propertyId: true, qrPayload: true, issuerLegalName: true },
      orderBy: { id: "asc" },
      take: batchSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.id;
    for (const row of rows) {
      result.scanned += 1;
      const taxId = taxIdFromQrPayload(row.qrPayload);
      if (!taxId) {
        result.skipped += 1;
        continue;
      }
      if (!legalNameByProperty.has(row.propertyId)) {
        legalNameByProperty.set(row.propertyId, (await resolveIssuerIdentity(row.propertyId))?.legalName ?? null);
      }
      const legalName = row.issuerLegalName ?? legalNameByProperty.get(row.propertyId) ?? null;
      if (!dryRun) {
        await prisma.invoice.update({
          where: { id: row.id },
          data: { issuerTaxId: taxId, issuerLegalName: legalName, issuerTaxIdPlaceholder: taxId === ISSUER_TAX_ID_PLACEHOLDER }
        });
      }
      result.updated += 1;
    }
    if (rows.length < batchSize) break;
  }
  return result;
}
