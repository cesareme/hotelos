// Historical accounting re-projection CLI (Finanzas · lote ledger · 2026-09-15).
//
// Walks the SOURCE documents of an organisation (invoices issued /
// rectified / cancelled, payments captured / refunded, POS cash and card
// tickets) in a window of property-local calendar days and posts the asientos
// that are missing through the ledger engine (modules/accounting/projection.ts
// replayAccountingProjection). Idempotent by (organization, sourceType,
// sourceId): a second run posts nothing. Faranda (created after the seed,
// chart provisioned on 2026-09-15) has 0 asientos for ~100 money documents —
// this command is how its history enters the diario.
//
// Usage (from apps/api, DATABASE_URL in env or ../../.env):
//   node --env-file-if-exists=../../.env --import tsx src/scripts/accounting-replay.ts \
//     --org <organizationId> --from YYYY-MM-DD --to YYYY-MM-DD [--property <id>] \
//     [--kinds invoice,payment,pos] [--dry-run | --apply --confirm <organizationId>] [--json]
//
//   --org <id>          organisation (required)
//   --from / --to       inclusive window of fecha contable (required)
//   --property <id>     restrict to one property of the organisation
//   --kinds             comma list of invoice, payment, pos (default all)
//   --dry-run           (default) build every asiento, write nothing, print the plan
//   --apply             post the missing asientos; requires --confirm <organizationId>
//   --json              machine-readable report
//   --help / -h         usage
//
// Run with the API instances STOPPED or accept that their in-memory audit
// chain forks (CLAUDE.md deuda 12(c)); the journal itself has no in-memory
// mirror, so no restart is needed for the numbers to be visible.
//
// Exit codes: 0 ok · 1 failures reported (or DB error) · 2 usage.

import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import { prisma } from "@hotelos/database";
import { flushAuditQueues } from "../modules/audit/audit.service.js";
import { replayAccountingProjection } from "../modules/accounting/projection.js";
import type { ReplayKind, ReplayReportView } from "../../../../packages/shared/src/accounting-types.js";

export const CORRELATION_ID = "corr_accounting_replay";
export const SYSTEM_USER_ID = "usr_system_accounting_replay";

export type ReplayFlags = { org: string | null; property: string | null; from: string | null; to: string | null; kinds: ReplayKind[]; apply: boolean; confirm: string | null; json: boolean; help: boolean };

export const USAGE = [
  "Uso (desde apps/api, DATABASE_URL en el entorno o ../../.env):",
  "  node --env-file-if-exists=../../.env --import tsx src/scripts/accounting-replay.ts \\",
  "    --org <organizationId> --from YYYY-MM-DD --to YYYY-MM-DD [--property <id>] \\",
  "    [--kinds invoice,payment,pos] [--dry-run | --apply --confirm <organizationId>] [--json]",
  "",
  "  --org <id>           organización (obligatorio)",
  "  --from / --to        ventana inclusiva de fecha contable (obligatorios)",
  "  --property <id>      limitar a una propiedad de la organización",
  "  --kinds              lista separada por comas: invoice, payment, pos (por defecto todas)",
  "  --dry-run            (por defecto) construye cada asiento sin escribir e imprime el plan",
  "  --apply              contabiliza los asientos que faltan; exige --confirm <organizationId>",
  "  --json               informe legible por máquina",
  "  --help, -h           esta ayuda",
  "",
  "Códigos de salida: 0 ok · 1 documentos fallidos o error de BD · 2 uso."
].join("\n");

const KINDS: ReplayKind[] = ["invoice", "payment", "pos"];

