// Coste de personal importado (Tanda 6c · L1) — parser y mapeo, PUROS.
//
// Convierte el fichero agregado de RRHH (CSV o JSON, diseño §6) en filas
// normalizadas centro × mes × grupo × departamento SIN tocar la base de datos:
//   · `parsePayrollCostContent` — CSV (cabecera obligatoria, `;` o `,`, decimales
//     con coma o punto, BOM, mes YYYY-MM o MM/YYYY) o JSON (el agregado del
//     informe `{ lineas, referencia, mapping }` o `{ rows: PayrollCostRowDto[] }`);
//     filas con error → `errors` con nº de línea 1-based; nunca lanza;
//   · `aggregateRows` — fusiona claves repetidas sumando importes y empleados
//     (aviso «filas N y M fusionadas»): la clave natural de PayrollCostLine es
//     (etiqueta ORIGINAL del centro, mes, grupo, departamento) → nunca P2002;
//   · `payrollCostContentHash` — sha256 hex del JSON canónico de filas +
//     referencias normalizadas (ordenadas, importes a 2 decimales): el mismo para
//     el CSV y el JSON equivalentes, independiente de formato, espacios y BOM;
//   · `applyPayrollCostMapping` — resuelve centro (mapeo → centroCode ≡
//     Property.code → etiqueta ≡ code / name / tradeName), departamento (mapeo →
//     columna usali → diccionario DEFAULT_DEPARTMENT_MAP) y grupo (mapeo →
//     mapping.grupos del JSON → canónico); devuelve el plan con celdas
//     (centro, mes), etiquetas sin mapear con sugerencias y departamentos que no
//     admiten la línea `labor` (isAdmittedUsali).
//
// Regla de totales (diseño §1.7): `totalCost = gross + employerSs` SIEMPRE; el
// `coste_total` del fichero es informativo (`reportedTotalCost`) y si difiere
// más de 0,01 se AVISA («se contabiliza bruto + SS»), nunca es error: el
// informe real trae una fila descuadrada y debe poder importarse.
//
// Topes de almacenamiento (corrector 6c · SEC-6C-02): lo que pasa el parser cabe en
// las columnas de `payroll_cost_lines` / `payroll_cost_references` — importes <
// 10^12 (Decimal(14,2)), empleados < 10^6 (Decimal(8,2)), inventario ≤ 2^31-1
// (INT4), etiquetas ≤ 200 caracteres sin caracteres de control (índice único
// btree) — de modo que un valor fuera de rango es un 400 con nº de línea y nunca
// un error de Prisma (500) dentro de la transacción.
//
// GDPR: el formato no admite columnas de persona; los tests usan cifras sintéticas.

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { parseDelimited } from "@hotelos/ai-tools";
import {
  PAYROLL_COST_AMOUNT_MAX,
  PAYROLL_COST_CSV_COLUMNS,
  PAYROLL_COST_CSV_OPTIONAL_COLUMNS,
  PAYROLL_COST_GROUPS,
  PAYROLL_COST_HEADCOUNT_MAX,
  PAYROLL_COST_LABEL_MAX_LENGTH,
  PAYROLL_COST_ROOMS_MAX,
  PAYROLL_COST_USALI_DEPARTMENTS,
  type PayrollCostCentreSuggestion,
  type PayrollCostGroup,
  type PayrollCostImportFormat,
  type PayrollCostImportIssue,
  type PayrollCostImportSource,
  type PayrollCostMapping,
  type PayrollCostUnmappedLabel,
  type PayrollCostUsaliDepartment,
  type PropertyKind
} from "@hotelos/shared";
import { USALI_DEPARTMENTS } from "../accounting/chart-of-accounts.service.js";
import { isAdmittedUsali } from "../financial-statements/usali-mapping.service.js";

export type Dec = Prisma.Decimal;
const D = Prisma.Decimal;
const ROUND = Prisma.Decimal.ROUND_HALF_UP;
const ZERO = new D(0);
/** Separador de claves compuestas (nunca aparece en una etiqueta). */
const SEP = "\u001f";

// ---------------------------------------------------------------------------
// Tipos del parser
// ---------------------------------------------------------------------------

/** Fila normalizada del fichero (una por celda centro × mes × grupo × departamento). */
export type NormalizedRow = {
  /** Nº de línea 1-based del fichero (cabecera = 1) o índice + 1 en `lineas[]`; 0 tras una fusión. */
  line: number;
  /** Etiqueta ORIGINAL del centro, normalizada (trim, espacios colapsados, mayúsculas, acentos conservados). */
  workCenterLabel: string;
  /** `centroCode` del JSON (≡ Property.code); null en CSV. */
  centreCodeHint: string | null;
  /** "YYYY-MM". */
  periodCode: string;
  /** Grupo tal como viene (normalizado); el mapeo lo lleva al canónico. */
  costGroup: string;
  /** Departamento tal como viene ("3 RECEPCIO", "6 PISOS"…), normalizado. */
  departmentLabel: string;
  /** Departamento USALI fijado por el fichero (columna `usali` / `usaliDepartment`), en minúsculas; null si no viene. */
  usaliDepartmentHint: string | null;
  gross: Dec;
  employerSs: Dec;
  /** = gross + employerSs (lo que se contabiliza). */
  totalCost: Dec;
  /** `coste_total` del fichero (informativo). */
  reportedTotalCost: Dec | null;
  headcount: Dec;
  /** Columna opcional `ventas_sin_iva` (referencia por centro × mes). */
  netSalesReported: Dec | null;
  /** Columna opcional `hab_disponibles` (INVENTARIO de habitaciones, no habitaciones-noche). */
  roomsAvailableReported: number | null;
};

/** Referencia del informe por centro × mes (empleados, inventario de habitaciones, ventas sin IVA). */
export type NormalizedReference = {
  line: number;
  /** Etiqueta del centro cuando la referencia viene por etiqueta (CSV, `rows`, o `lineas` con un solo centro por código). */
  workCenterLabel: string | null;
  /** `centroCode` del JSON. */
  centreCodeHint: string | null;
  periodCode: string;
  employeesReported: Dec | null;
  roomsAvailableReported: number | null;
  netSalesReported: Dec | null;
};

export type PayrollCostParseHints = {
  /** Etiqueta normalizada de centro → `centroCode` (lineas y mapping.centros del JSON). */
  centreCodes: Record<string, string>;
  /** Etiqueta normalizada de grupo → grupo canónico (mapping.grupos del JSON). */
  groups: Record<string, PayrollCostGroup>;
};

export type PayrollCostParseResult = {
  rows: NormalizedRow[];
  references: NormalizedReference[];
  errors: PayrollCostImportIssue[];
  warnings: string[];
  hints: PayrollCostParseHints;
  /** `organizationId` declarado en el JSON (el servicio exige que coincida); null en CSV. */
  sourceOrganizationId: string | null;
  source: PayrollCostImportSource;
};

export class PayrollCostParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayrollCostParseError";
  }
}

// ---------------------------------------------------------------------------
// Helpers de normalización (puros, exportados para los tests)
// ---------------------------------------------------------------------------

