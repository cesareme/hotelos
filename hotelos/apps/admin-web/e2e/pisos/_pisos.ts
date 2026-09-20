import { expect, type APIRequestContext, type Locator, type Page, type Response } from "@playwright/test";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { E2E_API_URL, UXDAY, loginAsUxDay, type UxDaySession } from "../_helpers";

/**
 * Helpers de pisos y mantenimiento (Tanda UX-3 · lote U0, ampliados por Q1 ·
 * docs/design/UX-PISOS-MANTENIMIENTO-FEEL.md §7): constantes del tenant UXDAY
 * (usuarios que siembra packages/database/prisma/seed-ux-day-pisos.ts), rutas
 * del árbol de navegación, esperas de «pantalla lista», elección de la
 * habitación / el parte por API (nunca por texto de la pantalla), el estado
 * verificable en datos tras cada tarea y, desde Q1, los localizadores del
 * camino nuevo (chips de sección y de alcance, tarjeta «Siguiente», diálogo
 * nominal de bloqueo), la espera de las escrituras DIFERIDAS (§5: «Limpia»,
 * «Inspeccionar», «Resuelta», «Resolver» viajan a los 8 s) y una foto PNG
 * generada para «Reportar» (p4).
 *
 * Sesiones: cada `test.use({ viewport, hasTouch })` abre un worker nuevo y
 * `loginAsUxDay` (e2e/_helpers.ts) memoriza la sesión solo en memoria del
 * worker; con seis specs × dos variantes y hasta dos personas por tarea se
 * superaría el límite de 10 logins/min por IP (server.ts POST /auth/login).
 * `loginAsPisos` reutiliza la sesión desde una caché en el directorio temporal
 * del sistema (por correo y API, 30 min, comprobada con GET /auth/sessions) y
 * la escribe en la página con las MISMAS claves que loginAsUxDay; solo si no
 * hay sesión válida hace el login real a través de loginAsUxDay.
 */

export const PISOS = {
  users: {
    pisos: "pisos@uxday.test",
    gobernanta: "gobernanta@uxday.test",
    mantenimiento: "mantenimiento@uxday.test",
    encargado: "encargado@uxday.test"
  },
  routes: {
    pisos: "/operaciones/pisos",
    miTurno: "/operaciones/pisos/mi-turno",
    mantenimiento: "/operaciones/mantenimiento",
    misAverias: "/operaciones/mantenimiento/mis-averias",
    tablero: "/recepcion/reservas/tablero"
  },
  viewports: {
    raton: { width: 1280, height: 900 },
    tablet: { width: 820, height: 1180 }
  },
  ids: {
    /** Tareas de las habitaciones sucias de p1 (seed-ux-day-pisos: hkt_uxday_p1_1…5). */
    p1TaskPrefix: "hkt_uxday_p1_",
    p5: ["wo_uxday_p5a", "wo_uxday_p5b"],
    p6: ["wo_uxday_p6a", "wo_uxday_p6b"]
  },
  /** Habitaciones que usan las specs t1…t6 y de humo (seed-ux-day.ts): p3 no crea tareas en ellas. */
  reservedRooms: new Set([101, 102, 103, 104, 110, 111, 204, 205, 206, 207, 212, 213, 217, 218, 219, 220, 305, 306, 310, 311, 312, 401])
} as const;

export type PisosVariant = keyof typeof PISOS.viewports;

/**
 * Ventana de «Deshacer» de las escrituras diferidas (§5, D7): la duración del
 * toast con acción (components/cocoa/CocoaToast ACTION_DURATION = 8 s). La
 * petición viaja al agotarse (o al salir de la pantalla / pagehide); una
 * verificación por API antes de ese momento ve el estado ANTERIOR.
 */
export const DEFERRED_WRITE_MS = 8000;

/** Margen de espera para una escritura diferida: la ventana entera más el viaje al API. */
export const DEFERRED_WRITE_TIMEOUT_MS = DEFERRED_WRITE_MS + 12_000;

// ---------------------------------------------------------------------------
// Sesión con caché en disco
// ---------------------------------------------------------------------------

