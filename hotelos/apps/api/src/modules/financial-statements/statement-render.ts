// Renders a statement (the wire JSON) into tables, and tables into PDF /
// XLSX / CSV bytes. The same functions serve live statements and stored
// snapshots (a snapshot is rendered from its saved json, never recomputed).

import type {
  AnnualAccounts,
  PgcBalanceSheet,
  PgcEquityChanges,
  PgcMemoria,
  PgcProfitAndLoss,
  StatementLine,
  UsaliPeriodComparison,
  UsaliPnl,
  UsaliPropertyComparison
} from "../../../../../packages/shared/src/financial-statements-types.js";
import { csvBlocks, type CsvCell } from "./csv.js";
import { decimalComma } from "./money.js";
import { renderPdfReport, type PdfRow, type PdfTable } from "./pdf-writer.js";
import { writeXlsx, type XlsxCell, type XlsxSheet } from "./xlsx-writer.js";

export type RenderColumn = { label: string; width: number; align: "left" | "right" };
export type RenderRow = PdfRow;
export type RenderTable = { title: string; columns: RenderColumn[]; rows: RenderRow[] };
export type RenderDocument = { title: string; subtitle: string; entity?: string; landscape?: boolean; tables: RenderTable[] };

const NUMBER_RE = /^-?\d+(\.\d+)?$/;
const dash = (value: string | null | undefined): string => (value === null || value === undefined ? "—" : value);

// ---------------------------------------------------------------------------
// Statement → tables
// ---------------------------------------------------------------------------

function linesRows(lines: StatementLine[], withPrevious: boolean, detail: boolean): RenderRow[] {
  const rows: RenderRow[] = [];
  for (const line of lines) {
    const cells = [line.label, line.amount];
    if (withPrevious) cells.push(dash(line.previousAmount));
    rows.push({ cells, style: line.level === 0 ? "section" : "normal", indent: line.level });
    if (detail) {
      for (const account of line.accounts) {
        const sub = [`${account.code} · ${account.name}`, account.amount];
        if (withPrevious) sub.push("");
        rows.push({ cells: sub, style: "sub", indent: line.level + 1 });
      }
    }
  }
  return rows;
}

export function balanceTables(balance: PgcBalanceSheet, detail = true): RenderTable[] {
  const withPrevious = balance.assets.nonCurrent.some((l) => l.previousAmount !== undefined) || balance.equity.lines.some((l) => l.previousAmount !== undefined);
  const columns: RenderColumn[] = [
    { label: "Epígrafe", width: withPrevious ? 315 : 395, align: "left" },
    { label: `Ejercicio (${balance.asOf})`, width: 100, align: "right" }
  ];
  if (withPrevious) columns.push({ label: "Ejercicio anterior", width: 100, align: "right" });
  const pad = (cells: string[]): string[] => (withPrevious ? [...cells, ""] : cells);
  const total = (label: string, amount: string): RenderRow => ({ cells: pad([label, amount]), style: "total" });
  const activo: RenderRow[] = [
    { cells: pad(["A) ACTIVO NO CORRIENTE", balance.assets.totalNonCurrent]), style: "section" },
    ...linesRows(balance.assets.nonCurrent, withPrevious, detail),
    { cells: pad(["B) ACTIVO CORRIENTE", balance.assets.totalCurrent]), style: "section" },
    ...linesRows(balance.assets.current, withPrevious, detail),
    total("TOTAL ACTIVO (A + B)", balance.totalAssets)
  ];
  const pasivo: RenderRow[] = [
    { cells: pad(["A) PATRIMONIO NETO", balance.equity.total]), style: "section" },
    ...linesRows(balance.equity.lines, withPrevious, detail),
    { cells: pad(["B) PASIVO NO CORRIENTE", balance.liabilities.totalNonCurrent]), style: "section" },
    ...linesRows(balance.liabilities.nonCurrent, withPrevious, detail),
    { cells: pad(["C) PASIVO CORRIENTE", balance.liabilities.totalCurrent]), style: "section" },
    ...linesRows(balance.liabilities.current, withPrevious, detail),
    total("TOTAL PATRIMONIO NETO Y PASIVO (A + B + C)", balance.totalEquityAndLiabilities),
    { cells: pad([balance.balanced ? "Cuadre: activo = patrimonio neto + pasivo" : "ATENCIÓN: el balance no cuadra", balance.balanced ? "OK" : "KO"]), style: "sub" }
  ];
  const tables: RenderTable[] = [
    { title: "ACTIVO", columns, rows: activo },
    { title: "PATRIMONIO NETO Y PASIVO", columns, rows: pasivo }
  ];
  if (balance.warnings.length > 0) {
    tables.push({ title: "Avisos", columns: [{ label: "Aviso", width: 495, align: "left" }], rows: balance.warnings.map((w) => ({ cells: [w], style: "sub" })) });
  }
  return tables;
}

