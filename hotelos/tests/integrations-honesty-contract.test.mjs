// Tanda L8 · lote L8-08 — contrato de honestidad de las integraciones (fuente,
// sin base de datos). Fija modo ↔ comportamiento sobre el árbol:
//   · cada IntegrationKey del contrato compartido (packages/shared) tiene su
//     descriptor en integrations-status.service.ts (una función *Status en el
//     colector, en el orden de INTEGRATION_KEYS), su fila en el runbook §1 y su
//     entrada en docs/api-contracts.md; el bloque /health lleva exactamente las
//     14 claves sin propiedad (INTEGRATION_HEALTH_KEYS);
//   · las reglas fijas del DTO viven en finalizeIntegrationStatus: readyForReal
//     ≡ real && sin pendientes, mode none ⇒ lastActivityAt null;
//   · el bloque /health de server.ts llama a describeIntegrationsHealth y no
//     lee variables secretas ni escribe «http» (la ruta es pública);
//   · un modo none / sandbox nunca simula un resultado real: el registro PSP
//     sandbox solo entra por setPspRegistry (nunca por variable), el webhook de
//     WhatsApp sin secreto responde «refused» en producción, los tres
//     proveedores de notificaciones devuelven `simulated: true` fuera de
//     producción y `failed` en producción, el tope de canales nace en sandbox,
//     IMAP se declara no configurado, el hub heredado responde «simulated» a
//     la prueba de conexión (nunca ok);
//   · el front deriva el resultado de un envío con deliveryOutcome y la pantalla
//     de pagos ya no lee el `gatewayReady` del hub heredado.
// Ejecutar: node --test tests/integrations-honesty-contract.test.mjs
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFileSync(join(ROOT, relative), "utf8");

const sharedTypes = read("packages/shared/src/integrations-status-types.ts");
const statusService = read("apps/api/src/modules/integrations/integrations-status.service.ts");
const statusRoutes = read("apps/api/src/modules/integrations/integrations-status.routes.ts");
const server = read("apps/api/src/server.ts");
const runbook = read("docs/runbooks/integraciones.md");
const apiContracts = read("docs/api-contracts.md");
const pspIndex = read("apps/api/src/modules/payments/psp/index.ts");
const whatsappWebhook = read("apps/api/src/routes/webhooks-whatsapp.routes.ts");
const emailProvider = read("apps/api/src/modules/notifications/providers/email.provider.ts");
const smsProvider = read("apps/api/src/modules/notifications/providers/sms.provider.ts");
const whatsappProvider = read("apps/api/src/modules/notifications/providers/whatsapp.provider.ts");
const channelEnv = read("apps/api/src/modules/channel-manager/env.partial.ts");
const emailReservation = read("apps/api/src/modules/integrations/email/email-reservation.service.ts");
const legacyHub = read("apps/api/src/modules/integrations/integrations.service.ts");
const notificationsScreen = read("apps/admin-web/src/screens/notifications/NotificationsScreen.tsx");
const deliveryOutcome = read("apps/admin-web/src/screens/notifications/delivery-outcome.ts");
const paymentSettings = read("apps/admin-web/src/screens/PaymentSettings.tsx");
const statusHelpers = read("apps/admin-web/src/screens/integrations/integrations-status-helpers.ts");