/** trim + espacios colapsados + MAYÚSCULAS; conserva acentos («REG. CORUÑA»). */
export function normalizeLabel(value: unknown): string {
  return String(value ?? "")
    .replace(/\uFEFF/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

/** Para comparar etiquetas con nombres del ERP y cabeceras: sin acentos, minúsculas. */
export function foldLabel(value: unknown): string {
  return normalizeLabel(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Etiqueta del fichero (centro, grupo, departamento) normalizada y acotada: vacía →
 * «<qué> vacío»; caracteres de control (NUL…) o más de PAYROLL_COST_LABEL_MAX_LENGTH
 * caracteres → PayrollCostParseError (SEC-6C-02: Postgres rechaza el NUL con 22P05 y
 * el índice único btree una clave de ~2,7 KB, ambos como 500 dentro de la transacción).
 */
export function parseLabel(raw: unknown, what: string): string {
  const label = normalizeLabel(raw);
  if (!label) throw new PayrollCostParseError(`${what} vacío`);
  if (CONTROL_CHARS.test(label)) throw new PayrollCostParseError(`${what} contiene caracteres de control`);
  if (label.length > PAYROLL_COST_LABEL_MAX_LENGTH) throw new PayrollCostParseError(`${what} supera ${PAYROLL_COST_LABEL_MAX_LENGTH} caracteres (${label.length})`);
  return label;
}

/** «1.234» (un solo punto y exactamente tres decimales, sin coma): se lee como 1,23 pero en formato español suele ser un millar (contable-6C-07). */
export function isAmbiguousThousands(raw: unknown): boolean {
  return typeof raw === "string" && /^[-+]?\d{1,3}\.\d{3}$/.test(raw.replace(/\uFEFF/g, "").replace(/[\s€]/g, ""));
}

/**
 * «1.234,56» · «1234,56» · «1234.56» · «1,234.56» · número → Decimal a 2 decimales
 * (HALF_UP). Varios puntos sin coma → separadores de miles («1.234.567»); un solo
 * punto → decimal. Vacío, no numérico, negativo o mayor que `max` (por defecto
 * PAYROLL_COST_AMOUNT_MAX; los empleados usan PAYROLL_COST_HEADCOUNT_MAX) →
 * PayrollCostParseError.
 */
export function parseAmount(raw: unknown, what = "importe", max: string = PAYROLL_COST_AMOUNT_MAX): Dec {
  let text: string;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) throw new PayrollCostParseError(`${what} no numérico: «${String(raw)}»`);
    text = raw.toString();
  } else if (typeof raw === "string") {
    text = raw.replace(/\uFEFF/g, "").replace(/[\s€]/g, "");
    if (text === "") throw new PayrollCostParseError(`${what} vacío`);
    const lastComma = text.lastIndexOf(",");
    const lastDot = text.lastIndexOf(".");
    if (lastComma >= 0 && lastDot >= 0) {
      text = lastComma > lastDot ? text.replace(/\./g, "").replace(",", ".") : text.replace(/,/g, "");
    } else if (lastComma >= 0) {
      if ((text.match(/,/g) ?? []).length > 1) throw new PayrollCostParseError(`${what} no numérico: «${raw}»`);
      text = text.replace(",", ".");
    } else if (lastDot >= 0 && (text.match(/\./g) ?? []).length > 1) {
      text = text.replace(/\./g, "");
    }
    if (!/^[-+]?\d+(\.\d+)?$/.test(text)) throw new PayrollCostParseError(`${what} no numérico: «${raw}»`);
  } else if (raw === null || raw === undefined) {
    throw new PayrollCostParseError(`${what} vacío`);
  } else {
    throw new PayrollCostParseError(`${what} no numérico: «${String(raw)}»`);
  }
  const value = new D(text).toDecimalPlaces(2, ROUND);
  if (value.isNegative()) throw new PayrollCostParseError(`${what} negativo: «${String(raw)}»`);
  if (value.gt(max)) throw new PayrollCostParseError(`${what} supera el máximo admitido (${max}): «${String(raw)}»`);
  return value;
}

/** «2026-02» · «02/2026» · «2/2026» → "2026-02"; otra cosa → PayrollCostParseError. */
export function parseMonth(raw: unknown): string {
  const text = String(raw ?? "").replace(/\uFEFF/g, "").trim();
  let year: number | null = null;
  let month: number | null = null;
  const iso = /^(\d{4})-(\d{1,2})$/.exec(text);
  const es = /^(\d{1,2})\/(\d{4})$/.exec(text);
  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
  } else if (es) {
    month = Number(es[1]);
    year = Number(es[2]);
  }
  if (year === null || month === null || month < 1 || month > 12 || year < 1900 || year > 2999) {
    throw new PayrollCostParseError(`mes «${text}» no válido: usa YYYY-MM o MM/YYYY`);
  }
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** Entero ≥ 0 (inventario de habitaciones); vacío → null. */
export function parseRoomsInventory(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).replace(/\uFEFF/g, "").trim();
  if (text === "") return null;
  if (!/^\d+$/.test(text)) throw new PayrollCostParseError(`hab_disponibles no válido: «${text}» (entero ≥ 0)`);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value > PAYROLL_COST_ROOMS_MAX) throw new PayrollCostParseError(`hab_disponibles supera el máximo admitido (${PAYROLL_COST_ROOMS_MAX}): «${text}»`);
  return value;
}

/** Acumula los importes ambiguos («1.234») de un fichero y los resume en UN aviso (contable-6C-07). */
function ambiguousAmountsWarning(entries: readonly string[]): string | null {
  if (entries.length === 0) return null;
  const shown = entries.slice(0, 3).join(", ");
  const rest = entries.length > 3 ? ` y ${entries.length - 3} más` : "";
  return `${entries.length} importe(s) con un solo punto y tres cifras detrás (${shown}${rest}) se leen con punto decimal («1.234» → 1,23); si son miles, escribe «1.234,00» o «1234»`;
}

function isBlank(raw: unknown): boolean {
  return raw === null || raw === undefined || String(raw).replace(/\uFEFF/g, "").trim() === "";
}

/** Grupo canónico para una etiqueta («Mantenimiento obra», «mant_obra» → mantenimiento_obra; otra cosa → null). */
export function canonicalGroup(label: unknown): PayrollCostGroup | null {
  const folded = foldLabel(label).replace(/[\s-]+/g, "_");
  return (PAYROLL_COST_GROUPS as readonly string[]).includes(folded) ? (folded as PayrollCostGroup) : null;
}

function isUsaliDepartment(value: string): value is keyof typeof USALI_DEPARTMENTS {
  return Object.prototype.hasOwnProperty.call(USALI_DEPARTMENTS, value);
}

function isLaborDepartment(value: string): value is PayrollCostUsaliDepartment {
  return (PAYROLL_COST_USALI_DEPARTMENTS as readonly string[]).includes(value);
}

function rowKey(row: Pick<NormalizedRow, "workCenterLabel" | "periodCode" | "costGroup" | "departmentLabel">): string {
  return [row.workCenterLabel, row.periodCode, row.costGroup, row.departmentLabel].join("");
}