export function pygTables(pyg: PgcProfitAndLoss, detail = true): RenderTable[] {
  const withPrevious = pyg.lines.some((l) => l.previousAmount !== undefined);
  const columns: RenderColumn[] = [
    { label: "Partida", width: withPrevious ? 315 : 395, align: "left" },
    { label: `Ejercicio (${pyg.period.from} a ${pyg.period.to})`, width: 100, align: "right" }
  ];
  if (withPrevious) columns.push({ label: "Ejercicio anterior", width: 100, align: "right" });
  const pad = (cells: string[]): string[] => (withPrevious ? [...cells, ""] : cells);
  const rows: RenderRow[] = [];
  const operating = pyg.lines.filter((l) => /^P(1[0-2]|[1-9]|19)$/.test(l.id));
  const financial = pyg.lines.filter((l) => /^P1[3-7]$/.test(l.id));
  const tax = pyg.lines.filter((l) => l.id === "P18");
  rows.push(...linesRows(operating, withPrevious, detail));
  rows.push({ cells: pad(["A) RESULTADO DE EXPLOTACIÓN", pyg.operatingResult]), style: "total" });
  rows.push(...linesRows(financial, withPrevious, detail));
  rows.push({ cells: pad(["B) RESULTADO FINANCIERO", pyg.financialResult]), style: "total" });
  rows.push({ cells: pad(["C) RESULTADO ANTES DE IMPUESTOS (A + B)", pyg.resultBeforeTax]), style: "total" });
  rows.push(...linesRows(tax, withPrevious, detail));
  rows.push({ cells: pad(["D) RESULTADO DEL EJERCICIO (C + 18)", pyg.netResult]), style: "total" });
  rows.push({ cells: pad(["Comprobación: ingresos − gastos", pyg.netResult]), style: "sub" });
  rows.push({ cells: pad(["  Σ ingresos (7xx)", pyg.revenueTotal]), style: "sub" });
  rows.push({ cells: pad(["  Σ gastos (6xx)", pyg.expenseTotal]), style: "sub" });
  const tables: RenderTable[] = [{ title: "CUENTA DE PÉRDIDAS Y GANANCIAS (PGC Pymes)", columns, rows }];
  if (pyg.warnings.length > 0) {
    tables.push({ title: "Avisos", columns: [{ label: "Aviso", width: 495, align: "left" }], rows: pyg.warnings.map((w) => ({ cells: [w], style: "sub" })) });
  }
  return tables;
}

