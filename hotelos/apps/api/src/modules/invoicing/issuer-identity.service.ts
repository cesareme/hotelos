// Issuer identity — the ONE place that decides which NIF / legal name goes on
// an invoice, a VeriFactu / TicketBAI / IGIC registro or an SES Hospedajes
// comunicación (Tanda 2 · FISC-03).
//
// Rules:
//   * The NIF comes from Organization.taxId (normalised). Property.legalName is
//     a display name, never a NIF source — no regex over it, no demoStore.
//   * Fiscal mode = VERIFACTU_MODE === "production" (the same switch the AEAT
//     submitter and the QR builder read). Since the finanzas lote
//     (2026-09-15) an invalid / missing NIF blocks issuance with a 409
//     ISSUER_TAX_ID_MISSING in EVERY mode: the sandbox placeholder
//     (SPANISH_TAX_ID_PLACEHOLDER, B00000000) is never stamped on a new
//     document any more — a series that mixes real and placeholder NIFs is
//     not a fiscal series (hallazgo: FAC-2026 de Faranda con tres NIF). The
//     placeholder constant survives only to recognise the legacy invoices
//     that were issued with it before this change.
//   * Once an invoice is issued its identity is a SNAPSHOT (Invoice.issuerTaxId
//     / issuerLegalName / issuerTaxIdPlaceholder): hash, QR and every XML must
//     be reproducible even if the organisation changes its NIF afterwards.
//     Invoices issued before the snapshot columns existed carry the NIF that
//     was really hashed inside their qr_payload (`nif=`), which is what the
//     legacy fallback and the backfill read.

import { isValidSpanishTaxId, normalizeTaxId, SPANISH_TAX_ID_PLACEHOLDER, spanishTaxIdValidationMessage } from "@hotelos/compliance";
import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { ConflictError, NotFoundError } from "../../lib/http-error.js";

export const ISSUER_TAX_ID_PLACEHOLDER = SPANISH_TAX_ID_PLACEHOLDER;
export const ISSUER_TAX_ID_MISSING_CODE = "ISSUER_TAX_ID_MISSING";

export type FiscalMode = "production" | "sandbox";

/** Fiscal mode shared with the AEAT submitter and the QR builder. */
export function resolveFiscalMode(): FiscalMode {
  return process.env.VERIFACTU_MODE === "production" ? "production" : "sandbox";
}

export type IssuerIdentity = {
  propertyId: string;
  organizationId: string;
  propertyName: string;
  /** Property.legalName ?? Organization.legalName ?? Organization.name ?? Property.name */
  legalName: string;
  /** Normalised Organization.taxId, or null when not configured. */
  taxId: string | null;
  /** Checksum-valid DNI / NIE / CIF (false for null or a placeholder-like value). */
  taxIdValid: boolean;
  /** Why taxId is what it is. */
  taxIdSource: "organization" | "missing";
  address: string | null;
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
  /** snapshot = Invoice columns · qr_payload = legacy invoice · resolver = live Organization */
  source: "snapshot" | "qr_payload" | "resolver";
};

// Accepts the shared client or a transaction client.
type IssuerDb = Pick<Prisma.TransactionClient, "property" | "organization">;

function withDetails<T extends Error>(error: T, details: Record<string, unknown>): T {
  return Object.assign(error, { details });
}

/**
 * Live identity of a property's issuer (Property + Organization). Null when
 * the property does not exist. Never throws for a missing NIF: callers decide
 * (see requireIssuerIdentity).
 */
export async function resolveIssuerIdentity(propertyId: string, db: IssuerDb = prisma): Promise<IssuerIdentity | null> {
  const property = await db.property.findUnique({
    where: { id: propertyId },
    select: {
      id: true,
      organizationId: true,
      name: true,
      legalName: true,
      address: true,
      municipality: true,
      province: true,
      country: true,
      taxRegion: true,
      invoiceLogoUrl: true,
      invoiceLegalFooter: true
    }
  });
  if (!property) return null;
  const organization = await db.organization.findUnique({
    where: { id: property.organizationId },
    select: { taxId: true, legalName: true, name: true }
  });
  const taxId = normalizeTaxId(organization?.taxId);
  const addressParts = [property.address, property.municipality, property.province].filter(Boolean);
  return {
    propertyId: property.id,
    organizationId: property.organizationId,
    propertyName: property.name,
    legalName: property.legalName ?? organization?.legalName ?? organization?.name ?? property.name,
    taxId,
    taxIdValid: isValidSpanishTaxId(taxId),
    taxIdSource: taxId ? "organization" : "missing",
    address: addressParts.length > 0 ? addressParts.join(", ") : null,
    country: property.country,
    taxRegion: property.taxRegion ?? null,
    logoUrl: property.invoiceLogoUrl ?? null,
    legalFooter: property.invoiceLegalFooter ?? null
  };
}

/** Message shown when fiscal production mode has no valid NIF to issue with. */
export function issuerTaxIdMissingMessage(identity: Pick<IssuerIdentity, "taxId">): string {
  return identity.taxId
    ? `No se puede emitir: el NIF emisor configurado (${identity.taxId}) no es válido. Corrígelo en Configuración › Perfil del establecimiento; ninguna factura sale con NIF de relleno.`
    : "No se puede emitir: la organización no tiene NIF emisor configurado. Complétalo en Configuración › Perfil del establecimiento; ninguna factura sale con NIF de relleno.";
}

/**
 * Warnings for a draft / preview whose issuer has no usable NIF (FISC-03).
 * Empty when the configured NIF is checksum-valid. Pure: the fiscal mode is a
 * parameter so the message can be unit-tested for both modes.
 */
export function issuerIdentityWarnings(identity: Pick<IssuerIdentity, "taxId" | "taxIdValid">, fiscalMode: FiscalMode = resolveFiscalMode()): string[] {
  if (identity.taxIdValid && identity.taxId) return [];
  const consequence =
    `La emisión de facturas se bloquea (${ISSUER_TAX_ID_MISSING_CODE}) en cualquier modo fiscal hasta corregirlo en Configuración › Perfil del establecimiento: ` +
    `ninguna factura nueva sale con el NIF de relleno ${ISSUER_TAX_ID_PLACEHOLDER}. Modo fiscal actual: ${fiscalMode}.`;
  if (!identity.taxId) {
    return [`La organización no tiene NIF emisor configurado. ${consequence}`];
  }
  const reason = spanishTaxIdValidationMessage(identity.taxId) ?? "no supera la validación";
  return [`El NIF emisor configurado («${identity.taxId}») no es válido: ${reason} ${consequence}`];
}

export type IssuerTaxIdPreview = {
  /** NIF the document will carry when issued now: the valid configured NIF. When `placeholder` is true issuance is BLOCKED and this is the placeholder constant only so the UI can label the state. */
  taxId: string;
  /** True when no valid NIF is configured: issuance answers 409 ISSUER_TAX_ID_MISSING (no document is ever stamped with the placeholder). */
  placeholder: boolean;
  /** Normalised Organization.taxId as configured, valid or not (null when not configured). */
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
 * = "missing" | "invalid") when the organisation has no checksum-valid NIF —
 * in every fiscal mode. The placeholder is never returned for a new document;
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
 * the live resolver (which applies the production 409 / sandbox placeholder
 * policy). Never a regex over the legal name.
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
 * value that was really hashed — never from the current organisation — so
 * retries and XML rebuilds reproduce the original huella. Drafts (no QR) are
 * skipped: they get their snapshot when issued. Idempotent; dry-run by default.
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
