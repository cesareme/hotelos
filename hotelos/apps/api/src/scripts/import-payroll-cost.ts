// CLI de importación del coste de personal agregado (Tanda 6c · L3 · diseño §7).
//
// Lee el informe de RRHH YA AGREGADO (centro × mes × grupo × departamento; nunca
// datos por persona) en CSV o JSON y lo pasa por el MISMO servicio que la ruta
// HTTP (modules/payroll/cost-import.service.ts): este fichero solo decodifica,
// planifica y presenta, no re-implementa reglas.
//
//   · Dry-run (por defecto): previewPayrollCostImport → cabecera (organización,
//     sociedad vía resolveLedgerScope, fichero, hash, periodo), tabla centro × mes,
//     totales por grupo, avisos (discrepancias de coste_total con nº de línea),
//     etiquetas sin mapear, duplicado / solapes / periodos de nómina real,
//     canPost y «Nada escrito». Salida 1 si hay errores, centros sin mapear o
//     duplicado / solape sin --replace.
//   · --apply --confirm <organizationId>: hydrateAuditChainFromPostgres,
//     createPayrollCostImport (audita PAYROLL_COST_IMPORT_POSTED) como usuario de
//     sistema (createdBy "cli:import-payroll-cost"), flush de auditoría y
//     proyecciones antes de $disconnect; imprime importId, asientos (nº y
//     ejercicio), totales 640 / 642 / 465 / 476, reportedTotalCost y diferencia,
//     replacedImportIds. 409 duplicado / solape sin --replace → mensaje con el
//     importId y salida 1.
//
// Códigos de salida: 0 ok · 1 fallo (validación, mapeo, duplicado, BD) · 2 uso.
// NUNCA --replace sobre un lote real ya cargado sin querer sustituirlo entero:
// revierte los lotes afectados COMPLETOS antes de crear el nuevo (diseño §3.3).
//
//   cd apps/api && node --env-file-if-exists=../../.env --import tsx src/scripts/import-payroll-cost.ts \
//     --file <json|csv> --organization <organizationId> [--dry-run | --apply --confirm <organizationId>] [--replace] [--json]

