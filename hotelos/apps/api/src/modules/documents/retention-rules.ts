// Documents · retention and legal deadlines (Tanda T9 · lote T9-03, design
// §3.2 "Conservación" and §3.5 "Plazos que el módulo convierte en tareas").
//
// Retention (retentionUntilFor): 31/12 of the document's fiscal year plus
//   · 6 years by default (art. 30 CCom: invoices, delivery notes, receipts,
//     contracts, supplier letters, administrative notices),
//   · 10 years when the reviewer flags extendedRetention (art. 66 bis.2 LGT:
//     investment goods under regularisation, quotas pending compensation),
//   · letterRetentionYears (6 by default, design §3.2 / §8: supplier
//     correspondence is business correspondence under art. 30 CCom) for
//     letters / other documents,
//   · personalDataRetentionYears (4, AEPD 148/2019) ONLY for letters / other
//     documents explicitly tied to a person (`personalData: true`, i.e. the
//     row carries a guestId) and with no fiscal effect,
//   · 1 year for rejected documents (no fiscal effect: blocked, then purged).
// Deadlines (dueAtFor): +10 natural days (administrative notice, art. 43 Ley
//   39/2015), +10 business days (AEAT requirement, art. 55 RD 1065/2007), +20
//   natural days (traffic fine, arts. 94-95 RDL 6/2015), +4 days skipping
//   Saturdays, Sundays and national holidays (e-invoice status, art. 10 RD
//   238/2026); letters, contracts and the rest have no legal deadline (null).
// Pure date arithmetic in UTC calendar days; national holidays are the fixed
// dates plus Good Friday (computed), updatable in one place.

export type DocumentKind = "invoice" | "delivery_note" | "receipt" | "letter" | "administrative_notice" | "contract" | "other";

/** Kinds that carry a legal deadline (§3.5) on top of the document kinds. */
export type DeadlineKind = DocumentKind | "aeat_requirement" | "traffic_fine" | "e_invoice";

export type DocumentRetentionStatus = "pending" | "sent" | "approved" | "rejected" | "archived" | string;

export type RetentionSettings = {
  /** Default years for fiscal documents (6). */
  retentionYears?: number;
  /** Years when extendedRetention is set (10). */
  extendedRetentionYears?: number;
  /** Years for supplier letters / other documents (6, art. 30 CCom; design §8). */
  letterRetentionYears?: number;
  /** Years for letters / other documents about a person and without fiscal effect (4, AEPD 148/2019). */
  personalDataRetentionYears?: number;
  /** Years for rejected documents (1). */
  rejectedRetentionYears?: number;
};

export const DEFAULT_RETENTION_SETTINGS: Required<RetentionSettings> = Object.freeze({
  retentionYears: 6,
  extendedRetentionYears: 10,
  letterRetentionYears: 6,
  personalDataRetentionYears: 4,
  rejectedRetentionYears: 1
});

/** Kinds without fiscal effect by themselves (the reviewer can still flag them). */
const NON_FISCAL_KINDS: ReadonlySet<DocumentKind> = new Set<DocumentKind>(["letter", "other"]);

/** IncomingDocumentKind (catálogo) → tipo de retención; e_invoice_status y unknown → other. */
export function retentionKindOf(kind: string): DocumentKind {
  switch (kind) {
    case "invoice":
    case "delivery_note":
    case "receipt":
    case "letter":
    case "administrative_notice":
    case "contract":
      return kind;
    default:
      return "other";
  }
}

export type RetentionInput = {
  kind: DocumentKind;
  /** Date of the document (issue date, or capture date when unknown). */
  documentDate: Date;
  extendedRetention?: boolean;
  /** Explicit mark «datos personales sin efecto fiscal» (the row names a guest): 4 years for letter / other. */
  personalData?: boolean;
  status?: DocumentRetentionStatus | null;
  settings?: RetentionSettings | null;
};

