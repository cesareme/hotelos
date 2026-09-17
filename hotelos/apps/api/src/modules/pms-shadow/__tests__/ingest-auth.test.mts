// Unit tests · Tanda 7b · L3 — clave de API del ingest público (ingest-auth.ts):
// `<clientId>.<clientSecret>` partido por el PRIMER punto, sha256 hex comparado con
// timingSafeEqual, app activa con scope pms.shadow.ingest; cualquier fallo → null
// (un solo 401 sin distinguir causas). Prisma sustituido por un stub en memoria.
// Desde apps/api:
//   node --import tsx --test src/modules/pms-shadow/__tests__/ingest-auth.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PMS_SHADOW_INGEST_SCOPE, pmsShadowIngestScopeFor } from "@hotelos/shared";
import { INGEST_UNAUTHORIZED_CODE, INGEST_UNAUTHORIZED_MESSAGE, authenticateIngestApiKey, hashApiSecret, ingestPropertyIdsOf, ingestUnauthorizedError, parseApiKeyHeader, principalAllowsProperty, type IngestAuthDb } from "../ingest-auth.js";

const SECRET = "sec_1234567890abcdefghijklmnopqrstuvwxyzABCDEF";
const CLIENT_ID = "cli_abcdefghijkl-mnop";

type AppRow = { id: string; organizationId: string; status: string; clientId: string; clientSecretHash: string | null; scopes: string[] };

function stubDb(apps: AppRow[]): IngestAuthDb & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    developerApp: {
      findUnique: (async (args: { where: { clientId: string } }) => {
        calls.push(args.where.clientId);
        return apps.find((app) => app.clientId === args.where.clientId) ?? null;
      }) as unknown as IngestAuthDb["developerApp"]["findUnique"]
    }
  };
}

const ACTIVE: AppRow = { id: "app_1", organizationId: "org_1", status: "active", clientId: CLIENT_ID, clientSecretHash: hashApiSecret(SECRET), scopes: ["reservations.read", PMS_SHADOW_INGEST_SCOPE] };

describe("parseApiKeyHeader — <clientId>.<secret> por el primer punto", () => {
  it("clave bien formada, con espacios alrededor y secreto con puntos", () => {
    assert.deepEqual(parseApiKeyHeader(`${CLIENT_ID}.${SECRET}`), { clientId: CLIENT_ID, secret: SECRET });
    assert.deepEqual(parseApiKeyHeader(`  ${CLIENT_ID}.${SECRET}  `), { clientId: CLIENT_ID, secret: SECRET });
    assert.deepEqual(parseApiKeyHeader(`${CLIENT_ID}.sec_con.puntos.dentro`), { clientId: CLIENT_ID, secret: "sec_con.puntos.dentro" }, "el secreto conserva sus puntos");
    assert.deepEqual(parseApiKeyHeader([`${CLIENT_ID}.${SECRET}`, "otra"]), { clientId: CLIENT_ID, secret: SECRET }, "cabecera repetida: la primera");
  });

  it("ausente, no texto, sin punto, partes vacías o clientId sin el prefijo cli_ → null", () => {
    assert.equal(parseApiKeyHeader(undefined), null);
    assert.equal(parseApiKeyHeader(null), null);
    assert.equal(parseApiKeyHeader(42), null);
    assert.equal(parseApiKeyHeader(""), null);
    assert.equal(parseApiKeyHeader("sinpunto"), null);
    assert.equal(parseApiKeyHeader(`${CLIENT_ID}.`), null);
    assert.equal(parseApiKeyHeader(`.${SECRET}`), null);
    assert.equal(parseApiKeyHeader(`app_abcdefghijkl.${SECRET}`), null, "prefijo distinto de cli_");
    assert.equal(parseApiKeyHeader(`cli_ab.${SECRET}`), null, "clientId demasiado corto");
    assert.equal(parseApiKeyHeader(`${CLIENT_ID}.con espacio`), null, "secreto con espacios");
  });
});