import { readFileSync } from "node:fs";
import { basename, extname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "@hotelos/database";
import type {
  PayrollCostCentreMonthDto,
  PayrollCostGroupTotals,
  PayrollCostImportCreateResult,
  PayrollCostImportFormat,
  PayrollCostImportPreview,
  PermissionKey
} from "@hotelos/shared";
import { PAYROLL_COST_GROUP_LABELS_ES } from "@hotelos/shared";
import type { UserContext } from "../lib/demo-store.js";
import { resolveLedgerScope } from "../lib/finance-scope.js";
import { HttpError } from "../lib/http-error.js";
import { flushAccountingProjection } from "../modules/accounting/projection.js";
import { flushExtraProjections } from "../modules/accounting/posting-rules/index.js";
import { flushAuditQueues, hydrateAuditChainFromPostgres } from "../modules/audit/audit.service.js";
import { parsePayrollCostContent } from "../modules/payroll/cost-import.parser.js";
import { createPayrollCostImport, previewPayrollCostImport } from "../modules/payroll/cost-import.service.js";

// ---------------------------------------------------------------------------
// Constantes del usuario de sistema
// ---------------------------------------------------------------------------

export const SYSTEM_USER_ID = "usr_system_payroll_cost_import";
export const CREATED_BY = "cli:import-payroll-cost";
export const CORRELATION_ID = "corr_payroll_cost_import";
export const SCRIPT_LABEL = "[payroll:import-cost]";

/** Claves que el servicio exige (PAYROLL_WRITE_KEYS / PAYROLL_READ_KEYS) más el ámbito de toda la sociedad (R11). */
export const CLI_PERMISSIONS: readonly PermissionKey[] = ["payroll.manage", "payroll.read", "accounting.journal.post", "accounting.read", "accounting.entity.read"];

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

export type ImportFlags = {
  file: string | null;
  organization: string | null;
  apply: boolean;
  confirm: string | null;
  replace: boolean;
  json: boolean;
  help: boolean;
};

export const USAGE = [
  "Uso (desde apps/api, DATABASE_URL en el entorno o ../../.env):",
  "  node --env-file-if-exists=../../.env --import tsx src/scripts/import-payroll-cost.ts \\",
  "    --file <ruta.json|ruta.csv> --organization <organizationId> \\",
  "    [--dry-run | --apply --confirm <organizationId>] [--replace] [--json] [--help]",
  "  (equivalente: corepack pnpm --filter @hotelos/api payroll:import-cost -- --file … --organization …)",
  "",
  "  --file <ruta>          informe de RRHH AGREGADO (centro × mes × grupo × departamento) en CSV (`;`, decimales con coma o punto,",
  "                         UTF-8 o latin1, BOM admitido) o JSON (agregado del informe con `lineas[]` / `referencia[]` o `{ rows }`);",
  "                         formato por extensión o por el primer carácter `{` / `[`. Nunca datos por persona.",
  "  --organization <id>    organización destino (los centros del fichero se resuelven contra sus Property.code / nombre)",
  "  --dry-run              (por defecto) previsualiza: tabla centro × mes, totales por grupo, avisos, etiquetas sin mapear,",
  "                         duplicado / solapes / periodos de nómina real, canPost; no escribe nada",
  "  --apply                importa y CONTABILIZA (un asiento por centro y mes, último día del mes, D 640 / D 642 por",
  "                         departamento USALI con centro de coste, H 465 / H 476); exige --confirm con el mismo organizationId",
  "  --confirm <id>         id exacto de la organización (guarda contra aplicar en otra BD)",
  "  --replace              sustituye los lotes vivos con el mismo contenido o con celdas (centro, mes) ya contabilizadas:",
  "                         los revierte ENTEROS y crea el lote nuevo en la misma transacción (reimporta siempre el rango completo)",
  "  --json                 resultado legible por máquina (previsualización o lote creado)",
  "  --help, -h             esta ayuda",
  "",
  `Usuario de sistema: ${SYSTEM_USER_ID} (createdBy ${CREATED_BY}, correlación ${CORRELATION_ID}).`,
  "Códigos de salida: 0 ok · 1 fallo (validación, centros sin mapear, duplicado / solape sin --replace, BD) · 2 flag desconocido / uso."
].join("\n");

const VALUE_FLAGS = new Set(["--file", "--organization", "--confirm"]);

export function parseFlags(argv: readonly string[]): ImportFlags {
  const flags: ImportFlags = { file: null, organization: null, apply: false, confirm: null, replace: false, json: false, help: false };
  let sawDryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") return { ...flags, help: true };
    if (arg === "--dry-run") sawDryRun = true;
    else if (arg === "--apply") flags.apply = true;
    else if (arg === "--replace") flags.replace = true;
    else if (arg === "--json") flags.json = true;
    else if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--") || value.trim() === "") throw new Error(`El flag "${arg}" necesita un valor.`);
      const trimmed = value.trim();
      if (arg === "--file") {
        if (flags.file !== null) throw new Error("--file solo puede indicarse una vez (un fichero = un lote).");
        flags.file = trimmed;
      } else if (arg === "--organization") {
        if (flags.organization !== null) throw new Error("--organization solo puede indicarse una vez.");
        flags.organization = trimmed;
      } else {
        if (flags.confirm !== null) throw new Error("--confirm solo puede indicarse una vez.");
        flags.confirm = trimmed;
      }
      i++;
    } else if (arg === "--") continue;
    else throw new Error(`Flag desconocido "${arg}". Admitidos: --file <ruta>, --organization <id>, --dry-run, --apply, --confirm <id>, --replace, --json, --help.`);
  }
  if (sawDryRun && flags.apply) throw new Error("--dry-run y --apply son excluyentes.");
  if (flags.file === null) throw new Error("--file <ruta.json|ruta.csv> es obligatorio.");
  if (flags.organization === null) throw new Error("--organization <organizationId> es obligatorio.");
  if (flags.apply && flags.confirm === null) throw new Error(`--apply exige --confirm ${flags.organization}.`);
  if (!flags.apply && flags.confirm !== null) throw new Error("--confirm solo tiene sentido con --apply.");
  return flags;
}

/** Con --apply, `--confirm` debe repetir exactamente el organizationId de `--organization`. */
export function assertConfirmMatches(flags: Pick<ImportFlags, "apply" | "confirm" | "organization">): void {
  if (!flags.apply) return;
  if (flags.confirm === null || flags.confirm !== flags.organization) {
    throw new Error(`--confirm "${flags.confirm ?? ""}" no coincide con --organization "${flags.organization ?? ""}". Nada escrito.`);
  }
}

// ---------------------------------------------------------------------------
// Lectura del fichero (puro sobre bytes)
// ---------------------------------------------------------------------------