function compareRows(a: Pick<NormalizedRow, "workCenterLabel" | "periodCode" | "costGroup" | "departmentLabel">, b: Pick<NormalizedRow, "workCenterLabel" | "periodCode" | "costGroup" | "departmentLabel">): number {
  return a.workCenterLabel.localeCompare(b.workCenterLabel) || a.periodCode.localeCompare(b.periodCode) || a.costGroup.localeCompare(b.costGroup) || a.departmentLabel.localeCompare(b.departmentLabel);
}

/** Avisa cuando el `coste_total` del fichero difiere más de 0,01 de bruto + SS (nunca error). */
export function reportedTotalWarning(row: Pick<NormalizedRow, "line" | "totalCost" | "reportedTotalCost">): string | null {
  if (!row.reportedTotalCost) return null;
  if (row.reportedTotalCost.minus(row.totalCost).abs().lte("0.01")) return null;
  return `línea ${row.line}: coste_total ${row.reportedTotalCost.toFixed(2)} ≠ bruto + SS ${row.totalCost.toFixed(2)}; se contabiliza bruto + SS`;
}

/**
 * Fusiona las filas con la misma clave (centro, mes, grupo, departamento)
 * sumando importes y empleados; la fila resultante lleva `line 0` y se avisa
 * «filas N y M fusionadas». El orden de salida es el de primera aparición.
 */
export function aggregateRows(rows: readonly NormalizedRow[], warnings: string[] = []): NormalizedRow[] {
  const byKey = new Map<string, { row: NormalizedRow; lines: number[] }>();
  for (const row of rows) {
    const key = rowKey(row);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { row: { ...row }, lines: [row.line] });
      continue;
    }
    const merged = existing.row;
    merged.line = 0;
    merged.gross = merged.gross.plus(row.gross);
    merged.employerSs = merged.employerSs.plus(row.employerSs);
    merged.totalCost = merged.gross.plus(merged.employerSs);
    merged.reportedTotalCost = merged.reportedTotalCost || row.reportedTotalCost ? (merged.reportedTotalCost ?? ZERO).plus(row.reportedTotalCost ?? ZERO) : null;
    merged.headcount = merged.headcount.plus(row.headcount);
    merged.centreCodeHint = merged.centreCodeHint ?? row.centreCodeHint;
    merged.usaliDepartmentHint = merged.usaliDepartmentHint ?? row.usaliDepartmentHint;
    merged.netSalesReported = merged.netSalesReported ?? row.netSalesReported;
    merged.roomsAvailableReported = merged.roomsAvailableReported ?? row.roomsAvailableReported;
    existing.lines.push(row.line);
  }
  for (const entry of byKey.values()) {
    if (entry.lines.length > 1) {
      warnings.push(`filas ${entry.lines.join(" y ")} fusionadas (misma clave ${entry.row.workCenterLabel} · ${entry.row.periodCode} · ${entry.row.costGroup} · ${entry.row.departmentLabel})`);
    }
  }
  return Array.from(byKey.values(), (entry) => entry.row);
}

/** Clave de referencia para ordenar y hashear: etiqueta si la hay, si no el código del centro. */
export function referenceKey(reference: Pick<NormalizedReference, "workCenterLabel" | "centreCodeHint">): string {
  return reference.workCenterLabel ?? reference.centreCodeHint ?? "";
}

/**
 * sha256 hex del JSON canónico de filas + referencias normalizadas, ordenadas
 * por (workCenterLabel, periodCode, costGroup, departmentLabel) y con importes a
 * 2 decimales: no depende del formato (CSV / JSON), de los espacios ni del BOM.
 */
