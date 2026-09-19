// Importación contable desde Sage 200 · Tanda 7c · L3 · superficie HTTP (diseño §7.1
// con las correcciones de §10.4.1: prefijo `/accounting/ledger-imports*`, 15 rutas; FIX-1 · F11
// añade la 16.ª, `GET /accounting/ledger-imports/third-parties`).
//
// Registradas desde server.ts con `registerLedgerImportRoutes(app)` justo después de
// registerPmsShadowRoutes(app). Permisos: ledger-import-route-permissions.partial.ts
// de este módulo (spread en routePermissionManifest envuelto con
// requireAccountingReportsKey; los contratos leen ese fichero). Todo cuerpo y consulta
// pasa por un esquema zod `.strict()` de schemas/ledger-import.schemas.ts con
// parseOr400 → 400 VALIDATION_ERROR en español (clave desconocida, `allowClosed` por
// HTTP, content XOR contentBase64, reason corto…).
//
// Orden de registro: las estáticas (`preview`, `template`, `account-map`,
// `analytics-map`, `reconciliation`, `reconciliation/:id`, `reconciliation/:id/csv`,
// `third-parties`)
// antes que `/:id` (find-my-way prioriza las estáticas; el orden documenta la
// intención). Tenencia: `:id` pasa por assertEntityAccess(ledgerImport |
// ledgerReconciliation) → 404 opaco fuera de la organización (lib/tenancy.ts); el
// ámbito por centro (R11) sobre los propertyId del lote lo aplica el servicio con
// assertFinanceReadScopeMany, y en `:id/post` y `:id/reverse` la escritura sobre esos
// centros. Las tres rutas de carga (preview, lote, reconciliación) aceptan cuerpos de
// hasta 30 MiB (Fastify sin bodyLimit global → 1 MiB por defecto; 28 MiB de base64
// + JSON exigen ≈ 30 MiB) y 30 peticiones por minuto; ficheros mayores → CLI.
//
// Respuestas: preview 200 (nunca escribe) · crear 201 · reconciliar 200 (escribe solo
// ledger_reconciliations) · reverso 200 idempotente (patrón payroll / pms-shadow;
// el 201 de POST /accounting/journal/:id/reverse es para un reverso individual).
// Códigos de dominio (LEDGER_IMPORT_ERROR_CODES de @hotelos/shared): los emiten los
// servicios de modules/accounting/import/; aquí solo se valida la frontera y se enruta.

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { LEDGER_THIRD_PARTY_LIST_DEFAULT_LIMIT, LEDGER_THIRD_PARTY_LIST_MAX_LIMIT, LEDGER_THIRD_PARTY_QUERY_MAX, LEDGER_THIRD_PARTY_ROLES } from "@hotelos/shared";
import { BadRequestError } from "../../lib/http-error.js";
import { createId } from "../../lib/ids.js";
import { pageHeaders, parsePageQuery } from "../../lib/pagination.js";
import { assertEntityAccess } from "../../lib/tenancy.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import {
  AccountMapPutSchema,
  AnalyticsMapPutSchema,
  CreateSchema,
  DetailQuerySchema,
  ListQuerySchema,
  PostSchema,
  PreviewSchema,
  ReconciliationBodySchema,
  ReconciliationListQuerySchema,
  ReverseSchema,
  TemplateQuerySchema
} from "../../schemas/ledger-import.schemas.js";
import {
  buildLedgerImportTemplate,
  createLedgerImport,
  getAccountMap,
  getAnalyticsMap,
  getLedgerImport,
  listLedgerImports,
  postLedgerImport,
  previewLedgerImport,
  putAccountMap,
  putAnalyticsMap,
  reverseLedgerImport
} from "./import/ledger-import.service.js";
import { getReconciliation, listReconciliations, reconcileLedger, reconciliationCsv } from "./import/ledger-reconciliation.service.js";
import { listLedgerThirdParties } from "./import/ledger-third-parties.service.js";

type IdParams = { id: string };

