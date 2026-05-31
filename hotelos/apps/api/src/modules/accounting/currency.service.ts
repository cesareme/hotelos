import { prisma, type Prisma } from "@hotelos/database";

// Multi-currency helpers (Sprint 24 — Track Multi-Currency).
//
// The `ExchangeRate` table stores point-in-time mid-market rates keyed by
// `(baseCurrency, quoteCurrency, effectiveDate, organizationId)`. We always
// resolve "the most recent rate up to `asOf`" — older rates stay around so
// historical invoices keep reproducing the FX they were issued with.
//
// Conventions:
//   • `rate` means: 1 unit of `baseCurrency` == `rate` units of `quoteCurrency`.
//     Example row: { base: "USD", quote: "EUR", rate: 0.9200 } -> 1 USD = 0.92 EUR.
//   • When `base === quote` we short-circuit to 1.0 — no DB hit required,
//     no row required either (a tenant that only operates in EUR has an
//     empty `ExchangeRate` table, and conversions still work).
//   • An `organizationId`-scoped row beats a global row (organizationId
//     IS NULL) when both exist for the same `(base, quote, effectiveDate)`.
//     This lets a tenant override the central rate feed.
//   • If no row exists *and* base !== quote we throw — the caller must
//     surface this; we don't silently fall back to 1.0 (that would corrupt
//     `Invoice.baseTotal`).

const RATE_SCALE = 8;
const AMOUNT_SCALE = 2;

function roundAmount(n: number): number {
  return Math.round(n * 10 ** AMOUNT_SCALE) / 10 ** AMOUNT_SCALE;
}

function toIsoDate(date: Date | string | undefined): Date {
  if (date instanceof Date) return date;
  if (typeof date === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return new Date(`${date}T00:00:00.000Z`);
    return new Date(date);
  }
  return new Date();
}

function decimalToNumber(value: Prisma.Decimal | number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return value;
  return Number(value);
}

export type GetExchangeRateInput = {
  base: string;
  quote: string;
  asOf?: Date | string;
  organizationId?: string | null;
};

export type ExchangeRateRecord = {
  id: string;
  baseCurrency: string;
  quoteCurrency: string;
  rate: number;
  effectiveDate: string;
  source?: string;
  organizationId?: string;
  createdAt: string;
};

function mapRate(
  row: NonNullable<Awaited<ReturnType<typeof prisma.exchangeRate.findFirst>>>
): ExchangeRateRecord {
  return {
    id: row.id,
    baseCurrency: row.baseCurrency,
    quoteCurrency: row.quoteCurrency,
    rate: decimalToNumber(row.rate),
    effectiveDate: row.effectiveDate.toISOString().slice(0, 10),
    source: row.source ?? undefined,
    organizationId: row.organizationId ?? undefined,
    createdAt: row.createdAt.toISOString()
  };
}

/**
 * Resolve the FX rate for `base -> quote` at (or before) `asOf`. Returns 1.0
 * for same-currency calls without touching the DB. Throws "No FX rate
 * available …" when there's nothing in the table — callers should catch and
 * surface to the UI / API consumer.
 */
export async function getExchangeRate(input: GetExchangeRateInput): Promise<number> {
  const base = input.base.toUpperCase();
  const quote = input.quote.toUpperCase();
  if (base === quote) return 1;

  const asOf = toIsoDate(input.asOf);

  // Tenant-scoped row first, then global. Both ordered by effectiveDate desc
  // so we pick the most recent row not in the future.
  const orgRow = input.organizationId
    ? await prisma.exchangeRate.findFirst({
        where: {
          baseCurrency: base,
          quoteCurrency: quote,
          organizationId: input.organizationId,
          effectiveDate: { lte: asOf }
        },
        orderBy: { effectiveDate: "desc" }
      })
    : null;
  if (orgRow) return decimalToNumber(orgRow.rate);

  const globalRow = await prisma.exchangeRate.findFirst({
    where: {
      baseCurrency: base,
      quoteCurrency: quote,
      organizationId: null,
      effectiveDate: { lte: asOf }
    },
    orderBy: { effectiveDate: "desc" }
  });
  if (globalRow) return decimalToNumber(globalRow.rate);

  throw new Error(
    `No FX rate available for ${base}->${quote} as of ${asOf.toISOString().slice(0, 10)}`
  );
}

