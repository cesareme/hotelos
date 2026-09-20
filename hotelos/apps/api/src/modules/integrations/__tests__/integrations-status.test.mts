// Unit tests · Tanda L8 · L8-01 — estado honesto de las integraciones
// (integrations-status.service.ts): una función pura por integración con
// fixtures explícitas (sin BD), el subconjunto de /health y el colector con
// Prisma y lectores sustituidos por stubs en memoria.
// Reglas fijas que fijan estos tests: readyForReal ≡ real && missingForReal
// vacío; mode none ⇒ readyForReal=false y lastActivityAt=null; sandbox nunca
// dice «enviado»; sin URLs, buckets, endpoints ni variables secretas en las
// frases (el bloque de /health es público).
// Desde apps/api:
//   node --import tsx --test src/modules/integrations/__tests__/integrations-status.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { INTEGRATION_KEYS, INTEGRATION_LABELS_ES, INTEGRATION_MODES, INTEGRATION_SCREENS, INTEGRATION_TRANSPORTS, type IntegrationStatusDto } from "@hotelos/shared";
import {
  INTEGRATION_HEALTH_KEYS,
  NO_DELIVERIES,
  NO_SUBMISSIONS,
  aiStatus,
  channelsStatus,
  collectIntegrationsStatus,
  complianceGates,
  complianceStatus,
  describeIntegrationsHealth,
  emailInStatus,
  emailOutStatus,
  gbpStatus,
  gestoriaExportStatus,
  igicStatus,
  operaStatus,
  pspStatus,
  redisStatus,
  sage200Status,
  sentryStatus,
  smsStatus,
  storageStatus,
  whatsappStatus,
  type ComplianceIntegrationInput,
  type DeliveryActivity,
  type IntegrationsHealthInputs,
  type IntegrationsStatusDb,
  type IntegrationsStatusDeps
} from "../integrations-status.service.js";

const T_OLD = new Date("2026-09-18T07:00:00.000Z");
const T_MID = new Date("2026-09-19T08:30:00.000Z");
const T_NEW = new Date("2026-09-20T09:15:00.000Z");

const URL_OR_ENDPOINT = /https?:|:\/\/|\bwww\.|\.(com|es|io|net)\b|\/[a-z]+\/[a-z]+\//i;
const SECRET_VAR_NAME = /\b[A-Z][A-Z0-9]*_(SECRET|KEY|TOKEN|PASSPHRASE|PASSWORD|DSN|URL)\b/;
const SAYS_SENT = /\benviad[oa]s?\b/i;

/** Invariantes comunes del DTO (contrato L8). */
function assertInvariants(dto: IntegrationStatusDto): void {
  assert.ok((INTEGRATION_KEYS as readonly string[]).includes(dto.key), `clave desconocida ${dto.key}`);
  assert.equal(dto.label, INTEGRATION_LABELS_ES[dto.key]);
  assert.equal(dto.screen, INTEGRATION_SCREENS[dto.key]);
  assert.ok((INTEGRATION_MODES as readonly string[]).includes(dto.mode));
  assert.ok((INTEGRATION_TRANSPORTS as readonly string[]).includes(dto.transport));
  assert.equal(dto.readyForReal, dto.mode === "real" && dto.missingForReal.length === 0, `${dto.key}: readyForReal ≡ real && sin pendientes`);
  if (dto.mode === "none") {
    assert.equal(dto.readyForReal, false, `${dto.key}: none nunca está listo`);
    assert.equal(dto.lastActivityAt, null, `${dto.key}: none sin actividad`);
  }
  if (dto.mode === "sandbox") {
    assert.doesNotMatch(dto.message, SAYS_SENT, `${dto.key}: sandbox nunca dice «enviado»`);
    assert.match(dto.message, /simul|prueba|ficticia|local/i, `${dto.key}: sandbox se declara como tal`);
  }
  assert.ok(dto.message.trim().length > 0);
  assert.doesNotMatch(dto.message, URL_OR_ENDPOINT, `${dto.key}: frase sin URLs/endpoints`);
  assert.doesNotMatch(dto.message, SECRET_VAR_NAME, `${dto.key}: frase sin variables secretas`);
  for (const item of dto.missingForReal) {
    assert.doesNotMatch(item, URL_OR_ENDPOINT);
    assert.doesNotMatch(item, SECRET_VAR_NAME);
  }
  assert.equal(new Set(dto.missingForReal).size, dto.missingForReal.length, `${dto.key}: pendientes sin duplicados`);
  if (dto.lastActivityAt !== null) assert.ok(!Number.isNaN(Date.parse(dto.lastActivityAt)), `${dto.key}: lastActivityAt ISO`);
}

describe("operaStatus — OPERA Cloud modo sombra (ficheros reales)", () => {
  it("sin perfil → none aunque existan runs (regla none ⇒ sin actividad)", () => {
    const dto = operaStatus({ profile: null, lastRun: { status: "done", source: "cli", createdAt: T_NEW, errorMessage: null }, ingestAppCount: 1, shadowMailboxCount: 0 });
    assertInvariants(dto);
    assert.equal(dto.mode, "none");
    assert.equal(dto.configured, false);
    assert.equal(dto.lastActivityAt, null);
    assert.ok(dto.missingForReal.some((item) => /perfil de modo sombra activo/i.test(item)));
  });

  it("perfil pausado → none pero configured", () => {
    const dto = operaStatus({ profile: { status: "paused", updatedAt: T_OLD }, lastRun: null, ingestAppCount: 0, shadowMailboxCount: 0 });
    assertInvariants(dto);
    assert.equal(dto.mode, "none");
    assert.equal(dto.configured, true);
    assert.match(dto.message, /paused/);
  });

  it("perfil activo sin vía de ingest ni informes → real por ficheros, no listo", () => {
    const dto = operaStatus({ profile: { status: "active", updatedAt: T_OLD }, lastRun: null, ingestAppCount: 0, shadowMailboxCount: 0 });
    assertInvariants(dto);
    assert.equal(dto.mode, "real");
    assert.equal(dto.transport, "files");
    assert.equal(dto.readyForReal, false);
    assert.equal(dto.missingForReal.length, 2);
    assert.equal(dto.lastActivityAt, null);
  });

  it("perfil activo con clave de ingest y run procesado → listo, actividad = run", () => {
    const dto = operaStatus({ profile: { status: "active", updatedAt: T_OLD }, lastRun: { status: "done", source: "api_key", createdAt: T_MID, errorMessage: null }, ingestAppCount: 1, shadowMailboxCount: 0 });
    assertInvariants(dto);
    assert.equal(dto.readyForReal, true);
    assert.equal(dto.lastActivityAt, T_MID.toISOString());
    assert.equal(dto.lastError, null);
    assert.match(dto.message, /1 aplicación con clave de ingest/);
  });

  it("último run fallido → lastError con el mensaje; parcial sin mensaje → texto genérico", () => {
    const failed = operaStatus({ profile: { status: "active", updatedAt: T_OLD }, lastRun: { status: "failed", source: "api_key", createdAt: T_NEW, errorMessage: "Cabecera del informe no reconocida" }, ingestAppCount: 0, shadowMailboxCount: 1 });
    assertInvariants(failed);
    assert.equal(failed.lastError, "Cabecera del informe no reconocida");
    assert.match(failed.message, /1 buzón de correo/);
    const partial = operaStatus({ profile: { status: "active", updatedAt: T_OLD }, lastRun: { status: "partial", source: "cli", createdAt: T_NEW, errorMessage: null }, ingestAppCount: 0, shadowMailboxCount: 0 });
    assert.match(partial.lastError ?? "", /errores/);
  });
});

