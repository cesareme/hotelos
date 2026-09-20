import { expect, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";

/**
 * Helpers de e2e (Tanda UX-1 · lote U1 · docs/design/UX-RECEPCION-FEEL.md §8.6).
 *
 * Dev-bypass de login: `loginAsUxDay(page, request)` hace un POST /auth/login
 * REAL contra el API de pruebas (E2E_API_URL) con un usuario del tenant
 * aislado `UXDAY` (packages/database/prisma/seed-ux-day.ts) y escribe la sesión
 * en localStorage ANTES de que cargue la app (page.addInitScript), con las
 * mismas claves que LoginScreen + services/auth-storage.ts y la propiedad
 * activa de services/activeProperty.ts. La app arranca ya autenticada en el
 * hotel de prueba; el recorrido de bienvenida queda descartado para que los
 * diálogos no tapen la columna «Acciones».
 *
 * La sesión se memoriza por correo dentro del proceso worker: el login tiene
 * un límite de 10/min por IP (server.ts POST /auth/login) y una suite entera
 * cabe en un solo login por usuario.
 */

export const E2E_API_URL = (process.env.E2E_API_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");

export const UXDAY = {
  organizationId: "org_uxday",
  propertyId: "prop_uxday",
  propertyName: "Hotel UXDAY (prueba)",
  password: process.env.E2E_UXDAY_PASSWORD ?? "uxday-demo",
  users: {
    recepcion: "recepcion@uxday.test",
    direccion: "direccion@uxday.test",
    sistemas: "sistemas@uxday.test"
  }
} as const;

export type UxDaySession = {
  token: string;
  /** Payload `user` de POST /auth/login + `email` (tipo AuthUser de services/auth-storage.ts). */
  user: Record<string, unknown> & { email: string };
};

const sessionCache = new Map<string, UxDaySession>();

async function loginViaApi(request: APIRequestContext, email: string): Promise<UxDaySession> {
  const cached = sessionCache.get(email);
  if (cached) return cached;
  const response = await request.post(`${E2E_API_URL}/auth/login`, {
    data: { email, password: UXDAY.password, deviceId: "e2e" }
  });
  if (!response.ok()) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `[e2e] POST ${E2E_API_URL}/auth/login como ${email} → ${response.status()} ${body.slice(0, 200)}. ` +
        "¿Está el API de pruebas arrancado y el seed ejecutado (corepack pnpm --filter @hotelos/database db:seed:ux-day)?"
    );
  }
  const payload = (await response.json()) as { token: string; user: Record<string, unknown> };
  const session: UxDaySession = { token: payload.token, user: { ...payload.user, email } };
  sessionCache.set(email, session);
  return session;
}

/**
 * Autentica al usuario de recepción del tenant UXDAY (o al indicado en
 * `options.email`) y deja la sesión persistida antes de la primera navegación.
 * Sin overrides CSS (corrector UX1-REV-08 / R8): el velo de los drawers lo
 * pinta styles/cocoa-22.css (`.c22-scrim[data-open] { display: block; }`, U4) y
 * quick-checkin.spec lo comprueba sobre el CSS real.
 */
export async function loginAsUxDay(
  page: Page,
  request: APIRequestContext,
  options: { email?: string } = {}
): Promise<UxDaySession> {
  const email = options.email ?? UXDAY.users.recepcion;
  const session = await loginViaApi(request, email);
  await page.addInitScript(
    ({ token, user, active }) => {
      try {
        window.localStorage.setItem("hotelos.auth.token", token);
        window.localStorage.setItem("hotelos.auth.user", JSON.stringify(user));
        window.localStorage.setItem("hotelos.auth.deviceId", "e2e");
        window.localStorage.setItem("hotelos-active-property", active.propertyId);
        window.localStorage.setItem("hotelos-active-org", active.organizationId);
        window.localStorage.setItem("hotelos-active-property-name", active.propertyName);
        // Recorrido de bienvenida ya visto (components/guide/guideStore.ts): sin diálogos encima de las tablas.
        window.localStorage.setItem("hotelos.guide.v1", JSON.stringify({ tourCompleted: true, welcomeDismissed: true, seenRoles: [] }));
      } catch {
        /* localStorage no disponible: la spec fallará en assertNoLoginGate con diagnóstico */
      }
    },
    {
      token: session.token,
      user: session.user,
      active: { propertyId: UXDAY.propertyId, organizationId: UXDAY.organizationId, propertyName: UXDAY.propertyName }
    }
  );
  return session;
}

