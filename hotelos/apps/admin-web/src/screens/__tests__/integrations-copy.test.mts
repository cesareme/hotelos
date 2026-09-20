import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Regression contract of lote L8-07 (Tanda L8 · integraciones honestas): the
// neighbouring screens stop announcing successes the code does not guarantee.
//   · Pagos reads the gateway state from GET /integrations/status (row `psp`)
//     and never derives «ready» from the legacy hub (`connectedCount > 0`);
//     the hub rows are «Conexiones de demostración (catálogo heredado)».
//   · Exportar a gestoría names «compatible ContaPlus / Sage 50» and A3 «no
//     disponible» (409); never the ledger-import product name.
//   · The manual §3.3 describes the tab (status panel + empty catalogue) with
//     the contract vocabulary and no «En construcción».
// Source-level, like screens-fixes-contract.test.mts: no browser, no API.
const SRC = fileURLToPath(new URL("../../", import.meta.url));
const REPO = fileURLToPath(new URL("../../../../../", import.meta.url));
/** Source without comments (code comments stay in English by convention; only rendered copy is checked). */
const stripComments = (source: string) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
const read = (rel: string) => stripComments(readFileSync(join(SRC, rel), "utf8"));

describe("Pagos · la pasarela sale de GET /integrations/status, nunca del hub heredado (auditoría A1, recon nº 1)", () => {
  const screen = read("screens/PaymentSettings.tsx");
  const api = read("services/billingApi.ts");

  it("la petición es la de services/integrationsApi.ts (L8-06), sin duplicarla en billingApi; billingApi solo lee la fila psp", () => {
    const integrationsApi = read("services/integrationsApi.ts");
    assert.match(integrationsApi, /export function fetchIntegrationsStatus\(/);
    assert.match(integrationsApi, /INTEGRATIONS_STATUS_PATH = "\/integrations\/status"/);
    assert.doesNotMatch(api, /function fetchIntegrationsStatus|\/integrations\/status/);
    assert.match(api, /export function pspIntegrationStatus\(/);
    assert.match(api, /item\.key === "psp"/);
    assert.match(screen, /import \{ fetchIntegrationsStatus \} from "\.\.\/services\/integrationsApi";/);
  });

  it("la pantalla ya no calcula la pasarela con connectedCount > 0 ni pinta «Conectado» en verde", () => {
    assert.doesNotMatch(screen, /gatewayReady\s*=\s*connectedCount\s*>\s*0/);
    assert.doesNotMatch(screen, /connectedCount/);
    assert.doesNotMatch(screen, /connected: \{ label: "Conectado", tone: "success" \}/);
    assert.doesNotMatch(screen, /Ningún PSP conectado|Pasarela no configurada|hasta que uno pase a «Conectado»/);
    assert.match(screen, /fetchIntegrationsStatus\(PROPERTY_ID\)/);
    assert.match(screen, /pspIntegrationStatus\(status\.value\)/);
  });

  it("el badge lee el modo del contrato: verde solo en real y sin requisitos pendientes; sin estado nunca «listo»", () => {
    assert.match(screen, /INTEGRATION_MODE_LABELS_ES\[psp\.mode\]/);
    assert.match(screen, /const MODE_TONE: Record<IntegrationMode, CocoaTone> = \{ none: "neutral", sandbox: "warning", real: "success" \};/);
    assert.match(screen, /psp\.mode === "real" && !psp\.readyForReal[\s\S]{0,80}Real · con requisitos pendientes/);
    assert.match(screen, /failed \? "Estado no disponible" : "Comprobando…", tone: "neutral"/);
    // Sin PSP real la pantalla muestra el `message` de psp-status y lo que falta.
    assert.match(screen, /<p>\{psp\.message\}<\/p>/);
    assert.match(screen, /psp\.missingForReal\.map\(/);
    assert.match(screen, /Qué falta para cobrar en real/);
  });

  it("el hub heredado es «Conexiones de demostración (catálogo heredado)» con nota de que no cobra y sin tono success", () => {
    assert.match(screen, /title="Conexiones de demostración \(catálogo heredado\)"/);
    assert.match(screen, /son de demostración y no cobran/);
    assert.match(screen, /Demostración · no cobra/);
    const hubMeta = screen.match(/const HUB_STATUS_META[\s\S]*?\n\};/)?.[0] ?? "";
    assert.ok(hubMeta, "HUB_STATUS_META missing");
    assert.doesNotMatch(hubMeta, /"success"/);
  });
});

describe("Exportar a gestoría · «compatible ContaPlus / Sage 50» y A3 «no disponible» (409)", () => {
  const raw = readFileSync(join(SRC, "screens/accounting/GestoriaExportScreen.tsx"), "utf8");
  const screen = stripComments(raw);

  it("nunca nombra el producto de la importación contable (ni en comentarios)", () => {
    assert.doesNotMatch(raw, /Sage ?200/i);
  });

  it("las etiquetas y ayudas dicen «ContaPlus / Sage 50» y A3 lee «no disponible» con el 409 del API", () => {
    assert.match(screen, /ContaPlus \/ Sage 50/);
    assert.match(screen, /`\$\{candidate\.label\} \(no disponible\)`/);
    assert.match(screen, /el servidor lo rechaza \(409\) y no genera ningún fichero/);
    assert.match(screen, /«A3 \(enlace contable\)» no está disponible \(el servidor responde 409 y no genera fichero\)/);
  });
});

describe("Manual · 60-sistemas §3.3 describe la pestaña (panel de estado + catálogo vacío) sin «En construcción»", () => {
  const manual = readFileSync(join(REPO, "docs/manual/60-sistemas.md"), "utf8");
  const start = manual.indexOf("### 3.3 Integraciones");
  const end = manual.indexOf("## 4. ", start);
  assert.ok(start >= 0 && end > start, "§3.3 not found");
  const section = manual.slice(start, end);

  it("sin «En construcción» ni «aplicaciones certificadas» en §3.3", () => {
    assert.doesNotMatch(section, /En construcción/);
    assert.doesNotMatch(section, /Aplicaciones certificadas/);
  });

  it("nombra el panel de estado con el vocabulario del contrato y el catálogo vacío", () => {
    assert.match(section, /\*\*Panel de estado\*\*/);
    for (const label of ["«Sin integración»", "«Pruebas (sin efecto real)»", "«Real»", "«Ficheros»", "«API (red)»", "«Manual»", "«Ninguno»", "«Qué falta para real»"]) {
      assert.ok(section.includes(label), `§3.3 no cita ${label}`);
    }
    assert.match(section, /\*\*Catálogo de aplicaciones\*\*/);
    assert.match(section, /«0 aplicaciones publicadas»/);
    assert.match(section, /El verde solo aparece en «Real»/);
  });
});

// ---------------------------------------------------------------------------
// Corrector L8 (REV-02 · «ningún éxito falso» en pantallas servidas; REV-03/04/10 y seguridad REV-07)
// ---------------------------------------------------------------------------

describe("Corrector L8 · Campañas, SES, Pagos, Integraciones y manifiesto sin éxitos falsos", () => {
  it("Campañas: el KPI «Enviadas» dice que son registros sin motor de envío (A8)", () => {
    const screen = read("screens/marketing/CampaignManagerScreen.tsx");
    assert.match(screen, /<CocoaKpi label="Enviadas" value=\{number\(stats\.sent\)\} caption="registradas como enviadas \(sin motor de envío\)"/);
    assert.doesNotMatch(screen, /ya entregadas/);
  });

  it("SES.Hospedajes: los acuses del simulador (endpoint stub://) se etiquetan «(simulador)» y el punto de acceso no pinta stub:// (B1)", () => {
    const screen = read("screens/compliance/SesHospedajesSettingsScreen.tsx");
    assert.match(screen, /import \{ SIMULATED_ENDPOINT_LABEL, SUBMISSION_PENDING_STATUSES, isSimulatedSubmission, simulatorAwareStatusLabel \} from "\.\.\/fiscal\/fiscal-shared";/);
    assert.doesNotMatch(screen, /STATUS_LABELS\[s\.status\] \?\? s\.status|STATUS_LABELS\[sub\.status\] \?\? sub\.status/, "ningún badge lee la etiqueta sin pasar por simulatorAwareStatusLabel");
    assert.match(screen, /<KvRow label="Punto de acceso" value=\{isSimulatedSubmission\(sub\) \? SIMULATED_ENDPOINT_LABEL : sub\.endpoint\} mono=\{!isSimulatedSubmission\(sub\)\} \/>/);
    const shared = read("screens/fiscal/fiscal-shared.ts");
    assert.match(shared, /export function simulatorAwareStatusLabel\(/);
    assert.match(shared, /\$\{base\} \(simulador\)/);
  });

  it("Pagos: una conexión de demostración en error o desconectada muestra también su estado persistido (REV-04)", () => {
    const screen = read("screens/PaymentSettings.tsx");
    assert.match(screen, /const attention = row\.status === "error" \|\| row\.status === "disconnected";/);
    assert.match(screen, /Demostración · no cobra<\/CocoaBadge>\s*\{attention \? \(/);
  });

  it("Integraciones: el «Actualizar» de la cabecera recarga también el panel de estado y el vacío de instaladas no invita a instalar de un catálogo vacío (REV-03)", () => {
    const screen = read("screens/marketplace/MarketplaceCatalogScreen.tsx");
    assert.match(screen, /<IntegrationsStatusPanel refreshKey=\{statusRefreshKey\} \/>/);
    assert.match(screen, /function refreshAll\(\) \{\s*setStatusRefreshKey\(\(key\) => key \+ 1\);\s*void refresh\(\);/);
    assert.match(screen, /onClick=\{refreshAll\}/);
    assert.match(screen, /Ninguna aplicación instalada; el catálogo de terceros está vacío\./);
    const panel = read("screens/integrations/IntegrationsStatusPanel.tsx");
    assert.match(panel, /export function IntegrationsStatusPanel\(\{ refreshKey = 0 \}/);
    assert.match(panel, /\}, \[load, refreshKey\]\);/);
  });

  it("CocoaStatusBar («Conectado» y contadores inventados sin consumidor) ya no existe (A9)", () => {
    assert.equal(existsSync(join(SRC, "components/cocoa-global/CocoaStatusBar.tsx")), false);
    assert.doesNotMatch(read("components/cocoa-global/index.ts"), /CocoaStatusBar/);
  });

  it("manifiesto de proveedores (apps/mobile): todos demo + sandbox con «(demostración)» y la app móvil no pinta ninguno «connected»", () => {
    const manifest = readFileSync(join(REPO, "packages/integrations/src/registry/integration-provider-manifest.ts"), "utf8");
    const entries = manifest.match(/\{\s*code: "[^"]+"[\s\S]*?\n  \}/g) ?? [];
    assert.equal(entries.length, 5, "5 proveedores en el manifiesto");
    for (const entry of entries) {
      assert.match(entry, /name: "[^"]+ \(demostración\)"/, entry);
      assert.match(entry, /demo: true/, entry);
      assert.match(entry, /mode: "sandbox"/, entry);
    }
    const mobile = readFileSync(join(REPO, "apps/mobile/src/screens/more/IntegrationMarketplaceScreen.tsx"), "utf8");
    assert.doesNotMatch(mobile, /"connected"/);
    assert.match(mobile, /provider\.demo \? "demostración" : "available"/);
  });

  it("manuales 10 y 20: la pestaña Pagos describe la pasarela real y la conexión de demostración, nunca «CONECTADO»", () => {
    for (const rel of ["docs/manual/10-direccion.md", "docs/manual/20-administracion.md"]) {
      const manual = readFileSync(join(REPO, rel), "utf8");
      assert.doesNotMatch(manual, /Demo Payment Gateway · mock_payments · CONECTADO/, rel);
      assert.match(manual, /Demo Payment Gateway \(demostración\) · mock_payments · DEMOSTRACIÓN · NO COBRA · api_key/, rel);
      assert.match(manual, /Conexiones de demostración \(catálogo heredado\)/, rel);
      assert.doesNotMatch(manual, /Proveedores de pago \(PSP\) conectados a la propiedad/, rel);
    }
  });
});