describe("sage200Status — importación por ficheros", () => {
  it("sin lotes → none", () => {
    const dto = sage200Status({ totalImports: 0, postedImports: 0, lastImport: null });
    assertInvariants(dto);
    assert.equal(dto.mode, "none");
    assert.equal(dto.configured, false);
  });

  it("lotes solo en borrador → real por ficheros, pendiente de contabilizar", () => {
    const dto = sage200Status({ totalImports: 2, postedImports: 0, lastImport: { status: "draft", createdAt: T_MID, postedAt: null } });
    assertInvariants(dto);
    assert.equal(dto.mode, "real");
    assert.equal(dto.transport, "files");
    assert.equal(dto.readyForReal, false);
    assert.equal(dto.lastActivityAt, T_MID.toISOString());
  });

  it("lotes contabilizados → listo; actividad = el más reciente entre creación y contabilización", () => {
    const dto = sage200Status({ totalImports: 50, postedImports: 50, lastImport: { status: "posted", createdAt: T_MID, postedAt: T_NEW } });
    assertInvariants(dto);
    assert.equal(dto.readyForReal, true);
    assert.equal(dto.lastActivityAt, T_NEW.toISOString());
    assert.match(dto.message, /50 lotes importados/);
    assert.match(dto.message, /por ficheros/);
  });
});

describe("gestoriaExportStatus — exportación manual", () => {
  it("siempre real por transporte manual, listo, y declara los formatos no implementados", () => {
    const dto = gestoriaExportStatus({ lastExportAt: T_OLD });
    assertInvariants(dto);
    assert.equal(dto.mode, "real");
    assert.equal(dto.transport, "manual");
    assert.equal(dto.readyForReal, true);
    assert.match(dto.message, /A3 y Sage 200 no implementados/);
    assert.equal(dto.lastActivityAt, T_OLD.toISOString());
    assert.equal(gestoriaExportStatus().lastActivityAt, null);
  });
});

describe("channelsStatus — canales de venta", () => {
  const sandboxActive = { providerCode: "booking_com", mode: "sandbox", status: "active", lastSyncAt: T_MID };
  const realActive = { providerCode: "channex", mode: "real", status: "active", lastSyncAt: T_NEW };

  it("sin canales → none; con tope sandbox el tope aparece como pendiente", () => {
    const dto = channelsStatus({ maxMode: "sandbox", channels: [] });
    assertInvariants(dto);
    assert.equal(dto.mode, "none");
    assert.ok(dto.missingForReal.some((item) => /tope de modo/i.test(item)));
    const real = channelsStatus({ maxMode: "real", channels: [] });
    assert.ok(!real.missingForReal.some((item) => /tope de modo/i.test(item)));
  });

  it("canales dados de alta pero ninguno activo → none y configured", () => {
    const dto = channelsStatus({ maxMode: "sandbox", channels: [{ ...sandboxActive, status: "inactive" }] });
    assertInvariants(dto);
    assert.equal(dto.mode, "none");
    assert.equal(dto.configured, true);
    assert.equal(dto.lastActivityAt, null);
  });

  it("tope sandbox limita un canal declarado real → sandbox (nada sale a Internet)", () => {
    const dto = channelsStatus({ maxMode: "sandbox", channels: [realActive, sandboxActive] });
    assertInvariants(dto);
    assert.equal(dto.mode, "sandbox");
    assert.match(dto.message, /nada sale a Internet/);
    assert.ok(dto.missingForReal.some((item) => /tope de modo/i.test(item)));
    assert.equal(dto.lastActivityAt, T_NEW.toISOString());
  });

  it("tope real + canal real activo → real y listo; solo sandbox → sandbox sin línea de tope", () => {
    const real = channelsStatus({ maxMode: "real", channels: [realActive, sandboxActive] });
    assertInvariants(real);
    assert.equal(real.mode, "real");
    assert.equal(real.readyForReal, true);
    assert.match(real.message, /1 en real/);
    const onlySandbox = channelsStatus({ maxMode: "real", channels: [sandboxActive] });
    assertInvariants(onlySandbox);
    assert.equal(onlySandbox.mode, "sandbox");
    assert.ok(!onlySandbox.missingForReal.some((item) => /tope de modo/i.test(item)));
    assert.ok(onlySandbox.missingForReal.some((item) => /credenciales del proveedor/i.test(item)));
  });
});

describe("pspStatus — pasarela de pago", () => {
  it("sin PSP → none", () => {
    const dto = pspStatus({ configured: false, provider: null, mode: null, webhookSecretConfigured: false });
    assertInvariants(dto);
    assert.equal(dto.mode, "none");
    assert.match(dto.message, /Ningún PSP configurado/);
  });

  it("modo test → sandbox con credenciales de producción, webhook y decisión pendientes", () => {
    const dto = pspStatus({ configured: true, provider: "stripe", mode: "test", webhookSecretConfigured: false });
    assertInvariants(dto);
    assert.equal(dto.mode, "sandbox");
    assert.equal(dto.transport, "http");
    assert.equal(dto.missingForReal.length, 3);
    assert.match(dto.message, /Stripe en modo de pruebas/);
  });

  it("modo live sin secreto de webhook → real pero no listo; con secreto → listo", () => {
    const noWebhook = pspStatus({ configured: true, provider: "redsys", mode: "live", webhookSecretConfigured: false });
    assertInvariants(noWebhook);
    assert.equal(noWebhook.mode, "real");
    assert.equal(noWebhook.readyForReal, false);
    assert.match(noWebhook.message, /Redsys en modo de producción/);
    const ready = pspStatus({ configured: true, provider: "redsys", mode: "live", webhookSecretConfigured: true });
    assertInvariants(ready);
    assert.equal(ready.readyForReal, true);
  });
});