export function ecpnTables(ecpn: PgcEquityChanges): RenderTable[] {
  const a: RenderTable = {
    title: "A) ESTADO DE INGRESOS Y GASTOS RECONOCIDOS",
    columns: [
      { label: "Concepto", width: 395, align: "left" },
      { label: "Importe", width: 100, align: "right" }
    ],
    rows: [
      { cells: ["A) Resultado de la cuenta de pérdidas y ganancias", ecpn.recognisedIncomeAndExpense.periodResult], style: "section" },
      ...ecpn.recognisedIncomeAndExpense.directlyToEquity.map((l) => ({ cells: [l.label, l.amount], style: "normal" as const, indent: 1 })),
      ...ecpn.recognisedIncomeAndExpense.transfersToPnl.map((l) => ({ cells: [l.label, l.amount], style: "normal" as const, indent: 1 })),
      { cells: ["TOTAL DE INGRESOS Y GASTOS RECONOCIDOS", ecpn.recognisedIncomeAndExpense.total], style: "total" }
    ]
  };
  const b: RenderTable = {
    title: "B) ESTADO TOTAL DE CAMBIOS EN EL PATRIMONIO NETO",
    columns: [{ label: "Concepto", width: 210, align: "left" }, ...ecpn.columns.map((c) => ({ label: c.label, width: 64, align: "right" as const }))],
    rows: ecpn.rows.map((row) => ({
      cells: [row.label, ...ecpn.columns.map((c) => row.values[c.key])],
      style: row.level === 0 ? ("total" as const) : ("normal" as const),
      indent: row.level
    }))
  };
  const tables = [a, b];
  if (ecpn.warnings.length > 0) {
    tables.push({ title: "Avisos", columns: [{ label: "Aviso", width: 700, align: "left" }], rows: ecpn.warnings.map((w) => ({ cells: [w], style: "sub" as const })) });
  }
  return tables;
}

function figuresRows(figures: Record<string, unknown>, prefix = ""): RenderRow[] {
  const rows: RenderRow[] = [];
  for (const [key, value] of Object.entries(figures)) {
    const label = prefix ? `${prefix}.${key}` : key;
    if (value === null || value === undefined) rows.push({ cells: [label, "—"], style: "sub" });
    else if (Array.isArray(value)) {
      rows.push({ cells: [label, `${value.length} filas`], style: "sub" });
      value.slice(0, 200).forEach((item, index) => {
        if (item && typeof item === "object") rows.push(...figuresRows(item as Record<string, unknown>, `${label}[${index}]`));
        else rows.push({ cells: [`${label}[${index}]`, String(item)], style: "sub" });
      });
    } else if (typeof value === "object") rows.push(...figuresRows(value as Record<string, unknown>, label));
    else rows.push({ cells: [label, String(value)], style: "sub" });
  }
  return rows;
}

export function memoriaTables(memoria: PgcMemoria): RenderTable[] {
  const columns: RenderColumn[] = [
    { label: "Concepto", width: 315, align: "left" },
    { label: "Dato", width: 180, align: "right" }
  ];
  const tables: RenderTable[] = [
    {
      title: "Identificación",
      columns,
      rows: [
        { cells: ["Entidad", memoria.entity.legalName ?? memoria.entity.name], style: "normal" },
        { cells: ["NIF", memoria.entity.taxId ?? "—"], style: "normal" },
        { cells: ["Periodo", `${memoria.period.from} a ${memoria.period.to}`], style: "normal" },
        ...memoria.entity.properties.map((p) => ({ cells: [`Establecimiento · ${p.name}`, p.address ?? "—"], style: "sub" as const }))
      ]
    }
  ];
  for (const note of memoria.notes) {
    tables.push({
      title: `${note.number}. ${note.title}${note.status === "requires_input" ? " (pendiente de cumplimentar)" : ""}`,
      columns,
      rows: [{ cells: [note.text, ""], style: "normal" }, ...figuresRows(note.figures)]
    });
  }
  if (memoria.warnings.length > 0) {
    tables.push({ title: "Avisos", columns: [{ label: "Aviso", width: 495, align: "left" }], rows: memoria.warnings.map((w) => ({ cells: [w], style: "sub" })) });
  }
  return tables;
}

