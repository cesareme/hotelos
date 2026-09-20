// Documents · paper registry number (Tanda T9 · lote T9-03, design §6.4).
//
// Every IncomingDocument gets `DOC-<Property.code>-<AAAA>-<nnnnnn>`, a
// sequence per property and year. Property.code is nullable (Tanda 6b left
// the SET NOT NULL pending): without a code the registry falls back to the
// last 4 characters of Property.id upper-cased and the property page warns.
// Allocation serialises on pg_advisory_xact_lock(hashtext(...)) inside the
// caller's transaction (the journal-numbering pattern of
// accounting.service.ts) and takes MAX(seq)+1 from incoming_documents.
//
// The table / column names below are the snake_case mapping expected from the
// T9-01 migration (incoming_documents.registry_year, registry_seq); they are
// exported so the schema lote and this one stay aligned by a single edit.

import type { Prisma } from "@prisma/client";

export const REGISTRY_TABLE = "incoming_documents";
export const REGISTRY_PROPERTY_COLUMN = "property_id";
export const REGISTRY_YEAR_COLUMN = "registry_year";
export const REGISTRY_SEQ_COLUMN = "registry_seq";
export const REGISTRY_SEQ_DIGITS = 6;
export const REGISTRY_PREFIX = "DOC";

export type RegistryNumberParts = {
  propertyCode?: string | null;
  propertyId: string;
  year: number;
  seq: number;
};

/** Segment of the registry number that identifies the property: Property.code or the id fallback. */
export function registryPropertySegment(propertyCode: string | null | undefined, propertyId: string): string {
  const code = (propertyCode ?? "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
  if (code) return code;
  return propertyId.slice(-4).toUpperCase();
}

/** `DOC-<code|id.slice(-4)>-<AAAA>-<nnnnnn>` (seq zero-padded to 6 digits, wider if it ever overflows). */
export function formatRegistryNumber(parts: RegistryNumberParts): string {
  if (!Number.isInteger(parts.year) || parts.year < 1000 || parts.year > 9999) {
    throw new RangeError(`Año de registro no válido: ${String(parts.year)}`);
  }
  if (!Number.isInteger(parts.seq) || parts.seq < 1) {
    throw new RangeError(`Secuencia de registro no válida: ${String(parts.seq)}`);
  }
  const segment = registryPropertySegment(parts.propertyCode, parts.propertyId);
  return `${REGISTRY_PREFIX}-${segment}-${parts.year}-${String(parts.seq).padStart(REGISTRY_SEQ_DIGITS, "0")}`;
}

/** Strict shape of a formatted registry number. */
export const REGISTRY_NUMBER_RE = /^DOC-[A-Z0-9-]{1,32}-\d{4}-\d{6,}$/;

export function isRegistryNumber(value: unknown): value is string {
  return typeof value === "string" && REGISTRY_NUMBER_RE.test(value);
}

/** Advisory-lock key per (property, year) — hashed by Postgres with hashtext(). */
export function registryLockKey(propertyId: string, year: number): string {
  return `documents.registry:${propertyId}:${year}`;
}

/** Year of the registry (UTC calendar year of the capture instant). */
export function registryYearOf(at: Date = new Date()): number {
  return at.getUTCFullYear();
}

export type AllocateRegistryNumberInput = { propertyId: string; propertyCode?: string | null; year: number };
export type AllocatedRegistryNumber = { registryNumber: string; registryYear: number; registrySeq: number };

/** Minimal surface of Prisma.TransactionClient the allocator needs (tests pass a stub). */
export type RegistryTx = Pick<Prisma.TransactionClient, "$executeRaw" | "$queryRaw">;

/**
 * Next registry number for a property and year. Must run inside the same
 * transaction that inserts the IncomingDocument row: the advisory lock is
 * released at commit/rollback, which is what makes MAX+1 safe.
 */
export async function allocateRegistryNumber(tx: RegistryTx, input: AllocateRegistryNumberInput): Promise<AllocatedRegistryNumber> {
  // $executeRaw: the lock function returns void, which $queryRaw cannot deserialise.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${registryLockKey(input.propertyId, input.year)}))`;
  const rows = await tx.$queryRaw<Array<{ next: number | bigint }>>`
    SELECT COALESCE(MAX(registry_seq), 0) + 1 AS next
    FROM incoming_documents
    WHERE property_id = ${input.propertyId} AND registry_year = ${input.year}`;
  const registrySeq = Number(rows[0]?.next ?? 1);
  return {
    registryNumber: formatRegistryNumber({ propertyCode: input.propertyCode ?? null, propertyId: input.propertyId, year: input.year, seq: registrySeq }),
    registryYear: input.year,
    registrySeq
  };
}
