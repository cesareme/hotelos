// Vigencias derivadas (Tanda ACT · L0a, diseño §4 «status derivado» y §5.1).
// Puro: días ISO ("YYYY-MM-DD") y aritmética en UTC; sin Prisma, sin reloj
// (el «hoy» lo pasa quien llama, así los tests son deterministas). Nada de lo
// que se calcula aquí se persiste: la vigencia de un documento, el «vencido»
// de un recibo y el plazo de una inspección se derivan en cada lectura.

import type { IsoDay, RealEstateDocumentStatus, RealEstateInspectionDueState } from "@hotelos/shared";

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/** Días de aviso por defecto para documentos (`CompliancePropertyProfile.expiringSoonDays`, 30). */
export const DEFAULT_EXPIRING_SOON_DAYS = 30;
/** Días de aviso por defecto para inspecciones y seguros (diseño §4: 90). */
export const DEFAULT_INSPECTION_WARN_DAYS = 90;

/** True para un día real "YYYY-MM-DD" (2026-02-30 no vale). */
export function isIsoDay(value: unknown): value is IsoDay {
  if (typeof value !== "string" || !ISO_DAY_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function assertIsoDay(value: string, what: string): number {
  if (!isIsoDay(value)) throw new RangeError(`${what} no es un día válido (AAAA-MM-DD): ${value}`);
  return Date.parse(`${value}T00:00:00.000Z`);
}

/** Día ISO de un instante (UTC). */
export function toIsoDay(date: Date): IsoDay {
  return date.toISOString().slice(0, 10);
}

/** `to − from` en días (negativo si `to` es anterior). */
export function daysBetween(from: IsoDay, to: IsoDay): number {
  return Math.round((assertIsoDay(to, "to") - assertIsoDay(from, "from")) / MS_PER_DAY);
}

export function addDays(day: IsoDay, days: number): IsoDay {
  return toIsoDay(new Date(assertIsoDay(day, "day") + days * MS_PER_DAY));
}

/** Último día del mes (1..12) de un año. */
export function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Suma meses conservando el día cuando existe (31-01 + 1 mes → 28/29-02). */
export function addMonths(day: IsoDay, months: number): IsoDay {
  assertIsoDay(day, "day");
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const dom = Number(day.slice(8, 10));
  const index = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(index / 12);
  const targetMonth = (index % 12) + 1;
  const targetDom = Math.min(dom, lastDayOfMonth(targetYear, targetMonth));
  return `${String(targetYear).padStart(4, "0")}-${String(targetMonth).padStart(2, "0")}-${String(targetDom).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Documentos
// ---------------------------------------------------------------------------

/**
 * Vigencia derivada de un documento:
 *   · `sustituido` si tiene versión posterior (`supersededById`), pase lo que pase con la fecha;
 *   · `sin_fecha` sin `validUntil`;
 *   · `caducado` si `validUntil` es anterior a hoy;
 *   · `caduca_pronto` si vence hoy o dentro de `expiringSoonDays` días;
 *   · `vigente` en otro caso.
 */
export function deriveDocumentStatus(
  document: { validUntil: IsoDay | null | undefined; supersededById?: string | null },
  today: IsoDay,
  expiringSoonDays: number = DEFAULT_EXPIRING_SOON_DAYS
): RealEstateDocumentStatus {
  if (document.supersededById) return "sustituido";
  if (!document.validUntil) return "sin_fecha";
  const daysLeft = daysBetween(today, document.validUntil);
  if (daysLeft < 0) return "caducado";
  if (daysLeft <= Math.max(0, expiringSoonDays)) return "caduca_pronto";
  return "vigente";
}

// ---------------------------------------------------------------------------
// Recibos de tributos
// ---------------------------------------------------------------------------

/** El «vencido» del diseño: sin pagar y con `dueTo` anterior a hoy (un recurso no suspende el plazo por sí solo). */
export function isReceiptOverdue(receipt: { status: string; dueTo: IsoDay | null | undefined; paidAt?: IsoDay | null | undefined }, today: IsoDay): boolean {
  if (isReceiptPaid(receipt)) return false;
  if (!receipt.dueTo) return false;
  return daysBetween(today, receipt.dueTo) < 0;
}

/** Pagado: status `pagado` o un recibo recurrido después de pagarlo (conserva `paidAt`; ACT-REV-10). */
export function isReceiptPaid(receipt: { status: string; paidAt?: IsoDay | Date | null | undefined }): boolean {
  return receipt.status === "pagado" || Boolean(receipt.paidAt);
}

/** DD/MM/AAAA para etiquetas y mensajes; los `dueAt` / `paidAt` de los DTO siguen en ISO. */
export function formatDay(day: IsoDay): string {
  return `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;
}

/** Importe "18000.00" → "18.000,00 €" (formato español) para etiquetas; los DTO siguen con MoneyString. */
export function formatMoneyEs(value: string | number): string {
  const [integer, fraction = "00"] = String(value).split(".");
  const negative = integer.startsWith("-");
  const digits = negative ? integer.slice(1) : integer;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negative ? "-" : ""}${grouped},${fraction.padEnd(2, "0").slice(0, 2)} €`;
}

// ---------------------------------------------------------------------------
// Inspecciones
// ---------------------------------------------------------------------------

export type InspectionDueState = { state: RealEstateInspectionDueState; daysLeft: number | null };

/**
 * Plazo derivado de una inspección a partir de su próxima fecha:
 * `sin_fecha` · `vencida` (fecha pasada) · `proxima` (dentro de `warnDays`) · `en_plazo`.
 */
export function inspectionDueState(
  inspection: { nextDueAt: IsoDay | null | undefined },
  today: IsoDay,
  options: { warnDays?: number } = {}
): InspectionDueState {
  if (!inspection.nextDueAt) return { state: "sin_fecha", daysLeft: null };
  const warnDays = options.warnDays ?? DEFAULT_INSPECTION_WARN_DAYS;
  const daysLeft = daysBetween(today, inspection.nextDueAt);
  if (daysLeft < 0) return { state: "vencida", daysLeft };
  if (daysLeft <= Math.max(0, warnDays)) return { state: "proxima", daysLeft };
  return { state: "en_plazo", daysLeft };
}
