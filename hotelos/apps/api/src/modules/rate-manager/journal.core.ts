// Rate grid v2 · journal arithmetic (pure, no I/O).
//
// Everything the history/revert path computes WITHOUT Prisma lives here so it
// is unit-testable (__tests__/journal-core.test.mts):
//   · coalesceJournalItems — one journal item per (cell, field) even when a
//     request touched the same cell twice (an op + a manual cell on the same
//     cell): `before` of the first write, `after` of the last; dropped when the
//     net change is nil. Before this, a revert restored the INTERMEDIATE value.
//   · buildRevertPatches  — inverse patches of an entry (the `before` of each
//     field) with `expected` = the `after` the entry wrote, so the engine can
//     detect that a later edit changed the cell (409 JOURNAL_STALE).
//   · staleFields         — compares a patch's `expected` with the current
//     state of the cell (optimistic concurrency of bulk-update and revert);
//     staleReason words it for the hotelier (Spanish labels, es-ES money and
//     dates — the editor shows `conflicts[].reason` verbatim).
//   · parseJournalCursorDate — a cursor whose `k` is not a date is a 400
//     (lib/pagination.ts promises «never a 500»).
//   · revertReason / legacyRevertsJournalId — wording of the inverse entry
//     («Reversión: <motivo original>») and the link to the entry it reverted
//     (changesJson.revertsJournalId; the old wording carried the id inline).
//   · normalizePushStatus — DB string → RateJournalPushStatus of the contract.
//   · withIdempotentReplay — belt and braces of the clientRequestId unique
//     constraint: a P2002 on the journal row means a concurrent retry won the
//     race, so the caller re-reads that entry instead of answering 409.

import type { RateCellSource, RateChangeJournalItem, RateJournalPushStatus, RateRestrictions, RateRestrictionsPatch } from "@hotelos/shared";
import { RATE_RESTRICTION_KEYS } from "@hotelos/shared";
import { BadRequestError } from "../../lib/http-error.js";
import { STAR } from "./bulk-ops.js";
import type { EnginePatch, ExpectedCellState, JournalItemDraft } from "./rate-grid.engine.js";

const RESTRICTION_KEY_SET = new Set<string>(RATE_RESTRICTION_KEYS);

export function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function fieldKey(i: { ratePlanId: string; roomTypeId: string; date: string; channelId?: string | null; field: string }): string {
  return `${i.ratePlanId}|${i.roomTypeId}|${i.date}|${i.channelId ?? STAR}|${i.field}`;
}

/**
 * Merge the items of ONE write per (plan, type, date, channel, field): first
 * `before`, last `after`, insertion order kept; an item whose net change is
 * nil (100 → 111 → 100) disappears, so `changesCount` counts real changes and
 * the revert of the entry is deterministic.
 */
export function coalesceJournalItems(items: JournalItemDraft[]): JournalItemDraft[] {
  const merged = new Map<string, JournalItemDraft>();
  for (const item of items) {
    const key = fieldKey(item);
    const previous = merged.get(key);
    if (previous) previous.after = item.after;
    else merged.set(key, { ...item });
  }
  return [...merged.values()].filter((i) => !sameJson(i.before, i.after));
}

const isNumberOrNull = (v: unknown): v is number | null => v === null || typeof v === "number";

/**
 * Inverse patches of a journal: one patch per (plan, type, date, channel)
 * carrying the `before` of each field. When the same (cell, field) appears
 * more than once (entries written before coalescing existed, ordered by id =
 * insertion order) the FIRST `before` and the LAST `after` win.
 *
 * `withExpected` (default true) stamps `expected` with the `after` values so
 * the engine refuses to overwrite a cell a later entry changed; `force`
 * reverts pass false.
 */
