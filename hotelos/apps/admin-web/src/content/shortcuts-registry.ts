// shortcuts-registry — la ÚNICA fuente de los atajos de teclado de admin-web
// (Tanda UX-1 · lote U5 · docs/design/UX-RECEPCION-FEEL.md §1.1 P2, §4
// «Atajos por pantalla y teclas de acceso», §10 D7 y R8).
//
// Tres capas (D7): navegación global con ⌥+letra (estilo Mews), teclas de acceso
// reveladas al mantener ⌥ (estilo OPERA) y ⌘K con los comandos de la pantalla.
// Cada entrada declara DÓNDE está cableada (`wiredIn`: fichero + literal que el
// contrato tests/shortcuts-catalog-contract.test.mjs busca en él): anunciar un
// atajo sin cablearlo es regresión (plan §2.3), y el catálogo de ayuda
// content/help-articles/keyboard-shortcuts.ts se GENERA de aquí con
// `node scripts/gen-shortcuts.mjs` (nunca se edita a mano).
//
// R8: los atajos con modificador se comparan por `KeyboardEvent.code` («KeyN»),
// nunca por `key` (⌥N produce «˜» en macOS), y solo hacen `preventDefault`
// cuando el foco NO está en un campo de texto (`isTextEntryTarget`).
//
// Sin importaciones de valor: el generador (.mjs) y el contrato lo importan tal
// cual bajo Node (type stripping), sin Vite.

export interface ShortcutWiring {
  /** Ruta relativa a hotelos/ del fichero que cablea el atajo. */
  readonly file: string;
  /** Literal que debe aparecer en ese fichero (el contrato lo comprueba). */
  readonly token: string;
}

export interface ShortcutEntry {
  /** Identificador estable («nav.today»); la guía y los comandos lo citan. */
  readonly id: string;
  /** Notación Mac tal y como se muestra («⌥H», «⌘⇧T», «Intro»). */
  readonly keys: string;
  /** Qué hace, en español y sin jerga. */
  readonly action: string;
  /** Categoría del catálogo de ayuda (orden en CATEGORY_ORDER). */
  readonly category: ShortcutCategory;
  /** `KeyboardEvent.code` de la tecla principal cuando el atajo lleva modificador (R8). */
  readonly code?: string;
  readonly alt?: boolean;
  /** ⌘ en Mac / Ctrl en Windows-Linux. */
  readonly mod?: boolean;
  readonly shift?: boolean;
  /** Pantalla a la que navega (clave de App.tsx / nav-tree). */
  readonly screen?: string;
  /** Evento de `window` que despacha (lo consume la pantalla activa). */
  readonly event?: string;
  readonly wiredIn: ShortcutWiring;
}

export type ShortcutCategory =
  | "Global"
  | "Navegación con ⌥"
  | "Teclas de acceso"
  | "Cobro"
  | "Paleta de comandos"
  | "Pestañas de una pantalla"
  | "Recorrido guiado"
  | "Modo prueba";

/** Orden de las categorías en el catálogo («Global» va primero: el centro de ayuda destaca esa lista). */
export const CATEGORY_ORDER: readonly ShortcutCategory[] = [
  "Global",
  "Navegación con ⌥",
  "Teclas de acceso",
  "Cobro",
  "Paleta de comandos",
  "Pestañas de una pantalla",
  "Recorrido guiado",
  "Modo prueba"
];

const LAYOUT = "apps/admin-web/src/layouts/BackOfficeLayout.tsx";
const PROVIDER = "apps/admin-web/src/providers/CocoaGlobalProvider.tsx";
const PALETTE = "apps/admin-web/src/components/CommandPalette.tsx";
const ACCESS_KEY = "apps/admin-web/src/components/cocoa/CocoaAccessKey.tsx";
const PAYMENT = "apps/admin-web/src/components/billing/PaymentDialog.tsx";
const UX_TRACE = "apps/admin-web/src/providers/UxTraceProvider.tsx";

