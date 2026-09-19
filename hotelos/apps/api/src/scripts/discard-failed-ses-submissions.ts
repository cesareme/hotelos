// Descarte auditado de envíos SES.HOSPEDAJES `failed` (Tanda L5 · lote L5-B2).
//
// Cierra las filas `failed` de una propiedad aparcadas por causa recuperable
// (SES_ESTABLISHMENT_INCOMPLETE · ISSUER_TAX_ID_MISSING) — o las ids dadas —
// con discardFailedSesSubmissions (modules/compliance/ses-submission.service.ts):
//   · errorCode SES_DISCARDED, errorMessage «Descartado por el operador: <motivo>»,
//     nextRetryAt null, responsePayloadJson.discarded { by, at, reason };
//   · el estado sigue `failed` (el enum SubmissionStatus no tiene otro valor honesto);
//   · el programador (runDueSesSubmissions) solo re-encola códigos recuperables y
//     POST /ses/submissions/:id/retry responde 409 SES_DISCARDED: la fila no llega al MIR;
//   · un evento de auditoría SES_HOSPEDAJES_SUBMISSION_DISCARDED por fila.
// Sin ruta HTTP (decisión de la tanda): este script es la única superficie.
//
// Uso (desde apps/api, DATABASE_URL en el entorno o ../../.env):
//   corepack pnpm --filter @hotelos/api ses:discard-failed -- \
//     --property <id> --reason "<motivo, ≥ 5 caracteres>" [--ids a,b,c] [--dry-run] [--json]
//
//   --property <id>   propiedad (obligatorio); el contexto de sistema toma su organización
//   --reason "<txt>"  motivo del descarte (obligatorio, ≥ 5 caracteres; queda en la fila y en la auditoría)
//   --ids a,b,c       solo esas filas (cualquier código `failed` salvo SES_DISCARDED)
//   --dry-run         cuenta las candidatas sin escribir nada
//   --json            salida legible por máquina
//
// Salida: cuántas filas descarta (o descartaría) y cuántas recuperables quedan.
// Códigos de salida: 0 ok · 1 fallo (BD, propiedad desconocida, error de dominio) · 2 flag inválido.

import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "@hotelos/database";
import type { PermissionKey } from "@hotelos/shared";
import type { UserContext } from "../lib/demo-store.js";
import { HttpError } from "../lib/http-error.js";
import { flushAuditQueues, hydrateAuditChainFromPostgres } from "../modules/audit/audit.service.js";
import { discardFailedSesSubmissions, SES_RECOVERABLE_ERROR_CODES, type DiscardFailedSesSubmissionsResult } from "../modules/compliance/ses-submission.service.js";

export const SCRIPT_LABEL = "[ses:discard-failed]";
// Usuario de sistema del descarte (actor_user_id de la auditoría y
// responsePayloadJson.discarded.by). No se exporta: este CLI nunca escribe
// asientos contables, así que la etiqueta de actor de Contabilidad
// (admin-web · accounting/actor-label.ts) no necesita conocerlo; systemContext()
// expone el contexto completo para los tests.
const SYSTEM_USER_ID = "usr_system_ses_discard";
export const DEVICE_ID = "cli:discard-failed-ses-submissions";
/** Única clave que exige discardFailedSesSubmissions: gestión del conector (corrector L5 · CS-10), no la de envío de recepción. */
export const CLI_PERMISSIONS: readonly PermissionKey[] = ["compliance.ses.configure"];
const MIN_REASON_LENGTH = 5;

export type DiscardFlags = {
  propertyId: string | null;
  reason: string | null;
  ids: string[] | null;
  dryRun: boolean;
  json: boolean;
  help: boolean;
};

export const USAGE = [
  `${SCRIPT_LABEL} descarte auditado de envíos SES.HOSPEDAJES failed`,
  "",
  "  corepack pnpm --filter @hotelos/api ses:discard-failed -- --property <id> --reason \"<motivo>\" [--ids a,b] [--dry-run] [--json]",
  "",
  "  --property <id>   propiedad (obligatorio)",
  `  --reason \"<txt>\"  motivo del descarte (obligatorio, ≥ ${MIN_REASON_LENGTH} caracteres)`,
  "  --ids a,b,c       solo esas filas failed (por defecto: todas las recuperables de la propiedad)",
  "  --dry-run         solo cuenta, no escribe",
  "  --json            salida JSON",
  "  --help            esta ayuda"
].join("\n");

