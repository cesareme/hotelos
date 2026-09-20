import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { CHK, E2E_API_URL, E2E_GUEST_BASE_URL, assertConsoleClean, assertTargets, createSyntheticReservation, forceCoarse, isoDay, loginAsChk, releaseReservationRoom, shot, watchConsole } from "./_guest-helpers";
import type { ChkSession } from "./_guest-helpers";

/**
 * Encuesta post-estancia del portal del huésped de punta a punta (Tanda L7 ·
 * lote L7-08 · proyecto Playwright `guest`, móvil emulado Pixel 5 con
 * `pointer: coarse`, es-ES; tenant CHK de seed-checkin, nombres INVENTADOS):
 *   0. recepción crea por API una reserva sintética que llega hoy, la aloja en
 *      una Doble libre (POST check-in) y le hace el check-out (folio vacío:
 *      saldo 0, sin cargo de alojamiento hasta el cierre del día);
 *   1. POST /reservations/:id/post-stay/survey-invite (L7-04) → `invited`
 *      SIMULADO (sin EMAIL_PROVIDER) con `surveyUrl` = `/?survey=1&token=…&property=…`;
 *      con proveedor real la ruta no devuelve el enlace y la spec FALLA con el motivo;
 *   2. el enlace abre SurveyPage (token fuera de la URL, sesión en sessionStorage):
 *      NPS 0-10 como radiogroup de botones ≥ 44 px, comentario;
 *   3. envío → POST /guest-portal/survey 201 → «¡Gracias por tu opinión!»;
 *   4. repetir por API con el mismo token → 409 SURVEY_ALREADY_ANSWERED; recargar
 *      la página → estado «Ya has respondido» (sin formulario);
 *   5. la sesión del enlace es SOLO de la encuesta (corrector L7-REV-01): «Entrar en
 *      el portal con mi código» cierra la sesión → acceso por código + correo →
 *      estancia terminada con «Gracias por tu opinión.» y sin CTA de encuesta; el
 *      recorrido de recepción (L7-07) ve la respuesta;
 *   6. enlace caducado (token inválido, pestaña sin sesión) → pantalla de acceso
 *      con el aviso y 401 esperado.
 * Al terminar (corrector L7-REV-10) la habitación usada vuelve a estar limpia.
 * En cada pantalla: captura (E2E_SHOTS_DIR) y contrato de tamaño de objetivos
 * (assertTargets: 0 < 24 px; los < 44 px a JSON). Al final: 0 excepciones, 0
 * errores de consola salvo el 401 esperado, token nunca en una URL del API.
 * Sin skip: sin API, seed o portal la spec FALLA con el motivo.
 */

type ChkRoom = { id: string; number: string; roomTypeId: string; status: string; housekeepingStatus?: string; sellable?: boolean };

/** Habitaciones que otras reservas vivas de prop_chk tienen asignadas hoy (canAssignRoom las rechaza con 409). */
async function heldRoomsChk(request: APIRequestContext, session: ChkSession, stay: { arrival: string; departure: string }): Promise<Set<string>> {
  const url = `${E2E_API_URL}/properties/${CHK.propertyId}/reservations?from=${stay.arrival}&to=${stay.departure}&status=confirmed,checked_in&limit=500&envelope=1`;
  const response = await request.get(url, { headers: session.headers });
  expect(response.ok(), `GET reservations → ${response.status()}`).toBeTruthy();
  const payload = (await response.json()) as { items?: Array<{ assignedRoomId?: string | null }> } | Array<{ assignedRoomId?: string | null }>;
  const items = Array.isArray(payload) ? payload : (payload.items ?? []);
  return new Set(items.filter((item) => item.assignedRoomId).map((item) => item.assignedRoomId as string));
}

