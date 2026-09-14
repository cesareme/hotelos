// Shared cursor pagination contract (Tanda 2 · REC-05 / QC-04).
//
// Compatibility rule: list endpoints keep returning a bare array by default
// (every existing consumer — admin-web, mobile, ai-gateway — reads arrays).
// Clients that send `?cursor=` or `?envelope=1` get `{ items, nextCursor, total }`,
// a shape utils/toArray.ts already unwraps. Handlers always add the
// `X-Total-Count` and `X-Next-Cursor` headers so header-aware clients can page
// without switching the body shape.
//
// Cursors are opaque base64url JSON of the sort key + id (tie-breaker), e.g.
// { k: "2026-09-13", id: "res_…" }. A malformed cursor is a 400, never a 500;
// a repeated `?cursor=a&cursor=b` (an array after query parsing) is a 400 too,
// not a silent first page.
//
// `limit` is clamped to the handler's `max` (default MAX_PAGE_LIMIT = 500)
// WITHOUT an error: `?limit=10000` returns 500 rows and the client learns the
// real page size from `items.length` / `X-Next-Cursor`. Only a non-integer or
// non-positive `limit` is a 400.

import { BadRequestError } from "./http-error.js";

export type PageQuery = {
  limit: number;
  cursor: string | null;
  envelope: boolean;
};

export type Page<T> = {
  items: T[];
  nextCursor: string | null;
  total: number;
};

export type CursorKey = { k: string; id: string };

export const DEFAULT_PAGE_LIMIT = 100;
export const MAX_PAGE_LIMIT = 500;

/** Parse `limit` / `cursor` / `envelope` from a raw query object (strings). */
export function parsePageQuery(query: Record<string, unknown> | undefined, defaults: { limit?: number; max?: number } = {}): PageQuery {
  const raw = query ?? {};
  const fallback = defaults.limit ?? DEFAULT_PAGE_LIMIT;
  const max = defaults.max ?? MAX_PAGE_LIMIT;
  let limit = fallback;
  if (raw.limit !== undefined && raw.limit !== "") {
    const parsed = Number(raw.limit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new BadRequestError("El parámetro limit debe ser un entero positivo.");
    }
    limit = Math.min(parsed, max);
  }
  // Fastify's default query parser turns a repeated key into an array; anything
  // that is not a string (or absent) cannot be a cursor we issued.
  if (raw.cursor !== undefined && typeof raw.cursor !== "string") {
    throw new BadRequestError("El cursor de paginación no es válido.");
  }
  const cursor = raw.cursor !== undefined && raw.cursor.length > 0 ? raw.cursor : null;
  const envelope = cursor !== null || raw.envelope === "1" || raw.envelope === "true";
  return { limit, cursor, envelope };
}

export function encodeCursor(key: CursorKey): string {
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | null): CursorKey | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<CursorKey>;
    if (typeof parsed.k !== "string" || typeof parsed.id !== "string") throw new Error("shape");
    return { k: parsed.k, id: parsed.id };
  } catch {
    throw new BadRequestError("El cursor de paginación no es válido.");
  }
}

/**
 * Build a page from `limit + 1` rows fetched in sort order: the extra row only
 * signals that a next page exists. `keyOf` returns the sort key of a row.
 */
export function buildPage<T extends { id: string }>(rows: T[], limit: number, total: number, keyOf: (row: T) => string): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor({ k: keyOf(last), id: last.id }) : null,
    total
  };
}

/** Response body per the compatibility rule: bare array unless the client asked for the envelope. */
export function pageBody<T>(page: Page<T>, query: PageQuery): T[] | Page<T> {
  return query.envelope ? page : page.items;
}

/** Headers every list handler sets, so header-aware clients can page without the envelope. */
export function pageHeaders(page: Page<unknown>): Record<string, string> {
  return {
    "X-Total-Count": String(page.total),
    ...(page.nextCursor ? { "X-Next-Cursor": page.nextCursor } : {})
  };
}
