import { devices, expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHK, E2E_API_URL, SYNTHETIC_GUEST, assertConsoleClean, createSyntheticReservation, forceCoarse, invite, isoDay, loginAsChk, shot, syntheticMrz, tinyPng, watchConsole, type ChkSession, type SyntheticReservation } from "./_guest-helpers";

/**
 * Recorrido del huésped en recepción (Tanda L7 · lote L7-09 · proyecto
 * Playwright `guest`, escritorio 1280 × 900 sobre admin-web —
 * E2E_ADMIN_BASE_URL, por defecto http://127.0.0.1:5207—, es-ES; tenant CHK,
 * titular INVENTADO). Comprueba la pantalla de L7-07
 * (/recepcion/reservas/:id/recorrido, GET /reservations/:id/guest-journey)
 * con datos REALES creados por API en la misma corrida:
 *   0. recepción crea la reserva (llega hoy) y la invita → aviso SIMULADO por
 *      correo (sin EMAIL_PROVIDER) con destinatario enmascarado; el huésped
 *      cierra el pre-check-in por API (MRZ → residencia → consentimientos →
 *      complete → firma) y pide la consigna de equipaje desde el portal
 *      (POST /guest-portal/stay/requests); recepción hace el check-in
 *      (POST /reservations/:id/check-in/complete → habitación + llave móvil de
 *      demo + bienvenida simulada);
 *   1. recepción entra en la pantalla (sesión por localStorage como
 *      e2e/_helpers.ts) y ve: «Invitación al check-in en línea» con el envío
 *      simulado y `p***@chk.test` (nunca el correo entero), «Pre-check-in del
 *      huésped» alojado con 1/1 firmados, «Habitación asignada» con el número,
 *      «Check-in» hecho, «Llave» con la serie real y «QR de demo», «Estancia»
 *      en curso, «Peticiones del huésped» con 1 abierta; «Avisos al huésped»
 *      con las entregas marcadas «Simulado»; «Peticiones y mensajes» con la
 *      petición abierta;
 *   2. limpieza: recepción hace el check-out por API para no dejar la
 *      habitación ocupada (el folio nace vacío: saldo 0) y dirección la marca
 *      limpia otra vez (housekeeping.task.manage): la spec es repetible el
 *      mismo día sin agotar las Dobles listas del tenant.
 * Contrato de tamaño de objetivos (2.5.8: 0 < 24 px; los < 44 px a JSON
 * descritos SOLO por su tipo, nunca por su texto: la lista de reservas lleva
 * los nombres inventados del tenant) medido, como e2e/target-size.spec.ts, bajo
 * `pointer: coarse` por CDP (Cocoa 22 agranda los objetivos con el dedo: con
 * puntero fino la búsqueda de la lista mide 18 px y los botones de icono 20 px),
 * y 0 errores de consola / respuestas ≥ 400.
 * Sin skip: sin API, seed, admin-web o portal la spec FALLA con el motivo.
 */

/** Base de admin-web para el proyecto `guest` (la de `chromium`, E2E_BASE_URL, apunta por defecto al Vite de recepción :5173). */
const E2E_ADMIN_BASE_URL = (process.env.E2E_ADMIN_BASE_URL ?? process.env.E2E_BASE_URL ?? "http://127.0.0.1:5207").replace(/\/+$/, "");

const DOCUMENT = { number: "PRB000789", nationality: "ESP", dateOfBirth: "1985-11-23", sex: "M" as const, expiryDate: "2031-11-22" };

async function readJson<T>(response: { ok(): boolean; status(): number; json(): Promise<unknown>; text(): Promise<string> }, label: string): Promise<T> {
  expect(response.ok(), `${label} → ${response.status()} ${(await response.text().catch(() => "")).slice(0, 300)}`).toBeTruthy();
  return (await response.json()) as T;
}

type JourneyFixture = { reservation: SyntheticReservation; token: string; guestHeaders: Record<string, string>; room: string; roomId: string; keySerial: string; requestId: string; recipientMasked: string };

