// Ledger HTTP surface (Finanzas · lote ledger · 2026-09-15).
//
// Registered from server.ts with `registerLedgerRoutes(app)` (integrator).
// Permissions: route-permissions.partial.ts — entries merged into
// routePermissionManifest; the contract test reads that file.
//
// Tenancy: every route acts on the caller's organisation
// (request.userContext.organizationId); an entry id goes through
// assertEntityAccess (404 for another organisation's asiento); a propertyId
// in the query is validated by the global property hook. Bodies and queries
// are zod-validated here (.strict(), Spanish messages) so direct callers get
// the same 400s as the UI. Money in bodies travels as strings ("121.00") or
// numbers with two decimals; the engine rounds HALF_UP to the cent.
//
// Replaces (integrator): GET /organizations/:id/journal-entries,
// POST /journal-entries/drafts, POST /journal-entries/:id/post,
// GET /accounting/journal-entries/recent and GET /organizations/:id/accounts.
//
// Estructura societaria (Tanda 6b · L5, design §5.2 R11): every read with
// amounts of the three finance route families (ledger, fiscal, financial
// statements) goes through `assertFinanceReadScope` below. A user WITHOUT
// `accounting.entity.read` whose roles cover a subset of the centres
// (`assignedPropertyIds`) can only read WITH a `propertyId` of an assigned
// centre; the whole-sociedad scope (no `propertyId`) and a sister centre are
// an opaque 404, never a 403 that would confirm what exists. Platform admins
// and contexts without assignments (organization-wide by construction, same
// rule as lib/tenancy.ts isPropertyAssigned) keep the full scope. The helper
// lives here because the three route files are the only callers and the L1
// helper module (lib/finance-scope.ts) is closed; it mirrors
// `propertyWithinScope` from there.
//
// Writes follow the same rule (fix t6b#5, design R4 + R11): a manual asiento
// WITHOUT centre (`societyLevel: true`, or a balance-sheet-only entry with no
// `propertyId`) is booked on the whole sociedad, so posting or reversing one
// needs the whole-sociedad scope too (`assertFinanceWriteScope`); a centre's
// asiento needs that centre. Otherwise a director whose only role lives in one
// hotel could post society-level entries (property_id NULL) he is not allowed
// to read back.

import { prisma } from "@hotelos/database";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { assertFinanceReadScope, assertFinanceWriteScope } from "../../lib/finance-scope.js";
import { NotFoundError } from "../../lib/http-error.js";
import { createId } from "../../lib/ids.js";
import { pageHeaders, parsePageQuery } from "../../lib/pagination.js";
import { assertEntityAccess, resolveOrganizationScope } from "../../lib/tenancy.js";
import { parse } from "../../lib/validate.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";

/**
 * Tanda 8a (brief §3 «Exportación contable»): fiscal periods of the
 * organisation (society-level and, when given, the centre) that overlap the
 * exported range, with the ones still open. `provisional` is true when some
 * period of the range is not closed, or when no closed period covers the
 * range at all (nothing has been closed: the export is a working copy). The
 * export is never blocked: the hard rule «solo periodos cerrados» is the
 * integrator's decision (ThresholdAction accounting_export is reserved for
 * it in role_thresholds).
 */
export async function fiscalPeriodsOfRange(input: { organizationId: string; propertyId?: string | null; from?: string; to?: string }): Promise<{ periodsOpen: string[]; periodsClosed: string[]; provisional: boolean }> {
  const rows = await prisma.fiscalPeriod.findMany({
    where: {
      organizationId: input.organizationId,
      ...(input.propertyId ? { OR: [{ propertyId: input.propertyId }, { propertyId: null }] } : {}),
      ...(input.from ? { endDate: { gte: new Date(`${input.from}T00:00:00.000Z`) } } : {}),
      ...(input.to ? { startDate: { lte: new Date(`${input.to}T00:00:00.000Z`) } } : {})
    },
    select: { periodCode: true, status: true, propertyId: true },
    orderBy: { startDate: "asc" }
  });
  const label = (row: { periodCode: string; propertyId: string | null }) => (row.propertyId ? `${row.periodCode}@${row.propertyId}` : row.periodCode);
  const periodsOpen = rows.filter((row) => row.status !== "closed").map(label);
  const periodsClosed = rows.filter((row) => row.status === "closed").map(label);
  return { periodsOpen, periodsClosed, provisional: periodsOpen.length > 0 || periodsClosed.length === 0 };
}
import {
  createChartAccount,
  createManualJournalEntry,
  exportJournal,
  getAccountLedger,
  getAccountingSettings,
  getJournalEntry,
  ledgerToCsv,
  listChartAccounts,
  listJournal,
  patchChartAccount,
  reverseJournalEntryByUser,
  updateAccountingSettings
} from "./accounting.service.js";
import { getProjectionStatus, replayAccountingProjection } from "./projection.js";

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: "Fecha con formato YYYY-MM-DD." });
const moneyField = z.union([z.string().regex(/^-?\d+(\.\d{1,2})?$/, { message: "Importe con hasta dos decimales." }), z.number().finite()]);
const accountCodeField = z.string().regex(/^[1-9][0-9]{0,7}(\.[0-9]{1,3})?$/, { message: "Código de cuenta PGC (p. ej. 705.1 o 4300)." });