export function buildRevertPatches(
  items: RateChangeJournalItem[],
  derivedPlanIds: Set<string>,
  options: { withExpected?: boolean } = {}
): EnginePatch[] {
  const withExpected = options.withExpected !== false;
  // Automatic materialisations ("derivedPrice") are re-created from the
  // reverted parent; user actions on a derived plan (convertToManual /
  // revertToDerived → "price" + "source") are replayed as their own before.
  const net = new Map<string, { item: RateChangeJournalItem; before: unknown; after: unknown }>();
  for (const item of items) {
    if (item.field === "derivedPrice") continue;
    const key = fieldKey(item);
    const entry = net.get(key);
    if (entry) entry.after = item.after;
    else net.set(key, { item, before: item.before, after: item.after });
  }

  const patches = new Map<string, EnginePatch>();
  for (const { item, before, after } of net.values()) {
    const key = `${item.ratePlanId}|${item.roomTypeId}|${item.date}|${item.channelId ?? STAR}`;
    const patch =
      patches.get(key) ??
      ({ ratePlanId: item.ratePlanId, roomTypeId: item.roomTypeId, date: item.date, ...(item.channelId ? { channelId: item.channelId } : {}) } as EnginePatch);
    const expected: ExpectedCellState = patch.expected ?? {};
    switch (item.field) {
      case "price":
        patch.price = typeof before === "number" ? before : null;
        expected.price = isNumberOrNull(after) ? after : null;
        break;
      case "minPrice":
        patch.minPrice = typeof before === "number" ? before : null;
        expected.minPrice = isNumberOrNull(after) ? after : null;
        break;
      case "maxPrice":
        patch.maxPrice = typeof before === "number" ? before : null;
        expected.maxPrice = isNumberOrNull(after) ? after : null;
        break;
      case "occupancyPrices":
        patch.occupancyPrices = before && typeof before === "object" && !Array.isArray(before) ? (before as Record<string, number>) : null;
        expected.occupancyPrices = after && typeof after === "object" && !Array.isArray(after) ? (after as Record<string, number>) : null;
        break;
      case "available":
        patch.available = typeof before === "number" ? before : null;
        expected.available = isNumberOrNull(after) ? after : null;
        break;
      case "source":
        // derived → manual was the change: go back to derived (recomputed from
        // the parent). manual → derived on a derived plan (materialisation over
        // a manual cell, or revertToDerived): restore the manual override.
        // import/rms → manual: the engine writes "manual" by default, so the
        // provenance is restored through `restoreSource` (revert only).
        if (before === "derived") patch.revertToDerived = true;
        else if (before === "manual" && derivedPlanIds.has(item.ratePlanId)) patch.convertToManual = true;
        else if (before === "import" || before === "rms") patch.restoreSource = before as RateCellSource;
        expected.source = typeof after === "string" ? after : null;
        break;
      default:
        if (RESTRICTION_KEY_SET.has(item.field)) {
          const restrictions: RateRestrictionsPatch = patch.restrictions ?? {};
          (restrictions as Record<string, unknown>)[item.field] = before === undefined ? null : before;
          patch.restrictions = restrictions;
          const expectedRestrictions = expected.restrictions ?? {};
          (expectedRestrictions as Record<string, unknown>)[item.field] = after === undefined ? null : after;
          expected.restrictions = expectedRestrictions;
        }
    }
    if (withExpected) patch.expected = expected;
    patches.set(key, patch);
  }
  // A price that must be restored on a cell whose "after" was a fresh row needs
  // no convertToManual; a cell of a derived plan that was converted to manual is
  // reverted with its former price as manual too (convertToManual keeps it writable).
  for (const patch of patches.values()) {
    if (patch.revertToDerived) {
      delete patch.price;
      delete patch.convertToManual;
    } else if (derivedPlanIds.has(patch.ratePlanId) && patch.price !== undefined) {
      patch.convertToManual = true;
    }
  }
  return [...patches.values()];
}

/** Current state of ONE cell as the engine sees it before applying anything. */
export type CurrentCellState = {
  /** null when the (plan, type, date) has no RateDay. */
  rate: {
    price: number;
    minPrice: number | null;
    maxPrice: number | null;
    occupancyPrices: Record<string, number> | null;
    source: string;
    updatedAt: Date | null;
  } | null;
  /** InventoryDay.availableCount, null when not managed. */
  available: number | null;
  /** Wire restrictions of the (plan|"*", channel|"*") row the patch targets. */
  restrictions: RateRestrictions;
};

export type StaleField = { field: string; expected: unknown; actual: unknown };

/**
 * Fields whose `expected` value differs from the current cell state. Empty
 * array = the cell is as the caller saw it. Prices compare as numbers (both
 * sides are 2-decimal values); `lastModifiedAt` compares ISO stamps at
 * millisecond precision; restriction values compare per key (null = unset).
 */
export function staleFields(expected: ExpectedCellState | undefined, current: CurrentCellState): StaleField[] {
  if (!expected) return [];
  const out: StaleField[] = [];
  const check = (field: string, want: unknown, actual: unknown): void => {
    if (!sameJson(want, actual)) out.push({ field, expected: want ?? null, actual: actual ?? null });
  };
  if (expected.price !== undefined) check("price", expected.price, current.rate?.price ?? null);
  if (expected.minPrice !== undefined) check("minPrice", expected.minPrice, current.rate?.minPrice ?? null);
  if (expected.maxPrice !== undefined) check("maxPrice", expected.maxPrice, current.rate?.maxPrice ?? null);
  if (expected.occupancyPrices !== undefined) check("occupancyPrices", expected.occupancyPrices, current.rate?.occupancyPrices ?? null);
  if (expected.source !== undefined) check("source", expected.source, current.rate?.source ?? null);
  if (expected.available !== undefined) check("available", expected.available, current.available);
  if (expected.lastModifiedAt !== undefined) {
    const want = expected.lastModifiedAt ? new Date(expected.lastModifiedAt).getTime() : null;
    const actual = current.rate?.updatedAt ? current.rate.updatedAt.getTime() : null;
    if (want !== actual) out.push({ field: "lastModifiedAt", expected: expected.lastModifiedAt ?? null, actual: current.rate?.updatedAt?.toISOString() ?? null });
  }
  if (expected.restrictions) {
    for (const [key, want] of Object.entries(expected.restrictions)) {
      const actual = (current.restrictions as Record<string, unknown>)[key];
      check(key, want ?? null, actual === undefined ? null : actual);
    }
  }
  return out;
}