/**
 * Reserva alojada con invitación simulada, pre-check-in cerrado por API, una
 * petición abierta desde el portal y llave móvil (mismo pipeline que
 * stay-checkout.spec.ts; local a la spec por diseño del lote).
 */
async function provisionJourney(request: APIRequestContext, session: ChkSession): Promise<JourneyFixture> {
  const reservation = await createSyntheticReservation(request, { arrival: isoDay(0), departure: isoDay(2), adults: 1, session });
  const invitation = await invite(request, reservation.id, { session });
  expect(invitation.notification.dispatched, "la invitación se registra como entrega").toBe(true);
  expect(invitation.notification.simulated, "sin EMAIL_PROVIDER el envío es SIMULADO (honestidad)").toBe(true);
  const guestHeaders = { "x-guest-token": invitation.token };
  const checkIn = await readJson<{ guests: Array<{ id: string; isPrimary: boolean }> }>(await request.get(`${E2E_API_URL}/guest-portal/check-in`, { headers: guestHeaders }), "GET /guest-portal/check-in");
  const primary = checkIn.guests.find((guest) => guest.isPrimary) ?? checkIn.guests[0];
  expect(primary).toBeTruthy();
  const guestId = primary!.id;
  const mrz = syntheticMrz({ surname: SYNTHETIC_GUEST.surname1, givenNames: SYNTHETIC_GUEST.firstName, documentNumber: DOCUMENT.number, ...DOCUMENT });
  await readJson(await request.post(`${E2E_API_URL}/guest-portal/check-in/guests/${guestId}/mrz`, { headers: guestHeaders, data: { lines: mrz } }), "POST …/mrz");
  await readJson(await request.patch(`${E2E_API_URL}/guest-portal/check-in/guests/${guestId}`, { headers: guestHeaders, data: { residenceFullAddress: "Rúa de Proba 9", residenceLocality: "A Coruña", residenceCountry: "ESP" } }), "PATCH …/guests/:id");
  await readJson(await request.patch(`${E2E_API_URL}/guest-portal/check-in`, { headers: guestHeaders, data: { consent: { gdpr: true, aiDisclosure: true } } }), "PATCH /guest-portal/check-in (consent)");
  await readJson(await request.post(`${E2E_API_URL}/guest-portal/check-in/complete`, { headers: guestHeaders, data: {} }), "POST …/complete");
  const signature = await request.post(`${E2E_API_URL}/guest-portal/check-in/guests/${guestId}/signature`, {
    headers: guestHeaders,
    data: { pngBase64: tinyPng().toString("base64"), strokeMeta: { points: 24, durationMs: 900, bbox: { x: 10, y: 10, w: 200, h: 60 } } }
  });
  expect(signature.status(), `POST …/signature → ${signature.status()}`).toBe(201);
  const created = await request.post(`${E2E_API_URL}/guest-portal/stay/requests`, { headers: guestHeaders, data: { kind: "luggage", note: "Prueba e2e: dos maletas hasta las 18:00." } });
  expect(created.status(), `POST /guest-portal/stay/requests → ${created.status()}`).toBe(201);
  const ticket = (await created.json()) as { id: string; ticketNumber: string };
  const arrived = await readJson<{ room: { id: string; number: string }; key: { serialNumber: string } | null; welcome?: { status?: string } }>(
    await request.post(`${E2E_API_URL}/reservations/${reservation.id}/check-in/complete`, { headers: session.headers, data: {} }),
    "POST /reservations/:id/check-in/complete"
  );
  expect(arrived.room?.number).toBeTruthy();
  expect(arrived.key?.serialNumber, "el check-in emite la llave móvil (QR de demo)").toBeTruthy();
  // maskRecipient del API: «p***@chk.test» para «prueba.portal.<stamp>@chk.test».
  const recipientMasked = `${reservation.email.charAt(0)}***@${reservation.email.split("@")[1]}`;
  return { reservation, token: invitation.token, guestHeaders, room: arrived.room.number, roomId: arrived.room.id, keySerial: arrived.key!.serialNumber, requestId: ticket.id, recipientMasked };
}