export function parseFlags(argv: readonly string[]): ReplayFlags {
  const flags: ReplayFlags = { org: null, property: null, from: null, to: null, kinds: [], apply: false, confirm: null, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") return { ...flags, help: true };
    if (arg === "--dry-run") continue;
    if (arg === "--apply") {
      flags.apply = true;
      continue;
    }
    if (arg === "--json") {
      flags.json = true;
      continue;
    }
    if (["--org", "--property", "--from", "--to", "--kinds", "--confirm"].includes(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`Flag "${arg}" requires a value.`);
      i += 1;
      if (arg === "--org") flags.org = value;
      else if (arg === "--property") flags.property = value;
      else if (arg === "--from") flags.from = value;
      else if (arg === "--to") flags.to = value;
      else if (arg === "--confirm") flags.confirm = value;
      else {
        for (const kind of value.split(",").map((k) => k.trim()).filter(Boolean)) {
          if (!KINDS.includes(kind as ReplayKind)) throw new Error(`Unknown kind "${kind}" (invoice, payment, pos).`);
          flags.kinds.push(kind as ReplayKind);
        }
      }
      continue;
    }
    throw new Error(`Unknown flag "${arg}".`);
  }
  return flags;
}

export function validateFlags(flags: ReplayFlags): string | null {
  if (!flags.org) return "--org es obligatorio.";
  if (!flags.from || !flags.to) return "--from y --to son obligatorios (YYYY-MM-DD).";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(flags.from) || !/^\d{4}-\d{2}-\d{2}$/.test(flags.to) || flags.from > flags.to) return "--from/--to deben ser YYYY-MM-DD con from ≤ to.";
  if (flags.apply && flags.confirm !== flags.org) return `--apply exige --confirm ${flags.org} (id exacto de la organización).`;
  return null;
}

export function formatReport(report: ReplayReportView): string {
  const lines: string[] = [];
  lines.push(`Organización ${report.organizationId}${report.propertyId ? ` · propiedad ${report.propertyId}` : ""} · ${report.from} → ${report.to} · ${report.apply ? "APLICADO" : "dry-run"} · tipos ${report.kinds.join(", ")}`);
  lines.push(`Documentos: ${report.scanned} · contabilizados ${report.posted} · ya existían ${report.existing} · pendientes (dry-run) ${report.wouldPost} · omitidos ${report.skipped} · fallidos ${report.failed}`);
  if (report.balanced !== null) lines.push(`Cuadre de la ventana tras aplicar: ${report.balanced ? "OK (Σ debe = Σ haber)" : "DESCUADRE"}`);
  for (const item of report.items) {
    const number = item.entryNumber !== null ? ` → asiento ${item.entryNumber}` : "";
    const note = item.message ? ` · ${item.message}` : "";
    const warnings = item.warnings.length > 0 ? ` · avisos: ${item.warnings.join(" | ")}` : "";
    lines.push(`  [${item.status.padEnd(10)}] ${item.entryDate} ${item.sourceType.padEnd(22)} ${(item.reference ?? item.sourceId).padEnd(20)} ${item.amount.padStart(10)}${number}${note}${warnings}`);
  }
  return lines.join("\n");
}

export async function main(argv: readonly string[]): Promise<number> {
  let flags: ReplayFlags;
  try {
    flags = parseFlags(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return 2;
  }
  if (flags.help) {
    console.log(USAGE);
    return 0;
  }
  const problem = validateFlags(flags);
  if (problem) {
    console.error(problem);
    console.error(USAGE);
    return 2;
  }
  const organization = await prisma.organization.findUnique({ where: { id: flags.org! }, select: { id: true, name: true } });
  if (!organization) {
    console.error(`La organización "${flags.org}" no existe.`);
    return 1;
  }
  const report = await replayAccountingProjection({
    organizationId: organization.id,
    propertyId: flags.property,
    from: flags.from!,
    to: flags.to!,
    apply: flags.apply,
    kinds: flags.kinds.length > 0 ? flags.kinds : undefined,
    actorUserId: SYSTEM_USER_ID,
    correlationId: CORRELATION_ID
  });
  await flushAuditQueues();
  console.log(flags.json ? JSON.stringify(report, null, 2) : formatReport(report));
  return report.failed > 0 || report.balanced === false ? 1 : 0;
}

const invokedDirectly = process.argv[1] !== undefined && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then(async (code) => {
      await prisma.$disconnect();
      process.exit(code);
    })
    .catch(async (error) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      await prisma.$disconnect();
      process.exit(1);
    });
}