// ---- stale wording (browser-ux-final#8) ---------------------------------------------
// The editor shows `conflicts[].reason` verbatim in a toast, so the text must
// read for the hotelier: field labels in Spanish, money with the property's
// currency, stamps as es-ES dates (Europe/Madrid) — never «price actual 92
// (esperado 91.46); lastModifiedAt actual 2026-09-15T05:43:40.614Z».

/** `StaleField.field` → Spanish label, lowercase so it reads inline («precio actual …»). */
const STALE_FIELD_LABELS: Record<string, string> = {
  price: "precio",
  minPrice: "precio mínimo",
  maxPrice: "precio máximo",
  occupancyPrices: "precios por ocupación",
  source: "origen",
  available: "disponibles",
  lastModifiedAt: "última modificación",
  minLos: "estancia mínima",
  maxLos: "estancia máxima",
  minLosThrough: "estancia mínima (estancia completa)",
  cta: "cerrado a llegada",
  ctd: "cerrado a salida",
  closed: "cerrado",
  stopSell: "cierre de venta",
  minAdvanceDays: "antelación mínima",
  maxAdvanceDays: "antelación máxima"
};

const CELL_SOURCE_LABELS: Record<string, string> = { manual: "manual", derived: "derivado", import: "importado", rms: "RMS" };

const MONEY_FIELDS: ReadonlySet<string> = new Set(["price", "minPrice", "maxPrice"]);

const DATE_TIME_ES = new Intl.DateTimeFormat("es-ES", {
  timeZone: "Europe/Madrid",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false
});

/** «15/09/2026 07:43:40» (Europe/Madrid); with `withMillis` «…:40,614». Anything unparseable → «fecha desconocida». */
export function formatStaleStamp(value: unknown, withMillis = false): string {
  const date = value instanceof Date ? value : typeof value === "string" || typeof value === "number" ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "fecha desconocida";
  const parts = Object.fromEntries(DATE_TIME_ES.formatToParts(date).map((p) => [p.type, p.value]));
  const base = `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}:${parts.second}`;
  return withMillis ? `${base},${String(date.getUTCMilliseconds()).padStart(3, "0")}` : base;
}

