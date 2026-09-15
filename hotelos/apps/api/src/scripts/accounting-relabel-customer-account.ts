// Customer sub-ledger sanitation CLI: 430 → 4300 (fix:ledger 2026-09-16, t6#4).
//
// Moves the journal lines an organisation still carries on the 3-digit
// header «430 Clientes» to the canonical sub-account «4300 Clientes (euros)»
// (modules/accounting/customer-account-relabel.ts). Same amounts, sides,
// dates and numbers: the balance of subgroup 43 and every report stay the
// same to the cent; only the customer sub-ledger becomes ONE account, the
// one every writer uses since this fix (CUSTOMER_ACCOUNT_CODE).
//
// Usage (from apps/api, DATABASE_URL in env or ../../.env):
//   node --env-file-if-exists=../../.env --import tsx src/scripts/accounting-relabel-customer-account.ts \
//     --org <organizationId> [--org <otherId>] [--dry-run | --apply --confirm <organizationId>] [--json]
//
//   --org <id>          organisation (repeatable)
//   --dry-run           (default) print the plan per organisation (lines, entries, sums by
//                       sourceType, blocking reasons), write nothing
//   --apply             move the lines, one transaction per organisation; requires --confirm
//   --confirm <id>      exact id of every --org given (guard against the wrong database)
//   --json              machine-readable output
//   --help / -h         usage
//
// Refuses (exit 1, nothing written) when 4300 is missing / not postable or
// when any 430 line belongs to an asiento dated inside a CLOSED fiscal year
// (reopen it first). Audited: one ACCOUNTING_CUSTOMER_ACCOUNT_RELABELED event
// per organisation. Idempotent: a second run moves 0 lines.
//
// Books already legalised (art. 27 CCom): do NOT relabel; post an asiento de
// reclasificación D 4300 / H 430 for the net balance instead (manual entry).
// Backup first and run with the API instances stopped (in-memory audit chain,
// CLAUDE.md deuda 12(c)); the journal has no in-memory mirror.
//
// Exit codes: 0 ok · 1 blocked / DB error · 2 usage.

import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import { prisma } from "@hotelos/database";
import {
  applyCustomerAccountRelabel,
  planCustomerAccountRelabel,
  type CustomerRelabelPlan,
  type CustomerRelabelResult
} from "../modules/accounting/customer-account-relabel.js";

export const CORRELATION_ID = "corr_accounting_customer_relabel";
export const SYSTEM_USER_ID = "usr_system_accounting_relabel";

export type RelabelFlags = { orgs: string[]; apply: boolean; confirm: string[]; json: boolean; help: boolean };

export const USAGE = [
  "Uso (desde apps/api, DATABASE_URL en el entorno o ../../.env):",
  "  node --env-file-if-exists=../../.env --import tsx src/scripts/accounting-relabel-customer-account.ts \\",
  "    --org <organizationId> [--org <otroId>] [--dry-run | --apply --confirm <organizationId>] [--json]",
  "",
  "  --org <id>           organización (repetible)",
  "  --dry-run            (por defecto) imprime el plan por organización, no escribe nada",
  "  --apply              traslada las líneas 430 → 4300, una transacción por organización; exige --confirm",
  "  --confirm <id>       id exacto de cada --org (guarda contra aplicar a otra BD); uno por --org",
  "  --json               salida legible por máquina",
  "  --help, -h           esta ayuda",
  "",
  "Libros ya legalizados: no trasladar; contabilizar un asiento de reclasificación D 4300 / H 430.",
  "Códigos de salida: 0 ok · 1 bloqueado o error de BD · 2 uso."
].join("\n");

export function parseFlags(argv: readonly string[]): RelabelFlags {
  const flags: RelabelFlags = { orgs: [], apply: false, confirm: [], json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") return { ...flags, help: true };
    if (arg === "--dry-run") continue;
    if (arg === "--apply") flags.apply = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--org" || arg === "--confirm") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`Flag "${arg}" requires a value.`);
      if (arg === "--org") flags.orgs.push(value);
      else flags.confirm.push(value);
      i += 1;
    } else throw new Error(`Unknown flag "${arg}". Known: --org <id>, --dry-run, --apply, --confirm <id>, --json, --help.`);
  }
  return flags;
}