/** L2-05: el detalle pagina por desplazamiento (`offset`/`limit`); un `cursor` (de otra ruta) responde el 400 canónico de paginación. */
function rejectCursor(raw: Record<string, unknown>): void {
  if (raw.cursor !== undefined) throw new BadRequestError("El cursor de paginación no es válido.");
}

/** Cuerpos de hasta 30 MiB (28 MiB de base64 + JSON) y 30 subidas por minuto en las tres rutas de carga. */
const UPLOAD_OPTIONS = { bodyLimit: 30 * 1024 * 1024, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };

/**
 * FIX-1 · F11: consulta de `GET /accounting/ledger-imports/third-parties` (declarada aquí y no en
 * schemas/ledger-import.schemas.ts para no tocar ese fichero): `q` ≤ LEDGER_THIRD_PARTY_QUERY_MAX,
 * `role` del catálogo; `limit` y `cursor` los interpreta parsePageQuery (lib/pagination.ts: limit
 * recortado a LEDGER_THIRD_PARTY_LIST_MAX_LIMIT sin error, cursor opaco → 400 si no es válido).
 */
const ThirdPartiesQuerySchema = z
  .object({
    q: z.string({ invalid_type_error: "q debe ser un texto." }).trim().max(LEDGER_THIRD_PARTY_QUERY_MAX, { message: `q no puede superar ${LEDGER_THIRD_PARTY_QUERY_MAX} caracteres.` }).optional(),
    role: z.enum(LEDGER_THIRD_PARTY_ROLES).optional(),
    limit: z.string().optional(),
    cursor: z.string().optional()
  })
  .strict({ message: "Campo no admitido en la consulta." });

/** Copia local de `sendCsv` de ledger.routes.ts (privada allí): adjunto CSV UTF-8 sin caché. */
function sendCsv(reply: FastifyReply, filename: string, csv: string): string {
  reply.header("Content-Type", "text/csv; charset=utf-8");
  reply.header("Content-Disposition", `attachment; filename="${filename}"`);
  reply.header("Cache-Control", "no-store");
  return csv;
}

