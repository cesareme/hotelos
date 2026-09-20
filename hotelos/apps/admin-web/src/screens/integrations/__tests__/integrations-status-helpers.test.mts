import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { IntegrationKey, IntegrationMode, IntegrationStatusDto, IntegrationTransport } from "@hotelos/shared";
import { EMPTY, dateTime } from "../../../lib/format.ts";
import {
  AREA_LABELS,
  AREA_OF,
  AREA_ORDER,
  MODE_KPI_LABELS,
  MODE_LABELS,
  MODE_TONES,
  NOTHING_MISSING,
  NO_ACTIVITY,
  STATUS_ROUTE_MISSING,
  TRANSPORT_LABELS,
  areaOf,
  countByMode,
  formatLastActivity,
  groupByArea,
  isIntegrationMode,
  loadErrorMessage,
  missingSummary,
  modeKpis,
  modeLabel,
  modeNote,
  modeTone,
  screenKeyForRoute,
  tabSwitchFor,
  transportLabel
} from "../integrations-status-helpers.ts";

// Tanda L8 · L8-06: the pure helpers of the «Integraciones» status panel.
// Fixtures are fictional (no tenant, no person): the 18 keys of the L8-01
// contract in their presentation order, with the screens the API sends.

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

/** INTEGRATION_KEYS of the contract (presentation order) with INTEGRATION_SCREENS. */
const KEYS_AND_SCREENS: ReadonlyArray<[IntegrationKey, string | null]> = [
  ["opera", "/configuracion/modulos/modo-sombra"],
  ["sage200", "/finanzas/contabilidad/importar-sage200"],
  ["gestoria_export", "/finanzas/contabilidad/exportar-gestoria"],
  ["channels", "/comercial/canales"],
  ["psp", "/configuracion/facturacion-pagos/pagos"],
  ["whatsapp", "/configuracion/comunicaciones"],
  ["email_out", "/configuracion/comunicaciones"],
  ["sms", "/configuracion/comunicaciones"],
  ["email_in", "/configuracion/comunicaciones/correo-entrante"],
  ["gbp", "/comercial/reputacion"],
  ["ses", "/cumplimiento/envios"],
  ["verifactu", "/cumplimiento/verifactu"],
  ["tbai", "/cumplimiento/verifactu"],
  ["igic", "/cumplimiento/verifactu"],
  ["storage", "/operaciones/digitalizar"],
  ["ai", "/configuracion/ia"],
  ["sentry", null],
  ["redis", null]
];

function dto(key: IntegrationKey, over: Partial<IntegrationStatusDto> = {}): IntegrationStatusDto {
  const screen = KEYS_AND_SCREENS.find(([k]) => k === key)?.[1] ?? null;
  return {
    key,
    label: `Integración ${key}`,
    mode: "none",
    transport: "none",
    configured: false,
    readyForReal: false,
    message: "Sin integración operativa.",
    missingForReal: [],
    lastActivityAt: null,
    lastError: null,
    screen,
    ...over
  };
}

const ALL_ROWS: IntegrationStatusDto[] = KEYS_AND_SCREENS.map(([key]) => dto(key));

describe("integrations-status-helpers · modo", () => {
  it("labels and tones the three modes (neutral · warning · success) and falls back on unknown values", () => {
    assert.deepEqual(Object.keys(MODE_LABELS), ["none", "sandbox", "real"]);
    assert.equal(modeLabel("none"), "Sin integración");
    assert.equal(modeLabel("sandbox"), "Pruebas (sin efecto real)");
    assert.equal(modeLabel("real"), "Real");
    assert.equal(modeTone("none"), "neutral");
    assert.equal(modeTone("sandbox"), "warning");
    assert.equal(modeTone("real"), "success");
    assert.deepEqual(MODE_TONES, { none: "neutral", sandbox: "warning", real: "success" });
    for (const value of ["otro", "", null, undefined]) {
      assert.equal(modeLabel(value), EMPTY, String(value));
      assert.equal(modeTone(value), "neutral", String(value));
      assert.equal(isIntegrationMode(value), false, String(value));
    }
    assert.equal(isIntegrationMode("sandbox"), true);
  });

  it("keeps engineering jargon off the hotelier's screen (admin-web-spanish-copy contract)", () => {
    const visible = [...Object.values(MODE_LABELS), ...Object.values(MODE_KPI_LABELS), ...Object.values(TRANSPORT_LABELS), ...Object.values(AREA_LABELS), NO_ACTIVITY, NOTHING_MISSING, STATUS_ROUTE_MISSING];
    for (const text of visible) assert.doesNotMatch(text, /\b(sandbox|mock|stub|TODO)\b/i, text);
  });

  it("notes «con requisitos pendientes» only for a real mode that is not ready", () => {
    assert.equal(modeNote({ mode: "real", readyForReal: false }), "con requisitos pendientes");
    assert.equal(modeNote({ mode: "real", readyForReal: true }), null);
    assert.equal(modeNote({ mode: "sandbox", readyForReal: false }), null);
    assert.equal(modeNote({ mode: "none", readyForReal: false }), null);
  });

  it("labels the four transports in Spanish", () => {
    const expected: Record<IntegrationTransport, string> = { files: "Ficheros", http: "API (red)", manual: "Manual", none: "Ninguno" };
    for (const [transport, label] of Object.entries(expected)) assert.equal(transportLabel(transport), label);
    assert.equal(transportLabel("otro"), "otro");
    assert.equal(transportLabel(null), EMPTY);
  });
});

