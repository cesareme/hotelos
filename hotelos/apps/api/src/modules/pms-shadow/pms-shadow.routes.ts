// OPERA Cloud · modo sombra · Tanda 7b · L3 · superficie HTTP (diseño §6.5 con §10).
//
// Registradas desde server.ts con `registerPmsShadowRoutes(app)` justo después de
// registerReservationImportRoutes(app). Permisos: route-permissions.partial.ts de
// este módulo (spread en routePermissionManifest; los contratos leen ese fichero).
// Todo cuerpo y consulta pasa por un esquema zod `.strict()` de
// schemas/pms-shadow.schemas.ts con parseOr400 → 400 VALIDATION_ERROR en español.
//
// `POST /integrations/pms-shadow/ingest` es PÚBLICA (prefijo en PUBLIC_PREFIXES de
// lib/auth-context.ts; entrada `public` en el manifiesto) y se autentica en el
// handler con `X-Api-Key: <clientId>.<clientSecret>` de una DeveloperApp activa con
// scope pms.shadow.ingest (ingest-auth.ts): cabecera → app o 401 único; después
// el cuerpo, `assertPropertyInOrg(body.propertyId, app.organizationId)` (404 opaco:
// el guard global de tenencia salta las rutas públicas) y el ingest con el contexto
// de sistema. Responde 202 con el run YA cerrado (done · partial · failed).
//
// Orden de registro: literales antes que `:id` (`runs` y `runs/:id`; `revenue/preview`
// y `revenue` antes que `revenue/:id`). Tenencia: el preHandler global resuelve
// `:propertyId` con 404 opaco y el servicio repite assertPropertyInOrg; `:id` pasa
// además por assertEntityAccess(pmsShadowRun | pmsShadowAlert | pmsShadowRevenueImport)
// cruzado con `:propertyId`. Las subidas (ingest, run manual, ingresos) aceptan
// cuerpos de hasta 8 MiB (base64 de 5 MiB reales) y 30 peticiones por minuto.

import type { FastifyInstance } from "fastify";
import { prisma } from "@hotelos/database";
import { PMS_SHADOW_INGEST_HEADER } from "@hotelos/shared";
import { createId } from "../../lib/ids.js";
import { assertEntityAccess } from "../../lib/tenancy.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import {
  AlertsQuerySchema,
  IngestSchema,
  ManualRunSchema,
  ProfileUpsertSchema,
  ReconciliationQuerySchema,
  ResolveAlertSchema,
  RevenueImportSchema,
  RevenueListQuerySchema,
  RevenuePreviewSchema,
  RevenueReverseSchema,
  RunsQuerySchema
} from "../../schemas/pms-shadow.schemas.js";
import { assertPropertyInOrg } from "../pms/pms.service.js";
import { authenticateIngestApiKey, ingestUnauthorizedError, principalAllowsProperty } from "./ingest-auth.js";
import { systemContext } from "./pms-shadow.rules.js";
import { getOverview, getProfile, getReconciliation, getRun, ingestPmsShadowFile, listAlerts, listRuns, resolveAlert, upsertProfile } from "./pms-shadow.service.js";
import { getPmsShadowRevenueImport, importPmsShadowRevenue, listPmsShadowRevenueImports, previewPmsShadowRevenue, reversePmsShadowRevenue } from "./revenue-import.service.js";

type PropertyParams = { propertyId: string };
type EntityParams = { propertyId: string; id: string };

const UPLOAD_OPTIONS = { bodyLimit: 8 * 1024 * 1024, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };

