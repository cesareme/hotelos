// Indirect-tax backfill CLI (Tanda 3 · IVA/IGIC/IPSI "sin atrezzo").
//
// Before Tanda 3, `Property.taxRegion` was free text ("Madrid", "canary", "",
// NULL, "Mainland Spain"…), the Tax/TaxRate catalogue existed only for org_123
// with legacy region strings (mainland/canary/ceuta/melilla) and wrong IGIC/IPSI
// tiers, and invoice lines were created as "ES_UNKNOWN_0" with 0 € of tax.
// This command converges existing data to the statutory catalogue:
//
//   1. normalise every property's taxRegion (by province when empty) and
//      mirror it in property_compliance_settings — never writes '';
//   2. migrate the legacy Tax rows (non-canonical region): their line-type
//      rates are closed with validTo = yesterday (history kept, nothing is
//      deleted) and the Tax row is renamed to the canonical region when no
//      canonical row exists yet (otherwise it is left as an orphan);
//   3. ensurePropertyTaxes per property (Tax + one TaxRate per category from
//      the catalogue: IVA 10/10/21/10, IGIC 7/7/7/3, IPSI 2/2/4/4);
//   4. re-resolve the lines of DRAFT invoices (taxCode/taxRate/taxCategory/
//      taxCalificacion/taxFigure) and recompute total/taxTotal/taxBreakdownJson
//      with computeInvoiceTotals (contract B — the single source of totals);
//   5. LIST (never touch) issued/cancelled/rectified invoices that carry
//      ES_UNKNOWN_* or 0 % S1 lines: they are immutable (VeriFactu hash chain)
//      and can only be fixed with a rectifying invoice.
//
// Usage (from apps/api, DATABASE_URL in env or ../../.env):
//   corepack pnpm --filter @hotelos/api backfill:taxes -- [--apply] [--property <id>] [--json]
//   node --env-file-if-exists=../../.env --import tsx src/scripts/backfill-taxes.ts [--apply] [--property <id>] [--json]
//
//   (default)        dry-run: report what would change, write nothing
//   --apply          perform the writes
//   --property <id>  one property (and the legacy Tax rows of its organization)
//   --json           machine-readable output
//
// Idempotent: a second --apply run reports 0 changes.
// Exit codes: 0 ok · 1 failure (DB unreachable, any step failed) · 2 bad flag.

import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import { prisma } from "@hotelos/database";
import {
  TAX_CATEGORIES,
  TAX_REGIONS,
  categoryForLineType,
  computeInvoiceTotals,
  figureForRegion,
  isTaxCategory,
  normalizeTaxRegion,
  parseTaxCode,
  statutoryRates,
  type InvoiceTotalsLine,
  type TaxBreakdownGroup,
  type TaxCategory,
  type TaxRegion
} from "@hotelos/compliance";
import { ensurePropertyTaxes } from "../lib/tenant-hydration.js";
import { dayUtc, invalidateTaxCache, resolveTaxRate } from "../modules/accounting/tax-rate.service.js";

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

export type TaxBackfillFlags = { propertyId: string | null; apply: boolean; json: boolean };