export function usaliTables(pnl: UsaliPnl, detail = true): RenderTable[] {
  const columns: RenderColumn[] = [
    { label: "Línea", width: 255, align: "left" },
    { label: "Importe", width: 80, align: "right" },
    { label: "PAR", width: 80, align: "right" },
    { label: "POR", width: 80, align: "right" }
  ];
  const rows: RenderRow[] = [];
  const par = (department: string, field: "revenuePAR" | "profitPAR" | "expensePAR"): string => dash(pnl.ratios.perDepartment.find((d) => d.department === department)?.[field]);
  const por = (department: string, field: "revenuePOR" | "profitPOR" | "expensePOR"): string => dash(pnl.ratios.perDepartment.find((d) => d.department === department)?.[field]);
  rows.push({ cells: ["DEPARTAMENTOS OPERATIVOS", "", "", ""], style: "section" });
  for (const dept of pnl.operatingDepartments) {
    rows.push({ cells: [dept.label, "", "", ""], style: "header" });
    rows.push({ cells: ["Ingresos", dept.revenue, par(dept.department, "revenuePAR"), por(dept.department, "revenuePOR")], style: "normal", indent: 1 });
    if (dept.department !== "misc_income") {
      rows.push({ cells: ["Coste de ventas", dept.costOfSales, "", ""], style: "normal", indent: 1 });
      rows.push({ cells: ["Costes de personal", dept.labor, "", ""], style: "normal", indent: 1 });
      rows.push({ cells: ["Otros gastos", dept.otherExpense, "", ""], style: "normal", indent: 1 });
      rows.push({ cells: ["Total gastos", dept.totalExpenses, par(dept.department, "expensePAR"), por(dept.department, "expensePOR")], style: "normal", indent: 1 });
    }
    rows.push({ cells: ["Beneficio departamental", dept.departmentalProfit, par(dept.department, "profitPAR"), por(dept.department, "profitPOR")], style: "total", indent: 1 });
    if (detail) for (const account of dept.accounts) rows.push({ cells: [`${account.code} · ${account.name} (${account.line})`, account.amount, "", ""], style: "sub", indent: 2 });
  }
  rows.push({ cells: ["Ingresos operativos totales", pnl.totalOperatingRevenue, dash(pnl.ratios.trevpar), dash(pnl.ratios.totalRevenuePOR)], style: "total" });
  rows.push({ cells: ["Beneficio departamental total", pnl.totalDepartmentalProfit, "", ""], style: "total" });
  rows.push({ cells: ["GASTOS NO DISTRIBUIDOS", "", "", ""], style: "section" });
  for (const dept of pnl.undistributed) {
    rows.push({ cells: [dept.label, dept.total, par(dept.department, "expensePAR"), por(dept.department, "expensePOR")], style: "normal" });
    rows.push({ cells: ["Costes de personal", dept.labor, "", ""], style: "sub", indent: 1 });
    rows.push({ cells: ["Otros gastos", dept.otherExpense, "", ""], style: "sub", indent: 1 });
    if (detail) for (const account of dept.accounts) rows.push({ cells: [`${account.code} · ${account.name}`, account.amount, "", ""], style: "sub", indent: 2 });
  }
  rows.push({ cells: ["Total gastos no distribuidos", pnl.totalUndistributed, dash(pnl.ratios.undistributedPAR), ""], style: "total" });
  rows.push({ cells: ["GOP · BENEFICIO OPERATIVO BRUTO", pnl.gop, dash(pnl.ratios.goppar), dash(pnl.ratios.gopPOR)], style: "total" });
  rows.push({ cells: ["Honorarios de gestión", pnl.managementFees, "", ""], style: "normal" });
  rows.push({ cells: ["Resultado antes de no operativos", pnl.incomeBeforeNonOperating, "", ""], style: "total" });
  rows.push({ cells: ["NO OPERATIVOS", "", "", ""], style: "section" });
  rows.push({ cells: ["Alquiler", pnl.nonOperating.rent, "", ""], style: "normal", indent: 1 });
  rows.push({ cells: ["Impuestos sobre la propiedad", pnl.nonOperating.propertyTaxes, "", ""], style: "normal", indent: 1 });
  rows.push({ cells: ["Seguros", pnl.nonOperating.insurance, "", ""], style: "normal", indent: 1 });
  rows.push({ cells: ["Otros", pnl.nonOperating.other, "", ""], style: "normal", indent: 1 });
  rows.push({ cells: ["EBITDA", pnl.ebitda, dash(pnl.ratios.ebitdaPAR), ""], style: "total" });
  rows.push({ cells: ["Intereses", pnl.belowEbitda.interest, "", ""], style: "normal", indent: 1 });
  rows.push({ cells: ["Amortización", pnl.belowEbitda.depreciationAmortization, "", ""], style: "normal", indent: 1 });
  rows.push({ cells: ["Impuesto sobre beneficios", pnl.belowEbitda.incomeTax, "", ""], style: "normal", indent: 1 });
  rows.push({ cells: ["RESULTADO NETO", pnl.netIncome, "", ""], style: "total" });
  rows.push({ cells: ["SIN ASIGNAR (cuentas sin mapeo USALI)", pnl.unassigned.net, "", ""], style: "section" });
  for (const account of pnl.unassigned.accounts) rows.push({ cells: [`${account.code} · ${account.name} (${account.kind})`, account.amount, "", ""], style: "sub", indent: 1 });
  rows.push({ cells: [`Conciliación PGC: resultado ${pnl.reconciliation.pgcResult} = neto USALI + sin asignar ${pnl.reconciliation.usaliNetIncomePlusUnassigned}`, pnl.reconciliation.ok ? "OK" : "KO", "", ""], style: "sub" });

  const stats: RenderTable = {
    title: "Estadísticas y ratios (datos del PMS)",
    columns: [
      { label: "Indicador", width: 335, align: "left" },
      { label: "Valor", width: 160, align: "right" }
    ],
    rows: [
      { cells: ["Noches del periodo", String(pnl.statistics.nights)], style: "normal" },
      { cells: ["Habitaciones (inventario activo)", String(pnl.statistics.roomsInventory)], style: "normal" },
      { cells: ["Habitaciones disponibles (inventario × noches)", String(pnl.statistics.roomsAvailable)], style: "normal" },
      { cells: ["Habitaciones ocupadas (estancias reales)", String(pnl.statistics.roomsOccupied)], style: "normal" },
      { cells: ["Ocupación %", dash(pnl.statistics.occupancyPct)], style: "normal" },
      { cells: ["ADR", dash(pnl.ratios.adr)], style: "normal" },
      { cells: ["RevPAR", dash(pnl.ratios.revpar)], style: "normal" },
      { cells: ["TRevPAR", dash(pnl.ratios.trevpar)], style: "normal" },
      { cells: ["GOPPAR", dash(pnl.ratios.goppar)], style: "normal" }
    ]
  };
  return [{ title: `USALI · ${pnl.propertyName ?? "Organización"} · ${pnl.period.from} a ${pnl.period.to}`, columns, rows }, stats];
}