export function registerPmsShadowRoutes(app: FastifyInstance): void {
  // Ingest público por clave de API (agente SFTP, cron del VPS): 202 con el run cerrado.
  app.post("/integrations/pms-shadow/ingest", UPLOAD_OPTIONS, async (request, reply) => {
    const devApp = await authenticateIngestApiKey(prisma, request.headers[PMS_SHADOW_INGEST_HEADER]);
    if (!devApp) throw ingestUnauthorizedError();
    const body = parseOr400(IngestSchema, request.body ?? {}, "body");
    // SEC-04: clave ligada a otro centro (`pms.shadow.ingest:<propertyId>`) → el mismo 401, antes de mirar la propiedad.
    if (!principalAllowsProperty(devApp, body.propertyId)) throw ingestUnauthorizedError();
    await assertPropertyInOrg(body.propertyId, devApp.organizationId);
    const context = systemContext(devApp.organizationId, body.propertyId);
    const result = await ingestPmsShadowFile({
      context,
      propertyId: body.propertyId,
      source: "api_key",
      feed: body.feed,
      fileName: body.fileName,
      bytes: Buffer.from(body.contentBase64, "base64"),
      businessDate: body.businessDate ?? null,
      force: body.force,
      horizonDays: body.horizonDays ?? null,
      declared: body.declared ?? null,
      reconciliation: body.reconciliation ?? null,
      correlationId: createId("corr"),
      createdBy: `developer_app:${devApp.clientId}`
    });
    return reply.code(202).send({ runId: result.runId, status: result.status, counts: result.counts, alerts: result.alerts });
  });

  // Panel: KPIs (último corte, reservas enlazadas, alertas abiertas, último día conciliado) y tabla de feeds.
  app.get("/properties/:propertyId/pms-shadow/overview", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    return getOverview({ context: request.userContext, propertyId });
  });

  // Perfil: código OPERA, estado, mapeos, transaction codes, programación, buzón y carpeta.
  app.get("/properties/:propertyId/pms-shadow/profile", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    return getProfile({ context: request.userContext, propertyId });
  });

  app.put("/properties/:propertyId/pms-shadow/profile", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    const body = parseOr400(ProfileUpsertSchema, request.body ?? {}, "body");
    return upsertProfile({ context: request.userContext, propertyId, body, correlationId: createId("corr") });
  });

  // Cortes: listado (feed, estado, business date, limit 1..200) y subida manual (mismo cuerpo del ingest sin propertyId).
  app.get("/properties/:propertyId/pms-shadow/runs", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    const query = parseOr400(RunsQuerySchema, request.query ?? {}, "query");
    return listRuns({ context: request.userContext, propertyId, query });
  });

  app.post("/properties/:propertyId/pms-shadow/runs", UPLOAD_OPTIONS, async (request, reply) => {
    const { propertyId } = request.params as PropertyParams;
    const body = parseOr400(ManualRunSchema, request.body ?? {}, "body");
    const result = await ingestPmsShadowFile({
      context: request.userContext,
      propertyId,
      source: "manual",
      feed: body.feed,
      fileName: body.fileName,
      bytes: Buffer.from(body.contentBase64, "base64"),
      businessDate: body.businessDate ?? null,
      force: body.force,
      horizonDays: body.horizonDays ?? null,
      declared: body.declared ?? null,
      reconciliation: body.reconciliation ?? null,
      correlationId: createId("corr"),
      createdBy: request.userContext.userId
    });
    return reply.code(202).send({ runId: result.runId, status: result.status, counts: result.counts, alerts: result.alerts, run: result.run });
  });

  app.get("/properties/:propertyId/pms-shadow/runs/:id", async (request) => {
    const { propertyId, id } = request.params as EntityParams;
    await assertEntityAccess(request, { entity: "pmsShadowRun", id, propertyId });
    return getRun({ context: request.userContext, propertyId, runId: id });
  });

  // Alertas: abiertas por defecto; resolución con motivo (auditada).
  app.get("/properties/:propertyId/pms-shadow/alerts", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    const query = parseOr400(AlertsQuerySchema, request.query ?? {}, "query");
    return listAlerts({ context: request.userContext, propertyId, query });
  });

  app.post("/properties/:propertyId/pms-shadow/alerts/:id/resolve", async (request) => {
    const { propertyId, id } = request.params as EntityParams;
    await assertEntityAccess(request, { entity: "pmsShadowAlert", id, propertyId });
    const body = parseOr400(ResolveAlertSchema, request.body ?? {}, "body");
    return resolveAlert({ context: request.userContext, propertyId, alertId: id, note: body.note, correlationId: createId("corr") });
  });

  // Reconciliación del día (§5.4): declarado por OPERA frente a calculado por Anfitorio.
  app.get("/properties/:propertyId/pms-shadow/reconciliation", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    const query = parseOr400(ReconciliationQuerySchema, request.query ?? {}, "query");
    return getReconciliation({ context: request.userContext, propertyId, businessDate: query.businessDate });
  });

  // Ingresos diarios (L2): previsualizar (nunca escribe), contabilizar, listar, detalle y reverso.
  app.post("/properties/:propertyId/pms-shadow/revenue/preview", UPLOAD_OPTIONS, async (request) => {
    const { propertyId } = request.params as PropertyParams;
    const body = parseOr400(RevenuePreviewSchema, request.body ?? {}, "body");
    return previewPmsShadowRevenue({ context: request.userContext, propertyId, body });
  });

  app.post("/properties/:propertyId/pms-shadow/revenue", UPLOAD_OPTIONS, async (request, reply) => {
    const { propertyId } = request.params as PropertyParams;
    const body = parseOr400(RevenueImportSchema, request.body ?? {}, "body");
    const record = await importPmsShadowRevenue({ context: request.userContext, propertyId, body, createdBy: request.userContext.userId, correlationId: createId("corr") });
    return reply.code(201).send(record);
  });

  app.get("/properties/:propertyId/pms-shadow/revenue", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    const query = parseOr400(RevenueListQuerySchema, request.query ?? {}, "query");
    return listPmsShadowRevenueImports({
      context: request.userContext,
      propertyId,
      status: query.status ?? null,
      from: query.businessDate ?? query.from ?? null,
      to: query.businessDate ?? query.to ?? null,
      limit: query.limit
    });
  });

  app.get("/properties/:propertyId/pms-shadow/revenue/:id", async (request) => {
    const { propertyId, id } = request.params as EntityParams;
    await assertEntityAccess(request, { entity: "pmsShadowRevenueImport", id, propertyId });
    return getPmsShadowRevenueImport({ context: request.userContext, propertyId, importId: id });
  });

  app.post("/properties/:propertyId/pms-shadow/revenue/:id/reverse", async (request) => {
    const { propertyId, id } = request.params as EntityParams;
    await assertEntityAccess(request, { entity: "pmsShadowRevenueImport", id, propertyId });
    const body = parseOr400(RevenueReverseSchema, request.body ?? {}, "body");
    return reversePmsShadowRevenue({ context: request.userContext, propertyId, importId: id, reason: body.reason, entryDate: body.entryDate ?? null, correlationId: createId("corr") });
  });
}