export type UxDayRoom = { id: string; number: string; roomTypeId: string; status: string; housekeepingStatus?: string; sellable?: boolean };

/**
 * Habitaciones que otras reservas vivas (confirmed / checked_in) tienen asignadas
 * en la ventana de una estancia: el API (inventory.engine canAssignRoom) rechaza
 * con 409 el check-in o el traslado a ellas aunque `rooms.status` diga «libre»
 * (una reserva conservada con factura o una llegada confirmada con habitación).
 */
export async function heldRooms(
  request: APIRequestContext,
  headers: Record<string, string>,
  stay: { arrivalDate: string; departureDate: string },
  exceptId = ""
): Promise<Set<string>> {
  const url = `${E2E_API_URL}/properties/${UXDAY.propertyId}/reservations?from=${stay.arrivalDate.slice(0, 10)}&to=${stay.departureDate.slice(0, 10)}&status=confirmed,checked_in&limit=500&envelope=1`;
  const payload = (await (await request.get(url, { headers })).json()) as { items?: Array<{ id: string; assignedRoomId?: string | null }> } | Array<{ id: string; assignedRoomId?: string | null }>;
  const items = Array.isArray(payload) ? payload : (payload.items ?? []);
  return new Set(items.filter((item) => item.id !== exceptId && item.assignedRoomId).map((item) => item.assignedRoomId as string));
}

const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * Salida de prueba creada por API: llegó ayer, sale hoy, alojada en la Doble libre,
 * limpia y sin otra reserva de número MÁS ALTO (el seed deja 217-220 para esto; la
 * sugerencia «primera por número» del check-in y del walk-in se queda con 101-104)
 * y `balance` € de minibar sin cobrar (el cargo de alojamiento lo asienta el cierre
 * del día). Sin factura la borra `seed-ux-day --reset`; si la spec emite la factura
 * con número, el reset la conserva pero la cierra (no retiene la habitación).
 */
export async function provisionDeparture(
  request: APIRequestContext,
  headers: Record<string, string>,
  options: { balance: number; guest: { firstName: string; surname1: string } }
): Promise<{ id: string; code: string; room: UxDayRoom; balance: number }> {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const stay = { arrivalDate: isoDate(yesterday), departureDate: isoDate(today) };
  const rooms = (await (await request.get(`${E2E_API_URL}/properties/${UXDAY.propertyId}/rooms`, { headers })).json()) as UxDayRoom[];
  const held = await heldRooms(request, headers, stay);
  const free = rooms
    .filter((room) => room.roomTypeId === "rt_uxday_dbl" && !held.has(room.id) && room.sellable !== false && room.status !== "occupied" && room.housekeepingStatus === "clean")
    .sort((a, b) => b.number.localeCompare(a.number, "es", { numeric: true }));
  expect(free.length, "sin Doble libre, limpia y sin otra reserva para la salida de prueba (rearma el seed con --reset)").toBeGreaterThan(0);
  const room = free[0];
  const created = await request.post(`${E2E_API_URL}/properties/${UXDAY.propertyId}/reservations`, {
    headers,
    // Llegó ayer: llegada pasada confirmada (L-02: sin `allowPastArrival` el API responde 400 PAST_ARRIVAL_DATE).
    data: { ...stay, adults: 2, roomTypeId: "rt_uxday_dbl", assignedRoomId: room.id, channel: "direct", bookingSource: "walk_in", currency: "EUR", primaryGuest: options.guest, allowPastArrival: true }
  });
  expect(created.ok(), `POST reservations → ${created.status()}`).toBeTruthy();
  const reservation = (await created.json()) as { id: string; code: string };
  const checkedIn = await request.post(`${E2E_API_URL}/reservations/${reservation.id}/check-in`, { headers, data: { roomId: room.id } });
  expect(checkedIn.ok(), `POST check-in → ${checkedIn.status()}`).toBeTruthy();
  const folio = (await (await request.get(`${E2E_API_URL}/reservations/${reservation.id}/folio`, { headers })).json()) as { folio: { id: string } };
  const line = await request.post(`${E2E_API_URL}/folios/${folio.folio.id}/lines`, { headers, data: { type: "minibar", description: "Minibar", quantity: 1, unitPrice: options.balance } });
  expect(line.ok(), `POST folio line → ${line.status()}`).toBeTruthy();
  return { id: reservation.id, code: reservation.code, room, balance: options.balance };
}