export function payrollCostContentHash(parsed: Pick<PayrollCostParseResult, "rows" | "references">): string {
  const rows = [...parsed.rows].sort(compareRows).map((row) => ({
    c: row.workCenterLabel,
    m: row.periodCode,
    g: row.costGroup,
    d: row.departmentLabel,
    b: row.gross.toFixed(2),
    s: row.employerSs.toFixed(2),
    t: row.reportedTotalCost ? row.reportedTotalCost.toFixed(2) : null,
    e: row.headcount.toFixed(2)
  }));
  const references = [...parsed.references]
    .map((reference) => ({
      c: referenceKey(reference),
      m: reference.periodCode,
      e: reference.employeesReported ? reference.employeesReported.toFixed(2) : null,
      h: reference.roomsAvailableReported,
      v: reference.netSalesReported ? reference.netSalesReported.toFixed(2) : null
    }))
    .sort((a, b) => a.c.localeCompare(b.c) || a.m.localeCompare(b.m));
  return createHash("sha256").update(JSON.stringify({ rows, references })).digest("hex");
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

const REQUIRED_COLUMNS: readonly string[] = PAYROLL_COST_CSV_COLUMNS;
const OPTIONAL_COLUMNS: readonly string[] = PAYROLL_COST_CSV_OPTIONAL_COLUMNS;

function headerName(cell: string): string {
  return foldLabel(cell).replace(/[\s-]+/g, "_");
}

/** Índices 1-based (fichero) de las líneas no vacías, en orden: parseDelimited las descarta y el usuario necesita el nº real. */
function nonBlankLineNumbers(content: string): number[] {
  const out: number[] = [];
  content.split(/\r?\n/).forEach((line, index) => {
    if (line.trim().length > 0) out.push(index + 1);
  });
  return out;
}

function parseCsv(content: string): PayrollCostParseResult {
  const errors: PayrollCostImportIssue[] = [];
  const warnings: string[] = [];
  const text = content.replace(/^\uFEFF/, "");
  const lineNumbers = nonBlankLineNumbers(text);
  const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  const delimiter = firstLine.includes(";") ? ";" : ",";
  const table = parseDelimited(text, delimiter);
  const result: PayrollCostParseResult = { rows: [], references: [], errors, warnings, hints: { centreCodes: {}, groups: {} }, sourceOrganizationId: null, source: "csv" };

  if (table.header.length === 0) {
    errors.push({ line: null, message: "El fichero está vacío: falta la cabecera «centro;mes;grupo;departamento;salario_bruto;coste_ss;coste_total;empleados»." });
    return result;
  }
  const columns = new Map<string, number>();
  table.header.forEach((cell, index) => {
    const name = headerName(cell);
    if (name && !columns.has(name)) columns.set(name, index);
  });
  const missing = REQUIRED_COLUMNS.filter((column) => !columns.has(column));
  if (missing.length > 0) {
    errors.push({ line: 1, message: `Cabecera inválida: faltan las columnas ${missing.map((c) => `«${c}»`).join(", ")}. Cabecera esperada: ${REQUIRED_COLUMNS.join(";")}[;${OPTIONAL_COLUMNS.join(";")}].` });
    return result;
  }
  for (const name of columns.keys()) {
    if (!REQUIRED_COLUMNS.includes(name) && !OPTIONAL_COLUMNS.includes(name)) warnings.push(`columna desconocida «${name}» ignorada`);
  }
  const col = (name: string): number => columns.get(name) ?? -1;
  const cell = (fields: string[], name: string): string => {
    const index = col(name);
    return index >= 0 ? (fields[index] ?? "") : "";
  };

  const parsedRows: NormalizedRow[] = [];
  const referenceByKey = new Map<string, NormalizedReference>();
  const ambiguous: string[] = [];
  table.rows.forEach((fields, index) => {
    const line = lineNumbers[index + 1] ?? index + 2;
    if (fields.every((field) => field.trim() === "")) return;
    try {
      const workCenterLabel = parseLabel(cell(fields, "centro"), "centro");
      const periodCode = parseMonth(cell(fields, "mes"));
      const costGroup = parseLabel(cell(fields, "grupo"), "grupo");
      const departmentLabel = parseLabel(cell(fields, "departamento"), "departamento");
      for (const column of ["salario_bruto", "coste_ss", "coste_total", "ventas_sin_iva"]) {
        if (col(column) >= 0 && isAmbiguousThousands(cell(fields, column))) ambiguous.push(`línea ${line} (${column} «${cell(fields, column).trim()}»)`);
      }
      const gross = parseAmount(cell(fields, "salario_bruto"), "salario_bruto");
      const employerSs = parseAmount(cell(fields, "coste_ss"), "coste_ss");
      const reportedTotalCost = isBlank(cell(fields, "coste_total")) ? null : parseAmount(cell(fields, "coste_total"), "coste_total");
      const headcount = isBlank(cell(fields, "empleados")) ? ZERO : parseAmount(cell(fields, "empleados"), "empleados", PAYROLL_COST_HEADCOUNT_MAX);
      const netSalesReported = col("ventas_sin_iva") >= 0 && !isBlank(cell(fields, "ventas_sin_iva")) ? parseAmount(cell(fields, "ventas_sin_iva"), "ventas_sin_iva") : null;
      const roomsAvailableReported = col("hab_disponibles") >= 0 ? parseRoomsInventory(cell(fields, "hab_disponibles")) : null;
      const usaliRaw = col("usali") >= 0 ? foldLabel(cell(fields, "usali")) : "";
      const row: NormalizedRow = {
        line,
        workCenterLabel,
        centreCodeHint: null,
        periodCode,
        costGroup,
        departmentLabel,
        usaliDepartmentHint: usaliRaw || null,
        gross,
        employerSs,
        totalCost: gross.plus(employerSs),
        reportedTotalCost,
        headcount,
        netSalesReported,
        roomsAvailableReported
      };
      const warning = reportedTotalWarning(row);
      if (warning) warnings.push(warning);
      parsedRows.push(row);
      if (netSalesReported !== null || roomsAvailableReported !== null) {
        const key = `${workCenterLabel}${periodCode}`;
        const existing = referenceByKey.get(key);
        if (!existing) {
          referenceByKey.set(key, { line, workCenterLabel, centreCodeHint: null, periodCode, employeesReported: null, roomsAvailableReported, netSalesReported });
        } else {
          if (existing.netSalesReported === null) existing.netSalesReported = netSalesReported;
          else if (netSalesReported !== null && !existing.netSalesReported.equals(netSalesReported)) warnings.push(`línea ${line}: ventas_sin_iva ${netSalesReported.toFixed(2)} distinta de la línea ${existing.line} (${existing.netSalesReported.toFixed(2)}) para ${workCenterLabel} · ${periodCode}; se conserva la primera`);
          if (existing.roomsAvailableReported === null) existing.roomsAvailableReported = roomsAvailableReported;
          else if (roomsAvailableReported !== null && existing.roomsAvailableReported !== roomsAvailableReported) warnings.push(`línea ${line}: hab_disponibles ${roomsAvailableReported} distinta de la línea ${existing.line} (${existing.roomsAvailableReported}) para ${workCenterLabel} · ${periodCode}; se conserva la primera`);
        }
      }
    } catch (error) {
      errors.push({ line, message: error instanceof Error ? error.message : String(error) });
    }
  });
  const ambiguousWarning = ambiguousAmountsWarning(ambiguous);
  if (ambiguousWarning) warnings.push(ambiguousWarning);
  result.rows = aggregateRows(parsedRows, warnings);
  result.references = Array.from(referenceByKey.values());
  return result;
}

// ---------------------------------------------------------------------------
// JSON (agregado del informe de RRHH o { rows })
// ---------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalAmount(value: unknown, what: string): Dec | null {
  return isBlank(value) ? null : parseAmount(value, what);
}