const DELIVERIES: DeliveryActivity = { lastRealAt: T_MID, lastSimulatedAt: T_NEW, lastFailed: { at: T_OLD, error: "SIMULADO: destinatario rechazado" } };

describe("whatsappStatus / smsStatus / emailOutStatus — salidas", () => {
  it("whatsapp real con webhook firmado → listo, actividad = último envío real", () => {
    const dto = whatsappStatus({ outboundConfigured: true, webhookMode: "signed", production: true, deliveries: DELIVERIES });
    assertInvariants(dto);
    assert.equal(dto.mode, "real");
    assert.equal(dto.readyForReal, true);
    assert.equal(dto.lastActivityAt, T_MID.toISOString());
    assert.equal(dto.lastError, "SIMULADO: destinatario rechazado");
  });

  it("whatsapp real con webhook rechazado → no listo (falta el secreto)", () => {
    const dto = whatsappStatus({ outboundConfigured: true, webhookMode: "refused", production: true });
    assertInvariants(dto);
    assert.equal(dto.readyForReal, false);
    assert.match(dto.message, /rechazado/);
  });

  it("whatsapp sin credenciales fuera de producción → sandbox SIMULADO, actividad = último simulado", () => {
    const dto = whatsappStatus({ outboundConfigured: false, webhookMode: "simulated", production: false, deliveries: DELIVERIES });
    assertInvariants(dto);
    assert.equal(dto.mode, "sandbox");
    assert.match(dto.message, /SIMULADO/);
    assert.equal(dto.lastActivityAt, T_NEW.toISOString());
    assert.equal(dto.missingForReal.length, 3);
  });

  it("whatsapp sin credenciales en producción → none (fallan, no se simulan) y sin actividad", () => {
    const dto = whatsappStatus({ outboundConfigured: false, webhookMode: "refused", production: true, deliveries: DELIVERIES });
    assertInvariants(dto);
    assert.equal(dto.mode, "none");
    assert.equal(dto.lastActivityAt, null);
    assert.match(dto.message, /no se simulan/);
  });

  it("sms: real / sandbox / none", () => {
    const real = smsStatus({ configured: true, production: true, deliveries: DELIVERIES });
    assertInvariants(real);
    assert.equal(real.mode, "real");
    assert.equal(real.readyForReal, true);
    const sandbox = smsStatus({ configured: false, production: false, deliveries: DELIVERIES });
    assertInvariants(sandbox);
    assert.equal(sandbox.mode, "sandbox");
    assert.equal(sandbox.lastActivityAt, T_NEW.toISOString());
    const none = smsStatus({ configured: false, production: true });
    assertInvariants(none);
    assert.equal(none.mode, "none");
  });

  it("correo saliente: real usa la última entrega real (no la simulada); simulated → sandbox; disabled → none", () => {
    const real = emailOutStatus({ configured: true, provider: "postmark", mode: "real", deliveries: DELIVERIES });
    assertInvariants(real);
    assert.equal(real.mode, "real");
    assert.equal(real.lastActivityAt, T_MID.toISOString());
    assert.match(real.message, /Postmark/);
    const sandbox = emailOutStatus({ configured: false, provider: null, mode: "simulated", deliveries: DELIVERIES });
    assertInvariants(sandbox);
    assert.equal(sandbox.mode, "sandbox");
    assert.match(sandbox.message, /SIMULADO/);
    assert.equal(sandbox.lastActivityAt, T_NEW.toISOString());
    const none = emailOutStatus({ configured: false, provider: null, mode: "disabled", deliveries: DELIVERIES });
    assertInvariants(none);
    assert.equal(none.mode, "none");
    assert.equal(none.lastActivityAt, null);
    const bare = emailOutStatus({ configured: false, provider: null, mode: "simulated" });
    assert.equal(bare.lastActivityAt, null);
    assert.equal(NO_DELIVERIES.lastFailed, null);
  });
});

describe("emailInStatus — correo entrante OAuth", () => {
  const providers = (gmail: boolean, microsoft: boolean) => ({ gmail: { configured: gmail }, microsoft: { configured: microsoft }, imap: { configured: false }, manual: { configured: true } });

  it("sin OAuth → none aunque haya buzón manual (transporte manual)", () => {
    const dto = emailInStatus({ providers: providers(false, false), connections: [{ provider: "manual", status: "connected", purpose: "reservation_ai", lastSyncAt: T_NEW, lastError: null, updatedAt: T_NEW }] });
    assertInvariants(dto);
    assert.equal(dto.mode, "none");
    assert.equal(dto.transport, "manual");
    assert.equal(dto.lastActivityAt, null);
  });

  it("OAuth configurado sin buzones → real no listo (falta autorizar)", () => {
    const dto = emailInStatus({ providers: providers(true, false), connections: [] });
    assertInvariants(dto);
    assert.equal(dto.mode, "real");
    assert.equal(dto.readyForReal, false);
    assert.match(dto.message, /OAuth de Google configurado; ningún buzón autorizado/);
  });

  it("buzón conectado → listo; propósito en la frase; error de otro buzón en lastError", () => {
    const dto = emailInStatus({
      providers: providers(true, true),
      connections: [
        { provider: "gmail", status: "connected", purpose: "pms_shadow", lastSyncAt: T_MID, lastError: null, updatedAt: T_MID },
        { provider: "microsoft", status: "error", purpose: "documents", lastSyncAt: T_OLD, lastError: "Token caducado", updatedAt: T_NEW }
      ]
    });
    assertInvariants(dto);
    assert.equal(dto.readyForReal, true);
    assert.match(dto.message, /Google y Microsoft/);
    assert.match(dto.message, /1 buzón autorizado \(1 pms_shadow\)/);
    assert.match(dto.message, /1 pendiente\(s\) o con error/);
    assert.equal(dto.lastActivityAt, T_MID.toISOString());
    assert.equal(dto.lastError, "Token caducado");
  });
});

