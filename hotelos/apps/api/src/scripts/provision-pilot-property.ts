// Pilot property provisioning CLI (Faranda · second pilot hotel).
//
// Tanda 6b (L2 · estructura societaria): the plan/apply engine moved to
// apps/api/src/modules/structure/property-provisioning.service.ts, the SAME
// service behind POST /legal-entities/:legalEntityId/properties (alta de centro
// desde producto). This CLI is the operator's front of that service: it reads a
// JSON spec (src/scripts/specs/*.json, the centre spec plus `organizationId`),
// prints the plan per table, and — only with --apply --confirm <organizationId>
// — writes it. The pure helpers the operator's tests exercise are re-exported
// from the service so the contract of this file does not change.
//
// Idempotent: the property is located by (organizationId, name); an existing
// property CONVERGES — null fields are filled, equal fields are skipped, and a
// field holding a DIFFERENT value is reported as a conflict (never overwritten;
// conflicts block --apply). Satellites are matched by their natural keys
// (code / number / unique) and only ever created or filled — nothing is deleted.
// The centre hangs from the organisation's default legal entity (created
// implicitly when the tenant predates the backfill), gets its `kind` / `code` /
// `tradeName`, and its series prefixes are checked against the sister centres
// (prefix clash = conflict).
//
// Usage (from apps/api, DATABASE_URL in env or ../../.env):
//   node --env-file-if-exists=../../.env --import tsx src/scripts/provision-pilot-property.ts \
//     --spec src/scripts/specs/faranda-los-tilos.json [--dry-run | --apply --confirm <organizationId>] [--json]
//
//   --spec <file>        spec JSON (required)
//   --dry-run            (default) print the plan per table, write nothing
//   --apply              write, inside one transaction; requires --confirm
//   --confirm <orgId>    exact organisation id of the spec — guards against
//                        applying a spec to the wrong database
//   --json               machine-readable summary
//   --help / -h          print this usage and exit 0
//
// Writes go through Prisma (never psql) inside a single transaction, followed
// by ensurePropertySettings (tenant-hydration.ts, outside the transaction
// because it uses the global client and its own tax provisioning) and one
// PROPERTY_PROVISIONED audit event through audit.service so the change is
// chained in the trail. In-memory tenant mirrors are only hydrated at boot:
// the operator restarts the API afterwards.
//
// Exit codes: 0 ok · 1 failure (spec invalid, org/user/role missing,
// conflicts, post-condition mismatch, DB error) · 2 unknown flag / usage.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import { prisma } from "@hotelos/database";
import {
  AUDIT_ACTION,
  applyProvisionPlan,
  buildPlan,
  formatPlannedWrites,
  hotelInventoryOf,
  isHotelKind,
  planRooms,
  summarizePlan,
  validateSpec,
  type PilotSpec,
  type PlanSummary,
  type PostCondition
} from "../modules/structure/property-provisioning.service.js";

// Pure helpers re-exported for the operator's unit tests (src/scripts/__tests__).
export {
  AUDIT_ACTION,
  assertFiscalLocationCoherent,
  assertInvoiceSequenceCoherent,
  buildPlan,
  diffConverge,
  planRoomCapacityFill,
  planRooms,
  sameValue,
  splitProfile,
  stableStringify,
  summarizePlan,
  validateSpec
} from "../modules/structure/property-provisioning.service.js";
export type { ConvergeDiff, FieldConflict, PilotSpec, PlanSummary, PlannedRoom, ProvisionPlan, RoomCapacity, RoomCapacityFill, RoomTypeSpec } from "../modules/structure/property-provisioning.service.js";

export const CORRELATION_ID = "corr_pilot_los_tilos";
export const SYSTEM_USER_ID = "usr_system_pilot_provision";

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

export type ProvisionFlags = { spec: string; apply: boolean; confirm: string | null; json: boolean; help: boolean };

export const USAGE = [
  "Uso (desde apps/api, DATABASE_URL en el entorno o ../../.env):",
  "  node --env-file-if-exists=../../.env --import tsx src/scripts/provision-pilot-property.ts \\",
  "    --spec src/scripts/specs/<hotel>.json [--dry-run | --apply --confirm <organizationId>] [--json]",
  "",
  "  --spec <file>        spec JSON (obligatorio)",
  "  --dry-run            (por defecto) imprime el plan por tabla, no escribe nada",
  "  --apply              escribe, en una sola transacción; exige --confirm",
  "  --confirm <orgId>    id exacto de la organización del spec (guarda contra aplicar el spec a otra BD)",
  "  --json               resumen legible por máquina",
  "  --help, -h           esta ayuda",
  "",
  "Códigos de salida: 0 ok · 1 fallo (spec inválido, org/usuario/rol ausente, conflictos, post-condición, BD) · 2 flag desconocido / uso."
].join("\n");