function parseJson(content: string): PayrollCostParseResult {
  const errors: PayrollCostImportIssue[] = [];
  const warnings: string[] = [];
  const result: PayrollCostParseResult = { rows: [], references: [], errors, warnings, hints: { centreCodes: {}, groups: {} }, sourceOrganizationId: null, source: "json" };
  let data: unknown;
  try {
    data = JSON.parse(content.replace(/^\uFEFF/, ""));
  } catch (error) {
    errors.push({ line: null, message: `JSON no válido: ${error instanceof Error ? error.message : String(error)}` });
    return result;
  }
  if (!isRecord(data)) {
    errors.push({ line: null, message: "El JSON debe ser un objeto con «lineas» (informe de RRHH) o «rows»." });
    return result;
  }
  if (typeof data.organizationId === "string" && data.organizationId.trim()) result.sourceOrganizationId = data.organizationId.trim();
  if (typeof data.fuente === "string" && data.fuente.trim()) result.source = "informe_rrhh";

  if (isRecord(data.mapping)) {
    if (isRecord(data.mapping.centros)) {
      for (const [label, code] of Object.entries(data.mapping.centros)) {
        if (typeof code === "string" && code.trim()) result.hints.centreCodes[normalizeLabel(label)] = code.trim().toUpperCase();
      }
    }
    if (isRecord(data.mapping.grupos)) {
      for (const [label, group] of Object.entries(data.mapping.grupos)) {
        const canonical = canonicalGroup(group);
        if (canonical) result.hints.groups[normalizeLabel(label)] = canonical;
        else warnings.push(`mapping.grupos: «${label}» → «${String(group)}» no es un grupo canónico (${PAYROLL_COST_GROUPS.join(", ")}); se ignora`);
      }
    }
  }

  const parsedRows: NormalizedRow[] = [];
  const referenceByKey = new Map<string, NormalizedReference>();
  const ambiguous: string[] = [];
  const addReference = (reference: NormalizedReference): void => {
    const key = `${referenceKey(reference)}${reference.periodCode}`;
    const existing = referenceByKey.get(key);
    if (!existing) {
      referenceByKey.set(key, reference);
      return;
    }
    existing.employeesReported = existing.employeesReported ?? reference.employeesReported;
    existing.roomsAvailableReported = existing.roomsAvailableReported ?? reference.roomsAvailableReported;
    existing.netSalesReported = existing.netSalesReported ?? reference.netSalesReported;
    warnings.push(`referencia repetida para ${referenceKey(reference)} · ${reference.periodCode} (líneas ${existing.line} y ${reference.line}); se conserva la primera`);
  };

  if (Array.isArray(data.lineas)) {
    data.lineas.forEach((item, index) => {
      const line = index + 1;
      try {
        if (!isRecord(item)) throw new PayrollCostParseError("la línea no es un objeto");
        const workCenterLabel = parseLabel(item.centro, "centro");
        const centreCodeHint = typeof item.centroCode === "string" && item.centroCode.trim() ? item.centroCode.trim().toUpperCase() : null;
        if (centreCodeHint) result.hints.centreCodes[workCenterLabel] = result.hints.centreCodes[workCenterLabel] ?? centreCodeHint;
        const periodCode = parseMonth(item.mes);
        const costGroup = parseLabel(item.grupo, "grupo");
        const departmentLabel = parseLabel(item.departamento, "departamento");
        for (const [key, value] of [["salarioBruto", item.salarioBruto], ["costeSs", item.costeSs], ["costeTotal", item.costeTotal]] as const) {
          if (isAmbiguousThousands(value)) ambiguous.push(`lineas[${index}] (${key} «${String(value).trim()}»)`);
        }
        const gross = parseAmount(item.salarioBruto, "salarioBruto");
        const employerSs = parseAmount(item.costeSs, "costeSs");
        const reportedTotalCost = optionalAmount(item.costeTotal, "costeTotal");
        const headcount = isBlank(item.empleados) ? ZERO : parseAmount(item.empleados, "empleados", PAYROLL_COST_HEADCOUNT_MAX);
        const usaliRaw = typeof item.usaliDepartment === "string" ? foldLabel(item.usaliDepartment) : "";
        const row: NormalizedRow = {
          line,
          workCenterLabel,
          centreCodeHint,
          periodCode,
          costGroup,
          departmentLabel,
          usaliDepartmentHint: usaliRaw || null,
          gross,
          employerSs,
          totalCost: gross.plus(employerSs),
          reportedTotalCost,
          headcount,
          netSalesReported: null,
          roomsAvailableReported: null
        };
        const warning = reportedTotalWarning(row);
        if (warning) warnings.push(warning);
        parsedRows.push(row);
      } catch (error) {
        errors.push({ line, message: `lineas[${index}]: ${error instanceof Error ? error.message : String(error)}` });
      }
    });
    // Etiqueta única por código (para que la referencia por centroCode hashee igual que la del CSV equivalente).
    const labelsByCode = new Map<string, Set<string>>();
    for (const [label, code] of Object.entries(result.hints.centreCodes)) {
      const set = labelsByCode.get(code) ?? new Set<string>();
      set.add(label);
      labelsByCode.set(code, set);
    }
    if (Array.isArray(data.referencia)) {
      data.referencia.forEach((item, index) => {
        const line = index + 1;
        try {
          if (!isRecord(item)) throw new PayrollCostParseError("la referencia no es un objeto");
          const centreCodeHint = typeof item.centroCode === "string" && item.centroCode.trim() ? item.centroCode.trim().toUpperCase() : null;
          const explicitLabel = isBlank(item.centro) ? "" : parseLabel(item.centro, "centro");
          const labels = centreCodeHint ? labelsByCode.get(centreCodeHint) : undefined;
          const workCenterLabel = explicitLabel || (labels && labels.size === 1 ? Array.from(labels)[0]! : null);
          if (!centreCodeHint && !workCenterLabel) throw new PayrollCostParseError("centroCode vacío");
          addReference({
            line,
            workCenterLabel,
            centreCodeHint,
            periodCode: parseMonth(item.mes),
            employeesReported: isBlank(item.empleadosInforme) ? null : parseAmount(item.empleadosInforme, "empleadosInforme", PAYROLL_COST_HEADCOUNT_MAX),
            roomsAvailableReported: parseRoomsInventory(item.habitacionesDisponibles),
            netSalesReported: optionalAmount(item.ventasSinIva, "ventasSinIva")
          });
        } catch (error) {
          errors.push({ line, message: `referencia[${index}]: ${error instanceof Error ? error.message : String(error)}` });
        }
      });
    }
  } else if (Array.isArray(data.rows)) {
    data.rows.forEach((item, index) => {
      const line = index + 1;
      try {
        if (!isRecord(item)) throw new PayrollCostParseError("la fila no es un objeto");
        const workCenterLabel = parseLabel(item.workCenterLabel, "workCenterLabel");
        const centreCodeHint = typeof item.workCenterCode === "string" && item.workCenterCode.trim() ? item.workCenterCode.trim().toUpperCase() : null;
        if (centreCodeHint) result.hints.centreCodes[workCenterLabel] = result.hints.centreCodes[workCenterLabel] ?? centreCodeHint;
        const periodCode = parseMonth(item.periodCode);
        const costGroup = parseLabel(item.costGroup, "costGroup");
        const departmentLabel = parseLabel(item.departmentLabel, "departmentLabel");
        for (const [key, value] of [["gross", item.gross], ["employerSs", item.employerSs], ["reportedTotalCost", item.reportedTotalCost], ["netSalesReported", item.netSalesReported]] as const) {
          if (isAmbiguousThousands(value)) ambiguous.push(`rows[${index}] (${key} «${String(value).trim()}»)`);
        }
        const gross = parseAmount(item.gross, "gross");
        const employerSs = parseAmount(item.employerSs, "employerSs");
        const reportedTotalCost = optionalAmount(item.reportedTotalCost, "reportedTotalCost");
        const headcount = isBlank(item.headcount) ? ZERO : parseAmount(item.headcount, "headcount", PAYROLL_COST_HEADCOUNT_MAX);
        const usaliRaw = typeof item.usaliDepartment === "string" ? foldLabel(item.usaliDepartment) : "";
        const netSalesReported = optionalAmount(item.netSalesReported, "netSalesReported");
        const roomsAvailableReported = parseRoomsInventory(item.roomsAvailableReported);
        const employeesReported = isBlank(item.employeesReported) ? null : parseAmount(item.employeesReported, "employeesReported", PAYROLL_COST_HEADCOUNT_MAX);
        const row: NormalizedRow = {
          line,
          workCenterLabel,
          centreCodeHint,
          periodCode,
          costGroup,
          departmentLabel,
          usaliDepartmentHint: usaliRaw || null,
          gross,
          employerSs,
          totalCost: gross.plus(employerSs),
          reportedTotalCost,
          headcount,
          netSalesReported,
          roomsAvailableReported
        };
        const warning = reportedTotalWarning(row);
        if (warning) warnings.push(warning);
        parsedRows.push(row);
        if (netSalesReported !== null || roomsAvailableReported !== null || employeesReported !== null) {
          addReference({ line, workCenterLabel, centreCodeHint: null, periodCode, employeesReported, roomsAvailableReported, netSalesReported });
        }
      } catch (error) {
        errors.push({ line, message: `rows[${index}]: ${error instanceof Error ? error.message : String(error)}` });
      }
    });
  } else {
    errors.push({ line: null, message: "El JSON debe contener «lineas» (informe de RRHH) o «rows» (PayrollCostRowDto[])." });
    return result;
  }
  // Las referencias repetidas ya se avisan en addReference; aquí solo se fusionan filas de coste.
  const refWarnings = warnings.filter((w) => w.startsWith("referencia repetida")).length;
  const ambiguousWarning = ambiguousAmountsWarning(ambiguous);
  if (ambiguousWarning) warnings.push(ambiguousWarning);
  result.rows = aggregateRows(parsedRows, warnings);
  if (refWarnings > 3) warnings.push(`${refWarnings} referencias repetidas en total`);
  result.references = Array.from(referenceByKey.values());
  return result;
}