/** Evento que enfoca el buscador de la pantalla activa (⌥F); si nadie lo atiende, el shell abre ⌘K. */
export const FOCUS_SEARCH_EVENT = "hotelos-focus-search";
/** Evento que abre el walk-in desde cualquier sitio (⌥W; lo consume Mi día en U6); si nadie lo atiende, el shell abre Nueva reserva. */
export const OPEN_WALK_IN_EVENT = "hotelos-open-walk-in";

export const SHORTCUTS: readonly ShortcutEntry[] = [
  // --- Global ---------------------------------------------------------------
  { id: "global.palette", keys: "⌘K", action: "Buscar reservas, huéspedes, habitaciones, facturas y pantallas, y ejecutar los comandos de la pantalla (paleta de comandos)", category: "Global", mod: true, code: "KeyK", wiredIn: { file: LAYOUT, token: 'event.key.toLowerCase() === "k"' } },
  { id: "global.shortcuts", keys: "⌘/", action: "Ver esta lista de atajos", category: "Global", mod: true, wiredIn: { file: PROVIDER, token: 'key === "/"' } },
  { id: "global.preferences", keys: "⌘,", action: "Abrir las preferencias de apariencia", category: "Global", mod: true, wiredIn: { file: PROVIDER, token: 'key === ","' } },
  { id: "global.enter", keys: "Intro", action: "En un campo de una línea de un diálogo o panel, confirmar la acción principal", category: "Global", wiredIn: { file: "apps/admin-web/src/components/cocoa/CocoaDialog.tsx", token: "shouldSubmitOnEnter" } },
  { id: "global.escape", keys: "Esc", action: "Cerrar el panel, diálogo o menú abierto", category: "Global", wiredIn: { file: "apps/admin-web/src/components/cocoa/cocoa-overlay.ts", token: '"Escape"' } },

  // --- Navegación con ⌥ (R8: por `code`, fuera de campos de texto) ----------
  { id: "nav.today", keys: "⌥H", action: "Ir a Mi día", category: "Navegación con ⌥", alt: true, code: "KeyH", screen: "FrontDeskDashboard", wiredIn: { file: LAYOUT, token: "GLOBAL_ALT_SHORTCUTS" } },
  { id: "nav.reservations", keys: "⌥R", action: "Ir a Reservas", category: "Navegación con ⌥", alt: true, code: "KeyR", screen: "ReservationWorkspace", wiredIn: { file: LAYOUT, token: "GLOBAL_ALT_SHORTCUTS" } },
  { id: "nav.reservation-create", keys: "⌥N", action: "Abrir Nueva reserva", category: "Navegación con ⌥", alt: true, code: "KeyN", screen: "ReservationCreate", wiredIn: { file: LAYOUT, token: "GLOBAL_ALT_SHORTCUTS" } },
  { id: "nav.timeline", keys: "⌥T", action: "Abrir el Live Timeline", category: "Navegación con ⌥", alt: true, code: "KeyT", screen: "LiveTimeline", wiredIn: { file: LAYOUT, token: "GLOBAL_ALT_SHORTCUTS" } },
  { id: "nav.room-rack", keys: "⌥B", action: "Abrir el tablero de habitaciones", category: "Navegación con ⌥", alt: true, code: "KeyB", screen: "RoomRackScreen", wiredIn: { file: LAYOUT, token: "GLOBAL_ALT_SHORTCUTS" } },
  { id: "nav.focus-search", keys: "⌥F", action: "Ir al buscador de la pantalla (si no tiene, abre la paleta)", category: "Navegación con ⌥", alt: true, code: "KeyF", event: FOCUS_SEARCH_EVENT, wiredIn: { file: LAYOUT, token: "GLOBAL_ALT_SHORTCUTS" } },
  { id: "nav.walk-in", keys: "⌥W", action: "Alta de walk-in (llegada sin reserva)", category: "Navegación con ⌥", alt: true, code: "KeyW", event: OPEN_WALK_IN_EVENT, wiredIn: { file: LAYOUT, token: "GLOBAL_ALT_SHORTCUTS" } },

  // --- Teclas de acceso -------------------------------------------------------
  { id: "access.reveal", keys: "⌥ (mantener)", action: "Mostrar la letra de cada acción visible; ⌥ + esa letra la ejecuta", category: "Teclas de acceso", wiredIn: { file: ACCESS_KEY, token: "altHeld" } },

  // --- Cobro (PaymentDialog) --------------------------------------------------
  { id: "payment.cash", keys: "⌥1", action: "Método efectivo en el cobro", category: "Cobro", alt: true, code: "Digit1", wiredIn: { file: PAYMENT, token: "PAYMENT_METHOD_ACCESS_KEYS" } },
  { id: "payment.card", keys: "⌥2", action: "Método tarjeta (datáfono) en el cobro", category: "Cobro", alt: true, code: "Digit2", wiredIn: { file: PAYMENT, token: "PAYMENT_METHOD_ACCESS_KEYS" } },
  { id: "payment.transfer", keys: "⌥3", action: "Método transferencia en el cobro", category: "Cobro", alt: true, code: "Digit3", wiredIn: { file: PAYMENT, token: "PAYMENT_METHOD_ACCESS_KEYS" } },
  { id: "payment.submit", keys: "Intro", action: "Cobrar (con el foco en el importe o la referencia)", category: "Cobro", wiredIn: { file: PAYMENT, token: "onSubmit" } },

  // --- Paleta de comandos -----------------------------------------------------
  { id: "palette.move", keys: "↑ ↓", action: "Moverse por los resultados", category: "Paleta de comandos", wiredIn: { file: PALETTE, token: '"ArrowDown"' } },
  { id: "palette.enter", keys: "Intro", action: "Abrir el resultado o ejecutar el comando seleccionado", category: "Paleta de comandos", wiredIn: { file: PALETTE, token: '"Enter"' } },
  { id: "palette.escape", keys: "Esc", action: "Cerrar la paleta", category: "Paleta de comandos", wiredIn: { file: PALETTE, token: '"Escape"' } },

  // --- Pestañas de una pantalla ----------------------------------------------
  { id: "tabs.move", keys: "← →", action: "Moverse entre pestañas", category: "Pestañas de una pantalla", wiredIn: { file: "apps/admin-web/src/components/cocoa/CocoaRouteTabs.tsx", token: '"ArrowRight"' } },
  { id: "tabs.ends", keys: "Inicio / Fin", action: "Primera / última pestaña", category: "Pestañas de una pantalla", wiredIn: { file: "apps/admin-web/src/components/cocoa/CocoaRouteTabs.tsx", token: '"Home"' } },
  { id: "tabs.activate", keys: "Intro / Espacio", action: "Abrir la pestaña seleccionada", category: "Pestañas de una pantalla", wiredIn: { file: "apps/admin-web/src/components/cocoa/CocoaRouteTabs.tsx", token: 'role="tab"' } },

  // --- Recorrido guiado -------------------------------------------------------
  { id: "tour.next", keys: "→", action: "Paso siguiente", category: "Recorrido guiado", wiredIn: { file: "apps/admin-web/src/components/cocoa-guidance/CocoaGuidedTour.tsx", token: '"ArrowRight"' } },
  { id: "tour.prev", keys: "←", action: "Paso anterior", category: "Recorrido guiado", wiredIn: { file: "apps/admin-web/src/components/cocoa-guidance/CocoaGuidedTour.tsx", token: '"ArrowLeft"' } },
  { id: "tour.escape", keys: "Esc", action: "Salir del recorrido", category: "Recorrido guiado", wiredIn: { file: "apps/admin-web/src/components/cocoa-guidance/CocoaGuidedTour.tsx", token: '"Escape"' } },

  // --- Modo prueba (solo con VITE_UX_TRACE=1; lote U1, §8.4 C) ----------------
  { id: "trace.next-task", keys: "⌘⇧T", action: "Pasar a la tarea siguiente de la sesión de prueba (solo con el modo prueba activo)", category: "Modo prueba", mod: true, shift: true, code: "KeyT", wiredIn: { file: UX_TRACE, token: 'isTaskShortcut(event, "t")' } },
  { id: "trace.export", keys: "⌘⇧E", action: "Exportar la sesión de prueba (solo con el modo prueba activo)", category: "Modo prueba", mod: true, shift: true, code: "KeyE", wiredIn: { file: UX_TRACE, token: 'isTaskShortcut(event, "e")' } }
];

