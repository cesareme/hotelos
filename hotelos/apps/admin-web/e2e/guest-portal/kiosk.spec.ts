import { expect, test, type APIRequestContext } from "@playwright/test";
import { CHK, E2E_API_URL, E2E_GUEST_BASE_URL, assertConsoleClean, assertTargets, createSyntheticReservation, forceCoarse, isoDay, loginAsChk, shot, watchConsole, type ChkSession } from "./_guest-helpers";

/**
 * Kiosco de recepción (Tanda L7 · lote L7-09 · proyecto Playwright `guest`,
 * tablet apaisada 1024 × 768 con `hasTouch`, es-ES; tenant CHK, reserva con
 * titular INVENTADO). Mismo recorrido que la verificación de TANDA-CHK W4-C
 * (l.100-105) y del lote L7-05 (aviso de inactividad accesible), como spec:
 *   0. dirección (kiosk.configure) crea un kiosco y arranca el emparejamiento
 *      (POST /properties/prop_chk/kiosks · …/kiosks/:id/pair → código de 8
 *      dígitos de un solo uso, 10 min); recepción crea la reserva (llega dentro
 *      de E2E_KIOSK_ARRIVAL_OFFSET_DAYS días, 7 por defecto: el kiosco no hace
 *      la llegada y así no consume las habitaciones de hoy de las otras specs);
 *   1. `?kiosk=1&device=<id>&property=prop_chk` → pantalla «Emparejar este
 *      kiosco» → código → POST /guest-portal/check-in/kiosk/claim → credencial
 *      del DISPOSITIVO en localStorage (hotelos.kiosk.device, deviceToken; el
 *      código nunca se guarda ni viaja en una URL) → pantalla de espera;
 *   2. «Toca para empezar» → «Localiza tu reserva» → código de reserva + correo
 *      → POST /guest-portal/sign-in → asistente con el código de la reserva y
 *      el paso «Documento» (titular ya nombrado); la sesión del huésped NUNCA
 *      se persiste (sessionStorage sin hotelos.guest.*);
 *   3. inactividad con el reloj falso de Playwright (page.clock): a los 75 s
 *      aparece el aviso role="alert" «Sin actividad: la pantalla se reiniciará
 *      en N s.» con «Continuar» (prolonga la sesión); sin tocar nada, a los 90 s
 *      el kiosco se reinicia: pantalla de espera, sin asistente, sin restos del
 *      huésped en sessionStorage y con la credencial del kiosco intacta;
 *   4. limpieza: el kiosco de la prueba queda `disabled` (PATCH), para no dejar
 *      un dispositivo en línea (db:seed:checkin --reset también lo borra).
 * En cada pantalla: captura y contrato de tamaño de objetivos (0 < 24 px; los
 * < 44 px a JSON: en el kiosco no debería haber ninguno). Al final: 0
 * excepciones, 0 errores de consola, ninguna respuesta ≥ 400. Sin skip.
 */

/** Llegada de la reserva del kiosco (días): fuera de la ventana de hoy a propósito, ver la fixture. */
const KIOSK_ARRIVAL_OFFSET_DAYS = Number(process.env.E2E_KIOSK_ARRIVAL_OFFSET_DAYS ?? "7");
/** kiosk-mode.ts: IDLE_TIMEOUT_MS 90 s · IDLE_WARNING_MS 15 s → aviso a los 75 s. */
const IDLE_TIMEOUT_MS = 90_000;
const IDLE_WARNING_MS = 15_000;
/** Claves de kiosk-mode.ts: la del dispositivo (localStorage) y las del huésped (sessionStorage, prohibidas en modo kiosco). */
const KIOSK_STORAGE_KEY = "hotelos.kiosk.device";
const GUEST_STORAGE_KEYS = ["hotelos.guest.session", "hotelos.guest.arrival"];

type KioskDevice = { id: string; name: string; status: string; propertyId: string };

async function readJson<T>(response: { ok(): boolean; status(): number; json(): Promise<unknown>; text(): Promise<string> }, label: string): Promise<T> {
  expect(response.ok(), `${label} → ${response.status()} ${(await response.text().catch(() => "")).slice(0, 300)}`).toBeTruthy();
  return (await response.json()) as T;
}

