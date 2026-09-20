// Integraciones · helpers puros del panel de estado (Tanda L8 · L8-06; contrato
// packages/shared/src/integrations-status-types.ts de L8-01, runbook
// docs/runbooks/integraciones.md §2.2). Sin React, sin api-client, sin
// import.meta: etiquetas y tonos por modo, áreas de agrupación, resumen de lo
// que falta para operar en real, última actividad, contadores por modo, la
// clave de pantalla del árbol para el botón «Configurar» y el cambio de pestaña
// dentro del mismo contenedor (patrón SistemaTabs: pushState + evento de
// pestaña, sin viaje por el shell) cuando la pantalla del DTO es una pestaña
// del ítem anfitrión (OPERA → Modo sombra). Todo formatea por lib/format.
// Solo `import type` de @hotelos/shared (los .js stubs del contrato ganan bajo
// node --import tsx): los diccionarios en español se redeclaran aquí
// tipados contra el contrato, con las mismas frases que
// INTEGRATION_MODE_LABELS_ES / INTEGRATION_TRANSPORT_LABELS_ES.

import type { IntegrationKey, IntegrationMode, IntegrationStatusDto, IntegrationTransport } from "@hotelos/shared";
import type { CocoaTone } from "../../components/cocoa";
import { EMPTY, dateTime } from "../../lib/format";
import { NAV_TREE, findByUrl, type NavTree } from "../../navigation/nav-tree";

// ---------------------------------------------------------------------------
// Modo
// ---------------------------------------------------------------------------

export const INTEGRATION_MODES: readonly IntegrationMode[] = ["none", "sandbox", "real"];

/** Misma frase que INTEGRATION_MODE_LABELS_ES del contrato (sin jerga en pantalla). */
export const MODE_LABELS: Readonly<Record<IntegrationMode, string>> = Object.freeze({
  none: "Sin integración",
  sandbox: "Pruebas (sin efecto real)",
  real: "Real"
});

export const MODE_TONES: Readonly<Record<IntegrationMode, CocoaTone>> = Object.freeze({
  none: "neutral",
  sandbox: "warning",
  real: "success"
});

/** Título corto del contador por modo (cabecera del panel). */
export const MODE_KPI_LABELS: Readonly<Record<IntegrationMode, string>> = Object.freeze({
  none: "Sin integración",
  sandbox: "En pruebas",
  real: "Reales"
});

export const MODE_KPI_CAPTIONS: Readonly<Record<IntegrationMode, string>> = Object.freeze({
  none: "nada cruza al sistema externo",
  sandbox: "ningún resultado tiene efecto real",
  real: "los datos cruzan de verdad"
});

export function isIntegrationMode(value: unknown): value is IntegrationMode {
  return typeof value === "string" && (INTEGRATION_MODES as readonly string[]).includes(value);
}

export function modeLabel(mode: IntegrationMode | string | null | undefined): string {
  return isIntegrationMode(mode) ? MODE_LABELS[mode] : EMPTY;
}

export function modeTone(mode: IntegrationMode | string | null | undefined): CocoaTone {
  return isIntegrationMode(mode) ? MODE_TONES[mode] : "neutral";
}

/** Nota bajo el badge de modo: solo cuando «real» arrastra requisitos pendientes. */
export function modeNote(dto: Pick<IntegrationStatusDto, "mode" | "readyForReal">): string | null {
  return dto.mode === "real" && !dto.readyForReal ? "con requisitos pendientes" : null;
}

// ---------------------------------------------------------------------------
// Transporte
// ---------------------------------------------------------------------------

export const TRANSPORT_LABELS: Readonly<Record<IntegrationTransport, string>> = Object.freeze({
  files: "Ficheros",
  http: "API (red)",
  manual: "Manual",
  none: "Ninguno"
});

export function transportLabel(transport: IntegrationTransport | string | null | undefined): string {
  if (!transport) return EMPTY;
  return (TRANSPORT_LABELS as Record<string, string>)[transport] ?? transport;
}

// ---------------------------------------------------------------------------
// Áreas (agrupación de la tabla; el orden de las filas dentro de cada área es
// el de INTEGRATION_KEYS tal y como llega del API)
// ---------------------------------------------------------------------------

export type IntegrationArea = "pms" | "sales" | "communications" | "compliance" | "platform" | "other";

export const AREA_ORDER: readonly IntegrationArea[] = ["pms", "sales", "communications", "compliance", "platform", "other"];

export const AREA_LABELS: Readonly<Record<IntegrationArea, string>> = Object.freeze({
  pms: "PMS y contabilidad",
  sales: "Ventas, cobros y reputación",
  communications: "Comunicaciones",
  compliance: "Cumplimiento",
  platform: "Plataforma",
  other: "Otras"
});

/** Área de cada clave del inventario (exhaustivo: una clave nueva del contrato no compila sin área). */
export const AREA_OF: Readonly<Record<IntegrationKey, IntegrationArea>> = Object.freeze({
  opera: "pms",
  sage200: "pms",
  gestoria_export: "pms",
  channels: "sales",
  psp: "sales",
  gbp: "sales",
  whatsapp: "communications",
  email_out: "communications",
  sms: "communications",
  email_in: "communications",
  ses: "compliance",
  verifactu: "compliance",
  tbai: "compliance",
  igic: "compliance",
  storage: "platform",
  ai: "platform",
  sentry: "platform",
  redis: "platform"
});