/** Doble de prop_chk libre, vendible, limpia o inspeccionada y sin otra reserva hoy (la de número más alto, lejos de la sugerencia «primera por número»). */
async function freeRoomChk(request: APIRequestContext, session: ChkSession, stay: { arrival: string; departure: string }): Promise<ChkRoom> {
  const response = await request.get(`${E2E_API_URL}/properties/${CHK.propertyId}/rooms`, { headers: session.headers });
  expect(response.ok(), `GET rooms → ${response.status()}`).toBeTruthy();
  const rooms = (await response.json()) as ChkRoom[];
  const held = await heldRoomsChk(request, session, stay);
  const free = rooms
    .filter((room) => room.roomTypeId === CHK.roomTypeId && !held.has(room.id) && room.sellable !== false && room.status !== "occupied" && room.status !== "out_of_order" && (room.housekeepingStatus === "clean" || room.housekeepingStatus === "inspected"))
    .sort((a, b) => b.number.localeCompare(a.number, "es", { numeric: true }));
  expect(free.length, "sin Doble libre y limpia en prop_chk para alojar la reserva de prueba (rearma el seed con --reset)").toBeGreaterThan(0);
  return free[0];
}

type InviteResult = { reservationId: string; status: string; reason: string | null; dispatched: boolean; simulated: boolean; channel: string | null; recipient: string | null; deliveryId: string | null; surveyUrl?: string };

test.describe.configure({ mode: "serial" });

