// Finanzas · estados financieros (lote usali-cuentas): HTTP surface.
//
// Registered from server.ts with `registerFinancialStatementsRoutes(app)`
// (INTEGRADOR); permissions in route-permissions.partial.ts (merged into
// routePermissionManifest; the contract test reads both files).
//
// Tenancy: every route is scoped by request.userContext.organizationId; a
// `propertyId` in the query goes through the global preHandler
// (grantPropertyAccess → opaque 404 for a foreign or unassigned property) and
// the services re-check that the property belongs to the organisation.
// Snapshots and exports are fetched by id + organizationId (404 otherwise).
// Downloads (format=pdf|xlsx|csv) set content-type and content-disposition;
// JSON is the default.

import type { FastifyInstance, FastifyReply } from "fastify";
import { createId } from "../../lib/ids.js";
import { requirePermissions } from "../auth/auth.service.js";
import type { GestoriaExportFormatKey, UsaliMappingUpsert } from "../../../../../packages/shared/src/financial-statements-types.js";
import {
  buildAnnualAccounts,
  buildBalanceSheet,
  buildEquityChanges,
  buildMemoria,
  buildProfitAndLoss,
  createStatementSnapshot,
  getStatementSnapshot,
  listStatementSnapshots
} from "./annual-accounts.service.js";
import {
  annualAccountsQuerySchema,
  gestoriaExportCreateSchema,
  gestoriaExportListQuerySchema,
  optionalPeriodQuerySchema,
  parseOr400,
  parsePeriodsParam,
  periodsListSchema,
  snapshotCreateSchema,
  snapshotDownloadQuerySchema,
  snapshotListQuerySchema,
  usaliCompareQuerySchema,
  usaliMappingPatchSchema,
  usaliPeriodsQuerySchema,
  usaliPnlQuerySchema
} from "./financial-statements.schemas.js";
import { GESTORIA_FORMATS, createGestoriaExport, getGestoriaExport, listGestoriaExports } from "./gestoria-export.service.js";
import { prismaFinancialStatementsSource } from "./source.js";
import { renderStatementFile, type RenderableStatement } from "./statement-render.js";
import { deleteUsaliMapping, getUsaliCoverage, getUsaliMappings, patchUsaliMappings } from "./usali-mapping.service.js";
import { buildUsaliPnl, compareUsaliPeriods, compareUsaliProperties } from "./usali.service.js";

type Format = "json" | "pdf" | "xlsx" | "csv";

function sendFile(reply: FastifyReply, file: { buffer: Buffer; contentType: string }, fileName: string): FastifyReply {
  reply.header("content-type", file.contentType);
  reply.header("content-disposition", `attachment; filename="${fileName}"`);
  reply.header("cache-control", "no-store");
  return reply.send(file.buffer);
}

async function entityLabel(organizationId: string): Promise<string | undefined> {
  const organization = await prismaFinancialStatementsSource.organization(organizationId);
  if (!organization) return undefined;
  return `${organization.legalName ?? organization.name}${organization.taxId ? ` · NIF ${organization.taxId}` : ""}`;
}

/** JSON by default; pdf/xlsx/csv as a download named <stem>_<from>_<to>.<ext>. */
async function respond(reply: FastifyReply, statement: RenderableStatement, format: Format | undefined, stem: string): Promise<unknown> {
  if (!format || format === "json") return statement;
  const file = renderStatementFile(statement, format, await entityLabel(statement.organizationId));
  const period = "period" in statement ? `${statement.period.from}_${statement.period.to}` : "periodos";
  return sendFile(reply, file, `${stem}_${period}.${file.extension}`);
}

const boolFlag = (value: string | undefined): boolean => value === "1" || value === "true";