export function registerLedgerImportRoutes(app: FastifyInstance): void {
  // ---- Previsualizar (nunca escribe) y crear (+ contabilizar) un lote -------
  app.post("/accounting/ledger-imports/preview", UPLOAD_OPTIONS, async (request) => {
    const body = parseOr400(PreviewSchema, request.body ?? {}, "body");
    return previewLedgerImport({ context: request.userContext, body });
  });

  app.post("/accounting/ledger-imports", UPLOAD_OPTIONS, async (request, reply) => {
    const body = parseOr400(CreateSchema, request.body ?? {}, "body");
    const result = await createLedgerImport({ context: request.userContext, body, correlationId: createId("corr") });
    return reply.code(201).send(result);
  });

  // ---- Listado, plantilla canónica y mapas (estáticas antes que /:id) --------
  app.get("/accounting/ledger-imports", async (request) => {
    const query = parseOr400(ListQuerySchema, request.query ?? {}, "query");
    return listLedgerImports({ context: request.userContext, query });
  });

  app.get("/accounting/ledger-imports/template", async (request, reply) => {
    const query = parseOr400(TemplateQuerySchema, request.query ?? {}, "query");
    const file = buildLedgerImportTemplate(query.kind);
    return sendCsv(reply, file.fileName, file.content);
  });

  app.get("/accounting/ledger-imports/account-map", async (request) => {
    return getAccountMap({ context: request.userContext });
  });

  app.put("/accounting/ledger-imports/account-map", async (request) => {
    const body = parseOr400(AccountMapPutSchema, request.body ?? {}, "body");
    return putAccountMap({ context: request.userContext, body, correlationId: createId("corr") });
  });

  app.get("/accounting/ledger-imports/analytics-map", async (request) => {
    return getAnalyticsMap({ context: request.userContext });
  });

  app.put("/accounting/ledger-imports/analytics-map", async (request) => {
    const body = parseOr400(AnalyticsMapPutSchema, request.body ?? {}, "body");
    return putAnalyticsMap({ context: request.userContext, body, correlationId: createId("corr") });
  });

  // ---- Reconciliación (§5.2): ejecutar y persistir, historial, detalle y CSV --
  app.post("/accounting/ledger-imports/reconciliation", UPLOAD_OPTIONS, async (request) => {
    const body = parseOr400(ReconciliationBodySchema, request.body ?? {}, "body");
    return reconcileLedger({ context: request.userContext, body, correlationId: createId("corr") });
  });

  app.get("/accounting/ledger-imports/reconciliation", async (request) => {
    const query = parseOr400(ReconciliationListQuerySchema, request.query ?? {}, "query");
    return listReconciliations({ context: request.userContext, query });
  });

  app.get("/accounting/ledger-imports/reconciliation/:id", async (request) => {
    const { id } = request.params as IdParams;
    await assertEntityAccess(request, { entity: "ledgerReconciliation", id });
    return getReconciliation({ context: request.userContext, reconciliationId: id });
  });

  app.get("/accounting/ledger-imports/reconciliation/:id/csv", async (request, reply) => {
    const { id } = request.params as IdParams;
    await assertEntityAccess(request, { entity: "ledgerReconciliation", id });
    const file = await reconciliationCsv({ context: request.userContext, reconciliationId: id });
    return sendCsv(reply, file.fileName, file.content);
  });

  // ---- Terceros importados (FIX-1 · F11): directorio de solo lectura, antes que /:id ----
  // Página keyset (rol, código Sage, id) con `total` y `nextCursor` en el cuerpo y las cabeceras X-Total-Count / X-Next-Cursor.
  app.get("/accounting/ledger-imports/third-parties", async (request, reply) => {
    const raw = (request.query ?? {}) as Record<string, unknown>;
    const query = parseOr400(ThirdPartiesQuerySchema, raw, "query");
    const page = parsePageQuery(raw, { limit: LEDGER_THIRD_PARTY_LIST_DEFAULT_LIMIT, max: LEDGER_THIRD_PARTY_LIST_MAX_LIMIT });
    const result = await listLedgerThirdParties({ context: request.userContext, q: query.q, role: query.role, limit: page.limit, cursor: page.cursor });
    for (const [name, value] of Object.entries(pageHeaders({ items: result.rows, nextCursor: result.nextCursor, total: result.total }))) reply.header(name, value);
    return result;
  });

  // ---- Un lote: detalle, contabilizar un borrador y reverso entero ----------
  // Detalle: `entries` (y `balances` en un lote balances) paginadas con el mismo ?offset=&limit=; X-Total-Count = entradas,
  // X-Balance-Total = saldos (Tanda L2 · L2-05).
  app.get("/accounting/ledger-imports/:id", async (request, reply) => {
    const { id } = request.params as IdParams;
    await assertEntityAccess(request, { entity: "ledgerImport", id });
    const raw = (request.query ?? {}) as Record<string, unknown>;
    rejectCursor(raw);
    const query = parseOr400(DetailQuerySchema, raw, "query");
    const detail = await getLedgerImport({ context: request.userContext, importId: id, query });
    reply.header("X-Total-Count", String(detail.entryTotal));
    if (detail.balanceTotal !== undefined) reply.header("X-Balance-Total", String(detail.balanceTotal));
    return detail;
  });

  app.post("/accounting/ledger-imports/:id/post", async (request) => {
    const { id } = request.params as IdParams;
    await assertEntityAccess(request, { entity: "ledgerImport", id });
    const body = parseOr400(PostSchema, request.body ?? {}, "body");
    return postLedgerImport({ context: request.userContext, importId: id, replace: body.replace, correlationId: createId("corr") });
  });

  // 200 idempotente: un lote ya revertido responde su registro con alreadyReversed: true.
  app.post("/accounting/ledger-imports/:id/reverse", async (request) => {
    const { id } = request.params as IdParams;
    await assertEntityAccess(request, { entity: "ledgerImport", id });
    const body = parseOr400(ReverseSchema, request.body ?? {}, "body");
    return reverseLedgerImport({ context: request.userContext, importId: id, reason: body.reason, correlationId: createId("corr") });
  });
}