/** Sesión de recepción del tenant CHK escrita en localStorage antes de que cargue admin-web (mismas claves que e2e/_helpers.ts loginAsUxDay). */
async function loginAdminAsChk(page: Page, session: ChkSession): Promise<void> {
  await page.addInitScript(
    ({ token, user, active }) => {
      try {
        window.localStorage.setItem("hotelos.auth.token", token);
        window.localStorage.setItem("hotelos.auth.user", JSON.stringify(user));
        window.localStorage.setItem("hotelos.auth.deviceId", "e2e-guest");
        window.localStorage.setItem("hotelos-active-property", active.propertyId);
        window.localStorage.setItem("hotelos-active-org", active.organizationId);
        window.localStorage.setItem("hotelos-active-property-name", active.propertyName);
        // Recorrido de bienvenida ya visto (components/guide/guideStore.ts): sin diálogos encima del detalle.
        window.localStorage.setItem("hotelos.guide.v1", JSON.stringify({ tourCompleted: true, welcomeDismissed: true, seenRoles: [] }));
      } catch {
        /* localStorage no disponible: la spec fallará al no ver la pantalla */
      }
    },
    { token: session.token, user: session.user, active: { propertyId: CHK.propertyId, organizationId: CHK.organizationId, propertyName: CHK.propertyName } }
  );
}

// ── Tamaño de objetivos en admin-web (2.5.8), descritos SOLO por tipo ─────────

type AdminTargetSample = { kind: string; w: number; h: number; min: number; inline: boolean };

/** Misma regla que _guest-helpers.ts auditTargets, sin textos: la lista de reservas lleva nombres (inventados) y no deben acabar en el JSON. Se ejecuta en la página. */
function auditAdminTargets(): { coarse: boolean; totals: { targets: number; below24: number; below44: number; inlineExempt: number }; below24: AdminTargetSample[]; below44: AdminTargetSample[] } {
  const INTERACTIVE =
    'a[href], button, input, select, textarea, summary, [role="button"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"], [role="option"], [role="link"], [role="slider"], [tabindex="0"]';
  const isVisible = (element: Element): boolean => {
    if (element.closest('[aria-hidden="true"], [hidden]')) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    if (/^rect\(0px,? 0px,? 0px,? 0px\)$/.test(style.clip) || (style.overflow === "hidden" && element.clientWidth <= 1 && element.clientHeight <= 1)) return false;
    return element.getClientRects().length > 0;
  };
  const kindOf = (element: Element): string => {
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute("role");
    const type = tag === "input" ? `[${(element as HTMLInputElement).type}]` : "";
    const cocoa = Array.from(element.classList).find((name) => /^(c22-|cocoa-)/.test(name)) ?? null;
    return `${tag}${type}${role ? `[role=${role}]` : ""}${cocoa ? ` (.${cocoa})` : ""}`;
  };
  const isInlineLink = (element: Element): boolean => {
    if (element.tagName !== "A") return false;
    const parent = element.parentElement;
    if (!parent || !/^(P|SPAN|LI|TD|DD|SMALL|EM|STRONG)$/.test(parent.tagName)) return false;
    return Array.from(parent.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim().length > 0);
  };
  const samples: AdminTargetSample[] = [];
  for (const element of Array.from(document.querySelectorAll(INTERACTIVE))) {
    const input = element as HTMLInputElement;
    if (element.tagName === "INPUT" && (input.type === "hidden" || input.type === "file")) continue;
    if ((element as HTMLButtonElement).disabled || element.getAttribute("aria-disabled") === "true") continue;
    if (!isVisible(element)) continue;
    const rect = element.tagName === "INPUT" && (input.type === "checkbox" || input.type === "radio") ? (element.closest("label") ?? element).getBoundingClientRect() : element.getBoundingClientRect();
    const w = Math.round(rect.width * 100) / 100;
    const h = Math.round(rect.height * 100) / 100;
    if (w === 0 || h === 0) continue;
    samples.push({ kind: kindOf(element), w, h, min: Math.min(w, h), inline: isInlineLink(element) });
  }
  const below24 = samples.filter((sample) => sample.min < 24);
  const below44 = samples.filter((sample) => sample.min < 44);
  return { coarse: matchMedia("(pointer: coarse)").matches, totals: { targets: samples.length, below24: below24.length, below44: below44.length, inlineExempt: below24.filter((sample) => sample.inline).length }, below24, below44 };
}