export function usaliComparisonTables(comparison: UsaliPropertyComparison): RenderTable[] {
  const names = [...comparison.properties.map((p) => p.propertyName), "Consolidado"];
  const pnls = [...comparison.properties.map((p) => p.pnl), comparison.consolidated];
  const columns: RenderColumn[] = [{ label: "Línea", width: 200, align: "left" }, ...names.map((n) => ({ label: n, width: Math.max(60, Math.floor(540 / names.length)), align: "right" as const }))];
  const row = (label: string, pick: (p: UsaliPnl) => string | null, style: RenderRow["style"] = "normal"): RenderRow => ({ cells: [label, ...pnls.map((p) => dash(pick(p)))], style });
  const rows: RenderRow[] = [
    row("Ingresos operativos totales", (p) => p.totalOperatingRevenue, "total"),
    ...comparison.consolidated.operatingDepartments.map((d) => row(`${d.label} · ingresos`, (p) => p.operatingDepartments.find((x) => x.department === d.department)?.revenue ?? null)),
    ...comparison.consolidated.operatingDepartments.map((d) => row(`${d.label} · beneficio`, (p) => p.operatingDepartments.find((x) => x.department === d.department)?.departmentalProfit ?? null)),
    row("Beneficio departamental total", (p) => p.totalDepartmentalProfit, "total"),
    row("Gastos no distribuidos", (p) => p.totalUndistributed),
    row("GOP", (p) => p.gop, "total"),
    row("EBITDA", (p) => p.ebitda, "total"),
    row("Resultado neto", (p) => p.netIncome, "total"),
    row("Sin asignar (neto)", (p) => p.unassigned.net),
    row("Ocupación %", (p) => p.statistics.occupancyPct),
    row("ADR", (p) => p.ratios.adr),
    row("RevPAR", (p) => p.ratios.revpar),
    row("TRevPAR", (p) => p.ratios.trevpar),
    row("GOPPAR", (p) => p.ratios.goppar)
  ];
  return [{ title: `USALI · comparación entre propiedades · ${comparison.period.from} a ${comparison.period.to}`, columns, rows }];
}

