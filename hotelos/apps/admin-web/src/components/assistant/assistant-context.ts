// Asistente unificado (Tanda L6b) · contexto de pantalla, puro.
//
// `buildScreenContext({ screenKey, pathname, pageCommands })` describe la
// página desde la que se pregunta con lo MÍNIMO que el núcleo necesita para
// enrutar y filtrar herramientas: la clave de pantalla, la URL sin query
// string ni hash y, si la ruta es una ficha, la entidad como `{ type, id }`.
// Nunca nombres (un segmento que no parezca un id se descarta), nunca
// parámetros de búsqueda (pueden llevar texto libre del operador). Los ids de
// los comandos ⌘K de la página viajan como `commands` (solo ids, sin
// etiquetas) para que el asistente sepa qué acciones ofrece la pantalla.
//
// Sin DOM: el panel pasa `window.location.pathname` y `getPageCommands()`.
// Probado en components/__tests__/assistant-panel.test.mts.

import type { AssistantScreenContext, AssistantScreenEntity } from "../../services/assistantApi";
import type { CocoaPageCommand } from "../cocoa/cocoa-page-commands";

/** Un id «seguro»: alfanumérico con `_ . : -`, ≤ 80 caracteres, sin espacios ni codificación (%20) — lo que descarta un nombre. */
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;

/** Segmentos que ocupan el hueco del id sin ser uno («nueva», «new»…). */
const RESERVED_SEGMENTS: ReadonlySet<string> = new Set(["nueva", "nuevo", "new", "crear", "create", "editar", "edit", "lista", "list"]);

/** Máximo de ids de comandos que viajan con el contexto. */
export const MAX_CONTEXT_COMMANDS = 12;

export interface ScreenContextInput {
  /** Clave de la pantalla activa (App.tsx / nav-tree). */
  screenKey: string | null | undefined;
  /** `window.location.pathname` (se admite una URL completa o una ruta con query/hash). */
  pathname: string | null | undefined;
  /** Comandos ⌘K registrados por la página (`getPageCommands()`); solo se conservan sus ids. */
  pageCommands?: readonly Pick<CocoaPageCommand, "id">[] | null;
}

/** Rutas con ficha (pilots/tanda5-nav-tree.csv): tipo de entidad ← patrón de la URL. */
export const ENTITY_ROUTES: ReadonlyArray<{ type: string; pattern: RegExp }> = [
  { type: "reservation", pattern: /^\/recepcion\/reservas\/([^/]+)/ },
  { type: "guest", pattern: /^\/recepcion\/huespedes\/([^/]+)/ },
  { type: "folio", pattern: /^\/finanzas\/facturacion\/folios\/([^/]+)/ },
  { type: "organization", pattern: /^\/configuracion\/sistema\/organizaciones\/([^/]+)/ },
  { type: "property", pattern: /^\/informes\/cartera\/([^/]+)/ },
  { type: "room_category", pattern: /^\/configuracion\/propiedad\/categorias\/([^/]+)/ }
];

/** Ruta limpia (pura): sin origen, sin query string, sin hash, con barra inicial y sin barra final. */
export function stripQuery(pathname: string | null | undefined): string {
  let path = (pathname ?? "").trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    const withoutOrigin = path.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "");
    path = withoutOrigin || "/";
  }
  const cut = path.search(/[?#]/);
  if (cut >= 0) path = path.slice(0, cut);
  if (!path.startsWith("/")) path = `/${path}`;
  path = path.replace(/\/{2,}/g, "/");
  if (path.length > 1) path = path.replace(/\/+$/, "");
  return path;
}

/** Id aceptable para el contexto (puro): cumple SAFE_ID y no es un segmento reservado. */
export function isSafeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value) && !RESERVED_SEGMENTS.has(value.toLowerCase());
}

/** Entidad de una ruta de ficha (pura): `{ type, id }` o undefined cuando la ruta no es una ficha o el segmento no es un id seguro. */
export function entityFromPath(url: string): AssistantScreenEntity | undefined {
  for (const route of ENTITY_ROUTES) {
    const match = route.pattern.exec(url);
    if (!match) continue;
    const id = match[1];
    return isSafeId(id) ? { type: route.type, id } : undefined;
  }
  return undefined;
}

/** Ids de comandos (puros): solo ids seguros, sin duplicados, acotados a MAX_CONTEXT_COMMANDS. */
export function commandIds(pageCommands: ScreenContextInput["pageCommands"]): string[] {
  const out: string[] = [];
  for (const command of pageCommands ?? []) {
    const id = command?.id;
    if (!isSafeId(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= MAX_CONTEXT_COMMANDS) break;
  }
  return out;
}

/** Contexto de la pantalla activa para `askAssistant({ screen })`: clave, URL limpia, entidad por id y comandos por id. */
export function buildScreenContext(input: ScreenContextInput): AssistantScreenContext {
  const screenKey = (input.screenKey ?? "").trim();
  const url = stripQuery(input.pathname);
  const context: AssistantScreenContext = { screenKey: isSafeId(screenKey) ? screenKey : "", url };
  const entity = entityFromPath(url);
  if (entity) context.entity = entity;
  const commands = commandIds(input.pageCommands);
  if (commands.length > 0) context.commands = commands;
  return context;
}