export function areaOf(key: IntegrationKey | string): IntegrationArea {
  return (AREA_OF as Record<string, IntegrationArea>)[key] ?? "other";
}

export type IntegrationGroup = { area: IntegrationArea; label: string; rows: IntegrationStatusDto[] };

/** Grupos no vacíos en el orden de AREA_ORDER; cada grupo conserva el orden de llegada de sus filas. */
export function groupByArea(rows: readonly IntegrationStatusDto[]): IntegrationGroup[] {
  const buckets = new Map<IntegrationArea, IntegrationStatusDto[]>();
  for (const row of rows) {
    const area = areaOf(row.key);
    const bucket = buckets.get(area);
    if (bucket) bucket.push(row);
    else buckets.set(area, [row]);
  }
  return AREA_ORDER.filter((area) => buckets.has(area)).map((area) => ({ area, label: AREA_LABELS[area], rows: buckets.get(area) ?? [] }));
}

// ---------------------------------------------------------------------------
// Celdas
// ---------------------------------------------------------------------------

export const NO_ACTIVITY = "Sin actividad";
export const NOTHING_MISSING = "Nada pendiente: opera en real";

/** «15/09/2026, 14:05» o «Sin actividad» (null, vacío o fecha inválida). */
export function formatLastActivity(value: string | null | undefined): string {
  if (!value) return NO_ACTIVITY;
  return dateTime(value, { empty: NO_ACTIVITY });
}

/** Qué falta para operar en real: las frases del API unidas por « · »; «Nada pendiente» solo si readyForReal. */
export function missingSummary(dto: Pick<IntegrationStatusDto, "readyForReal" | "missingForReal">): string {
  if (dto.readyForReal) return NOTHING_MISSING;
  const items = dto.missingForReal.map((item) => item.trim()).filter((item) => item.length > 0);
  return items.length > 0 ? items.join(" · ") : EMPTY;
}

// ---------------------------------------------------------------------------
// Contadores de cabecera
// ---------------------------------------------------------------------------

export function countByMode(rows: readonly Pick<IntegrationStatusDto, "mode">[]): Record<IntegrationMode, number> {
  const counts: Record<IntegrationMode, number> = { none: 0, sandbox: 0, real: 0 };
  for (const row of rows) {
    if (isIntegrationMode(row.mode)) counts[row.mode] += 1;
  }
  return counts;
}

export type ModeKpi = { mode: IntegrationMode; label: string; caption: string; value: number; tone: CocoaTone };

/** Tres contadores en orden real · pruebas · sin integración (nunca inventados: cuentan filas del API). */
export function modeKpis(rows: readonly Pick<IntegrationStatusDto, "mode">[]): ModeKpi[] {
  const counts = countByMode(rows);
  return (["real", "sandbox", "none"] as const).map((mode) => ({ mode, label: MODE_KPI_LABELS[mode], caption: MODE_KPI_CAPTIONS[mode], value: counts[mode], tone: MODE_TONES[mode] }));
}

// ---------------------------------------------------------------------------
// Navegación («Configurar» abre la pantalla del DTO por su clave del árbol)
// ---------------------------------------------------------------------------

/** Clave SCREEN_COMPONENTS que sirve la ruta `screen` del DTO (null si no tiene pantalla o el árbol no la conoce). */
export function screenKeyForRoute(route: string | null | undefined, tree: NavTree = NAV_TREE): string | null {
  if (!route) return null;
  const match = findByUrl(route, tree);
  if (!match) return null;
  if (match.kind === "item") return match.item.screenKey;
  if (match.kind === "tab") return match.tab.screenKey;
  return match.screen.screenKey;
}

/** Último segmento estático de una ruta (`/configuracion/modulos/modo-sombra` → `modo-sombra`); vacío si no lo hay. */
function lastSegment(pathname: string): string {
  const segments = pathname.split("?")[0]?.split("/").filter(Boolean) ?? [];
  return segments[segments.length - 1] ?? "";
}

export type TabSwitch = { basePath: string; from: string | null; to: string; href: string };

/**
 * Cambio de pestaña dentro del contenedor anfitrión (TabHostInfo.basePath) cuando
 * la ruta del DTO es una pestaña estática del mismo ítem del árbol; null si no
 * hay anfitrión, la ruta pertenece a otro ítem, lleva `:param` o ya es la
 * pestaña actual (entonces el panel viaja por el shell con la clave de pantalla).
 */
export function tabSwitchFor(route: string | null | undefined, host: { basePath: string } | null | undefined, currentPathname: string | null | undefined, tree: NavTree = NAV_TREE): TabSwitch | null {
  if (!route || !host) return null;
  const match = findByUrl(route, tree);
  if (!match || match.kind !== "tab" || match.item.url !== host.basePath || match.tab.url.includes(":")) return null;
  const to = lastSegment(match.tab.url);
  const from = currentPathname ? lastSegment(currentPathname) || null : null;
  if (!to || from === to) return null;
  return { basePath: host.basePath, from, to, href: match.tab.url };
}

// ---------------------------------------------------------------------------
// Errores de carga (sin importar api-client: se lee `status` por forma)
// ---------------------------------------------------------------------------

export const STATUS_ROUTE_MISSING = "Esta instancia del API no expone todavía el estado de las integraciones.";

export function loadErrorMessage(error: unknown, fallback = "No se pudo leer el estado de las integraciones."): string {
  const status = typeof error === "object" && error !== null ? (error as { status?: unknown }).status : undefined;
  if (status === 404) return STATUS_ROUTE_MISSING;
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return fallback;
}
