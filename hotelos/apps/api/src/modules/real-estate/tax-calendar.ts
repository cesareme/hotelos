// Calendario de tributos locales (Tanda ACT · L0a, diseño §2.4, §5 «Tributos»).
// Puro: sin Prisma ni reloj. Dos piezas:
//   · `voluntaryPeriodFor(ine, kind, year)`: periodo voluntario de pago del
//     padrón. Tabla por código INE del municipio (solo Madrid 28079 verificado
//     por el diseño; A Coruña no aplica a ningún centro) y, en su defecto, el
//     supletorio del art. 62.3 LGT (1 de septiembre a 20 de noviembre).
//   · `expectedReceiptsFor(tax, year)`: recibos `previsto` del ejercicio con su
//     ventana y su importe, repartiendo `expectedAnnualAmount` por periodicidad
//     (partes iguales, el último plazo absorbe el resto de céntimos) o por los
//     plazos de `installmentsJson` (PAC: `pct` de cada plazo, el último ajusta
//     para que la suma sea exactamente el importe anual).
// El dinero se opera en céntimos enteros (nunca float); las cadenas entran y
// salen como `MoneyString` ("1234.56").

import type { IsoDay, MoneyString, PropertyTaxInstallment, PropertyTaxKind, PropertyTaxPeriodicity } from "@hotelos/shared";
import { lastDayOfMonth } from "./vigencias.js";

/** `MM-DD` (mes y día sin año), como `PropertyTax.voluntaryFrom/To` e `installmentsJson[].dueFrom/dueTo`. */
export type MonthDay = string;
export type MonthDayWindow = { from: MonthDay; to: MonthDay };

/** Supletorio art. 62.3 LGT para deudas de notificación colectiva y periódica. */
export const DEFAULT_VOLUNTARY_PERIOD: MonthDayWindow = { from: "09-01", to: "11-20" };

/**
 * Periodos voluntarios por municipio (código INE de 5 cifras) y tributo.
 * Solo entradas verificadas por el diseño (§2.4, §10.2): Madrid. El resto de
 * ayuntamientos de los centros (Santander 39075, Oviedo 33044, Teo 15082,
 * Carreño 33014, Gijón 33024, Oleiros 15058) queda en el supletorio hasta que
 * la administración aporte sus ordenanzas (decisión §6.3 del reconocimiento).
 */
export const MUNICIPAL_VOLUNTARY_PERIODS: Readonly<Record<string, Partial<Record<PropertyTaxKind, MonthDayWindow>>>> = {
  "28079": {
    ibi: { from: "10-01", to: "11-30" },
    iae: { from: "10-01", to: "11-30" },
    vados: { from: "04-01", to: "06-01" }
  }
};

export type VoluntaryPeriodSource = "tributo" | "municipal" | "supletorio";
export type VoluntaryPeriod = { from: IsoDay; to: IsoDay; source: VoluntaryPeriodSource };

const MONTH_DAY_RE = /^(\d{2})-(\d{2})$/;

/** `MM-DD` → { month, day } si el día existe en ese año; null en otro caso. */
export function parseMonthDay(value: unknown, year: number): { month: number; day: number } | null {
  if (typeof value !== "string") return null;
  const match = MONTH_DAY_RE.exec(value);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > lastDayOfMonth(year, month)) return null;
  return { month, day };
}

export function isMonthDay(value: unknown): value is MonthDay {
  // Se comprueba contra un año bisiesto para admitir 02-29.
  return parseMonthDay(value, 2024) !== null;
}