export function parseFlags(argv: readonly string[]): DiscardFlags {
  const flags: DiscardFlags = { propertyId: null, reason: null, ids: null, dryRun: false, json: false, help: false };
  const valueOf = (name: string, index: number): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`El flag "${name}" requiere un valor.`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--property") {
      flags.propertyId = valueOf(arg, i).trim();
      i++;
    } else if (arg === "--reason") {
      flags.reason = valueOf(arg, i).trim();
      i++;
    } else if (arg === "--ids") {
      const ids = valueOf(arg, i)
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0);
      if (ids.length === 0) throw new Error('El flag "--ids" requiere al menos un id.');
      flags.ids = ids;
      i++;
    } else if (arg === "--") continue;
    else throw new Error(`Flag desconocido "${arg}". Conocidos: --property <id>, --reason "<txt>", --ids a,b, --dry-run, --json, --help.`);
  }
  if (flags.help) return flags;
  if (!flags.propertyId) throw new Error("Falta --property <id>.");
  if (!flags.reason || flags.reason.length < MIN_REASON_LENGTH) throw new Error(`Falta --reason con al menos ${MIN_REASON_LENGTH} caracteres.`);
  return flags;
}

/** Contexto de sistema (mismo patrón que import-reservations.ts): la organización de la propiedad, usuario de sistema y la clave del descarte. */
export function systemContext(organizationId: string, propertyId: string): UserContext {
  return {
    organizationId,
    propertyId,
    userId: SYSTEM_USER_ID,
    fullName: "Descarte SES (CLI)",
    deviceId: DEVICE_ID,
    permissions: [...CLI_PERMISSIONS],
    isPlatformAdmin: false
  };
}

export type RunOutcome = {
  exitCode: number;
  json: Record<string, unknown>;
  lines: string[];
};

export async function runDiscard(flags: DiscardFlags): Promise<RunOutcome> {
  const propertyId = flags.propertyId!;
  const property = await prisma.property.findUnique({ where: { id: propertyId }, select: { id: true, organizationId: true, name: true } });
  if (!property) {
    return { exitCode: 1, json: { error: "PROPERTY_NOT_FOUND", propertyId }, lines: [`${SCRIPT_LABEL} propiedad ${propertyId} no encontrada.`] };
  }
  const candidates = await prisma.sesHospedajesSubmission.count({
    where: { propertyId: property.id, status: "failed", errorCode: { in: [...SES_RECOVERABLE_ERROR_CODES] } }
  });
  const context = systemContext(property.organizationId, property.id);
  const correlationId = `ses_discard_cli_${Date.now().toString(36)}`;
  if (!flags.dryRun) await hydrateAuditChainFromPostgres();
  let result: DiscardFailedSesSubmissionsResult;
  try {
    result = await discardFailedSesSubmissions({
      context,
      propertyId: property.id,
      reason: flags.reason!,
      submissionIds: flags.ids ?? undefined,
      dryRun: flags.dryRun,
      correlationId
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return {
        exitCode: 1,
        json: { error: error.name, statusCode: error.statusCode, message: error.message, details: error.details ?? null },
        lines: [`${SCRIPT_LABEL} ${error.statusCode} ${error.message}`]
      };
    }
    throw error;
  } finally {
    if (!flags.dryRun) await flushAuditQueues();
  }
  const mode = flags.dryRun ? "DRY-RUN (sin escrituras)" : "APLICADO";
  const lines = [
    `${SCRIPT_LABEL} ${mode} · ${property.name} (${property.id}) · organización ${property.organizationId}`,
    `  candidatas recuperables antes: ${candidates}${flags.ids ? ` · ids pedidas: ${flags.ids.length}` : ""}`,
    `  ${flags.dryRun ? "descartaría" : "descartadas"}: ${result.discarded} fila${result.discarded === 1 ? "" : "s"} (SES_DISCARDED, motivo «${flags.reason}»)`,
    `  recuperables que quedan: ${result.recoverableLeft}`,
    `  auditoría: ${flags.dryRun ? "ninguna (dry-run)" : `${result.discarded} × SES_HOSPEDAJES_SUBMISSION_DISCARDED (correlación ${correlationId})`}`
  ];
  if (result.ids.length > 0 && result.ids.length <= 20) lines.push(`  ids: ${result.ids.join(", ")}`);
  return {
    exitCode: 0,
    json: { mode: flags.dryRun ? "dry-run" : "apply", propertyId: property.id, organizationId: property.organizationId, candidatesBefore: candidates, correlationId, ...result },
    lines
  };
}

function writeStdout(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${text}\n`, (error) => (error ? reject(error) : resolve()));
  });
}

// Entrada CLI: solo cuando se invoca directamente (misma guarda que import-reservations.ts).
const entryFile = resolvePath(fileURLToPath(import.meta.url));
const argFile = process.argv[1] ? resolvePath(process.argv[1]) : "";
if (entryFile === argFile) {
  let flags: DiscardFlags;
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
  runDiscard(flags)
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
