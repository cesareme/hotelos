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

// ----------------------------------------------------------------- origin codes
// Cocoa 22 · ola 3 (lote 3-A / 3-C · qa#8). Wire codes of a reservation's
// origin (`channel`, `sourceCode`, `marketSegment`) rendered as Spanish names,
// so chips, facts and journey steps never show «booking_com» or «corporate» to
// the hotelier. Unknown codes are humanised («new_ota» → «New ota») instead of
// leaking the underscore; callers keep the raw code in `title` for support.
// Test connectors («expedia_mock») read «(conector de pruebas)», the wording
// the reservation form already uses for them.

export type CodeLabelOptions = {
  /** Text for null/empty codes. Default EMPTY. */
  empty?: string;
};

const CHANNEL_LABELS: Record<string, string> = {
  direct: "Directo",
  direct_booking_engine: "Motor de reservas directo",
  web: "Web",
  phone: "Teléfono",
  email: "Correo electrónico",
  walk_in: "Walk-in",
  corporate: "Corporativo",
  group: "Grupos",
  groups: "Grupos",
  ota: "OTA",
  gds: "GDS",
  wholesale: "Mayorista / TTOO",
  wholesaler: "Mayorista / TTOO",
  agency: "Agencia de viajes",
  metasearch: "Metabuscador",
  manual: "Canal manual",
  manual_channel: "Canal manual",
  booking_com: "Booking.com",
  bookingcom: "Booking.com",
  expedia: "Expedia",
  airbnb: "Airbnb",
  vrbo: "Vrbo",
  hotelbeds: "Hotelbeds",
  channex: "Channex",
  google_hotels: "Google Hotels",
  tripadvisor: "Tripadvisor",
  trivago: "Trivago"
};

const MARKET_SEGMENT_LABELS: Record<string, string> = {
  corporate: "Corporativo",
  leisure: "Ocio",
  mice: "MICE / Convenciones",
  wedding: "Bodas",
  sports: "Deportes",
  group: "Grupos",
  groups: "Grupos",
  government: "Administración pública",
  wholesale: "Mayorista",
  complimentary: "Cortesía",
  ota: "OTA",
  direct: "Directo",
  transient: "Individual"
};

const TEST_CONNECTOR_SUFFIX = /[_-]?mock$/;

