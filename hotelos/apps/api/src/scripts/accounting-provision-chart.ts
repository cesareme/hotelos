// Chart-of-accounts provisioning CLI (Finanzas · lote schema · 2026-09-15).
//
// Provisions the «PGC Pymes hotelero» template (chart-of-accounts.service.ts)
// for one or more organisations. Idempotent and additive: it creates the
// accounts that are missing, links parents, fills USALI defaults on legacy P&L
// accounts and records the template code in accounting_settings. It never
// deletes, renames or re-types an existing account (name differences are
// listed in the plan for the operator). Faranda (created after the seed) has no
// chart at all today, so the accounting projection fails silently for it — this
// command is how a pilot organisation gets its plan.
//
// Usage (from apps/api, DATABASE_URL in env or ../../.env):
//   node --env-file-if-exists=../../.env --import tsx src/scripts/accounting-provision-chart.ts \
//     --org <organizationId> [--org <otherId>] [--dry-run | --apply --confirm <organizationId>] [--json]
//
//   --org <id>          organisation to provision (repeatable)
//   --dry-run           (default) print the plan per organisation, write nothing
//   --apply             write, one transaction per organisation; requires --confirm
//   --confirm <id>      exact id of every --org given (guard against the wrong database);
//                       repeat it once per --org
//   --json              machine-readable output
//   --help / -h         print this usage and exit 0
//
// Writes go through Prisma inside provisionOrganizationChart's transaction and
// are followed by one ACCOUNTING_CHART_PROVISIONED audit event per organisation
// (audit.service, so the change is chained in the trail). The API keeps no
// in-memory mirror of accounts: no restart is needed.
//
// Exit codes: 0 ok · 1 failure (organisation missing, canonical account still
// missing after the run, DB error) · 2 unknown flag / usage.

import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import { prisma } from "@hotelos/database";
import {
  CHART_TEMPLATE_CODE,
  PGC_PYMES_HOTEL_TEMPLATE,
  provisionOrganizationChart,
  validateChartTemplate,
  type ChartProvisionResult
} from "../modules/accounting/chart-of-accounts.service.js";

export const CORRELATION_ID = "corr_accounting_provision_chart";
export const SYSTEM_USER_ID = "usr_system_accounting_provision";
export const AUDIT_ACTION = "ACCOUNTING_CHART_PROVISIONED";

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

export type ProvisionChartFlags = { orgs: string[]; apply: boolean; confirm: string[]; json: boolean; help: boolean };

export const USAGE = [
  "Uso (desde apps/api, DATABASE_URL en el entorno o ../../.env):",
  "  node --env-file-if-exists=../../.env --import tsx src/scripts/accounting-provision-chart.ts \\",
  "    --org <organizationId> [--org <otroId>] [--dry-run | --apply --confirm <organizationId>] [--json]",
  "",
  "  --org <id>           organización a provisionar (repetible)",
  "  --dry-run            (por defecto) imprime el plan por organización, no escribe nada",
  "  --apply              escribe, una transacción por organización; exige --confirm",
  "  --confirm <id>       id exacto de cada --org (guarda contra aplicar a otra BD); uno por --org",
  "  --json               resumen legible por máquina",
  "  --help, -h           esta ayuda",
  "",
  "Códigos de salida: 0 ok · 1 fallo (organización ausente, cuenta canónica ausente tras el run, BD) · 2 flag desconocido / uso."
].join("\n");

export function parseFlags(argv: readonly string[]): ProvisionChartFlags {
  const flags: ProvisionChartFlags = { orgs: [], apply: false, confirm: [], json: false, help: false };
  let sawDryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { ...flags, help: true };
    if (arg === "--dry-run") sawDryRun = true;
    else if (arg === "--apply") flags.apply = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--org" || arg === "--confirm") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`Flag "${arg}" requires a value.`);
      if (arg === "--org") flags.orgs.push(value);
      else flags.confirm.push(value);
      i++;
    } else if (arg === "--") continue;
    else throw new Error(`Unknown flag "${arg}". Known: --org <id>, --dry-run, --apply, --confirm <id>, --json, --help.`);
  }
  if (sawDryRun && flags.apply) throw new Error("--dry-run and --apply are mutually exclusive.");
  if (flags.orgs.length === 0) throw new Error("--org <organizationId> is required (repeat it for several organisations).");
  if (new Set(flags.orgs).size !== flags.orgs.length) throw new Error("--org given twice for the same organisation.");
  if (flags.apply && flags.confirm.length === 0) throw new Error("--apply requires --confirm <organizationId> (one per --org).");
  if (!flags.apply && flags.confirm.length > 0) throw new Error("--confirm only makes sense with --apply.");
  return flags;
}

/** --confirm must name exactly the organisations given with --org (typo / wrong DB guard). */
export function assertConfirmMatches(flags: ProvisionChartFlags): void {
  if (!flags.apply) return;
  const orgs = new Set(flags.orgs);
  const confirmed = new Set(flags.confirm);
  const missing = flags.orgs.filter((org) => !confirmed.has(org));
  const extra = flags.confirm.filter((org) => !orgs.has(org));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `--confirm does not match --org (missing: ${missing.join(", ") || "-"}; unexpected: ${extra.join(", ") || "-"}). Nothing written.`
    );
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export type ProvisionChartSummary = {
  templateCode: string;
  templateSize: number;
  apply: boolean;
  results: Array<{ organizationId: string; result?: ChartProvisionResult; error?: string }>;
  errors: string[];
};