/** Number of years the rules add to the fiscal year of the document. */
export function retentionYearsFor(input: Pick<RetentionInput, "kind" | "extendedRetention" | "personalData" | "status" | "settings">): number {
  const s = { ...DEFAULT_RETENTION_SETTINGS, ...(input.settings ?? {}) };
  if (input.status === "rejected") return s.rejectedRetentionYears;
  if (input.extendedRetention) return s.extendedRetentionYears;
  if (NON_FISCAL_KINDS.has(input.kind)) return input.personalData === true ? s.personalDataRetentionYears : s.letterRetentionYears;
  return s.retentionYears;
}

/** 31/12 (UTC) of the document's year + the years of retentionYearsFor. */
export function retentionUntilFor(input: RetentionInput): Date {
  const years = retentionYearsFor(input);
  const year = input.documentDate.getUTCFullYear() + years;
  return new Date(Date.UTC(year, 11, 31));
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

/** Spanish national holidays with a fixed date (MM-DD), non-substitutable by the regions. */
export const SPAIN_NATIONAL_FIXED_HOLIDAYS: readonly string[] = Object.freeze([
  "01-01", // Año Nuevo
  "01-06", // Epifanía
  "05-01", // Fiesta del Trabajo
  "08-15", // Asunción
  "10-12", // Fiesta Nacional
  "11-01", // Todos los Santos
  "12-06", // Constitución
  "12-08", // Inmaculada
  "12-25" // Navidad
]);

/** Easter Sunday (Gregorian, Meeus/Jones/Butcher) as a UTC date. */
export function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3 = March, 4 = April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

/** Good Friday (national holiday everywhere in Spain) as a UTC date. */
export function goodFriday(year: number): Date {
  return addDays(easterSunday(year), -2);
}

function mmdd(date: Date): string {
  return `${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function isNationalHoliday(date: Date): boolean {
  if (SPAIN_NATIONAL_FIXED_HOLIDAYS.includes(mmdd(date))) return true;
  const friday = goodFriday(date.getUTCFullYear());
  return friday.getUTCMonth() === date.getUTCMonth() && friday.getUTCDate() === date.getUTCDate();
}

export function isWeekend(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

/** Monday–Friday and not a national holiday. */
export function isBusinessDay(date: Date): boolean {
  return !isWeekend(date) && !isNationalHoliday(date);
}

/** UTC midnight of the calendar day of `date`. */
export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function addDays(date: Date, days: number): Date {
  const out = startOfUtcDay(date);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

/** Adds `days` business days (skipping weekends and national holidays); negative counts walk backwards. */
export function addBusinessDays(date: Date, days: number): Date {
  let current = startOfUtcDay(date);
  let remaining = Math.abs(days);
  const step = days < 0 ? -1 : 1;
  while (remaining > 0) {
    current = addDays(current, step);
    if (isBusinessDay(current)) remaining--;
  }
  return current;
}

/**
 * Business days strictly after `from` up to and including `to` (0 when `to`
 * is not after `from`). businessDaysBetween(d, addBusinessDays(d, n)) === n.
 */
export function businessDaysBetween(from: Date, to: Date): number {
  let current = startOfUtcDay(from);
  const end = startOfUtcDay(to);
  let count = 0;
  while (current < end) {
    current = addDays(current, 1);
    if (isBusinessDay(current)) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Deadlines (§3.5)
// ---------------------------------------------------------------------------

export type DeadlineRule = { kind: "natural"; days: number } | { kind: "business"; days: number } | null;

/** Default deadline per kind; the reviewer can always override dueAt. */
export function deadlineRuleFor(kind: DeadlineKind): DeadlineRule {
  switch (kind) {
    case "administrative_notice":
      return { kind: "natural", days: 10 };
    case "aeat_requirement":
      return { kind: "business", days: 10 };
    case "traffic_fine":
      return { kind: "natural", days: 20 };
    case "e_invoice":
      // "cuatro días naturales, excluyendo sábados, domingos y festivos nacionales" (art. 10 RD 238/2026)
      return { kind: "business", days: 4 };
    default:
      return null;
  }
}

/** Default dueAt (UTC midnight of the due calendar day) or null when the kind has no legal deadline. */
export function dueAtFor(kind: DeadlineKind, notedAt: Date): Date | null {
  const rule = deadlineRuleFor(kind);
  if (!rule) return null;
  return rule.kind === "natural" ? addDays(notedAt, rule.days) : addBusinessDays(notedAt, rule.days);
}