describe("integrations-status-helpers · agrupación por área", () => {
  it("assigns every key of the contract to an area and groups them in the fixed order", () => {
    assert.deepEqual(Object.keys(AREA_OF).sort(), KEYS_AND_SCREENS.map(([key]) => key).sort());
    const groups = groupByArea(ALL_ROWS);
    assert.deepEqual(
      groups.map((group) => group.area),
      ["pms", "sales", "communications", "compliance", "platform"]
    );
    assert.deepEqual(groups.map((group) => group.label), ["PMS y contabilidad", "Ventas, cobros y reputación", "Comunicaciones", "Cumplimiento", "Plataforma"]);
    assert.deepEqual(
      groups.map((group) => group.rows.map((row) => row.key)),
      [
        ["opera", "sage200", "gestoria_export"],
        ["channels", "psp", "gbp"],
        ["whatsapp", "email_out", "sms", "email_in"],
        ["ses", "verifactu", "tbai", "igic"],
        ["storage", "ai", "sentry", "redis"]
      ]
    );
    assert.equal(groups.flatMap((group) => group.rows).length, 18, "no row is lost or duplicated");
  });

  it("drops empty areas, keeps the arrival order inside an area and sends unknown keys to «Otras»", () => {
    assert.deepEqual(groupByArea([]), []);
    const partial = groupByArea([dto("redis"), dto("verifactu"), dto("storage")]);
    assert.deepEqual(partial.map((group) => [group.area, group.rows.map((row) => row.key)]), [
      ["compliance", ["verifactu"]],
      ["platform", ["redis", "storage"]]
    ]);
    const unknown = { ...dto("opera"), key: "desconocida" as IntegrationKey };
    assert.equal(areaOf("desconocida"), "other");
    const withUnknown = groupByArea([unknown, dto("opera")]);
    assert.deepEqual(withUnknown.map((group) => group.area), ["pms", "other"]);
    assert.equal(withUnknown[1]?.label, "Otras");
    assert.equal(AREA_ORDER[AREA_ORDER.length - 1], "other");
  });
});

describe("integrations-status-helpers · celdas", () => {
  it("formats the last activity through lib/format and says «Sin actividad» for null", () => {
    assert.equal(formatLastActivity(null), NO_ACTIVITY);
    assert.equal(formatLastActivity(undefined), NO_ACTIVITY);
    assert.equal(formatLastActivity(""), NO_ACTIVITY);
    assert.equal(formatLastActivity("no-es-una-fecha"), NO_ACTIVITY);
    const iso = "2026-09-17T06:31:00.000Z";
    assert.equal(formatLastActivity(iso), dateTime(iso));
    assert.match(formatLastActivity(iso), /17\/09\/2026/);
    assert.equal(NO_ACTIVITY, "Sin actividad");
  });

  it("summarises what is missing for real: the API's phrases joined, «Nada pendiente» only when ready", () => {
    assert.equal(missingSummary({ readyForReal: true, missingForReal: [] }), NOTHING_MISSING);
    assert.equal(missingSummary({ readyForReal: false, missingForReal: ["Credencial del proveedor", "Decisión: pasar a producción"] }), "Credencial del proveedor · Decisión: pasar a producción");
    assert.equal(missingSummary({ readyForReal: false, missingForReal: [] }), EMPTY);
    assert.equal(missingSummary({ readyForReal: false, missingForReal: ["  ", ""] }), EMPTY);
  });

  it("counts rows by mode without inventing anything and orders the KPIs real · pruebas · sin integración", () => {
    const rows = [dto("opera", { mode: "real" }), dto("psp", { mode: "sandbox" }), dto("whatsapp", { mode: "sandbox" }), dto("redis"), dto("sentry"), { ...dto("ai"), mode: "otro" as IntegrationMode }];
    assert.deepEqual(countByMode(rows), { real: 1, sandbox: 2, none: 2 });
    assert.deepEqual(countByMode([]), { real: 0, sandbox: 0, none: 0 });
    const kpis = modeKpis(rows);
    assert.deepEqual(
      kpis.map((kpi) => [kpi.mode, kpi.label, kpi.value, kpi.tone]),
      [
        ["real", "Reales", 1, "success"],
        ["sandbox", "En pruebas", 2, "warning"],
        ["none", "Sin integración", 2, "neutral"]
      ]
    );
    for (const kpi of kpis) assert.ok(kpi.caption.length > 0, kpi.mode);
  });
});

