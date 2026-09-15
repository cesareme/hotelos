// Channel-manager routes (rate grid v2 · lote api-channel-outbox).
//
// Registered by server.ts through `registerChannelManagerRoutes(app)`; the
// permission entries live in ./route-permissions.partial.ts (spread into the
// manifest). Tenancy: routes carrying :propertyId (or a propertyId in
// body/query) are checked by the global hook; routes addressed by an entity id
// go through `assertEntityAccess({ entity: "channel" })` and, for product
// mappings / deliveries, resolve the parent channel first (no tenancy resolver
// exists for those tables and lib/tenancy.ts is not ours).
//
// Public routes (no staff auth; listed in PUBLIC_PREFIXES of lib/auth-context.ts
// AND as riskLevel "public" in the manifest partial — both halves are needed):
//   POST /channel-manager/webhooks/:provider/:channelId — provider webhook;
//        verified with the channel's webhook secret and it ONLY triggers a
//        pull (the payload is never trusted). The HMAC variant
//        (`X-Anfitorio-Signature: sha256=<hex>`) is computed over the ORIGINAL
//        bytes: the `preParsing` hook registered here captures them as
//        `request.rawBody` for that prefix only AND verifies the secret right
//        there, BEFORE any body parser runs — so an anonymous caller gets the
//        same 401 for a malformed body as for a well-formed one (no 400/401
//        oracle, no parser work before authentication). Bodies above
//        WEBHOOK_MAX_BYTES are refused (413) while still reading the stream.
//        The route lives in its own encapsulated context with a catch-all
//        string parser: any content type reaches the handler as the raw
//        string (the payload is a hint, never parsed into a trusted shape).
//        In stub/sandbox the adapters have no reservation feed and fabricate
//        0-3 deterministic reservations per pull (adapters/stub-utils.ts
//        `buildStubReservations`): an authenticated webhook on such a channel
//        DOES add simulated rows to the ExternalReservation inbox (runbook §1.8).
//   POST /channel-manager/_sandbox/:provider — loopback into the in-process
//        simulator, so an external tool can validate an OTA XML / Channex JSON
//        body without credentials. Pure: it never touches the database.

import { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "@hotelos/database";
import { BadRequestError, NotFoundError, UnauthorizedError } from "../../lib/http-error.js";
import { assertEntityAccess } from "../../lib/tenancy.js";
import { requirePermissions } from "../auth/auth.service.js";
import { zodErrorMapEs } from "../rate-manager/rate-grid.schemas.js";
import type { ChannelMode } from "./adapter.types.js";
import { listProviderCodes } from "./adapters/index.js";
import {
  archiveChannel,
  createChannel,
  getChannelDetail,
  listRateGridChannels,
  patchChannel,
  pullChannelReservations,
  setChannelCredentials,
  testChannel,
  verifyWebhookSecret,
  type ChannelRow
} from "./channels.service.js";
import { enqueueRateGridPush, getDelivery, getRateGridSyncStatus, listDeliveries, retryDelivery } from "./delivery.service.js";
import { drainChannelDeliveries } from "./drain.service.js";
import { deleteProductMapping, listProductMappings, migrateLegacyMappings, productCoverage, upsertProductMapping } from "./mapping.service.js";
import { channelReadiness } from "./readiness.service.js";
import { runSimulator, type SimulatorProvider } from "./sandbox/simulator.js";

/** What the webhook needs from a channel row (the secret lives in the credentials). */
export type WebhookChannel = Pick<ChannelRow, "id" | "credentialsEncrypted" | "configurationJson">;

/**
 * Seams for the collaborators of the routes tested on a bare Fastify instance
 * without a database (webhook hook + route, deliveries listing); production
 * wiring uses the defaults (Prisma lookup, `pullChannelReservations`,
 * `assertEntityAccess`, `listDeliveries`).
 */
export type ChannelManagerRouteDeps = {
  loadWebhookChannel?: (channelId: string) => Promise<WebhookChannel | null>;
  pullReservations?: (channelId: string) => Promise<{ ok: boolean; imported: number }>;
  /** Tenant check of a channel id → the property it hangs from (default: `assertEntityAccess`). */
  channelAccess?: (request: FastifyRequest, channelId: string) => Promise<{ propertyId: string }>;
  listDeliveries?: typeof listDeliveries;
};

declare module "fastify" {
  interface FastifyRequest {
    /** Original request bytes (utf8) — only set for /channel-manager/webhooks/* (HMAC verification). */
    rawBody?: string;
    /** Channel whose secret verified the webhook (set by the preParsing hook, before any parser). */
    webhookChannel?: WebhookChannel;
  }
}

export const WEBHOOK_PATH_PREFIX = "/channel-manager/webhooks/";
/** Webhook bodies above this size are refused before parsing (a provider ping is a few KB). */
export const WEBHOOK_MAX_BYTES = 1_048_576;

/** True for the webhook prefix (query string and trailing segments ignored). */
export function isWebhookUrl(url: string | undefined): boolean {
  return typeof url === "string" && url.startsWith(WEBHOOK_PATH_PREFIX);
}

/** `:channelId` of `/channel-manager/webhooks/:provider/:channelId[?…]`; null for any other shape. */
export function webhookChannelIdFromUrl(url: string | undefined): string | null {
  if (!isWebhookUrl(url)) return null;
  const path = (url as string).split("?")[0] ?? "";
  const segments = path.slice(WEBHOOK_PATH_PREFIX.length).split("/").filter(Boolean);
  if (segments.length !== 2) return null;
  try {
    return decodeURIComponent(segments[1] as string);
  } catch {
    return null;
  }
}

/** Drain a request stream into a Buffer, refusing anything above `maxBytes`. */
export async function readStreamBytes(stream: NodeJS.ReadableStream, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk as Uint8Array);
    size += buf.length;
    if (size > maxBytes) throw Object.assign(new Error("Webhook demasiado grande."), { statusCode: 413 });
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

const modeSchema = z.enum(["stub", "sandbox", "real"]);
const credentialsSchema = z.record(z.string().min(1).max(64), z.unknown()).refine((v) => Object.keys(v).length > 0, { message: "credentials no puede estar vacío." });

const createChannelSchema = z.object({
  propertyId: z.string().min(1),
  providerCode: z.string().min(2).max(40),
  name: z.string().min(1).max(120),
  mode: modeSchema.optional(),
  status: z.enum(["active", "inactive"]).optional(),
  defaultMarkupPercent: z.number().min(-100).max(500).nullable().optional(),
  autoPushOnSave: z.boolean().optional(),
  credentials: credentialsSchema.nullable().optional()
});

const patchChannelSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    mode: modeSchema.optional(),
    status: z.enum(["active", "inactive", "error", "paused"]).optional(),
    defaultMarkupPercent: z.number().min(-100).max(500).nullable().optional(),
    autoPushOnSave: z.boolean().optional()
  })
  .strict();

const patchCredentialsSchema = z.object({ credentials: credentialsSchema, merge: z.boolean().optional() });