// ---------------------------------------------------------------------------
// Entrada única
// ---------------------------------------------------------------------------

export function parsePayrollCostContent(input: { format: PayrollCostImportFormat; content: string }): PayrollCostParseResult {
  const content = typeof input.content === "string" ? input.content : "";
  if (input.format === "json") return parseJson(content);
  return parseCsv(content);
}

// ---------------------------------------------------------------------------
// Diccionario de departamentos (diseño §6): etiqueta del informe → USALI
// ---------------------------------------------------------------------------

/**
 * Se aplica sobre la etiqueta sin prefijo numérico («3 RECEPCIO» → «RECEPCIO»),
 * sin acentos y en mayúsculas, por orden. RECEP* / PISOS / SIN DEPARTAMENTO →
 * rooms; CAF* / REST* / COCINA → fnb; MANTENIM* → pom; DIRECCI* /
 * ADMINISTRACION / PROPIEDAD → admin_general; COMERCIAL → sales_marketing.
 */
export const DEFAULT_DEPARTMENT_MAP: ReadonlyArray<{ pattern: RegExp; department: PayrollCostUsaliDepartment }> = [
  { pattern: /^RECEP/, department: "rooms" },
  { pattern: /^PISOS\b/, department: "rooms" },
  { pattern: /^SIN DEPARTAMENTO\b/, department: "rooms" },
  { pattern: /^CAF/, department: "fnb" },
  { pattern: /^REST/, department: "fnb" },
  { pattern: /^COCINA\b/, department: "fnb" },
  { pattern: /^MANTENIM/, department: "pom" },
  { pattern: /^DIRECCI/, department: "admin_general" },
  { pattern: /^ADMINISTRACION\b/, department: "admin_general" },
  { pattern: /^PROPIEDAD\b/, department: "admin_general" },
  { pattern: /^COMERCIAL\b/, department: "sales_marketing" }
];