const JournalQuerySchema = z
  .object({
    from: isoDay.optional(),
    to: isoDay.optional(),
    propertyId: z.string().min(1).optional(),
    sourceType: z.string().min(1).max(40).optional(),
    status: z.enum(["draft", "posted", "reversed"], { message: "status debe ser draft, posted o reversed." }).optional(),
    accountCode: accountCodeField.optional(),
    q: z.string().max(200).optional(),
    limit: z.string().optional(),
    cursor: z.string().optional(),
    envelope: z.string().optional()
  })
  .strict({ message: "Parámetro de consulta no admitido." });

const ManualLineSchema = z
  .object({
    accountCode: accountCodeField,
    debit: moneyField.optional(),
    credit: moneyField.optional(),
    description: z.string().max(500).optional(),
    taxRateCode: z.string().max(4).optional(),
    taxBase: moneyField.optional(),
    costCenterId: z.string().min(1).optional()
  })
  .strict({ message: "Campo no admitido en una línea del asiento." });

const ManualEntrySchema = z
  .object({
    entryDate: isoDay,
    description: z.string().min(1, { message: "El concepto es obligatorio." }).max(500),
    reference: z.string().max(200).optional(),
    propertyId: z.string().min(1).optional(),
    // Tanda 6b (R4, L4): asiento de sociedad sin centro (grupos 6/7 admitidos sin propertyId).
    societyLevel: z.boolean().optional(),
    lines: z.array(ManualLineSchema).min(2, { message: "Un asiento necesita al menos dos líneas." }).max(500)
  })
  .strict({ message: "Campo no admitido en el cuerpo de la petición." });

const ReverseSchema = z
  .object({
    reason: z.string().min(1, { message: "Indica el motivo de la anulación." }).max(500),
    entryDate: isoDay.optional()
  })
  .strict({ message: "Campo no admitido en el cuerpo de la petición." });

const LedgerQuerySchema = z
  .object({
    from: isoDay.optional(),
    to: isoDay.optional(),
    propertyId: z.string().min(1).optional(),
    format: z.enum(["json", "csv"], { message: "format debe ser json o csv." }).optional()
  })
  .strict({ message: "Parámetro de consulta no admitido." });

const ChartQuerySchema = z.object({ postableOnly: z.enum(["1", "true", "0", "false"]).optional() }).strict({ message: "Parámetro de consulta no admitido." });

const usaliField = z.string().min(2).max(40).nullable();

const ChartCreateSchema = z
  .object({
    code: accountCodeField,
    name: z.string().min(2).max(200),
    kind: z.enum(["asset", "liability", "equity", "income", "expense"], { message: "kind debe ser asset, liability, equity, income o expense." }).optional(),
    isPostable: z.boolean().optional(),
    usaliDepartment: usaliField.optional(),
    usaliLine: usaliField.optional()
  })
  .strict({ message: "Campo no admitido en el cuerpo de la petición." });

const ChartPatchSchema = z
  .object({
    name: z.string().min(2).max(200).optional(),
    isPostable: z.boolean().optional(),
    usaliDepartment: usaliField.optional(),
    usaliLine: usaliField.optional()
  })
  .strict({ message: "Campo no admitido en el cuerpo de la petición." });

