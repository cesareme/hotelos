// Single es-ES formatting module for admin-web (Tanda 5 · L1a).
//
// Replaces the 47 local money formatters, the 50 literal `EUR` and the 20
// `toLocaleString()` without locale found by the Tanda 5 audit. Every helper:
//   - formats for `es-ES` in the `Europe/Madrid` time zone (hotel time, not the
//     browser's), whatever the machine the receptionist uses;
//   - accepts null/undefined/NaN/invalid input and returns EMPTY («—») instead
//     of "NaN", "0" or "Invalid Date" (plan §2.3: honest empty values);
//   - caches its Intl instances (creating one per render is the usual
//     performance leak of ad-hoc formatters);
//   - keeps ICU's es-ES grouping rule (minimumGroupingDigits = 2): four-digit
//     numbers stay bare ("1500 €"), the dot appears from 10.000 ("12.500 €"),
//     which is the RAE convention and what the rate grid already does.
//
// Migration guide: docs/runbooks/navegacion-tanda-5.md («Migrar formateadores»).

export const LOCALE = "es-ES";
export const TIME_ZONE = "Europe/Madrid";
/** Placeholder for missing values; never render "0" or "NaN" in its place. */
export const EMPTY = "—";
/** Currency used when the record carries none (the demo properties bill in euros). */
export const DEFAULT_CURRENCY = "EUR";

export type Numeric = number | string | null | undefined;
export type DateInput = Date | string | number | null | undefined;

const numberFormats = new Map<string, Intl.NumberFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();
let pluralRules: Intl.PluralRules | null = null;
let relativeFormat: Intl.RelativeTimeFormat | null = null;

function numberFormat(options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = JSON.stringify(options);
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(LOCALE, options);
    numberFormats.set(key, format);
  }
  return format;
}

function dateFormat(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(options);
  let format = dateFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE, ...options });
    dateFormats.set(key, format);
  }
  return format;
}