export function parseFlags(argv: readonly string[]): ProvisionFlags {
  const flags: ProvisionFlags = { spec: "", apply: false, confirm: null, json: false, help: false };
  let sawDryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // --help wins over everything else (also over a missing --spec): the
    // operator asking for usage must never get a validation error instead.
    if (arg === "--help" || arg === "-h") return { ...flags, help: true };
    if (arg === "--dry-run") sawDryRun = true;
    else if (arg === "--apply") flags.apply = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--spec" || arg === "--confirm") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`Flag "${arg}" requires a value.`);
      if (arg === "--spec") flags.spec = v;
      else if (flags.confirm !== null) throw new Error("--confirm may be given only once (one spec = one organisation).");
      else flags.confirm = v;
      i++;
    } else if (arg === "--") continue;
    else throw new Error(`Unknown flag "${arg}". Known: --spec <file>, --dry-run, --apply, --confirm <orgId>, --json, --help.`);
  }
  if (sawDryRun && flags.apply) throw new Error("--dry-run and --apply are mutually exclusive.");
  if (!flags.spec) throw new Error("--spec <file> is required.");
  if (flags.apply && flags.confirm === null) throw new Error("--apply requires --confirm <organizationId> (the organizationId of the spec).");
  if (!flags.apply && flags.confirm !== null) throw new Error("--confirm only makes sense with --apply.");
  return flags;
}

/** --confirm must name exactly the organisation of the spec (typo / wrong DB guard). */
export function assertConfirmMatches(flags: ProvisionFlags, organizationId: string): void {
  if (!flags.apply) return;
  if (flags.confirm !== organizationId) {
    throw new Error(`--confirm "${flags.confirm}" does not match the spec organizationId "${organizationId}". Nothing written.`);
  }
}