describe("integrations-status-helpers · navegación y errores", () => {
  it("resolves every screen of the contract to a key of the navigation tree and null otherwise", () => {
    assert.equal(screenKeyForRoute("/configuracion/modulos/modo-sombra"), "PmsShadowScreen");
    assert.equal(screenKeyForRoute("/configuracion/modulos/integraciones"), "MarketplaceCatalog");
    assert.equal(screenKeyForRoute(null), null);
    assert.equal(screenKeyForRoute(undefined), null);
    assert.equal(screenKeyForRoute(""), null);
    assert.equal(screenKeyForRoute("/ruta/que/no/existe"), null);
    const unresolved = KEYS_AND_SCREENS.filter(([, screen]) => screen !== null && screenKeyForRoute(screen) === null).map(([key, screen]) => `${key} → ${screen}`);
    assert.deepEqual(unresolved, [], "every DTO screen must be served by the tree (no new front routes in L8)");
    assert.deepEqual(KEYS_AND_SCREENS.filter(([, screen]) => screen === null).map(([key]) => key), ["sentry", "redis"], "platform components without a screen");
  });

  it("switches in-container only for a static tab of the hosting item (OPERA → Modo sombra), otherwise travels by the shell", () => {
    const host = { basePath: "/configuracion/modulos" };
    const here = "/configuracion/modulos/integraciones";
    assert.deepEqual(tabSwitchFor("/configuracion/modulos/modo-sombra", host, here), { basePath: "/configuracion/modulos", from: "integraciones", to: "modo-sombra", href: "/configuracion/modulos/modo-sombra" });
    assert.deepEqual(tabSwitchFor("/configuracion/modulos/modo-sombra", host, `${here}?dev=1`), { basePath: "/configuracion/modulos", from: "integraciones", to: "modo-sombra", href: "/configuracion/modulos/modo-sombra" });
    assert.equal(tabSwitchFor("/configuracion/modulos/modo-sombra", host, null)?.from, null);
    assert.equal(tabSwitchFor("/configuracion/modulos/integraciones", host, here), null, "already on that tab");
    assert.equal(tabSwitchFor("/comercial/canales", host, here), null, "another item: shell navigation");
    assert.equal(tabSwitchFor("/configuracion/modulos", host, here), null, "the item itself is not a tab");
    assert.equal(tabSwitchFor("/configuracion/modulos/modo-sombra", null, here), null, "standalone: no host");
    assert.equal(tabSwitchFor(null, host, here), null);
    assert.equal(tabSwitchFor("/ruta/que/no/existe", host, here), null);
    const inContainer = KEYS_AND_SCREENS.filter(([, screen]) => screen !== null && tabSwitchFor(screen, host, here) !== null).map(([key]) => key);
    assert.deepEqual(inContainer, ["opera"], "only OPERA lives in the Módulos container");
  });

  it("explains a 404 as a route not exposed by this API, keeps the API's message otherwise and falls back", () => {
    assert.equal(loadErrorMessage({ status: 404, message: "Not Found" }), STATUS_ROUTE_MISSING);
    assert.equal(loadErrorMessage(Object.assign(new Error("Sesión caducada"), { status: 401 })), "Sesión caducada");
    assert.equal(loadErrorMessage(new Error("   ")), "No se pudo leer el estado de las integraciones.");
    assert.equal(loadErrorMessage("cadena"), "No se pudo leer el estado de las integraciones.");
    assert.equal(loadErrorMessage(null, "otro"), "otro");
  });
});

describe("integrations-status-helpers · contrato de ficheros del lote", () => {
  it("the panel paints no inline style and only imports Cocoa primitives from the barrel", () => {
    const panel = stripComments(read("../IntegrationsStatusPanel.tsx"));
    assert.equal((panel.match(/\bstyle=\{/g) ?? []).length, 0, "IntegrationsStatusPanel.tsx nace con 0 style={");
    assert.doesNotMatch(panel, /<(button|table|input|select|textarea)\b/, "sin elementos crudos");
    assert.match(panel, /from "\.\.\/\.\.\/components\/cocoa"/);
    assert.match(panel, /useTabHost\(\)/, "lee el anfitrión para el cambio de pestaña en el contenedor (regla 7 de cocoa-22)");
    assert.doesNotMatch(panel, /\bfetch\(/, "las llamadas pasan por services/integrationsApi.ts");
  });

  it("the helpers stay pure: no React, no api-client, no import.meta", () => {
    const helpers = stripComments(read("../integrations-status-helpers.ts"));
    assert.doesNotMatch(helpers, /from "react"/);
    assert.doesNotMatch(helpers, /api-client/);
    assert.doesNotMatch(helpers, /import\.meta/);
    assert.match(helpers, /import type \{[^}]*\} from "@hotelos\/shared"/, "solo import type del contrato compartido");
    assert.doesNotMatch(helpers, /^import \{[^}]*\} from "@hotelos\/shared"/m);
  });

  it("the API client calls GET /integrations/status through apiRequest with the property in the query", () => {
    const service = stripComments(read("../../../services/integrationsApi.ts"));
    assert.match(service, /INTEGRATIONS_STATUS_PATH = "\/integrations\/status"/);
    assert.match(service, /apiRequest<IntegrationsStatusResponse>\(INTEGRATIONS_STATUS_PATH, \{ query: \{ propertyId: id \}/);
    assert.doesNotMatch(service, /\bfetch\(/);
  });
});
