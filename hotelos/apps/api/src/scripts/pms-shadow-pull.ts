// CLI del modo sombra OPERA Cloud (Tanda 7b · L3 · diseño §6.5): agente de carpeta
// SFTP (o de un fichero suelto) que entrega cada corte al ingest.
//
//   · Dry-run (por defecto): lista los ficheros de la carpeta (csv, txt, xml, xlsx),
//     su tamaño y el feed que se clasifica por nombre / cabecera; no escribe nada.
//   · --apply en modo HTTP (recomendado con el API en marcha): POST
//     /integrations/pms-shadow/ingest con `X-Api-Key: <clientId>.<clientSecret>` de la
//     DeveloperApp con scope pms.shadow.ingest (--ingest-url + --api-key), fetch nativo.
//     Un 202 (run done | partial | failed) o un 409 PMS_SHADOW_RUN_DUPLICATE dan el
//     fichero por entregado y, con --move-to, lo archivan en esa carpeta (`procesados/`).
//   · --apply en modo directo (sin --ingest-url): llama a ingestPmsShadowFile con el
//     contexto de sistema de pms-shadow.rules.ts. AVISO: el API debe estar parado (cadena
//     de auditoría in-memory, deuda 12(c)); pensado para el arranque y la carga histórica.
//   · Sin lecturas de process.env (corrección g): todo por flags.
//
// Códigos de salida: 0 ok · 1 fallo (fichero no entregado, run fallido, error de dominio
// o de BD) · 2 flag desconocido / uso.
//
//   cd apps/api && node --env-file-if-exists=../../.env --import tsx src/scripts/pms-shadow-pull.ts \
//     --property <propertyId> --folder <dir> [--feed auto] [--business-date YYYY-MM-DD] [--move-to <dir>] \
//     [--dry-run | --apply] [--ingest-url http://localhost:3000 --api-key <clientId.secret>] [--json]

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
import { BRAND } from "../lib/brand.js";
import { basename, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "@hotelos/database";
import { PMS_SHADOW_FEEDS, PMS_SHADOW_INGEST_HEADER, PMS_SHADOW_MAX_FILE_BYTES, type PmsShadowFeed, type PmsShadowRunAlert, type PmsShadowRunStatus } from "@hotelos/shared";
import { HttpError } from "../lib/http-error.js";
import { flushAccountingProjection } from "../modules/accounting/projection.js";
import { flushExtraProjections } from "../modules/accounting/posting-rules/index.js";
import { flushAuditQueues, hydrateAuditChainFromPostgres } from "../modules/audit/audit.service.js";
import { PMS_SHADOW_ATTACHMENT_EXTENSIONS, attachmentExtension, classifyFeed, isIsoDate, systemContext } from "../modules/pms-shadow/pms-shadow.rules.js";
import { ingestPmsShadowFile } from "../modules/pms-shadow/pms-shadow.service.js";

export const SCRIPT_LABEL = "[pms-shadow:pull]";
export const CORRELATION_PREFIX = "corr_pms_shadow_pull";
export const INGEST_PATH = "/integrations/pms-shadow/ingest";

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

export type PullFlags = {
  property: string | null;
  folder: string | null;
  file: string | null;
  feed: PmsShadowFeed | "auto";
  businessDate: string | null;
  moveTo: string | null;
  apply: boolean;
  ingestUrl: string | null;
  apiKey: string | null;
  json: boolean;
  help: boolean;
};

export const USAGE = [
  "Uso (desde apps/api, DATABASE_URL en el entorno o ../../.env solo para el modo directo):",
  "  node --env-file-if-exists=../../.env --import tsx src/scripts/pms-shadow-pull.ts \\",
  "    --property <propertyId> (--folder <dir> | --file <ruta>) [--feed <feed|auto>] [--business-date YYYY-MM-DD] \\",
  "    [--move-to <dir>] [--dry-run | --apply] [--ingest-url <url> --api-key <clientId.secret>] [--json]",
  "  (equivalente: corepack pnpm --filter @hotelos/api pms-shadow:pull -- --property … --folder …)",
  "",
  "  --property <id>          propiedad destino (su perfil de modo sombra decide código OPERA, mapeos y programación)",
  "  --folder <dir>           carpeta con los cortes (SFTP local del VPS): se toman los .csv/.txt/.xml/.xlsx, por nombre",
  "  --file <ruta>            un solo fichero (carga manual, p. ej. --feed revenue --file GEN_XMLBO_REVENUE.xml)",
  `  --feed <feed|auto>       feed de TODOS los ficheros (${PMS_SHADOW_FEEDS.join(", ")}) o auto (por nombre / cabecera; defecto)`,
  `  --business-date <fecha>  business date del corte (recomendado: en modo sombra el business date de ${BRAND.name} no avanza);`,
  "                           sin él, el API usa el business date actual + offset del feed, y en revenue la fecha del XML",
  "  --move-to <dir>          tras entregar (202 o 409 duplicado) mueve el fichero a esa carpeta (p. ej. procesados/); solo con --apply",
  "  --dry-run                (por defecto) lista los ficheros y su feed clasificado; no escribe nada; salida 0",
  "  --apply                  entrega cada fichero al ingest",
  "  --ingest-url <url>       modo HTTP (recomendado con el API en marcha): origen del API (http://localhost:3000) o la URL del ingest",
  "  --api-key <clave>        `<clientId>.<clientSecret>` de la DeveloperApp con scope pms.shadow.ingest (va con --ingest-url);",
  "                           mejor por entorno: PMS_SHADOW_INGEST_URL y PMS_SHADOW_API_KEY (la clave en argv queda en ps / crontab / historial)",
  "  --json                   resultado legible por máquina",
  "  --help, -h               esta ayuda",
  "",
  "Modo directo (--apply sin --ingest-url): llama al servicio con el contexto de sistema usr_system_pms_shadow;",
  "AVISO: ejecutarlo con los API parados (cadena de auditoría in-memory). Los ficheros nunca se guardan en la BD.",
  "Códigos de salida: 0 ok · 1 fallo (fichero no entregado, run fallido, error de dominio o de BD) · 2 flag desconocido / uso."
].join("\n");

const VALUE_FLAGS = new Set(["--property", "--folder", "--file", "--feed", "--business-date", "--move-to", "--ingest-url", "--api-key"]);
const KNOWN_FLAGS = "--property <id>, --folder <dir>, --file <ruta>, --feed <feed|auto>, --business-date <fecha>, --move-to <dir>, --dry-run, --apply, --ingest-url <url>, --api-key <clave>, --json, --help";

function isFeedFlag(value: string): value is PmsShadowFeed | "auto" {
  return value === "auto" || (PMS_SHADOW_FEEDS as readonly string[]).includes(value);
}

export function parseFlags(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): PullFlags {
  const flags: PullFlags = { property: null, folder: null, file: null, feed: "auto", businessDate: null, moveTo: null, apply: false, ingestUrl: null, apiKey: null, json: false, help: false };
  let sawDryRun = false;
  let sawFeed = false;
  const once = (name: string, current: unknown): void => {
    if (current !== null) throw new Error(`${name} solo puede indicarse una vez.`);
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") return { ...flags, help: true };
    if (arg === "--dry-run") sawDryRun = true;
    else if (arg === "--apply") flags.apply = true;
    else if (arg === "--json") flags.json = true;
    else if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--") || value.trim() === "") throw new Error(`El flag "${arg}" necesita un valor.`);
      const trimmed = value.trim();
      switch (arg) {
        case "--property":
          once(arg, flags.property);
          flags.property = trimmed;
          break;
        case "--folder":
          once(arg, flags.folder);
          flags.folder = trimmed;
          break;
        case "--file":
          once(arg, flags.file);
          flags.file = trimmed;
          break;
        case "--feed":
          if (sawFeed) throw new Error("--feed solo puede indicarse una vez.");
          sawFeed = true;
          if (!isFeedFlag(trimmed)) throw new Error(`--feed debe ser uno de: ${PMS_SHADOW_FEEDS.join(", ")} o auto (recibido "${trimmed}").`);
          flags.feed = trimmed;
          break;
        case "--business-date":
          once(arg, flags.businessDate);
          if (!isIsoDate(trimmed)) throw new Error(`--business-date debe ser una fecha AAAA-MM-DD (recibido "${trimmed}").`);
          flags.businessDate = trimmed;
          break;
        case "--move-to":
          once(arg, flags.moveTo);
          flags.moveTo = trimmed;
          break;
        case "--ingest-url":
          once(arg, flags.ingestUrl);
          flags.ingestUrl = trimmed;
          break;
        default:
          once(arg, flags.apiKey);
          flags.apiKey = trimmed;
      }
      i++;
    } else if (arg === "--") continue;
    else throw new Error(`Flag desconocido "${arg}". Admitidos: ${KNOWN_FLAGS}.`);
  }
  // SEC-06: la clave por argv queda visible en `ps`, en el crontab y en el historial del shell del VPS.
  // Si faltan los flags se leen PMS_SHADOW_INGEST_URL / PMS_SHADOW_API_KEY del entorno del agente
  // (recomendado: fichero de entorno del cron con permisos 600), como documenta el runbook.
  if (flags.ingestUrl === null && typeof env.PMS_SHADOW_INGEST_URL === "string" && env.PMS_SHADOW_INGEST_URL.trim() !== "") flags.ingestUrl = env.PMS_SHADOW_INGEST_URL.trim();
  if (flags.apiKey === null && typeof env.PMS_SHADOW_API_KEY === "string" && env.PMS_SHADOW_API_KEY.trim() !== "") flags.apiKey = env.PMS_SHADOW_API_KEY.trim();
  if (sawDryRun && flags.apply) throw new Error("--dry-run y --apply son excluyentes.");
  if (flags.property === null) throw new Error("--property <propertyId> es obligatorio.");
  if (flags.folder === null && flags.file === null) throw new Error("Indica --folder <dir> o --file <ruta>.");
  if (flags.folder !== null && flags.file !== null) throw new Error("--folder y --file son excluyentes.");
  if ((flags.ingestUrl === null) !== (flags.apiKey === null)) throw new Error("--ingest-url y --api-key van juntos.");
  if (flags.moveTo !== null && !flags.apply) throw new Error("--move-to solo tiene sentido con --apply.");
  if (flags.apiKey !== null && !/^cli_[A-Za-z0-9_-]+\.[^\s]+$/.test(flags.apiKey)) throw new Error("--api-key (o PMS_SHADOW_API_KEY) debe tener la forma <clientId>.<clientSecret> (cli_….…).");
  return flags;
}