/**
 * Llegada de prueba creada por API (CIERRE-1 · C4a): llega hoy, sale mañana, Doble
 * SIN habitación asignada (como UXDAY-A2: la fila y el inspector ofrecen «Check-in
 * en NNN» con la candidata del motor), sin cargos ni cobros. La fila de Mi día no
 * pinta el código, así que —como hace el seed con UXDAY-A2— se deja en «Peticiones»
 * (`specialRequests`, PATCH con pms.reservation.modify) para que la spec localice la
 * fila por `code`. La spec «solo teclado» de quick-checkin.spec la registra, así no
 * depende de UXDAY-A2/A3, del orden de specs ni del proyecto «measure». Sin factura
 * la borra `db:seed:ux-day -- --reset`.
 */
export async function provisionArrival(
  request: APIRequestContext,
  headers: Record<string, string>,
  options: { guest: { firstName: string; surname1: string } }
): Promise<{ id: string; code: string }> {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const created = await request.post(`${E2E_API_URL}/properties/${UXDAY.propertyId}/reservations`, {
    headers,
    data: { arrivalDate: isoDate(today), departureDate: isoDate(tomorrow), adults: 2, roomTypeId: "rt_uxday_dbl", channel: "direct", bookingSource: "walk_in", currency: "EUR", primaryGuest: options.guest }
  });
  expect(created.ok(), `POST reservations → ${created.status()}`).toBeTruthy();
  const reservation = (await created.json()) as { id: string; code: string };
  const noted = await request.patch(`${E2E_API_URL}/reservations/${reservation.id}`, { headers, data: { specialRequests: `${reservation.code} · llegada de prueba solo teclado` } });
  expect(noted.ok(), `PATCH reservations/${reservation.code} (specialRequests) → ${noted.status()}`).toBeTruthy();
  return { id: reservation.id, code: reservation.code };
}

/**
 * Diagnóstico: si tras el dev-bypass sigue apareciendo la LoginScreen (botón
 * «Iniciar sesión»), la spec FALLA con el motivo (sesión no persistida, API
 * distinto al de la app, usuario sin propiedad). Nunca se salta.
 */
export async function assertNoLoginGate(page: Page, testInfo?: TestInfo): Promise<void> {
  const loginButton = page.getByRole("button", { name: /Iniciar sesión/i });
  const visible = await loginButton.isVisible().catch(() => false);
  if (visible) {
    // eslint-disable-next-line no-console
    console.log(`[e2e:${testInfo?.title ?? "spec"}] LoginScreen visible tras el dev-bypass: revisa E2E_API_URL=${E2E_API_URL} y el seed UXDAY.`);
  }
  expect(visible, "LoginScreen visible tras loginAsUxDay: el dev-bypass no ha dejado sesión").toBe(false);
}

/** @deprecated Solo diagnóstico (U1): equivale a assertNoLoginGate y ya no salta la spec. */
export async function skipIfLoginGate(page: Page, testInfo: TestInfo): Promise<boolean> {
  await assertNoLoginGate(page, testInfo);
  return false;
}

/** Descarta el aviso de bienvenida si aún se renderiza (por ejemplo, con una sesión reutilizada). */
export async function dismissWelcome(page: Page): Promise<void> {
  const welcome = page.getByRole("dialog", { name: "Recorrido guiado" });
  if (await welcome.isVisible().catch(() => false)) {
    const later = welcome.getByRole("button", { name: /Ahora no|Más tarde|Cerrar|Saltar/i }).first();
    if (await later.isVisible().catch(() => false)) await later.click();
  }
}

/**
 * Navega a la primera ruta que responde sin 404 (vocabulario del árbol de
 * navegación, nav-tree.generated.json). Conserva la firma anterior.
 */
export async function gotoFirstAvailable(page: Page, paths: string[]): Promise<string> {
  for (const path of paths) {
    const resp = await page.goto(path, { waitUntil: "domcontentloaded" }).catch(() => null);
    if (resp && resp.status() < 400) return path;
  }
  return paths[paths.length - 1];
}