/** Los atajos ⌥+letra de navegación que BackOfficeLayout registra en CocoaGlobalProvider. */
export const GLOBAL_ALT_SHORTCUTS: readonly ShortcutEntry[] = SHORTCUTS.filter((entry) => entry.category === "Navegación con ⌥" && entry.alt === true && Boolean(entry.code));

/** Letras reservadas por la navegación global: una tecla de acceso (`CocoaButton accessKey`) no debe reutilizarlas. */
export const RESERVED_ACCESS_LETTERS: readonly string[] = GLOBAL_ALT_SHORTCUTS.map((entry) => letterOfCode(entry.code ?? "")).filter((letter): letter is string => Boolean(letter));

/** «KeyH» → «H», «Digit1» → «1»; otras teclas → null. */
export function letterOfCode(code: string): string | null {
  const match = /^(?:Key|Digit)([A-Z0-9])$/.exec(code);
  return match ? match[1] : null;
}

/** Combinación que acepta `useCocoaShortcuts().register` («Alt+KeyH», «Mod+Shift+KeyT»). */
export function shortcutCombo(entry: Pick<ShortcutEntry, "code" | "alt" | "mod" | "shift">): string | null {
  if (!entry.code) return null;
  const parts: string[] = [];
  if (entry.mod) parts.push("Mod");
  if (entry.alt) parts.push("Alt");
  if (entry.shift) parts.push("Shift");
  parts.push(entry.code);
  return parts.join("+");
}