test("el huésped responde la encuesta post-estancia desde el enlace en móvil: NPS, comentario, gracias, 409 al repetir y enlace caducado", async ({ page, request }, testInfo) => {
  test.setTimeout(150_000);

  // 0 · Reserva sintética alojada y con check-out hecho (recepción, por API).
  const session = await loginAsChk(request, "recepcion");
  const stay = { arrival: isoDay(0), departure: isoDay(1) };
  const room = await freeRoomChk(request, session, stay);
  const reservation = await createSyntheticReservation(request, { ...stay, adults: 1, session });
  const checkedIn = await request.post(`${E2E_API_URL}/reservations/${reservation.id}/check-in`, { headers: session.headers, data: { roomId: room.id } });
  expect(checkedIn.ok(), `POST check-in (habitación ${room.number}) → ${checkedIn.status()} ${(await checkedIn.text().catch(() => "")).slice(0, 200)}`).toBeTruthy();
  const checkedOut = await request.post(`${E2E_API_URL}/reservations/${reservation.id}/check-out`, { headers: session.headers, data: {} });
  expect(checkedOut.ok(), `POST check-out → ${checkedOut.status()} ${(await checkedOut.text().catch(() => "")).slice(0, 200)}`).toBeTruthy();
  try {

  // 1 · Invitación forzada a la encuesta (L7-04): simulada sin proveedor de correo → enlace en claro.
  const invited = await request.post(`${E2E_API_URL}/reservations/${reservation.id}/post-stay/survey-invite`, { headers: session.headers, data: {} });
  expect(invited.ok(), `POST survey-invite → ${invited.status()} ${(await invited.text().catch(() => "")).slice(0, 200)}`).toBeTruthy();
  const invitation = (await invited.json()) as InviteResult;
  expect(invitation.status, `la invitación no salió: ${invitation.reason ?? "sin motivo"}`).toBe("invited");
  expect(invitation.channel).toBe("email");
  expect(invitation.recipient ?? "", "el destinatario llega enmascarado").toMatch(/\*/);
  expect(invitation.surveyUrl, "sin `surveyUrl`: el envío no fue simulado (EMAIL_PROVIDER configurado) y la spec no puede abrir la encuesta").toBeTruthy();
  const link = new URL(invitation.surveyUrl as string);
  expect(link.searchParams.get("survey")).toBe("1");
  expect(link.searchParams.get("property")).toBe(CHK.propertyId);
  const token = link.searchParams.get("token") as string;
  expect(token).toBeTruthy();
  // La base del enlace la fija GUEST_WEB_BASE_URL en el API; el portal bajo prueba es E2E_GUEST_BASE_URL.
  const surveyUrl = `${E2E_GUEST_BASE_URL}/?${new URLSearchParams({ survey: "1", token, property: CHK.propertyId }).toString()}`;
  const watch = watchConsole(page, token);

  // 2 · Enlace → SurveyPage con el token fuera de la URL.
  await test.step("enlace de la encuesta → formulario NPS", async () => {
    await forceCoarse(page);
    await page.goto(surveyUrl, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1, name: "¿Qué tal tu estancia?" })).toBeVisible({ timeout: 20_000 });
    expect(page.url(), "el token del enlace no debe quedar en la barra de direcciones").not.toContain("token=");
    expect(page.url()).toContain("survey=1");
    const stored = await page.evaluate(() => ({
      session: Object.keys(window.sessionStorage),
      local: Object.keys(window.localStorage).filter((key) => key.startsWith("hotelos.guest"))
    }));
    expect(stored.session, "la sesión del huésped vive en sessionStorage").toContain("hotelos.guest.session");
    expect(stored.local, "nunca en localStorage").toEqual([]);
    await expect(page.locator(".gp-hero-code")).toHaveText(reservation.code);
    const group = page.getByRole("radiogroup").first();
    await expect(group).toBeVisible();
    await expect(group.getByRole("radio")).toHaveCount(11);
    await expect(group.getByRole("radio", { name: "Puntuación 0" })).toBeVisible();
    await expect(group.getByRole("radio", { name: "Puntuación 10" })).toBeVisible();
    await shot(page, "survey-01-formulario");
    const audit = await assertTargets(page, testInfo, "survey-01-formulario");
    // Los 11 botones del NPS miden ≥ 44 × 44 px (gp-chip + gp-link): ninguno en la lista de < 44 px.
    expect(audit.below44.filter((sample) => /^Puntuación \d+$/.test(sample.label)), "botones NPS < 44 px").toEqual([]);
  });

  // 3 · Validación en cliente, puntuación y comentario, envío 201 → gracias.
  await test.step("responder → 201 y gracias", async () => {
    const submit = page.getByRole("button", { name: "Enviar mi opinión", exact: true });
    await submit.click();
    await expect(page.getByRole("alert").filter({ hasText: "Elige una puntuación de 0 a 10." })).toBeVisible();
    const nine = page.getByRole("radio", { name: "Puntuación 9" });
    await nine.click();
    await expect(nine).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("radio", { name: "Puntuación 8" })).toHaveAttribute("aria-checked", "false");
    await expect(page.getByRole("alert").filter({ hasText: "Elige una puntuación" })).toHaveCount(0);
    // Teclado: flecha derecha mueve la selección al 10 y el foco con ella.
    await nine.press("ArrowRight");
    await expect(page.getByRole("radio", { name: "Puntuación 10" })).toHaveAttribute("aria-checked", "true");
    await page.getByRole("radio", { name: "Puntuación 10" }).press("ArrowLeft");
    await expect(nine).toHaveAttribute("aria-checked", "true");
    await page.getByLabel("¿Qué podríamos mejorar?").fill("Prueba e2e L7-08: todo correcto, el desayuno podría abrir antes.");
    await shot(page, "survey-02-puntuacion");
    await assertTargets(page, testInfo, "survey-02-puntuacion");
    const submitResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/guest-portal/survey"));
    await submit.click();
    const sent = await submitResponse;
    expect(sent.status(), "POST /guest-portal/survey").toBe(201);
    const body = (await sent.json()) as { responseId: string; surveyId: string; score: number; answeredAt: string };
    expect(body.score).toBe(9);
    expect(body.responseId).toBeTruthy();
    const posted = sent.request().postDataJSON() as { score: number; answers?: Record<string, unknown> };
    expect(posted).toEqual({ score: 9, answers: { comment: "Prueba e2e L7-08: todo correcto, el desayuno podría abrir antes." } });
    await expect(page.getByRole("status").filter({ hasText: "¡Gracias por tu opinión!" })).toBeVisible();
    await expect(page.getByText("Has elegido 9 de 10.")).toBeVisible();
    await shot(page, "survey-03-gracias");
    await assertTargets(page, testInfo, "survey-03-gracias");
  });

  // 4 · Una respuesta por reserva: el API responde 409 y la página, al volver, muestra el estado.
  await test.step("repetir → 409 SURVEY_ALREADY_ANSWERED y estado «ya respondida»", async () => {
    const again = await request.post(`${E2E_API_URL}/guest-portal/survey`, { headers: { "x-guest-token": token }, data: { score: 1 } });
    expect(again.status(), "segunda respuesta con el mismo token").toBe(409);
    const conflict = (await again.json()) as { details?: { code?: string; answeredAt?: string } };
    expect(conflict.details?.code).toBe("SURVEY_ALREADY_ANSWERED");
    const view = await request.get(`${E2E_API_URL}/guest-portal/survey`, { headers: { "x-guest-token": token } });
    expect(view.ok()).toBeTruthy();
    const surveyView = (await view.json()) as { answered: boolean; available: boolean; stage: string };
    expect(surveyView).toMatchObject({ answered: true, available: false, stage: "post_stay" });
    // Recarga sin token (la sesión sigue en sessionStorage): estado honesto, sin formulario.
    await page.goto(`${E2E_GUEST_BASE_URL}/?survey=1&property=${CHK.propertyId}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Ya has respondido a esta encuesta. ¡Gracias!")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/^Respondida el /)).toBeVisible();
    await expect(page.getByRole("radiogroup")).toHaveCount(0);
    // Corrector L7-REV-01: el token del enlace NO abre el resto del portal.
    const stayWithSurveyToken = await request.get(`${E2E_API_URL}/guest-portal/stay`, { headers: { "x-guest-token": token } });
    expect(stayWithSurveyToken.status(), "la sesión de la encuesta no lee la estancia").toBe(401);
    const reservationWithSurveyToken = await request.get(`${E2E_API_URL}/guest-portal/reservation`, { headers: { "x-guest-token": token } });
    expect(reservationWithSurveyToken.status()).toBe(401);
    await shot(page, "survey-04-respondida");
    await assertTargets(page, testInfo, "survey-04-respondida");
  });

  // 5 · La sesión del enlace es solo de la encuesta: «Entrar en el portal con mi código» → acceso → estancia terminada con la opinión recibida y sin CTA de encuesta; recepción ve la respuesta (L7-07).
  await test.step("entrar en el portal con el código → estancia terminada", async () => {
    await expect(page.getByRole("button", { name: "Volver a mi estancia" })).toHaveCount(0, { timeout: 5_000 });
    await page.getByRole("button", { name: "Entrar en el portal con mi código" }).first().click();
    await expect(page.getByLabel("Código de reserva")).toBeVisible({ timeout: 15_000 });
    await page.getByLabel("Código de reserva").fill(reservation.code);
    await page.getByLabel("Correo electrónico").fill(reservation.email);
    await page.getByRole("button", { name: "Continuar", exact: true }).click();
    const surveyBlock = page.locator(".gp-survey");
    await expect(surveyBlock).toBeVisible({ timeout: 15_000 });
    await expect(surveyBlock).toContainText("Gracias por tu opinión.");
    await expect(page.locator(".gp-pill", { hasText: "Estancia terminada" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Responder la encuesta/ })).toHaveCount(0);
    await shot(page, "survey-05-estancia");
    await assertTargets(page, testInfo, "survey-05-estancia");
    const journey = await request.get(`${E2E_API_URL}/reservations/${reservation.id}/guest-journey`, { headers: session.headers });
    expect(journey.ok(), `GET /reservations/:id/guest-journey → ${journey.status()}`).toBeTruthy();
    const view = (await journey.json()) as { survey: { invitedAt: string | null; answeredAt: string | null; score: number | null } };
    expect(view.survey.invitedAt, "la invitación queda registrada").toBeTruthy();
    expect(view.survey.answeredAt, "la respuesta queda registrada").toBeTruthy();
    expect(view.survey.score).toBe(9);
  });

  // 6 · Enlace caducado: sin sesión en la pestaña y token inválido → pantalla de acceso con el aviso.
  await test.step("enlace caducado → acceso por código", async () => {
    await page.evaluate(() => window.sessionStorage.clear());
    await page.goto(`${E2E_GUEST_BASE_URL}/?survey=1&token=caducado-e2e&property=${CHK.propertyId}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("alert").filter({ hasText: "Tu enlace de acceso ha caducado o no es válido." })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByLabel("Código de reserva")).toBeVisible();
    expect(page.url()).not.toContain("token=");
    await shot(page, "survey-06-enlace-caducado");
    await assertTargets(page, testInfo, "survey-06-enlace-caducado");
  });

  // El enlace caducado se verifica contra GET /guest-portal/survey (sesión acotada, corrector L7-REV-01).
  assertConsoleClean(watch, [{ path: /\/guest-portal\/survey$/, status: 401 }]);
  } finally {
    await releaseReservationRoom(request, reservation.id, room.id);
  }
});
