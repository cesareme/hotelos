// CLI de importación contable desde Sage 200 (Tanda 7c · L3 · diseño §7.3 con las
// correcciones de §10.4.1). Clon estructural de import-payroll-cost.ts.
//
// Lee la exportación de Sage 200 (Excel / CSV de listados, CSV IME de 60 columnas,
// XML «Datos contables» o canónico CSV / JSON) y la pasa por el MISMO servicio que
// las rutas HTTP (modules/accounting/import/ledger-import.service.ts y
// ledger-reconciliation.service.ts): este fichero solo decodifica, presenta y
// maneja flags, no re-implementa reglas (mapa de cuentas, analítica, exclusión de
// nativos, cuadre, idempotencia, periodos cerrados).
//
//   · Dry-run (por defecto): previewLedgerImport → cabecera (organización, sociedad
//     vía resolveLedgerScope, fichero, hash, formato detectado, ejercicio, rango),
//     tabla por mes y por centro (asientos, apuntes, Debe, Haber), cuentas sin mapear
//     con sugerencia, analítica sin mapear, asientos sin centro, nativos excluidos, ya
//     existentes, avisos, bloqueos y canPost; «Nada escrito». Salida 1 si !canPost.
//   · --apply --confirm <organizationId>: hydrateAuditChainFromPostgres antes;
//     createLedgerImport (audita LEDGER_IMPORT_POSTED) como usuario de sistema
//     (createdBy "cli:import-sage200"); flushAuditQueues + flushAccountingProjection +
//     flushExtraProjections antes de $disconnect. Con `--type journal --reconcile
//     --balance <sumas-y-saldos>` el lote adjunta el balance de Sage y la reconciliación
//     se ejecuta tras el commit (options.reconcile).
//   · --allow-closed (solo con --apply, exige --reason): contabiliza en periodos
//     cerrados de Anfitorio; el motivo queda en `notes` del lote y en la auditoría.
//   · --reconcile suelto: --balance <fichero> --from <YYYY-MM-DD> --to <YYYY-MM-DD>
//     [--property <código>] → reconcileLedger (escribe solo ledger_reconciliations).
//   · --reverse <importId> --reason "…" --confirm <orgId>: el lote resuelve la
//     organización y --confirm debe coincidir con ella; 200 idempotente del servicio.
//   · --template <type> --out <ruta.csv>: plantilla canónica (sin BD).
//
// Códigos de salida: 0 ok · 1 fallo (validación, mapeo, duplicado, BD, !canPost) · 2 uso.
// NUNCA --replace sobre Faranda salvo para sustituir un mes completo (revierte
// ENTEROS los lotes que solapen antes de crear el nuevo). Con el API en marcha su
// cadena de auditoría en memoria se bifurca (accounting-replay.ts, CLAUDE.md deuda
// 12(c)): ejecuta --apply con el API parado o reinícialo después.
//
//   cd apps/api && node --env-file-if-exists=../../.env --import tsx src/scripts/import-sage200.ts \
//     --type plan|fiscal_years|journal|vat_books|third_parties|balances --file <ruta> --organization <orgId> \
//     [--entity <legalEntityId>] [--format <formato>] [--sheet <hoja>] [--mapping <ruta.json>] [--unassigned block|office] \
//     [--dry-run | --apply --confirm <orgId>] [--replace] [--allow-closed --reason "…"] [--reconcile --balance <fichero>] [--json]