describe("authenticateIngestApiKey — app activa + secreto correcto + scope pms.shadow.ingest", () => {
  it("clave válida → principal con appId, clientId, organización y scopes; una sola consulta por clientId", async () => {
    const db = stubDb([ACTIVE]);
    const principal = await authenticateIngestApiKey(db, `${CLIENT_ID}.${SECRET}`);
    assert.deepEqual(principal, { appId: "app_1", clientId: CLIENT_ID, organizationId: "org_1", scopes: ["reservations.read", PMS_SHADOW_INGEST_SCOPE], propertyIds: null });
    assert.deepEqual(db.calls, [CLIENT_ID]);
  });

  it("SEC-04 · scope ligado a un centro (pms.shadow.ingest:<propertyId>) → propertyIds con esos centros; solo ese centro pasa principalAllowsProperty", async () => {
    assert.equal(pmsShadowIngestScopeFor("prop_ra"), "pms.shadow.ingest:prop_ra");
    const bound = await authenticateIngestApiKey(stubDb([{ ...ACTIVE, scopes: [pmsShadowIngestScopeFor("prop_ra"), "reservations.read", pmsShadowIngestScopeFor("prop_lt"), pmsShadowIngestScopeFor("prop_ra")] }]), `${CLIENT_ID}.${SECRET}`);
    assert.deepEqual(bound?.propertyIds, ["prop_ra", "prop_lt"], "sin duplicados, en orden");
    assert.equal(principalAllowsProperty(bound!, "prop_ra"), true);
    assert.equal(principalAllowsProperty(bound!, "prop_lt"), true);
    assert.equal(principalAllowsProperty(bound!, "prop_pg"), false, "otro centro de la misma organización: no");
    // El scope a secas manda: cualquier centro de la organización aunque haya también ligados.
    const wide = await authenticateIngestApiKey(stubDb([{ ...ACTIVE, scopes: [pmsShadowIngestScopeFor("prop_ra"), PMS_SHADOW_INGEST_SCOPE] }]), `${CLIENT_ID}.${SECRET}`);
    assert.equal(wide?.propertyIds, null);
    assert.equal(principalAllowsProperty(wide!, "prop_pg"), true);
    // Prefijo sin id o solo espacios: no cuenta como scope.
    assert.equal(await authenticateIngestApiKey(stubDb([{ ...ACTIVE, scopes: ["pms.shadow.ingest:", "pms.shadow.ingest:   "] }]), `${CLIENT_ID}.${SECRET}`), null);
    assert.deepEqual(ingestPropertyIdsOf(["reservations.read"]), []);
    assert.equal(ingestPropertyIdsOf([PMS_SHADOW_INGEST_SCOPE]), null);
  });

  it("cabecera mal formada → null SIN consultar la base de datos", async () => {
    const db = stubDb([ACTIVE]);
    assert.equal(await authenticateIngestApiKey(db, undefined), null);
    assert.equal(await authenticateIngestApiKey(db, "sinpunto"), null);
    assert.deepEqual(db.calls, []);
  });

  it("app inexistente, secreto incorrecto, app revocada, sin scope o sin hash → null (mismo resultado, sin oráculo)", async () => {
    assert.equal(await authenticateIngestApiKey(stubDb([]), `${CLIENT_ID}.${SECRET}`), null, "inexistente");
    assert.equal(await authenticateIngestApiKey(stubDb([ACTIVE]), `${CLIENT_ID}.${SECRET}x`), null, "secreto incorrecto");
    assert.equal(await authenticateIngestApiKey(stubDb([{ ...ACTIVE, status: "revoked" }]), `${CLIENT_ID}.${SECRET}`), null, "revocada");
    assert.equal(await authenticateIngestApiKey(stubDb([{ ...ACTIVE, status: "draft" }]), `${CLIENT_ID}.${SECRET}`), null, "borrador");
    assert.equal(await authenticateIngestApiKey(stubDb([{ ...ACTIVE, scopes: ["reservations.read"] }]), `${CLIENT_ID}.${SECRET}`), null, "sin scope");
    assert.equal(await authenticateIngestApiKey(stubDb([{ ...ACTIVE, clientSecretHash: null }]), `${CLIENT_ID}.${SECRET}`), null, "sin hash");
    assert.equal(await authenticateIngestApiKey(stubDb([{ ...ACTIVE, clientSecretHash: "no-es-hex" }]), `${CLIENT_ID}.${SECRET}`), null, "hash corrupto: sin excepción");
  });

  it("hashApiSecret = sha256 hex (misma función que hashSecret de marketplace.service.ts)", () => {
    assert.equal(hashApiSecret("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.match(hashApiSecret(SECRET), /^[0-9a-f]{64}$/);
  });

  it("ingestUnauthorizedError: 401 único con details.code PMS_SHADOW_INGEST_UNAUTHORIZED", () => {
    const error = ingestUnauthorizedError();
    assert.equal(error.statusCode, 401);
    assert.equal(error.message, INGEST_UNAUTHORIZED_MESSAGE);
    assert.equal(error.message, "Clave de API no autorizada.");
    assert.deepEqual(error.details, { code: INGEST_UNAUTHORIZED_CODE });
    assert.equal(INGEST_UNAUTHORIZED_CODE, "PMS_SHADOW_INGEST_UNAUTHORIZED");
  });
});