describe("gbpStatus — Google Business Profile", () => {
  it("sin fuentes → none; fuente de Google pendiente → none y configured", () => {
    const none = gbpStatus({ sources: [] });
    assertInvariants(none);
    assert.equal(none.mode, "none");
    assert.equal(none.configured, false);
    const pending = gbpStatus({ sources: [{ provider: "google", status: "pending", mode: "api", lastRunAt: null, lastError: null, updatedAt: T_OLD }] });
    assertInvariants(pending);
    assert.equal(pending.mode, "none");
    assert.equal(pending.configured, true);
    assert.match(pending.message, /pending/);
  });

  it("reseñas por CSV → real por ficheros, no listo (la API exige la ruta OAuth que no existe)", () => {
    const dto = gbpStatus({ sources: [{ provider: "csv", status: "connected", mode: "csv", lastRunAt: T_MID, lastError: null, updatedAt: T_MID }] });
    assertInvariants(dto);
    assert.equal(dto.mode, "real");
    assert.equal(dto.transport, "files");
    assert.equal(dto.readyForReal, false);
    assert.ok(dto.missingForReal.some((item) => /OAuth/.test(item)));
    assert.match(dto.message, /CSV/);
    assert.equal(dto.lastActivityAt, T_MID.toISOString());
  });

  it("API de Google conectada → real y listo; demo → sandbox; error → lastError", () => {
    const api = gbpStatus({ sources: [{ provider: "google", status: "connected", mode: "api", lastRunAt: T_NEW, lastError: null, updatedAt: T_NEW }] });
    assertInvariants(api);
    assert.equal(api.readyForReal, true);
    const demo = gbpStatus({ sources: [{ provider: "demo", status: "connected", mode: "demo", lastRunAt: T_OLD, lastError: null, updatedAt: T_OLD }, { provider: "csv", status: "error", mode: "csv", lastRunAt: null, lastError: "CSV sin cabecera", updatedAt: T_NEW }] });
    assertInvariants(demo);
    assert.equal(demo.mode, "sandbox");
    assert.equal(demo.lastError, "CSV sin cabecera");
  });
});

function verifactu(overrides: Partial<ComplianceIntegrationInput> = {}): ComplianceIntegrationInput {
  return {
    integration: "verifactu",
    enabled: true,
    mode: "sandbox",
    readyForReal: false,
    cert: { configured: false, reason: "Falta la ruta del certificado." },
    software: { ok: false, errors: ["Falta la razón social del productor del software.", "Falta el NIF del productor del software (no el del hotel emisor)."] },
    ...overrides
  };
}

