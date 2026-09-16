// Series prefix uniqueness per legal entity (Tanda 6b · L1 · design §5.2 R3).
//
// RD 1619/2012 art. 6.1.a: numbering is correlative per series and unique per
// issuer (NIF). With several work centres under one legal entity two hotels
// could both open `FAC-2026-` and issue `FAC-2026-000001` twice under the same
// NIF (design §4 #3). This module is the service-level guard:
//
//   assertSeriesPrefixFree({ propertyId, prefix, year })
//       409 SERIES_PREFIX_CLASH { conflictingPropertyId, conflictingSequenceId,
//       prefix, year } when an ACTIVE series of a sister centre of the same
//       legal entity (same organization while the tenant is not backfilled)
//       already uses the prefix (case-insensitive) in that year. Closed series
//       (`active = false`) never clash: a prefix is closed, never renumbered.
//
//   defaultSeriesPrefix({ series, year, propertyCode, billingCentres })
//       `${series}-${year}-` when the legal entity has ONE billing centre (zero
//       change for single hotels and new tenants) and
//       `${series}-${code}-${year}-` when it has several.
//
// Callers (their own lots): backoffice.service.patchBillingSettings and the
// property provisioning service (L2), invoice.service.allocateInvoiceNumber
// (L3). Until the deferred unique index (legal_entity_id, upper(prefix), year)
// exists (migration 20260916101000 header), this guard IS the uniqueness.
//
// `findPrefixClash` and `defaultSeriesPrefix` are pure (unit-tested without a
// database); the database access is confined to `listSiblingPropertyIds` and
// `assertSeriesPrefixFree`.

import { prisma } from "@hotelos/database";
import { ConflictError } from "../../lib/http-error.js";
import type { SeriesPrefixClashDetails } from "@hotelos/shared";

export const SERIES_PREFIX_CLASH_CODE = "SERIES_PREFIX_CLASH" as const;

export type SeriesPrefixRow = {
  id: string;
  propertyId: string;
  prefix: string | null;
  year: number | null;
  active: boolean;
};

export type SeriesPrefixWant = {
  propertyId: string;
  prefix: string;
  year: number | null;
  /** The row being edited (PATCH of an existing series): never clashes with itself. */
  excludeSequenceId?: string;
};

/** Subset of the Prisma client the guard reads (unit tests pass fakes). */
export type SeriesDb = Pick<typeof prisma, "property" | "invoiceSequence">;

/** Comparison form of a prefix: trimmed, upper-case (FAC-ra-2026- ≡ FAC-RA-2026-). */
export function normalizeSeriesPrefix(prefix: string): string {
  return prefix.trim().toUpperCase();
}

/**
 * Pure: the first sister row (another property) whose active series uses the
 * same prefix in the same year. A legacy row without `year` matches on the
 * prefix alone (the prefix carries the year: FAC-2026-).
 */
export function findPrefixClash(rows: readonly SeriesPrefixRow[], want: SeriesPrefixWant): SeriesPrefixRow | null {
  const prefix = normalizeSeriesPrefix(want.prefix);
  if (prefix.length === 0) return null;
  for (const row of rows) {
    if (!row.active) continue;
    if (row.propertyId === want.propertyId) continue;
    if (want.excludeSequenceId && row.id === want.excludeSequenceId) continue;
    if (row.prefix === null || normalizeSeriesPrefix(row.prefix) !== prefix) continue;
    const sameYear = row.year === null || want.year === null || row.year === want.year;
    if (sameYear) return row;
  }
  return null;
}

/** 409 with typed details; the message names the conflicting centre for the operator. */
export function seriesPrefixClashError(clash: SeriesPrefixRow, want: SeriesPrefixWant): ConflictError {
  const details: SeriesPrefixClashDetails = {
    code: SERIES_PREFIX_CLASH_CODE,
    prefix: want.prefix,
    year: want.year ?? clash.year ?? null,
    conflictingPropertyId: clash.propertyId,
    conflictingSequenceId: clash.id
  };
  return new ConflictError(
    `El prefijo de serie «${want.prefix}» ya lo usa otro centro de la misma sociedad${details.year ? ` en ${details.year}` : ""}. Bajo un mismo NIF cada serie debe ser única: elige otro prefijo (p. ej. con el código del centro) o cierra la serie del otro centro.`,
    details
  );
}

/**
 * Sister billing centres of a property: the other properties of its legal
 * entity, or of its organization while the tenant has no backfilled entity
 * (both centres then issue with the same Organization NIF anyway).
 */
export async function listSiblingPropertyIds(propertyId: string, db: SeriesDb = prisma): Promise<string[]> {
  const property = await db.property.findUnique({
    where: { id: propertyId },
    select: { id: true, organizationId: true, legalEntityId: true }
  });
  if (!property) return [];
  const siblings = await db.property.findMany({
    where: property.legalEntityId
      ? { legalEntityId: property.legalEntityId, id: { not: property.id } }
      : { organizationId: property.organizationId, id: { not: property.id } },
    select: { id: true }
  });
  return siblings.map((row) => row.id);
}

/**
 * Guard: throws 409 SERIES_PREFIX_CLASH when a sister centre already uses the
 * prefix in that year. Resolves nothing when the property has no siblings (a
 * single hotel keeps `FAC-<año>-` untouched).
 */
export async function assertSeriesPrefixFree(want: SeriesPrefixWant, db: SeriesDb = prisma): Promise<void> {
  const siblingIds = await listSiblingPropertyIds(want.propertyId, db);
  if (siblingIds.length === 0) return;
  const rows = await db.invoiceSequence.findMany({
    where: { propertyId: { in: siblingIds }, active: true },
    select: { id: true, propertyId: true, prefix: true, year: true, active: true }
  });
  const clash = findPrefixClash(rows, want);
  if (clash) throw seriesPrefixClashError(clash, want);
}

/**
 * R3 · default prefix of a new series: `${series}-${year}-` with one billing
 * centre in the legal entity, `${series}-${code}-${year}-` with several (the
 * centre code makes the pair NIF + serie unique). Without a property code the
 * caller must ask for one (409 upstream) — here we fall back to the plain form.
 */
export function defaultSeriesPrefix(input: { series: string; year: number; propertyCode: string | null; billingCentres: number }): string {
  const series = input.series.trim().toUpperCase();
  const code = input.propertyCode?.trim().toUpperCase() ?? "";
  if (input.billingCentres > 1 && code.length > 0) return `${series}-${code}-${input.year}-`;
  return `${series}-${input.year}-`;
}