export type DecodedInput = { content: string; encoding: "utf-8" | "latin1"; bom: boolean };

/** UTF-8 estricto; si no decodifica, latin1 (informes exportados desde Excel/Windows). Quita el BOM. */
export function decodeInput(bytes: Uint8Array): DecodedInput {
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const body = bom ? bytes.subarray(3) : bytes;
  try {
    return { content: new TextDecoder("utf-8", { fatal: true }).decode(body), encoding: "utf-8", bom };
  } catch {
    return { content: Buffer.from(body).toString("latin1"), encoding: "latin1", bom };
  }
}

/** `.json` → json, `.csv` / `.txt` → csv; sin extensión conocida decide el primer carácter no blanco (`{` / `[` → json). */
export function detectFormat(fileName: string, content: string): PayrollCostImportFormat {
  const extension = extname(fileName).toLowerCase();
  if (extension === ".json") return "json";
  if (extension === ".csv" || extension === ".txt") return "csv";
  const first = content.trimStart().charAt(0);
  return first === "{" || first === "[" ? "json" : "csv";
}

// ---------------------------------------------------------------------------
// Presentación (pura)
// ---------------------------------------------------------------------------

/** "1234567.5" → "1.234.567,50" sin depender de ICU. */
export function formatEs(value: string | number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || value === "") return "—";
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return String(value);
  const sign = number < 0 ? "-" : "";
  const [integer, fraction = ""] = Math.abs(number).toFixed(decimals).split(".");
  const grouped = integer!.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${sign}${grouped}${decimals > 0 ? `,${fraction}` : ""}`;
}

function table(header: string[], rows: string[][], rightAligned: ReadonlySet<number> = new Set()): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const cell = (value: string, i: number) => (rightAligned.has(i) ? value.padStart(widths[i]!) : value.padEnd(widths[i]!));
  const line = (cells: string[]) => `| ${cells.map((value, i) => cell(value ?? "", i)).join(" | ")} |`;
  return [line(header), `|${widths.map((w) => "-".repeat(w + 2)).join("|")}|`, ...rows.map(line)];
}

/** Tabla centro × mes de la previsualización (una fila por asiento previsto), ordenada por mes y código. */
export function formatCentreMonthTable(cells: readonly PayrollCostCentreMonthDto[]): string[] {
  const sorted = [...cells].sort((a, b) => a.periodCode.localeCompare(b.periodCode) || (a.propertyCode ?? a.propertyName ?? a.propertyId).localeCompare(b.propertyCode ?? b.propertyName ?? b.propertyId));
  const rows = sorted.map((cell) => [
    cell.propertyCode ?? cell.propertyName ?? cell.propertyId,
    cell.periodCode,
    cell.workCenterLabels.join(" + "),
    String(cell.lines),
    formatEs(cell.gross),
    formatEs(cell.employerSs),
    formatEs(cell.totalCost),
    formatEs(cell.headcount),
    cell.employeesReported === null ? "—" : formatEs(cell.employeesReported),
    cell.departments.join(", ")
  ]);
  return table(["Centro", "Mes", "Etiquetas del informe", "Líneas", "Bruto", "SS empresa", "Total", "Empleados", "Empl. informe", "Departamentos USALI"], rows, new Set([3, 4, 5, 6, 7, 8]));
}

export function formatGroupTable(groups: readonly PayrollCostGroupTotals[]): string[] {
  const rows = groups.map((group) => [PAYROLL_COST_GROUP_LABELS_ES[group.costGroup] ?? group.costGroup, String(group.lines), formatEs(group.gross), formatEs(group.employerSs), formatEs(group.totalCost), group.reportedTotalCost === null ? "—" : formatEs(group.reportedTotalCost), formatEs(group.headcount)]);
  return table(["Grupo", "Líneas", "Bruto", "SS empresa", "Total", "Coste total informe", "Empleados"], rows, new Set([1, 2, 3, 4, 5, 6]));
}

/** 1 si la previsualización no puede contabilizarse tal cual (errores, sin mapear, duplicado / solape sin --replace); 0 si sí. */
export function dryRunExitCode(preview: Pick<PayrollCostImportPreview, "errors" | "unmappedCentres" | "unmappedDepartments" | "unmappedGroups" | "duplicateOf" | "overlaps" | "canPost">, replace: boolean): 0 | 1 {
  if (preview.errors.length > 0) return 1;
  if (preview.unmappedCentres.length > 0 || preview.unmappedDepartments.length > 0 || preview.unmappedGroups.length > 0) return 1;
  if (!replace && (preview.duplicateOf !== null || preview.overlaps.length > 0)) return 1;
  return preview.canPost ? 0 : 1;
}

export type DryRunHeader = {
  organizationId: string;
  organizationName: string;
  legalEntityId: string | null;
  legalName: string;
  file: string;
  format: PayrollCostImportFormat;
  encoding: DecodedInput["encoding"];
  bom: boolean;
  bytes: number;
  parsedRows: number;
  references: number;
  source: string;
  sourceOrganizationId: string | null;
};

export function formatDryRun(header: DryRunHeader, preview: PayrollCostImportPreview, replace: boolean): string[] {
  const lines: string[] = [];
  lines.push(`${SCRIPT_LABEL} previsualización (dry-run) · organización ${header.organizationName} (${header.organizationId})`);
  lines.push(`  Sociedad: ${header.legalName}${header.legalEntityId ? ` (${header.legalEntityId})` : " (sin sociedad dada de alta)"}`);
  lines.push(`  Fichero: ${header.file} · ${header.format} · ${header.encoding}${header.bom ? " + BOM" : ""} · ${formatEs(header.bytes, 0)} bytes · origen ${header.source}${header.sourceOrganizationId ? ` · organizationId declarado ${header.sourceOrganizationId}` : ""}`);
  lines.push(`  Hash de contenido: ${preview.contentHash}`);
  lines.push(`  Periodo: ${preview.periodFrom ?? "—"} → ${preview.periodTo ?? "—"} · ${preview.rowCount} filas normalizadas (${header.parsedRows} del fichero) · ${preview.byCentreMonth.length} celdas centro × mes · ${header.references} referencias`);
  lines.push("");
  if (preview.errors.length > 0) {
    lines.push(`  ERRORES (${preview.errors.length}):`);
    for (const error of preview.errors) lines.push(`    · ${error.line === null ? "fichero" : `línea ${error.line}`}: ${error.message}`);
    lines.push("");
  }
  lines.push("  Celdas centro × mes:");
  for (const line of formatCentreMonthTable(preview.byCentreMonth)) lines.push(`  ${line}`);
  lines.push("");
  lines.push("  Totales por grupo:");
  for (const line of formatGroupTable(preview.byGroup)) lines.push(`  ${line}`);
  lines.push(`  Total: bruto ${formatEs(preview.totals.gross)} · SS empresa ${formatEs(preview.totals.employerSs)} · 640 + 642 = ${formatEs(preview.totals.totalCost)}${preview.totals.reportedTotalCost !== null ? ` · coste total del informe ${formatEs(preview.totals.reportedTotalCost)} (diferencia ${formatEs(Number(preview.totals.totalCost) - Number(preview.totals.reportedTotalCost))})` : ""} · empleados medios ${preview.totals.headcountAverage === null ? "—" : formatEs(preview.totals.headcountAverage)}`);
  lines.push("");
  const unmapped = [
    ...preview.unmappedCentres.map((u) => `centro «${u.label}» (${u.rows} filas)${u.suggestions.length ? ` → sugerencias: ${u.suggestions.map((s) => `${s.code ?? s.name} (${s.propertyId})`).join(", ")}` : ""}`),
    ...preview.unmappedDepartments.map((u) => `departamento «${u.label}» (${u.rows} filas)`),
    ...preview.unmappedGroups.map((u) => `grupo «${u.label}» (${u.rows} filas)`)
  ];
  lines.push(`  Etiquetas sin mapear: ${unmapped.length === 0 ? "ninguna" : unmapped.length}`);
  for (const item of unmapped) lines.push(`    · ${item}`);
  lines.push(`  Avisos: ${preview.warnings.length === 0 ? "ninguno" : preview.warnings.length}`);
  for (const warning of preview.warnings) lines.push(`    · ${warning}`);
  if (preview.duplicateOf) lines.push(`  Duplicado: el mismo contenido ya está importado en el lote ${preview.duplicateOf.importId} (${preview.duplicateOf.status}, ${preview.duplicateOf.fileName ?? "sin nombre"}, ${preview.duplicateOf.periodFrom} → ${preview.duplicateOf.periodTo})${replace ? " → se revertirá ENTERO por --replace" : " → usa --replace para sustituirlo"}`);
  if (preview.overlaps.length > 0) {
    lines.push(`  Solapes: ${preview.overlaps.length} celda(s) ya contabilizadas por otro lote${replace ? " → los lotes afectados se revertirán ENTEROS por --replace" : " → usa --replace para sustituirlos"}`);
    for (const overlap of preview.overlaps.slice(0, 20)) lines.push(`    · ${overlap.propertyId} · ${overlap.periodCode} · lote ${overlap.importId} (${overlap.periodFrom} → ${overlap.periodTo})`);
  }
  if (preview.payrollPeriodsPosted.length > 0) lines.push(`  Periodos de nómina real ya contabilizados en el mismo centro y mes: ${preview.payrollPeriodsPosted.map((p) => `${p.propertyId ?? "sociedad"} · ${p.periodCode}`).join(", ")}`);
  if (replace && preview.replacedImportIds.length > 0) lines.push(`  Lotes que --replace revertiría enteros: ${preview.replacedImportIds.join(", ")}`);
  lines.push(`  canPost: ${preview.canPost ? "sí" : "no"}`);
  lines.push("");
  lines.push("  Nada escrito (dry-run). Para contabilizar: --apply --confirm <organizationId>.");
  return lines;
}

export function formatApplyResult(result: PayrollCostImportCreateResult): string[] {
  const lines: string[] = [];
  const numbered = result.entries.filter((entry) => entry.entryNumber !== null);
  const first = numbered.length ? numbered.reduce((min, entry) => (entry.entryNumber! < min.entryNumber! ? entry : min)) : null;
  const last = numbered.length ? numbered.reduce((max, entry) => (entry.entryNumber! > max.entryNumber! ? entry : max)) : null;
  lines.push(`${SCRIPT_LABEL} lote ${result.id} ${result.status === "posted" ? "contabilizado" : result.status} · ${result.fileName ?? "sin nombre"} · ${result.periodFrom} → ${result.periodTo} · ${result.rowCount} filas · ${result.centreMonths} celdas centro × mes`);
  lines.push(`  Asientos: ${result.entries.length}${first && last ? ` (nº ${first.entryNumber} → ${last.entryNumber}, ejercicio ${first.fiscalYearCode ?? "—"})` : ""}`);
  lines.push(`  640 Sueldos y salarios (D) = 465 Remuneraciones pendientes (H): ${formatEs(result.totalGross)}`);
  lines.push(`  642 SS empresa (D) = 476 SS acreedora (H): ${formatEs(result.totalEmployerSs)}`);
  lines.push(`  Total contabilizado (640 + 642): ${formatEs(result.totalCost)}${result.reportedTotalCost !== null ? ` · coste total del informe ${formatEs(result.reportedTotalCost)} (diferencia ${formatEs(Number(result.totalCost) - Number(result.reportedTotalCost))})` : ""}`);
  lines.push(`  Empleados medios: ${result.headcountAverage === null ? "—" : formatEs(result.headcountAverage)} · sociedad ${result.legalEntityId ?? "—"} · createdBy ${result.createdBy ?? "—"}`);
  lines.push(`  Lotes sustituidos (--replace): ${result.replacedImportIds.length === 0 ? "ninguno" : result.replacedImportIds.join(", ")}`);
  if (result.warnings.length > 0) {
    lines.push(`  Avisos (${result.warnings.length}):`);
    for (const warning of result.warnings) lines.push(`    · ${warning}`);
  }
  for (const entry of result.entries) lines.push(`    · ${entry.fiscalYearCode ?? "—"}/${entry.entryNumber ?? "—"} · ${entry.propertyCode ?? entry.propertyId} · ${entry.periodCode} · ${entry.entryDate} · ${formatEs(entry.totalDebit)} · ${entry.sourceId}`);
  return lines;
}

// ---------------------------------------------------------------------------
// Contexto de sistema y ejecución
// ---------------------------------------------------------------------------

export function systemContext(organizationId: string, propertyId: string): UserContext {
  return {
    organizationId,
    propertyId,
    userId: SYSTEM_USER_ID,
    fullName: "Importación de coste de personal (CLI)",
    deviceId: CREATED_BY,
    permissions: [...CLI_PERMISSIONS],
    isPlatformAdmin: false
  };
}

export type RunOutcome = { exitCode: 0 | 1; json: unknown; lines: string[] };

export async function runImport(flags: ImportFlags): Promise<RunOutcome> {
  assertConfirmMatches(flags);
  const organizationId = flags.organization!;
  const filePath = resolvePath(flags.file!);
  const bytes = readFileSync(filePath);
  const decoded = decodeInput(bytes);
  const format = detectFormat(filePath, decoded.content);
  const parsed = parsePayrollCostContent({ format, content: decoded.content });

  const organization = await prisma.organization.findUnique({ where: { id: organizationId }, select: { id: true, name: true } });
  if (!organization) throw new Error(`Organización "${organizationId}" no encontrada. Nada escrito.`);
  const firstProperty = await prisma.property.findFirst({ where: { organizationId }, orderBy: { createdAt: "asc" }, select: { id: true } });
  if (!firstProperty) throw new Error(`La organización "${organizationId}" no tiene centros de trabajo: da de alta los centros antes de importar. Nada escrito.`);
  const context = systemContext(organizationId, firstProperty.id);
  const scope = await resolveLedgerScope(context, {});
  const header: DryRunHeader = {
    organizationId,
    organizationName: organization.name,
    legalEntityId: scope.legalEntityId,
    legalName: scope.identity.legalName,
    file: basename(filePath),
    format,
    encoding: decoded.encoding,
    bom: decoded.bom,
    bytes: bytes.length,
    parsedRows: parsed.rows.length,
    references: parsed.references.length,
    source: parsed.source,
    sourceOrganizationId: parsed.sourceOrganizationId
  };

  if (!flags.apply) {
    const preview = await previewPayrollCostImport({ context, body: { format, content: decoded.content, replace: flags.replace } });
    const exitCode = dryRunExitCode(preview, flags.replace);
    return { exitCode, json: { mode: "dry-run", header, preview, exitCode }, lines: formatDryRun(header, preview, flags.replace) };
  }

  await hydrateAuditChainFromPostgres();
  try {
    const result = await createPayrollCostImport({
      context,
      body: { format, content: decoded.content, fileName: header.file, replace: flags.replace, post: true },
      createdBy: CREATED_BY,
      correlationId: CORRELATION_ID
    });
    return { exitCode: 0, json: { mode: "apply", header, result, exitCode: 0 }, lines: formatApplyResult(result) };
  } catch (error) {
    if (error instanceof HttpError) {
      const details = (error.details ?? {}) as Record<string, unknown>;
      const code = typeof details.code === "string" ? details.code : `HTTP_${error.statusCode}`;
      const lines = [`${SCRIPT_LABEL} ${code} (${error.statusCode}): ${error.message}`];
      if (typeof details.importId === "string") lines.push(`  Lote afectado: ${details.importId}${typeof details.status === "string" ? ` (${details.status})` : ""} → --replace lo revertiría ENTERO antes de crear el nuevo.`);
      if (Array.isArray(details.overlaps)) lines.push(`  Solapes: ${details.overlaps.length} celda(s) → --replace revertiría ENTEROS los lotes afectados.`);
      if (Array.isArray(details.labels)) lines.push(`  Etiquetas: ${(details.labels as unknown[]).map(String).join(", ")}`);
      if (Array.isArray(details.errors)) for (const item of details.errors as Array<{ line?: number | null; message?: string }>) lines.push(`    · ${item.line == null ? "fichero" : `línea ${item.line}`}: ${item.message ?? ""}`);
      lines.push("  Nada escrito.");
      return { exitCode: 1, json: { mode: "apply", header, error: { statusCode: error.statusCode, message: error.message, details }, exitCode: 1 }, lines };
    }
    throw error;
  } finally {
    await flushAuditQueues();
    await flushAccountingProjection();
    await flushExtraProjections();
  }
}

/** Escribe en stdout y espera a que la tubería lo acepte: `process.exit` justo después de console.log truncaría un --json largo. */
function writeStdout(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${text}\n`, (error) => (error ? reject(error) : resolve()));
  });
}

const entryFile = resolvePath(fileURLToPath(import.meta.url));
const argFile = process.argv[1] ? resolvePath(process.argv[1]) : "";
if (entryFile === argFile) {
  let flags: ImportFlags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (error) {
    console.error(`${SCRIPT_LABEL} ${(error as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (flags.help) {
    console.log(USAGE);
    process.exit(0);
  }
  runImport(flags)
    .then(async (outcome) => {
      await writeStdout(flags.json ? JSON.stringify(outcome.json, null, 2) : outcome.lines.join("\n"));
      await prisma.$disconnect();
      process.exit(outcome.exitCode);
    })
    .catch(async (error) => {
      console.error(`${SCRIPT_LABEL} fallo:`, error instanceof Error ? error.message : error);
      await prisma.$disconnect().catch(() => undefined);
      process.exit(1);
    });
}