type AdminTargetAudit = ReturnType<typeof auditAdminTargets>;

/** Mide y escribe `targets-<name>.json` (TARGET_SIZE_OUT o el outputDir) con los < 44 px agrupados por tipo; no afirma nada. */
async function recordAdminTargets(page: Page, testInfo: TestInfo, name: string): Promise<AdminTargetAudit> {
  const audit = await page.evaluate(auditAdminTargets);
  const groups = new Map<string, { kind: string; count: number; min: number }>();
  for (const sample of audit.below44) {
    const group = groups.get(sample.kind) ?? { kind: sample.kind, count: 0, min: Number.POSITIVE_INFINITY };
    group.count += 1;
    group.min = Math.min(group.min, sample.min);
    groups.set(sample.kind, group);
  }
  const dir = process.env.TARGET_SIZE_OUT ?? testInfo.outputDir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `targets-${name}.json`), `${JSON.stringify({ name, url: page.url(), viewport: page.viewportSize(), ...audit, below44Summary: Array.from(groups.values()).sort((a, b) => a.min - b.min || b.count - a.count) }, null, 2)}\n`, "utf8");
  // eslint-disable-next-line no-console
  console.log(`[guest:targets:${name}] targets=${audit.totals.targets} <24=${audit.totals.below24} (inline ${audit.totals.inlineExempt}) <44=${audit.totals.below44} coarse=${audit.coarse}`);
  return audit;
}

/** 0 objetivos < 24 × 24 px (salvo enlaces en línea) bajo pointer: coarse; los < 44 px quedan en el JSON. */
async function assertAdminTargets(page: Page, testInfo: TestInfo, name: string): Promise<AdminTargetAudit> {
  const audit = await recordAdminTargets(page, testInfo, name);
  expect(audit.coarse, "la medida se hace bajo pointer: coarse (misma condición que e2e/target-size.spec.ts)").toBe(true);
  const offenders = audit.below24.filter((sample) => !sample.inline);
  expect(offenders, `${name}: objetivos < 24 × 24 px (2.5.8): ${JSON.stringify(offenders)}`).toEqual([]);
  return audit;
}

test.use({ ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 }, baseURL: E2E_ADMIN_BASE_URL });

