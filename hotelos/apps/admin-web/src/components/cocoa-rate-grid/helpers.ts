// CocoaRateGrid v2 — pure helpers (no React, no DOM).
//
// Cell keys, date math, es-ES money formatting, restriction chips, sync
// status presentation, derivation math and the "view cell" resolution that
// merges a draft entry over the persisted cell. Everything here is
// deterministic so it can be unit-tested with node:test.

import type {
  CellSyncState,
  CellSyncStatus,
  ChannelMode,
  RateChangeJournalEntry,
  RateGridCell,
  RateGridCellPatch,
  RateGridCellRecommendation,
  RateGridChannel,
  RatePlanDerivation,
  RateRestrictions,
  RateRestrictionsPatch
} from "@hotelos/shared";
import type { CellBeforeSnapshot, CellKey, DraftEntry, ParsedCellKey } from "./types";
import { AVAILABILITY_PLAN_ID } from "./types";

/* ------------------------------------------------------------------ */
/*  Cell keys                                                          */
/* ------------------------------------------------------------------ */

const KEY_SEP = "|";

/** `${ratePlanId}|${roomTypeId}|${date}` (+ `|${channelId}` for channel override cells). */
export function cellKey(ratePlanId: string, roomTypeId: string, date: string, channelId?: string | null): CellKey {
  const base = `${ratePlanId}${KEY_SEP}${roomTypeId}${KEY_SEP}${date}`;
  return channelId ? `${base}${KEY_SEP}${channelId}` : base;
}

export function parseCellKey(key: CellKey): ParsedCellKey {
  const parts = key.split(KEY_SEP);
  if (parts.length < 3 || parts.length > 4 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error(`Clave de celda no válida: ${JSON.stringify(key)}`);
  }
  const parsed: ParsedCellKey = { ratePlanId: parts[0], roomTypeId: parts[1], date: parts[2] };
  if (parts.length === 4 && parts[3]) parsed.channelId = parts[3];
  return parsed;
}

export function keyOfCell(cell: Pick<RateGridCell, "ratePlanId" | "roomTypeId" | "date">): CellKey {
  return cellKey(cell.ratePlanId, cell.roomTypeId, cell.date);
}

export function keyOfPatch(patch: RateGridCellPatch): CellKey {
  return cellKey(patch.ratePlanId, patch.roomTypeId, patch.date, patch.channelId ?? null);
}

export function isAvailabilityKey(key: CellKey): boolean {
  return key.startsWith(`${AVAILABILITY_PLAN_ID}${KEY_SEP}`);
}

export function indexCells(cells: RateGridCell[]): Map<CellKey, RateGridCell> {
  const idx = new Map<CellKey, RateGridCell>();
  for (const c of cells) idx.set(keyOfCell(c), c);
  return idx;
}