/** Literales de un `export const NAME = [ "a", "b" ] as const;` (sin evaluar TypeScript). */
function stringArrayConst(source, name) {
  const match = source.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`));
  assert.ok(match, `${name} no está declarado como array de literales as const`);
  return [...match[1].matchAll(/"([a-z0-9_]+)"/g)].map((entry) => entry[1]);
}

/** Bloque de código entre dos marcadores (el primero incluido; el segundo excluido). */
function between(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `marcador «${start}» ausente`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `marcador «${end}» ausente tras «${start}»`);
  return source.slice(from, to);
}

/** Valores de un `Record<IntegrationMode, string>` congelado: { none: "…", sandbox: "…", real: "…" }. */
function modeLabelRecord(source, name) {
  const block = between(source, `${name}: Readonly<Record<IntegrationMode, string>> = Object.freeze({`, "});");
  const labels = {};
  for (const entry of block.matchAll(/^\s*(none|sandbox|real): "([^"]+)"/gm)) labels[entry[1]] = entry[2];
  return labels;
}

/** Ficheros .ts del API fuera de __tests__ (para comprobar que nadie importa el registro sandbox). */
function apiSourceFiles(dir = join(ROOT, "apps/api/src")) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== "__tests__" && entry !== "node_modules") files.push(...apiSourceFiles(path));
    } else if (entry.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

const INTEGRATION_KEYS = stringArrayConst(sharedTypes, "INTEGRATION_KEYS");
const INTEGRATION_MODES = stringArrayConst(sharedTypes, "INTEGRATION_MODES");
const HEALTH_EXCLUDED = ["opera", "sage200", "psp", "gbp"];
const HEALTH_KEYS = INTEGRATION_KEYS.filter((key) => !HEALTH_EXCLUDED.includes(key));

/** Descriptor (función del servicio) que produce cada clave dentro del colector collectIntegrationsStatus. */
const DESCRIPTOR_OF = {
  opera: "operaStatus(",
  sage200: "sage200Status(",
  gestoria_export: "gestoriaExportStatus(",
  channels: "channelsStatus(",
  psp: "pspStatus(",
  whatsapp: "whatsappStatus(",
  email_out: "emailOutStatus(",
  sms: "smsStatus(",
  email_in: "emailInStatus(",
  gbp: "gbpStatus(",
  ses: 'complianceStatus("ses"',
  verifactu: 'complianceStatus("verifactu"',
  tbai: 'complianceStatus("tbai"',
  igic: "igicStatus(",
  storage: "storageStatus(",
  ai: "aiStatus(",
  sentry: "sentryStatus(",
  redis: "redisStatus("
};

describe("L8-08 · contrato compartido (packages/shared/src/integrations-status-types.ts)", () => {
  it("el vocabulario de modos es exactamente none | sandbox | real y hay 18 claves sin repetir", () => {
    assert.deepEqual(INTEGRATION_MODES, ["none", "sandbox", "real"]);
    assert.equal(INTEGRATION_KEYS.length, 18);
    assert.equal(new Set(INTEGRATION_KEYS).size, INTEGRATION_KEYS.length);
    assert.deepEqual(Object.keys(DESCRIPTOR_OF), INTEGRATION_KEYS, "el mapa clave → descriptor de este contrato sigue el orden de INTEGRATION_KEYS");
  });

  it("cada clave tiene etiqueta y pantalla declaradas en el contrato y los tres diccionarios se exportan congelados", () => {
    for (const key of INTEGRATION_KEYS) {
      assert.match(sharedTypes, new RegExp(`^\\s{2}${key}: "[^"]+",?$`, "m"), `${key}: sin etiqueta INTEGRATION_LABELS_ES`);
      assert.match(sharedTypes, new RegExp(`^\\s{2}${key}: ("/[^"]+"|null),?$`, "m"), `${key}: sin pantalla INTEGRATION_SCREENS`);
    }
    for (const name of ["INTEGRATION_LABELS_ES", "INTEGRATION_SCREENS", "INTEGRATION_MODE_LABELS_ES"]) {
      assert.match(sharedTypes, new RegExp(`export const ${name}: Readonly<Record<[A-Za-z]+, [a-z| ]+>> = Object\\.freeze\\(`), `${name} no se exporta congelado`);
    }
    assert.match(sharedTypes, /readyForReal — SOLO true cuando mode === "real" y missingForReal está\s+\/\/\s+vacío/, "el contrato documenta la regla readyForReal");
  });

  it("las etiquetas de modo del panel (admin-web) son las mismas frases que INTEGRATION_MODE_LABELS_ES", () => {
    const shared = modeLabelRecord(sharedTypes, "export const INTEGRATION_MODE_LABELS_ES");
    const front = modeLabelRecord(statusHelpers, "export const MODE_LABELS");
    assert.deepEqual(Object.keys(shared).sort(), ["none", "real", "sandbox"]);
    assert.deepEqual(front, shared);
  });
});