export function registerFinancialStatementsRoutes(app: FastifyInstance): void {
  // ---- USALI mapping editor --------------------------------------------------
  app.get("/accounting/usali/mappings", async (request) => {
    const q = parseOr400(optionalPeriodQuerySchema, request.query ?? {}, "query");
    return getUsaliMappings({ context: request.userContext, period: q.from && q.to ? { from: q.from, to: q.to } : null });
  });

  app.patch("/accounting/usali/mappings", async (request) => {
    const body = parseOr400(usaliMappingPatchSchema, request.body ?? {}, "body");
    return patchUsaliMappings({ context: request.userContext, mappings: body.mappings as UsaliMappingUpsert[], correlationId: createId("corr") });
  });

  app.delete("/accounting/usali/mappings/:mappingId", async (request) => {
    const { mappingId } = request.params as { mappingId: string };
    return deleteUsaliMapping({ context: request.userContext, mappingId, correlationId: createId("corr") });
  });

  app.get("/accounting/usali/coverage", async (request) => {
    const q = parseOr400(optionalPeriodQuerySchema, request.query ?? {}, "query");
    return getUsaliCoverage({ context: request.userContext, period: q.from && q.to ? { from: q.from, to: q.to } : null });
  });

  // ---- USALI statement ------------------------------------------------------
  app.get("/accounting/usali/pnl", async (request, reply) => {
    const q = parseOr400(usaliPnlQuerySchema, request.query ?? {}, "query");
    const pnl = await buildUsaliPnl({ context: request.userContext, propertyId: q.propertyId ?? null, from: q.from, to: q.to });
    return respond(reply, pnl, q.format, `usali${q.propertyId ? `_${q.propertyId}` : ""}`);
  });

  app.get("/accounting/usali/compare", async (request, reply) => {
    const raw = (request.query ?? {}) as Record<string, unknown>;
    const format = typeof raw.format === "string" ? (raw.format as Format) : undefined;
    const { format: _format, ...rest } = raw;
    const q = parseOr400(usaliCompareQuerySchema, rest, "query");
    const propertyIds = q.propertyIds ? q.propertyIds.split(",").map((s) => s.trim()).filter(Boolean) : null;
    const comparison = await compareUsaliProperties({ context: request.userContext, from: q.from, to: q.to, propertyIds });
    return respond(reply, comparison, format, "usali_propiedades");
  });

  app.get("/accounting/usali/periods", async (request, reply) => {
    const raw = (request.query ?? {}) as Record<string, unknown>;
    const format = typeof raw.format === "string" ? (raw.format as Format) : undefined;
    const { format: _format, ...rest } = raw;
    const q = parseOr400(usaliPeriodsQuerySchema, rest, "query");
    const periods = parseOr400(periodsListSchema, parsePeriodsParam(q.periods), "periods");
    const comparison = await compareUsaliPeriods({ context: request.userContext, propertyId: q.propertyId ?? null, periods });
    return respond(reply, comparison, format, "usali_periodos");
  });

  // ---- Cuentas anuales PGC Pymes ---------------------------------------------
  app.get("/accounting/annual-accounts", async (request, reply) => {
    const q = parseOr400(annualAccountsQuerySchema, request.query ?? {}, "query");
    const accounts = await buildAnnualAccounts({ context: request.userContext, fiscalYearId: q.fiscalYearId, from: q.from, to: q.to, propertyId: q.propertyId ?? null, comparative: boolFlag(q.comparative) });
    return respond(reply, accounts, q.format, "cuentas_anuales");
  });

  app.get("/accounting/annual-accounts/balance", async (request, reply) => {
    const q = parseOr400(annualAccountsQuerySchema, request.query ?? {}, "query");
    const balance = await buildBalanceSheet({ context: request.userContext, fiscalYearId: q.fiscalYearId, from: q.from, to: q.to, propertyId: q.propertyId ?? null, comparative: boolFlag(q.comparative) });
    return respond(reply, balance, q.format, "balance");
  });

  app.get("/accounting/annual-accounts/pyg", async (request, reply) => {
    const q = parseOr400(annualAccountsQuerySchema, request.query ?? {}, "query");
    const pyg = await buildProfitAndLoss({ context: request.userContext, fiscalYearId: q.fiscalYearId, from: q.from, to: q.to, propertyId: q.propertyId ?? null, comparative: boolFlag(q.comparative) });
    return respond(reply, pyg, q.format, "pyg");
  });

  app.get("/accounting/annual-accounts/ecpn", async (request, reply) => {
    const q = parseOr400(annualAccountsQuerySchema, request.query ?? {}, "query");
    const ecpn = await buildEquityChanges({ context: request.userContext, fiscalYearId: q.fiscalYearId, from: q.from, to: q.to, propertyId: q.propertyId ?? null });
    return respond(reply, ecpn, q.format, "ecpn");
  });

  app.get("/accounting/annual-accounts/memoria", async (request, reply) => {
    const q = parseOr400(annualAccountsQuerySchema, request.query ?? {}, "query");
    const memoria = await buildMemoria({ context: request.userContext, fiscalYearId: q.fiscalYearId, from: q.from, to: q.to, propertyId: q.propertyId ?? null });
    return respond(reply, memoria, q.format, "memoria");
  });

  // ---- Snapshots -------------------------------------------------------------
  app.get("/accounting/annual-accounts/snapshots", async (request) => {
    const q = parseOr400(snapshotListQuerySchema, request.query ?? {}, "query");
    return listStatementSnapshots({ context: request.userContext, kind: q.kind ?? null, fiscalYearId: q.fiscalYearId ?? null, limit: q.limit });
  });

  app.post("/accounting/annual-accounts/snapshots", async (request, reply) => {
    const body = parseOr400(snapshotCreateSchema, request.body ?? {}, "body");
    const snapshot = await createStatementSnapshot({
      context: request.userContext,
      kind: body.kind,
      fiscalYearId: body.fiscalYearId ?? null,
      from: body.from ?? null,
      to: body.to ?? null,
      propertyId: body.propertyId ?? null,
      label: body.label ?? null,
      correlationId: createId("corr")
    });
    reply.code(201);
    return snapshot;
  });

  app.get("/accounting/annual-accounts/snapshots/:snapshotId", async (request) => {
    const { snapshotId } = request.params as { snapshotId: string };
    return getStatementSnapshot({ context: request.userContext, snapshotId });
  });

  app.get("/accounting/annual-accounts/snapshots/:snapshotId/download", async (request, reply) => {
    const { snapshotId } = request.params as { snapshotId: string };
    const q = parseOr400(snapshotDownloadQuerySchema, request.query ?? {}, "query");
    const snapshot = await getStatementSnapshot({ context: request.userContext, snapshotId });
    const statement = snapshot.json as RenderableStatement;
    if (!q.format || q.format === "json") return statement;
    const file = renderStatementFile(statement, q.format, await entityLabel(snapshot.organizationId));
    return sendFile(reply, file, `${snapshot.kind}_${snapshot.periodFrom}_${snapshot.periodTo}.${file.extension}`);
  });

  // ---- Exportación a gestoría -----------------------------------------------
  app.get("/accounting/gestoria-exports/formats", async (request) => {
    requirePermissions(request.userContext, ["analytics.export"]);
    return { formats: GESTORIA_FORMATS };
  });

  app.get("/accounting/gestoria-exports", async (request) => {
    const q = parseOr400(gestoriaExportListQuerySchema, request.query ?? {}, "query");
    return listGestoriaExports({ context: request.userContext, format: (q.format as GestoriaExportFormatKey | undefined) ?? null, limit: q.limit });
  });

  app.post("/accounting/gestoria-exports", async (request, reply) => {
    const body = parseOr400(gestoriaExportCreateSchema, request.body ?? {}, "body");
    const row = await createGestoriaExport({
      context: request.userContext,
      format: body.format,
      from: body.from,
      to: body.to,
      propertyId: body.propertyId ?? null,
      subaccountLength: body.subaccountLength,
      correlationId: createId("corr")
    });
    reply.code(201);
    return row;
  });

  app.get("/accounting/gestoria-exports/:exportId", async (request) => {
    const { exportId } = request.params as { exportId: string };
    return (await getGestoriaExport({ context: request.userContext, exportId })).row;
  });

  app.get("/accounting/gestoria-exports/:exportId/download", async (request, reply) => {
    const { exportId } = request.params as { exportId: string };
    const { row, content } = await getGestoriaExport({ context: request.userContext, exportId });
    return sendFile(reply, { buffer: Buffer.from(content, "utf8"), contentType: "text/csv; charset=utf-8" }, row.fileName);
  });
}