type CachedSession = { token: string; user: UxDaySession["user"]; at: number };
const SESSION_CACHE_PATH = join(tmpdir(), "ehotelos-e2e-pisos-sessions.json");
const SESSION_TTL_MS = 30 * 60 * 1000;

function readSessionCache(): Record<string, CachedSession> {
  try {
    return JSON.parse(readFileSync(SESSION_CACHE_PATH, "utf8")) as Record<string, CachedSession>;
  } catch {
    return {};
  }
}

function writeSessionCache(cache: Record<string, CachedSession>): void {
  mkdirSync(dirname(SESSION_CACHE_PATH), { recursive: true });
  const tmp = `${SESSION_CACHE_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache), "utf8");
  renameSync(tmp, SESSION_CACHE_PATH);
}

async function cachedSession(request: APIRequestContext, email: string): Promise<UxDaySession | null> {
  const entry = readSessionCache()[`${E2E_API_URL} ${email}`];
  if (!entry || Date.now() - entry.at > SESSION_TTL_MS) return null;
  const probe = await request.get(`${E2E_API_URL}/auth/sessions`, { headers: { Authorization: `Bearer ${entry.token}` } }).catch(() => null);
  if (!probe || !probe.ok()) return null;
  return { token: entry.token, user: entry.user };
}

/** Sesión real de `email` (caché en disco → loginAsUxDay) persistida en la página antes de la primera navegación. */
export async function loginAsPisos(page: Page, request: APIRequestContext, email: string): Promise<UxDaySession> {
  const cached = await cachedSession(request, email);
  if (cached) {
    // Mismas claves que loginAsUxDay (e2e/_helpers.ts; contrato tests/seed-ux-day-contract.test.mjs).
    await page.addInitScript(
      ({ token, user, active }) => {
        try {
          window.localStorage.setItem("hotelos.auth.token", token);
          window.localStorage.setItem("hotelos.auth.user", JSON.stringify(user));
          window.localStorage.setItem("hotelos.auth.deviceId", "e2e");
          window.localStorage.setItem("hotelos-active-property", active.propertyId);
          window.localStorage.setItem("hotelos-active-org", active.organizationId);
          window.localStorage.setItem("hotelos-active-property-name", active.propertyName);
          window.localStorage.setItem("hotelos.guide.v1", JSON.stringify({ tourCompleted: true, welcomeDismissed: true, seenRoles: [] }));
        } catch {
          /* localStorage no disponible: la spec fallará en assertNoLoginGate con diagnóstico */
        }
      },
      { token: cached.token, user: cached.user, active: { propertyId: UXDAY.propertyId, organizationId: UXDAY.organizationId, propertyName: UXDAY.propertyName } }
    );
    return cached;
  }
  const session = await loginAsUxDay(page, request, { email });
  const cache = readSessionCache();
  cache[`${E2E_API_URL} ${email}`] = { token: session.token, user: session.user, at: Date.now() };
  writeSessionCache(cache);
  return session;
}

export function apiHeaders(session: UxDaySession): Record<string, string> {
  return { Authorization: `Bearer ${session.token}`, "x-property-id": UXDAY.propertyId };
}

// ---------------------------------------------------------------------------
// Lecturas por API (elección y verificación)
// ---------------------------------------------------------------------------

export type MiTurnoRoom = {
  roomId: string;
  roomNumber: string;
  housekeepingStatus?: string;
  priority: string;
  taskId?: string;
  taskStatus?: string;
  openIncidents: number;
  /** Sección de pisos (P2, aditivo en GET /dashboards/housekeeping-mobile). */
  sectionId?: string;
  sectionName?: string;
};
export type MiTurnoSection = { id: string; name: string; code?: string; total: number };
export type MiTurnoData = { rooms: MiTurnoRoom[]; sections: MiTurnoSection[] };
export type BoardRoom = { id: string; number: string; status: string; housekeepingStatus: string; maintenanceStatus: string; sellable: boolean };
export type BoardTask = { id: string; taskType: string; status: string; priority?: string; assignedTo?: string | null };
export type BoardItem = { room: BoardRoom; tasks: BoardTask[] };
export type WorkOrderRow = { id: string; roomId?: string | null; title: string; priority: string; status: string; blocksRoom: boolean; assignedTo?: string | null; createdAt?: string };
export type WorkOrderMediaMeta = { id: string; mimeType?: string | null; sizeBytes?: number | null; inline?: boolean };
export type MaintMobileItem = { workOrderId: string; title: string; status: string; roomNumber?: string; assignedTo?: string; mediaCount: number };

const byNumber = (a: { roomNumber?: string; number?: string }, b: { roomNumber?: string; number?: string }) =>
  (a.roomNumber ?? a.number ?? "").localeCompare(b.roomNumber ?? b.number ?? "", "es", { numeric: true });

async function getJson<T>(request: APIRequestContext, session: UxDaySession, path: string): Promise<T> {
  const response = await request.get(`${E2E_API_URL}${path}`, { headers: apiHeaders(session) });
  expect(response.ok(), `GET ${path} → ${response.status()}`).toBeTruthy();
  return (await response.json()) as T;
}

/** GET /dashboards/housekeeping-mobile completo (habitaciones y secciones; analytics.read: camarera y gobernanta). */
export async function fetchMiTurnoData(request: APIRequestContext, session: UxDaySession): Promise<MiTurnoData> {
  const data = await getJson<{ rooms?: MiTurnoRoom[]; sections?: MiTurnoSection[] }>(request, session, `/dashboards/housekeeping-mobile?propertyId=${UXDAY.propertyId}`);
  return { rooms: data.rooms ?? [], sections: data.sections ?? [] };
}

/** GET /dashboards/housekeeping-mobile (lo que pinta Mi turno, en el orden del API). */
export async function fetchMiTurno(request: APIRequestContext, session: UxDaySession): Promise<MiTurnoRoom[]> {
  return (await fetchMiTurnoData(request, session)).rooms;
}

/** GET /properties/:id/housekeeping/board (housekeeping.read: las cuatro personas). */
export async function fetchBoard(request: APIRequestContext, session: UxDaySession): Promise<BoardItem[]> {
  const data = await getJson<BoardItem[] | { items?: BoardItem[] }>(request, session, `/properties/${UXDAY.propertyId}/housekeeping/board`);
  return Array.isArray(data) ? data : (data.items ?? []);
}

/** GET /properties/:id/work-orders (maintenance.read: gobernanta, técnico y encargado). */
export async function fetchWorkOrders(request: APIRequestContext, session: UxDaySession): Promise<WorkOrderRow[]> {
  const data = await getJson<WorkOrderRow[] | { items?: WorkOrderRow[] }>(request, session, `/properties/${UXDAY.propertyId}/work-orders?limit=500`);
  return Array.isArray(data) ? data : (data.items ?? []);
}

/** GET /work-orders/:id/media (M1: metadatos de las fotos del parte, sin bytes; maintenance.read). */
export async function fetchWorkOrderMedia(request: APIRequestContext, session: UxDaySession, workOrderId: string): Promise<WorkOrderMediaMeta[]> {
  const data = await getJson<WorkOrderMediaMeta[] | { items?: WorkOrderMediaMeta[] }>(request, session, `/work-orders/${encodeURIComponent(workOrderId)}/media`);
  return Array.isArray(data) ? data : (data.items ?? []);
}

/** GET /dashboards/maintenance-mobile (lo que pinta Mis averías: `items[].mediaCount`; analytics.read). */
export async function fetchMisAverias(request: APIRequestContext, session: UxDaySession): Promise<MaintMobileItem[]> {
  const data = await getJson<{ items?: MaintMobileItem[] }>(request, session, `/dashboards/maintenance-mobile?propertyId=${UXDAY.propertyId}`);
  return data.items ?? [];
}

/** Habitación sucia del seed (tarea hkt_uxday_p1_* pendiente) con el número más bajo; null si no queda ninguna. */
export async function pickDirtyRoom(request: APIRequestContext, session: UxDaySession): Promise<MiTurnoRoom | null> {
  const rooms = await fetchMiTurno(request, session);
  return rooms.filter((r) => r.housekeepingStatus === "dirty" && r.taskId?.startsWith(PISOS.ids.p1TaskPrefix) && r.taskStatus === "pending").sort(byNumber)[0] ?? null;
}

/** Habitación limpia, sin tareas abiertas, vendible y fuera de las de las specs t*, con el número más bajo. */
export async function pickCleanRoomWithoutTasks(request: APIRequestContext, session: UxDaySession): Promise<BoardRoom | null> {
  const board = await fetchBoard(request, session);
  return (
    board
      .filter((i) => i.room.housekeepingStatus === "clean" && i.tasks.length === 0 && i.room.sellable && i.room.maintenanceStatus === "ok" && !PISOS.reservedRooms.has(Number(i.room.number)))
      .map((i) => i.room)
      .sort(byNumber)[0] ?? null
  );
}

/** Primer parte de `ids` (en ese orden) que cumple `where`; null si ninguno. */
export async function pickWorkOrder(request: APIRequestContext, session: UxDaySession, ids: readonly string[], where: (w: WorkOrderRow) => boolean): Promise<WorkOrderRow | null> {
  const orders = await fetchWorkOrders(request, session);
  for (const id of ids) {
    const order = orders.find((w) => w.id === id);
    if (order && where(order)) return order;
  }
  return null;
}

export async function workOrderById(request: APIRequestContext, session: UxDaySession, id: string): Promise<WorkOrderRow | null> {
  return (await fetchWorkOrders(request, session)).find((w) => w.id === id) ?? null;
}

/** Estado unificado de la habitación (tablero de pisos). */
export async function roomState(request: APIRequestContext, session: UxDaySession, roomId: string): Promise<BoardRoom | null> {
  return (await fetchBoard(request, session)).find((i) => i.room.id === roomId)?.room ?? null;
}

/** Tareas abiertas de la habitación en el tablero (el board solo lista las no cerradas: una tarea `done` desaparece). */
export async function openTasksOf(request: APIRequestContext, session: UxDaySession, roomId: string): Promise<BoardTask[]> {
  return (await fetchBoard(request, session)).find((i) => i.room.id === roomId)?.tasks ?? [];
}

// ---------------------------------------------------------------------------
// Pantalla
// ---------------------------------------------------------------------------

/** Pantalla lista: los chips de filtro solo se pintan con datos (CocoaPage state="ready"). */
export async function waitForChips(page: Page, label: string): Promise<void> {
  await expect(page.getByRole("group", { name: label })).toBeVisible({ timeout: 20_000 });
}

/** Mi turno listo (HousekeepingMobileScreen: «Filtrar por prioridad»). */
export async function waitForMiTurno(page: Page): Promise<void> {
  await waitForChips(page, "Filtrar por prioridad");
}

/** Tablero de pisos listo (HousekeepingDashboard: «Filtrar habitaciones»). */
export async function waitForTableroPisos(page: Page): Promise<void> {
  await waitForChips(page, "Filtrar habitaciones");
}

/** Tablero de mantenimiento listo (MaintenanceDashboard: «Filtrar órdenes»). */
export async function waitForMantenimiento(page: Page): Promise<void> {
  await waitForChips(page, "Filtrar órdenes");
}

/** Mis averías listo (MaintenanceMobileScreen: «Filtrar por prioridad»). */
export async function waitForMisAverias(page: Page): Promise<void> {
  await waitForChips(page, "Filtrar por prioridad");
}

/** Tarjeta de habitación de Mi turno o del tablero de pisos (`role="group"` + «Habitación NNN»). */
export function roomCard(page: Page, number: string): Locator {
  return page.getByRole("group", { name: `Habitación ${number}`, exact: true });
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Tarjeta de parte de Mis averías (`role="group"` + «Avería <título>»). */
export function workOrderCard(page: Page, title: string): Locator {
  return page.getByRole("group", { name: new RegExp(`^Avería ${escapeRegExp(title)}$`) });
}

/** Toast del ToastHost (`data-cocoa="toast"`) que contiene el texto. */
export function toastContaining(page: Page, text: string | RegExp): Locator {
  return page.locator('[data-cocoa="toast"]').filter({ hasText: text }).first();
}

/** ¿El toast ofrece «Deshacer»? (P4: deshacer antes que confirmar; el botón es alcanzable con Tab). */
export async function toastOffersUndo(toast: Locator): Promise<boolean> {
  return toast.getByRole("button", { name: "Deshacer", exact: true }).isVisible().catch(() => false);
}

/** Botón «Cerrar instrucciones» de la tarjeta de ayuda si está visible (con ratón, la primera vez en cada contexto; con el dedo va plegada bajo la lista, D9). */
export async function instructionsCloseButton(page: Page): Promise<Locator | null> {
  const button = page.getByRole("button", { name: "Cerrar instrucciones" }).first();
  return (await button.isVisible().catch(() => false)) ? button : null;
}

/** Chip de sección de Mi turno («Planta 1 · 5», «Todas · 12»; grupo «Filtrar por sección», P2). */
export function sectionChip(page: Page, name: string): Locator {
  return page.getByRole("group", { name: "Filtrar por sección" }).getByRole("button", { name: new RegExp(`^${escapeRegExp(name)} · `) });
}

/** Tarjeta «Siguiente» de Mi turno (§4.2): la única tarjeta de la sección titulada «Siguiente». */
export function nextRoomCard(page: Page): Locator {
  return page
    .locator('[data-cocoa="section"]')
    .filter({ has: page.getByRole("heading", { name: "Siguiente", exact: true }) })
    .getByRole("group", { name: /^Habitación \d+/ })
    .first();
}

/** Número de la habitación de una tarjeta (`aria-label="Habitación NNN"`). */
export async function roomNumberOfCard(card: Locator): Promise<string> {
  return ((await card.getAttribute("aria-label")) ?? "").replace(/^Habitación\s+/, "");
}

/** Chip de alcance de Mis averías («Mías · 1» / «Todas · 6»; grupo «Mías o todas», §4.4). */
export function scopeChip(page: Page, label: "Mías" | "Todas"): Locator {
  return page.getByRole("group", { name: "Mías o todas" }).getByRole("button", { name: new RegExp(`^${label} · `) });
}

/** Diálogo nominal de bloqueo («Bloquear la 305» / «Mantenerla en venta», §4.3 y §4.5). */
export function blockRoomDialog(page: Page, number: string): Locator {
  return page.getByRole("dialog", { name: `Bloquear la ${number}`, exact: true });
}

/**
 * Respuesta del API a una escritura de la página (método + sufijo de ruta). Se
 * registra ANTES del clic; para una escritura diferida el plazo cubre la ventana
 * de «Deshacer» (8 s) y el viaje.
 */
export function waitForApiResponse(page: Page, method: string, pathSuffix: string, timeout = DEFERRED_WRITE_TIMEOUT_MS): Promise<Response> {
  return page.waitForResponse((response) => response.request().method() === method && response.url().startsWith(E2E_API_URL) && new URL(response.url()).pathname.endsWith(pathSuffix), { timeout });
}

/** Tablet: además de `hasTouch`, fija por CDP `pointer: coarse` / `hover: none` (como e2e/target-size.spec.ts). */
export async function forceCoarse(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: "coarse" }, { name: "hover", value: "none" }] });
}

// ---------------------------------------------------------------------------
// Foto de prueba (p4): PNG válido generado en Node, sin ficheros ni dependencias
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * PNG RGB de `width` × `height` con un degradado (comprime bien): con el lado
 * largo > 1.600 px el cajón «Reportar» lo pasa por capture-compress.ts (canvas
 * → JPEG), como una foto de la cámara de la tablet. Nunca se guarda en disco.
 */
export function makeTestPng(width = 1800, height = 1350): Buffer {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride;
    raw[rowStart] = 0; // filtro «None»
    for (let x = 0; x < width; x += 1) {
      const offset = rowStart + 1 + x * 3;
      raw[offset] = (x * 255) / width;
      raw[offset + 1] = (y * 255) / height;
      raw[offset + 2] = ((x + y) * 127) / (width + height);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // profundidad
  ihdr[9] = 2; // color RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}