// ---------------------------------------------------------------------------
// Ficheros (puro salvo la lectura de disco)
// ---------------------------------------------------------------------------

export type CandidateFile = { path: string; fileName: string; bytes: number };

/**
 * Ficheros regulares de la carpeta con extensión csv | txt | xml | xlsx, ordenados por nombre; los
 * ocultos, las carpetas y los ENLACES SIMBÓLICOS se saltan (SEC-10: `lstat`, no `stat`; un symlink
 * dejado en la carpeta SFTP haría que el agente leyera cualquier fichero legible por su usuario).
 */
export function listCandidateFiles(folder: string): CandidateFile[] {
  const dir = resolvePath(folder);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`La carpeta "${folder}" no existe o no es un directorio.`);
  return readdirSync(dir)
    .filter((name) => !name.startsWith(".") && (PMS_SHADOW_ATTACHMENT_EXTENSIONS as readonly string[]).includes(attachmentExtension(name)))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => join(dir, name))
    .map((path) => ({ path, stat: lstatSync(path) }))
    .filter(({ stat }) => stat.isFile() && !stat.isSymbolicLink())
    .map(({ path, stat }) => ({ path, fileName: basename(path), bytes: stat.size }));
}

export function singleFile(path: string): CandidateFile {
  const abs = resolvePath(path);
  if (!existsSync(abs)) throw new Error(`El fichero "${path}" no existe.`);
  const stat = lstatSync(abs);
  if (stat.isSymbolicLink()) throw new Error(`El fichero "${path}" es un enlace simbólico: no se admite (SEC-10).`);
  if (!stat.isFile()) throw new Error(`El fichero "${path}" no existe.`);
  return { path: abs, fileName: basename(abs), bytes: stat.size };
}

