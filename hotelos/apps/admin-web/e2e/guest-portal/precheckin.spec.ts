import { expect, test } from "@playwright/test";
import {
  CHK,
  E2E_API_URL,
  SYNTHETIC_GUEST,
  assertConsoleClean,
  assertTargets,
  createSyntheticReservation,
  releaseReservationRoom,
  forceCoarse,
  guestUrl,
  invite,
  isoDay,
  loginAsChk,
  shot,
  syntheticMrz,
  tinyPng,
  watchConsole
} from "./_guest-helpers";

/**
 * Pre-check-in del portal del huésped de punta a punta (Tanda L7 · lote L7-03 ·
 * proyecto Playwright `guest`, móvil emulado 393 × 851 con `pointer: coarse`,
 * es-ES; tenant CHK de seed-checkin, nombres INVENTADOS). Mismo recorrido que
 * la verificación W4-C de TANDA-CHK (l.100) pero como spec repetible:
 *   0. recepción crea por API una reserva sintética (llegada dentro de
 *      `E2E_GUEST_ARRIVAL_OFFSET_DAYS` días, 3 por defecto) y la invita;
 *   1. enlace mágico `/checkin?token=…&property=prop_chk` → sesión en
 *      sessionStorage y token FUERA de la URL (App.tsx consumeUrlToken);
 *   2. Viajeros: el titular ya viene con nombre (adults 1: el asistente reanuda
 *      en «Documento» y se vuelve a «Viajeros» para medirlo). NO se ejercita
 *      «Quitar»: apps/guest-web/src/api/client.ts request() fija
 *      Content-Type: application/json y removeGuest manda DELETE sin cuerpo →
 *      Fastify 400 «Body cannot be empty» antes de la ruta (defecto del cliente,
 *      fichero de L7-06; cuando se corrija, añadir aquí la acompañante y quitarla);
 *   3. Documento: «foto» (PNG de 1 px) sin proveedor de visión → 400
 *      DOCUMENT_UNREADABLE con aviso role=alert y campo de MRZ abierto → MRZ
 *      sintética válida → «Documento leído · termina en NNN» (leído de la MRZ);
 *   4. Datos: solo faltan dirección, localidad y país → guardar → «Listo para
 *      llegar»; consentimientos RGPD e IA (PATCH por casilla);
 *   5. Firma: al entrar se cierra el pre-check-in (complete → parte de viajeros)
 *      y el trazo en el canvas → «Firmar» 201 → «Firmado el …»;
 *   6. Pago y extras: SIN PSP el estado es honesto: `no_folio` («No hay nada
 *      pendiente»), `at_reception` («se cobrará en recepción») o `settled`
 *      SOLO si el folio que abre la reserva tiene saldo 0 (la reserva creada por
 *      API nace con folio vacío: el alojamiento se carga en el cierre del día);
 *      nunca `link_sent` ni «Pagar ahora»;
 *   7. Llegada: ETA + preferencia guardadas; identidad por mrz_checksum (sin
 *      OTP); «Ya estoy en el hotel» → 409 CHECK_IN_DATE_OUT_OF_RANGE («Podrás
 *      hacer el check-in el …») fuera de la ventana ±1 día, o 200 con habitación
 *      y llave si la reserva llega hoy (offset 0);
 *   8. «Volver a mi estancia» → bloque de pre-check-in «Listo para llegar».
 * En cada paso: captura (E2E_SHOTS_DIR) y contrato de tamaño de objetivos
 * (assertTargets: 0 < 24 px; los < 44 px a JSON). Al final: 0 excepciones, 0
 * errores de consola salvo los de las dos respuestas esperadas, token nunca en
 * una URL. Sin skip: sin API, seed o portal la spec FALLA con el motivo.
 */

const ARRIVAL_OFFSET_DAYS = Number(process.env.E2E_GUEST_ARRIVAL_OFFSET_DAYS ?? "3");
/** Ventana ±1 día de arrival.service.ts: con la llegada hoy (±1) el check-in autónomo se admite. */
const EXPECT_ARRIVAL_OK = Math.abs(ARRIVAL_OFFSET_DAYS) <= 1;

const DOCUMENT = {
  number: "PRB000123",
  nationality: "ESP",
  dateOfBirth: "1990-05-14",
  sex: "M" as const,
  expiryDate: "2033-05-13"
};

test.describe.configure({ mode: "serial" });