/** «92,00 €» in es-ES with the property's currency; an unknown ISO code falls back to «92,00 XXX». */
export function formatStaleMoney(value: number, currency = "EUR"): string {
  try {
    // Intl separates amount and symbol with U+00A0; a toast/log wants a plain space.
    return new Intl.NumberFormat("es-ES", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value).replace(/\u00a0/g, " ");
  } catch {
    return `${value.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
  }
}

/** One stale value as the hotelier reads it (money, sí/no, origen, fecha…); null = «sin valor» («sin tarifa» for a price). */
export function formatStaleValue(field: string, value: unknown, currency = "EUR", options: { withMillis?: boolean } = {}): string {
  if (value === null || value === undefined) return field === "price" ? "sin tarifa" : "sin valor";
  if (MONEY_FIELDS.has(field) && typeof value === "number") return formatStaleMoney(value, currency);
  if (field === "occupancyPrices" && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([occ, v]) => `${occ}: ${typeof v === "number" ? formatStaleMoney(v, currency) : String(v)}`);
    return entries.length > 0 ? entries.join(", ") : "sin valor";
  }
  if (field === "source") return CELL_SOURCE_LABELS[String(value)] ?? String(value);
  if (field === "lastModifiedAt") return formatStaleStamp(value, options.withMillis);
  if (typeof value === "boolean") return value ? "sí" : "no";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Human reason of a stale cell for `conflicts[]` (Spanish, one line):
 * «la celda cambió desde que se cargó: precio actual 92,00 € (esperado
 * 91,46 €); última modificación actual 15/09/2026 07:43:40 (esperado
 * 14/09/2026 21:59:29)». Two stamps within the same second show their
 * milliseconds so the two sides never read identical. `currency` is the
 * property's (the engine passes `catalog.currency`).
 */
export function staleReason(stale: StaleField[], currency = "EUR"): string {
  const parts = stale.slice(0, 3).map((s) => {
    const label = STALE_FIELD_LABELS[s.field] ?? s.field;
    let actual = formatStaleValue(s.field, s.actual, currency);
    let expected = formatStaleValue(s.field, s.expected, currency);
    if (s.field === "lastModifiedAt" && actual === expected) {
      actual = formatStaleValue(s.field, s.actual, currency, { withMillis: true });
      expected = formatStaleValue(s.field, s.expected, currency, { withMillis: true });
    }
    return `${label} actual ${actual} (esperado ${expected})`;
  });
  return `la celda cambió desde que se cargó: ${parts.join("; ")}${stale.length > 3 ? "…" : ""}`;
}

/** Cursor key `k` of the journal list must be an ISO timestamp; anything else is a 400, never a Prisma 500. */
export function parseJournalCursorDate(key: { k: string; id: string } | null): Date | null {
  if (!key) return null;
  const at = new Date(key.k);
  if (Number.isNaN(at.getTime())) throw new BadRequestError("El cursor de paginación no es válido.");
  return at;
}

// ---- revert wording and links ---------------------------------------------------

/**
 * Reason of the inverse entry a revert writes. The journal id is NOT part of
 * the text any more (it lives in changesJson.revertsJournalId, exposed as
 * `revertsJournalId`): the history read «Reversión de cmu1… (Corrección)»
 * and the operator only cares about the motive. `extra` is the optional text
 * of the revert body (RateJournalRevertRequest.reason).
 */
export function revertReason(originalReason: string | null | undefined, extra?: string | null): string {
  const motive = (originalReason ?? "").trim();
  const suffix = (extra ?? "").trim();
  return `${motive ? `Reversión: ${motive}` : "Reversión"}${suffix ? ` — ${suffix}` : ""}`;
}

const LEGACY_REVERT_REASON = /^Reversión de ([A-Za-z0-9_-]+)/;

/**
 * Entries written before the cierre (2026-09-15) carried the reverted id in
 * the reason («Reversión de <id> (<motivo>)»); read it back so the history
 * links old reverts too. Null when the reason does not follow that shape.
 */
export function legacyRevertsJournalId(reason: string | null | undefined): string | null {
  const match = reason ? LEGACY_REVERT_REASON.exec(reason) : null;
  return match ? match[1]! : null;
}

/** `revertsJournalId` of an entry: the stored link first, the legacy wording as fallback. */
export function readRevertsJournalId(changesJson: unknown, reason: string | null | undefined): string | null {
  const stored = changesJson && typeof changesJson === "object" && !Array.isArray(changesJson) ? (changesJson as { revertsJournalId?: unknown }).revertsJournalId : undefined;
  if (typeof stored === "string" && stored.length > 0) return stored;
  return legacyRevertsJournalId(reason);
}

const PUSH_STATUSES: ReadonlySet<string> = new Set<RateJournalPushStatus>(["draft", "queued", "pushed", "partial", "failed", "superseded"]);

/** DB value → contract union; anything unknown (old rows, typos) reads as `draft`. */
export function normalizePushStatus(raw: string | null | undefined): RateJournalPushStatus {
  return raw && PUSH_STATUSES.has(raw) ? (raw as RateJournalPushStatus) : "draft";
}

// ---- idempotency (clientRequestId) -------------------------------------------------

/**
 * True for Prisma's unique-violation error (P2002). When `column` is given the
 * violated target must mention it (Prisma reports the DB column names in
 * `meta.target`); with no `meta.target` at all the code alone decides, so the
 * caller must still confirm by re-reading the row it expects.
 */
export function isUniqueViolation(error: unknown, column?: string): boolean {
  if (!error || typeof error !== "object") return false;
  if ((error as { code?: unknown }).code !== "P2002") return false;
  if (!column) return true;
  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  if (target === undefined || target === null) return true;
  const list = Array.isArray(target) ? target.map(String) : [String(target)];
  return list.some((t) => t.includes(column));
}

/**
 * Run `write`; if it fails with a unique violation on `client_request_id`
 * (two retries with the same clientRequestId raced past the advisory lock —
 * in practice impossible, hence «belt and braces») return `replay()` when it
 * finds the entry the other attempt wrote; any other failure, or a P2002 whose
 * row cannot be found, is rethrown untouched.
 */
export async function withIdempotentReplay<T>(clientRequestId: string | null | undefined, write: () => Promise<T>, replay: () => Promise<T | null>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (!clientRequestId || !isUniqueViolation(error, "client_request_id")) throw error;
    const replayed = await replay();
    if (replayed === null) throw error;
    return replayed;
  }
}
