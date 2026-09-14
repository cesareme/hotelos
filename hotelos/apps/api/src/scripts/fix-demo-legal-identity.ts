// Demo legal-identity fix CLI (Tanda 4 · dataset-seeds · FISC-10).
//
// The 360 audit left the two live demo tenants with a contaminated fiscal
// identity: Faranda's organisation carries legal_name "AUDIT-T1 SL" and the
// invalid NIF B99999999 (checksum), its property an "AUDIT-T1 …" legal name and
// address, and org_123 the invalid NIF B12345678. In VERIFACTU_MODE=production
// issuer-identity.service refuses to issue for an invalid NIF (409), and the
// contaminated name is copied into every new invoice, XML and SES record.
//
// This command converges both tenants to their real identity through Prisma
// (never psql) and records one audit event per organisation with before/after
// through audit.service, so the change is chained in the trail. Invoices
// already issued keep their immutable issuer snapshot (FAC-2026-000001…):
// nothing fiscal is rewritten.
//
// Usage (from apps/api, DATABASE_URL in env or ../../.env):
//   node --env-file-if-exists=../../.env --import tsx src/scripts/fix-demo-legal-identity.ts \
//     [--dry-run | --apply --confirm <orgId> [--confirm <orgId>]] [--json]
//
//   --dry-run          (default) show the diff per organisation, write nothing
//   --apply            write; ONLY the organisations named with --confirm are touched
//   --confirm <orgId>  exact organisation id (repeatable) — required with --apply
//   --json             machine-readable output
//
// Idempotent: a field already holding the target value is not rewritten; a
// re-run reports 0 changes. Fields that must stay as they are (tax region /
// fiscal territory) are only FILLED when empty, never overwritten.
//
// Exit codes: 0 ok · 1 failure (invalid NIF target, tenant missing, DB error) ·
// 2 unknown flag / missing --confirm.

import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import { prisma } from "@hotelos/database";
import { isValidSpanishTaxId } from "@hotelos/compliance";

export const CORRELATION_ID = "corr_demo_identity_fix";
export const SYSTEM_USER_ID = "usr_system_demo_refresh";

export type IdentityTarget = {
  organizationId: string;
  label: string;
  organization: { legalName?: string; taxId: string };
  property?: {
    propertyId: string;
    set: { legalName: string; address: string; postalCode: string; province: string; municipality: string; ineMunicipalityCode: string };
    /** Only written when the current value is null/empty. */
    fillIfEmpty: { taxRegion: string; fiscalTerritory: string };
  };
};

/** Real identities of the two live demo tenants (recon 2026-09-14, item 17). */
export const IDENTITY_TARGETS: readonly IdentityTarget[] = [
  {
    organizationId: "cmrhw9jy30002fyvb6tsdiugt",
    label: "Faranda",
    organization: { legalName: "Faranda Hotels & Resorts", taxId: "B99999997" },
    property: {
      propertyId: "cmrhw9jy40003fyvbuu2ec2w7",
      set: {
        legalName: "Hotel Faranda Rías Altas by Ascend Collection",
        address: "Paseo Marítimo, 1",
        postalCode: "15172",
        province: "A Coruña",
        municipality: "Perillo (Oleiros)",
        ineMunicipalityCode: "15058"
      },
      fillIfEmpty: { taxRegion: "ES_PENINSULA_BALEARES", fiscalTerritory: "common" }
    }
  },
  {
    organizationId: "org_123",
    label: "org_123 (demo)",
    organization: { taxId: "B12345674" }
  }
];

export type IdentityFlags = { apply: boolean; confirm: string[]; json: boolean };

export function parseFlags(argv: readonly string[]): IdentityFlags {
  const flags: IdentityFlags = { apply: false, confirm: [], json: false };
  let sawDryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") sawDryRun = true;
    else if (arg === "--apply") flags.apply = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--confirm") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error('Flag "--confirm" requires an organisation id.');
      flags.confirm.push(v);
      i++;
    } else if (arg === "--") continue;
    else throw new Error(`Unknown flag "${arg}". Known: --dry-run, --apply, --confirm <orgId>, --json.`);
  }
  if (sawDryRun && flags.apply) throw new Error("--dry-run and --apply are mutually exclusive.");
  if (flags.apply && flags.confirm.length === 0) throw new Error("--apply requires --confirm <orgId> (repeatable) naming each organisation to fix.");
  const unknown = flags.confirm.filter((id) => !IDENTITY_TARGETS.some((t) => t.organizationId === id));
  if (unknown.length > 0) throw new Error(`--confirm names an organisation this script does not manage: ${unknown.join(", ")}. Known: ${IDENTITY_TARGETS.map((t) => t.organizationId).join(", ")}.`);
  return flags;
}

export type FieldChange = { entity: "organization" | "property"; id: string; field: string; before: string | null; after: string };

/** Pure diff: which fields differ from the target (fill-if-empty fields only when empty). */
export function diffIdentity(
  target: IdentityTarget,
  current: { organization: { legalName: string | null; taxId: string | null } | null; property: Record<string, string | null> | null }
): FieldChange[] {
  const changes: FieldChange[] = [];
  if (!current.organization) return changes;
  const org = current.organization;
  if (target.organization.legalName !== undefined && org.legalName !== target.organization.legalName) {
    changes.push({ entity: "organization", id: target.organizationId, field: "legalName", before: org.legalName, after: target.organization.legalName });
  }
  if (org.taxId !== target.organization.taxId) {
    changes.push({ entity: "organization", id: target.organizationId, field: "taxId", before: org.taxId, after: target.organization.taxId });
  }
  if (target.property && current.property) {
    for (const [field, value] of Object.entries(target.property.set)) {
      if ((current.property[field] ?? null) !== value) {
        changes.push({ entity: "property", id: target.property.propertyId, field, before: current.property[field] ?? null, after: value });
      }
    }
    for (const [field, value] of Object.entries(target.property.fillIfEmpty)) {
      const now = current.property[field];
      if (now === null || now === undefined || now.trim() === "") {
        changes.push({ entity: "property", id: target.property.propertyId, field, before: now ?? null, after: value });
      }
    }
  }
  return changes;
}