test("el huésped completa el pre-check-in desde el enlace mágico en móvil: documento, datos, firma, pago honesto y llegada", async ({ page, request }, testInfo) => {
  test.setTimeout(150_000);

  // 0 · Reserva sintética + invitación (recepción, por API).
  const session = await loginAsChk(request, "recepcion");
  const reservation = await createSyntheticReservation(request, { arrival: isoDay(ARRIVAL_OFFSET_DAYS), departure: isoDay(ARRIVAL_OFFSET_DAYS + 2), adults: 1, session });
  const invitation = await invite(request, reservation.id, { session });
  expect(invitation.sessionStatus, "la invitación deja la sesión de check-in abierta").toMatch(/^(invited|in_progress)$/);
  const watch = watchConsole(page, invitation.token);
  try {
  const mrz = syntheticMrz({ surname: SYNTHETIC_GUEST.surname1, givenNames: SYNTHETIC_GUEST.firstName, documentNumber: DOCUMENT.number, ...DOCUMENT });
  const progress = page.getByRole("group", { name: /^Paso \d de 6$/ });
  const stepOf = async (): Promise<number> => Number(/Paso (\d) de 6/.exec((await progress.getAttribute("aria-label")) ?? "")?.[1] ?? 0);
  const next = page.getByRole("button", { name: "Continuar", exact: true });

  // 1 · Enlace mágico: sesión creada, token retirado de la URL, asistente abierto.
  await test.step("enlace mágico → token fuera de la URL", async () => {
    await forceCoarse(page);
    await page.goto(guestUrl(invitation.token), { waitUntil: "domcontentloaded" });
    await expect(page.locator(".gp-wizard")).toBeVisible({ timeout: 20_000 });
    expect(page.url(), "el token del enlace no debe quedar en la barra de direcciones").not.toContain("token=");
    expect(page.url()).toContain(`property=${CHK.propertyId}`);
    const stored = await page.evaluate(() => ({
      session: Object.keys(window.sessionStorage),
      local: Object.keys(window.localStorage).filter((key) => key.startsWith("hotelos.guest"))
    }));
    expect(stored.session, "la sesión del huésped vive en sessionStorage").toContain("hotelos.guest.session");
    expect(stored.local, "nunca en localStorage").toEqual([]);
    await expect(page.locator(".gp-hero-code")).toHaveText(reservation.code);
  });

  // 2 · Viajeros: el titular ya tiene nombre → el asistente reanuda en «Documento»; se vuelve a «Viajeros» para medirlo.
  await test.step("viajeros", async () => {
    expect(await stepOf(), "con el titular ya nombrado el asistente reanuda en el paso 2").toBe(2);
    await page.getByRole("button", { name: "Atrás", exact: true }).click();
    await expect(progress).toHaveAttribute("aria-label", "Paso 1 de 6");
    const cards = page.locator("form.gp-traveller");
    await expect(cards).toHaveCount(1);
    await expect(cards.first().getByLabel("Nombre", { exact: true })).toHaveValue(SYNTHETIC_GUEST.firstName);
    await expect(cards.first().getByLabel("Primer apellido", { exact: true })).toHaveValue(SYNTHETIC_GUEST.surname1);
    // adults 1: la plaza está cubierta y el botón lo dice (deshabilitado, fuera de la medida de objetivos).
    await expect(page.getByRole("button", { name: "La reserva ya tiene todos los viajeros declarados." })).toBeDisabled();
    await shot(page, "precheckin-01-viajeros");
    await assertTargets(page, testInfo, "01-viajeros");
    await expect(next).toBeEnabled();
    await next.click();
    await expect(progress).toHaveAttribute("aria-label", "Paso 2 de 6");
  });

  // 3 · Documento: foto sin proveedor → 400 → MRZ sintética válida.
  await test.step("documento: foto sin proveedor 400 → MRZ válida", async () => {
    await expect(next, "sin documento no se puede continuar").toBeDisabled();
    await shot(page, "precheckin-02-documento");
    await assertTargets(page, testInfo, "02-documento");
    const documentResponse = page.waitForResponse((response) => /\/guest-portal\/check-in\/guests\/[^/]+\/document$/.test(new URL(response.url()).pathname));
    await page.locator('input[type="file"]').setInputFiles({ name: "documento.png", mimeType: "image/png", buffer: tinyPng() });
    expect((await documentResponse).status(), "sin proveedor de visión la foto se rechaza").toBe(400);
    await expect(page.getByRole("alert").filter({ hasText: "No hemos podido leer el documento" })).toBeVisible();
    const mrzInput = page.locator(".gp-mrz-input");
    await expect(mrzInput, "el 400 abre el campo de la MRZ").toBeVisible();
    await shot(page, "precheckin-03-documento-ilegible");
    await assertTargets(page, testInfo, "03-documento-ilegible");
    await mrzInput.fill(mrz.join("\n"));
    const mrzResponse = page.waitForResponse((response) => /\/guest-portal\/check-in\/guests\/[^/]+\/mrz$/.test(new URL(response.url()).pathname));
    await page.getByRole("button", { name: "Leer la MRZ" }).click();
    expect((await mrzResponse).status()).toBe(200);
    await expect(page.getByText(`Documento leído · termina en ${DOCUMENT.number.slice(-3)}`)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".gp-document .gp-meta").first()).toContainText("leído de la MRZ");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await shot(page, "precheckin-04-documento-leido");
    await assertTargets(page, testInfo, "04-documento-leido");
    await expect(next).toBeEnabled();
    await next.click();
    await expect(progress).toHaveAttribute("aria-label", "Paso 3 de 6");
  });

  // 4 · Datos: residencia + consentimientos.
  await test.step("datos y consentimientos", async () => {
    const form = page.locator("form.gp-details").first();
    await expect(form.locator(".gp-missing"), "la MRZ deja solo la residencia pendiente").toHaveText("Dirección completa · Localidad · País de residencia (código ISO)");
    // Campos no personales de la lectura prefijados con su origen; el número (PII) solo como «···últimos 3».
    await expect(form.getByLabel(/^Sexo/)).toHaveValue(DOCUMENT.sex);
    await expect(form.getByLabel(/^Nacionalidad/)).toHaveValue(DOCUMENT.nationality);
    await expect(form.getByLabel(/^Fecha de nacimiento/)).toHaveValue(DOCUMENT.dateOfBirth);
    await expect(form.getByLabel(/^Tipo de documento/)).toHaveValue("PASSPORT");
    await expect(form.getByLabel(/^Número de documento/)).toHaveValue("");
    await expect(form.getByLabel(/^Número de documento/)).toHaveAttribute("placeholder", `···${DOCUMENT.number.slice(-3)}`);
    // sexo · nacionalidad · nacimiento · tipo · caducidad: cinco campos de la MRZ con su origen.
    await expect(form.locator(".gp-badge-source")).toHaveCount(5);
    await expect(form.locator(".gp-badge-source").first()).toContainText("leído de la MRZ");
    await shot(page, "precheckin-05-datos");
    await assertTargets(page, testInfo, "05-datos");
    await form.getByLabel("Dirección completa", { exact: true }).fill("Rúa de Proba 9");
    await form.getByLabel("Localidad", { exact: true }).fill("A Coruña");
    await form.getByLabel(/^País de residencia/).fill("ESP");
    const saveResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && /\/guest-portal\/check-in\/guests\/[^/]+$/.test(new URL(response.url()).pathname));
    await form.getByRole("button", { name: "Guardar", exact: true }).click();
    expect((await saveResponse).status()).toBe(200);
    await expect(form.locator(".gp-missing")).toHaveCount(0);
    await expect(form.locator(".gp-pill")).toHaveText("Listo para llegar");
    await expect(next, "sin consentimiento RGPD no se continúa").toBeDisabled();
    for (const label of [/He leído el tratamiento de mis datos/, /Entiendo que un asistente automático/]) {
      const box = page.getByLabel(label);
      await expect(box).toBeEnabled();
      const consentResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname.endsWith("/guest-portal/check-in"));
      await box.click();
      expect((await consentResponse).status()).toBe(200);
      await expect(box).toBeChecked();
    }
    await shot(page, "precheckin-06-datos-consentimiento");
    await assertTargets(page, testInfo, "06-datos-consentimiento");
    await expect(next).toBeEnabled();
    const completeResponse = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/guest-portal/check-in/complete"));
    await next.click();
    await expect(progress).toHaveAttribute("aria-label", "Paso 4 de 6");
    expect((await completeResponse).status(), "al entrar en Firma se cierra el pre-check-in (parte de viajeros)").toBe(200);
  });

  // 5 · Firma en el canvas.
  await test.step("firma", async () => {
    const pad = page.locator(".gp-signature").first();
    await expect(pad).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".gp-signature.is-disabled"), "el canvas se habilita cuando el parte existe").toHaveCount(0, { timeout: 15_000 });
    const sign = page.getByRole("button", { name: "Firmar", exact: true });
    await expect(sign, "sin trazo no se firma").toBeDisabled();
    await shot(page, "precheckin-07-firma");
    await assertTargets(page, testInfo, "07-firma");
    const canvas = page.getByRole("img", { name: "Firma aquí con el dedo" });
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    const { x, y, width, height } = box!;
    await page.mouse.move(x + width * 0.1, y + height * 0.5);
    await page.mouse.down();
    for (let i = 1; i <= 24; i += 1) await page.mouse.move(x + width * 0.1 + i * (width * 0.03), y + height * 0.5 + Math.sin(i / 2) * height * 0.2, { steps: 3 });
    await page.mouse.up();
    await expect(sign).toBeEnabled();
    const signResponse = page.waitForResponse((response) => /\/guest-portal\/check-in\/guests\/[^/]+\/signature$/.test(new URL(response.url()).pathname));
    await sign.click();
    expect((await signResponse).status()).toBe(201);
    await expect(page.locator(".gp-signature-card .gp-meta").first()).toContainText("Firmado el", { timeout: 10_000 });
    await expect(page.locator(".gp-signature-card .gp-pill")).toHaveText("Listo para llegar");
    await shot(page, "precheckin-08-firmado");
    await assertTargets(page, testInfo, "08-firmado");
    await expect(next).toBeEnabled();
  });

  // 6 · Pago y extras: estado honesto sin PSP.
  await test.step("pago honesto (sin PSP)", async () => {
    const paymentResponse = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/guest-portal/check-in/payment-link"));
    await next.click();
    await expect(progress).toHaveAttribute("aria-label", "Paso 5 de 6");
    const payment = await paymentResponse;
    expect(payment.status()).toBeLessThan(300);
    const outcome = (await payment.json()) as { status: string };
    // Corrector L7-REV-03: un folio SIN líneas responde `no_charges` (nunca «pagado» sobre una cuenta vacía).
    expect(outcome.status, "sin PSP configurado nunca hay enlace de pago").toMatch(/^(no_folio|no_charges|at_reception|settled)$/);
    if (outcome.status === "no_charges") {
      const folio = await request.get(`${E2E_API_URL}/reservations/${reservation.id}/folio`, { headers: session.headers });
      expect(folio.ok(), `GET /reservations/:id/folio → ${folio.status()}`).toBeTruthy();
      const empty = (await folio.json()) as { lines?: unknown[]; balanceDue: number };
      expect((empty.lines ?? []).length, "no_charges exige un folio sin líneas").toBe(0);
      expect(empty.balanceDue).toBe(0);
    }
    if (outcome.status === "settled") {
      // «Todo pagado» solo es honesto con saldo 0 real en el folio de la reserva.
      const folio = await request.get(`${E2E_API_URL}/reservations/${reservation.id}/folio`, { headers: session.headers });
      expect(folio.ok(), `GET /reservations/:id/folio → ${folio.status()}`).toBeTruthy();
      const balance = (await folio.json()) as { reservationBalanceDue: number; balanceDue: number };
      expect(balance.reservationBalanceDue, "settled exige saldo 0 en la reserva").toBe(0);
      expect(balance.balanceDue).toBe(0);
    }
    const MESSAGE: Record<string, string> = {
      no_folio: "No hay nada pendiente de pago.",
      no_charges: "No hay nada pendiente de pago.",
      at_reception: "El importe pendiente se cobrará en recepción a tu llegada.",
      settled: "Todo pagado. ¡Gracias!"
    };
    await expect(page.locator(".gp-payment-message")).toHaveText(MESSAGE[outcome.status]!);
    await expect(page.getByRole("button", { name: "Pagar ahora" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Comprobar el pago" })).toHaveCount(0);
    await shot(page, "precheckin-09-pago");
    await assertTargets(page, testInfo, "09-pago");
    await expect(next).toBeEnabled();
    await next.click();
    await expect(progress).toHaveAttribute("aria-label", "Paso 6 de 6");
  });

  // 7 · Llegada: ETA + preferencia, identidad por MRZ, arrive.
  await test.step(`llegada → ${EXPECT_ARRIVAL_OK ? "200 habitación y llave" : "409 fuera de la ventana de fechas"}`, async () => {
    await page.getByLabel("Hora estimada de llegada").fill("16:30");
    const chip = page.getByRole("button", { name: "Tranquila", exact: true });
    await chip.click();
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    const prefsResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname.endsWith("/guest-portal/check-in"));
    await page.getByRole("button", { name: "Guardar preferencias" }).click();
    expect((await prefsResponse).status()).toBe(200);
    // Política CHK: mrz_checksum admitido → la MRZ válida ya verifica al titular; sin OTP pendiente.
    const otp = page.locator(".gp-otp");
    if (await otp.count()) await expect(otp).toContainText("Identidad verificada.");
    await expect(page.getByRole("button", { name: "Enviar código al correo" })).toHaveCount(0);
    await shot(page, "precheckin-10-llegada");
    await assertTargets(page, testInfo, "10-llegada");
    const arriveResponse = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/guest-portal/check-in/arrive"));
    await page.getByRole("button", { name: "Ya estoy en el hotel" }).click();
    const arrive = await arriveResponse;
    if (EXPECT_ARRIVAL_OK) {
      expect(arrive.status(), "con la llegada en la ventana ±1 día el check-in autónomo se hace").toBe(200);
      await expect(page.locator(".gp-room-number")).toBeVisible({ timeout: 15_000 });
      await expect(page.locator(".gp-arrival-badges")).toContainText("Check-in hecho");
    } else {
      expect(arrive.status(), `llegada dentro de ${ARRIVAL_OFFSET_DAYS} días: fuera de la ventana ±1 día`).toBe(409);
      const body = (await arrive.json()) as { details?: { code?: string } };
      expect(body.details?.code).toBe("CHECK_IN_DATE_OUT_OF_RANGE");
      await expect(page.locator(".gp-arrival-message")).toContainText("Podrás hacer el check-in el", { timeout: 15_000 });
      await expect(page.locator(".gp-arrival-pending")).toContainText("CHECK_IN_DATE_OUT_OF_RANGE");
    }
    await shot(page, "precheckin-11-arrive-resultado");
    await assertTargets(page, testInfo, "11-arrive-resultado");
  });

  // 8 · Vuelta a la estancia: bloque de pre-check-in con el estado real.
  await test.step("volver a mi estancia", async () => {
    await page.getByRole("button", { name: "Volver a mi estancia" }).first().click();
    const block = page.locator(".gp-precheckin");
    await expect(block).toBeVisible({ timeout: 15_000 });
    await expect(block).toContainText(EXPECT_ARRIVAL_OK ? "Check-in hecho" : "Listo para llegar");
    await shot(page, "precheckin-12-estancia");
    await assertTargets(page, testInfo, "12-estancia");
  });

  // Estado en el API (personal): la sesión refleja lo hecho; nada de PII en la vista.
  const view = await request.get(`${E2E_API_URL}/reservations/${reservation.id}/check-in`, { headers: session.headers });
  expect(view.ok(), `GET /reservations/:id/check-in → ${view.status()}`).toBeTruthy();
  const checkIn = (await view.json()) as { status: string; paymentStatus: string; guests: Array<{ status: string; identityVerificationMethod: string | null; documentNumberLast3: string | null }> };
  expect(checkIn.status).toBe(EXPECT_ARRIVAL_OK ? "checked_in" : "ready_for_arrival");
  expect(checkIn.paymentStatus).not.toBe("paid_by_portal");
  expect(checkIn.guests[0]?.status).toMatch(/^(signed|verified)$/);
  expect(checkIn.guests[0]?.identityVerificationMethod).toBe("mrz_checksum");
  expect(checkIn.guests[0]?.documentNumberLast3).toBe(DOCUMENT.number.slice(-3));

  assertConsoleClean(watch, [
    { path: /\/guest-portal\/check-in\/guests\/[^/]+\/document$/, status: 400 },
    ...(EXPECT_ARRIVAL_OK ? [] : [{ path: /\/guest-portal\/check-in\/arrive$/, status: 409 }])
  ]);
  } finally {
    // Corrector L7-REV-10: la habitación asignada en la llegada vuelve a estar limpia (y la reserva salida) para la siguiente corrida.
    await releaseReservationRoom(request, reservation.id);
  }
});
