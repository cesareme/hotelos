// Importación masiva de reservas · Tanda 7 · L3 · superficie HTTP (diseño §7).
//
// Registradas desde server.ts con `registerReservationImportRoutes(app)` justo
// después de registerPayrollCostRoutes(app). Permisos: route-permissions.partial.ts
// de este módulo (spread en routePermissionManifest; los contratos leen ese
// fichero). Todo cuerpo y consulta pasa por un esquema zod `.strict()` de
// schemas/reservation-import.schemas.ts con parseOr400 → 400 VALIDATION_ERROR en
// español (clave desconocida, content y contentBase64 a la vez, commit ≠ true,
// limit fuera de 1..200, reason > 500).
//
// Orden de registro: `template` antes que `:id` y `preview` antes que
// `:id/undo`, con paths literales para el extractor del contrato. Tenencia: el
// preHandler global (server.ts, grantPropertyAccess) resuelve `:propertyId` con
// 404 opaco y el servicio repite assertPropertyInOrg; `:id` pasa además por
// assertEntityAccess("reservationImport", { propertyId }) → 404 opaco cuando el
// lote es de otra propiedad u organización («Importación de reservas no
// encontrada.», sin eco del id).
//
// Preview e import aceptan cuerpos de hasta 8 MiB (`bodyLimit`: base64 infla
// 4/3 los 5 MiB reales que admite el parser; por encima Fastify responde 413) y
// se limitan a 30 peticiones por minuto y usuario (`config.rateLimit`). Los
// códigos de dominio (RESERVATION_IMPORT_ERROR_CODES de @hotelos/shared) los
// emite reservation-import.service.ts; aquí solo se valida la frontera y se enruta.

import type { FastifyInstance, FastifyReply } from "fastify";
import { createId } from "../../lib/ids.js";
import { assertEntityAccess } from "../../lib/tenancy.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import {
  CreateReservationImportSchema,
  ListReservationImportsQuerySchema,
  PreviewReservationImportSchema,
  ReservationImportTemplateQuerySchema,
  UndoReservationImportSchema
} from "../../schemas/reservation-import.schemas.js";
import { getReservationImport, importReservations, listReservationImports, previewReservationImport, undoReservationImport } from "./reservation-import.service.js";
import { buildReservationImportTemplate, type ReservationImportTemplateFile } from "./reservation-import.template.js";

type PropertyParams = { propertyId: string };
type ImportParams = { propertyId: string; id: string };

/** Descarga de la plantilla (patrón financial-statements.routes.ts): adjunto, sin caché. */
function sendFile(reply: FastifyReply, file: ReservationImportTemplateFile): FastifyReply {
  reply.header("content-type", file.contentType);
  reply.header("content-disposition", `attachment; filename="${file.fileName}"`);
  reply.header("cache-control", "no-store");
  return reply.send(file.buffer);
}

export function registerReservationImportRoutes(app: FastifyInstance): void {
  // Previsualización: cabecera detectada, mapeo propuesto o aplicado, catálogo de
  // la propiedad, veredicto por fila, disponibilidad, duplicados, hash y
  // `canImport`. Nunca escribe.
  app.post("/properties/:propertyId/reservations/imports/preview", { bodyLimit: 8 * 1024 * 1024, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request) => {
    const { propertyId } = request.params as PropertyParams;
    const body = parseOr400(PreviewReservationImportSchema, request.body ?? {}, "body");
    return previewReservationImport({ context: request.userContext, propertyId, body });
  });

  // Importar: mismo análisis que la preview y, si pasa, lote `processing` bajo
  // lock por propiedad + una reserva por fila válida vía createReservation.
  // 201 siempre que el lote exista (incluso `failed`), con el resultado por fila.
  app.post("/properties/:propertyId/reservations/imports", { bodyLimit: 8 * 1024 * 1024, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    const { propertyId } = request.params as PropertyParams;
    // `commit: true` es un literal de intención (lo exige el esquema); el servicio recibe el cuerpo de la preview.
    const { commit, ...body } = parseOr400(CreateReservationImportSchema, request.body ?? {}, "body");
    void commit;
    const result = await importReservations({
      context: request.userContext,
      propertyId,
      body,
      createdBy: request.userContext.userId,
      correlationId: createId("corr"),
      source: "http"
    });
    return reply.code(201).send(result);
  });

  // Listado de lotes de la propiedad (createdAt desc; `status` y `limit` 1..200).
  app.get("/properties/:propertyId/reservations/imports", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    const query = parseOr400(ListReservationImportsQuerySchema, request.query ?? {}, "query");
    return listReservationImports({ context: request.userContext, propertyId, query });
  });

  // Plantilla oficial (CSV con BOM y «;» o XLSX con hoja «Instrucciones»); no
  // depende de la propiedad, pero la ruta cuelga de ella para heredar el 404
  // opaco y el permiso de lectura de reservas.
  app.get("/properties/:propertyId/reservations/imports/template", async (request, reply) => {
    const query = parseOr400(ReservationImportTemplateQuerySchema, request.query ?? {}, "query");
    return sendFile(reply, buildReservationImportTemplate(query.format));
  });

  // Detalle: lote + filas por rowNumber (sin datos personales del huésped).
  app.get("/properties/:propertyId/reservations/imports/:id", async (request) => {
    const { propertyId, id } = request.params as ImportParams;
    await assertEntityAccess(request, { entity: "reservationImport", id, propertyId });
    return getReservationImport({ context: request.userContext, propertyId, importId: id });
  });

  // Deshacer: cancela las reservas del lote que sigan draft | confirmed
  // (bookingSource import:<id>), conserva las alojadas o históricas y deja el
  // lote `undone`. Idempotente (`alreadyUndone`).
  app.post("/properties/:propertyId/reservations/imports/:id/undo", async (request) => {
    const { propertyId, id } = request.params as ImportParams;
    await assertEntityAccess(request, { entity: "reservationImport", id, propertyId });
    const body = parseOr400(UndoReservationImportSchema, request.body ?? {}, "body");
    return undoReservationImport({ context: request.userContext, propertyId, importId: id, reason: body.reason ?? null, correlationId: createId("corr") });
  });
}