/* ------------------------------------------------------------------ */
/*  Dates (calendar days, no timezone math)                            */
/* ------------------------------------------------------------------ */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Local YYYY-MM-DD of a Date (avoids the UTC shift of `toISOString`). */
export function toIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function todayIso(now: Date = new Date()): string {
  return toIsoDate(now);
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function diffDays(fromIso: string, toIso: string): number {
  const a = Date.UTC(Number(fromIso.slice(0, 4)), Number(fromIso.slice(5, 7)) - 1, Number(fromIso.slice(8, 10)));
  const b = Date.UTC(Number(toIso.slice(0, 4)), Number(toIso.slice(5, 7)) - 1, Number(toIso.slice(8, 10)));
  return Math.round((b - a) / 86_400_000);
}

/** Inclusive list of calendar days. */
export function eachDay(fromIso: string, toIso: string): string[] {
  const n = diffDays(fromIso, toIso);
  if (n < 0) return [];
  const out: string[] = [];
  for (let i = 0; i <= n; i++) out.push(addDays(fromIso, i));
  return out;
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function isoWeekday(iso: string): number {
  const d = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

export function isWeekend(iso: string): boolean {
  const wd = isoWeekday(iso);
  return wd === 6 || wd === 7;
}

const WEEKDAY_SHORT = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"];
const MONTH_SHORT = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const MONTH_LONG = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre"
];

export const WEEKDAY_LABELS: ReadonlyArray<{ value: number; short: string; long: string }> = [
  { value: 1, short: "L", long: "Lunes" },
  { value: 2, short: "M", long: "Martes" },
  { value: 3, short: "X", long: "Miércoles" },
  { value: 4, short: "J", long: "Jueves" },
  { value: 5, short: "V", long: "Viernes" },
  { value: 6, short: "S", long: "Sábado" },
  { value: 7, short: "D", long: "Domingo" }
];

/** "lun 12" style header parts (deterministic Spanish, no Intl dependency). */
export function formatDateHeader(iso: string): { weekday: string; day: string; month: string; isFirstOfMonth: boolean } {
  const wd = isoWeekday(iso);
  const day = Number(iso.slice(8, 10));
  const month = Number(iso.slice(5, 7)) - 1;
  return {
    weekday: WEEKDAY_SHORT[wd - 1],
    day: String(day),
    month: MONTH_SHORT[month],
    isFirstOfMonth: day === 1
  };
}

/** "12 de marzo de 2026" */
export function formatDateLong(iso: string): string {
  if (!isIsoDate(iso)) return iso;
  const day = Number(iso.slice(8, 10));
  const month = Number(iso.slice(5, 7)) - 1;
  return `${day} de ${MONTH_LONG[month]} de ${iso.slice(0, 4)}`;
}

/** "12 mar" */
export function formatDateShort(iso: string): string {
  if (!isIsoDate(iso)) return iso;
  const day = Number(iso.slice(8, 10));
  const month = Number(iso.slice(5, 7)) - 1;
  return `${day} ${MONTH_SHORT[month]}`;
}

/** "12–18 mar" / "28 feb – 3 mar" / "12 mar" */
export function formatDateRange(fromIso: string, toIso: string): string {
  if (fromIso === toIso) return formatDateShort(fromIso);
  if (fromIso.slice(0, 7) === toIso.slice(0, 7)) {
    return `${Number(fromIso.slice(8, 10))}–${formatDateShort(toIso)}`;
  }
  return `${formatDateShort(fromIso)} – ${formatDateShort(toIso)}`;
}

/** "10:42" local time of an ISO timestamp; null when unparsable. */
export function formatTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "12 mar, 10:42" */
export function formatDateTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${formatDateShort(toIsoDate(d))}, ${formatTime(iso)}`;
}

/* ------------------------------------------------------------------ */
/*  Money (es-ES)                                                      */
/* ------------------------------------------------------------------ */

const NBSP = "\u00a0";

/**
 * es-ES money: "132 €" for integers, "132,50 €" otherwise. No thousands
 * separator below 10 000 (es-ES minimumGroupingDigits = 2), "12.500 €" above.
 * Deterministic implementation (no Intl) so tests and SSR agree.
 */
export function formatMoney(value: number | null | undefined, currency = "EUR"): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "sin tarifa";
  const rounded = Math.round(value * 100) / 100;
  const isInt = Number.isInteger(rounded);
  const abs = Math.abs(rounded);
  const intPart = Math.trunc(abs);
  const intStr = intPart >= 10_000 ? intPart.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".") : intPart.toString();
  const decStr = isInt ? "" : `,${Math.round((abs - intPart) * 100).toString().padStart(2, "0")}`;
  const sign = rounded < 0 ? "−" : "";
  return `${sign}${intStr}${decStr}${NBSP}${currencySymbol(currency)}`;
}

export function currencySymbol(currency: string): string {
  switch (currency.toUpperCase()) {
    case "EUR":
      return "€";
    case "USD":
      return "$";
    case "GBP":
      return "£";
    default:
      return currency.toUpperCase();
  }
}

/** Number only, es-ES decimals: "132" / "132,50". */
export function formatNumber(value: number | null | undefined, decimals?: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  const d = decimals ?? (Number.isInteger(Math.round(value * 100) / 100) ? 0 : 2);
  return value.toFixed(d).replace(".", ",");
}

/** "+10 %" / "−5 %" */
export function formatPercent(value: number | null | undefined, decimals = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${Math.abs(value).toFixed(decimals).replace(".", ",")}${NBSP}%`;
}

/** "+12 €" / "−5 €" */
export function formatSignedMoney(value: number, currency = "EUR"): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${formatMoney(Math.abs(value), currency)}`;
}

/* ------------------------------------------------------------------ */
/*  Restrictions                                                       */
/* ------------------------------------------------------------------ */

export type RestrictionKey = keyof RateRestrictions;

export const RESTRICTION_KEYS: ReadonlyArray<RestrictionKey> = [
  "minLos",
  "maxLos",
  "minLosThrough",
  "cta",
  "ctd",
  "closed",
  "stopSell",
  "minAdvanceDays",
  "maxAdvanceDays"
];

export const BOOLEAN_RESTRICTION_KEYS: ReadonlyArray<RestrictionKey> = ["cta", "ctd", "closed", "stopSell"];
export const NUMERIC_RESTRICTION_KEYS: ReadonlyArray<RestrictionKey> = [
  "minLos",
  "maxLos",
  "minLosThrough",
  "minAdvanceDays",
  "maxAdvanceDays"
];

export const RESTRICTION_LABELS: Record<RestrictionKey, string> = {
  minLos: "Estancia mínima",
  maxLos: "Estancia máxima",
  minLosThrough: "Estancia mínima (estancia completa)",
  cta: "Cerrado a llegada",
  ctd: "Cerrado a salida",
  closed: "Cerrado",
  stopSell: "Cierre de venta",
  minAdvanceDays: "Antelación mínima",
  maxAdvanceDays: "Antelación máxima"
};

export type RestrictionChip = { key: RestrictionKey; text: string; tone: "danger" | "warning" | "info"; label: string };

/** Compact chips shown inside a cell: MÍN2, MÍNT3, MÁX7, CTA, CTD, CERR, STOP, ANT3. */
export function restrictionChips(r: RateRestrictions | null | undefined): RestrictionChip[] {
  if (!r) return [];
  const out: RestrictionChip[] = [];
  if (r.stopSell) out.push({ key: "stopSell", text: "STOP", tone: "danger", label: "Cierre de venta" });
  if (r.closed) out.push({ key: "closed", text: "CERR", tone: "danger", label: "Cerrado" });
  if (r.cta) out.push({ key: "cta", text: "CTA", tone: "warning", label: "Cerrado a llegada" });
  if (r.ctd) out.push({ key: "ctd", text: "CTD", tone: "warning", label: "Cerrado a salida" });
  if (typeof r.minLos === "number" && r.minLos > 1)
    out.push({ key: "minLos", text: `MÍN${r.minLos}`, tone: "info", label: `Estancia mínima ${r.minLos}` });
  if (typeof r.minLosThrough === "number" && r.minLosThrough > 1)
    out.push({
      key: "minLosThrough",
      text: `MÍNT${r.minLosThrough}`,
      tone: "info",
      label: `Estancia mínima (estancia completa) ${r.minLosThrough}`
    });
  if (typeof r.maxLos === "number" && r.maxLos > 0)
    out.push({ key: "maxLos", text: `MÁX${r.maxLos}`, tone: "info", label: `Estancia máxima ${r.maxLos}` });
  if (typeof r.minAdvanceDays === "number" && r.minAdvanceDays > 0)
    out.push({ key: "minAdvanceDays", text: `ANT${r.minAdvanceDays}`, tone: "info", label: `Antelación mínima ${r.minAdvanceDays} días` });
  if (typeof r.maxAdvanceDays === "number" && r.maxAdvanceDays > 0)
    out.push({ key: "maxAdvanceDays", text: `≤${r.maxAdvanceDays}d`, tone: "info", label: `Antelación máxima ${r.maxAdvanceDays} días` });
  return out;
}

export function describeRestrictions(r: RateRestrictions | null | undefined): string | null {
  const chips = restrictionChips(r);
  return chips.length ? chips.map((c) => c.label).join(", ") : null;
}

export function hasAnyRestriction(r: RateRestrictions | null | undefined): boolean {
  return restrictionChips(r).length > 0;
}

/** Merge a tri-state patch over restrictions: undefined = keep, null = clear, value = set. */
export function applyRestrictionsPatch(base: RateRestrictions | null | undefined, patch: RateRestrictionsPatch | undefined): RateRestrictions {
  const next: RateRestrictions = { ...(base ?? {}) };
  if (!patch) return next;
  for (const key of RESTRICTION_KEYS) {
    if (!(key in patch)) continue;
    const v = patch[key];
    if (v === null || v === undefined) {
      delete next[key];
    } else {
      (next as Record<string, unknown>)[key] = v;
    }
  }
  return next;
}

export function restrictionsEqual(a: RateRestrictions | null | undefined, b: RateRestrictions | null | undefined): boolean {
  for (const key of RESTRICTION_KEYS) {
    const av = normalizeRestrictionValue(a?.[key]);
    const bv = normalizeRestrictionValue(b?.[key]);
    if (av !== bv) return false;
  }
  return true;
}

function normalizeRestrictionValue(v: unknown): unknown {
  if (v === null || v === undefined || v === false || v === 0) return undefined;
  return v;
}

/* ------------------------------------------------------------------ */
/*  Derivation                                                         */
/* ------------------------------------------------------------------ */

export function roundDerived(value: number, roundTo: RatePlanDerivation["roundTo"]): number {
  if (roundTo === undefined) return Math.round(value * 100) / 100;
  if (roundTo === 0) return Math.round(value);
  if (roundTo === 1) return Math.round(value * 10) / 10;
  if (roundTo === 2) return Math.round(value * 100) / 100;
  // 0.99 = psychological: round down to x.99 (e.g. 118.2 → 117.99, 118.99 → 118.99).
  return Math.max(0, Math.ceil(value) - 0.01);
}

/** Price of a derived plan for a given parent price; null when there is no parent price. */
export function computeDerivedPrice(parentPrice: number | null | undefined, derivation: RatePlanDerivation | null | undefined): number | null {
  if (parentPrice === null || parentPrice === undefined || !Number.isFinite(parentPrice)) return null;
  if (!derivation || derivation.mode === "none") return parentPrice;
  const raw = derivation.mode === "percent" ? parentPrice * (1 + derivation.value / 100) : parentPrice + derivation.value;
  return Math.max(0, roundDerived(raw, derivation.roundTo));
}

/** "BAR −10 %" / "BAR −15 €" / "BAR" */
export function derivationLabel(parentCode: string, derivation: RatePlanDerivation | null | undefined, currency = "EUR"): string {
  if (!derivation || derivation.mode === "none") return parentCode;
  if (derivation.mode === "percent") return `${parentCode} ${formatPercent(derivation.value)}`;
  return `${parentCode} ${formatSignedMoney(derivation.value, currency)}`;
}

/** "Derivado de BAR (−10 %)" */
export function derivationLongLabel(parentCode: string, derivation: RatePlanDerivation | null | undefined, currency = "EUR"): string {
  if (!derivation || derivation.mode === "none") return `Derivado de ${parentCode}`;
  const delta = derivation.mode === "percent" ? formatPercent(derivation.value) : formatSignedMoney(derivation.value, currency);
  return `Derivado de ${parentCode} (${delta})`;
}

/* ------------------------------------------------------------------ */
/*  Channel effective price                                            */
/* ------------------------------------------------------------------ */

export function effectivePriceForChannel(basePrice: number | null | undefined, markupPercent: number | null | undefined): number | null {
  if (basePrice === null || basePrice === undefined || !Number.isFinite(basePrice)) return null;
  const pct = markupPercent ?? 0;
  return Math.round(basePrice * (1 + pct / 100) * 100) / 100;
}

/* ------------------------------------------------------------------ */
/*  Sync status presentation                                           */
/* ------------------------------------------------------------------ */

export type SyncTone = "muted" | "pending" | "sending" | "ok" | "error" | "timeout" | "stale";

// «stale» (cierre 2026-09-15): the last confirmed delivery no longer matches
// the grid value (e.g. after a revert that was not sent). The channel still
// sells the OLD value, so the cell must read «Pendiente de reenvío», never a
// reassuring «Confirmado».
export const SYNC_STATUS_META: Record<CellSyncStatus, { label: string; tone: SyncTone; icon: string }> = {
  never: { label: "Sin enviar", tone: "muted", icon: "○" },
  queued: { label: "Pendiente", tone: "pending", icon: "◔" },
  sending: { label: "Enviando…", tone: "sending", icon: "◑" },
  sent: { label: "Enviado", tone: "pending", icon: "◑" },
  confirmed: { label: "Confirmado", tone: "ok", icon: "✓" },
  rejected: { label: "Rechazado", tone: "error", icon: "✕" },
  timeout: { label: "Sin respuesta (tiempo agotado)", tone: "timeout", icon: "⏱" },
  superseded: { label: "Sustituido", tone: "muted", icon: "↻" },
  stale: { label: "Pendiente de reenvío", tone: "stale", icon: "↺" }
};

/** "Confirmado por Booking.com a las 10:42" / "Rechazado por Expedia: …" */
export function describeSync(channelName: string, state: CellSyncState | null | undefined): string {
  if (!state) return `${channelName}: sin enviar`;
  const time = formatTime(state.at);
  switch (state.status) {
    case "confirmed":
      return `Confirmado por ${channelName}${time ? ` a las ${time}` : ""}`;
    case "rejected":
      return `Rechazado por ${channelName}${state.error ? `: ${state.error}` : ""}`;
    case "timeout":
      return `${channelName}: sin respuesta (tiempo agotado)`;
    case "sending":
      return `Enviando a ${channelName}…`;
    case "queued":
      return `Pendiente de envío a ${channelName}`;
    case "sent":
      return `Enviado a ${channelName}${time ? ` a las ${time}` : ""}, esperando confirmación`;
    case "superseded":
      return `${channelName}: sustituido por un envío posterior`;
    case "stale":
      return `${channelName}: pendiente de reenvío (el canal conserva el valor anterior${time ? `, confirmado a las ${time}` : ""})`;
    case "never":
    default:
      // A "never" state can carry an explicit reason (e.g. the editor marks a
      // reverted cell as pending re-send: the channel still holds the old value).
      return state.error ? `${channelName}: ${state.error}` : `${channelName}: sin enviar`;
  }
}

/**
 * Worst status among several channels — what the single cell dot shows.
 * Priority: rejected > timeout > sending > queued/sent > stale > confirmed >
 * never (a stale channel needs the hotelier's action, so it beats a
 * confirmed one; an in-flight delivery will resolve it, so it does not beat
 * sending/queued).
 */
export function aggregateSyncStatus(sync: Record<string, CellSyncState> | null | undefined): CellSyncStatus {
  if (!sync) return "never";
  const statuses = Object.values(sync).map((s) => s.status);
  if (statuses.length === 0) return "never";
  const order: CellSyncStatus[] = ["rejected", "timeout", "sending", "queued", "sent", "stale", "confirmed", "superseded", "never"];
  for (const s of order) if (statuses.includes(s)) return s;
  return "never";
}

/* ------------------------------------------------------------------ */
/*  View cell (persisted cell + draft entry)                           */
/* ------------------------------------------------------------------ */

export interface ViewCell {
  key: CellKey;
  cell: RateGridCell | null;
  basePrice: number | null;
  effectivePrice: number | null;
  restrictions: RateRestrictions;
  available: number | null;
  /** True when a draft entry changes something visible on this cell. */
  modified: boolean;
  /** Draft entry when present. */
  entry: DraftEntry | null;
  /** Derived plan cell that still follows its parent (read-only until converted). */
  derivedLocked: boolean;
  /** Manual override on a derived plan. */
  manualOverride: boolean;
}

export function snapshotBefore(cell: RateGridCell | null | undefined): CellBeforeSnapshot {
  return {
    basePrice: cell?.basePrice ?? null,
    effectivePrice: cell?.effectivePrice ?? null,
    restrictions: { ...(cell?.restrictions ?? {}) },
    available: cell?.inventory?.available ?? null,
    source: cell?.source ?? null,
    lastModifiedAt: cell?.lastModifiedAt ?? null
  };
}

/**
 * Optimistic-concurrency stamp for a BASE cell patch (cierre 2026-09-15):
 * what the editor saw when the cell was loaded. Channel-scoped patches and
 * availability patches carry no stamp (their `before` is not a RateDay
 * snapshot), and a draft persisted before `lastModifiedAt` existed sends the
 * price only. `price: null` is meaningful («no había tarifa»), so it is kept.
 */
export function expectedFromSnapshot(before: CellBeforeSnapshot | null | undefined): RateGridCellPatch["expected"] | undefined {
  if (!before) return undefined;
  const expected: NonNullable<RateGridCellPatch["expected"]> = { price: before.basePrice };
  if (before.lastModifiedAt !== undefined) expected.lastModifiedAt = before.lastModifiedAt;
  return expected;
}

export function resolveViewCell(key: CellKey, cell: RateGridCell | null | undefined, entry: DraftEntry | null | undefined): ViewCell {
  const isDerivedPlan = Boolean(cell?.derivedFrom);
  let basePrice = cell?.basePrice ?? null;
  let effectivePrice = cell?.effectivePrice ?? null;
  let restrictions: RateRestrictions = cell?.restrictions ?? {};
  let available = cell?.inventory?.available ?? null;
  let modified = false;
  let manualOverride = isDerivedPlan && cell?.source === "manual";
  let derivedLocked = isDerivedPlan && cell?.source === "derived";

  if (entry) {
    const p = entry.patch;
    if (p.price !== undefined) {
      basePrice = p.price;
      effectivePrice = p.price;
      modified = modified || p.price !== entry.before.basePrice;
    }
    if (p.restrictions) {
      restrictions = applyRestrictionsPatch(restrictions, p.restrictions);
      modified = modified || !restrictionsEqual(restrictions, entry.before.restrictions);
    }
    if (p.available !== undefined) {
      available = p.available;
      modified = modified || p.available !== (entry.before.available ?? null);
    }
    if (p.convertToManual) {
      manualOverride = true;
      derivedLocked = false;
      modified = true;
    }
    if (p.revertToDerived) {
      manualOverride = false;
      derivedLocked = isDerivedPlan;
      modified = true;
    }
  }

  return { key, cell: cell ?? null, basePrice, effectivePrice, restrictions, available, modified, entry: entry ?? null, derivedLocked, manualOverride };
}

/* ------------------------------------------------------------------ */
/*  Spanish labels for wire enums (jargon → hotelier vocabulary)       */
/* ------------------------------------------------------------------ */

const MEAL_PLAN_LABELS: Record<string, string> = {
  room_only: "Solo alojamiento",
  ro: "Solo alojamiento",
  breakfast: "Con desayuno",
  bed_and_breakfast: "Con desayuno",
  bb: "Con desayuno",
  half_board: "Media pensión",
  hb: "Media pensión",
  full_board: "Pensión completa",
  fb: "Pensión completa",
  all_inclusive: "Todo incluido",
  ai: "Todo incluido"
};

/** "room_only" → "Solo alojamiento"; unknown codes are humanised ("dinner_included" → "Dinner included"). */
export function mealPlanLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  const key = code.trim().toLowerCase();
  if (MEAL_PLAN_LABELS[key]) return MEAL_PLAN_LABELS[key];
  const words = key.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : null;
}

/** Channel mode as the hotelier reads it: "simulado" (stub, no network), "modo de pruebas" (provider sandbox), "real". */
export function channelModeLabel(mode: ChannelMode | string | null | undefined): string {
  if (mode === "stub") return "simulado";
  if (mode === "sandbox") return "modo de pruebas";
  if (mode === "real") return "real";
  return mode ? String(mode) : "";
}

/**
 * Long form of the three channel modes for a <select> (hub «Alta de canal»
 * and the per-row mode select). Each option STARTS with the same words
 * `channelModeLabel` uses in badges, callouts and the «Efectivo: …» line, so
 * the hotelier never reads «Sandbox del proveedor» in one place and «modo de
 * pruebas» in the next (browser-ux-final#11).
 */
export const CHANNEL_MODE_LABELS: Record<ChannelMode, string> = {
  stub: "Simulado (sin red, sin proveedor)",
  sandbox: "Modo de pruebas (entorno de pruebas del proveedor)",
  real: "Real (producción)"
};

const PROVIDER_LABELS: Record<string, string> = {
  booking_com: "Booking.com",
  expedia: "Expedia",
  channex: "Channex",
  airbnb: "Airbnb",
  hotelbeds: "Hotelbeds",
  vrbo: "Vrbo",
  google_hotels_mock: "Google Hotels (simulado)",
  direct_booking_engine: "Motor de reservas directo",
  manual_channel: "Canal manual"
};

/** Provider code as a name ("booking_com" → "Booking.com"); unknown codes are humanised ("new_ota" → "New ota"). */
export function providerLabel(code: string | null | undefined): string {
  if (!code) return "";
  const key = code.trim().toLowerCase();
  if (PROVIDER_LABELS[key]) return PROVIDER_LABELS[key];
  const words = key.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

const CHANNEL_TYPE_LABELS: Record<string, string> = {
  ota: "OTA",
  aggregator: "agregador",
  direct: "motor directo",
  vacation_rental: "alquiler vacacional",
  wholesaler: "mayorista",
  metasearch: "metabuscador",
  gds: "GDS",
  manual: "manual"
};

/** Channel.channelType wire enum → Spanish ("vacation_rental" → "alquiler vacacional"); unknown values are humanised in lower case. */
export function channelTypeLabel(type: string | null | undefined): string {
  if (!type) return "";
  const key = type.trim().toLowerCase();
  if (CHANNEL_TYPE_LABELS[key]) return CHANNEL_TYPE_LABELS[key];
  return key.replace(/[_-]+/g, " ").trim();
}

/** "sin recargo" / "+12 % de recargo" / "−5 % de recargo" (markup applied on top of the base price). */
export function markupLabel(markupPercent: number | null | undefined): string {
  const pct = markupPercent ?? 0;
  if (!pct) return "sin recargo";
  return `${formatPercent(pct)} de recargo`;
}

/** Delivery/sync status labels for lists (log de entregas, filtros). */
export const DELIVERY_STATUS_LABELS: Record<string, string> = {
  queued: "en cola",
  sending: "enviando",
  sent: "enviada",
  confirmed: "confirmada",
  rejected: "rechazada",
  timeout: "sin respuesta",
  superseded: "sustituida",
  stale: "pendiente de reenvío",
  never: "sin enviar"
};

export function deliveryStatusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  return DELIVERY_STATUS_LABELS[status] ?? status;
}

/* ------------------------------------------------------------------ */
/*  Channels: which ones the editor should list                        */
/* ------------------------------------------------------------------ */

/**
 * Channels shown in the editor's selectors and publish flows. Inactive /
 * paused channels stay visible in the Channel Manager (with their badge) but
 * are noise in «Precio visto por» and the channels view; "error" channels
 * are kept so their rejected deliveries remain visible in the sync layer.
 */
export function activeGridChannels<T extends Pick<RateGridChannel, "status">>(channels: T[]): T[] {
  return channels.filter((c) => {
    const s = (c.status ?? "").toLowerCase();
    return s !== "inactive" && s !== "paused" && s !== "disabled";
  });
}

/* ------------------------------------------------------------------ */
/*  Recommendations: layer summary (empty state)                       */
/* ------------------------------------------------------------------ */

export const RECOMMENDATION_MISSING_LABELS: Record<string, string> = {
  compset: "sin datos de compset",
  events: "sin calendario de eventos",
  otb_empty: "sin reservas en libros",
  forecast: "sin previsión",
  stly: "sin histórico del año anterior",
  pickup: "sin pickup",
  rate_shopper: "sin rate shopper"
};

export interface RecommendationSummary {
  /** Cells with a recommendation object (any action). */
  total: number;
  /** raise / lower with a suggested price: the ones «Aceptar todas» can apply. */
  actionable: number;
  hold: number;
  noData: number;
  /** Rounded average confidence (0-100) over `total`, null when empty. */
  avgConfidence: number | null;
  /** Missing signals sorted by frequency (most common first), humanised. */
  missing: string[];
}

/** Aggregates a recommendation set so the layer can explain "nothing to accept" instead of staying silent. */
export function summarizeRecommendations(recs: Iterable<RateGridCellRecommendation | null | undefined>): RecommendationSummary {
  let total = 0;
  let actionable = 0;
  let hold = 0;
  let noData = 0;
  let confidenceSum = 0;
  const missingCount = new Map<string, number>();
  for (const rec of recs) {
    if (!rec) continue;
    total += 1;
    confidenceSum += Number.isFinite(rec.confidence) ? rec.confidence : 0;
    if (rec.action === "no_data") noData += 1;
    else if (rec.action === "hold" || rec.suggestedPrice === null) hold += 1;
    else actionable += 1;
    for (const m of rec.missing ?? []) missingCount.set(m, (missingCount.get(m) ?? 0) + 1);
  }
  const missing = [...missingCount.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code]) => RECOMMENDATION_MISSING_LABELS[code] ?? code);
  return { total, actionable, hold, noData, avgConfidence: total ? Math.round(confidenceSum / total) : null, missing };
}

/* ------------------------------------------------------------------ */
/*  Journal entry status                                               */
/* ------------------------------------------------------------------ */

export type JournalStatusTone = "muted" | "ok" | "warn" | "danger" | "accent";

/**
 * One badge per journal entry. A save without publish and a revert both
 * leave the PMS updated but the channels untouched: they read "guardado sin
 * enviar", never "borrador" (the values are already live in Anfitorio).
 */
export function journalStatusLabel(e: Pick<RateChangeJournalEntry, "status" | "pushStatus">): { label: string; tone: JournalStatusTone } {
  if (e.status === "reverted") return { label: "revertido", tone: "muted" };
  if (e.pushStatus === "pushed") return { label: "✓ publicado", tone: "ok" };
  if (e.pushStatus === "partial") return { label: "publicado parcialmente", tone: "warn" };
  if (e.pushStatus === "failed") return { label: "✕ publicación fallida", tone: "danger" };
  // Cierre 2026-09-15: the outbox stamps «queued» while the deliveries are in
  // the queue and «superseded» when every delivery was replaced by a later
  // publish of the same cells (nothing of this entry reached the channels).
  if (e.pushStatus === "queued") return { label: "… en cola de envío", tone: "accent" };
  if (e.pushStatus === "superseded") return { label: "sustituido por un envío posterior", tone: "muted" };
  return { label: "guardado sin enviar a canales", tone: "accent" };
}

/* ------------------------------------------------------------------ */
/*  Journal items: field / value labels                                */
/* ------------------------------------------------------------------ */

const CELL_SOURCE_LABELS: Record<string, string> = {
  manual: "manual",
  derived: "derivado",
  import: "importado",
  rms: "RMS"
};

/** Journal `field` → Spanish label («Precio», «Origen», «Precio derivado (automático)», restriction names…). */
export function journalFieldLabel(field: string): string {
  if (field === "price") return "Precio";
  if (field === "derivedPrice") return "Precio derivado (automático)";
  if (field === "source") return "Origen";
  if (field === "manuallyOverridden") return "Sobrescritura manual";
  if (field === "available") return "Disponibles";
  if (field === "occupancyPrices") return "Precios por ocupación";
  if (field === "minPrice") return "Precio mínimo";
  if (field === "maxPrice") return "Precio máximo";
  return (RESTRICTION_LABELS as Record<string, string>)[field] ?? field;
}

/** Journal before/after value for `field`, formatted for the hotelier (money, sí/no, origen…). */
export function journalValueLabel(field: string, v: unknown, currency = "EUR"): string {
  if (v === null || v === undefined) return field === "price" || field === "derivedPrice" ? "sin tarifa" : "—";
  if (field === "price" || field === "derivedPrice" || field === "minPrice" || field === "maxPrice") return formatMoney(typeof v === "number" ? v : Number(v), currency);
  if (field === "source") return CELL_SOURCE_LABELS[String(v)] ?? String(v);
  if (typeof v === "boolean") return v ? "sí" : "no";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/* ------------------------------------------------------------------ */
/*  Typed 4xx codes of the rate grid API (Spanish copy for the editor) */
/* ------------------------------------------------------------------ */

/** `details.code` values the editor knows how to explain (rate-grid.schemas / engine / channel-manager). */
export const RATE_GRID_ERROR_CODES = {
  ALL_CELLS_CONFLICT: "ALL_CELLS_CONFLICT",
  JOURNAL_STALE: "JOURNAL_STALE",
  RATE_GRID_BUSY: "RATE_GRID_BUSY",
  CHANNEL_HAS_PENDING_DELIVERIES: "CHANNEL_HAS_PENDING_DELIVERIES",
  NO_CELLS: "NO_CELLS",
  TOO_MANY_CELLS: "TOO_MANY_CELLS",
  INACTIVE_RATE_PLANS: "INACTIVE_RATE_PLANS",
  DERIVATION_CHAIN: "DERIVATION_CHAIN",
  DERIVATION_YIELDS_ZERO: "DERIVATION_YIELDS_ZERO",
  UNKNOWN_IDS: "UNKNOWN_IDS"
} as const;

export type RateGridErrorCode = (typeof RATE_GRID_ERROR_CODES)[keyof typeof RATE_GRID_ERROR_CODES];

function idList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Human message for a typed 4xx of the rate grid / channel manager. The API
 * already answers in Spanish; this adds the «what now» the hotelier needs
 * (retry, reactivate plans, split the request…) and a fallback when the
 * message is empty. Unknown codes return the API message untouched.
 */
export function rateGridErrorMessage(code: string | undefined, apiMessage: string | null | undefined, details: Record<string, unknown> = {}): string {
  const base = (apiMessage ?? "").trim();
  switch (code) {
    case RATE_GRID_ERROR_CODES.RATE_GRID_BUSY:
      // The API already says «reintenta en unos segundos»; only add it when it does not.
      return /reintenta/i.test(base) ? base : `${base || "La parrilla de esta propiedad está siendo modificada por otra petición."} Reintenta en unos segundos.`;
    case RATE_GRID_ERROR_CODES.JOURNAL_STALE:
      return base || "La parrilla cambió después de este asiento: revierte primero los asientos posteriores o fuerza la reversión.";
    case RATE_GRID_ERROR_CODES.ALL_CELLS_CONFLICT:
      return base || "Ninguna celda se pudo aplicar: todas las celdas entran en conflicto.";
    case RATE_GRID_ERROR_CODES.CHANNEL_HAS_PENDING_DELIVERIES: {
      const pending = typeof details.pending === "number" ? details.pending : null;
      return `${base || "El canal tiene entregas pendientes de envío."}${pending !== null ? ` (${pluralize(pending, "entrega pendiente", "entregas pendientes")})` : ""} Espera al drenaje o usa «Drenar ahora» y vuelve a intentarlo.`;
    }
    case RATE_GRID_ERROR_CODES.NO_CELLS:
      return base || "La operación no afecta a ninguna celda: revisa el rango, los tipos y los planes seleccionados.";
    case RATE_GRID_ERROR_CODES.TOO_MANY_CELLS:
      return `${base || "La petición supera el máximo de celdas por guardado."} Reduce el rango de fechas o divide el cambio en varios guardados.`;
    case RATE_GRID_ERROR_CODES.INACTIVE_RATE_PLANS: {
      const ids = idList(details.ratePlanIds);
      return `${base || "Alguno de los planes está desactivado."}${ids.length ? ` Planes: ${ids.join(", ")}.` : ""} Reactívalos en «Planes tarifarios» o quítalos del borrador.`;
    }
    case RATE_GRID_ERROR_CODES.DERIVATION_CHAIN:
      return base || "Un plan con planes derivados no puede convertirse a su vez en derivado (solo se admite un nivel de derivación).";
    case RATE_GRID_ERROR_CODES.DERIVATION_YIELDS_ZERO:
      return base || "La regla de derivación produciría un precio de 0 € o negativo con las tarifas actuales del plan padre: ajusta el importe o el porcentaje.";
    case RATE_GRID_ERROR_CODES.UNKNOWN_IDS: {
      const ids = [...idList(details.ratePlanIds), ...idList(details.roomTypeIds), ...idList(details.channelIds), ...idList(details.ids)];
      return `${base || "La petición incluye identificadores que no pertenecen a esta propiedad."}${ids.length ? ` (${ids.slice(0, 5).join(", ")}${ids.length > 5 ? "…" : ""})` : ""} Recarga la parrilla y vuelve a intentarlo.`;
    }
    default:
      return base;
  }
}

/* ------------------------------------------------------------------ */
/*  Misc                                                               */
/* ------------------------------------------------------------------ */

export function pluralize(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/* ------------------------------------------------------------------ */
/*  Popover placement (RateGridPopover)                                */
/* ------------------------------------------------------------------ */

export interface PopoverPlacementInput {
  /** Anchor rect in viewport coordinates; null centres the popover. */
  anchor: { top: number; left: number; width: number; height: number } | null;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  /** Space between the anchor and the popover (default 6). */
  gap?: number;
  /** Minimum distance to the viewport edges (default 8). */
  margin?: number;
}

/**
 * Where a fixed popover goes: below the anchor when it fits, above it when it
 * does not, and — when neither side has room (a tall «Rechazar · Otro» form on
 * a 800 px viewport) — clamped so its bottom edge stays inside the viewport
 * (browser-ux-final#2). The caller re-runs this whenever the popover's size
 * changes (mode switch), not only when it opens.
 */
export function placePopover(input: PopoverPlacementInput): { top: number; left: number } {
  const gap = input.gap ?? 6;
  const margin = input.margin ?? 8;
  const { width: w, height: h, viewportWidth: vw, viewportHeight: vh } = input;
  const a = input.anchor ?? { top: vh / 2 - h / 2, left: vw / 2 - w / 2, width: 0, height: 0 };
  let top = a.top + a.height + gap;
  if (top + h > vh - margin) {
    const above = a.top - h - gap;
    top = above >= margin ? above : Math.max(margin, vh - h - margin);
  }
  let left = a.left;
  if (left + w > vw - margin) left = Math.max(margin, vw - w - margin);
  if (left < margin) left = margin;
  return { top, left };
}

/* ------------------------------------------------------------------ */
/*  Recommendation popover choices                                     */
/* ------------------------------------------------------------------ */

export interface RecommendationChoices {
  /** «hold» / «no_data» / no suggested price: the engine proposes NO new price. */
  holdLike: boolean;
  /** «Aceptar» applies `suggestedPrice` as is: only when the engine actually suggests one. */
  canAccept: boolean;
  /** The ± stepper needs a starting price (suggested, or the current one for hold). */
  canAdjust: boolean;
  adjustStart: number;
  adjustLabel: string;
}

/**
 * Which actions a recommendation offers. A «hold» carries `suggestedPrice`
 * (the engine's raw computation, often ≠ current) but its decision is «keep
 * the current price»: «Aceptar» must not silently apply that figure
 * (browser-ux-final#3). The hotelier can still set another price explicitly
 * («Fijar otro precio», starting from the CURRENT price) or reject.
 */
export function recommendationChoices(rec: Pick<RateGridCellRecommendation, "action" | "suggestedPrice" | "currentPrice">): RecommendationChoices {
  const holdLike = rec.action === "hold" || rec.action === "no_data" || rec.suggestedPrice === null;
  const start = holdLike ? rec.currentPrice : rec.suggestedPrice;
  const canAdjust = typeof start === "number" && Number.isFinite(start);
  return {
    holdLike,
    canAccept: !holdLike,
    canAdjust,
    adjustStart: canAdjust ? (start as number) : 0,
    adjustLabel: holdLike ? "Fijar otro precio" : "Aceptar con ajuste"
  };
}

/* ------------------------------------------------------------------ */
/*  Toast clearance over the sticky status bar                         */
/* ------------------------------------------------------------------ */

/** Toast offset calibrated for the one-row bar (see Toast.tsx). */
export const TOAST_OFFSET_BASE_PX = 120;
/** Height of the one-row status bar the base offset was measured with (.crg-status min-height). */
export const STATUS_BAR_BASE_HEIGHT_PX = 44;

/**
 * Bottom offset (px) the toast host must keep so it never covers the sticky
 * status bar: the base 120 px plus whatever the bar grew beyond its one-row
 * height (restore banner, «celdas guardadas sin enviar» chip wrapping to a
 * second row). browser-ux-final#9. Since Cocoa 22 · ola 5 the bar is a
 * CocoaActionBar and `publishToastOffset` writes the variable itself; this
 * helper stays as the pure, unit-tested reference of that clearance.
 */
export function toastOffsetForBar(barHeight: number): number {
  const extra = Number.isFinite(barHeight) ? Math.max(0, Math.round(barHeight) - STATUS_BAR_BASE_HEIGHT_PX) : 0;
  return TOAST_OFFSET_BASE_PX + extra;
}

/**
 * «6 entregas encoladas (tarifas y disponibilidad) para 1 celda en 3 canales»:
 * the API queues one delivery per kind and channel, so the figure is always a
 * multiple of the cells; saying so avoids the «6 for 1?» reading
 * (browser-ux-final#7).
 */
export function queuedDeliveriesSummary(queued: number, cells: number, channelCount: number): string {
  const perCell = cells > 0 && channelCount > 0 ? queued / (cells * channelCount) : 0;
  const kinds = perCell > 1 ? " (tarifas y disponibilidad)" : "";
  return `${pluralize(queued, "entrega encolada", "entregas encoladas")}${kinds} para ${pluralize(cells, "celda", "celdas")} en ${pluralize(channelCount, "canal", "canales")}.`;
}

/** Round to 2 decimals (money). */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Simple non-crypto id for client-side ops (uuid when available). */
export function clientId(prefix = "op"): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return `${prefix}_${g.crypto.randomUUID()}`;
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