describe("complianceStatus — VeriFactu / SES / TBAI / IGIC", () => {
  it("verifactu sandbox con declaración incompleta → sandbox; los errores del software y la decisión van a missingForReal", () => {
    const dto = complianceStatus("verifactu", verifactu(), { last: { status: "accepted", at: T_MID }, lastFailed: { status: "rejected", at: T_OLD, error: "Huella no válida" } });
    assertInvariants(dto);
    assert.equal(dto.mode, "sandbox");
    assert.match(dto.message, /AEAT/);
    // Corrector L8 (REV-06): sin punto final (el panel une los pendientes con « · »).
    assert.ok(dto.missingForReal.includes("Falta la razón social del productor del software"));
    assert.ok(dto.missingForReal.includes("Falta la ruta del certificado"));
    assert.ok(dto.missingForReal.every((item) => !item.endsWith(".")), dto.missingForReal.join(" | "));
    assert.ok(dto.missingForReal.some((item) => /^Decisión: cambiar el modo/.test(item)));
    assert.equal(dto.missingForReal.length, 4);
    assert.equal(dto.lastActivityAt, T_MID.toISOString());
    assert.equal(dto.lastError, "Huella no válida");
  });

  it("verifactu producción con certificado y software → real y listo; certificado inexistente → no listo", () => {
    const ready = complianceStatus("verifactu", verifactu({ mode: "production", readyForReal: true, cert: { configured: true, certPathExists: true }, software: { ok: true, errors: [] } }));
    assertInvariants(ready);
    assert.equal(ready.mode, "real");
    assert.equal(ready.readyForReal, true);
    assert.match(ready.message, /^Producción/);
    const missingFile = complianceStatus("verifactu", verifactu({ mode: "production", cert: { configured: true, certPathExists: false }, software: { ok: true, errors: [] } }));
    assertInvariants(missingFile);
    assert.equal(missingFile.readyForReal, false);
    assert.deepEqual(missingFile.missingForReal, ["El fichero del certificado no existe en la ruta configurada"]);
    assert.match(missingFile.message, /requisitos pendientes/);
  });

  it("preproducción → real (llega al entorno oficial de pruebas) con la decisión de producción pendiente", () => {
    const dto = complianceStatus("ses", { integration: "ses_hospedajes", enabled: true, mode: "preproduction", readyForReal: true, cert: { configured: true, certPathExists: true } });
    assertInvariants(dto);
    assert.equal(dto.mode, "real");
    assert.deepEqual(dto.missingForReal, ["Decisión: pasar a producción"]);
    assert.match(dto.message, /Ministerio del Interior/);
  });

  it("ses sandbox no dice «enviado»; la actividad simulada sí se muestra", () => {
    const dto = complianceStatus("ses", { integration: "ses_hospedajes", enabled: true, mode: "sandbox", readyForReal: false, cert: { configured: false, reason: "Falta la ruta del certificado." } }, { last: { status: "accepted", at: T_NEW }, lastFailed: { status: "failed", at: T_MID, error: null } });
    assertInvariants(dto);
    assert.equal(dto.mode, "sandbox");
    assert.equal(dto.lastActivityAt, T_NEW.toISOString());
    assert.equal(dto.lastError, "Último envío failed.");
  });

  it("tbai sin territorio foral → none «no aplica»; con territorio y producción → real", () => {
    const off = complianceStatus("tbai", { integration: "tbai", enabled: false, mode: "sandbox", readyForReal: false, cert: { configured: false, reason: "Falta la ruta del certificado." } });
    assertInvariants(off);
    assert.equal(off.mode, "none");
    assert.match(off.message, /No aplica/);
    assert.deepEqual(off.missingForReal, []);
    const on = complianceStatus("tbai", { integration: "tbai", enabled: true, mode: "production", readyForReal: true, cert: { configured: true, certPathExists: true } });
    assertInvariants(on);
    assert.equal(on.readyForReal, true);
  });

  it("sin informe de cumplimiento (consulta fallida) → none sin inventar nada; igic siempre none", () => {
    const missing = complianceStatus("verifactu", null);
    assertInvariants(missing);
    assert.equal(missing.mode, "none");
    assert.match(missing.message, /no disponible/);
    const igic = igicStatus();
    assertInvariants(igic);
    assert.equal(igic.mode, "none");
    assert.match(igic.message, /VeriFactu/);
  });

  // Corrector L8 (REV-01): el interruptor del establecimiento manda sobre el modo del proceso.
  it("interruptor apagado y sin uso → none «Desactivado para este establecimiento» aunque el proceso esté en producción; «Activar …» encabeza los pendientes", () => {
    const off = { flagEnabled: false, usageCount: 0 };
    const ses = complianceStatus("ses", { integration: "ses_hospedajes", enabled: true, mode: "production", readyForReal: true, cert: { configured: true, certPathExists: true } }, { last: { status: "accepted", at: T_OLD }, lastFailed: null }, off);
    assertInvariants(ses);
    assert.equal(ses.mode, "none");
    assert.equal(ses.transport, "none");
    assert.equal(ses.configured, true, "el certificado del proceso sigue siendo un dato");
    assert.match(ses.message, /^Desactivado para este establecimiento y sin envíos en los últimos 180 días/);
    assert.equal(ses.lastActivityAt, null);
    assert.deepEqual(ses.missingForReal, ["Activar SES.Hospedajes para el establecimiento (ajustes de cumplimiento de la propiedad)"]);
    const vf = complianceStatus("verifactu", verifactu(), NO_SUBMISSIONS, off);
    assertInvariants(vf);
    assert.equal(vf.mode, "none");
    assert.match(vf.message, /sin facturas emitidas/);
    assert.equal(vf.missingForReal[0], "Activar VeriFactu para el establecimiento (ajustes de cumplimiento de la propiedad)");
    assert.ok(vf.missingForReal.includes("Falta la ruta del certificado"), "los requisitos del proceso siguen listados");
    assert.ok(vf.missingForReal.some((item) => /^Decisión: cambiar el modo/.test(item)));
    const tbai = complianceStatus("tbai", { integration: "tbai", enabled: true, mode: "sandbox", readyForReal: false, cert: { configured: false, reason: "Falta la ruta del certificado." } }, NO_SUBMISSIONS, off);
    assertInvariants(tbai);
    assert.equal(tbai.mode, "none");
    assert.match(tbai.message, /el establecimiento no declara territorio foral/);
    assert.equal(tbai.missingForReal[0], "Declarar el territorio foral en la ficha del centro");
  });

  it("interruptor apagado pero con uso → conserva el modo del proceso, lo dice en la frase y añade «Activar …» a los pendientes; interruptor encendido → sin cambios", () => {
    const byUsage = complianceStatus("verifactu", verifactu(), { last: { status: "accepted", at: T_NEW }, lastFailed: null }, { flagEnabled: false, usageCount: 24 });
    assertInvariants(byUsage);
    assert.equal(byUsage.mode, "sandbox");
    assert.match(byUsage.message, /Activo solo por uso \(24 facturas emitidas\): el interruptor del establecimiento está apagado\.$/);
    assert.equal(byUsage.missingForReal[0], "Activar VeriFactu para el establecimiento (ajustes de cumplimiento de la propiedad)");
    assert.equal(byUsage.lastActivityAt, T_NEW.toISOString());
    const on = complianceStatus("verifactu", verifactu(), NO_SUBMISSIONS, { flagEnabled: true, usageCount: 0 });
    const ungated = complianceStatus("verifactu", verifactu(), NO_SUBMISSIONS);
    assert.deepEqual(on, ungated, "con el interruptor encendido el DTO es el de siempre");
    assert.ok(!on.missingForReal.some((item) => /^Activar/.test(item)));
    assert.doesNotMatch(on.message, /Activo solo por uso/);
    const sesUsage = complianceStatus("ses", { integration: "ses_hospedajes", enabled: true, mode: "sandbox", readyForReal: false, cert: { configured: false, reason: "Falta la ruta del certificado." } }, NO_SUBMISSIONS, { flagEnabled: false, usageCount: 1 });
    assert.match(sesUsage.message, /1 envío en los últimos 180 días/);
  });

  it("complianceGates (pura): properties ∪ property_compliance_settings; sin fila de propiedad o con uso sin dato e interruptor apagado no se gatea", () => {
    assert.deepEqual(complianceGates({ property: null, settings: null, sesUsage: 0, issuedInvoices: 0 }), { ses: null, verifactu: null, tbai: null });
    const flags = { sesHospedajesEnabled: false, verifactuEnabled: false, fiscalTerritory: "bizkaia" };
    assert.deepEqual(complianceGates({ property: flags, settings: { sesHospedajesEnabled: true, verifactuEnabled: false }, sesUsage: 0, issuedInvoices: 5 }), {
      ses: { flagEnabled: true, usageCount: 0 },
      verifactu: { flagEnabled: false, usageCount: 5 },
      tbai: { flagEnabled: true, usageCount: 0 }
    });
    assert.deepEqual(complianceGates({ property: { ...flags, fiscalTerritory: null }, settings: null, sesUsage: null, issuedInvoices: null }), {
      ses: null,
      verifactu: null,
      tbai: { flagEnabled: false, usageCount: 0 }
    });
    assert.deepEqual(complianceGates({ property: { ...flags, verifactuEnabled: true }, settings: null, sesUsage: null, issuedInvoices: null }).verifactu, { flagEnabled: true, usageCount: 0 }, "interruptor encendido: aplica aunque el uso no tenga dato");
  });
});

describe("storageStatus — almacén de documentos", () => {
  it("unconfigured → none; inline/disk → sandbox local; s3 → real «configurado, no comprobado» (no listo)", () => {
    const none = storageStatus({ kind: "unconfigured" });
    assertInvariants(none);
    assert.equal(none.mode, "none");
    const inline = storageStatus({ kind: "inline" });
    assertInvariants(inline);
    assert.equal(inline.mode, "sandbox");
    assert.equal(inline.transport, "none");
    const disk = storageStatus({ kind: "disk" });
    assertInvariants(disk);
    assert.equal(disk.mode, "sandbox");
    assert.equal(disk.transport, "files");
    const s3 = storageStatus({ kind: "s3" });
    assertInvariants(s3);
    assert.equal(s3.mode, "real");
    assert.equal(s3.configured, true);
    assert.equal(s3.readyForReal, false);
    assert.match(s3.message, /configurado, no comprobado/);
    assert.equal(s3.missingForReal.length, 1);
  });
});