function isoDayOf(year: number, month: number, day: number): IsoDay {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** `MM-DD` + año → día ISO (null si no es un día válido de ese año). */
export function monthDayToIsoDay(value: unknown, year: number): IsoDay | null {
  const parsed = parseMonthDay(value, year);
  return parsed ? isoDayOf(year, parsed.month, parsed.day) : null;
}

/** Ventana `MM-DD..MM-DD` de un año; si `to` cae antes que `from`, `to` pasa al año siguiente. */
function windowOf(window: MonthDayWindow, year: number): { from: IsoDay; to: IsoDay } | null {
  const from = monthDayToIsoDay(window.from, year);
  if (!from) return null;
  let to = monthDayToIsoDay(window.to, year);
  if (!to) return null;
  if (to < from) to = monthDayToIsoDay(window.to, year + 1) ?? to;
  return { from, to };
}

function assertYear(year: number): void {
  if (!Number.isInteger(year) || year < 1900 || year > 9999) throw new RangeError(`año no válido: ${year}`);
}

/**
 * Periodo voluntario de un tributo de padrón en un ejercicio: tabla municipal
 * por INE si existe la entrada, si no el supletorio LGT 62.3.
 */
export function voluntaryPeriodFor(ineMunicipalityCode: string | null | undefined, kind: PropertyTaxKind, year: number): VoluntaryPeriod {
  assertYear(year);
  const municipal = ineMunicipalityCode ? MUNICIPAL_VOLUNTARY_PERIODS[ineMunicipalityCode]?.[kind] : undefined;
  if (municipal) {
    const window = windowOf(municipal, year);
    if (window) return { ...window, source: "municipal" };
  }
  const fallback = windowOf(DEFAULT_VOLUNTARY_PERIOD, year);
  if (!fallback) throw new RangeError(`año no válido: ${year}`);
  return { ...fallback, source: "supletorio" };
}

// ---------------------------------------------------------------------------
// Dinero en céntimos
// ---------------------------------------------------------------------------

const MONEY_RE = /^(-?)(\d+)(?:\.(\d{1,2}))?$/;

/** "1234.56" → 123456; null si no es una cadena decimal con ≤ 2 decimales. */
export function moneyToCents(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = MONEY_RE.exec(value.trim());
  if (!match) return null;
  const sign = match[1] === "-" ? -1 : 1;
  const cents = Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? sign * cents : null;
}

/** 123456 → "1234.56". */
export function centsToMoney(cents: number): MoneyString {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(cents));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Porcentaje "11.11" → centésimas de punto (1111); null si no es válido (0..100, ≤ 2 decimales). */
export function percentToHundredths(value: unknown): number | null {
  const raw = typeof value === "number" ? String(value) : value;
  if (typeof raw !== "string") return null;
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(raw.trim());
  if (!match) return null;
  const hundredths = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return hundredths > 10_000 ? null : hundredths;
}

/** Reparte `totalCents` en `parts` partes iguales; el resto de céntimos va a la última. */
export function splitCentsEvenly(totalCents: number, parts: number): number[] {
  if (parts < 1) return [];
  const base = Math.trunc(totalCents / parts);
  const out = new Array<number>(parts).fill(base);
  out[parts - 1] += totalCents - base * parts;
  return out;
}

// ---------------------------------------------------------------------------
// Recibos previstos
// ---------------------------------------------------------------------------

export type ExpectedReceiptTaxInput = {
  kind: PropertyTaxKind;
  periodicity: PropertyTaxPeriodicity;
  /** Plazos PAC (`pct` en % del importe anual; `dueFrom`/`dueTo` en `MM-DD`). Tiene prioridad sobre `periodicity`. */
  installmentsJson?: PropertyTaxInstallment[] | null;
  expectedAnnualAmount?: MoneyString | null;
  /** Ventana propia del tributo (`MM-DD`), solo para `anual` / `unico`; manda sobre la tabla municipal. */
  voluntaryFrom?: string | null;
  voluntaryTo?: string | null;
  ineMunicipalityCode?: string | null;
};

export type ExpectedReceipt = {
  /** `anual` · `unico` · `1/2` · `3/4` · `7/12` · etiqueta del plazo PAC. */
  period: string;
  dueFrom: IsoDay;
  dueTo: IsoDay;
  /** null cuando el tributo no tiene importe anual previsto. */
  amount: MoneyString | null;
};

const PARTS_BY_PERIODICITY: Record<PropertyTaxPeriodicity, number> = { anual: 1, unico: 1, semestral: 2, trimestral: 4, mensual: 12 };

function annualWindow(tax: ExpectedReceiptTaxInput, year: number): { from: IsoDay; to: IsoDay } {
  if (tax.voluntaryFrom && tax.voluntaryTo) {
    const own = windowOf({ from: tax.voluntaryFrom, to: tax.voluntaryTo }, year);
    if (own) return own;
  }
  const period = voluntaryPeriodFor(tax.ineMunicipalityCode, tax.kind, year);
  return { from: period.from, to: period.to };
}

/**
 * Recibos `previsto` de un ejercicio para un tributo activo. Con
 * `installmentsJson` (≥ 1 plazo) cada plazo produce un recibo con su ventana
 * y `pct` del importe anual; sin plazos, `periodicity` reparte el año en
 * partes iguales (anual / unico: la ventana voluntaria; semestral,
 * trimestral, mensual: el tramo natural del año). Las cantidades suman
 * exactamente `expectedAnnualAmount` cuando existe.
 */
export function expectedReceiptsFor(tax: ExpectedReceiptTaxInput, year: number): ExpectedReceipt[] {
  assertYear(year);
  const totalCents = tax.expectedAnnualAmount == null ? null : moneyToCents(tax.expectedAnnualAmount);
  const installments = Array.isArray(tax.installmentsJson) ? tax.installmentsJson : [];

  if (installments.length > 0) {
    const fallback = annualWindow(tax, year);
    const amounts: Array<number | null> = installments.map((installment) => {
      if (totalCents === null) return null;
      const pct = percentToHundredths(installment.pct);
      if (pct === null) return 0;
      // Redondeo a la mitad hacia arriba sobre enteros: cents × pct / 10_000.
      const product = totalCents * pct;
      return Math.trunc((product + (product >= 0 ? 5_000 : -5_000)) / 10_000);
    });
    if (totalCents !== null && amounts.length > 0) {
      const previous = amounts.slice(0, -1).reduce<number>((acc, value) => acc + (value ?? 0), 0);
      amounts[amounts.length - 1] = totalCents - previous;
    }
    return installments.map((installment, index) => {
      const window = windowOf({ from: installment.dueFrom, to: installment.dueTo }, year) ?? fallback;
      const label = typeof installment.label === "string" && installment.label.trim().length > 0 ? installment.label.trim() : `PAC-${String(index + 1).padStart(2, "0")}`;
      const amount = amounts[index];
      return { period: label, dueFrom: window.from, dueTo: window.to, amount: amount === null ? null : centsToMoney(amount) };
    });
  }

  const parts = PARTS_BY_PERIODICITY[tax.periodicity] ?? 1;
  const amounts: Array<number | null> = totalCents === null ? new Array<null>(parts).fill(null) : splitCentsEvenly(totalCents, parts);
  if (parts === 1) {
    const window = annualWindow(tax, year);
    return [{ period: tax.periodicity === "unico" ? "unico" : "anual", dueFrom: window.from, dueTo: window.to, amount: amounts[0] === null ? null : centsToMoney(amounts[0]) }];
  }
  const monthsPerPart = 12 / parts;
  return amounts.map((amount, index) => {
    const firstMonth = index * monthsPerPart + 1;
    const lastMonth = firstMonth + monthsPerPart - 1;
    return {
      period: `${index + 1}/${parts}`,
      dueFrom: isoDayOf(year, firstMonth, 1),
      dueTo: isoDayOf(year, lastMonth, lastDayOfMonth(year, lastMonth)),
      amount: amount === null ? null : centsToMoney(amount)
    };
  });
}