export function loadSpec(path: string): PilotSpec {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`No se pudo leer el spec ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateSpec(raw);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export type ProvisionSummary = {
  dryRun: boolean;
  specPath: string;
  organization: { id: string; name: string };
  legalEntity: { id: string | null; code: string; legalName: string; action: "exists" | "create" } | null;
  property: { name: string; id: string | null; existed: boolean; kind: string; code: string | null };
  rooms: { total: number; byType: Record<string, number>; sample: string[] };
  plan: PlanSummary;
  countsBefore: Record<string, number>;
  applied: { propertyId: string; countsAfter: Record<string, number>; postConditions: PostCondition[]; auditEventId: string } | null;
  warnings: string[];
  errors: string[];
  durationMs: number;
};

export async function runProvision(flags: ProvisionFlags): Promise<ProvisionSummary> {
  const start = Date.now();
  const spec = loadSpec(flags.spec);
  assertConfirmMatches(flags, spec.organizationId);
  const plan = await buildPlan(spec, spec.organizationId);
  const planSummary = summarizePlan(plan);
  const rooms = isHotelKind(spec.property.kind) ? planRooms(hotelInventoryOf(spec)) : [];
  const byType: Record<string, number> = {};
  for (const r of rooms) byType[r.roomTypeCode] = (byType[r.roomTypeCode] ?? 0) + 1;

  const summary: ProvisionSummary = {
    dryRun: !flags.apply,
    specPath: flags.spec,
    organization: plan.organization,
    legalEntity: plan.legalEntity ?? null,
    property: { name: spec.property.name, id: plan.property.existingId, existed: plan.property.existingId !== null, kind: spec.property.kind, code: plan.code?.value ?? null },
    rooms: { total: rooms.length, byType, sample: [...rooms.slice(0, 3), ...rooms.filter((r) => r.roomTypeCode === "SUI")].map((r) => `${r.number}:${r.roomTypeCode}`) },
    plan: planSummary,
    countsBefore: plan.countsBefore,
    applied: null,
    warnings: [],
    errors: [],
    durationMs: 0
  };
  if (spec.roomTypes?._estimated) summary.warnings.push(`Reparto de tipos ESTIMADO: ${spec.roomTypes._estimatedReason ?? "sin explicación en el spec"}`);
  if (plan.legalEntity?.action === "create") summary.warnings.push(`La organización no tiene sociedad: se creará la sociedad implícita «${plan.legalEntity.legalName}» (NIF pendiente si el de la organización no es válido).`);
  if (planSummary.conflicts.length > 0) {
    summary.errors.push(`${planSummary.conflicts.length} conflictos entre spec y BD: resuélvelos antes de --apply (nunca se sobrescribe).`);
  }
  if (!flags.apply || summary.errors.length > 0) {
    summary.durationMs = Date.now() - start;
    return summary;
  }

  // Hash-chained audit: the in-memory tip must be the Postgres tip BEFORE
  // sealing the new event, otherwise the chain forks.
  const audit = await import("../modules/audit/audit.service.js");
  await audit.hydrateAuditChainFromPostgres();

  const applied = await applyProvisionPlan({
    spec,
    plan,
    organizationId: spec.organizationId,
    actor: { userId: SYSTEM_USER_ID, actorType: "system" },
    correlationId: CORRELATION_ID,
    planSummary
  });
  await audit.flushAuditQueues();

  for (const c of applied.postConditions) if (!c.ok) summary.errors.push(`Post-condición ${c.check}: esperado ${c.expected}, real ${c.actual}.`);
  summary.property.id = applied.propertyId;
  summary.legalEntity = plan.legalEntity ?? null;
  summary.applied = { propertyId: applied.propertyId, countsAfter: applied.countsAfter, postConditions: applied.postConditions, auditEventId: applied.auditEventId };
  summary.durationMs = Date.now() - start;
  return summary;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export function printHuman(summary: ProvisionSummary): void {
  const lines: string[] = [];
  lines.push(`[pilot:provision-property] ${summary.dryRun ? "DRY-RUN (no writes)" : "APPLIED"} · spec ${summary.specPath} · ${summary.durationMs} ms`);
  lines.push(`  Organización: ${summary.organization.name} (${summary.organization.id})`);
  if (summary.legalEntity) {
    lines.push(
      `  Sociedad: ${summary.legalEntity.action === "exists" ? `${summary.legalEntity.code} «${summary.legalEntity.legalName}» (${summary.legalEntity.id})` : `NUEVA (implícita) «${summary.legalEntity.legalName}»`}`
    );
  }
  lines.push(
    `  Centro (${summary.property.kind}${summary.property.code ? ` · ${summary.property.code}` : ""}): «${summary.property.name}» → ${summary.property.existed ? `EXISTE (${summary.property.id}), converge` : summary.property.id ? `CREADO ${summary.property.id}` : "NUEVO (se creará)"}`
  );
  if (summary.property.kind === "hotel") {
    lines.push(`  Habitaciones planificadas: ${summary.rooms.total} · ${Object.entries(summary.rooms.byType).map(([c, n]) => `${c}=${n}`).join(" · ")} · muestra ${summary.rooms.sample.join(", ")}`);
  } else {
    lines.push("  Habitaciones: ninguna (centro no alojativo, R6)");
  }
  lines.push(`  Escrituras previstas por tabla (${summary.plan.writes.length}):`);
  lines.push(...formatPlannedWrites(summary.plan.writes));
  lines.push(`  Sin cambios (${summary.plan.skips.length}):`);
  for (const s of summary.plan.skips) lines.push(`  ${"skip".padEnd(10)} ${s}`);
  if (summary.plan.skips.length === 0) lines.push("  (nada que saltar: propiedad nueva)");
  lines.push(`  Conflictos (${summary.plan.conflicts.length}):`);
  for (const c of summary.plan.conflicts) lines.push(`  ${"CONFLICT".padEnd(10)} ${c}`);
  if (summary.plan.conflicts.length === 0) lines.push("  (ninguno)");
  lines.push(`  Conteos antes: ${Object.entries(summary.countsBefore).map(([t, n]) => `${t}=${n}`).join(" · ")}`);
  if (summary.applied) {
    lines.push(`  Conteos después: ${Object.entries(summary.applied.countsAfter).map(([t, n]) => `${t}=${n}`).join(" · ")}`);
    lines.push("  Post-condiciones:");
    for (const c of summary.applied.postConditions) lines.push(`    ${c.ok ? "OK  " : "FAIL"} ${c.check}: ${c.actual} (esperado ${c.expected})`);
    lines.push(`  Audit ${AUDIT_ACTION} ${summary.applied.auditEventId} · correlation ${CORRELATION_ID}`);
  }
  for (const w of summary.warnings) lines.push(`  WARN ${w}`);
  for (const e of summary.errors) lines.push(`  ERROR ${e}`);
  if (summary.dryRun) {
    lines.push(`  Nada escrito. Repite con --apply --confirm ${summary.organization.id} (haz backup antes: bash scripts/backup-postgres.sh).`);
  } else if (summary.applied) {
    lines.push("  Reinicia el API (:3400/:3000): los espejos de tenants solo se cargan al arrancar.");
    if (summary.property.kind === "hotel") {
      lines.push(
        `  Siguiente paso, SOLO tras reiniciar: corepack pnpm --filter @hotelos/api import:pms-history-forecast -- --property ${summary.applied.propertyId} --file <history-forecast.csv> --source <origen> --publish-bar BAR (dry-run por defecto; --apply --confirm ${summary.applied.propertyId})`
      );
    }
  }
  console.log(lines.join("\n"));
}

const entryFile = resolvePath(fileURLToPath(import.meta.url));
const argFile = process.argv[1] ? resolvePath(process.argv[1]) : "";
if (entryFile === argFile) {
  let flags: ProvisionFlags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (error) {
    console.error(`[pilot:provision-property] ${(error as Error).message}`);
    process.exit(2);
  }
  if (flags.help) {
    console.log(USAGE);
    process.exit(0);
  }
  runProvision(flags)
    .then(async (summary) => {
      if (flags.json) console.log(JSON.stringify(summary, null, 2));
      else printHuman(summary);
      await prisma.$disconnect();
      return summary.errors.length;
    })
    .then((failed) => process.exit(failed > 0 ? 1 : 0))
    .catch(async (error) => {
      console.error("[pilot:provision-property] failed:", error);
      await prisma.$disconnect().catch(() => undefined);
      process.exit(1);
    });
}