/** Numbers and numeric strings (Prisma decimals arrive as strings) → finite number, else null. */
export function toNumber(value: Numeric): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(String(value).trim().replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

// ----------------------------------------------------------------- numbers

export type MoneyOptions = {
  /** Decimal places; "auto" drops them for integer amounts (rate grids, KPIs). Default 2. */
  decimals?: number | "auto";
  /** Compact notation for dashboards: "1,2 mil €". */
  compact?: boolean;
  signDisplay?: Intl.NumberFormatOptions["signDisplay"];
  /** Text for null/invalid input. Default EMPTY. */
  empty?: string;
};

/** ISO 4217 code as it travels in the records (folio, rate, property); null/undefined → DEFAULT_CURRENCY. */
export type CurrencyInput = string | null | undefined;

const ISO_CURRENCY = /^[A-Za-z]{3}$/;

/**
 * "1.234,56 €" · money(12.5, "USD") → "12,50 US$" · money(null) → "—" ·
 * money(v, { decimals: 0 }) → euros without the currency argument (L1c: no
 * "EUR" literal in the screens; the code comes from the record or defaults).
 * A malformed code typed by a user ("euros") never throws: the amount is
 * rendered as a plain number followed by the code as given.
 */
export function money(amount: Numeric, currency?: CurrencyInput, options?: MoneyOptions): string;
export function money(amount: Numeric, options: MoneyOptions): string;
export function money(amount: Numeric, currencyOrOptions?: CurrencyInput | MoneyOptions, maybeOptions?: MoneyOptions): string {
  const options: MoneyOptions =
    currencyOrOptions !== null && typeof currencyOrOptions === "object" ? currencyOrOptions : maybeOptions ?? {};
  const rawCurrency = typeof currencyOrOptions === "string" ? currencyOrOptions.trim() : "";
  const currency = rawCurrency || DEFAULT_CURRENCY;
  const value = toNumber(amount);
  if (value === null) return options.empty ?? EMPTY;
  if (!ISO_CURRENCY.test(currency)) return `${number(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
  const decimals = options.decimals ?? 2;
  const fraction =
    decimals === "auto"
      ? Number.isInteger(Math.round(value * 100) / 100)
        ? { minimumFractionDigits: 0, maximumFractionDigits: 0 }
        : { minimumFractionDigits: 2, maximumFractionDigits: 2 }
      : { minimumFractionDigits: decimals, maximumFractionDigits: decimals };
  return numberFormat({
    style: "currency",
    currency: currency.toUpperCase(),
    currencyDisplay: "symbol",
    ...fraction,
    ...(options.compact ? { notation: "compact", compactDisplay: "short", minimumFractionDigits: 0, maximumFractionDigits: 1 } : {}),
    ...(options.signDisplay ? { signDisplay: options.signDisplay } : {})
  }).format(value);
}

export type NumberOptions = {
  maximumFractionDigits?: number;
  minimumFractionDigits?: number;
  compact?: boolean;
  signDisplay?: Intl.NumberFormatOptions["signDisplay"];
  empty?: string;
};

/** "1.234" · number(1234.5, { maximumFractionDigits: 1 }) → "1.234,5". Default: up to 2 decimals, no padding. */
export function number(value: Numeric, options: NumberOptions = {}): string {
  const parsed = toNumber(value);
  if (parsed === null) return options.empty ?? EMPTY;
  // No explicit `useGrouping`: newer ICU maps `true` to "always" (1234 → "1.234"),
  // which would contradict money() and the RAE rule; the default "auto" keeps
  // the minimumGroupingDigits = 2 behaviour across every helper.
  return numberFormat({
    minimumFractionDigits: options.minimumFractionDigits ?? 0,
    maximumFractionDigits: options.maximumFractionDigits ?? Math.max(options.minimumFractionDigits ?? 0, 2),
    ...(options.compact ? { notation: "compact", compactDisplay: "short" } : {}),
    ...(options.signDisplay ? { signDisplay: options.signDisplay } : {})
  }).format(parsed);
}

export type PercentOptions = {
  /** Input already in percent units (12.5 → "12,5 %", the app convention). Set `ratio: true` for 0.125. */
  ratio?: boolean;
  signDisplay?: Intl.NumberFormatOptions["signDisplay"];
  maximumFractionDigits?: number;
  minimumFractionDigits?: number;
  empty?: string;
};

/** "12,5 %" · percent(3, { signDisplay: "always" }) → "+3 %" · percent(0.125, { ratio: true }) → "12,5 %". */
export function percent(value: Numeric, options: PercentOptions = {}): string {
  const parsed = toNumber(value);
  if (parsed === null) return options.empty ?? EMPTY;
  const ratio = options.ratio ? parsed : parsed / 100;
  return numberFormat({
    style: "percent",
    minimumFractionDigits: options.minimumFractionDigits ?? 0,
    maximumFractionDigits: options.maximumFractionDigits ?? Math.max(options.minimumFractionDigits ?? 0, 1),
    ...(options.signDisplay ? { signDisplay: options.signDisplay } : {})
  }).format(ratio);
}

// ----------------------------------------------------------------- dates

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Any date input → Date or null. A plain "YYYY-MM-DD" is a calendar day: it is
 * anchored at 12:00 UTC so it renders as that day in Madrid whatever the
 * machine's zone (a local-midnight Date would slide a day in the Americas).
 */
export function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    const fromNumber = new Date(value);
    return Number.isNaN(fromNumber.getTime()) ? null : fromNumber;
  }
  const text = value.trim();
  const iso = ISO_DATE.exec(text);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    const parsed = new Date(Date.UTC(year, month - 1, day, 12));
    // Date.UTC rolls impossible days over ("2026-13-45" → 14/02/2027): reject them.
    const valid =
      !Number.isNaN(parsed.getTime()) && parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
    return valid ? parsed : null;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export type DateStyle =
  | "short"
  | "medium"
  | "long"
  | "weekday"
  | "weekdayShort"
  | "weekdayOnly"
  | "dayMonth"
  | "monthYear"
  | "relative";

const DATE_STYLES: Record<Exclude<DateStyle, "relative">, Intl.DateTimeFormatOptions> = {
  short: { day: "2-digit", month: "2-digit", year: "numeric" },
  medium: { day: "numeric", month: "short", year: "numeric" },
  long: { day: "numeric", month: "long", year: "numeric" },
  weekday: { weekday: "long", day: "numeric", month: "long" },
  // Timeline headers, pickup calendars and KPI footers (L1c): «mar, 15 sept» ·
  // «mar» · «15 sept» · «sept 2026».
  weekdayShort: { weekday: "short", day: "numeric", month: "short" },
  weekdayOnly: { weekday: "short" },
  dayMonth: { day: "numeric", month: "short" },
  monthYear: { month: "short", year: "numeric" }
};

export type DateOptions = {
  /** Reference instant for `relative` (tests, "as of" views). Default now. */
  now?: DateInput;
  empty?: string;
};

/**
 * date("2026-09-15") → "15/09/2026" · "medium" → "15 sept 2026" ·
 * "long" → "15 de septiembre de 2026" · "weekday" → "martes, 15 de septiembre" ·
 * "weekdayShort" → "mar, 15 sept" · "weekdayOnly" → "mar" · "dayMonth" → "15 sept" ·
 * "monthYear" → "sept 2026" · "relative" → "ayer" / "hace 3 minutos" / "dentro de 2 días".
 */
export function date(value: DateInput, style: DateStyle = "short", options: DateOptions = {}): string {
  const parsed = toDate(value);
  if (!parsed) return options.empty ?? EMPTY;
  if (style === "relative") return relativeTime(parsed, options.now);
  return dateFormat(DATE_STYLES[style]).format(parsed);
}

export type TimeOptions = { seconds?: boolean; empty?: string };

/** "14:05" (24 h, Madrid) · time(x, { seconds: true }) → "14:05:09". */
export function time(value: DateInput, options: TimeOptions = {}): string {
  const parsed = toDate(value);
  if (!parsed) return options.empty ?? EMPTY;
  return dateFormat({
    hour: "2-digit",
    minute: "2-digit",
    ...(options.seconds ? { second: "2-digit" } : {}),
    hourCycle: "h23"
  }).format(parsed);
}

export type DateTimeOptions = {
  /** Date part: "short" (default, «15/09/2026, 14:05»), "medium" («15 sept 2026, 14:05»), "dayMonth" («15 sept, 14:05»)… */
  style?: Exclude<DateStyle, "relative">;
  empty?: string;
};

/** "15/09/2026, 14:05" — date plus 24 h time in Madrid; `style` picks the date part. */
export function dateTime(value: DateInput, options: DateTimeOptions = {}): string {
  const parsed = toDate(value);
  if (!parsed) return options.empty ?? EMPTY;
  return dateFormat({ ...DATE_STYLES[options.style ?? "short"], hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(parsed);
}

export type DateRangeOptions = { style?: Exclude<DateStyle, "relative" | "weekday">; empty?: string };

/**
 * "12–18 sept 2026" · "28 feb – 3 mar 2026" · same day → "12 sept 2026".
 * Uses Intl's formatRange, so shared parts (month, year) are not repeated.
 */
export function dateRange(from: DateInput, to: DateInput, options: DateRangeOptions = {}): string {
  const start = toDate(from);
  const end = toDate(to);
  const empty = options.empty ?? EMPTY;
  if (!start && !end) return empty;
  const format = dateFormat(DATE_STYLES[options.style ?? "medium"]);
  if (!start || !end) return format.format(start ?? end!);
  if (start.getTime() > end.getTime()) return `${format.format(start)} – ${format.format(end)}`;
  return format.formatRange(start, end);
}

/** "2026-09-15" — the calendar day in Madrid, for API params and date inputs. */
export function isoDate(value: DateInput): string | null {
  const parsed = toDate(value);
  if (!parsed) return null;
  const parts = dateFormat({ year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(parsed);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "ahora mismo" · "hace 5 minutos" · "ayer" · "dentro de 3 días" · "el mes pasado". */
export function relativeTime(value: DateInput, now: DateInput = undefined): string {
  const parsed = toDate(value);
  if (!parsed) return EMPTY;
  const reference = toDate(now) ?? new Date();
  const diff = parsed.getTime() - reference.getTime();
  const abs = Math.abs(diff);
  if (abs < 45_000) return "ahora mismo";
  relativeFormat ??= new Intl.RelativeTimeFormat("es", { numeric: "auto" });
  const sign = diff < 0 ? -1 : 1;
  if (abs < 45 * MINUTE) return relativeFormat.format(sign * Math.max(1, Math.round(abs / MINUTE)), "minute");
  if (abs < 22 * HOUR) return relativeFormat.format(sign * Math.max(1, Math.round(abs / HOUR)), "hour");
  if (abs < 26 * DAY) return relativeFormat.format(sign * Math.max(1, Math.round(abs / DAY)), "day");
  if (abs < 320 * DAY) return relativeFormat.format(sign * Math.max(1, Math.round(abs / (30 * DAY))), "month");
  return relativeFormat.format(sign * Math.max(1, Math.round(abs / (365 * DAY))), "year");
}

// ----------------------------------------------------------------- plurals

export type PluralOptions = { withCount?: boolean; empty?: string };

/** plural(1, "reserva", "reservas") → "1 reserva" · plural(3, …) → "3 reservas" · plural(1250, …) → "1.250 reservas". */
export function plural(count: Numeric, singular: string, pluralForm: string, options: PluralOptions = {}): string {
  const parsed = toNumber(count);
  if (parsed === null) return options.empty ?? EMPTY;
  pluralRules ??= new Intl.PluralRules("es");
  const word = pluralRules.select(parsed) === "one" ? singular : pluralForm;
  return options.withCount === false ? word : `${number(parsed)} ${word}`;
}