/** Departamento USALI del diccionario para una etiqueta del informe, o null. */
export function defaultDepartmentFor(label: string): PayrollCostUsaliDepartment | null {
  const folded = foldLabel(label).toUpperCase().replace(/^\d+[\s.\-_]*/, "").trim();
  for (const entry of DEFAULT_DEPARTMENT_MAP) {
    if (entry.pattern.test(folded)) return entry.department;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Mapeo (puro): centros, departamentos y grupos → plan por celda (centro, mes)
// ---------------------------------------------------------------------------

export type PayrollCostPlanProperty = {
  id: string;
  code: string | null;
  name: string;
  tradeName?: string | null;
  kind: PropertyKind;
};

export type PayrollCostPlanRow = {
  line: number;
  workCenterLabel: string;
  centreCodeHint: string | null;
  propertyId: string | null;
  periodCode: string;
  /** Etiqueta original del grupo (normalizada). */
  costGroupLabel: string;
  costGroup: PayrollCostGroup | null;
  departmentLabel: string;
  usaliDepartment: PayrollCostUsaliDepartment | null;
  gross: Dec;
  employerSs: Dec;
  totalCost: Dec;
  reportedTotalCost: Dec | null;
  headcount: Dec;
  netSalesReported: Dec | null;
  roomsAvailableReported: number | null;
};

export type PayrollCostPlanReference = {
  propertyId: string;
  workCenterLabel: string | null;
  periodCode: string;
  employeesReported: Dec | null;
  roomsAvailableReported: number | null;
  netSalesReported: Dec | null;
};

export type PayrollCostPlanCell = {
  propertyId: string;
  periodCode: string;
  workCenterLabels: string[];
  rows: PayrollCostPlanRow[];
  /** Parejas D 640 / D 642 del asiento, ordenadas por clave USALI. */
  departments: Array<{ usaliDepartment: PayrollCostUsaliDepartment; gross: Dec; employerSs: Dec }>;
};

export type PayrollCostPlan = {
  rows: PayrollCostPlanRow[];
  /** Una por (centro, mes) mapeado; varias etiquetas del mismo centro se suman (aviso). */
  references: PayrollCostPlanReference[];
  /** Solo filas completamente mapeadas, agrupadas por (centro, mes). */
  cells: PayrollCostPlanCell[];
  /** Mapeo efectivo (explícito + resuelto): lo que se guarda en `mappingJson`. */
  mapping: Required<PayrollCostMapping>;
  unmappedCentres: PayrollCostUnmappedLabel[];
  unmappedDepartments: PayrollCostUnmappedLabel[];
  unmappedGroups: PayrollCostUnmappedLabel[];
  /** Departamentos resueltos que no admiten la línea `labor` (400 USALI_LINE_NOT_ADMITTED). */
  notAdmitted: Array<{ department: string; labels: string[] }>;
  /** Centros del ERP que toca el plan (orden de aparición). */
  propertyIds: string[];
  periodFrom: string | null;
  periodTo: string | null;
  warnings: string[];
  /** Sin etiquetas pendientes ni departamentos no admitidos. */
  complete: boolean;
};

const STOP_WORDS = new Set(["hotel", "hostal", "oficina", "de", "del", "la", "el", "los", "las", "y", "en", "sa", "sl", "central", "apartamentos", "apartahotel"]);
/** Departamentos USALI operativos (rooms, fnb, other_operated): un centro `office` no los explota. */
const OPERATING_DEPARTMENTS: ReadonlySet<string> = new Set(["rooms", "fnb", "other_operated"]);

function tokens(value: string): string[] {
  return foldLabel(value)
    .split(/[^a-z0-9ñ]+/)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

/** Candidatos del ERP para una etiqueta sin mapear: inclusión de texto o tokens comunes en code / name / tradeName. */
export function suggestCentres(label: string, properties: readonly PayrollCostPlanProperty[], limit = 5): PayrollCostCentreSuggestion[] {
  const folded = foldLabel(label);
  if (!folded) return [];
  const labelTokens = new Set(tokens(label));
  // Solo palabras vacías («HOTEL», «OFICINA») o demasiado cortas: sugerir todos los centros sería ruido.
  if (labelTokens.size === 0) return [];
  const scored: Array<{ score: number; property: PayrollCostPlanProperty }> = [];
  for (const property of properties) {
    const candidates = [property.code ?? "", property.name, property.tradeName ?? ""].map(foldLabel).filter(Boolean);
    let score = 0;
    for (const candidate of candidates) {
      if (candidate === folded) score = Math.max(score, 100);
      else if (candidate.length >= 3 && (candidate.includes(folded) || folded.includes(candidate))) score = Math.max(score, 50);
      else {
        const shared = tokens(candidate).filter((token) => labelTokens.has(token)).length;
        if (shared > 0) score = Math.max(score, 10 * shared);
      }
    }
    if (score > 0) scored.push({ score, property });
  }
  scored.sort((a, b) => b.score - a.score || a.property.name.localeCompare(b.property.name));
  return scored.slice(0, limit).map(({ property }) => ({ propertyId: property.id, code: property.code ?? null, name: property.name, kind: property.kind }));
}

function unmappedList(map: Map<string, number>, suggestionsFor?: (label: string) => PayrollCostCentreSuggestion[]): PayrollCostUnmappedLabel[] {
  return Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([label, rows]) => ({ label, rows, suggestions: suggestionsFor ? suggestionsFor(label) : [] }));
}

export function applyPayrollCostMapping(
  parsed: Pick<PayrollCostParseResult, "rows" | "references" | "hints">,
  input: { mapping?: PayrollCostMapping | null; properties: readonly PayrollCostPlanProperty[] }
): PayrollCostPlan {
  const warnings: string[] = [];
  const mapping = input.mapping ?? {};
  const explicitCentres = new Map<string, string>();
  for (const [label, propertyId] of Object.entries(mapping.centres ?? {})) {
    if (typeof propertyId === "string" && propertyId.trim()) explicitCentres.set(normalizeLabel(label), propertyId.trim());
  }
  const explicitDepartments = new Map<string, string>();
  for (const [label, department] of Object.entries(mapping.departments ?? {})) {
    if (typeof department === "string" && department.trim()) explicitDepartments.set(normalizeLabel(label), foldLabel(department));
  }
  const explicitGroups = new Map<string, string>();
  for (const [label, group] of Object.entries(mapping.groups ?? {})) {
    if (typeof group === "string" && group.trim()) explicitGroups.set(normalizeLabel(label), String(group));
  }

  const byCode = new Map<string, PayrollCostPlanProperty>();
  const byFoldedName = new Map<string, PayrollCostPlanProperty>();
  const byId = new Map<string, PayrollCostPlanProperty>(input.properties.map((property) => [property.id, property]));
  for (const property of input.properties) {
    if (property.code) byCode.set(property.code.trim().toUpperCase(), property);
    for (const candidate of [property.code ?? "", property.name, property.tradeName ?? ""]) {
      const folded = foldLabel(candidate);
      if (folded && !byFoldedName.has(folded)) byFoldedName.set(folded, property);
    }
  }

  const centreCache = new Map<string, string | null>();
  const resolveCentre = (label: string, codeHint: string | null): string | null => {
    const cacheKey = `${label}${codeHint ?? ""}`;
    const cached = centreCache.get(cacheKey);
    if (cached !== undefined) return cached;
    let propertyId: string | null = null;
    const explicit = explicitCentres.get(label);
    if (explicit) propertyId = explicit;
    else {
      const code = codeHint ?? parsed.hints.centreCodes[label] ?? null;
      const byHint = code ? byCode.get(code.toUpperCase()) : undefined;
      if (byHint) propertyId = byHint.id;
      else {
        const byName = byFoldedName.get(foldLabel(label));
        if (byName) propertyId = byName.id;
      }
    }
    centreCache.set(cacheKey, propertyId);
    return propertyId;
  };

  const departmentCache = new Map<string, { department: PayrollCostUsaliDepartment | null; notAdmitted: string | null }>();
  const resolveDepartment = (label: string, hint: string | null): { department: PayrollCostUsaliDepartment | null; notAdmitted: string | null } => {
    const cacheKey = `${label}${hint ?? ""}`;
    const cached = departmentCache.get(cacheKey);
    if (cached) return cached;
    let candidate: string | null = explicitDepartments.get(label) ?? null;
    if (!candidate && hint) candidate = hint;
    if (!candidate) candidate = defaultDepartmentFor(label);
    let resolved: { department: PayrollCostUsaliDepartment | null; notAdmitted: string | null };
    if (!candidate) resolved = { department: null, notAdmitted: null };
    else if (isLaborDepartment(candidate) && isAdmittedUsali(candidate, "labor")) resolved = { department: candidate, notAdmitted: null };
    else if (isUsaliDepartment(candidate)) resolved = { department: null, notAdmitted: candidate };
    else {
      warnings.push(`departamento «${label}»: «${candidate}» no es un departamento USALI (${PAYROLL_COST_USALI_DEPARTMENTS.join(", ")})`);
      resolved = { department: null, notAdmitted: null };
    }
    departmentCache.set(cacheKey, resolved);
    return resolved;
  };

  const resolveGroup = (label: string): PayrollCostGroup | null => {
    const explicit = explicitGroups.get(label);
    if (explicit !== undefined) {
      const canonical = canonicalGroup(explicit);
      if (canonical) return canonical;
      warnings.push(`mapping.groups: «${label}» → «${explicit}» no es un grupo canónico; se ignora`);
    }
    return parsed.hints.groups[label] ?? canonicalGroup(label);
  };

  const unmappedCentres = new Map<string, number>();
  const unmappedDepartments = new Map<string, number>();
  const unmappedGroups = new Map<string, number>();
  const notAdmittedMap = new Map<string, Set<string>>();
  const effective: Required<PayrollCostMapping> = { centres: {}, departments: {}, groups: {} };

  const mappedRows: PayrollCostPlanRow[] = [];
  for (const row of parsed.rows) {
    const propertyId = resolveCentre(row.workCenterLabel, row.centreCodeHint);
    if (propertyId) effective.centres[row.workCenterLabel] = propertyId;
    else unmappedCentres.set(row.workCenterLabel, (unmappedCentres.get(row.workCenterLabel) ?? 0) + 1);

    const department = resolveDepartment(row.departmentLabel, row.usaliDepartmentHint);
    if (department.department) effective.departments[row.departmentLabel] = department.department;
    else if (department.notAdmitted) {
      const set = notAdmittedMap.get(department.notAdmitted) ?? new Set<string>();
      set.add(row.departmentLabel);
      notAdmittedMap.set(department.notAdmitted, set);
    } else unmappedDepartments.set(row.departmentLabel, (unmappedDepartments.get(row.departmentLabel) ?? 0) + 1);

    const group = resolveGroup(row.costGroup);
    if (group) effective.groups[row.costGroup] = group;
    else unmappedGroups.set(row.costGroup, (unmappedGroups.get(row.costGroup) ?? 0) + 1);

    mappedRows.push({
      line: row.line,
      workCenterLabel: row.workCenterLabel,
      centreCodeHint: row.centreCodeHint,
      propertyId,
      periodCode: row.periodCode,
      costGroupLabel: row.costGroup,
      costGroup: group,
      departmentLabel: row.departmentLabel,
      usaliDepartment: department.department,
      gross: row.gross,
      employerSs: row.employerSs,
      totalCost: row.totalCost,
      reportedTotalCost: row.reportedTotalCost,
      headcount: row.headcount,
      netSalesReported: row.netSalesReported,
      roomsAvailableReported: row.roomsAvailableReported
    });
  }

  // Dos etiquetas de grupo que van al mismo canónico («mant-obra» y «mantenimiento_obra») colisionarían en la clave única de la línea: se fusionan.
  const fused = new Map<string, { row: PayrollCostPlanRow; lines: number[] }>();
  for (const row of mappedRows) {
    const key = [row.workCenterLabel, row.periodCode, row.costGroup ?? row.costGroupLabel, row.departmentLabel].join("");
    const existing = fused.get(key);
    if (!existing) {
      fused.set(key, { row, lines: [row.line] });
      continue;
    }
    const merged = existing.row;
    merged.line = 0;
    merged.gross = merged.gross.plus(row.gross);
    merged.employerSs = merged.employerSs.plus(row.employerSs);
    merged.totalCost = merged.gross.plus(merged.employerSs);
    merged.reportedTotalCost = merged.reportedTotalCost || row.reportedTotalCost ? (merged.reportedTotalCost ?? ZERO).plus(row.reportedTotalCost ?? ZERO) : null;
    merged.headcount = merged.headcount.plus(row.headcount);
    existing.lines.push(row.line);
  }
  const rows = Array.from(fused.values(), (entry) => {
    if (entry.lines.length > 1) warnings.push(`filas ${entry.lines.join(" y ")} fusionadas (mismo grupo canónico ${entry.row.costGroup} en ${entry.row.workCenterLabel} · ${entry.row.periodCode} · ${entry.row.departmentLabel})`);
    return entry.row;
  });

  // Celdas (centro, mes) con las filas completamente mapeadas.
  const cellMap = new Map<string, PayrollCostPlanCell>();
  const propertyIds: string[] = [];
  for (const row of rows) {
    if (!row.propertyId || !row.usaliDepartment || !row.costGroup) continue;
    if (!propertyIds.includes(row.propertyId)) propertyIds.push(row.propertyId);
    const key = `${row.propertyId}${row.periodCode}`;
    let cell = cellMap.get(key);
    if (!cell) {
      cell = { propertyId: row.propertyId, periodCode: row.periodCode, workCenterLabels: [], rows: [], departments: [] };
      cellMap.set(key, cell);
    }
    cell.rows.push(row);
    if (!cell.workCenterLabels.includes(row.workCenterLabel)) cell.workCenterLabels.push(row.workCenterLabel);
    let department = cell.departments.find((d) => d.usaliDepartment === row.usaliDepartment);
    if (!department) {
      department = { usaliDepartment: row.usaliDepartment, gross: ZERO, employerSs: ZERO };
      cell.departments.push(department);
    }
    department.gross = department.gross.plus(row.gross);
    department.employerSs = department.employerSs.plus(row.employerSs);
  }
  const cells = Array.from(cellMap.values()).sort((a, b) => a.periodCode.localeCompare(b.periodCode) || a.propertyId.localeCompare(b.propertyId));
  for (const cell of cells) cell.departments.sort((a, b) => a.usaliDepartment.localeCompare(b.usaliDepartment));

  // Personal de una oficina enrutado a un departamento USALI operativo (contable-6C-06): aviso por
  // (centro, departamento) — el dato se respeta, pero «OFICINA · RECEPCION → rooms» suele ser admin_general.
  const officeOperating = new Map<string, string>();
  for (const row of rows) {
    if (!row.propertyId || !row.usaliDepartment) continue;
    const property = byId.get(row.propertyId);
    if (property?.kind !== "office" || !OPERATING_DEPARTMENTS.has(row.usaliDepartment)) continue;
    const key = `${row.workCenterLabel}${SEP}${row.departmentLabel}${SEP}${row.usaliDepartment}`;
    if (!officeOperating.has(key)) officeOperating.set(key, `centro «${row.workCenterLabel}» es una oficina y su departamento «${row.departmentLabel}» va al departamento USALI operativo ${row.usaliDepartment}; el personal de oficina suele ir a admin_general (mapping.departments o columna usali)`);
  }
  warnings.push(...officeOperating.values());

  // Referencias por (centro, mes): varias etiquetas del mismo centro se suman con aviso.
  const referenceMap = new Map<string, PayrollCostPlanReference & { labels: string[] }>();
  for (const reference of parsed.references) {
    let propertyId: string | null = null;
    if (reference.workCenterLabel) propertyId = resolveCentre(reference.workCenterLabel, reference.centreCodeHint);
    if (!propertyId && reference.centreCodeHint) propertyId = byCode.get(reference.centreCodeHint.toUpperCase())?.id ?? null;
    if (!propertyId) {
      if (reference.centreCodeHint && !reference.workCenterLabel) warnings.push(`referencia ${reference.centreCodeHint} · ${reference.periodCode}: código de centro sin correspondencia en el ERP; se ignora`);
      continue;
    }
    const key = `${propertyId}${reference.periodCode}`;
    const label = reference.workCenterLabel ?? reference.centreCodeHint ?? "";
    const existing = referenceMap.get(key);
    if (!existing) {
      referenceMap.set(key, { propertyId, workCenterLabel: reference.workCenterLabel, periodCode: reference.periodCode, employeesReported: reference.employeesReported, roomsAvailableReported: reference.roomsAvailableReported, netSalesReported: reference.netSalesReported, labels: [label] });
      continue;
    }
    existing.labels.push(label);
    existing.employeesReported = existing.employeesReported || reference.employeesReported ? (existing.employeesReported ?? ZERO).plus(reference.employeesReported ?? ZERO) : null;
    existing.roomsAvailableReported = existing.roomsAvailableReported !== null || reference.roomsAvailableReported !== null ? (existing.roomsAvailableReported ?? 0) + (reference.roomsAvailableReported ?? 0) : null;
    existing.netSalesReported = existing.netSalesReported || reference.netSalesReported ? (existing.netSalesReported ?? ZERO).plus(reference.netSalesReported ?? ZERO) : null;
    existing.workCenterLabel = null;
  }
  const references: PayrollCostPlanReference[] = [];
  for (const reference of referenceMap.values()) {
    if (reference.labels.length > 1) warnings.push(`referencias de ${reference.labels.join(" + ")} sumadas en el mismo centro para ${reference.periodCode}`);
    const { labels: _labels, ...rest } = reference;
    references.push(rest);
  }
  references.sort((a, b) => a.periodCode.localeCompare(b.periodCode) || a.propertyId.localeCompare(b.propertyId));

  const months = rows.map((row) => row.periodCode).sort();
  const notAdmitted = Array.from(notAdmittedMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([department, labels]) => ({ department, labels: Array.from(labels).sort() }));
  const unmappedCentresList = unmappedList(unmappedCentres, (label) => suggestCentres(label, input.properties));
  const unmappedDepartmentsList = unmappedList(unmappedDepartments);
  const unmappedGroupsList = unmappedList(unmappedGroups);
  return {
    rows,
    references,
    cells,
    mapping: effective,
    unmappedCentres: unmappedCentresList,
    unmappedDepartments: unmappedDepartmentsList,
    unmappedGroups: unmappedGroupsList,
    notAdmitted,
    propertyIds,
    periodFrom: months[0] ?? null,
    periodTo: months[months.length - 1] ?? null,
    warnings,
    complete: unmappedCentresList.length === 0 && unmappedDepartmentsList.length === 0 && unmappedGroupsList.length === 0 && notAdmitted.length === 0
  };
}