export function validateFlags(flags: RelabelFlags): void {
  if (flags.help) return;
  if (flags.orgs.length === 0) throw new Error("--org <organizationId> is required (repeatable).");
  if (flags.apply && flags.confirm.length === 0) throw new Error("--apply requires --confirm <organizationId> (one per --org).");
  if (!flags.apply && flags.confirm.length > 0) throw new Error("--confirm only makes sense with --apply.");
  if (flags.apply) {
    const orgs = new Set(flags.orgs);
    const confirmed = new Set(flags.confirm);
    const missing = flags.orgs.filter((org) => !confirmed.has(org));
    const extra = flags.confirm.filter((org) => !orgs.has(org));
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(`--confirm does not match --org (missing: ${missing.join(", ") || "-"}; unexpected: ${extra.join(", ") || "-"}). Nothing written.`);
    }
  }
}

export function formatPlan(plan: CustomerRelabelPlan | CustomerRelabelResult): string {
  const lines: string[] = [];
  const applied = "applied" in plan ? plan.applied : false;
  lines.push(`Organización ${plan.organizationId} · ${applied ? "APLICADO" : "plan (dry-run)"} · ${plan.fromCode} → ${plan.toCode}`);
  lines.push(`  líneas: ${plan.lines} en ${plan.entries} asientos · debe ${plan.debit} · haber ${plan.credit}`);
  for (const row of plan.bySourceType) lines.push(`    ${row.sourceType.padEnd(24)} ${String(row.lines).padStart(5)} líneas  D ${row.debit.padStart(11)}  H ${row.credit.padStart(11)}`);
  if (plan.closedYearEntries > 0) lines.push(`  asientos en ejercicio cerrado: ${plan.closedYearEntries} (reábrelo antes)`);
  if (plan.blocking.length > 0) lines.push(`  BLOQUEADO: ${plan.blocking.join(", ")}`);
  if ("applied" in plan) lines.push(`  actualizadas: ${plan.updated} · saldo de ${plan.toCode} después: ${plan.targetBalanceAfter}`);
  return lines.join("\n");
}

async function run(flags: RelabelFlags): Promise<number> {
  const reports: Array<CustomerRelabelPlan | CustomerRelabelResult> = [];
  let failed = 0;
  for (const organizationId of flags.orgs) {
    const organization = await prisma.organization.findUnique({ where: { id: organizationId }, select: { id: true } });
    if (!organization) {
      failed += 1;
      console.error(`Organización ${organizationId}: no existe.`);
      continue;
    }
    try {
      const report = flags.apply
        ? await applyCustomerAccountRelabel(organizationId, { actorUserId: SYSTEM_USER_ID, correlationId: CORRELATION_ID })
        : await planCustomerAccountRelabel(organizationId);
      reports.push(report);
      if (report.blocking.length > 0) failed += 1;
    } catch (error) {
      failed += 1;
      console.error(`Organización ${organizationId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (flags.apply) {
    const audit = await import("../modules/audit/audit.service.js");
    await audit.flushAuditQueues();
  }
  if (flags.json) console.log(JSON.stringify({ apply: flags.apply, reports, failed }, null, 2));
  else for (const report of reports) console.log(formatPlan(report));
  return failed;
}

const isMain = process.argv[1] ? resolvePath(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isMain) {
  let flags: RelabelFlags;
  try {
    flags = parseFlags(process.argv.slice(2));
    validateFlags(flags);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    process.exit(2);
  }
  if (flags.help) {
    console.log(USAGE);
    process.exit(0);
  }
  run(flags)
    .then(async (failed) => {
      await prisma.$disconnect();
      process.exit(failed > 0 ? 1 : 0);
    })
    .catch(async (error) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      await prisma.$disconnect();
      process.exit(1);
    });
}