test("recepción ve en el recorrido la invitación simulada, el pre-check-in cerrado, la llave móvil y la petición abierta de una reserva alojada", async ({ page, request }, testInfo) => {
  test.setTimeout(150_000);

  // 0 · Fixture por API.
  const recepcion = await loginAsChk(request, "recepcion");
  const fixture = await provisionJourney(request, recepcion);
  const watch = watchConsole(page, fixture.token);

  try {
    await loginAdminAsChk(page, recepcion);
    // Misma emulación que el proyecto `touch`: objetivos medidos con el dedo (CDP), no con el puntero fino del escritorio.
    await forceCoarse(page);
    await page.goto(`${E2E_ADMIN_BASE_URL}/recepcion/reservas/${encodeURIComponent(fixture.reservation.id)}/recorrido`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Iniciar sesión" }), "admin-web debe arrancar autenticado en el tenant CHK").toHaveCount(0);
    // CocoaSection pinta un <div data-cocoa="section"> con su <h3>: la sección se localiza desde su título.
    const sectionOf = (title: string) => page.getByRole("heading", { name: title, exact: true }).locator('xpath=ancestor::*[@data-cocoa="section"][1]');
    const detail = sectionOf("Detalle del recorrido");
    await expect(detail).toBeVisible({ timeout: 30_000 });
    const journeyResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/reservations/${fixture.reservation.id}/guest-journey`, { timeout: 30_000 }).catch(() => null);
    const steps = page.locator('ol[aria-label="Pasos del recorrido"] > li');
    await expect(steps).toHaveCount(13, { timeout: 30_000 });
    await expect(detail).toContainText(fixture.reservation.code);
    const journey = await journeyResponse;
    if (journey) expect(journey.status(), "GET /reservations/:id/guest-journey").toBe(200);
    // Con el recorrido del API cargado ningún paso queda «no disponible».
    await expect(detail.getByText("Recorrido del check-in en línea no disponible.")).toHaveCount(0);
    await expect(detail.getByText("Datos no disponibles")).toHaveCount(0);

    // Título exacto del paso: «Check-in» no debe casar con «Invitación al check-in en línea» ni «Pre-check-in del huésped».
    const step = (label: string) => steps.filter({ has: page.locator("strong", { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) });
    await test.step("pasos con datos reales", async () => {
      const invitation = step("Invitación al check-in en línea");
      await expect(invitation).toHaveCount(1);
      await expect(invitation).toContainText(/envío simulado por correo/i);
      await expect(invitation).toContainText(fixture.recipientMasked);
      await expect(invitation, "el correo del huésped nunca viaja entero").not.toContainText(fixture.reservation.email);
      await expect(invitation).toContainText("Hecho");

      const precheckin = step("Pre-check-in del huésped");
      await expect(precheckin).toContainText("Alojado");
      await expect(precheckin).toContainText(/viajeros completos 1\/1 · firmados 1\/1/i);
      await expect(precheckin).toContainText("Hecho");

      // La MRZ del pre-check-in deja el pasaporte en el perfil del huésped (journey.ts hasDoc → «Documento registrado (PASSPORT)»);
      // «identidad verificada» solo se añade si CheckInGuest.identityVerifiedAt está fijado (hoy el check-in por mrz_checksum no lo persiste).
      const identity = step("Identidad y parte de viajeros (SES)");
      await expect(identity).toContainText(/Documento registrado \(PASSPORT\)/);
      await expect(identity).toContainText("Hecho");
      await expect(step("Habitación asignada")).toContainText(`Habitación ${fixture.room}`);
      await expect(step("Check-in")).toContainText(/huésped registrado/i);

      const key = step("Llave");
      await expect(key).toContainText(`Llave móvil ${fixture.keySerial}`);
      await expect(key).toContainText(/QR de demo \(sin certificado de Apple\)/i);
      await expect(key).toContainText("Hecho");

      await expect(step("Bienvenida")).toContainText(/mensaje de bienvenida: envío simulado por whatsapp/i);
      await expect(step("Estancia")).toContainText(/el huésped está en casa/i);
      await expect(step("Estancia")).toContainText("En curso");

      const requests = step("Peticiones del huésped");
      await expect(requests).toContainText(/1 de 1 sin atender/i);
      await expect(requests).toContainText("1 abierta");

      await expect(step("Check-out y factura")).toContainText("Pendiente");
      await expect(step("Encuesta post-estancia")).toContainText(/se envía tras la salida/i);
      await expect(detail.locator("strong", { hasText: /de 13 pasos completados/ })).toHaveCount(1);
    });

    await test.step("avisos al huésped simulados y enmascarados", async () => {
      const notices = sectionOf("Avisos al huésped");
      await expect(notices).toBeVisible();
      const rows = notices.locator('ul[aria-label="Avisos enviados al huésped"] > li');
      await expect(rows.first()).toBeVisible({ timeout: 15_000 });
      expect(await rows.count(), "invitación + bienvenida como mínimo").toBeGreaterThanOrEqual(2);
      const invitationRow = rows.filter({ hasText: "Invitación al check-in en línea" });
      await expect(invitationRow).toHaveCount(1);
      await expect(invitationRow).toContainText(fixture.recipientMasked);
      await expect(invitationRow).toContainText("Simulado");
      for (const row of await rows.all()) {
        await expect(row).toContainText("Simulado");
        await expect(row).not.toContainText(fixture.reservation.email);
        await expect(row).not.toContainText(fixture.reservation.mobilePhone);
      }
      await expect(notices).toContainText(/sesión del portal activa|sesiones del portal activas/);
      // Alojada: ya no se reenvía la invitación ni se manda la encuesta (surveyActionAvailable exige checked_out).
      await expect(notices.getByRole("button", { name: /invitación|Invitar al check-in/ })).toHaveCount(0);
      await expect(notices.getByRole("button", { name: "Enviar encuesta ahora" })).toHaveCount(0);
    });

    await test.step("peticiones y mensajes", async () => {
      const activity = page.locator('ul[aria-label="Actividad reciente"] > li');
      await expect(activity.first()).toBeVisible({ timeout: 15_000 });
      const luggage = activity.filter({ hasText: "Consigna de equipaje" });
      await expect(luggage).toHaveCount(1);
      await expect(luggage).toContainText("Abierta");
      await expect(luggage).toContainText("Recepción");
    });

    await test.step("captura, objetivos y lista filtrada", async () => {
      // Pantalla canónica (búsqueda vacía, como la «lista» de e2e/target-size.spec.ts): contrato 2.5.8 afirmado.
      await shot(page, "journey-01-recorrido-alojado");
      await assertAdminTargets(page, testInfo, "journey-01-recorrido-alojado");
      await page.getByRole("searchbox", { name: "Buscar reservas por código, huésped, fechas o estado" }).fill(fixture.reservation.code);
      const list = page.locator('ul[aria-label="Reservas"] > li');
      await expect(list).toHaveCount(1);
      await expect(list.first()).toContainText(fixture.reservation.code);
      await expect(list.first().getByRole("button")).toHaveAttribute("aria-current", "true");
      // Con texto en la búsqueda aparece el botón de borrar de CocoaSearchInput (20 × 20 px bajo coarse: hallazgo del
      // componente compartido, fuera de este lote): se mide y se escribe en el JSON sin afirmar para no ocultarlo.
      const filtered = await recordAdminTargets(page, testInfo, "journey-02-lista-filtrada");
      expect(filtered.below24.filter((sample) => !sample.inline).length, "solo el botón de borrar de la búsqueda puede quedar por debajo de 24 px").toBeLessThanOrEqual(1);
    });

    // La vista del API coincide con lo pintado (sin PII: destinatarios enmascarados, sin correo entero).
    const view = await readJson<{ notifications: Array<{ kind: string; simulated: boolean; recipient: string }>; key: { serial: string } | null; requests: Array<{ id: string; status: string }>; checkIn: { status: string } | null }>(
      await request.get(`${E2E_API_URL}/reservations/${fixture.reservation.id}/guest-journey`, { headers: recepcion.headers }),
      "GET /reservations/:id/guest-journey"
    );
    expect(view.checkIn?.status).toBe("checked_in");
    expect(view.key?.serial).toBe(fixture.keySerial);
    expect(view.requests.map((entry) => entry.id)).toContain(fixture.requestId);
    expect(view.notifications.every((entry) => entry.simulated && !entry.recipient.includes(fixture.reservation.email))).toBe(true);
    expect(view.notifications.map((entry) => entry.kind)).toEqual(expect.arrayContaining(["checkin_invitation", "welcome"]));

    assertConsoleClean(watch, []);
  } finally {
    // Limpieza: check-out por API (folio vacío → saldo 0) para no dejar la habitación ocupada y habitación limpia otra vez.
    const checkedOut = await request.post(`${E2E_API_URL}/reservations/${fixture.reservation.id}/check-out`, { headers: recepcion.headers, data: {} });
    expect(checkedOut.ok(), `POST /reservations/:id/check-out → ${checkedOut.status()} ${(await checkedOut.text().catch(() => "")).slice(0, 200)}`).toBeTruthy();
    const direccion = await loginAsChk(request, "direccion");
    const cleaned = await request.post(`${E2E_API_URL}/rooms/${fixture.roomId}/mark-clean`, { headers: direccion.headers, data: {} });
    expect(cleaned.ok(), `POST /rooms/:id/mark-clean → ${cleaned.status()} ${(await cleaned.text().catch(() => "")).slice(0, 200)}`).toBeTruthy();
  }
});