/** Dirección crea el kiosco de la prueba y arranca el emparejamiento (código en claro solo en esta respuesta). */
async function createPairingKiosk(request: APIRequestContext, direccion: ChkSession, name: string): Promise<{ device: KioskDevice; code: string; expiresAt: string }> {
  const created = await request.post(`${E2E_API_URL}/properties/${CHK.propertyId}/kiosks`, { headers: direccion.headers, data: { name } });
  expect(created.status(), `POST /properties/:id/kiosks → ${created.status()} ${(await created.text().catch(() => "")).slice(0, 200)}`).toBe(201);
  const device = (await created.json()) as KioskDevice;
  expect(device.status).toBe("unpaired");
  const pairing = await readJson<{ device: KioskDevice; code: string; expiresAt: string }>(await request.post(`${E2E_API_URL}/properties/${CHK.propertyId}/kiosks/${device.id}/pair`, { headers: direccion.headers, data: {} }), "POST …/kiosks/:id/pair");
  expect(pairing.code).toMatch(/^\d{8}$/);
  return { device, code: pairing.code, expiresAt: pairing.expiresAt };
}

/** Claves del huésped presentes en sessionStorage (debe ser [] en modo kiosco) y credencial del kiosco en localStorage. */
async function storageState(page: import("@playwright/test").Page): Promise<{ guestKeys: string[]; kiosk: { deviceId: string; token: string; name: string | null } | null }> {
  return page.evaluate(
    ({ kioskKey, guestKeys }) => {
      const present = guestKeys.filter((key) => window.sessionStorage.getItem(key) !== null);
      const raw = window.localStorage.getItem(kioskKey);
      const kiosk = raw ? (JSON.parse(raw) as { deviceId: string; token: string; name: string | null }) : null;
      return { guestKeys: present, kiosk: kiosk ? { deviceId: kiosk.deviceId, token: kiosk.token, name: kiosk.name } : null };
    },
    { kioskKey: KIOSK_STORAGE_KEY, guestKeys: GUEST_STORAGE_KEYS }
  );
}

// Tablet apaisada como dispositivo táctil (isMobile + hasTouch, como los descriptores iPad de Playwright).
test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });

test("la tablet de recepción se empareja, localiza la reserva por código y correo, abre el asistente y se reinicia sola tras la inactividad sin dejar rastro del huésped", async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);

  // 0 · Kiosco emparejable (dirección) y reserva de hoy (recepción).
  const direccion = await loginAsChk(request, "direccion");
  const recepcion = await loginAsChk(request, "recepcion");
  const stamp = Date.now().toString(36);
  const kiosk = await createPairingKiosk(request, direccion, `Tablet e2e ${stamp}`);
  // Llega dentro de una semana: el kiosco solo localiza y abre el asistente (no hace la llegada), así que la
  // reserva no compite por las habitaciones de hoy que consumen stay-checkout/journey ni se acumula en esa fecha.
  const reservation = await createSyntheticReservation(request, { arrival: isoDay(KIOSK_ARRIVAL_OFFSET_DAYS), departure: isoDay(KIOSK_ARRIVAL_OFFSET_DAYS + 2), adults: 1, session: recepcion });
  // El código de emparejamiento es secreto de un solo uso: no puede aparecer en ninguna URL (watchConsole lo vigila como «token»).
  const watch = watchConsole(page, kiosk.code);
  const idleWarning = page.locator(".gp-kiosk-idle-warning[role='alert']");
  const attract = page.getByRole("button", { name: "Toca para empezar" });

  try {
    // Reloj falso ANTES de navegar: los temporizadores del kiosco (setTimeout) se adelantan con fastForward.
    await page.clock.install();
    // Objetivos medidos con el dedo (CDP, como e2e/target-size.spec.ts). Observado: en cuanto «Toca para empezar» pide pantalla
    // completa, el Chromium headless deja de responder `pointer: coarse` (ni por CDP ni por isMobile), así que las pantallas 3-6 se
    // registran con coarse=false; no cambia la medida (todos los objetivos del kiosco son .gp-button-big/-huge, ≥ 56 px).
    await forceCoarse(page);

    // 1 · Emparejamiento por código.
    await test.step("emparejar el kiosco con el código de recepción", async () => {
      await page.goto(`${E2E_GUEST_BASE_URL}/?kiosk=1&device=${encodeURIComponent(kiosk.device.id)}&property=${CHK.propertyId}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Emparejar este kiosco" })).toBeVisible({ timeout: 20_000 });
      await expect(page.locator(".gp-kiosk")).toHaveClass(/gp-kiosk-pairing/);
      const pair = page.getByRole("button", { name: "Emparejar", exact: true });
      await expect(pair, "sin 8 dígitos no se empareja").toBeDisabled();
      await page.getByLabel("Código de emparejamiento").fill(kiosk.code);
      await expect(pair).toBeEnabled();
      await shot(page, "kiosk-01-emparejar");
      await assertTargets(page, testInfo, "kiosk-01-emparejar");
      const claim = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/guest-portal/check-in/kiosk/claim"));
      await pair.click();
      const claimed = await claim;
      expect(claimed.status(), "el código real empareja").toBe(200);
      expect(claimed.request().postData() ?? "", "el código viaja en el cuerpo, nunca en la URL").toContain(kiosk.code);
      await expect(attract).toBeVisible({ timeout: 15_000 });
      await expect(page.locator(".gp-kiosk")).toHaveClass(/gp-kiosk-idle/);
      await expect(page.locator(".gp-hint")).toContainText(`Kiosco ${kiosk.device.name}`);
      const stored = await storageState(page);
      expect(stored.kiosk?.deviceId, "la credencial del dispositivo queda en localStorage").toBe(kiosk.device.id);
      expect(stored.kiosk?.token, "deviceToken del claim").toBeTruthy();
      expect(stored.kiosk?.token).not.toContain(kiosk.code);
      expect(stored.guestKeys, "sin sesión de huésped").toEqual([]);
      const devices = await readJson<Array<KioskDevice & { paired: boolean }>>(await request.get(`${E2E_API_URL}/properties/${CHK.propertyId}/kiosks`, { headers: direccion.headers }), "GET /properties/:id/kiosks");
      const device = devices.find((row) => row.id === kiosk.device.id);
      expect(device?.status, "el API ve el kiosco en línea tras el claim").toBe("online");
      expect(device?.paired).toBe(true);
      await shot(page, "kiosk-02-espera");
      await assertTargets(page, testInfo, "kiosk-02-espera");
    });

    // 2 · Localizar la reserva por código + correo → asistente.
    await test.step("localizar por código y correo → asistente", async () => {
      await attract.click();
      await expect(page.getByRole("heading", { name: "Localiza tu reserva" })).toBeVisible({ timeout: 10_000 });
      await expect(page.locator(".gp-kiosk")).toHaveClass(/gp-kiosk-locate/);
      const byCode = page.locator("form.gp-kiosk-form", { has: page.locator('input[type="email"]') });
      const find = byCode.getByRole("button", { name: "Buscar" });
      await expect(find, "sin código y correo no se busca").toBeDisabled();
      await page.getByLabel("Código de reserva").fill(reservation.code);
      await page.getByLabel("Correo electrónico").fill(reservation.email);
      await expect(find).toBeEnabled();
      await shot(page, "kiosk-03-localizar");
      await assertTargets(page, testInfo, "kiosk-03-localizar");
      const signIn = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/guest-portal/sign-in"));
      await find.click();
      const signedIn = (await (await signIn).json()) as { ok: boolean };
      expect(signedIn.ok, "código + correo del titular inventado entran").toBe(true);
      await expect(page.locator(".gp-wizard")).toBeVisible({ timeout: 20_000 });
      await expect(page.locator(".gp-kiosk")).toHaveClass(/gp-kiosk-wizard/);
      await expect(page.locator(".gp-hero-code")).toHaveText(reservation.code);
      // Titular ya nombrado (adults 1): el asistente reanuda en «Documento»; en la tablet la vuelta se llama «Terminar».
      await expect(page.getByRole("group", { name: /^Paso \d de 6$/ })).toHaveAttribute("aria-label", "Paso 2 de 6");
      await expect(page.getByRole("button", { name: "Terminar", exact: true })).toBeVisible();
      const stored = await storageState(page);
      expect(stored.guestKeys, "en modo kiosco la sesión del huésped no se persiste").toEqual([]);
      expect(stored.kiosk?.deviceId).toBe(kiosk.device.id);
      await shot(page, "kiosk-04-asistente");
      await assertTargets(page, testInfo, "kiosk-04-asistente");
    });

    // 3 · Inactividad: aviso a los 75 s, «Continuar» prolonga; a los 90 s reinicio limpio.
    await test.step("aviso de inactividad y reinicio sin restos", async () => {
      await expect(idleWarning).toHaveCount(0);
      await page.clock.fastForward(IDLE_TIMEOUT_MS - IDLE_WARNING_MS + 1_000);
      await expect(idleWarning).toBeVisible({ timeout: 10_000 });
      await expect(idleWarning).toContainText("Sin actividad: la pantalla se reiniciará en");
      // La frase se anuncia una vez para el lector (texto oculto con los 15 s fijos) y el botón grande prolonga la sesión.
      await expect(idleWarning.locator(".gp-visually-hidden")).toHaveText(`Sin actividad: la pantalla se reiniciará en ${IDLE_WARNING_MS / 1000} s.`);
      const stay = idleWarning.getByRole("button", { name: "Continuar", exact: true });
      await expect(stay).toHaveClass(/gp-button-big/);
      await shot(page, "kiosk-05-aviso-inactividad");
      await assertTargets(page, testInfo, "kiosk-05-aviso-inactividad");
      await stay.click();
      await expect(idleWarning, "«Continuar» retira el aviso y reinicia la cuenta").toHaveCount(0);
      await expect(page.locator(".gp-wizard")).toBeVisible();

      // Sin tocar nada: aviso de nuevo y, 15 s después, reinicio.
      await page.clock.fastForward(IDLE_TIMEOUT_MS - IDLE_WARNING_MS + 1_000);
      await expect(idleWarning).toBeVisible({ timeout: 10_000 });
      await page.clock.fastForward(IDLE_WARNING_MS + 1_000);
      await expect(attract, "el kiosco vuelve a la pantalla de espera").toBeVisible({ timeout: 10_000 });
      await expect(page.locator(".gp-kiosk")).toHaveClass(/gp-kiosk-idle/);
      await expect(page.locator(".gp-wizard")).toHaveCount(0);
      await expect(idleWarning).toHaveCount(0);
      await expect(page.locator(".gp-hero-code")).toHaveCount(0);
      const stored = await storageState(page);
      expect(stored.guestKeys, "sin restos del huésped en sessionStorage").toEqual([]);
      expect(stored.kiosk?.deviceId, "la credencial del kiosco sobrevive al reinicio").toBe(kiosk.device.id);
      // La página tampoco conserva el código de reserva ni el correo del huésped anterior.
      await expect(page.getByText(reservation.code)).toHaveCount(0);
      await expect(page.getByText(reservation.email)).toHaveCount(0);
      await attract.click();
      await expect(page.getByLabel("Código de reserva")).toHaveValue("");
      await expect(page.getByLabel("Correo electrónico")).toHaveValue("");
      await page.getByRole("button", { name: "Cancelar", exact: true }).click();
      await expect(attract).toBeVisible();
      await shot(page, "kiosk-06-reiniciado");
      await assertTargets(page, testInfo, "kiosk-06-reiniciado");
    });

    // El personal ve la sesión de check-in que el kiosco abrió al localizar la reserva (manual, sin persistir nada del huésped en la tablet).
    const view = await readJson<{ status: string; channel: string }>(await request.get(`${E2E_API_URL}/reservations/${reservation.id}/check-in`, { headers: recepcion.headers }), "GET /reservations/:id/check-in");
    expect(view.status).toMatch(/^(invited|in_progress)$/);

    assertConsoleClean(watch, []);
  } finally {
    // Limpieza: el kiosco de la prueba deja de autenticar (no queda un dispositivo en línea).
    const disabled = await request.patch(`${E2E_API_URL}/properties/${CHK.propertyId}/kiosks/${kiosk.device.id}`, { headers: direccion.headers, data: { status: "disabled" } });
    expect(disabled.ok(), `PATCH …/kiosks/:id (disabled) → ${disabled.status()}`).toBeTruthy();
  }
});