export type IdentitySummary = {
  dryRun: boolean;
  targets: { organizationId: string; label: string; confirmed: boolean; found: boolean; changes: FieldChange[]; applied: boolean; error?: string }[];
  durationMs: number;
};

export async function runIdentityFix(flags: IdentityFlags): Promise<IdentitySummary> {
  const start = Date.now();
  for (const t of IDENTITY_TARGETS) {
    if (!isValidSpanishTaxId(t.organization.taxId)) throw new Error(`NIF objetivo inválido para ${t.label}: ${t.organization.taxId}`);
  }
  const summary: IdentitySummary = { dryRun: !flags.apply, targets: [], durationMs: 0 };
  const audit = flags.apply ? await import("../modules/audit/audit.service.js") : null;
  if (audit) await audit.hydrateAuditChainFromPostgres();

  for (const target of IDENTITY_TARGETS) {
    const confirmed = flags.confirm.includes(target.organizationId);
    const organization = await prisma.organization.findUnique({ where: { id: target.organizationId }, select: { legalName: true, taxId: true, name: true } });
    const property = target.property
      ? await prisma.property.findUnique({
          where: { id: target.property.propertyId },
          select: { legalName: true, address: true, postalCode: true, province: true, municipality: true, ineMunicipalityCode: true, taxRegion: true, fiscalTerritory: true }
        })
      : null;
    const entry: IdentitySummary["targets"][number] = { organizationId: target.organizationId, label: target.label, confirmed, found: Boolean(organization), changes: [], applied: false };
    summary.targets.push(entry);
    if (!organization) {
      entry.error = "organización no encontrada";
      continue;
    }
    if (target.property && !property) {
      entry.error = `propiedad ${target.property.propertyId} no encontrada`;
      continue;
    }
    entry.changes = diffIdentity(target, { organization, property: property as Record<string, string | null> | null });
    if (!flags.apply || !confirmed || entry.changes.length === 0) continue;

    const orgData: Record<string, string> = {};
    const propData: Record<string, string> = {};
    for (const c of entry.changes) (c.entity === "organization" ? orgData : propData)[c.field] = c.after;
    try {
      await prisma.$transaction(async (tx) => {
        if (Object.keys(orgData).length > 0) await tx.organization.update({ where: { id: target.organizationId }, data: orgData });
        if (target.property && Object.keys(propData).length > 0) await tx.property.update({ where: { id: target.property.propertyId }, data: propData });
      });
      entry.applied = true;
      audit?.recordAuditEvent({
        organizationId: target.organizationId,
        propertyId: target.property?.propertyId,
        actorUserId: SYSTEM_USER_ID,
        actorType: "system",
        action: "ORGANIZATION_FISCAL_IDENTITY_UPDATED",
        entityType: "organization",
        entityId: target.organizationId,
        beforeJson: Object.fromEntries(entry.changes.map((c) => [`${c.entity}.${c.field}`, c.before])),
        afterJson: Object.fromEntries(entry.changes.map((c) => [`${c.entity}.${c.field}`, c.after])),
        correlationId: CORRELATION_ID
      });
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
    }
  }
  if (audit) await audit.flushAuditQueues();
  summary.durationMs = Date.now() - start;
  return summary;
}

export function printHuman(summary: IdentitySummary): void {
  const lines = [`[demo:fix-identity] ${summary.dryRun ? "DRY-RUN (no writes)" : "APPLIED"} · ${summary.durationMs} ms`];
  for (const t of summary.targets) {
    const state = t.error ? `ERROR ${t.error}` : t.changes.length === 0 ? "sin cambios" : summary.dryRun ? `${t.changes.length} cambios previstos` : t.confirmed ? (t.applied ? "aplicado" : "no aplicado") : "pendiente (falta --confirm)";
    lines.push(`  ${t.label} (${t.organizationId}): ${state}`);
    for (const c of t.changes) lines.push(`    ${c.entity}.${c.field}: ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`);
  }
  if (summary.dryRun) lines.push("  Nada escrito. Repite con --apply --confirm <orgId> (repetible). Las facturas ya emitidas conservan su emisor histórico.");
  console.log(lines.join("\n"));
}

const entryFile = resolvePath(fileURLToPath(import.meta.url));
const argFile = process.argv[1] ? resolvePath(process.argv[1]) : "";
if (entryFile === argFile) {
  let flags: IdentityFlags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (error) {
    console.error(`[demo:fix-identity] ${(error as Error).message}`);
    process.exit(2);
  }
  runIdentityFix(flags)
    .then(async (summary) => {
      if (flags.json) console.log(JSON.stringify(summary, null, 2));
      else printHuman(summary);
      await prisma.$disconnect();
      return summary.targets.filter((t) => t.error).length;
    })
    .then((failed) => process.exit(failed > 0 ? 1 : 0))
    .catch(async (error) => {
      console.error("[demo:fix-identity] failed:", error);
      await prisma.$disconnect().catch(() => undefined);
      process.exit(1);
    });
}