describe("aiStatus / sentryStatus / redisStatus — plataforma", () => {
  it("ia: provider none → none; declarado sin clave → none con el motivo; configurado → real", () => {
    const none = aiStatus({ provider: "none", configured: false, reason: "not_configured" });
    assertInvariants(none);
    assert.equal(none.mode, "none");
    assert.equal(none.configured, false);
    const declared = aiStatus({ provider: "anthropic", configured: false, reason: "not_configured" });
    assertInvariants(declared);
    assert.equal(declared.mode, "none");
    assert.equal(declared.configured, true);
    assert.match(declared.message, /falta la clave/);
    const real = aiStatus({ provider: "anthropic", configured: true });
    assertInvariants(real);
    assert.equal(real.readyForReal, true);
  });

  it("sentry: sin DSN → none; con DSN → real y listo; sin pantalla", () => {
    const off = sentryStatus({ configured: false });
    assertInvariants(off);
    assert.equal(off.mode, "none");
    assert.equal(off.screen, null);
    const on = sentryStatus({ configured: true });
    assertInvariants(on);
    assert.equal(on.readyForReal, true);
  });

  it("redis configurado sin consumidor → none pero configured (dato honesto); con consumidor → real", () => {
    const orphan = redisStatus({ configured: true, consumerCount: 0 });
    assertInvariants(orphan);
    assert.equal(orphan.mode, "none");
    assert.equal(orphan.configured, true);
    assert.match(orphan.message, /ningún componente del API la usa/);
    assert.equal(orphan.missingForReal.length, 1);
    const off = redisStatus({ configured: false, consumerCount: 0 });
    assertInvariants(off);
    assert.equal(off.configured, false);
    assert.equal(off.missingForReal.length, 2);
    const used = redisStatus({ configured: true, consumerCount: 2 });
    assertInvariants(used);
    assert.equal(used.mode, "real");
    assert.equal(used.readyForReal, true);
  });
});

const HEALTH_INPUTS: IntegrationsHealthInputs = {
  channelMaxMode: "sandbox",
  whatsapp: { configured: false, webhookMode: "refused", production: false },
  sms: { configured: false, production: false },
  emailOut: { configured: false, provider: null, mode: "simulated" },
  emailIn: { gmail: { configured: false }, microsoft: { configured: false }, imap: { configured: false }, manual: { configured: true } },
  compliance: [
    verifactu(),
    { integration: "ses_hospedajes", enabled: true, mode: "sandbox", readyForReal: false, cert: { configured: false, reason: "Falta la ruta del certificado." } },
    { integration: "tbai", enabled: false, mode: "sandbox", readyForReal: false, cert: { configured: false, reason: "Falta la ruta del certificado." } },
    { integration: "igic", enabled: false, mode: "sandbox", readyForReal: false, cert: { configured: false, reason: "No aplica." } }
  ],
  storage: "inline",
  ai: { provider: "none", configured: false, reason: "not_configured" },
  sentryConfigured: false,
  redisConfigured: true
};

describe("describeIntegrationsHealth — bloque público sin BD", () => {
  it("cubre exactamente las claves sin BD (nunca opera / sage200 / psp / gbp) con modo válido y frase segura", () => {
    const block = describeIntegrationsHealth(HEALTH_INPUTS);
    assert.deepEqual(Object.keys(block).sort(), [...INTEGRATION_HEALTH_KEYS].sort());
    assert.equal(INTEGRATION_HEALTH_KEYS.length, 14);
    for (const forbidden of ["opera", "sage200", "psp", "gbp"]) assert.ok(!(forbidden in block), `${forbidden} exige BD`);
    for (const [key, entry] of Object.entries(block)) {
      assert.ok((INTEGRATION_MODES as readonly string[]).includes(entry!.mode), key);
      assert.doesNotMatch(entry!.message, URL_OR_ENDPOINT, key);
      assert.doesNotMatch(entry!.message, SECRET_VAR_NAME, key);
      assert.ok(entry!.message.length > 0 && entry!.message.length <= 260, `${key}: frase corta`);
      if (entry!.mode === "sandbox") assert.doesNotMatch(entry!.message, SAYS_SENT, key);
    }
  });

  it("tbai en /health habla del modo del proceso: con el lector sin organización (enabled) añade que aplica solo a establecimientos forales; sin foral en la organización sigue «No aplica»", () => {
    const process = describeIntegrationsHealth({ ...HEALTH_INPUTS, compliance: HEALTH_INPUTS.compliance.map((entry) => (entry.integration === "tbai" ? { ...entry, enabled: true } : entry)) });
    assert.equal(process.tbai?.mode, "sandbox");
    assert.match(process.tbai!.message, /^Modo de pruebas local: ningún fichero TicketBAI se envía a las haciendas forales; las respuestas son simuladas\. Aplica solo a los establecimientos con territorio foral; el modo efectivo se lee por propiedad\.$/);
    assert.ok(process.tbai!.message.length <= 260);
    const org = describeIntegrationsHealth(HEALTH_INPUTS);
    assert.equal(org.tbai?.mode, "none");
    assert.match(org.tbai!.message, /^No aplica: ninguna propiedad declara territorio foral/);
    assert.doesNotMatch(org.tbai!.message, /por propiedad/);
  });

  it("refleja el entorno del carril: todo sandbox/none, redis configurado sin consumidor = none, verifactu sandbox sin volcar los errores del software", () => {
    const block = describeIntegrationsHealth(HEALTH_INPUTS);
    assert.equal(block.redis?.mode, "none");
    assert.match(block.redis?.message ?? "", /ningún componente/);
    assert.equal(block.verifactu?.mode, "sandbox");
    assert.doesNotMatch(block.verifactu?.message ?? "", /razón social/);
    assert.equal(block.channels?.mode, "sandbox");
    assert.equal(block.email_in?.mode, "none");
    assert.equal(block.tbai?.mode, "none");
    assert.equal(block.igic?.mode, "none");
    assert.equal(block.storage?.mode, "sandbox");
    assert.equal(block.gestoria_export?.mode, "real");
    assert.equal(block.ai?.mode, "none");
    assert.equal(block.sentry?.mode, "none");
    const modes = Object.values(block).map((entry) => entry!.mode);
    assert.ok(!modes.includes("real") || modes.filter((mode) => mode === "real").length === 1, "solo la exportación manual es real en el carril");
  });

  it("tope real + OAuth configurado → canales real (tope) y correo entrante real (por propiedad)", () => {
    const block = describeIntegrationsHealth({ ...HEALTH_INPUTS, channelMaxMode: "real", emailIn: { ...HEALTH_INPUTS.emailIn, gmail: { configured: true } } });
    assert.equal(block.channels?.mode, "real");
    assert.match(block.channels?.message ?? "", /por propiedad/);
    assert.equal(block.email_in?.mode, "real");
    assert.match(block.email_in?.message ?? "", /Google/);
  });
});

// ───────────────────────────────────────────────── colector con stubs

type Stub = IntegrationsStatusDb & { calls: string[] };

