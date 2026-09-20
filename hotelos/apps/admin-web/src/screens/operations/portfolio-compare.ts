// Cartera · comparar hoteles (Tanda UX-2 · lote D6 · F-D9).
//
// Funciones puras de la Cartera de propiedades (PortfolioDashboard.tsx): el
// orden de la tabla (`compareRows`, antes en la pantalla), la media simple de
// la cartera por métrica y el delta de cada hotel frente a esa media, con su
// tono y su etiqueta. Sin React ni DOM: se prueban con `node --test`
// (__tests__/portfolio-compare.test.mts).

import type { CocoaTone } from "../../components/cocoa/cocoa-tones";
import { money, number } from "../../lib/format";

export type PortfolioHealth = "ok" | "warn" | "error";
export type PortfolioPropertyStatus = "open" | "closed" | "maintenance";

/** Fila de `perProperty` de GET /dashboards/portfolio (apps/api portfolio.service.ts). */
export type PortfolioPropertyRow = {
  propertyId: string;
  name: string;
  city?: string;
  region?: string;
  status: PortfolioPropertyStatus;
  roomsCount: number;
  arrivalsToday: number;
  departuresToday: number;
  inHouseNow: number;
  occupancyPct: number;
  adrEur: number;
  revparEur: number;
  revenueMtdEur: number;
  pendingFiscalSubmissions: number;
  pendingBalanceEur: number;
  health: PortfolioHealth;
};

export type SortKey =
  | "name"
  | "status"
  | "roomsCount"
  | "occupancyPct"
  | "adrEur"
  | "revparEur"
  | "revenueMtdEur"
  | "pendingFiscalSubmissions"
  | "pendingBalanceEur"
  | "health";

export type SortDirection = "asc" | "desc";

export type PortfolioSort = { key: SortKey; dir: SortDirection };

export const SORT_KEYS: readonly SortKey[] = ["name", "status", "roomsCount", "occupancyPct", "adrEur", "revparEur", "revenueMtdEur", "pendingFiscalSubmissions", "pendingBalanceEur", "health"];

const TEXT_KEYS: ReadonlySet<SortKey> = new Set<SortKey>(["name", "status", "health"]);

/** Orden inicial de la vista «Tabla» (ingresos del mes, mayor primero). */
export const TABLE_DEFAULT_SORT: PortfolioSort = { key: "revenueMtdEur", dir: "desc" };
/** Orden inicial de la vista «Comparar» (ocupación, mayor primero). */
export const COMPARE_DEFAULT_SORT: PortfolioSort = { key: "occupancyPct", dir: "desc" };

/** Métricas de la comparativa, en el orden de sus columnas. */
export const COMPARE_METRICS = ["occupancyPct", "adrEur", "revparEur", "revenueMtdEur"] as const;
export type CompareMetric = (typeof COMPARE_METRICS)[number];

/** Prefijo de la clave de columna de un delta («delta:occupancyPct»). */
export const DELTA_KEY_PREFIX = "delta:";

/** Clave de orden de una cabecera: una columna delta ordena por su métrica; una clave desconocida no ordena. */
export function sortKeyOf(columnKey: string): SortKey | null {
  const key = columnKey.startsWith(DELTA_KEY_PREFIX) ? columnKey.slice(DELTA_KEY_PREFIX.length) : columnKey;
  return SORT_KEYS.find((candidate) => candidate === key) ?? null;
}

/** Sentido tras pulsar una cabecera: la misma clave se invierte; una nueva empieza ascendente si es texto y descendente si es numérica. */
export function nextSort(prev: PortfolioSort, key: SortKey): PortfolioSort {
  if (prev.key === key) return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
  return { key, dir: TEXT_KEYS.has(key) ? "asc" : "desc" };
}

function sortValue(row: PortfolioPropertyRow, key: SortKey): number | string {
  switch (key) {
    case "name":
      return row.name.toLowerCase();
    case "status":
      return row.status;
    case "health":
      return row.health;
    default:
      return row[key];
  }
}

/** Comparador de dos filas por clave y sentido: números por valor, texto por `localeCompare`; 0 en empate (orden estable). */
export function compareRows(a: PortfolioPropertyRow, b: PortfolioPropertyRow, key: SortKey, dir: SortDirection): number {
  const va = sortValue(a, key);
  const vb = sortValue(b, key);
  const cmp = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
  return dir === "asc" ? cmp : -cmp;
}

/** Copia ordenada; estable (los empates conservan el orden de entrada). */
export function sortRows<Row extends PortfolioPropertyRow>(rows: readonly Row[], sort: PortfolioSort): Row[] {
  return rows.slice().sort((a, b) => compareRows(a, b, sort.key, sort.dir));
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Media simple (sin ponderar por habitaciones) de una métrica; 0 sin filas. Un valor no finito cuenta como 0. */
export function averageOf(rows: readonly PortfolioPropertyRow[], metric: CompareMetric): number {
  if (rows.length === 0) return 0;
  const sum = rows.reduce((acc, row) => acc + finite(row[metric]), 0);
  return round2(sum / rows.length);
}

/** Delta de un valor frente a la media (valor − media), a dos decimales. */
export function deltaVsAverage(value: number, average: number): number {
  return round2(finite(value) - finite(average));
}

export type CompareDelta = Record<CompareMetric, number>;
export type CompareRow = PortfolioPropertyRow & { delta: CompareDelta };
export type CompareView = { average: CompareDelta; rows: CompareRow[] };

/** Con dos o más hoteles hay comparación; con uno, la media es el propio hotel y el delta no dice nada. */
export function canCompare(rows: readonly PortfolioPropertyRow[]): boolean {
  return rows.length >= 2;
}

/** Media de la cartera por métrica y las filas con su delta, ya ordenadas. */
export function compareView(rows: readonly PortfolioPropertyRow[], sort: PortfolioSort = COMPARE_DEFAULT_SORT): CompareView {
  const average = Object.fromEntries(COMPARE_METRICS.map((metric) => [metric, averageOf(rows, metric)])) as CompareDelta;
  const withDelta: CompareRow[] = rows.map((row) => ({
    ...row,
    delta: Object.fromEntries(COMPARE_METRICS.map((metric) => [metric, deltaVsAverage(row[metric], average[metric])])) as CompareDelta
  }));
  return { average, rows: sortRows(withDelta, sort) };
}

/** Por debajo de medio céntimo (o media centésima de punto) el delta se pinta «en la media». */
export const DELTA_EPSILON = 0.005;

/** Tono del delta por signo: por encima de la media `success`, por debajo `danger`, en la media `neutral`. */
export function deltaTone(delta: number): CocoaTone {
  if (!Number.isFinite(delta) || Math.abs(delta) < DELTA_EPSILON) return "neutral";
  return delta > 0 ? "success" : "danger";
}

/** «+3,2 pp» (ocupación, puntos porcentuales) · «−12,50 €» (dinero) · «en la media». */
export function deltaLabel(metric: CompareMetric, delta: number): string {
  if (deltaTone(delta) === "neutral") return "en la media";
  const sign = delta > 0 ? "+" : "−";
  const magnitude = Math.abs(delta);
  const figure = metric === "occupancyPct" ? `${number(magnitude, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} pp` : money(magnitude);
  return `${sign}${figure}`;
}
