// Estados contables · pure helpers shared by the PGC statement screens of the
// lote 6-C (Sumas y saldos, Balance de situación, Pérdidas y ganancias,
// Cierre de ejercicio). No JSX (not a screen for the discoverability walker
// nor for the Cocoa contract): period presets on the settlement helpers of
// services/finance-contracts.ts, string-only column definitions of a
// StatementLine table (label indented by level · amount · comparative) and
// the download of a statement in pdf / xlsx / csv.

import type { StatementLine } from "@hotelos/shared";
import type { CocoaSelectOption, CocoaTableColumn } from "../../components/cocoa";
import { monthPeriod, periodBounds, previousPeriod, quarterPeriod, yearPeriod } from "../../services/finance-contracts";
import type { StatementDownloadFormat } from "../../services/finance-contracts";
import { money } from "../../lib/format";
import { todayIso } from "../accounting/accounting-ui";

// ---------------------------------------------------------------------------
// Period presets
// ---------------------------------------------------------------------------

export type PeriodPresetKey = "year" | "previousYear" | "quarter" | "previousQuarter" | "month" | "custom";

export const PERIOD_PRESET_OPTIONS: readonly CocoaSelectOption[] = [
  { value: "year", label: "Ejercicio en curso" },
  { value: "previousYear", label: "Ejercicio anterior" },
  { value: "quarter", label: "Trimestre en curso" },
  { value: "previousQuarter", label: "Trimestre anterior" },
  { value: "month", label: "Mes en curso" },
  { value: "custom", label: "Fechas a medida" }
];

export type DateRange = { from: string; to: string };

/** Inclusive bounds of a preset for the given day (hotel time); `custom` keeps the current range. */
export function presetRange(preset: PeriodPresetKey, current: DateRange, today: string = todayIso()): DateRange {
  let code: string | null = null;
  switch (preset) {
    case "year":
      code = yearPeriod(today);
      break;
    case "previousYear":
      code = previousPeriod(yearPeriod(today));
      break;
    case "quarter":
      code = quarterPeriod(today);
      break;
    case "previousQuarter":
      code = previousPeriod(quarterPeriod(today));
      break;
    case "month":
      code = monthPeriod(today);
      break;
    default:
      return current;
  }
  const bounds = code ? periodBounds(code) : null;
  return bounds ? { from: bounds.from, to: bounds.to } : current;
}

/** The preset a range corresponds to (so the control reflects a deep link), else `custom`. */
export function presetOf(range: DateRange, today: string = todayIso()): PeriodPresetKey {
  const presets: PeriodPresetKey[] = ["year", "previousYear", "quarter", "previousQuarter", "month"];
  for (const preset of presets) {
    const candidate = presetRange(preset, range, today);
    if (candidate.from === range.from && candidate.to === range.to) return preset;
  }
  return "custom";
}

// ---------------------------------------------------------------------------
// Statement lines (Balance · PyG)
// ---------------------------------------------------------------------------

/** Non-breaking indent by level (0 epigraph · 1 roman numeral · 2 arabic detail). */
export function indentedLabel(line: Pick<StatementLine, "label" | "level">): string {
  return `${"   ".repeat(Math.max(0, line.level))}${line.label}`;
}

/** Signed delta of two MoneyStrings as a number for painting (null when no comparative). */
export function lineDelta(line: Pick<StatementLine, "amount" | "previousAmount">): number | null {
  if (line.previousAmount === undefined) return null;
  const current = Number(line.amount);
  const previous = Number(line.previousAmount);
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  return Math.round((current - previous) * 100) / 100;
}

/** Columns of a statement table; `comparative` adds the previous period and the delta. */
export function statementColumns(comparative: boolean): CocoaTableColumn<StatementLine>[] {
  const columns: CocoaTableColumn<StatementLine>[] = [
    { key: "label", label: "Partida", render: (line) => indentedLabel(line) },
    { key: "amount", label: "Importe", align: "right", render: (line) => money(line.amount) }
  ];
  if (comparative) {
    columns.push({ key: "previousAmount", label: "Periodo anterior", align: "right", render: (line) => (line.previousAmount === undefined ? "—" : money(line.previousAmount)), hideOnNarrow: true });
    columns.push({
      key: "delta",
      label: "Variación",
      align: "right",
      render: (line) => {
        const delta = lineDelta(line);
        return delta === null ? "—" : money(delta, { signDisplay: "exceptZero" });
      },
      hideOnNarrow: true
    });
  }
  return columns;
}

/** Zero-amount detail lines hide by default; epigraphs and lines with accounts stay. */
export function isMeaningfulLine(line: StatementLine): boolean {
  return line.level === 0 || line.accounts.length > 0 || Number(line.amount) !== 0 || (line.previousAmount !== undefined && Number(line.previousAmount) !== 0);
}

export const DOWNLOAD_FORMAT_OPTIONS: readonly CocoaSelectOption[] = [
  { value: "pdf", label: "PDF" },
  { value: "xlsx", label: "Hoja de cálculo (XLSX)" },
  { value: "csv", label: "CSV" }
];

export type DownloadFormat = Exclude<StatementDownloadFormat, "json">;

export function isDownloadFormat(value: string): value is DownloadFormat {
  return value === "pdf" || value === "xlsx" || value === "csv";
}