function stubDb(overrides: Partial<Record<keyof IntegrationsStatusDb, unknown>> = {}): Stub {
  const calls: string[] = [];
  const delivery = async (args: { where: Record<string, unknown> }) => {
    calls.push(`delivery:${String(args.where.channel)}`);
    const where = args.where;
    if (where.status === "failed") return null;
    if (where.errorMessage && typeof where.errorMessage === "object") return where.channel === "email" ? { createdAt: T_MID, sentAt: T_MID, errorMessage: "SIMULADO: sin proveedor" } : null;
    return null;
  };
  const submission = (label: string) => async (args: { where: Record<string, unknown> }) => {
    calls.push(`${label}:${args.where.status ? "failed" : "last"}`);
    if (args.where.status) return label === "ses" ? { status: "failed", updatedAt: T_OLD, errorMessage: "Establecimiento incompleto" } : null;
    return { status: "accepted", updatedAt: T_NEW, errorMessage: null };
  };
  const base = {
    calls,
    // REV-01: interruptores de la propiedad y uso (SES apagado con 3 envíos recientes → activo por uso; VeriFactu encendido; sin territorio foral).
    property: { findUnique: async (args: { where: { id: string } }) => { calls.push(`property:${args.where.id}`); return { sesHospedajesEnabled: false, verifactuEnabled: true, fiscalTerritory: null }; } },
    propertyComplianceSetting: { findUnique: async () => null },
    invoice: { count: async (args: { where: Record<string, unknown> }) => { calls.push(`invoices:${JSON.stringify(args.where.status)}`); return 12; } },
    pmsShadowProfile: { findFirst: async () => ({ status: "active", updatedAt: T_OLD }) },
    pmsShadowRun: { findFirst: async () => ({ status: "done", source: "api_key", createdAt: T_MID, errorMessage: null }) },
    developerApp: { count: async (args: { where: Record<string, unknown> }) => { calls.push(`apps:${JSON.stringify(args.where.scopes)}`); return 1; } },
    emailConnection: { findMany: async () => [{ provider: "gmail", status: "connected", configJson: { purpose: "pms_shadow" }, lastSyncAt: T_MID, lastError: null, updatedAt: T_MID }] },
    ledgerImport: {
      count: async (args: { where: Record<string, unknown> }) => (args.where.status === "posted" ? 50 : 51),
      findFirst: async () => ({ status: "draft", createdAt: T_NEW, postedAt: null })
    },
    channel: { findMany: async () => [{ providerCode: "booking_com", mode: "sandbox", status: "active", lastSyncAt: T_OLD }] },
    reviewSource: { findMany: async () => [{ provider: "csv", status: "connected", mode: "csv", lastRunAt: T_OLD, lastError: null, updatedAt: T_OLD }] },
    verifactuSubmission: { findFirst: submission("verifactu") },
    sesHospedajesSubmission: { findFirst: submission("ses"), count: async (args: { where: { createdAt?: { gte?: Date } } }) => { calls.push(`sesUsage:${args.where.createdAt?.gte?.toISOString()}`); return 3; } },
    notificationDelivery: { findFirst: delivery },
    ...overrides
  };
  return base as unknown as Stub;
}

function stubDeps(): IntegrationsStatusDeps & { seenEnv: NodeJS.ProcessEnv[] } {
  const seenEnv: NodeJS.ProcessEnv[] = [];
  return {
    seenEnv,
    readChannelEnv: () => ({ maxMode: "sandbox" }),
    aiConfigSummary: () => ({ provider: "none", configured: false, reason: "not_configured" }),
    emailProvidersStatus: () => ({ gmail: { configured: true }, microsoft: { configured: false }, imap: { configured: false }, manual: { configured: true } }),
    emailStatus: (env) => { seenEnv.push(env); return { configured: false, provider: null, mode: env.NODE_ENV === "production" ? "disabled" : "simulated" }; },
    isWhatsappConfigured: () => false,
    isSmsConfigured: () => false,
    unsignedWebhookMode: (env) => { seenEnv.push(env); return "refused"; },
    pspStatusFor: async () => ({ configured: true, provider: "stripe", mode: "test", webhookSecretConfigured: false }),
    getComplianceHealth: async () => ({ integrations: HEALTH_INPUTS.compliance }),
    describeDocumentStorageHealth: () => "inline"
  };
}