export function shortcutById(id: string): ShortcutEntry | undefined {
  return SHORTCUTS.find((entry) => entry.id === id);
}

/** Teclas de un atajo por id («⌥H»); lanza si el id no existe (la guía nunca cita un atajo que no está cableado). */
export function shortcutKeys(id: string): string {
  const entry = shortcutById(id);
  if (!entry) throw new Error(`shortcuts-registry: atajo desconocido «${id}»`);
  return entry.keys;
}

export interface CatalogShortcut {
  readonly keys: string;
  readonly action: string;
}

export interface CatalogCategory {
  readonly category: string;
  readonly shortcuts: readonly CatalogShortcut[];
}

/** El catálogo de ayuda tal y como lo escribe scripts/gen-shortcuts.mjs (categorías en CATEGORY_ORDER, entradas en orden de registro). */
export function shortcutCatalog(entries: readonly ShortcutEntry[] = SHORTCUTS): CatalogCategory[] {
  return CATEGORY_ORDER.map((category) => ({
    category,
    shortcuts: entries.filter((entry) => entry.category === category).map((entry) => ({ keys: entry.keys, action: entry.action }))
  })).filter((category) => category.shortcuts.length > 0);
}

/** Campo de texto o editable: ahí los atajos ⌥+letra no actúan ni hacen `preventDefault` (R8). */
export function isTextEntryTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const element = target as { tagName?: string; type?: string; isContentEditable?: boolean; readOnly?: boolean };
  if (element.isContentEditable) return true;
  const tag = (element.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA") return true;
  if (tag !== "INPUT") return false;
  const type = (element.type ?? "text").toLowerCase();
  return !["button", "submit", "reset", "checkbox", "radio", "file", "range", "color", "image"].includes(type);
}

type DocLike = { querySelectorAll: (selector: string) => ArrayLike<{ closest?: (selector: string) => unknown }> };

/** Hay un diálogo modal visible (CocoaDialog, CocoaDrawer, paleta, recorrido): la navegación ⌥ no debe saltar por encima. */
export function modalDialogOpen(doc: DocLike | null | undefined): boolean {
  if (!doc) return false;
  const dialogs = doc.querySelectorAll('[role="dialog"][aria-modal="true"]');
  for (let index = 0; index < dialogs.length; index += 1) {
    const dialog = dialogs[index];
    if (typeof dialog.closest === "function" && dialog.closest('[aria-hidden="true"]')) continue;
    return true;
  }
  return false;
}