const SettingsPatchSchema = z
  .object({
    fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
    vatPeriodicity: z.enum(["quarterly", "monthly"], { message: "vatPeriodicity debe ser quarterly o monthly." }).optional(),
    vatRegime: z.enum(["general", "redeme", "recargo"], { message: "vatRegime debe ser general, redeme o recargo." }).optional(),
    prorrataPct: moneyField.nullable().optional(),
    taxFigure: z.enum(["IVA", "IGIC", "IPSI"], { message: "taxFigure debe ser IVA, IGIC o IPSI." }).optional()
  })
  .strict({ message: "Campo no admitido en el cuerpo de la petición." });

const ReplaySchema = z
  .object({
    organizationId: z.string().min(1).optional(),
    propertyId: z.string().min(1).optional(),
    from: isoDay,
    to: isoDay,
    apply: z.boolean().optional(),
    kinds: z.array(z.enum(["invoice", "payment", "pos"], { message: "kinds admite invoice, payment y pos." })).optional()
  })
  .strict({ message: "Campo no admitido en el cuerpo de la petición." });

function flag(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

// ── Whole-sociedad read scope (Tanda 6b · R11) ──────────────────────────────
// The helpers live in lib/finance-scope.ts (next to `propertyWithinScope`) so
// that services never import a routes module; re-exported here for the
// importers that predate the move (tests, server.ts).
export { ENTITY_READ_PERMISSION, assertFinanceReadScope, assertFinanceReadScopeMany, assertFinanceWriteScope, hasEntityReadScope, type FinanceScopeContext } from "../../lib/finance-scope.js";

function sendCsv(reply: FastifyReply, filename: string, csv: string): string {
  reply.header("Content-Type", "text/csv; charset=utf-8");
  reply.header("Content-Disposition", `attachment; filename="${filename}"`);
  return csv;
}

export function registerLedgerRoutes(app: FastifyInstance): void {
  // ---- Diario ---------------------------------------------------------------
  app.get("/accounting/journal", async (request, reply) => {
    const raw = (request.query ?? {}) as Record<string, unknown>;
    const q = parse(JournalQuerySchema, raw, "query");
    assertFinanceReadScope(request.userContext, q.propertyId ?? null);
    const page = parsePageQuery(raw, { limit: 50, max: 500 });
    const result = await listJournal({
      context: request.userContext,
      query: { from: q.from, to: q.to, propertyId: q.propertyId, sourceType: q.sourceType, status: q.status, accountCode: q.accountCode, q: q.q, limit: page.limit, cursor: page.cursor }
    });
    reply.headers(pageHeaders(result));
    return page.envelope ? result : result.items;
  });

  app.get("/accounting/journal/export", async (request, reply) => {
    const q = parse(JournalQuerySchema, request.query ?? {}, "query");
    assertFinanceReadScope(request.userContext, q.propertyId ?? null);
    const result = await exportJournal({ context: request.userContext, query: { from: q.from, to: q.to, propertyId: q.propertyId, sourceType: q.sourceType, status: q.status, accountCode: q.accountCode, q: q.q } });
    // Tanda 8a: every accounting export leaves a trace (actor, range, format,
    // open periods, provisional) — audited, never blocked (see fiscalPeriodsOfRange).
    const periods = await fiscalPeriodsOfRange({ organizationId: request.userContext.organizationId, propertyId: q.propertyId ?? null, from: q.from, to: q.to });
    recordAuditEvent({
      organizationId: request.userContext.organizationId,
      propertyId: q.propertyId ?? undefined,
      actorUserId: request.userContext.userId,
      actorType: "user",
      action: "ACCOUNTING_EXPORTED",
      entityType: "journal_export",
      entityId: `${request.userContext.organizationId}:${q.from ?? "*"}:${q.to ?? "*"}`,
      afterJson: { format: "csv", from: q.from ?? null, to: q.to ?? null, propertyId: q.propertyId ?? null, entries: result.entries, periodsOpen: periods.periodsOpen, periodsClosed: periods.periodsClosed, provisional: periods.provisional },
      deviceId: request.userContext.deviceId,
      correlationId: createId("corr")
    });
    reply.header("X-Total-Count", String(result.entries));
    reply.header("X-Export-Provisional", periods.provisional ? "true" : "false");
    return sendCsv(reply, `diario${q.from ? `-${q.from}` : ""}${q.to ? `-${q.to}` : ""}.csv`, result.csv);
  });

  app.post("/accounting/journal", async (request, reply) => {
    const body = parse(ManualEntrySchema, request.body ?? {}, "body");
    // R4 + R11: no `propertyId` (societyLevel or balance-only) = asiento of the whole sociedad → whole-sociedad scope; a centre → that centre.
    assertFinanceWriteScope(request.userContext, body.propertyId ?? null);
    const posted = await createManualJournalEntry({ context: request.userContext, body, correlationId: createId("corr") });
    reply.code(201);
    return posted;
  });

  app.get("/accounting/journal/:id", async (request) => {
    const { id } = request.params as { id: string };
    await assertEntityAccess(request, { entity: "journalEntry", id });
    const entry = await getJournalEntry({ context: request.userContext, journalEntryId: id });
    // A society-level entry (no centre) needs the whole-sociedad scope; a centre's entry, that centre (R11).
    assertFinanceReadScope(request.userContext, entry.propertyId);
    return entry;
  });

  app.post("/accounting/journal/:id/reverse", async (request, reply) => {
    const { id } = request.params as { id: string };
    await assertEntityAccess(request, { entity: "journalEntry", id });
    const body = parse(ReverseSchema, request.body ?? {}, "body");
    // Reversing a society-level asiento (no centre) is a write on the whole sociedad; a centre's asiento, on that centre (R4 + R11).
    const target = await prisma.journalEntry.findFirst({ where: { id, organizationId: request.userContext.organizationId }, select: { propertyId: true } });
    if (!target) throw new NotFoundError("Asiento no encontrado.");
    assertFinanceWriteScope(request.userContext, target.propertyId);
    const reversal = await reverseJournalEntryByUser({ context: request.userContext, journalEntryId: id, reason: body.reason, entryDate: body.entryDate, correlationId: createId("corr") });
    reply.code(201);
    return reversal;
  });

  // ---- Mayor ----------------------------------------------------------------
  app.get("/accounting/ledger/:accountCode", async (request, reply) => {
    const { accountCode } = request.params as { accountCode: string };
    const q = parse(LedgerQuerySchema, request.query ?? {}, "query");
    assertFinanceReadScope(request.userContext, q.propertyId ?? null);
    const ledger = await getAccountLedger({ context: request.userContext, accountCode, from: q.from, to: q.to, propertyId: q.propertyId });
    if (q.format === "csv") return sendCsv(reply, `mayor-${accountCode}${q.from ? `-${q.from}` : ""}-${ledger.to}.csv`, ledgerToCsv(ledger));
    return ledger;
  });

  // ---- Plan de cuentas ------------------------------------------------------
  app.get("/accounting/chart", async (request) => {
    const q = parse(ChartQuerySchema, request.query ?? {}, "query");
    return listChartAccounts({ context: request.userContext, postableOnly: flag(q.postableOnly) });
  });

  app.post("/accounting/chart", async (request, reply) => {
    const body = parse(ChartCreateSchema, request.body ?? {}, "body");
    const created = await createChartAccount({ context: request.userContext, body, correlationId: createId("corr") });
    reply.code(201);
    return created;
  });

  app.patch("/accounting/chart/:code", async (request) => {
    const { code } = request.params as { code: string };
    const body = parse(ChartPatchSchema, request.body ?? {}, "body");
    return patchChartAccount({ context: request.userContext, code, body, correlationId: createId("corr") });
  });

  // ---- Ajustes --------------------------------------------------------------
  app.get("/accounting/settings", async (request) => {
    return getAccountingSettings({ context: request.userContext });
  });

  app.patch("/accounting/settings", async (request) => {
    const body = parse(SettingsPatchSchema, request.body ?? {}, "body");
    return updateAccountingSettings({ context: request.userContext, body, correlationId: createId("corr") });
  });

  // ---- Re-proyección y estado de la proyección --------------------------------
  app.post("/accounting/replay", async (request) => {
    const body = parse(ReplaySchema, request.body ?? {}, "body");
    requirePermissions(request.userContext, ["accounting.journal.post", "ai.high_risk.confirm"]);
    // A platform admin may name another organisation; everyone else gets their own (404 otherwise).
    const organizationId = await resolveOrganizationScope(request, body.organizationId);
    return replayAccountingProjection({
      organizationId,
      propertyId: body.propertyId ?? null,
      from: body.from,
      to: body.to,
      apply: body.apply === true,
      kinds: body.kinds,
      actorUserId: request.userContext.userId,
      correlationId: createId("corr")
    });
  });

  app.get("/accounting/projection/status", async (request) => {
    requirePermissions(request.userContext, ["accounting.read"]);
    return getProjectionStatus();
  });
}