/** "new_ota" → "New ota" (first letter up, underscores and dashes as spaces). */
function humaniseCode(key: string): string {
  const words = key.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

function codeLabel(labels: Record<string, string>, code: string | null | undefined, options: CodeLabelOptions): string {
  const raw = typeof code === "string" ? code.trim() : "";
  if (!raw) return options.empty ?? EMPTY;
  const key = raw.toLowerCase();
  if (labels[key]) return labels[key];
  const base = key.replace(TEST_CONNECTOR_SUFFIX, "");
  if (base && base !== key) return `${labels[base] ?? humaniseCode(base)} (conector de pruebas)`;
  return humaniseCode(key);
}

/**
 * channelLabel("booking_com") → "Booking.com" · "direct" → "Directo" ·
 * "corporate" → "Corporativo" · "expedia_mock" → "Expedia (conector de pruebas)" ·
 * "new_ota" → "New ota" · null → "—". Also for a reservation's `sourceCode`.
 */
export function channelLabel(code: string | null | undefined, options: CodeLabelOptions = {}): string {
  return codeLabel(CHANNEL_LABELS, code, options);
}

/** marketSegmentLabel("leisure") → "Ocio" · "mice" → "MICE / Convenciones" · "ota" → "OTA" · null → "—". */
export function marketSegmentLabel(code: string | null | undefined, options: CodeLabelOptions = {}): string {
  return codeLabel(MARKET_SEGMENT_LABELS, code, options);
}

// Cocoa 22 · ola 5 (lote 5-C · qa#18). Codes of the competitor set
// (/revenue/competencia): the hotel category the API stores as typed by the
// hotelier or seeded («urban», «resort», «urban boutique», «4*») and the
// availability of a shopped rate («available», «sold_out»). Known codes read
// in Spanish; anything else is humanised, so a «4*» or «4 estrellas» typed in
// the form stays as typed. Callers keep the raw code in `title` when it
// differs from the label (rule C19).

const HOTEL_CATEGORY_LABELS: Record<string, string> = {
  urban: "Urbano",
  city: "Urbano",
  "urban boutique": "Boutique urbano",
  boutique: "Boutique",
  resort: "Vacacional",
  vacation: "Vacacional",
  holiday: "Vacacional",
  beach: "Playa",
  rural: "Rural",
  luxury: "Lujo",
  business: "Negocios",
  cultural: "Cultural",
  historic: "Histórico",
  apart: "Apartamentos",
  apartments: "Apartamentos",
  aparthotel: "Aparthotel",
  hostel: "Hostal",
  budget: "Económico",
  economy: "Económico",
  midscale: "Gama media",
  upscale: "Gama alta"
};

const AVAILABILITY_LABELS: Record<string, string> = {
  available: "Disponible",
  open: "Disponible",
  limited: "Últimas unidades",
  low: "Últimas unidades",
  sold_out: "Agotado",
  soldout: "Agotado",
  unavailable: "No disponible",
  closed: "Cerrado",
  restricted: "Restringido",
  on_request: "Bajo petición",
  unknown: "Sin datos"
};

/**
 * hotelCategoryLabel("urban") → "Urbano" · "resort" → "Vacacional" ·
 * "urban_boutique" → "Boutique urbano" · "4*" → "4*" · "Boutique" → "Boutique" · null → "—".
 * Underscores, dashes and repeated spaces are one space before the lookup.
 */
export function hotelCategoryLabel(code: string | null | undefined, options: CodeLabelOptions = {}): string {
  const key = typeof code === "string" ? code.replace(/[_-]+/g, " ").replace(/\s+/g, " ") : code;
  return codeLabel(HOTEL_CATEGORY_LABELS, key, options);
}

/** availabilityLabel("available") → "Disponible" · "sold_out" → "Agotado" · "waitlist" → "Waitlist" · null → "—". */
export function availabilityLabel(code: string | null | undefined, options: CodeLabelOptions = {}): string {
  return codeLabel(AVAILABILITY_LABELS, code, options);
}

// Cocoa 22 · ola 10 (lote 10-C · qa#14). Readiness checks and connector
// health notes arrive from the API with environment variable names
// («SES_HOSPEDAJES_MODE=sandbox»), English field keys («postalCode»), region
// codes («ES_CANARIAS») and engineering words («sandbox», «stub», «flag») a
// hotelier never reads elsewhere in the product. Until the API humanises them
// at source (backoffice.service.ts computeReadiness, compliance-health.service.ts,
// packages/compliance verifactu/software.ts), a screen passes every message
// through readinessMessage(): the known fragments read in Spanish, the dynamic
// parts (counts, names, modes, reasons) are kept and an unknown message comes
// back unchanged. Callers keep the raw text in `title` when it differs (C19).

const INTEGRATION_MODE_PHRASES: Record<string, string> = {
  sandbox: "modo de pruebas",
  preproduction: "modo de preproducción",
  production: "modo de producción"
};

function integrationModePhrase(mode: string): string {
  return INTEGRATION_MODE_PHRASES[mode.toLowerCase()] ?? `modo ${mode}`;
}

const FISCAL_ADDRESS_FIELD_LABELS: Record<string, string> = {
  address: "dirección",
  municipality: "municipio",
  province: "provincia",
  postalCode: "código postal",
  country: "país"
};

const TAX_REGION_LABELS: Record<string, string> = {
  ES_PENINSULA_BALEARES: "Península y Baleares",
  ES_PENINSULA: "Península y Baleares",
  ES_CANARIAS: "Canarias",
  ES_CEUTA: "Ceuta",
  ES_MELILLA: "Melilla"
};

type MessageReplacer = (match: string, ...groups: string[]) => string;
type MessageRewrite = [RegExp, string | MessageReplacer];

// Order matters: whole sentences first, then fragments, then the loose words.
const READINESS_MESSAGE_REWRITES: MessageRewrite[] = [
  // SES.HOSPEDAJES mode and certificate (check ses_hospedajes_credentials).
  [
    /SES_HOSPEDAJES_MODE=([a-z]+): los partes se envían a un simulador, no al MIR\. Configura preproduction\/production con certificado antes del go-live\./g,
    (_match, mode) =>
      `SES.HOSPEDAJES en ${integrationModePhrase(mode)}: los partes se envían a un simulador, no al Ministerio del Interior. Configura el modo de preproducción o producción con certificado antes de salir en vivo.`
  ],
  [/\bSES en modo ([a-z]+) sin certificado:/g, (_match, mode) => `SES.HOSPEDAJES en ${integrationModePhrase(mode)} sin certificado:`],
  [/\bSES\.HOSPEDAJES en modo ([a-z]+) con certificado configurado\./g, (_match, mode) => `SES.HOSPEDAJES en ${integrationModePhrase(mode)} con certificado configurado.`],
  // Connector health note of the fiscal settings card (compliance-health.service.ts), before the generic mode rules.
  [
    /Modo sandbox: no se llama a AEAT\. Cambia VERIFACTU_MODE=preproduction \+ cert para validar contra AEAT pre-producción\./g,
    "Modo de pruebas: no se llama a la AEAT. Cambia a preproducción con certificado para validar contra la AEAT de preproducción."
  ],
  [/SES_HOSPEDAJES_MODE=([a-z]+)/g, (_match, mode) => `SES.HOSPEDAJES en ${integrationModePhrase(mode)}`],
  [/VERIFACTU_MODE=([a-z]+)/g, (_match, mode) => `VeriFactu en ${integrationModePhrase(mode)}`],
  [/SES_HOSPEDAJES_CERT_PATH apunta a un fichero inexistente\./g, "La ruta del certificado de SES.HOSPEDAJES apunta a un fichero que no existe."],
  [/variable de ruta del certificado no configurada/g, "falta la ruta del certificado"],
  [/passphrase del certificado no configurada/g, "falta la contraseña del certificado"],
  [/Variable de path del certificado no configurada\./g, "Falta la ruta del certificado."],
  [/Passphrase del certificado no configurada\./g, "Falta la contraseña del certificado."],
  // Platform certificate notice (check platform_certificate_notice).
  [/\(VERIFACTU_CERT_PATH \/ SES_HOSPEDAJES_CERT_PATH\)/g, "(VeriFactu y SES.HOSPEDAJES)"],
  [
    /los envíos a AEAT\/MIR se firman con un stub \(solo sandbox\)\./g,
    "los envíos a la AEAT y al Ministerio del Interior se firman con una firma de pruebas, válida solo en modo de pruebas."
  ],
  // VeriFactu software block (check verifactu_software_declared · connector health).
  [/Bloque SistemaInformatico incompleto/g, "Datos del software VeriFactu incompletos"],
  [/Bloque SistemaInformatico declarado/g, "Datos del software VeriFactu declarados"],
  [/Bloque SistemaInformatico completo/g, "Datos del software VeriFactu completos"],
  [/Bloque Establecimiento SES completo/g, "Datos del establecimiento para SES.HOSPEDAJES completos"],
  [/En sandbox se envía con valores de relleno\./g, "En modo de pruebas se envía con valores de relleno."],
  [/Falta VERIFACTU_SOFTWARE_NAME \([^)]*\)\./g, "Falta la razón social del productor del software."],
  [/Falta VERIFACTU_SOFTWARE_NIF \([^)]*\)\./g, "Falta el NIF del productor del software (no el del hotel)."],
  [/VERIFACTU_SOFTWARE_NIF no es un NIF válido:/g, "El NIF del productor del software no es válido:"],
  [/Falta VERIFACTU_INSTALL_NUMBER \([^)]*\)\./g, "Falta el número de instalación asignado por el productor."],
  [/IdSistemaInformatico \(VERIFACTU_SYSTEM_ID\) debe tener exactamente/g, "El identificador del sistema debe tener exactamente"],
  [/VERIFACTU_MULTI_OT debe ser/g, "El indicador de varios obligados tributarios debe ser"],
  [
    /INSTALLATION_NOT_DECLARED: el centro no tiene una instalación VeriFactu declarada \(verifactu_installations\)\. En preproduction\/production el NumeroInstalacion nunca sale del entorno:/g,
    "El centro no tiene una instalación VeriFactu declarada. En preproducción o producción el número de instalación no puede salir de la configuración del servidor:"
  ],
  [/La instalación VeriFactu declarada no tiene número \([^)]*\)\./g, "La instalación VeriFactu declarada no tiene número."],
  [/ \((?:VERIFACTU_[A-Z_]+|verifactu_installations\.numero_instalacion)\) supera los (\d+) caracteres permitidos por el XSD/g, " supera los $1 caracteres que admite la AEAT"],
  // Usage notes («activo por uso») name the switch of the settings screen, not the flag.
  [/el flag verifactuEnabled está desactivado/g, "VeriFactu no está activado en la configuración del establecimiento"],
  [/el flag sesHospedajesEnabled está desactivado/g, "SES.HOSPEDAJES no está activado en la configuración del establecimiento"],
  [/el flag compliance_billing \(módulo\) está desactivado/g, "el módulo de facturación y cumplimiento no está activado"],
  // Issuer NIF (check issuer_tax_id_valid).
  [/NIF de relleno \(sandbox\)/g, "NIF de relleno (modo de pruebas)"],
  // Fiscal address keys (check property_fiscal_address_complete).
  [
    /Dirección fiscal incompleta: faltan ([A-Za-z, ]+)\./g,
    (_match, keys) =>
      `Dirección fiscal incompleta: faltan ${keys
        .split(",")
        .map((key) => FISCAL_ADDRESS_FIELD_LABELS[key.trim()] ?? key.trim())
        .join(", ")}.`
  ],
  // Tax region codes (check tax_region_configured).
  [/\bES_(?:PENINSULA_BALEARES|PENINSULA|CANARIAS|CEUTA|MELILLA)\b/g, (match) => TAX_REGION_LABELS[match] ?? match],
  // Loose words nobody should read on a hotelier's screen.
  [/\bModo sandbox\b/g, "Modo de pruebas"],
  [/\(solo sandbox\)/g, "(solo en modo de pruebas)"],
  [/\bsandbox\b/g, "modo de pruebas"],
  [/\bstub\b/g, "simulador"],
  [/\bgo-live\b/g, "salida en vivo"],
  [/\bpreproduction\b/g, "preproducción"],
  [/\bproduction\b/g, "producción"],
  [/\bAEAT\/MIR\b/g, "AEAT y Ministerio del Interior"],
  [/\bal MIR\b/g, "al Ministerio del Interior"]
];

/**
 * readinessMessage("SES_HOSPEDAJES_MODE=sandbox: los partes se envían a un simulador, no al MIR. …")
 *   → "SES.HOSPEDAJES en modo de pruebas: los partes se envían a un simulador, no al Ministerio del Interior. …"
 * readinessMessage("Bloque SistemaInformatico incompleto (Falta VERIFACTU_SOFTWARE_NAME (…).). En sandbox se envía con valores de relleno.")
 *   → "Datos del software VeriFactu incompletos (Falta la razón social del productor del software.). En modo de pruebas se envía con valores de relleno."
 * readinessMessage("3 tipo(s) de habitación activos.") → unchanged · null → "".
 */
export function readinessMessage(message: string | null | undefined): string {
  if (typeof message !== "string") return "";
  let text = message;
  for (const [pattern, replacement] of READINESS_MESSAGE_REWRITES) {
    text = typeof replacement === "string" ? text.replace(pattern, replacement) : text.replace(pattern, replacement);
  }
  return text;
}