// `los` (length-of-stay pricing) is in the adapter vocabulary but no builder
// implements it (Booking RateTimeUnit/UnitMultiplier, EQC LOS pricing): a
// mapping saved as `los` would be pushed as a per-night price. Refused with a
// clear message until it exists.
const productMappingSchema = z.object({
  roomTypeId: z.string().min(1),
  ratePlanId: z.string().min(1),
  externalRoomCode: z.string().min(1).max(120),
  externalRateCode: z.string().min(1).max(120),
  pricingModel: z
    .enum(["per_day", "obp"], { errorMap: () => ({ message: "debe ser per_day u obp (los, precio por estancia, no está implementado todavía)." }) })
    .optional(),
  status: z.enum(["active", "inactive"]).optional()
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato YYYY-MM-DD");

// `limit` may arrive as a query string («limit=25»): z.coerce turns it into a
// number. The literal `z.coerce.number().int().min(1).max(N)` of drainSchema
// is what tests/rate-grid-docs-contract.test.mjs reads to check runbook §4.
export const listDeliveriesSchema = z.object({
  propertyId: z.string().min(1).optional(),
  channelId: z.string().min(1).optional(),
  status: z.enum(["queued", "sending", "sent", "confirmed", "rejected", "timeout", "superseded"]).optional(),
  kind: z.enum(["rates", "availability", "restrictions"]).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  roomTypeId: z.string().optional(),
  ratePlanId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  cursor: z.string().optional()
});

export const drainSchema = z.object({ channelId: z.string().min(1).optional(), limit: z.coerce.number().int().min(1).max(20_000).optional() });

export const enqueueSchema = z.object({
  propertyId: z.string().min(1),
  from: isoDate,
  to: isoDate,
  channelIds: z.array(z.string().min(1)).min(1),
  ratePlanIds: z.array(z.string().min(1)).optional(),
  roomTypeIds: z.array(z.string().min(1)).optional(),
  kinds: z.array(z.enum(["rates", "availability", "restrictions"])).optional(),
  journalId: z.string().min(1).nullable().optional(),
  drainNow: z.boolean().optional()
});

const syncStatusSchema = z.object({ from: isoDate, to: isoDate, channelIds: z.union([z.string(), z.array(z.string())]).optional() });

const pullSchema = z.object({ since: z.string().datetime().optional() });

/**
 * Spanish error map of the module: `zodErrorMapEs` plus the two issues the
 * coerced integers of this file raise and the shared map has no word for —
 * `z.coerce.number()` reports «abc» (or an array) as received "nan" and
 * `.int()` reports 2.5 as expected "integer" / received "float"; both would
 * otherwise reach the user as English literals («se recibió nan»).
 */
export const channelErrorMapEs: z.ZodErrorMap = (issue, ctx) => {
  if (issue.code === z.ZodIssueCode.invalid_type) {
    if (issue.received === "nan") return { message: "se esperaba número y se recibió un valor no numérico" };
    if (issue.expected === "integer") return { message: "debe ser un número entero" };
  }
  return zodErrorMapEs(issue, ctx);
};

/**
 * Body/query parser of the module: every 400 is Spanish. zod's built-in
 * messages («Required», «Expected string, received array»…) are replaced by
 * `channelErrorMapEs` so «from: obligatorio» reaches the user; a schema-level
 * `errorMap` (e.g. pricingModel) still wins. Exported for the unit tests; the
 * routes call it as `parse`.
 */
export function parseRequest<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value ?? {}, { errorMap: channelErrorMapEs });
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`);
    throw new BadRequestError(`Petición inválida: ${issues.join("; ")}`);
  }
  return result.data;
}

const parse = parseRequest;

function params<T extends Record<string, string>>(request: FastifyRequest): T {
  return request.params as T;
}

async function channelAccessFromDb(request: FastifyRequest, channelId: string): Promise<{ propertyId: string }> {
  const owner = await assertEntityAccess(request, { entity: "channel", id: channelId });
  return { propertyId: owner.propertyId ?? "" };
}

/**
 * Property scope of GET /channel-manager/deliveries. The session property is
 * the default scope, but a `channelId` the tenant check has already granted
 * scopes the listing to THAT channel's property: an Owner of several
 * properties may address a channel of another of them without repeating
 * `propertyId` (before, the mismatch with the session property was a 404).
 * An explicit `propertyId` that does not match the channel's is still the
 * neutral 404. Exported for the unit tests.
 */
export function deliveriesScope(input: { queryPropertyId?: string; sessionPropertyId: string; channelPropertyId?: string }): string {
  if (input.channelPropertyId) {
    if (input.queryPropertyId && input.queryPropertyId !== input.channelPropertyId) throw new NotFoundError("Canal no encontrado.");
    return input.channelPropertyId;
  }
  return input.queryPropertyId ?? input.sessionPropertyId;
}

async function loadWebhookChannelFromDb(channelId: string): Promise<WebhookChannel | null> {
  return prisma.channel.findUnique({ where: { id: channelId }, select: { id: true, credentialsEncrypted: true, configurationJson: true } });
}

export function registerChannelManagerRoutes(app: FastifyInstance, deps: ChannelManagerRouteDeps = {}): void {
  const loadWebhookChannel = deps.loadWebhookChannel ?? loadWebhookChannelFromDb;
  const channelAccess = deps.channelAccess ?? channelAccessFromDb;
  const listDeliveriesFn = deps.listDeliveries ?? listDeliveries;
  const pullReservations =
    deps.pullReservations ??
    (async (channelId: string) => {
      const result = await pullChannelReservations({ channelId });
      return { ok: result.ok, imported: result.imported };
    });

  // Raw body capture + authentication for the webhook prefix (see file
  // header). The hook is global to the instance but returns immediately for
  // every other URL; the replayed stream carries `receivedEncodedLength` so
  // Fastify's body-limit accounting keeps working.
  app.addHook("preParsing", async (request, _reply, payload) => {
    if (!isWebhookUrl(request.raw.url)) return payload;
    const bytes = await readStreamBytes(payload, WEBHOOK_MAX_BYTES);
    request.rawBody = bytes.toString("utf8");
    // Neutral answer whatever the reason (unknown channel, no secret configured,
    // wrong secret / signature, malformed URL): never reveal which.
    const channelId = webhookChannelIdFromUrl(request.raw.url);
    const channel = channelId ? await loadWebhookChannel(channelId) : null;
    if (!channel || !verifyWebhookSecret(channel, request.headers as Record<string, unknown>, request.rawBody)) {
      throw new UnauthorizedError("Webhook no autorizado.");
    }
    request.webhookChannel = channel;
    const replay = Readable.from([bytes]) as Readable & { receivedEncodedLength?: number };
    replay.receivedEncodedLength = bytes.length;
    return replay;
  });

  // ---------------------------------------------------------------- editor list
  app.get("/properties/:propertyId/channels", async (request) => {
    const { propertyId } = params<{ propertyId: string }>(request);
    return { channels: await listRateGridChannels(propertyId), providers: listProviderCodes() };
  });

  app.get("/properties/:propertyId/channels/sync-status", async (request) => {
    const { propertyId } = params<{ propertyId: string }>(request);
    const q = parse(syncStatusSchema, request.query);
    const channelIds = q.channelIds === undefined ? undefined : Array.isArray(q.channelIds) ? q.channelIds : q.channelIds.split(",").filter(Boolean);
    return getRateGridSyncStatus(propertyId, q.from, q.to, channelIds);
  });

  // ---------------------------------------------------------------- channel CRUD
  app.post("/channel-manager/channels", async (request) => {
    requirePermissions(request.userContext, ["channel_manager.manage"]);
    const body = parse(createChannelSchema, request.body);
    return createChannel({ ...body, mode: body.mode as ChannelMode | undefined });
  });

  app.get("/channel-manager/channels/:channelId", async (request) => {
    const { channelId } = params<{ channelId: string }>(request);
    await channelAccess(request, channelId);
    return getChannelDetail(channelId);
  });

  app.patch("/channel-manager/channels/:channelId", async (request) => {
    requirePermissions(request.userContext, ["channel_manager.manage"]);
    const { channelId } = params<{ channelId: string }>(request);
    await channelAccess(request, channelId);
    const body = parse(patchChannelSchema, request.body);
    return patchChannel(channelId, { ...body, mode: body.mode as ChannelMode | undefined }, { userId: request.userContext.userId });
  });

  // Logical delete: history kept, refused while deliveries are pending (409).
  app.delete("/channel-manager/channels/:channelId", async (request) => {
    requirePermissions(request.userContext, ["channel_manager.manage"]);
    const { channelId } = params<{ channelId: string }>(request);
    await channelAccess(request, channelId);
    return archiveChannel(channelId, { userId: request.userContext.userId });
  });

  app.patch("/channel-manager/channels/:channelId/credentials", async (request) => {
    requirePermissions(request.userContext, ["channel_manager.manage"]);
    const { channelId } = params<{ channelId: string }>(request);
    await channelAccess(request, channelId);
    const body = parse(patchCredentialsSchema, request.body);
    // Write-only by design: the answer is the detail (hasCredentials + keys).
    return setChannelCredentials(channelId, body.credentials, { merge: body.merge ?? false });
  });

  app.post("/channel-manager/channels/:channelId/test", async (request) => {
    requirePermissions(request.userContext, ["channel_manager.sync"]);
    const { channelId } = params<{ channelId: string }>(request);
    await channelAccess(request, channelId);
    return testChannel(channelId);
  });

  app.post("/channel-manager/channels/:channelId/pull-reservations", async (request) => {
    requirePermissions(request.userContext, ["channel_manager.sync"]);
    const { channelId } = params<{ channelId: string }>(request);
    await channelAccess(request, channelId);
    const body = parse(pullSchema, request.body);
    return pullChannelReservations({ channelId, since: body.since ? new Date(body.since) : undefined });
  });

  // ---------------------------------------------------------------- product mappings
  app.get("/channel-manager/channels/:channelId/product-mappings", async (request) => {
    const { channelId } = params<{ channelId: string }>(request);
    await channelAccess(request, channelId);
    return { mappings: await listProductMappings(channelId) };
  });

  app.post("/channel-manager/channels/:channelId/product-mappings", async (request) => {
    requirePermissions(request.userContext, ["channel_manager.mappings.manage"]);
    const { channelId } = params<{ channelId: string }>(request);
    await channelAccess(request, channelId);
    const body = parse(productMappingSchema, request.body);
    return upsertProductMapping({ channelId, ...body });
  });

  app.delete("/channel-manager/product-mappings/:id", async (request) => {
    requirePermissions(request.userContext, ["channel_manager.mappings.manage"]);
    const { id } = params<{ id: string }>(request);
    const mapping = await prisma.channelProductMapping.findUnique({ where: { id }, select: { channelId: true } });
    if (!mapping) throw new NotFoundError("Mapeo no encontrado.");
    await channelAccess(request, mapping.channelId);
    return deleteProductMapping(id);
  });

  app.post("/channel-manager/channels/:channelId/product-mappings/migrate-legacy", async (request) => {
    requirePermissions(request.userContext, ["channel_manager.mappings.manage"]);
    const { channelId } = params<{ channelId: string }>(request);
    await channelAccess(request, channelId);
    return migrateLegacyMappings(channelId);
  });

  app.get("/channel-manager/channels/:channelId/product-coverage", async (request) => {
    const { channelId } = params<{ channelId: string }>(request);
    await channelAccess(request, channelId);
    return productCoverage(channelId);
  });

  app.get("/channel-manager/channels/:channelId/readiness-v2", async (request) => {
    const { channelId } = params<{ channelId: string }>(request);
    await channelAccess(request, channelId);
    return channelReadiness(channelId);
  });

  // ---------------------------------------------------------------- outbox
  app.post("/channel-manager/deliveries/enqueue", async (request) => {
    requirePermissions(request.userContext, ["channel_manager.sync"]);
    const body = parse(enqueueSchema, request.body);
    const response = await enqueueRateGridPush({ ...body, actorUserId: request.userContext.userId });
    if (body.drainNow) {
      const drains = [];
      for (const channelId of body.channelIds) drains.push(await drainChannelDeliveries({ channelId }));
      return { ...response, drained: drains };
    }
    return response;
  });

  app.get("/channel-manager/deliveries", async (request) => {
    const q = parse(listDeliveriesSchema, request.query);
    const owner = q.channelId ? await channelAccess(request, q.channelId) : null;
    const propertyId = deliveriesScope({ queryPropertyId: q.propertyId, sessionPropertyId: request.userContext.propertyId, channelPropertyId: owner?.propertyId || undefined });
    return listDeliveriesFn({ ...q, propertyId });
  });

  app.get("/channel-manager/deliveries/:id", async (request) => {
    const { id } = params<{ id: string }>(request);
    const delivery = await getDelivery(id);
    await channelAccess(request, delivery.channelId);
    return delivery;
  });

  app.post("/channel-manager/deliveries/:id/retry", async (request) => {
    requirePermissions(request.userContext, ["channel_manager.sync"]);
    const { id } = params<{ id: string }>(request);
    const delivery = await getDelivery(id);
    await channelAccess(request, delivery.channelId);
    return retryDelivery(id);
  });

  app.post("/channel-manager/deliveries/drain", async (request) => {
    requirePermissions(request.userContext, ["distribution.sync"]);
    const body = parse(drainSchema, request.body);
    if (body.channelId) await channelAccess(request, body.channelId);
    else if (!request.userContext.isPlatformAdmin) {
      // A tenant may only drain its own channels: scope by property.
      const channels = await prisma.channel.findMany({ where: { propertyId: request.userContext.propertyId }, select: { id: true } });
      const summaries = [];
      for (const c of channels) summaries.push(await drainChannelDeliveries({ channelId: c.id, limit: body.limit }));
      return { runs: summaries };
    }
    return drainChannelDeliveries({ channelId: body.channelId, limit: body.limit });
  });

  // ---------------------------------------------------------------- webhook (public)
  // Own encapsulated context: every content type (application/json included)
  // reaches the handler as the raw string, so a provider body that is not
  // well-formed JSON is never a 400 — the payload is a hint, never parsed into
  // a shape we would trust. The callback parameter is deliberately named
  // `app`: the route-permissions contract test inventories `app.<verb>(` calls.
  app.register(async (app) => {
    app.removeAllContentTypeParsers();
    app.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => {
      done(null, body);
    });
    app.post("/channel-manager/webhooks/:provider/:channelId", async (request, reply) => {
      const { channelId } = params<{ provider: string; channelId: string }>(request);
      // Normally already verified by the preParsing hook (401 before any parser).
      // A caller that bypassed the hook (direct handler invocation) is verified
      // here with the same neutral answer.
      let channel = request.webhookChannel;
      if (!channel) {
        const candidate = await loadWebhookChannel(channelId);
        const rawBody = request.rawBody ?? (typeof request.body === "string" ? request.body : request.body === undefined || request.body === null ? "" : JSON.stringify(request.body));
        if (!candidate || !verifyWebhookSecret(candidate, request.headers as Record<string, unknown>, rawBody)) throw new UnauthorizedError("Webhook no autorizado.");
        channel = candidate;
      }
      // The payload is not trusted: we only take it as a hint to pull.
      const result = await pullReservations(channel.id);
      return reply.code(202).send({ accepted: true, imported: result.imported, ok: result.ok });
    });
  });

  // ---------------------------------------------------------------- sandbox loopback (public)
  app.post("/channel-manager/_sandbox/:provider", async (request, reply) => {
    const { provider } = params<{ provider: string }>(request);
    const code = provider.toLowerCase();
    const sim: SimulatorProvider | null = code === "booking" || code === "booking_com" ? "booking" : code === "channex" ? "channex" : code === "expedia" ? "expedia" : null;
    if (!sim) throw new BadRequestError(`Simulador desconocido: ${provider}. Válidos: booking, expedia, channex.`);
    const q = (request.query ?? {}) as { endpoint?: string };
    const body = typeof request.body === "string" ? request.body : request.body === undefined || request.body === null ? "" : JSON.stringify(request.body);
    const endpoint = q.endpoint ?? (sim === "channex" ? "restrictions" : sim === "expedia" ? "ar" : /OTA_HotelAvailNotifRQ/.test(body) ? "OTA_HotelAvailNotif" : "OTA_HotelRateAmountNotif");
    const result = await runSimulator({ provider: sim, endpoint, body, channelId: `loopback:${sim}` });
    reply.code(result.status || 504).header("Content-Type", result.contentType).header("X-Anfitorio-Simulator", JSON.stringify({ accepted: result.accepted, rejected: result.rejected.length, warnings: result.warnings.length }));
    return reply.send(result.body);
  });
}