export function usaliPeriodsTables(comparison: UsaliPeriodComparison): RenderTable[] {
  const tables: RenderTable[] = [];
  for (const block of comparison.deltas) {
    tables.push({
      title: `USALI · ${comparison.periods[0]!.from} a ${comparison.periods[0]!.to} (base) vs ${block.from} a ${block.to}`,
      columns: [
        { label: "Línea", width: 215, align: "left" },
        { label: "Base", width: 80, align: "right" },
        { label: "Comparado", width: 80, align: "right" },
        { label: "Δ", width: 80, align: "right" },
        { label: "Δ %", width: 60, align: "right" }
      ],
      rows: block.lines.map((l) => ({ cells: [l.label, dash(l.base), dash(l.compared), dash(l.delta), dash(l.deltaPct)], style: "normal" as const }))
    });
  }
  return tables;
}

// ---------------------------------------------------------------------------
// Statement → document
// ---------------------------------------------------------------------------

export type RenderableStatement = PgcBalanceSheet | PgcProfitAndLoss | PgcEquityChanges | PgcMemoria | UsaliPnl | UsaliPropertyComparison | UsaliPeriodComparison | AnnualAccounts;

export function statementDocument(statement: RenderableStatement, entity?: string): RenderDocument {
  const scope = "propertyId" in statement && statement.propertyId ? ` · propiedad ${statement.propertyId}` : "";
  switch (statement.kind) {
    case "balance":
      return { title: "Balance de situación (PGC Pymes)", subtitle: `A ${statement.asOf} · periodo ${statement.period.from} a ${statement.period.to}${scope}`, entity, tables: balanceTables(statement) };
    case "pyg":
      return { title: "Cuenta de pérdidas y ganancias (PGC Pymes)", subtitle: `Periodo ${statement.period.from} a ${statement.period.to}${scope}`, entity, tables: pygTables(statement) };
    case "ecpn":
      return { title: "Estado de cambios en el patrimonio neto (PGC Pymes)", subtitle: `Periodo ${statement.period.from} a ${statement.period.to}${scope}`, entity, landscape: true, tables: ecpnTables(statement) };
    case "memoria":
      return { title: "Memoria (PGC Pymes)", subtitle: `Periodo ${statement.period.from} a ${statement.period.to}${scope}`, entity, tables: memoriaTables(statement) };
    case "usali":
      return { title: "Estado de resultados USALI (11.ª ed.)", subtitle: `Periodo ${statement.period.from} a ${statement.period.to}${scope}`, entity, tables: usaliTables(statement) };
    case "usali_compare_properties":
      return { title: "USALI · comparación entre propiedades", subtitle: `Periodo ${statement.period.from} a ${statement.period.to}`, entity, landscape: true, tables: usaliComparisonTables(statement) };
    case "usali_compare_periods":
      return { title: "USALI · comparación entre periodos", subtitle: statement.periods.map((p) => `${p.from} a ${p.to}`).join(" · "), entity, tables: usaliPeriodsTables(statement) };
    case "annual_accounts":
      return {
        title: "Cuentas anuales (PGC Pymes)",
        subtitle: `Periodo ${statement.period.from} a ${statement.period.to}${statement.fiscalYear ? ` · ejercicio ${statement.fiscalYear.code}` : ""}${scope}`,
        entity,
        landscape: true,
        tables: [...balanceTables(statement.balance), ...pygTables(statement.pyg), ...ecpnTables(statement.ecpn), ...memoriaTables(statement.memoria)]
      };
  }
}