export function parseFlags(argv: readonly string[]): TaxBackfillFlags {
  const flags: TaxBackfillFlags = { propertyId: null, apply: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--property") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error('Flag "--property" requires a value.');
      flags.propertyId = v;
      i++;
    } else if (arg === "--apply") flags.apply = true;
    else if (arg === "--dry-run") flags.apply = false;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--") continue;
    else throw new Error(`Unknown flag "${arg}". Known: --apply, --dry-run (default), --property <id>, --json.`);
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type PropertyRegionChange = {
  propertyId: string;
  propertyName: string;
  organizationId: string;
  province: string | null;
  before: string | null;
  after: TaxRegion | null;
  /** unchanged · normalized (property and/or compliance row rewritten) · unresolved (no region, no province) */
  action: "unchanged" | "normalized" | "unresolved";
  complianceBefore: string | null | undefined;
};

export type LegacyTaxChange = {
  taxId: string;
  organizationId: string;
  code: string;
  taxRegion: string;
  canonical: TaxRegion | null;
  /** renamed to the canonical region · kept_orphan (a canonical row already exists) · unmapped (unknown legacy region) */
  action: "renamed" | "kept_orphan" | "unmapped";
  ratesExpired: number;
};

export type ProvisionResult = {
  propertyId: string;
  taxRegion: TaxRegion | null;
  provisioned: number;
  skipped: number;
  error?: string;
};

export type DraftLineChange = {
  lineId: string;
  description: string;
  lineType: string | null;
  before: { taxCode: string; taxRate: number; taxCategory: string | null; taxCalificacion: string | null; taxFigure: string | null };
  after: { taxCode: string; taxRate: number; taxCategory: TaxCategory; taxCalificacion: string; taxFigure: string };
};

export type DraftInvoiceResult = {
  invoiceId: string;
  propertyId: string;
  lines: number;
  changedLines: number;
  sampleChanges: DraftLineChange[];
  totalBefore: number;
  taxTotalBefore: number;
  totalAfter: number;
  taxTotalAfter: number;
  breakdown: TaxBreakdownGroup[];
  error?: string;
};

export type ImmutableInvoice = {
  invoiceId: string;
  propertyId: string;
  invoiceNumber: string | null;
  status: string;
  issuedAt: string | null;
  unknownLines: number;
  zeroSubjectLines: number;
  total: number;
  taxTotal: number;
};

export type TaxBackfillSummary = {
  dryRun: boolean;
  propertyFilter: string | null;
  regions: PropertyRegionChange[];
  legacyTaxes: LegacyTaxChange[];
  provisioning: ProvisionResult[];
  drafts: DraftInvoiceResult[];
  immutable: ImmutableInvoice[];
  totals: {
    propertiesNormalized: number;
    propertiesUnresolved: number;
    legacyTaxesMigrated: number;
    legacyRatesExpired: number;
    ratesProvisioned: number;
    draftInvoicesChanged: number;
    draftLinesChanged: number;
    immutableInvoices: number;
    failed: number;
  };
  durationMs: number;
};

const MS_DAY = 86_400_000;
const SAMPLE_LIMIT = 5;

function num(value: unknown): number {
  return Number(value);
}

// ---------------------------------------------------------------------------
// Step 1 · property regions
// ---------------------------------------------------------------------------

async function normalizePropertyRegions(
  properties: Array<{ id: string; organizationId: string; name: string; taxRegion: string | null; province: string | null }>,
  apply: boolean
): Promise<PropertyRegionChange[]> {
  const results: PropertyRegionChange[] = [];
  for (const p of properties) {
    const after = normalizeTaxRegion(p.taxRegion, p.province);
    const compliance = await prisma.propertyComplianceSetting.findUnique({ where: { propertyId: p.id }, select: { taxRegion: true } });
    const complianceBefore = compliance ? compliance.taxRegion : undefined;
    let action: PropertyRegionChange["action"];
    if (after === null) {
      action = "unresolved";
    } else if (p.taxRegion === after && (compliance === null || compliance.taxRegion === after)) {
      action = "unchanged";
    } else {
      action = "normalized";
      if (apply) {
        if (p.taxRegion !== after) await prisma.property.update({ where: { id: p.id }, data: { taxRegion: after } });
        if (compliance && compliance.taxRegion !== after) {
          await prisma.propertyComplianceSetting.update({ where: { propertyId: p.id }, data: { taxRegion: after } });
        }
      }
    }
    results.push({ propertyId: p.id, propertyName: p.name, organizationId: p.organizationId, province: p.province, before: p.taxRegion, after, action, complianceBefore });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Step 2 · legacy Tax rows (mainland / canary / ceuta / melilla …)
// ---------------------------------------------------------------------------

async function migrateLegacyTaxes(organizationIds: string[], apply: boolean, today: Date): Promise<LegacyTaxChange[]> {
  const yesterday = new Date(today.getTime() - MS_DAY);
  const legacy = await prisma.tax.findMany({
    where: { organizationId: { in: organizationIds }, taxRegion: { notIn: [...TAX_REGIONS] } },
    orderBy: { createdAt: "asc" }
  });
  const results: LegacyTaxChange[] = [];
  for (const tax of legacy) {
    const canonical = normalizeTaxRegion(tax.taxRegion);
    // Every rate still open on the legacy row is closed yesterday: postings
    // dated before today keep resolving the historical tier; from today the
    // category rows of the catalogue apply.
    const openRates = await prisma.taxRate.findMany({
      where: { taxId: tax.id, active: true, OR: [{ validTo: null }, { validTo: { gte: today } }] },
      select: { id: true, validFrom: true }
    });
    let action: LegacyTaxChange["action"] = "unmapped";
    if (canonical) {
      const canonicalRow = await prisma.tax.findUnique({
        where: { organizationId_code_taxRegion: { organizationId: tax.organizationId, code: tax.code, taxRegion: canonical } },
        select: { id: true }
      });
      action = canonicalRow ? "kept_orphan" : "renamed";
    }
    if (apply) {
      for (const rate of openRates) {
        if (rate.validFrom.getTime() <= yesterday.getTime()) {
          await prisma.taxRate.update({ where: { id: rate.id }, data: { validTo: yesterday } });
        } else {
          await prisma.taxRate.update({ where: { id: rate.id }, data: { active: false } });
        }
      }
      if (action === "renamed" && canonical) {
        await prisma.tax.update({
          where: { id: tax.id },
          data: { taxRegion: canonical, verifactuImpuesto: figureForRegion(canonical).impuesto, code: figureForRegion(canonical).figure }
        });
      }
    }
    results.push({ taxId: tax.id, organizationId: tax.organizationId, code: tax.code, taxRegion: tax.taxRegion, canonical, action, ratesExpired: openRates.length });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Step 3 · provisioning
// ---------------------------------------------------------------------------

async function planPropertyTaxes(organizationId: string, region: TaxRegion): Promise<{ provisioned: number; skipped: number }> {
  const { figure } = figureForRegion(region);
  const tax = await prisma.tax.findUnique({
    where: { organizationId_code_taxRegion: { organizationId, code: figure, taxRegion: region } },
    select: { id: true }
  });
  if (!tax) return { provisioned: TAX_CATEGORIES.length, skipped: 0 };
  const existing = await prisma.taxRate.findMany({
    where: { taxId: tax.id, active: true, category: { in: [...TAX_CATEGORIES] } },
    select: { category: true, appliesTo: true }
  });
  const covered = new Set(existing.filter((r) => r.appliesTo === r.category || r.appliesTo === "*").map((r) => r.category));
  const skipped = TAX_CATEGORIES.filter((c) => covered.has(c)).length;
  return { provisioned: TAX_CATEGORIES.length - skipped, skipped };
}

async function provisionProperties(regions: PropertyRegionChange[], apply: boolean): Promise<ProvisionResult[]> {
  const results: ProvisionResult[] = [];
  for (const r of regions) {
    if (r.after === null) {
      results.push({ propertyId: r.propertyId, taxRegion: null, provisioned: 0, skipped: 0 });
      continue;
    }
    try {
      if (apply) {
        const done = await ensurePropertyTaxes({ propertyId: r.propertyId, organizationId: r.organizationId, taxRegion: r.after });
        results.push({ propertyId: r.propertyId, ...done });
      } else {
        // Dry-run: the legacy Tax row may be renamed in step 2, in which case
        // the catalogue rows are added to it; either way the missing
        // categories are the same.
        const plan = await planPropertyTaxes(r.organizationId, r.after);
        results.push({ propertyId: r.propertyId, taxRegion: r.after, ...plan });
      }
    } catch (error) {
      results.push({ propertyId: r.propertyId, taxRegion: r.after, provisioned: 0, skipped: 0, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Step 4 · draft invoices
// ---------------------------------------------------------------------------

// Category implied by the code/rate a line already carries when it cannot be
// traced back to a folio line: N1 → not_subject; a statutory S1 percent →
// the first category with that tier (accommodation before general services);
// unknown / 0 % → accommodation (the "Servicios hoteleros" summary line of a
// manual draft is lodging by default).
export function inferCategoryFromCode(region: TaxRegion, taxCode: string, taxRate: number): TaxCategory {
  const parsed = parseTaxCode(taxCode);
  if (parsed.calificacion === "N1") return "not_subject";
  const percent = parsed.figure === "UNKNOWN" ? taxRate : parsed.percent;
  if (percent > 0) {
    for (const row of statutoryRates(region)) {
      if (row.calificacion === "S1" && row.percent === percent && row.category !== "tourist_tax") return row.category;
    }
  }
  return "accommodation";
}

async function rewriteDraftInvoices(regions: PropertyRegionChange[], apply: boolean, today: Date): Promise<DraftInvoiceResult[]> {
  const regionByProperty = new Map(regions.map((r) => [r.propertyId, r.after]));
  const propertyIds = regions.filter((r) => r.after !== null).map((r) => r.propertyId);
  const drafts = await prisma.invoice.findMany({
    where: { propertyId: { in: propertyIds }, status: "draft", deletedAt: null },
    select: { id: true, propertyId: true, folioId: true, total: true, taxTotal: true },
    orderBy: { createdAt: "asc" }
  });
  const results: DraftInvoiceResult[] = [];
  for (const invoice of drafts) {
    const region = regionByProperty.get(invoice.propertyId);
    if (!region) continue;
    try {
      const lines = await prisma.invoiceLine.findMany({ where: { invoiceId: invoice.id }, orderBy: { id: "asc" } });
      const folioLines = invoice.folioId
        ? await prisma.folioLine.findMany({ where: { folioId: invoice.folioId, deletedAt: null }, select: { id: true, type: true, description: true, total: true, taxCategory: true } })
        : [];
      const unusedFolioLines = [...folioLines];

      const changes: DraftLineChange[] = [];
      const totalsInput: InvoiceTotalsLine[] = [];
      const updates = new Map<string, { ids: string[]; data: DraftLineChange["after"] }>();
      for (const line of lines) {
        const matchIndex = unusedFolioLines.findIndex((f) => f.description === line.description && num(f.total) === num(line.total));
        const matched = matchIndex >= 0 ? unusedFolioLines.splice(matchIndex, 1)[0] : null;
        const category: TaxCategory = isTaxCategory(line.taxCategory)
          ? line.taxCategory
          : matched
            ? categoryForLineType(matched.type, matched.taxCategory)
            : inferCategoryFromCode(region, line.taxCode, num(line.taxRate));
        const resolved = await resolveTaxRate({ propertyId: invoice.propertyId, lineType: matched?.type ?? category, taxCategory: category, postingDate: today });
        const after: DraftLineChange["after"] = {
          taxCode: resolved.canonicalTaxCode,
          taxRate: resolved.ratePercent,
          taxCategory: resolved.category,
          taxCalificacion: resolved.calificacion,
          taxFigure: resolved.figure
        };
        totalsInput.push({ total: num(line.total), ratePercent: resolved.ratePercent, figure: resolved.figure, impuesto: resolved.impuesto, calificacion: resolved.calificacion });
        const before = { taxCode: line.taxCode, taxRate: num(line.taxRate), taxCategory: line.taxCategory, taxCalificacion: line.taxCalificacion, taxFigure: line.taxFigure };
        const changed =
          before.taxCode !== after.taxCode ||
          before.taxRate !== after.taxRate ||
          before.taxCategory !== after.taxCategory ||
          before.taxCalificacion !== after.taxCalificacion ||
          before.taxFigure !== after.taxFigure;
        if (!changed) continue;
        changes.push({ lineId: line.id, description: line.description, lineType: matched?.type ?? null, before, after });
        const key = JSON.stringify(after);
        const group = updates.get(key) ?? { ids: [], data: after };
        group.ids.push(line.id);
        updates.set(key, group);
      }

      const totals = computeInvoiceTotals(totalsInput);
      const totalBefore = num(invoice.total);
      const taxTotalBefore = num(invoice.taxTotal);
      const totalsChanged = totals.total !== totalBefore || totals.taxTotal !== taxTotalBefore;
      if (apply && (changes.length > 0 || totalsChanged)) {
        await prisma.$transaction(async (tx) => {
          for (const group of updates.values()) {
            await tx.invoiceLine.updateMany({ where: { id: { in: group.ids } }, data: group.data });
          }
          await tx.invoice.update({
            where: { id: invoice.id },
            data: { total: totals.total, taxTotal: totals.taxTotal, taxBreakdownJson: totals.breakdown as object[] }
          });
        });
      }
      if (changes.length > 0 || totalsChanged) {
        results.push({
          invoiceId: invoice.id,
          propertyId: invoice.propertyId,
          lines: lines.length,
          changedLines: changes.length,
          sampleChanges: changes.slice(0, SAMPLE_LIMIT),
          totalBefore,
          taxTotalBefore,
          totalAfter: totals.total,
          taxTotalAfter: totals.taxTotal,
          breakdown: totals.breakdown
        });
      }
    } catch (error) {
      results.push({
        invoiceId: invoice.id,
        propertyId: invoice.propertyId,
        lines: 0,
        changedLines: 0,
        sampleChanges: [],
        totalBefore: num(invoice.total),
        taxTotalBefore: num(invoice.taxTotal),
        totalAfter: num(invoice.total),
        taxTotalAfter: num(invoice.taxTotal),
        breakdown: [],
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Step 5 · immutable invoices (report only)
// ---------------------------------------------------------------------------

async function listImmutableInvoices(propertyIds: string[]): Promise<ImmutableInvoice[]> {
  const invoices = await prisma.invoice.findMany({
    where: { propertyId: { in: propertyIds }, status: { in: ["issued", "cancelled", "rectified"] }, deletedAt: null },
    select: { id: true, propertyId: true, invoiceNumber: true, status: true, issuedAt: true, total: true, taxTotal: true },
    orderBy: [{ propertyId: "asc" }, { issuedAt: "asc" }]
  });
  const results: ImmutableInvoice[] = [];
  for (const invoice of invoices) {
    const lines = await prisma.invoiceLine.findMany({
      where: { invoiceId: invoice.id },
      select: { taxCode: true, taxRate: true, taxCalificacion: true, taxCategory: true }
    });
    const unknownLines = lines.filter((l) => parseTaxCode(l.taxCode).figure === "UNKNOWN").length;
    const zeroSubjectLines = lines.filter(
      (l) => num(l.taxRate) === 0 && l.taxCalificacion !== "N1" && l.taxCategory !== "not_subject" && parseTaxCode(l.taxCode).calificacion !== "N1"
    ).length;
    if (unknownLines === 0 && zeroSubjectLines === 0) continue;
    results.push({
      invoiceId: invoice.id,
      propertyId: invoice.propertyId,
      invoiceNumber: invoice.invoiceNumber,
      status: invoice.status,
      issuedAt: invoice.issuedAt ? invoice.issuedAt.toISOString() : null,
      unknownLines,
      zeroSubjectLines,
      total: num(invoice.total),
      taxTotal: num(invoice.taxTotal)
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runTaxBackfill(flags: TaxBackfillFlags, today: Date = dayUtc(new Date())): Promise<TaxBackfillSummary> {
  const start = Date.now();
  const apply = flags.apply;

  const properties = await prisma.property.findMany({
    where: flags.propertyId ? { id: flags.propertyId } : undefined,
    select: { id: true, organizationId: true, name: true, taxRegion: true, province: true },
    orderBy: { createdAt: "asc" }
  });
  if (flags.propertyId && properties.length === 0) throw new Error(`Property ${flags.propertyId} not found.`);
  const organizationIds = [...new Set(properties.map((p) => p.organizationId))];

  const regions = await normalizePropertyRegions(properties, apply);
  const legacyTaxes = await migrateLegacyTaxes(organizationIds, apply, today);
  const provisioning = await provisionProperties(regions, apply);
  // The resolver caches property context + rates for 5 minutes: drop it so
  // the draft rewrite sees the rows written above.
  invalidateTaxCache();
  const drafts = await rewriteDraftInvoices(regions, apply, today);
  const immutable = await listImmutableInvoices(properties.map((p) => p.id));
  invalidateTaxCache();

  const failed = provisioning.filter((p) => p.error).length + drafts.filter((d) => d.error).length;
  return {
    dryRun: !apply,
    propertyFilter: flags.propertyId,
    regions,
    legacyTaxes,
    provisioning,
    drafts,
    immutable,
    totals: {
      propertiesNormalized: regions.filter((r) => r.action === "normalized").length,
      propertiesUnresolved: regions.filter((r) => r.action === "unresolved").length,
      legacyTaxesMigrated: legacyTaxes.filter((t) => t.action === "renamed").length,
      legacyRatesExpired: legacyTaxes.reduce((acc, t) => acc + t.ratesExpired, 0),
      ratesProvisioned: provisioning.reduce((acc, p) => acc + p.provisioned, 0),
      draftInvoicesChanged: drafts.filter((d) => !d.error).length,
      draftLinesChanged: drafts.reduce((acc, d) => acc + d.changedLines, 0),
      immutableInvoices: immutable.length,
      failed
    },
    durationMs: Date.now() - start
  };
}

function printHuman(summary: TaxBackfillSummary): void {
  const mode = summary.dryRun ? "DRY-RUN (no writes)" : "APPLIED";
  const lines: string[] = [
    `[backfill:taxes] ${mode}${summary.propertyFilter ? ` · property ${summary.propertyFilter}` : ""} · ${summary.durationMs} ms`,
    `  properties: ${summary.regions.length} · normalized ${summary.totals.propertiesNormalized} · unresolved ${summary.totals.propertiesUnresolved}`
  ];
  for (const r of summary.regions) {
    const compliance = r.complianceBefore === undefined ? "no compliance row" : `compliance «${r.complianceBefore ?? "NULL"}»`;
    lines.push(`    ${r.action.padEnd(10)} ${r.propertyId} (${r.propertyName}): «${r.before ?? "NULL"}» → ${r.after ?? "—"} [province ${r.province ?? "—"}; ${compliance}]`);
  }
  lines.push(`  legacy Tax rows: ${summary.legacyTaxes.length} · renamed ${summary.totals.legacyTaxesMigrated} · rates closed ${summary.totals.legacyRatesExpired}`);
  for (const t of summary.legacyTaxes) {
    lines.push(`    ${t.action.padEnd(11)} ${t.taxId} ${t.organizationId} ${t.code}/${t.taxRegion} → ${t.canonical ?? "—"} (${t.ratesExpired} rates → validTo yesterday)`);
  }
  lines.push(`  provisioning: +${summary.totals.ratesProvisioned} rates`);
  for (const p of summary.provisioning) {
    lines.push(`    ${p.propertyId}: ${p.taxRegion ?? "skipped (no region)"} +${p.provisioned} / kept ${p.skipped}${p.error ? ` FAILED ${p.error}` : ""}`);
  }
  lines.push(`  draft invoices: ${summary.totals.draftInvoicesChanged} changed · ${summary.totals.draftLinesChanged} lines`);
  for (const d of summary.drafts) {
    lines.push(
      `    ${d.invoiceId} (${d.propertyId}): ${d.changedLines}/${d.lines} lines · total ${d.totalBefore} → ${d.totalAfter} · tax ${d.taxTotalBefore} → ${d.taxTotalAfter}${d.error ? ` FAILED ${d.error}` : ""}`
    );
    for (const c of d.sampleChanges) {
      lines.push(`      ${c.lineId} «${c.description}» [${c.lineType ?? "?"}] ${c.before.taxCode}@${c.before.taxRate} → ${c.after.taxCode}@${c.after.taxRate} (${c.after.taxCategory}/${c.after.taxCalificacion})`);
    }
    if (d.changedLines > d.sampleChanges.length) lines.push(`      … ${d.changedLines - d.sampleChanges.length} more`);
  }
  lines.push(`  immutable invoices with ES_UNKNOWN / 0 % S1 lines (NOT touched — rectify manually): ${summary.immutable.length}`);
  for (const i of summary.immutable) {
    lines.push(`    ${i.status.padEnd(9)} ${i.invoiceNumber ?? i.invoiceId} (${i.propertyId}) unknown ${i.unknownLines} · zero-S1 ${i.zeroSubjectLines} · total ${i.total} tax ${i.taxTotal}`);
  }
  if (summary.totals.failed > 0) lines.push(`  FAILED steps: ${summary.totals.failed}`);
  console.log(lines.join("\n"));
}

// CLI entrypoint: only runs when invoked directly (same guard as backfill-snapshots.ts).
const entryFile = resolvePath(fileURLToPath(import.meta.url));
const argFile = process.argv[1] ? resolvePath(process.argv[1]) : "";
if (entryFile === argFile) {
  let flags: TaxBackfillFlags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (error) {
    console.error(`[backfill:taxes] ${(error as Error).message}`);
    process.exit(2);
  }
  runTaxBackfill(flags)
    .then((summary) => {
      if (flags.json) console.log(JSON.stringify(summary, null, 2));
      else printHuman(summary);
      return prisma.$disconnect().then(() => summary.totals.failed);
    })
    .then((failed) => process.exit(failed > 0 ? 1 : 0))
    .catch(async (error) => {
      console.error("[backfill:taxes] failed:", error);
      await prisma.$disconnect().catch(() => undefined);
      process.exit(1);
    });
}