describe("L8-08 · descriptores del servicio (integrations-status.service.ts)", () => {
  const collector = between(statusService, "const integrations: IntegrationStatusDto[] = [", "];");

  it("cada IntegrationKey tiene su descriptor en el colector, en el orden de INTEGRATION_KEYS, sin sobrantes", () => {
    let cursor = -1;
    for (const key of INTEGRATION_KEYS) {
      const descriptor = DESCRIPTOR_OF[key];
      const at = collector.indexOf(descriptor, cursor + 1);
      assert.notEqual(at, -1, `${key}: el colector no llama a ${descriptor} (o no en el orden de INTEGRATION_KEYS)`);
      cursor = at;
    }
    // Una entrada por línea del array (4 espacios): los lectores anidados (deps.emailProvidersStatus()) no cuentan.
    const calls = [...collector.matchAll(/^\s{4}([a-zA-Z0-9]+Status)\(/gm)].map((entry) => entry[1]);
    assert.equal(calls.length, INTEGRATION_KEYS.length, `el colector produce ${calls.length} entradas y el contrato tiene ${INTEGRATION_KEYS.length} claves`);
  });

  it("cada clave llega a finalizeIntegrationStatus (directamente o por complianceStatus) con su literal", () => {
    for (const key of INTEGRATION_KEYS) {
      const direct = statusService.includes(`finalizeIntegrationStatus("${key}"`);
      const compliance = statusService.includes(`complianceStatus("${key}"`);
      assert.ok(direct || compliance, `${key}: ningún finalizeIntegrationStatus("${key}") ni complianceStatus("${key}")`);
    }
    assert.match(statusService, /export function complianceStatus\(key: ComplianceKey,[\s\S]*?finalizeIntegrationStatus\(key,/, "complianceStatus delega en finalizeIntegrationStatus con la clave recibida");
  });

  it("finalizeIntegrationStatus aplica las reglas fijas: readyForReal ≡ real && sin pendientes; none ⇒ sin actividad; sin duplicados", () => {
    const finalize = between(statusService, "export function finalizeIntegrationStatus(", "\n}\n");
    assert.match(finalize, /readyForReal: mode === "real" && missing\.length === 0,/);
    assert.match(finalize, /lastActivityAt: mode === "none" \? null : \(draft\.lastActivityAt\?\.toISOString\(\) \?\? null\),/);
    assert.match(finalize, /new Set\(draft\.missingForReal/, "missingForReal se deduplica");
    assert.match(finalize, /label: INTEGRATION_LABELS_ES\[key\],/);
    assert.match(finalize, /screen: INTEGRATION_SCREENS\[key\]/);
  });

  it("describeIntegrationsHealth devuelve exactamente las 14 claves sin propiedad (INTEGRATION_HEALTH_KEYS) en el orden del contrato", () => {
    assert.match(statusService, /INTEGRATION_KEYS\.filter\(\(key\) => key !== "opera" && key !== "sage200" && key !== "psp" && key !== "gbp"\)/);
    const health = between(statusService, "export function describeIntegrationsHealth(", "\n}\n");
    const returned = between(health, "  return {\n", "\n  };");
    const keys = [...returned.matchAll(/^\s{4}([a-z_]+): /gm)].map((entry) => entry[1]);
    assert.deepEqual(keys, HEALTH_KEYS);
    assert.equal(keys.length, 14);
    for (const key of HEALTH_EXCLUDED) assert.equal(keys.includes(key), false, `${key} depende de la propiedad: no va en /health`);
  });

  it("el servicio no lee process.env ni construye mensajes con URLs (los lectores existentes llegan como dependencias)", () => {
    assert.doesNotMatch(statusService, /process\.env\.[A-Z]/, "el servicio no lee variables por su cuenta");
    assert.doesNotMatch(statusService, /https?:\/\//, "ninguna URL literal en las frases del servicio");
    for (const reader of ["readChannelEnv", "aiConfigSummary", "emailProvidersStatus", "emailStatus", "isWhatsappConfigured", "isSmsConfigured", "unsignedWebhookMode", "pspStatusFor", "getComplianceHealth", "describeDocumentStorageHealth"]) {
      assert.match(statusService, new RegExp(`^\\s{2}${reader}[,:]`, "m"), `${reader} no forma parte de defaultDeps`);
    }
  });
});

describe("L8-08 · superficie HTTP: /health y GET /integrations/status (server.ts)", () => {
  const healthBlock = between(server, 'app.get("/health"', 'app.get("/metrics"');

  it("el bloque /health llama a describeIntegrationsHealth con los lectores existentes y cuelga `integrations` como clave superior", () => {
    assert.match(healthBlock, /const integrations = describeIntegrationsHealth\(\{/);
    for (const reader of ["readChannelEnv().maxMode", "isWhatsappConfigured()", "unsignedWebhookMode(process.env)", "isSmsConfigured()", "emailStatus()", "emailProvidersStatus()", "describeDocumentStorageHealth()", "aiConfigSummary()"]) {
      assert.ok(healthBlock.includes(reader), `/health no usa ${reader}`);
    }
    assert.match(healthBlock, /^\s+integrations,?$/m, "la respuesta de /health lleva la clave superior `integrations`");
    assert.doesNotMatch(healthBlock, /checks\.integrations\s*=/, "integrations nunca es un check: none/sandbox no degrada status");
  });

  it("el bloque /health no consulta la base de datos: VeriFactu / SES / TBAI salen de describeComplianceEnvironment() (solo entorno), nunca de getComplianceHealth() sin organización (corrector L8 · REV-03)", () => {
    assert.match(healthBlock, /complianceIntegrations = describeComplianceEnvironment\(\);/);
    assert.doesNotMatch(healthBlock, /getComplianceHealth\(/, "getComplianceHealth() sin organizationId lee las propiedades de todos los tenants");
    const complianceHealth = read("apps/api/src/modules/compliance/compliance-health.service.ts");
    const environment = between(complianceHealth, "export function describeComplianceEnvironment(", "\n}\n");
    assert.doesNotMatch(environment, /prisma\.|await /, "los lectores solo-configuración no tocan Prisma");
    assert.match(environment, /getTbaiHealth\(null\)/, "TBAI se declara por el modo del proceso; el territorio foral se evalúa por propiedad");
  });

  it("el bloque /health es público: no lee variables secretas (KEY|SECRET|TOKEN|DSN|PASSPHRASE|PASSWORD) ni escribe «http»", () => {
    assert.doesNotMatch(healthBlock, /process\.env\.[A-Z0-9_]*(KEY|SECRET|TOKEN|DSN|PASSPHRASE|PASSWORD)\b/);
    assert.doesNotMatch(healthBlock, /http/i);
    assert.doesNotMatch(healthBlock, /process\.env\.REDIS_URL/, "la dirección de Redis no se lee dentro de /health: llega como sentryConfigured / redisConfigured");
  });

  it("Sentry y Redis se derivan una sola vez («hay valor y no es change-me») y llegan a /health y a la ruta de estado", () => {
    assert.match(server, /const isConfiguredValue = \(value: string \| undefined\): boolean => Boolean\(value && value !== "change-me"\);/);
    assert.match(server, /sentryConfigured: isConfiguredValue\(process\.env\.SENTRY_DSN\),\s+redisConfigured: isConfiguredValue\(process\.env\.REDIS_URL\)/);
    assert.match(server, /registerIntegrationsStatusRoutes\(app, \{ platform: platformIntegrationsConfigured \}\);/);
    assert.match(statusRoutes, /app\.get\("\/integrations\/status"/);
    assert.match(statusRoutes, /grantPropertyAccess\(request, propertyId\)/, "tenencia por grantPropertyAccess (404 opaco)");
    assert.match(statusRoutes, /redisConsumerCount: 0/, "sin cliente Redis en el API, el consumidor es 0 (modo none)");
  });
});

describe("L8-08 · modo none / sandbox nunca simula un resultado real", () => {
  it("psp/index.ts: el registro sandbox solo entra por setPspRegistry (nunca por variable de entorno)", () => {
    assert.equal(pspIndex.match(/sandboxPspRegistry\(/g)?.length, 1, "sandboxPspRegistry solo aparece en su definición dentro del módulo");
    assert.match(pspIndex, /let registry: PspRegistry = defaultRegistry;/);
    assert.match(pspIndex, /export function setPspRegistry\(next: PspRegistry \| null\): void \{\s+registry = next \?\? defaultRegistry;\s+\}/);
    assert.equal(pspIndex.match(/\bregistry = /g)?.length, 1, "la única reasignación del registro es setPspRegistry");
    assert.doesNotMatch(pspIndex, /process\.env\.[A-Z_]*SANDBOX/i);
    for (const file of apiSourceFiles()) {
      const source = readFileSync(file, "utf8");
      if (file.endsWith(join("payments", "psp", "index.ts"))) continue;
      assert.equal(source.includes("sandboxPspRegistry"), false, `${file.slice(ROOT.length)} importa el registro sandbox fuera de los tests`);
    }
  });

  it("webhook de WhatsApp: sin secreto responde «refused» (503) salvo variable explícita fuera de producción", () => {
    const mode = between(whatsappWebhook, "export function unsignedWebhookMode(", "\n}\n");
    assert.match(mode, /if \(\(env\.WHATSAPP_APP_SECRET \?\? ""\)\.trim\(\)\) return "signed";/);
    assert.match(mode, /if \(env\.NODE_ENV !== "production" && \(allow === "1" \|\| allow === "true"\)\) return "simulated";/);
    assert.match(mode, /return "refused";\s*$/);
    assert.match(whatsappWebhook, /if \(mode === "refused"\) \{\s+reply\.code\(503\);/);
    assert.match(whatsappWebhook, /else if \(mode === "simulated"\) \{\s+simulated = true;/);
  });

  it("proveedores de correo, SMS y WhatsApp: sin credenciales → `failed` en producción y `simulated: true` fuera de ella", () => {
    for (const [name, source] of [["email", emailProvider], ["sms", smsProvider], ["whatsapp", whatsappProvider]]) {
      assert.match(source, /if \(process\.env\.NODE_ENV === "production"\) \{\s+return \{ status: "failed", error: "[^"]+" \};\s+\}\s+return \{ status: "sent", simulated: true, providerMessageId: `simulated_/, `${name}.provider.ts`);
    }
  });

  it("readChannelEnv: el tope de modo nace en sandbox (solo stub | real lo cambian) y no hay atajo a real", () => {
    assert.match(channelEnv, /const maxMode: ChannelMaxMode = rawMode === "stub" \|\| rawMode === "real" \? rawMode : "sandbox";/);
  });

  it("emailProvidersStatus: IMAP se declara no configurado (dependencia ausente) y el buzón manual es el único siempre disponible", () => {
    const status = between(emailReservation, "export function emailProvidersStatus() {", "\n}\n");
    assert.match(status, /imap: \{ configured: false, note: "[^"]+" \}/);
    assert.match(status, /manual: \{ configured: true \}/);
    assert.match(status, /gmail: \{ configured: !!oauthConfig\("gmail"\) \}/);
    assert.match(status, /microsoft: \{ configured: !!oauthConfig\("microsoft"\) \}/);
  });

  it("hub heredado: la prueba de conexión responde «simulated» (nunca ok) y persiste IntegrationTestSimulated", () => {
    const build = between(legacyHub, "export function buildConnectionTestResult(", "\n}\n");
    assert.match(build, /status: "simulated",\s+simulated: true,/);
    assert.match(build, /eventType: "IntegrationTestSimulated",\s+status: "simulated",/);
    assert.doesNotMatch(build, /"ok"|"accepted"/);
    assert.match(legacyHub, /status: "simulated";\s+simulated: true;/, "el tipo ConnectionTestResult fija el literal");
    assert.doesNotMatch(legacyHub, /status: "ok"/, "ningún resultado ok inventado en el hub heredado");
  });
});

describe("L8-08 · front honesto (admin-web)", () => {
  it("NotificationsScreen deriva el resultado de cada envío con deliveryOutcome (SIMULADO nunca cuenta como enviado)", () => {
    assert.match(notificationsScreen, /from "\.\/delivery-outcome"/);
    assert.match(notificationsScreen, /\bdeliveryOutcome\(/);
    assert.match(deliveryOutcome, /export const SIMULATED_MARK = \/\^SIMULADO\/i;/);
    assert.match(deliveryOutcome, /return isSimulatedDelivery\(row\) \? "simulated" : row\.status;/);
  });

  it("PaymentSettings lee la fila psp de GET /integrations/status y no el gatewayReady del hub heredado", () => {
    assert.doesNotMatch(paymentSettings, /gatewayReady/);
    assert.match(paymentSettings, /fetchIntegrationsStatus/);
    assert.match(paymentSettings, /INTEGRATION_MODE_LABELS_ES/);
  });
});

describe("L8-08 · documentación: runbook §1 y api-contracts.md", () => {
  const runbookTable = between(runbook, "## 1 · Tabla de estados", "## 2 · ");

  it("el runbook docs/runbooks/integraciones.md §1 tiene una fila por IntegrationKey y ninguna clave desconocida", () => {
    const rows = [...runbookTable.matchAll(/^\| `([a-z_0-9]+)` · /gm)].map((entry) => entry[1]);
    for (const key of INTEGRATION_KEYS) assert.ok(rows.includes(key), `runbook §1: falta la fila de ${key}`);
    for (const row of rows) assert.ok(INTEGRATION_KEYS.includes(row), `runbook §1: fila ${row} sin clave en el contrato`);
    assert.equal(rows.length, INTEGRATION_KEYS.length);
    assert.match(runbook, /`none \| sandbox \| real`/);
  });

  it("docs/api-contracts.md documenta GET /integrations/status, el bloque `integrations` de /health y cada clave", () => {
    assert.match(apiContracts, /`GET \/integrations\/status\?propertyId=<id>` \(`integrations\.read`, low/);
    assert.match(apiContracts, /`GET \/health` · clave superior `integrations`/);
    assert.match(apiContracts, /describeIntegrationsHealth/);
    for (const key of INTEGRATION_KEYS) assert.ok(apiContracts.includes(`\`${key}\``), `api-contracts.md: sin entrada \`${key}\``);
    assert.match(apiContracts, /`none` = nada cruza hacia el sistema externo ⇒ `readyForReal: false` y `lastActivityAt: null` siempre/);
    assert.match(apiContracts, /`message` nunca dice «enviado»/);
    assert.match(apiContracts, /tests\/integrations-honesty-contract\.test\.mjs/);
  });
});