import { readFileSync, writeFileSync } from "node:fs";
import { BRAND } from "../lib/brand.js";
import { basename, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "@hotelos/database";
import type {
  LedgerImportCreateResult,
  LedgerImportFormat,
  LedgerImportKind,
  LedgerImportMappingInput,
  LedgerImportOptions,
  LedgerImportPreview,
  LedgerImportPreviewMonthRow,
  LedgerImportPreviewPropertyRow,
  LedgerImportRecord,
  LedgerReconciliationDto,
  PermissionKey
} from "@hotelos/shared";
import {
  LEDGER_IMPORT_CLI_CREATED_BY,
  LEDGER_IMPORT_FORMATS,
  LEDGER_IMPORT_KIND_LABELS_ES,
  LEDGER_IMPORT_KINDS,
  LEDGER_IMPORT_SYSTEM_USER_ID,
  LEDGER_NUMBERING_DIMENSIONS,
  LEDGER_RECONCILIATION_CLASSIFICATION_LABELS_ES,
  LEDGER_UNASSIGNED_POLICIES,
  type LedgerNumberingDimension
} from "@hotelos/shared";
import type { UserContext } from "../lib/demo-store.js";
import { resolveLedgerScope } from "../lib/finance-scope.js";
import { HttpError } from "../lib/http-error.js";
import { flushAccountingProjection } from "../modules/accounting/projection.js";
import { flushExtraProjections } from "../modules/accounting/posting-rules/index.js";
import { buildLedgerImportTemplate, createLedgerImport, previewLedgerImport, reverseLedgerImport } from "../modules/accounting/import/ledger-import.service.js";
import { reconcileLedger } from "../modules/accounting/import/ledger-reconciliation.service.js";
import { parseOr400 } from "../modules/rate-manager/rate-grid.schemas.js";
import { flushAuditQueues, hydrateAuditChainFromPostgres } from "../modules/audit/audit.service.js";
import { LedgerImportMappingSchema } from "../schemas/ledger-import.schemas.js";

// ---------------------------------------------------------------------------
// Constantes del usuario de sistema
// ---------------------------------------------------------------------------

export const SYSTEM_USER_ID: string = LEDGER_IMPORT_SYSTEM_USER_ID;
export const CREATED_BY: string = LEDGER_IMPORT_CLI_CREATED_BY;
export const CORRELATION_ID = "corr_sage200_import";
export const SCRIPT_LABEL = "[sage200:import]";

/** Claves que exigen los servicios (journal.post, configure, read) más el manifiesto de lecturas (reports.read) y el ámbito de toda la sociedad (R11). */
export const CLI_PERMISSIONS: readonly PermissionKey[] = ["accounting.journal.post", "accounting.configure", "accounting.read", "accounting.reports.read", "accounting.entity.read"];

/** Valores de --type: IDÉNTICOS a LEDGER_IMPORT_KINDS. */
export const CLI_TYPES: readonly LedgerImportKind[] = LEDGER_IMPORT_KINDS;

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

export type CliMode = "import" | "reconcile" | "reverse" | "template";

export type ImportFlags = {
  mode: CliMode;
  type: LedgerImportKind | null;
  file: string | null;
  organization: string | null;
  entity: string | null;
  format: LedgerImportFormat | null;
  sheet: string | null;
  mapping: string | null;
  unassigned: "block" | "office" | null;
  /** «Numeración canal/delegación» de Sage: el código entra en la clave de cada asiento (options.numberingDimension). */
  numbering: LedgerNumberingDimension | null;
  apply: boolean;
  confirm: string | null;
  replace: boolean;
  allowClosed: boolean;
  reason: string | null;
  reconcile: boolean;
  balance: string | null;
  from: string | null;
  to: string | null;
  property: string | null;
  reverse: string | null;
  template: LedgerImportKind | null;
  out: string | null;
  json: boolean;
  help: boolean;
};

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export const USAGE = [
  "Uso (desde apps/api, DATABASE_URL en el entorno o ../../.env):",
  "  node --env-file-if-exists=../../.env --import tsx src/scripts/import-sage200.ts \\",
  `    --type ${CLI_TYPES.join("|")} --file <ruta> --organization <organizationId> \\`,
  "    [--entity <legalEntityId>] [--format sage_excel|sage_ime_csv|sage_xml|canonical_csv|canonical_json] [--sheet <hoja>] \\",
  "    [--mapping <ruta.json>] [--unassigned block|office] [--numbering canal|delegacion] [--dry-run | --apply --confirm <organizationId>] [--replace] \\",
  "    [--allow-closed --reason \"…\"] [--reconcile --balance <sumas-y-saldos>] [--json]",
  "  node … import-sage200.ts --reconcile --balance <sumas-y-saldos> --from YYYY-MM-DD --to YYYY-MM-DD --organization <organizationId> [--property <código>] [--json]",
  "  node … import-sage200.ts --reverse <importId> --reason \"…\" --confirm <organizationId> [--organization <organizationId>] [--json]",
  "  node … import-sage200.ts --template <type> --out <ruta.csv>",
  "  (equivalente: corepack pnpm --filter @hotelos/api sage200:import -- --type … --file … --organization …)",
  "",
  `  --type <tipo>          tipo de lote: ${CLI_TYPES.map((kind) => `${kind} (${LEDGER_IMPORT_KIND_LABELS_ES[kind]})`).join(", ")};`,
  "                         orden recomendado de carga: plan → fiscal_years → journal → vat_books → third_parties → balances",
  "  --file <ruta>          exportación de Sage 200: Excel / CSV de un listado («Enviar a Excel»), CSV de asientos IME (60 columnas),",
  `                         XML «Datos contables» (ZIP o XML) o CSV / JSON canónico de ${BRAND.name} (plantilla: --template)`,
  "  --organization <id>    organización destino (obligatorio salvo --reverse y --template)",
  "  --entity <id>          sociedad (legalEntityId) del lote; por defecto la sociedad de la organización (resolveLedgerScope)",
  "  --format <formato>     fuerza el formato; sin él se detecta por extensión, firma y cabecera (400 LEDGER_IMPORT_FORMAT_UNKNOWN si no)",
  "  --sheet <hoja>         hoja del XLSX (por defecto la primera no oculta)",
  "  --mapping <ruta.json>  mapeo enviado con el lote ({ accounts?: [...], analytics?: { centreDimension, costCentreDimension?, unassignedPolicy, entries } });",
  "                         lo que falte se toma del mapa persistido de la organización (PUT /accounting/ledger-imports/account-map | analytics-map)",
  "  --unassigned <pol>     política para apuntes 6/7 sin centro: block (por defecto: bloquea el lote) u office (van a la oficina central)",
  "  --numbering <dim>      (journal / fiscal_years) Sage numera por canal o por delegación: el código entra en la clave de cada asiento",
  "                         (empresa:ejercicio:periodo:asiento:<canal|delegación>) y dos asientos nº N de delegaciones distintas no se funden",
  "  --dry-run              (por defecto) previsualiza: cabecera, tablas por mes y por centro, cuentas y analítica sin mapear, asientos sin centro,",
  "                         nativos excluidos, ya existentes, avisos, bloqueos y canPost; no escribe nada (salida 1 si canPost es no)",
  "  --apply                importa y CONTABILIZA por postJournalEntry (un asiento por asiento Sage y centro, número Sage en reference);",
  "                         exige --confirm con el mismo organizationId",
  "  --confirm <id>         id exacto de la organización (guarda contra aplicar en otra BD)",
  "  --replace              sustituye los lotes vivos con el mismo hash o con asientos (empresa, ejercicio, periodo, asiento) ya contabilizados:",
  "                         los revierte ENTEROS y crea el lote nuevo en la misma transacción (reimporta siempre el mes completo)",
  `  --allow-closed         (solo con --apply) contabiliza en periodos cerrados de ${BRAND.name}; exige --reason y se audita con el motivo`,
  "  --reason <texto>       motivo del reverso (--reverse) o de --allow-closed",
  "  --reconcile            con --type journal: adjunta --balance <sumas-y-saldos de Sage del mismo rango> y reconcilia tras contabilizar;",
  "                         suelto (sin --type): --balance --from --to [--property <código>] → escribe solo ledger_reconciliations",
  "  --balance <ruta>       sumas y saldos nivel 0 de Sage (Excel, CSV o canónico de saldos)",
  "  --from / --to          rango de fechas contables de la reconciliación suelta (YYYY-MM-DD, from ≤ to)",
  "  --property <código>    centro comparado en la reconciliación suelta (código del centro, p. ej. RA); sin él, consolidado de sociedad",
  "  --reverse <importId>   revierte ENTERO un lote contabilizado (reverso marcado de cada asiento; filas de libros de IVA del lote borradas);",
  "                         idempotente; exige --reason y --confirm <organizationId del lote>",
  "  --template <type>      escribe la plantilla canónica CSV del tipo en --out <ruta.csv> (sin BD)",
  "  --out <ruta>           destino de --template",
  "  --json                 resultado legible por máquina (previsualización, lote, reconciliación o reverso)",
  "  --help, -h             esta ayuda",
  "",
  `Usuario de sistema: ${SYSTEM_USER_ID} (createdBy ${CREATED_BY}, correlación ${CORRELATION_ID}).`,
  "Aviso: con el API en marcha su cadena de auditoría en memoria se bifurca (accounting-replay.ts): ejecuta --apply / --reverse con el API parado o reinícialo después.",
  "NUNCA --replace sobre Faranda salvo para sustituir un mes completo. Ficheros de hasta 20 MB (LEDGER_IMPORT_MAX_BYTES); trocea por meses.",
  "Códigos de salida: 0 ok · 1 fallo (validación, cuentas o analítica sin mapear, duplicado / solape sin --replace, periodo cerrado, BD) · 2 flag desconocido / uso."
].join("\n");

const VALUE_FLAGS = new Set(["--type", "--file", "--organization", "--entity", "--format", "--sheet", "--mapping", "--unassigned", "--numbering", "--confirm", "--reason", "--balance", "--from", "--to", "--property", "--reverse", "--template", "--out"]);
const BOOLEAN_FLAGS = new Set(["--dry-run", "--apply", "--replace", "--allow-closed", "--reconcile", "--json"]);

function emptyFlags(): ImportFlags {
  return {
    mode: "import",
    type: null,
    file: null,
    organization: null,
    entity: null,
    format: null,
    sheet: null,
    mapping: null,
    unassigned: null,
    numbering: null,
    apply: false,
    confirm: null,
    replace: false,
    allowClosed: false,
    reason: null,
    reconcile: false,
    balance: null,
    from: null,
    to: null,
    property: null,
    reverse: null,
    template: null,
    out: null,
    json: false,
    help: false
  };
}

function assertKind(flag: string, value: string): LedgerImportKind {
  if (!(CLI_TYPES as readonly string[]).includes(value)) throw new Error(`${flag} "${value}" no es un tipo de lote válido. Admitidos: ${CLI_TYPES.join(", ")}.`);
  return value as LedgerImportKind;
}

export function parseFlags(argv: readonly string[]): ImportFlags {
  const flags = emptyFlags();
  const values = new Map<string, string>();
  let sawDryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") return { ...flags, help: true };
    if (arg === "--") continue;
    if (BOOLEAN_FLAGS.has(arg)) {
      if (arg === "--dry-run") sawDryRun = true;
      else if (arg === "--apply") flags.apply = true;
      else if (arg === "--replace") flags.replace = true;
      else if (arg === "--allow-closed") flags.allowClosed = true;
      else if (arg === "--reconcile") flags.reconcile = true;
      else flags.json = true;
      continue;
    }
    if (!VALUE_FLAGS.has(arg)) throw new Error(`Flag desconocido "${arg}". Admitidos: ${[...VALUE_FLAGS].map((flag) => `${flag} <valor>`).join(", ")}, ${[...BOOLEAN_FLAGS].join(", ")}, --help.`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--") || value.trim() === "") throw new Error(`El flag "${arg}" necesita un valor.`);
    if (values.has(arg)) throw new Error(`${arg} solo puede indicarse una vez.`);
    values.set(arg, value.trim());
    i++;
  }

  const get = (flag: string): string | null => values.get(flag) ?? null;
  flags.type = values.has("--type") ? assertKind("--type", get("--type")!) : null;
  flags.file = get("--file");
  flags.organization = get("--organization");
  flags.entity = get("--entity");
  flags.sheet = get("--sheet");
  flags.mapping = get("--mapping");
  flags.confirm = get("--confirm");
  flags.reason = get("--reason");
  flags.balance = get("--balance");
  flags.from = get("--from");
  flags.to = get("--to");
  flags.property = get("--property");
  flags.reverse = get("--reverse");
  flags.out = get("--out");
  flags.template = values.has("--template") ? assertKind("--template", get("--template")!) : null;
  const format = get("--format");
  if (format !== null) {
    if (!(LEDGER_IMPORT_FORMATS as readonly string[]).includes(format)) throw new Error(`--format "${format}" no es un formato válido. Admitidos: ${LEDGER_IMPORT_FORMATS.join(", ")}.`);
    flags.format = format as LedgerImportFormat;
  }
  const unassigned = get("--unassigned");
  if (unassigned !== null) {
    if (!(LEDGER_UNASSIGNED_POLICIES as readonly string[]).includes(unassigned)) throw new Error(`--unassigned "${unassigned}" no es válido. Admitidos: ${LEDGER_UNASSIGNED_POLICIES.join(", ")}.`);
    flags.unassigned = unassigned as "block" | "office";
  }
  const numbering = get("--numbering");
  if (numbering !== null) {
    if (!(LEDGER_NUMBERING_DIMENSIONS as readonly string[]).includes(numbering)) throw new Error(`--numbering "${numbering}" no es válido. Admitidos: ${LEDGER_NUMBERING_DIMENSIONS.join(", ")}.`);
    flags.numbering = numbering as LedgerNumberingDimension;
  }
  if (sawDryRun && flags.apply) throw new Error("--dry-run y --apply son excluyentes.");

  if (flags.template !== null) {
    flags.mode = "template";
    if (flags.out === null) throw new Error("--template exige --out <ruta.csv>.");
    if (flags.apply || flags.reverse !== null || flags.reconcile) throw new Error("--template no se combina con --apply, --reverse ni --reconcile.");
    return flags;
  }

  if (flags.reverse !== null) {
    flags.mode = "reverse";
    if (sawDryRun) throw new Error("--reverse siempre escribe: no admite --dry-run.");
    if (flags.reason === null) throw new Error("--reverse exige --reason \"<motivo del reverso>\".");
    if (flags.confirm === null) throw new Error("--reverse exige --confirm <organizationId del lote>.");
    if (flags.type !== null || flags.file !== null || flags.reconcile || flags.replace || flags.allowClosed) throw new Error("--reverse no se combina con --type, --file, --reconcile, --replace ni --allow-closed.");
    flags.apply = true;
    return flags;
  }

  if (flags.reconcile && flags.type === null) {
    flags.mode = "reconcile";
    if (flags.balance === null) throw new Error("--reconcile suelto exige --balance <sumas-y-saldos>.");
    if (flags.from === null || flags.to === null) throw new Error("--reconcile suelto exige --from YYYY-MM-DD y --to YYYY-MM-DD.");
    if (!ISO_DAY.test(flags.from) || !ISO_DAY.test(flags.to)) throw new Error("--from y --to deben ser fechas YYYY-MM-DD.");
    if (flags.from > flags.to) throw new Error("--from debe ser igual o anterior a --to.");
    if (flags.organization === null) throw new Error("--reconcile suelto exige --organization <organizationId>.");
    if (flags.file !== null || flags.replace || flags.allowClosed || flags.apply || flags.confirm !== null) throw new Error("--reconcile suelto no se combina con --file, --replace, --allow-closed, --apply ni --confirm (escribe solo ledger_reconciliations).");
    return flags;
  }

  flags.mode = "import";
  if (flags.type === null) throw new Error(`--type <${CLI_TYPES.join("|")}> es obligatorio (salvo --reconcile suelto, --reverse y --template).`);
  if (flags.file === null) throw new Error("--file <ruta> es obligatorio.");
  if (flags.organization === null) throw new Error("--organization <organizationId> es obligatorio.");
  if (flags.apply && flags.confirm === null) throw new Error(`--apply exige --confirm ${flags.organization}.`);
  if (!flags.apply && flags.confirm !== null) throw new Error("--confirm solo tiene sentido con --apply.");
  if (flags.allowClosed && !flags.apply) throw new Error("--allow-closed solo tiene sentido con --apply.");
  if (flags.allowClosed && flags.reason === null) throw new Error("--allow-closed exige --reason \"<motivo>\" (se audita).");
  if (flags.reconcile && flags.type !== "journal") throw new Error("--reconcile dentro de un lote solo se admite con --type journal (suelto: sin --type, con --from y --to).");
  if (flags.reconcile && flags.balance === null) throw new Error("--reconcile con --type journal exige --balance <sumas-y-saldos del mismo rango>.");
  if (!flags.reconcile && flags.balance !== null) throw new Error("--balance solo tiene sentido con --reconcile.");
  if (flags.from !== null || flags.to !== null) throw new Error("--from y --to solo se admiten en la reconciliación suelta (sin --type).");
  return flags;
}

/** Con --apply (o --reverse), `--confirm` debe repetir exactamente el organizationId de destino. */
export function assertConfirmMatches(flags: Pick<ImportFlags, "apply" | "confirm" | "organization">): void {
  if (!flags.apply) return;
  if (flags.confirm === null || flags.confirm !== flags.organization) {
    throw new Error(`--confirm "${flags.confirm ?? ""}" no coincide con --organization "${flags.organization ?? ""}". Nada escrito.`);
  }
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

/** Tabla por mes de la previsualización (asientos, apuntes, Debe, Haber), ordenada por mes. */
export function formatMonthTable(rows: readonly LedgerImportPreviewMonthRow[]): string[] {
  const sorted = [...rows].sort((a, b) => a.periodCode.localeCompare(b.periodCode));
  return table(["Mes", "Asientos", "Apuntes", "Debe", "Haber"], sorted.map((row) => [row.periodCode, String(row.entries), String(row.lines), formatEs(row.debit), formatEs(row.credit)]), new Set([1, 2, 3, 4]));
}

/** Tabla por centro (código o SOC), ordenada por código. */
export function formatPropertyTable(rows: readonly LedgerImportPreviewPropertyRow[]): string[] {
  const sorted = [...rows].sort((a, b) => a.propertyCode.localeCompare(b.propertyCode));
  return table(["Centro", "Asientos", "Debe", "Haber"], sorted.map((row) => [row.propertyCode, String(row.entries), formatEs(row.debit), formatEs(row.credit)]), new Set([1, 2, 3]));
}

/** 0 solo con canPost (el servicio ya incorpora errores, cuentas sin mapear, duplicado / solape sin replace…); 1 en cualquier otro caso. */
export function dryRunExitCode(preview: Pick<LedgerImportPreview, "canPost">): 0 | 1 {
  return preview.canPost ? 0 : 1;
}

export type DryRunHeader = {
  organizationId: string;
  organizationName: string;
  legalEntityId: string | null;
  legalName: string;
  file: string;
  bytes: number;
  type: LedgerImportKind;
  requestedFormat: LedgerImportFormat | null;
  mappingFile: string | null;
  balanceFile: string | null;
};

export function formatDryRun(header: DryRunHeader, preview: LedgerImportPreview, flags: Pick<ImportFlags, "replace" | "unassigned">): string[] {
  const lines: string[] = [];
  lines.push(`${SCRIPT_LABEL} previsualización (dry-run) · organización ${header.organizationName} (${header.organizationId})`);
  lines.push(`  Sociedad: ${header.legalName}${header.legalEntityId ? ` (${header.legalEntityId})` : " (sin sociedad dada de alta)"}`);
  lines.push(`  Fichero: ${header.file} · ${formatEs(header.bytes, 0)} bytes · tipo ${header.type} (${LEDGER_IMPORT_KIND_LABELS_ES[header.type]}) · formato ${header.requestedFormat ? `${preview.format} (forzado)` : `${preview.format} (detectado)`}${header.mappingFile ? ` · mapeo ${header.mappingFile}` : ""}${header.balanceFile ? ` · balance ${header.balanceFile}` : ""}`);
  lines.push(`  Hash de contenido: ${preview.contentHash}`);
  lines.push(`  Empresa Sage: ${preview.sourceCompanyCode ?? "—"} · Ejercicio: ${preview.fiscalYearCode ?? "—"} · Rango: ${preview.periodFrom ?? "—"} → ${preview.periodTo ?? "—"} · ${formatEs(preview.rowCount, 0)} filas · ${formatEs(preview.entryCount, 0)} asientos · ${formatEs(preview.lineCount, 0)} apuntes`);
  lines.push(`  Política de apuntes 6/7 sin centro: ${flags.unassigned ?? "la del mapa analítico (block por defecto)"}`);
  lines.push("");
  lines.push("  Por mes:");
  for (const line of formatMonthTable(preview.byMonth)) lines.push(`  ${line}`);
  lines.push("  Por centro:");
  for (const line of formatPropertyTable(preview.byProperty)) lines.push(`  ${line}`);
  lines.push(`  Totales: Debe ${formatEs(preview.totalDebit)} · Haber ${formatEs(preview.totalCredit)}`);
  lines.push("");
  lines.push(`  Cuentas sin mapear: ${preview.unmappedAccounts.length === 0 ? "ninguna" : preview.unmappedAccounts.length}`);
  for (const account of preview.unmappedAccounts) {
    const suggestion = account.suggestion ? `${account.suggestion.action}${account.suggestion.accountCode ? ` → ${account.suggestion.accountCode}` : ""}` : "sin propuesta (block)";
    lines.push(`    · ${account.sourceAccount}${account.sourceName ? ` «${account.sourceName}»` : ""} (${account.lineCount} apuntes) → sugerencia: ${suggestion}`);
  }
  lines.push(`  Analítica sin mapear: ${preview.unmappedAnalytics.length === 0 ? "ninguna" : preview.unmappedAnalytics.length}`);
  for (const code of preview.unmappedAnalytics) lines.push(`    · ${code.dimension} ${code.sourceCode}${code.sourceName ? ` «${code.sourceName}»` : ""} (${code.lineCount} apuntes)`);
  lines.push(`  Asientos sin centro (6/7): ${preview.centreRequired.length === 0 ? "ninguno" : preview.centreRequired.length}`);
  for (const entry of preview.centreRequired.slice(0, 50)) lines.push(`    · asiento ${entry.sourceEntryNumber} (periodo ${entry.sourcePeriod}): ${entry.accounts.join(", ")}`);
  lines.push(`  Descuadrados: ${preview.unbalanced.length === 0 ? "ninguno" : preview.unbalanced.length}`);
  for (const entry of preview.unbalanced.slice(0, 50)) lines.push(`    · asiento ${entry.sourceEntryNumber} (periodo ${entry.sourcePeriod}): Debe ${formatEs(entry.debit)} ≠ Haber ${formatEs(entry.credit)}`);
  lines.push(`  Nativos excluidos (documentos propios de ${BRAND.name}, §5.1): ${preview.nativeSkipped.length === 0 ? "ninguno" : preview.nativeSkipped.length}`);
  for (const entry of preview.nativeSkipped.slice(0, 50)) lines.push(`    · asiento ${entry.sourceEntryNumber} (periodo ${entry.sourcePeriod}) · ${entry.invoiceNumber ?? `${entry.series ?? ""}/${entry.number ?? ""}`} · ${entry.sourceType}/${entry.sourceId}`);
  lines.push(`  Ya existentes (importados antes): ${preview.existing.length === 0 ? "ninguno" : preview.existing.length}`);
  for (const entry of preview.existing.slice(0, 50)) lines.push(`    · asiento ${entry.sourceEntryNumber} (periodo ${entry.sourcePeriod}) → ${entry.fiscalYearCode ?? "—"}/${entry.entryNumber ?? "—"}`);
  if (preview.closingDetected.length > 0) lines.push(`  Apertura / cierres de Sage detectados: ${preview.closingDetected.map((entry) => `${entry.sourceEntryNumber} (${entry.entryKind})`).join(", ")}`);
  if (preview.existingNativeEntries > 0) lines.push(`  El ejercicio ya tiene ${preview.existingNativeEntries} asiento(s) nativo(s): la numeración quedará intercalada (el nº Sage va en reference).`);
  if (preview.duplicateOf) lines.push(`  Duplicado: el mismo contenido ya está importado en el lote ${preview.duplicateOf.importId} (${preview.duplicateOf.status}, ${preview.duplicateOf.fileName ?? "sin nombre"}, ${preview.duplicateOf.createdAt})${flags.replace ? " → se revertirá ENTERO por --replace" : " → usa --replace para sustituirlo"}`);
  if (preview.overlaps.length > 0) {
    lines.push(`  Solapes: ${preview.overlaps.length} lote(s) ya cubren asientos de este fichero${flags.replace ? " → se revertirán ENTEROS por --replace" : " → usa --replace para sustituirlos"}`);
    for (const overlap of preview.overlaps.slice(0, 20)) lines.push(`    · lote ${overlap.importId} (${overlap.status}, ${overlap.periodFrom ?? "—"} → ${overlap.periodTo ?? "—"}): ${overlap.entries} asiento(s)`);
  }
  if (preview.payrollCostImportsPosted.length > 0) lines.push(`  Coste de personal ya contabilizado en el rango (la nómina real de Sage lo duplicaría): ${preview.payrollCostImportsPosted.map((row) => `${row.importId} (${row.periodFrom} → ${row.periodTo})`).join(", ")}`);
  if (preview.vatSettingsMissing) lines.push("  VatSettings: la organización no tiene fila vat_settings (bloquea vat_books; decisión pendiente + PUT /fiscal/vat-settings).");
  lines.push(`  Avisos: ${preview.warnings.length === 0 ? "ninguno" : preview.warnings.length}`);
  for (const warning of preview.warnings) lines.push(`    · ${warning}`);
  lines.push(`  Bloqueos: ${preview.blockers.length === 0 ? "ninguno" : preview.blockers.length}`);
  for (const blocker of preview.blockers) lines.push(`    · ${blocker}`);
  lines.push(`  canPost: ${preview.canPost ? "sí" : "no"}`);
  lines.push("");
  lines.push("  Nada escrito (dry-run). Para contabilizar: --apply --confirm <organizationId>.");
  return lines;
}

export function formatReconciliation(dto: LedgerReconciliationDto, indent = "  "): string[] {
  const lines: string[] = [];
  lines.push(`${indent}Reconciliación ${dto.id} · ${dto.periodFrom} → ${dto.periodTo} · centro ${dto.propertyCode} · estado ${dto.status} · ${dto.accountsCompared} cuentas comparadas · ${dto.differenceCount} diferencia(s)`);
  lines.push(`${indent}  Resumen: importe distinto ${dto.summary.amountDiff} · solo ${BRAND.name} ${dto.summary.nativeOnly} · faltan en ${BRAND.name} ${dto.summary.missingInLedger} · IVA ${dto.summary.vatDiff} · tolerancia ${formatEs(dto.summary.tolerance)}`);
  const differences = dto.rows.filter((row) => !row.ok);
  for (const row of differences.slice(0, 50)) {
    lines.push(`${indent}  · ${row.accountCode}${row.accountName ? ` «${row.accountName}»` : ""} (${row.sourceAccounts.join(", ") || "—"}): Sage D ${formatEs(row.sourceDebit)} / H ${formatEs(row.sourceCredit)} · ${BRAND.name} D ${formatEs(row.ledgerDebit)} / H ${formatEs(row.ledgerCredit)} · dif. saldo ${formatEs(row.diffBalance)} · ${row.classification ? LEDGER_RECONCILIATION_CLASSIFICATION_LABELS_ES[row.classification] : "—"}${row.note ? ` · ${row.note}` : ""}`);
  }
  if (differences.length > 50) lines.push(`${indent}  … y ${differences.length - 50} diferencia(s) más (CSV: GET /accounting/ledger-imports/reconciliation/${dto.id}/csv).`);
  for (const entry of dto.missingEntries.slice(0, 20)) lines.push(`${indent}  · asiento Sage ${entry.sourceEntryNumber} (periodo ${entry.sourcePeriod}) no llegó al diario: ${entry.status}`);
  return lines;
}

export function formatApplyResult(result: LedgerImportCreateResult): string[] {
  const lines: string[] = [];
  const record = result.import;
  const numbered = result.entries.filter((entry) => entry.entryNumber !== null);
  const first = numbered.length ? numbered.reduce((min, entry) => (entry.entryNumber! < min.entryNumber! ? entry : min)) : null;
  const last = numbered.length ? numbered.reduce((max, entry) => (entry.entryNumber! > max.entryNumber! ? entry : max)) : null;
  lines.push(`${SCRIPT_LABEL} lote ${record.id} ${record.status === "posted" ? "contabilizado" : record.status} · ${record.kind} (${LEDGER_IMPORT_KIND_LABELS_ES[record.kind]}) · ${record.fileName ?? "sin nombre"} · ${record.periodFrom ?? "—"} → ${record.periodTo ?? "—"} · ${formatEs(record.rowCount, 0)} filas`);
  lines.push(`  Creados: ${result.created} · omitidos: ${result.skipped} · asientos del lote: ${record.journalEntryIds.length}${first && last ? ` (nº ${first.entryNumber} → ${last.entryNumber}, ejercicio ${first.fiscalYearCode ?? "—"})` : ""}`);
  lines.push(`  Debe ${formatEs(record.totalDebit)} · Haber ${formatEs(record.totalCredit)} · hash ${record.contentHash} · createdBy ${record.createdBy ?? "—"}`);
  if (record.notes) lines.push(`  Notas: ${record.notes}`);
  if (result.warnings.length > 0) {
    lines.push(`  Avisos (${result.warnings.length}):`);
    for (const warning of result.warnings) lines.push(`    · ${warning}`);
  }
  for (const entry of result.entries.slice(0, 200)) {
    lines.push(`    · ${entry.status} · ${entry.fiscalYearCode ?? "—"}/${entry.entryNumber ?? "—"} · ${entry.propertyCode} · ${entry.entryDate} · Sage ${entry.sourceFiscalYear}/${entry.sourceEntryNumber} (periodo ${entry.sourcePeriod}) · D ${formatEs(entry.debit)} · H ${formatEs(entry.credit)}${entry.sourceType && entry.sourceId ? ` · ${entry.sourceType}/${entry.sourceId}` : ""}`);
  }
  if (result.entries.length > 200) lines.push(`    … y ${result.entries.length - 200} entrada(s) más (GET /accounting/ledger-imports/${record.id}).`);
  if (result.reconciliation) lines.push(...formatReconciliation(result.reconciliation));
  return lines;
}

export function formatReverseResult(record: LedgerImportRecord & { alreadyReversed: boolean }): string[] {
  return [
    `${SCRIPT_LABEL} lote ${record.id} ${record.alreadyReversed ? "ya estaba revertido (idempotente, nada escrito)" : "revertido"} · ${record.kind} · ${record.fileName ?? "sin nombre"} · ${record.periodFrom ?? "—"} → ${record.periodTo ?? "—"}`,
    `  Asientos del lote: ${record.journalEntryIds.length} · reversos: ${record.reversalJournalEntryIds.length} · motivo: ${record.reversalReason ?? "—"} · reversedBy ${record.reversedBy ?? "—"} · ${record.reversedAt ?? "—"}`
  ];
}

/** Líneas legibles de un HttpError del servicio (code + details relevantes) y «Nada escrito». */
export function formatHttpError(error: HttpError): string[] {
  const details = (error.details ?? {}) as Record<string, unknown>;
  const code = typeof details.code === "string" ? details.code : `HTTP_${error.statusCode}`;
  const lines = [`${SCRIPT_LABEL} ${code} (${error.statusCode}): ${error.message}`];
  if (typeof details.importId === "string") lines.push(`  Lote afectado: ${details.importId}${typeof details.status === "string" ? ` (${details.status})` : ""} → --replace lo revertiría ENTERO antes de crear el nuevo.`);
  if (Array.isArray(details.overlaps)) lines.push(`  Solapes: ${details.overlaps.length} lote(s) → --replace revertiría ENTEROS los lotes afectados.`);
  if (Array.isArray(details.accounts)) lines.push(`  Cuentas: ${(details.accounts as unknown[]).map((item) => (typeof item === "object" && item !== null && "sourceAccount" in item ? String((item as { sourceAccount: unknown }).sourceAccount) : String(item))).join(", ")}`);
  if (Array.isArray(details.codes)) lines.push(`  Códigos analíticos: ${(details.codes as unknown[]).map((item) => (typeof item === "object" && item !== null && "sourceCode" in item ? String((item as { sourceCode: unknown }).sourceCode) : String(item))).join(", ")}`);
  if (Array.isArray(details.entries)) lines.push(`  Asientos: ${(details.entries as unknown[]).slice(0, 20).map((item) => (typeof item === "object" && item !== null && "sourceEntryNumber" in item ? String((item as { sourceEntryNumber: unknown }).sourceEntryNumber) : String(item))).join(", ")}${details.entries.length > 20 ? ` … (${details.entries.length})` : ""}`);
  if (Array.isArray(details.errors)) for (const item of (details.errors as Array<{ line?: number | null; message?: string; index?: number; sourceAccount?: string; sourceCode?: string }>).slice(0, 50)) lines.push(`    · ${item.line != null ? `línea ${item.line}` : item.sourceAccount ?? item.sourceCode ?? (item.index != null ? `#${item.index}` : "fichero")}: ${item.message ?? ""}`);
  if (Array.isArray(details.issues)) for (const item of (details.issues as Array<{ path?: string; message?: string }>).slice(0, 20)) lines.push(`    · ${item.path || "cuerpo"}: ${item.message ?? ""}`);
  if (Array.isArray(details.blocks)) lines.push(`  Bloques del XML: ${(details.blocks as unknown[]).map(String).join(", ")}`);
  if (typeof details.bytes === "number" && typeof details.max === "number") lines.push(`  Tamaño: ${formatEs(details.bytes, 0)} bytes (máximo ${formatEs(details.max, 0)}).`);
  lines.push("  Nada escrito.");
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
    fullName: "Importación contable desde Sage 200 (CLI)",
    deviceId: CREATED_BY,
    permissions: [...CLI_PERMISSIONS],
    isPlatformAdmin: false
  };
}

export type RunOutcome = { exitCode: 0 | 1; json: unknown; lines: string[] };

async function organizationContext(organizationId: string): Promise<{ context: UserContext; organizationName: string }> {
  const organization = await prisma.organization.findUnique({ where: { id: organizationId }, select: { id: true, name: true } });
  if (!organization) throw new Error(`Organización "${organizationId}" no encontrada. Nada escrito.`);
  const firstProperty = await prisma.property.findFirst({ where: { organizationId }, orderBy: { createdAt: "asc" }, select: { id: true } });
  if (!firstProperty) throw new Error(`La organización "${organizationId}" no tiene centros de trabajo: da de alta los centros antes de importar. Nada escrito.`);
  return { context: systemContext(organizationId, firstProperty.id), organizationName: organization.name };
}

async function propertyIdByCode(organizationId: string, code: string): Promise<string> {
  const property = await prisma.property.findFirst({ where: { organizationId, code }, select: { id: true } });
  if (!property) throw new Error(`El centro "${code}" no existe en la organización "${organizationId}". Nada escrito.`);
  return property.id;
}

function readBase64(path: string): { fileName: string; bytes: number; contentBase64: string } {
  const absolute = resolvePath(path);
  const buffer = readFileSync(absolute);
  return { fileName: basename(absolute), bytes: buffer.length, contentBase64: buffer.toString("base64") };
}

/** `--mapping <ruta.json>` validado con el mismo esquema que la ruta HTTP (400 VALIDATION_ERROR si no cumple). */
export function readMappingFile(path: string): LedgerImportMappingInput {
  const raw = readFileSync(resolvePath(path), "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`--mapping "${path}" no es JSON válido: ${(error as Error).message}`);
  }
  return parseOr400(LedgerImportMappingSchema, parsed, "mapping") as LedgerImportMappingInput;
}

async function flushAll(): Promise<void> {
  await flushAuditQueues();
  await flushAccountingProjection();
  await flushExtraProjections();
}

function printAuditForkWarning(): void {
  console.error(`${SCRIPT_LABEL} aviso: con el API en marcha su cadena de auditoría en memoria se bifurca (accounting-replay.ts): reinícialo tras esta ejecución.`);
}

async function runTemplate(flags: ImportFlags): Promise<RunOutcome> {
  const file = buildLedgerImportTemplate(flags.template!);
  const out = resolvePath(flags.out!);
  writeFileSync(out, file.content, "utf8");
  return { exitCode: 0, json: { mode: "template", type: flags.template, out, fileName: file.fileName, bytes: Buffer.byteLength(file.content, "utf8"), exitCode: 0 }, lines: [`${SCRIPT_LABEL} plantilla ${file.fileName} (${flags.template}) escrita en ${out} (${formatEs(Buffer.byteLength(file.content, "utf8"), 0)} bytes).`] };
}

async function runReverse(flags: ImportFlags): Promise<RunOutcome> {
  const importId = flags.reverse!;
  const row = await prisma.ledgerImport.findUnique({ where: { id: importId }, select: { id: true, organizationId: true, status: true, kind: true } });
  if (!row) throw new Error(`Lote "${importId}" no encontrado. Nada escrito.`);
  if (flags.organization !== null && flags.organization !== row.organizationId) throw new Error(`El lote "${importId}" no pertenece a la organización "${flags.organization}". Nada escrito.`);
  assertConfirmMatches({ apply: true, confirm: flags.confirm, organization: row.organizationId });
  const { context, organizationName } = await organizationContext(row.organizationId);
  printAuditForkWarning();
  await hydrateAuditChainFromPostgres();
  try {
    const record = await reverseLedgerImport({ context, importId, reason: flags.reason!, correlationId: CORRELATION_ID, actorType: "system" });
    return { exitCode: 0, json: { mode: "reverse", organizationId: row.organizationId, organizationName, record, exitCode: 0 }, lines: formatReverseResult(record) };
  } catch (error) {
    if (error instanceof HttpError) return { exitCode: 1, json: { mode: "reverse", organizationId: row.organizationId, organizationName, error: { statusCode: error.statusCode, message: error.message, details: error.details ?? {} }, exitCode: 1 }, lines: formatHttpError(error) };
    throw error;
  } finally {
    await flushAll();
  }
}

async function runReconcile(flags: ImportFlags): Promise<RunOutcome> {
  const organizationId = flags.organization!;
  const { context, organizationName } = await organizationContext(organizationId);
  const propertyId = flags.property !== null ? await propertyIdByCode(organizationId, flags.property) : undefined;
  const balance = readBase64(flags.balance!);
  const header = { organizationId, organizationName, balanceFile: balance.fileName, bytes: balance.bytes, from: flags.from!, to: flags.to!, property: flags.property };
  printAuditForkWarning();
  await hydrateAuditChainFromPostgres();
  try {
    const dto = await reconcileLedger({
      context,
      body: { from: flags.from!, to: flags.to!, propertyId, format: flags.format ?? undefined, contentBase64: balance.contentBase64, sheetName: flags.sheet ?? undefined },
      createdBy: CREATED_BY,
      correlationId: CORRELATION_ID,
      actorType: "system"
    });
    const exitCode: 0 | 1 = dto.status === "ok" ? 0 : 1;
    return { exitCode, json: { mode: "reconcile", header, reconciliation: dto, exitCode }, lines: [`${SCRIPT_LABEL} reconciliación · organización ${organizationName} (${organizationId}) · balance ${balance.fileName} (${formatEs(balance.bytes, 0)} bytes)`, ...formatReconciliation(dto)] };
  } catch (error) {
    if (error instanceof HttpError) return { exitCode: 1, json: { mode: "reconcile", header, error: { statusCode: error.statusCode, message: error.message, details: error.details ?? {} }, exitCode: 1 }, lines: formatHttpError(error) };
    throw error;
  } finally {
    await flushAll();
  }
}

async function runLot(flags: ImportFlags): Promise<RunOutcome> {
  assertConfirmMatches(flags);
  const organizationId = flags.organization!;
  const type = flags.type!;
  const file = readBase64(flags.file!);
  const mapping = flags.mapping !== null ? readMappingFile(flags.mapping) : undefined;
  const balance = flags.reconcile && flags.balance !== null ? readBase64(flags.balance) : null;
  const { context, organizationName } = await organizationContext(organizationId);
  const scope = await resolveLedgerScope(context, { legalEntityId: flags.entity ?? undefined });
  const header: DryRunHeader = {
    organizationId,
    organizationName,
    legalEntityId: scope.legalEntityId,
    legalName: scope.identity.legalName,
    file: file.fileName,
    bytes: file.bytes,
    type,
    requestedFormat: flags.format,
    mappingFile: flags.mapping !== null ? basename(flags.mapping) : null,
    balanceFile: balance?.fileName ?? null
  };
  const options: LedgerImportOptions = {
    ...(flags.unassigned !== null ? { unassignedPolicy: flags.unassigned } : {}),
    ...(flags.numbering !== null ? { numberingDimension: flags.numbering } : {}),
    ...(flags.replace ? { replace: true } : {}),
    ...(flags.reconcile ? { reconcile: true } : {}),
    ...(flags.allowClosed ? { allowClosed: true } : {})
  };
  const body = { kind: type, format: flags.format ?? undefined, fileName: file.fileName, contentBase64: file.contentBase64, sheetName: flags.sheet ?? undefined, mapping, options };

  if (!flags.apply) {
    try {
      const preview = await previewLedgerImport({ context, body: { ...body, options: { ...options, allowClosed: undefined } }, legalEntityId: flags.entity ?? null });
      const exitCode = dryRunExitCode(preview);
      return { exitCode, json: { mode: "dry-run", header, preview, exitCode }, lines: formatDryRun(header, preview, flags) };
    } catch (error) {
      if (error instanceof HttpError) return { exitCode: 1, json: { mode: "dry-run", header, error: { statusCode: error.statusCode, message: error.message, details: error.details ?? {} }, exitCode: 1 }, lines: formatHttpError(error) };
      throw error;
    }
  }

  printAuditForkWarning();
  await hydrateAuditChainFromPostgres();
  try {
    const result = await createLedgerImport({
      context,
      body: { ...body, post: true, notes: flags.allowClosed ? `--allow-closed: ${flags.reason}` : undefined },
      createdBy: CREATED_BY,
      correlationId: CORRELATION_ID,
      legalEntityId: flags.entity ?? null,
      balance: balance ? { contentBase64: balance.contentBase64, fileName: balance.fileName, sheetName: flags.sheet ?? undefined, propertyId: flags.property !== null ? await propertyIdByCode(organizationId, flags.property) : null } : undefined,
      actorType: "system"
    });
    return { exitCode: 0, json: { mode: "apply", header, result, exitCode: 0 }, lines: formatApplyResult(result) };
  } catch (error) {
    if (error instanceof HttpError) return { exitCode: 1, json: { mode: "apply", header, error: { statusCode: error.statusCode, message: error.message, details: error.details ?? {} }, exitCode: 1 }, lines: formatHttpError(error) };
    throw error;
  } finally {
    await flushAll();
  }
}

export async function runImport(flags: ImportFlags): Promise<RunOutcome> {
  switch (flags.mode) {
    case "template":
      return runTemplate(flags);
    case "reverse":
      return runReverse(flags);
    case "reconcile":
      return runReconcile(flags);
    default:
      return runLot(flags);
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