/** Feed efectivo de un fichero: el flag o la clasificación por nombre / primeros 4 KiB. */
export function classifyFile(file: CandidateFile, feedFlag: PmsShadowFeed | "auto", head: string): PmsShadowFeed | null {
  return feedFlag !== "auto" ? feedFlag : classifyFeed({ fileName: file.fileName, head });
}

/** `--ingest-url` = origen del API o URL completa del ingest → URL completa. */
export function ingestEndpoint(ingestUrl: string): string {
  const trimmed = ingestUrl.replace(/\/+$/, "");
  return trimmed.endsWith(INGEST_PATH) ? trimmed : `${trimmed}${INGEST_PATH}`;
}

function formatEs(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

// ---------------------------------------------------------------------------
// Resultado por fichero
// ---------------------------------------------------------------------------

export type FileOutcome = {
  fileName: string;
  bytes: number;
  feed: PmsShadowFeed | null;
  delivered: boolean;
  runId: string | null;
  status: PmsShadowRunStatus | "duplicate" | "error" | "skipped";
  counts: Record<string, number> | null;
  alerts: string[];
  error: { statusCode: number | null; code: string | null; message: string } | null;
  movedTo: string | null;
};

type IngestResponse = { runId?: string; status?: PmsShadowRunStatus; counts?: Record<string, number>; alerts?: PmsShadowRunAlert[]; message?: string; details?: { code?: string; runId?: string } };

function baseOutcome(file: CandidateFile, feed: PmsShadowFeed | null): FileOutcome {
  return { fileName: file.fileName, bytes: file.bytes, feed, delivered: false, runId: null, status: "skipped", counts: null, alerts: [], error: null, movedTo: null };
}

function moveFile(file: CandidateFile, moveTo: string | null): string | null {
  if (!moveTo) return null;
  const dir = resolvePath(moveTo);
  mkdirSync(dir, { recursive: true });
  let target = join(dir, file.fileName);
  if (existsSync(target)) target = join(dir, `${Date.now()}-${file.fileName}`);
  renameSync(file.path, target);
  return target;
}

async function deliverHttp(file: CandidateFile, bytes: Buffer, flags: PullFlags, feed: PmsShadowFeed | null): Promise<FileOutcome> {
  const outcome = baseOutcome(file, feed);
  const body = {
    propertyId: flags.property,
    feed: flags.feed,
    fileName: file.fileName,
    contentBase64: bytes.toString("base64"),
    ...(flags.businessDate ? { businessDate: flags.businessDate } : {})
  };
  const res = await fetch(ingestEndpoint(flags.ingestUrl!), {
    method: "POST",
    headers: { "content-type": "application/json", [PMS_SHADOW_INGEST_HEADER]: flags.apiKey! },
    body: JSON.stringify(body)
  });
  let parsed: IngestResponse = {};
  try {
    parsed = (await res.json()) as IngestResponse;
  } catch {
    parsed = {};
  }
  if (res.status === 202) {
    outcome.delivered = true;
    outcome.runId = parsed.runId ?? null;
    outcome.status = parsed.status ?? "done";
    outcome.counts = parsed.counts ?? null;
    outcome.alerts = (parsed.alerts ?? []).map((alert) => alert.code);
    outcome.movedTo = moveFile(file, flags.moveTo);
    return outcome;
  }
  const code = parsed.details?.code ?? null;
  if (res.status === 409 && code === "PMS_SHADOW_RUN_DUPLICATE") {
    outcome.delivered = true;
    outcome.status = "duplicate";
    outcome.runId = parsed.details?.runId ?? null;
    outcome.movedTo = moveFile(file, flags.moveTo);
    return outcome;
  }
  outcome.status = "error";
  outcome.error = { statusCode: res.status, code, message: parsed.message ?? `HTTP ${res.status}` };
  return outcome;
}

async function deliverDirect(file: CandidateFile, bytes: Buffer, flags: PullFlags, feed: PmsShadowFeed | null, organizationId: string, index: number): Promise<FileOutcome> {
  const outcome = baseOutcome(file, feed);
  try {
    const result = await ingestPmsShadowFile({
      context: systemContext(organizationId, flags.property!),
      propertyId: flags.property!,
      source: "cli",
      feed: flags.feed,
      fileName: file.fileName,
      bytes,
      businessDate: flags.businessDate,
      correlationId: `${CORRELATION_PREFIX}_${index}`
    });
    outcome.delivered = true;
    outcome.runId = result.runId;
    outcome.status = result.status;
    outcome.counts = result.counts;
    outcome.alerts = result.alerts.map((alert) => alert.code);
    outcome.movedTo = moveFile(file, flags.moveTo);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    const details = (error.details ?? {}) as { code?: unknown; runId?: unknown };
    const code = typeof details.code === "string" ? details.code : null;
    if (error.statusCode === 409 && code === "PMS_SHADOW_RUN_DUPLICATE") {
      outcome.delivered = true;
      outcome.status = "duplicate";
      outcome.runId = typeof details.runId === "string" ? details.runId : null;
      outcome.movedTo = moveFile(file, flags.moveTo);
    } else {
      outcome.status = "error";
      outcome.error = { statusCode: error.statusCode, code, message: error.message };
    }
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Ejecución
// ---------------------------------------------------------------------------

export type RunOutcome = { exitCode: 0 | 1; json: unknown; lines: string[] };

function describeOutcome(outcome: FileOutcome): string {
  const feed = outcome.feed ?? "sin reconocer";
  if (outcome.status === "error") return `  ✗ ${outcome.fileName} (${feed}): ${outcome.error?.code ?? "ERROR"} ${outcome.error?.statusCode ?? ""} — ${outcome.error?.message ?? ""}`.trimEnd();
  if (outcome.status === "duplicate") return `  = ${outcome.fileName} (${feed}): ya recibido (run ${outcome.runId ?? "?"})${outcome.movedTo ? ` → ${outcome.movedTo}` : ""}`;
  const counts = outcome.counts ? ` · creadas ${outcome.counts.created ?? 0} / actualizadas ${outcome.counts.updated ?? 0} / sin cambios ${outcome.counts.unchanged ?? 0} / transiciones ${outcome.counts.transitioned ?? 0} / omitidas ${outcome.counts.skipped ?? 0} / errores ${outcome.counts.error ?? 0}` : "";
  const alerts = outcome.alerts.length > 0 ? ` · alertas: ${outcome.alerts.join(", ")}` : "";
  const mark = outcome.status === "failed" ? "✗" : outcome.status === "partial" ? "!" : "✓";
  return `  ${mark} ${outcome.fileName} (${feed}): run ${outcome.runId ?? "?"} ${outcome.status}${counts}${alerts}${outcome.movedTo ? ` → ${outcome.movedTo}` : ""}`;
}

export async function runPull(flags: PullFlags): Promise<RunOutcome> {
  const files = flags.file !== null ? [singleFile(flags.file)] : listCandidateFiles(flags.folder!);
  const mode = !flags.apply ? "dry-run" : flags.ingestUrl ? "http" : "direct";
  const header = `${SCRIPT_LABEL} propiedad ${flags.property} · ${flags.file !== null ? `fichero ${flags.file}` : `carpeta ${resolvePath(flags.folder!)}`} · ${files.length} fichero(s) · feed ${flags.feed} · business date ${flags.businessDate ?? "(por defecto del API)"} · modo ${mode}`;

  if (mode === "dry-run") {
    const rows = files.map((file) => {
      const head = readFileSync(file.path).subarray(0, 4096).toString("utf8");
      const feed = classifyFile(file, flags.feed, head);
      const tooLarge = file.bytes > PMS_SHADOW_MAX_FILE_BYTES;
      return { fileName: file.fileName, bytes: file.bytes, feed, tooLarge };
    });
    const lines = [header, ...rows.map((row) => `  · ${row.fileName} — ${formatEs(row.bytes)} bytes — feed ${row.feed ?? "SIN RECONOCER (indica --feed)"}${row.tooLarge ? " — SUPERA 5 MiB" : ""}`)];
    if (rows.length === 0) lines.push("  (ningún fichero .csv/.txt/.xml/.xlsx)");
    lines.push("  Nada escrito (dry-run). Usa --apply con --ingest-url y --api-key para entregarlos al ingest.");
    return { exitCode: 0, json: { mode, propertyId: flags.property, folder: flags.folder, file: flags.file, feed: flags.feed, businessDate: flags.businessDate, files: rows, exitCode: 0 }, lines };
  }

  const outcomes: FileOutcome[] = [];
  if (mode === "http") {
    for (const file of files) {
      const bytes = readFileSync(file.path);
      const feed = classifyFile(file, flags.feed, bytes.subarray(0, 4096).toString("utf8"));
      outcomes.push(await deliverHttp(file, bytes, flags, feed));
    }
  } else {
    const property = await prisma.property.findUnique({ where: { id: flags.property! }, select: { id: true, organizationId: true } });
    if (!property) throw new Error(`Propiedad "${flags.property}" no encontrada. Nada escrito.`);
    await hydrateAuditChainFromPostgres();
    try {
      let index = 0;
      for (const file of files) {
        index += 1;
        const bytes = readFileSync(file.path);
        const feed = classifyFile(file, flags.feed, bytes.subarray(0, 4096).toString("utf8"));
        outcomes.push(await deliverDirect(file, bytes, flags, feed, property.organizationId, index));
      }
    } finally {
      await flushAuditQueues();
      await flushAccountingProjection();
      await flushExtraProjections();
    }
  }
  const failed = outcomes.filter((outcome) => outcome.status === "error" || outcome.status === "failed").length;
  const exitCode: 0 | 1 = failed > 0 ? 1 : 0;
  const lines = [header, ...(mode === "direct" ? [`${SCRIPT_LABEL} AVISO: modo directo — el API debe estar parado (cadena de auditoría in-memory).`] : []), ...outcomes.map(describeOutcome)];
  if (outcomes.length === 0) lines.push("  (ningún fichero .csv/.txt/.xml/.xlsx)");
  lines.push(`  Entregados ${outcomes.filter((outcome) => outcome.delivered).length} · duplicados ${outcomes.filter((outcome) => outcome.status === "duplicate").length} · fallidos ${failed}.`);
  return { exitCode, json: { mode, propertyId: flags.property, folder: flags.folder, file: flags.file, feed: flags.feed, businessDate: flags.businessDate, outcomes, exitCode }, lines };
}

function writeStdout(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${text}\n`, (error) => (error ? reject(error) : resolve()));
  });
}

const entryFile = resolvePath(fileURLToPath(import.meta.url));
const argFile = process.argv[1] ? resolvePath(process.argv[1]) : "";
if (entryFile === argFile) {
  let flags: PullFlags;
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
  runPull(flags)
    .then(async (outcome) => {
      await writeStdout(flags.json ? JSON.stringify(outcome.json, null, 2) : outcome.lines.join("\n"));
      await prisma.$disconnect().catch(() => undefined);
      process.exit(outcome.exitCode);
    })
    .catch(async (error) => {
      console.error(`${SCRIPT_LABEL} fallo:`, error instanceof Error ? error.message : error);
      await prisma.$disconnect().catch(() => undefined);
      process.exit(1);
    });
}