export type ConvertAmountInput = {
  amount: number;
  from: string;
  to: string;
  asOf?: Date | string;
  organizationId?: string | null;
};

/**
 * Convert `amount` from currency `from` to currency `to`. Resolves the FX
 * rate via {@link getExchangeRate}, multiplies, rounds to 2 decimals.
 *
 * Returns `{ amount, rate }` so callers can persist both the converted
 * amount *and* the rate used (so an invoice can be reprinted later with the
 * exact same numbers even if the rate table changes).
 */
export async function convertAmount(input: ConvertAmountInput): Promise<{ amount: number; rate: number }> {
  const from = input.from.toUpperCase();
  const to = input.to.toUpperCase();
  if (from === to) return { amount: roundAmount(input.amount), rate: 1 };

  const rate = await getExchangeRate({
    base: from,
    quote: to,
    asOf: input.asOf,
    organizationId: input.organizationId
  });
  return { amount: roundAmount(input.amount * rate), rate };
}

export type UpsertRateInput = {
  baseCurrency: string;
  quoteCurrency: string;
  rate: number | string;
  effectiveDate: Date | string;
  source?: string | null;
  organizationId?: string | null;
};

/**
 * Idempotently upsert an exchange rate row. The unique key is
 * `(baseCurrency, quoteCurrency, effectiveDate, organizationId)`; re-running
 * with a different `rate` updates in place — so a feed that pulls daily
 * ECB rates can be re-driven without inserting dups.
 */
export async function upsertRate(input: UpsertRateInput): Promise<ExchangeRateRecord> {
  const base = input.baseCurrency.toUpperCase();
  const quote = input.quoteCurrency.toUpperCase();
  if (base === quote) {
    throw new Error("baseCurrency and quoteCurrency must differ.");
  }
  const rate = typeof input.rate === "string" ? Number(input.rate) : input.rate;
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error("rate must be a positive finite number.");
  }
  const effectiveDate = toIsoDate(input.effectiveDate);

  const existing = await prisma.exchangeRate.findFirst({
    where: {
      baseCurrency: base,
      quoteCurrency: quote,
      effectiveDate,
      organizationId: input.organizationId ?? null
    }
  });

  const data = {
    baseCurrency: base,
    quoteCurrency: quote,
    rate: rate.toFixed(RATE_SCALE),
    effectiveDate,
    source: input.source ?? null,
    organizationId: input.organizationId ?? null
  };

  const row = existing
    ? await prisma.exchangeRate.update({ where: { id: existing.id }, data })
    : await prisma.exchangeRate.create({ data });

  return mapRate(row);
}

export type ListRatesInput = {
  base?: string;
  quote?: string;
  asOf?: Date | string;
  organizationId?: string | null;
  limit?: number;
};

/**
 * List exchange rates ordered by `effectiveDate desc`. Optional filters let
 * the API endpoint (`GET /finance/exchange-rates`) narrow on currency pair
 * and `asOf` ceiling. When `asOf` is set we only return rows with
 * `effectiveDate <= asOf` — that's the same "most recent up to" semantics as
 * `getExchangeRate`.
 */
export async function listRates(input: ListRatesInput = {}): Promise<ExchangeRateRecord[]> {
  const where: Prisma.ExchangeRateWhereInput = {};
  if (input.base) where.baseCurrency = input.base.toUpperCase();
  if (input.quote) where.quoteCurrency = input.quote.toUpperCase();
  if (input.asOf) where.effectiveDate = { lte: toIsoDate(input.asOf) };
  if (input.organizationId !== undefined) {
    where.organizationId = input.organizationId;
  }

  const rows = await prisma.exchangeRate.findMany({
    where,
    orderBy: [{ effectiveDate: "desc" }, { createdAt: "desc" }],
    take: input.limit ?? 200
  });
  return rows.map(mapRate);
}
