// OPERA Cloud · modo sombra (Tanda 7b · L3) — autenticación del ingest público
// `POST /integrations/pms-shadow/ingest` por clave de API de una `DeveloperApp`.
//
// Cabecera `X-Api-Key: <clientId>.<clientSecret>` (PMS_SHADOW_INGEST_HEADER). El
// clientId es `cli_<base64url>` (marketplace.service.ts createDeveloperApp) y no
// contiene puntos, así que se parte por el PRIMER punto. El secreto se compara
// como sha256 hex (la misma función que `hashSecret` de marketplace.service.ts,
// privada allí y reimplementada aquí) con crypto.timingSafeEqual sobre buffers
// de igual longitud. Cualquier fallo —cabecera ausente o mal formada, app
// inexistente, revocada (`status ≠ active`), secreto incorrecto, sin el scope
// `pms.shadow.ingest`— devuelve null y el handler responde UN solo 401
// PMS_SHADOW_INGEST_UNAUTHORIZED «Clave de API no autorizada.», sin distinguir
// causas (no es un oráculo de existencia de apps). Ningún preHandler valida
// tokens de DeveloperApp hoy (§10 nº 11): la clave se verifica en el handler.
//
// SEC-04: el scope puede ir ligado a un centro (`pms.shadow.ingest:<propertyId>`,
// una entrada por hotel). `principal.propertyIds` = null con el scope a secas
// (cualquier centro de la organización) o la lista de centros permitidos; el
// handler comprueba `principalAllowsProperty` ANTES de mirar la propiedad y
// responde el mismo 401 (una clave por hotel comprometida no escribe en los demás).

import { createHash, timingSafeEqual } from "node:crypto";
import type { prisma } from "@hotelos/database";
import { PMS_SHADOW_INGEST_SCOPE, PMS_SHADOW_INGEST_SCOPE_PROPERTY_PREFIX } from "@hotelos/shared";
import { UnauthorizedError } from "../../lib/http-error.js";

export const INGEST_UNAUTHORIZED_MESSAGE = "Clave de API no autorizada.";
export const INGEST_UNAUTHORIZED_CODE = "PMS_SHADOW_INGEST_UNAUTHORIZED";
/** `cli_` + base64url (createDeveloperApp); sin puntos por construcción. */
const CLIENT_ID_PATTERN = /^cli_[A-Za-z0-9_-]{8,}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_.~+/=-]{8,512}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export type IngestApiKey = { clientId: string; secret: string };

/**
 * App autenticada: quién envía el corte. `createdBy` del run = `developer_app:<clientId>`.
 * `propertyIds`: null = cualquier centro de la organización (scope `pms.shadow.ingest`);
 * lista = solo esos centros (scopes `pms.shadow.ingest:<propertyId>`, SEC-04).
 */
export type IngestPrincipal = { appId: string; clientId: string; organizationId: string; scopes: string[]; propertyIds: string[] | null };

/**
 * Centros que autorizan los scopes de la app: null si lleva el scope a secas
 * (toda la organización), la lista de `pms.shadow.ingest:<propertyId>` si solo
 * lleva scopes ligados, o [] si no lleva ninguno de los dos (→ null del validador).
 */
export function ingestPropertyIdsOf(scopes: readonly string[]): string[] | null {
  if (scopes.includes(PMS_SHADOW_INGEST_SCOPE)) return null;
  const bound: string[] = [];
  for (const scope of scopes) {
    if (typeof scope !== "string" || !scope.startsWith(PMS_SHADOW_INGEST_SCOPE_PROPERTY_PREFIX)) continue;
    const propertyId = scope.slice(PMS_SHADOW_INGEST_SCOPE_PROPERTY_PREFIX.length).trim();
    if (propertyId !== "" && !bound.includes(propertyId)) bound.push(propertyId);
  }
  return bound;
}

/** ¿La app puede enviar cortes de ese centro? (null = cualquiera de su organización). */
export function principalAllowsProperty(principal: Pick<IngestPrincipal, "propertyIds">, propertyId: string): boolean {
  return principal.propertyIds === null || principal.propertyIds.includes(propertyId);
}

/** Solo la consulta que necesita el validador; el test unitario pasa un stub. */
export type IngestAuthDb = { developerApp: Pick<(typeof prisma)["developerApp"], "findUnique"> };

/** `<clientId>.<secret>` → partes; null si falta, no es texto, no tiene punto o alguna parte no encaja con su forma. */
export function parseApiKeyHeader(value: unknown): IngestApiKey | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  const dot = text.indexOf(".");
  if (dot <= 0 || dot === text.length - 1) return null;
  const clientId = text.slice(0, dot);
  const secret = text.slice(dot + 1);
  if (!CLIENT_ID_PATTERN.test(clientId) || !SECRET_PATTERN.test(secret)) return null;
  return { clientId, secret };
}

/** sha256 hex del secreto, como `hashSecret` de marketplace.service.ts (privada allí). */
export function hashApiSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function secretMatches(secret: string, storedHash: string | null | undefined): boolean {
  if (typeof storedHash !== "string" || !SHA256_HEX.test(storedHash)) return false;
  const expected = Buffer.from(storedHash, "hex");
  const actual = Buffer.from(hashApiSecret(secret), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Cabecera → app autenticada o null. Una sola consulta (findUnique por clientId,
 * índice único); el resto son comparaciones en memoria. Nunca lanza por una
 * clave mal formada: el handler decide el 401.
 */
export async function authenticateIngestApiKey(db: IngestAuthDb, header: unknown): Promise<IngestPrincipal | null> {
  const key = parseApiKeyHeader(header);
  if (!key) return null;
  const app = await db.developerApp.findUnique({ where: { clientId: key.clientId } });
  if (!app) return null;
  if (app.status !== "active") return null;
  if (!secretMatches(key.secret, app.clientSecretHash)) return null;
  const scopes = Array.isArray(app.scopes) ? app.scopes : [];
  const propertyIds = ingestPropertyIdsOf(scopes);
  if (propertyIds !== null && propertyIds.length === 0) return null; // ni el scope a secas ni uno ligado a un centro
  return { appId: app.id, clientId: app.clientId, organizationId: app.organizationId, scopes, propertyIds };
}

/** El único 401 del ingest (mismo cuerpo para todas las causas). */
export function ingestUnauthorizedError(): UnauthorizedError {
  const error = new UnauthorizedError(INGEST_UNAUTHORIZED_MESSAGE);
  error.details = { code: INGEST_UNAUTHORIZED_CODE };
  return error;
}