// ---------------------------------------------------------------------------
// Document → bytes
// ---------------------------------------------------------------------------

export function documentToPdf(doc: RenderDocument): Buffer {
  const pageWidth = doc.landscape ? 761 : 515; // A4 minus margins
  const tables: PdfTable[] = doc.tables.map((table) => {
    const total = table.columns.reduce((s, c) => s + c.width, 0);
    const scale = total > pageWidth ? pageWidth / total : 1;
    return { ...table, columns: table.columns.map((c) => ({ ...c, width: c.width * scale })) };
  });
  return renderPdfReport(tables, { title: doc.title, subtitle: doc.subtitle, entity: doc.entity, landscape: doc.landscape });
}

function xlsxCell(text: string, align: "left" | "right", bold: boolean): XlsxCell {
  if (align === "right" && NUMBER_RE.test(text)) return { amount: text, bold };
  return { text, bold };
}

export function documentToXlsx(doc: RenderDocument): Buffer {
  const sheets: XlsxSheet[] = doc.tables.map((table, index) => {
    const rows: XlsxCell[][] = [[{ text: doc.title, bold: true }], [doc.subtitle], [], [{ text: table.title, bold: true }], table.columns.map((c) => ({ text: c.label, bold: true }))];
    for (const row of table.rows) {
      const bold = row.style === "total" || row.style === "section" || row.style === "header";
      rows.push(row.cells.map((cell, i) => xlsxCell(`${"  ".repeat(i === 0 ? (row.indent ?? 0) : 0)}${cell}`, table.columns[i]?.align ?? "left", bold)));
    }
    return { name: `${index + 1} ${table.title}`.slice(0, 31), widths: table.columns.map((c) => Math.max(12, Math.round(c.width / 6))), rows };
  });
  return writeXlsx(sheets);
}

export function documentToCsv(doc: RenderDocument): string {
  return csvBlocks(
    doc.tables.map((table) => ({
      title: `${doc.title} · ${doc.subtitle} · ${table.title}`,
      header: table.columns.map((c) => c.label),
      rows: table.rows.map((row) => row.cells.map((cell, i): CsvCell => (table.columns[i]?.align === "right" && NUMBER_RE.test(cell) ? decimalComma(cell) : cell)))
    }))
  );
}

export type RenderedFile = { buffer: Buffer; contentType: string; extension: "pdf" | "xlsx" | "csv" };

export function renderStatementFile(statement: RenderableStatement, format: "pdf" | "xlsx" | "csv", entity?: string): RenderedFile {
  const doc = statementDocument(statement, entity);
  if (format === "pdf") return { buffer: documentToPdf(doc), contentType: "application/pdf", extension: "pdf" };
  if (format === "xlsx") return { buffer: documentToXlsx(doc), contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", extension: "xlsx" };
  return { buffer: Buffer.from(documentToCsv(doc), "utf8"), contentType: "text/csv; charset=utf-8", extension: "csv" };
}