describe("collectIntegrationsStatus — colector con Prisma y lectores sustituidos", () => {
  it("devuelve las 18 integraciones en el orden del catálogo, con los invariantes, sin process.env (usa el env inyectado)", async () => {
    const db = stubDb();
    const deps = stubDeps();
    const env = { NODE_ENV: "development" } as NodeJS.ProcessEnv;
    const result = await collectIntegrationsStatus({ organizationId: "org_test", propertyId: "prop_test", sentryConfigured: false, redisConfigured: true, env, now: T_NEW, db, deps });
    assert.equal(result.propertyId, "prop_test");
    assert.equal(result.generatedAt, T_NEW.toISOString());
    assert.deepEqual(result.degraded, []);
    assert.deepEqual(result.integrations.map((dto) => dto.key), [...INTEGRATION_KEYS]);
    for (const dto of result.integrations) assertInvariants(dto);
    assert.ok(deps.seenEnv.length >= 2 && deps.seenEnv.every((seen) => seen === env), "los lectores reciben el env inyectado");
    const byKey = Object.fromEntries(result.integrations.map((dto) => [dto.key, dto]));
    assert.equal(byKey.opera!.mode, "real");
    assert.equal(byKey.opera!.readyForReal, true);
    assert.equal(byKey.opera!.lastActivityAt, T_MID.toISOString());
    assert.match(byKey.opera!.message, /1 aplicación con clave de ingest y 1 buzón de correo/);
    assert.ok(db.calls.includes('apps:{"has":"pms.shadow.ingest"}'));
    assert.equal(byKey.sage200!.mode, "real");
    assert.match(byKey.sage200!.message, /51 lotes importados .* 50 contabilizados/);
    assert.equal(byKey.channels!.mode, "sandbox");
    assert.equal(byKey.psp!.mode, "sandbox");
    assert.equal(byKey.whatsapp!.mode, "sandbox");
    assert.equal(byKey.whatsapp!.lastActivityAt, null, "sin entregas de whatsapp");
    assert.equal(byKey.email_out!.mode, "sandbox");
    assert.equal(byKey.email_out!.lastActivityAt, T_MID.toISOString(), "última entrega SIMULADO de correo");
    assert.equal(byKey.email_in!.mode, "real");
    assert.equal(byKey.email_in!.readyForReal, true);
    assert.equal(byKey.gbp!.mode, "real");
    assert.equal(byKey.gbp!.transport, "files");
    assert.equal(byKey.ses!.mode, "sandbox");
    assert.equal(byKey.ses!.lastActivityAt, T_NEW.toISOString());
    assert.equal(byKey.ses!.lastError, "Establecimiento incompleto");
    // REV-01: interruptor SES apagado con 3 envíos en la ventana → activo por uso; la ventana se calcula desde `now`.
    assert.match(byKey.ses!.message, /Activo solo por uso \(3 envíos en los últimos 180 días\)/);
    assert.match(byKey.ses!.missingForReal[0]!, /^Activar SES\.Hospedajes para el establecimiento/);
    assert.ok(db.calls.includes("property:prop_test"));
    assert.ok(db.calls.includes(`sesUsage:${new Date(T_NEW.getTime() - 180 * 24 * 60 * 60 * 1000).toISOString()}`), db.calls.join(","));
    assert.ok(db.calls.includes('invoices:{"in":["issued","cancelled","rectified"]}'));
    assert.equal(byKey.verifactu!.mode, "sandbox");
    assert.equal(byKey.verifactu!.lastError, null);
    assert.ok(!byKey.verifactu!.missingForReal.some((item) => /^Activar/.test(item)), "interruptor VeriFactu encendido: sin pendiente de activación");
    assert.equal(byKey.tbai!.mode, "none");
    assert.match(byKey.tbai!.message, /el establecimiento no declara territorio foral/);
    assert.equal(byKey.igic!.mode, "none");
    assert.equal(byKey.storage!.mode, "sandbox");
    assert.equal(byKey.ai!.mode, "none");
    assert.equal(byKey.sentry!.mode, "none");
    assert.equal(byKey.redis!.mode, "none");
    assert.equal(byKey.redis!.configured, true);
  });

  it("interruptores apagados y sin uso → ses y verifactu none «Desactivado para este establecimiento»; territorio foral en la ficha → tbai sigue el modo del proceso", async () => {
    const db = stubDb({
      property: { findUnique: async () => ({ sesHospedajesEnabled: false, verifactuEnabled: false, fiscalTerritory: "gipuzkoa" }) },
      invoice: { count: async () => 0 },
      sesHospedajesSubmission: { findFirst: async () => null, count: async () => 0 }
    });
    const compliance = HEALTH_INPUTS.compliance.map((entry) => (entry.integration === "tbai" ? { ...entry, enabled: true } : entry));
    const deps = { ...stubDeps(), getComplianceHealth: async () => ({ integrations: compliance }) };
    const result = await collectIntegrationsStatus({ organizationId: "org_test", propertyId: "prop_test", sentryConfigured: false, redisConfigured: false, env: { NODE_ENV: "development" } as NodeJS.ProcessEnv, now: T_NEW, db, deps });
    assert.deepEqual(result.degraded, []);
    for (const dto of result.integrations) assertInvariants(dto);
    const byKey = Object.fromEntries(result.integrations.map((dto) => [dto.key, dto]));
    assert.equal(byKey.ses!.mode, "none");
    assert.match(byKey.ses!.message, /^Desactivado para este establecimiento/);
    assert.equal(byKey.ses!.lastActivityAt, null);
    assert.equal(byKey.verifactu!.mode, "none");
    assert.match(byKey.verifactu!.message, /^Desactivado para este establecimiento y sin facturas emitidas/);
    assert.equal(byKey.tbai!.mode, "sandbox");
    assert.doesNotMatch(byKey.tbai!.message, /por propiedad/, "la nota de proceso es solo de /health");
  });

  it("sin fila de propiedad (consulta fallida) no se gatea: ses/verifactu conservan el modo del proceso y `property` queda en degraded", async () => {
    const db = stubDb({ property: { findUnique: async () => { throw new Error("timeout"); } } });
    const warn = console.warn;
    console.warn = () => {};
    try {
      const result = await collectIntegrationsStatus({ organizationId: "org_test", propertyId: "prop_test", sentryConfigured: false, redisConfigured: false, env: { NODE_ENV: "development" } as NodeJS.ProcessEnv, now: T_NEW, db, deps: stubDeps() });
      assert.deepEqual(result.degraded, ["property"]);
      const byKey = Object.fromEntries(result.integrations.map((dto) => [dto.key, dto]));
      assert.equal(byKey.ses!.mode, "sandbox");
      assert.doesNotMatch(byKey.ses!.message, /Activo solo por uso/);
      assert.equal(byKey.verifactu!.mode, "sandbox");
      assert.equal(byKey.tbai!.mode, "none");
      assert.match(byKey.tbai!.message, /ninguna propiedad declara territorio foral/, "sin dato de la propiedad vale la lectura de la organización");
    } finally {
      console.warn = warn;
    }
  });

  it("producción inyectada → las salidas sin credenciales son none (fallan), nunca sandbox", async () => {
    const result = await collectIntegrationsStatus({ organizationId: "org_test", propertyId: "prop_test", sentryConfigured: true, redisConfigured: false, env: { NODE_ENV: "production" } as NodeJS.ProcessEnv, db: stubDb(), deps: stubDeps() });
    const byKey = Object.fromEntries(result.integrations.map((dto) => [dto.key, dto]));
    assert.equal(byKey.whatsapp!.mode, "none");
    assert.equal(byKey.sms!.mode, "none");
    assert.equal(byKey.email_out!.mode, "none");
    assert.equal(byKey.sentry!.mode, "real");
    assert.equal(byKey.redis!.configured, false);
  });

  it("una consulta que falla degrada esa integración a «sin datos» y la lista en degraded (nunca un éxito)", async () => {
    const db = stubDb({
      pmsShadowProfile: { findFirst: async () => { throw new Error("connection refused"); } },
      ledgerImport: { count: async () => { throw new Error("timeout"); }, findFirst: async () => null }
    });
    const deps = { ...stubDeps(), getComplianceHealth: async () => { throw new Error("compliance down"); } };
    const warn = console.warn;
    console.warn = () => {};
    try {
      const result = await collectIntegrationsStatus({ organizationId: "org_test", propertyId: "prop_test", sentryConfigured: false, redisConfigured: false, env: {} as NodeJS.ProcessEnv, db, deps });
      assert.deepEqual([...result.degraded].sort(), ["compliance", "ledgerImports", "ledgerImportsPosted", "pmsShadowProfile"]);
      const byKey = Object.fromEntries(result.integrations.map((dto) => [dto.key, dto]));
      assert.equal(byKey.opera!.mode, "none");
      assert.equal(byKey.sage200!.mode, "none");
      assert.equal(byKey.verifactu!.mode, "none");
      assert.match(byKey.verifactu!.message, /no disponible/);
      assert.equal(byKey.ses!.mode, "none");
      for (const dto of result.integrations) assertInvariants(dto);
    } finally {
      console.warn = warn;
    }
  });
});