export async function runProvisionChart(flags: ProvisionChartFlags): Promise<ProvisionChartSummary> {
  assertConfirmMatches(flags);
  const summary: ProvisionChartSummary = {
    templateCode: CHART_TEMPLATE_CODE,
    templateSize: PGC_PYMES_HOTEL_TEMPLATE.length,
    apply: flags.apply,
    results: [],
    errors: []
  };
  const templateIssues = validateChartTemplate();
  if (templateIssues.length > 0) {
    summary.errors.push(...templateIssues.map((issue) => `Plantilla: ${issue}`));
    return summary;
  }

  for (const organizationId of flags.orgs) {
    try {
      const result = await provisionOrganizationChart(organizationId, { dryRun: !flags.apply });
      summary.results.push({ organizationId, result });
      if (result.plan.missingCanonical.length > 0) {
        summary.errors.push(`${organizationId}: cuentas canónicas ausentes tras el run: ${result.plan.missingCanonical.join(", ")}`);
      }
      if (flags.apply) {
        // Dynamic import: audit.service drags demoStore and friends, which the
        // unit tests (flags only) must not load.
        const audit = await import("../modules/audit/audit.service.js");
        audit.recordAuditEvent({
          organizationId,
          actorUserId: SYSTEM_USER_ID,
          actorType: "system",
          action: AUDIT_ACTION,
          entityType: "organization",
          entityId: organizationId,
          beforeJson: { accounts: result.plan.existing, setting: result.plan.setting },
          afterJson: {
            templateCode: CHART_TEMPLATE_CODE,
            created: result.created,
            linked: result.linked,
            usaliFilled: result.usaliFilled,
            settingWritten: result.settingWritten,
            totalAfter: result.totalAfter,
            nameDiffers: result.plan.nameDiffers
          },
          correlationId: CORRELATION_ID
        });
        await audit.flushAuditQueues();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      summary.results.push({ organizationId, error: message });
      summary.errors.push(`${organizationId}: ${message}`);
    }
  }
  return summary;
}

export function formatSummary(summary: ProvisionChartSummary): string {
  const lines: string[] = [];
  lines.push(`Plantilla ${summary.templateCode} · ${summary.templateSize} cuentas · modo ${summary.apply ? "APPLY" : "dry-run"}`);
  for (const entry of summary.results) {
    if (!entry.result) {
      lines.push(`- ${entry.organizationId}: ERROR ${entry.error}`);
      continue;
    }
    const { plan } = entry.result;
    lines.push(`- ${entry.organizationId}: ${plan.existing} cuentas existentes`);
    lines.push(`    crear ${plan.toCreate.length} · enlazar padre ${plan.toLink.length} · rellenar USALI ${plan.toFillUsali.length} · accounting_settings: ${plan.setting}`);
    if (plan.toCreate.length > 0) lines.push(`    a crear: ${plan.toCreate.slice(0, 12).join(", ")}${plan.toCreate.length > 12 ? ", …" : ""}`);
    if (plan.nameDiffers.length > 0) {
      lines.push(`    nombres distintos de la plantilla (NO se cambian): ${plan.nameDiffers.length}`);
      for (const diff of plan.nameDiffers.slice(0, 8)) lines.push(`      ${diff.code}: «${diff.current}» (plantilla: «${diff.template}»)`);
    }
    if (plan.missingCanonical.length > 0) lines.push(`    CUENTAS CANÓNICAS AUSENTES: ${plan.missingCanonical.join(", ")}`);
    if (entry.result.applied) {
      lines.push(
        `    aplicado: creadas ${entry.result.created} · enlazadas ${entry.result.linked} · USALI rellenado ${entry.result.usaliFilled} · setting ${entry.result.settingWritten ? "escrito" : "sin cambios"} · total ${entry.result.totalAfter}`
      );
    }
  }
  if (summary.errors.length > 0) {
    lines.push("Errores:");
    for (const error of summary.errors) lines.push(`  ${error}`);
  }
  return lines.join("\n");
}

const entryFile = resolvePath(fileURLToPath(import.meta.url));
const argFile = process.argv[1] ? resolvePath(process.argv[1]) : "";
if (entryFile === argFile) {
  let flags: ProvisionChartFlags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (error) {
    console.error(`[accounting:provision-chart] ${(error as Error).message}`);
    console.error(USAGE);
    process.exit(2);
  }
  if (flags.help) {
    console.log(USAGE);
    process.exit(0);
  }
  runProvisionChart(flags)
    .then(async (summary) => {
      if (flags.json) console.log(JSON.stringify(summary, null, 2));
      else console.log(formatSummary(summary));
      await prisma.$disconnect();
      return summary.errors.length;
    })
    .then((failed) => process.exit(failed > 0 ? 1 : 0))
    .catch(async (error) => {
      console.error("[accounting:provision-chart] failed:", error);
      await prisma.$disconnect().catch(() => undefined);
      process.exit(1);
    });
}
