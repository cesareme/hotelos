import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  CHK,
  E2E_API_URL,
  E2E_GUEST_BASE_URL,
  SYNTHETIC_GUEST,
  assertConsoleClean,
  assertTargets,
  createSyntheticReservation,
  forceCoarse,
  invite,
  isoDay,
  loginAsChk,
  shot,
  syntheticMrz,
  tinyPng,
  watchConsole,
  type ChkSession,
  type SyntheticReservation
} from "./_guest-helpers";

/**
 * Estancia y salida del portal del huésped de punta a punta (Tanda L7 · lote
 * L7-09 · proyecto Playwright `guest`, móvil 390 × 844 con `pointer: coarse`,
 * es-ES; tenant CHK de seed-checkin, titular INVENTADO «Prueba Portal»).
 * Recorrido de un huésped que ya está alojado (recon §19.2-19.5, L7-02/L7-06):
 *   0. fixture por API: recepción crea la reserva (llega hoy), la invita, el
 *      pre-check-in se cierra por las rutas del huésped (MRZ sintética → datos
 *      de residencia → consentimientos → complete → firma PNG) y recepción hace
 *      el check-in con POST /reservations/:id/check-in/complete (habitación
 *      asignada + llave móvil de demo); después carga un consumo en el folio
 *      (POST /folios/:id/lines) para que haya saldo REAL pendiente; si el hotel
 *      no tiene datos publicados (faq de PropertyAiSetting) dirección los fija;
 *   1. el huésped entra por código de reserva + correo (SignInPage; el token
 *      vuelve en la respuesta y nunca viaja en una URL) → estancia «En el
 *      hotel»: check-in hecho, llave emitida, habitación y saldo pendiente;
 *   2. «Información del hotel»: solo lo que el API devuelve (wifi, desayuno,
 *      hora de salida, teléfono como enlace tel:, dirección);
 *   3. «Salida y cuenta»: el cargo del folio con su importe; «Quiero pagar
 *      ahora» → POST /guest-portal/stay/payment-link → sin PSP `at_reception`
 *      («se cobra en recepción»); NUNCA «Pagar ahora»;
 *   4. petición «Salida tardía» con hora → POST /guest-portal/stay/requests 201
 *      → nº SRQ-<8> en pantalla, la misma fila en GET /reservations/:id/activity
 *      (recepción) y en la lista «Tus peticiones» del huésped;
 *   5. recepción cobra en efectivo (POST /folios/:id/payments) y hace el
 *      check-out (POST /reservations/:id/check-out) → al recargar, el portal
 *      pasa a «Estancia terminada» sin saldo, sin bloque de check-in y con la
 *      acción «Cuenta y facturas».
 * En cada pantalla: captura (E2E_SHOTS_DIR) y contrato de tamaño de objetivos
 * (assertTargets: 0 < 24 px; los < 44 px a JSON). Al final: 0 excepciones, 0
 * errores de consola, ninguna respuesta ≥ 400 y ningún token en una URL. Sin
 * skip: sin API, seed o portal la spec FALLA con el motivo.
 */

const DOCUMENT = { number: "PRB000456", nationality: "ESP", dateOfBirth: "1988-03-02", sex: "M" as const, expiryDate: "2032-03-01" };
const MINIBAR = { description: "Minibar (prueba e2e)", unitPrice: 12.5 };
/** Datos del hotel que dirección publica SOLO si prop_chk no los tiene (faq de PropertyAiSetting; mismas claves que el bot). */
const HOTEL_FAQ = { wifiName: "CHK-Huespedes", wifiPassword: "prueba-2026", breakfastHours: "07:30–10:30", checkOutTime: "12:00", receptionPhone: "+34 981 000 000" };

type GuestFixture = { reservation: SyntheticReservation; token: string; guestHeaders: Record<string, string>; room: string; roomId: string; keySerial: string };

async function readJson<T>(response: { ok(): boolean; status(): number; json(): Promise<unknown>; text(): Promise<string> }, label: string): Promise<T> {
  expect(response.ok(), `${label} → ${response.status()} ${(await response.text().catch(() => "")).slice(0, 300)}`).toBeTruthy();
  return (await response.json()) as T;
}

/**
 * Cierra el pre-check-in por las rutas del huésped (mismo orden que el
 * asistente: MRZ → residencia → consentimientos → complete → firma) y hace el
 * check-in desde recepción. Devuelve la habitación y la serie de la llave.
 */
async function provisionInHouse(request: APIRequestContext, session: ChkSession): Promise<GuestFixture> {
  const reservation = await createSyntheticReservation(request, { arrival: isoDay(0), departure: isoDay(2), adults: 1, session });
  const invitation = await invite(request, reservation.id, { session });
  const guestHeaders = { "x-guest-token": invitation.token };
  const checkIn = await readJson<{ guests: Array<{ id: string; isPrimary: boolean }> }>(await request.get(`${E2E_API_URL}/guest-portal/check-in`, { headers: guestHeaders }), "GET /guest-portal/check-in");
  const primary = checkIn.guests.find((guest) => guest.isPrimary) ?? checkIn.guests[0];
  expect(primary, "la sesión tiene al titular").toBeTruthy();
  const guestId = primary!.id;
  const mrz = syntheticMrz({ surname: SYNTHETIC_GUEST.surname1, givenNames: SYNTHETIC_GUEST.firstName, documentNumber: DOCUMENT.number, ...DOCUMENT });
  await readJson(await request.post(`${E2E_API_URL}/guest-portal/check-in/guests/${guestId}/mrz`, { headers: guestHeaders, data: { lines: mrz } }), "POST …/mrz");
  await readJson(await request.patch(`${E2E_API_URL}/guest-portal/check-in/guests/${guestId}`, { headers: guestHeaders, data: { residenceFullAddress: "Rúa de Proba 9", residenceLocality: "A Coruña", residenceCountry: "ESP" } }), "PATCH …/guests/:id");
  await readJson(await request.patch(`${E2E_API_URL}/guest-portal/check-in`, { headers: guestHeaders, data: { consent: { gdpr: true, aiDisclosure: true } } }), "PATCH /guest-portal/check-in (consent)");
  const completed = await readJson<{ status: string }>(await request.post(`${E2E_API_URL}/guest-portal/check-in/complete`, { headers: guestHeaders, data: {} }), "POST …/complete");
  expect(completed.status).toBe("ready_for_arrival");
  const signature = await request.post(`${E2E_API_URL}/guest-portal/check-in/guests/${guestId}/signature`, {
    headers: guestHeaders,
    data: { pngBase64: tinyPng().toString("base64"), strokeMeta: { points: 24, durationMs: 900, bbox: { x: 10, y: 10, w: 200, h: 60 } } }
  });
  expect(signature.status(), `POST …/signature → ${signature.status()} ${(await signature.text().catch(() => "")).slice(0, 200)}`).toBe(201);
  const arrived = await readJson<{ room: { id: string; number: string }; key: { serialNumber: string } | null }>(
    await request.post(`${E2E_API_URL}/reservations/${reservation.id}/check-in/complete`, { headers: session.headers, data: {} }),
    "POST /reservations/:id/check-in/complete"
  );
  expect(arrived.room?.number, "recepción asigna habitación al hacer el check-in").toBeTruthy();
  expect(arrived.key?.serialNumber, "el check-in emite la llave móvil (QR de demo)").toBeTruthy();
  return { reservation, token: invitation.token, guestHeaders, room: arrived.room.number, roomId: arrived.room.id, keySerial: arrived.key!.serialNumber };
}

type FolioView = { folio: { id: string }; balanceDue: number; reservationBalanceDue: number };

/** Carga un consumo en el folio principal (recepción) y devuelve el folio con su saldo. */
async function postMinibar(request: APIRequestContext, session: ChkSession, reservationId: string): Promise<FolioView> {
  const before = await readJson<FolioView>(await request.get(`${E2E_API_URL}/reservations/${reservationId}/folio`, { headers: session.headers }), "GET /reservations/:id/folio");
  await readJson(await request.post(`${E2E_API_URL}/folios/${before.folio.id}/lines`, { headers: session.headers, data: { type: "minibar", description: MINIBAR.description, quantity: 1, unitPrice: MINIBAR.unitPrice } }), "POST /folios/:id/lines");
  const after = await readJson<FolioView>(await request.get(`${E2E_API_URL}/reservations/${reservationId}/folio`, { headers: session.headers }), "GET /reservations/:id/folio");
  expect(after.balanceDue, "el consumo deja saldo real pendiente").toBeCloseTo(before.balanceDue + MINIBAR.unitPrice, 2);
  return after;
}

type StayInfo = { wifiName: string | null; wifiPassword: string | null; breakfastHours: string | null; checkOutTime: string | null; receptionPhone: string | null; address: string | null };

/** Datos del hotel: si prop_chk no publica wifi ni teléfono, dirección (ai.configure) los fija sin pisar el resto de configurationJson. */
async function ensureHotelInfo(request: APIRequestContext, guestHeaders: Record<string, string>): Promise<StayInfo> {
  const read = async () => (await readJson<{ info: StayInfo }>(await request.get(`${E2E_API_URL}/guest-portal/stay`, { headers: guestHeaders }), "GET /guest-portal/stay")).info;
  const current = await read();
  if (current.wifiName && current.receptionPhone) return current;
  const direccion = await loginAsChk(request, "direccion");
  const settings = await readJson<{ settings: { configurationJson: Record<string, unknown> } }>(await request.get(`${E2E_API_URL}/backoffice/properties/${CHK.propertyId}/ai-settings`, { headers: direccion.headers }), "GET ai-settings");
  await readJson(
    await request.patch(`${E2E_API_URL}/backoffice/properties/${CHK.propertyId}/ai-settings`, { headers: direccion.headers, data: { configurationJson: { ...settings.settings.configurationJson, faq: HOTEL_FAQ } } }),
    "PATCH ai-settings (faq)"
  );
  const updated = await read();
  expect(updated.wifiName, "tras publicar la faq el portal la lee").toBeTruthy();
  return updated;
}

/**
 * Limpieza de la fixture para que la spec sea repetible el mismo día: si sigue
 * alojada (spec rota a medias) recepción hace el check-out reconociendo el
 * saldo, y en todo caso dirección (housekeeping.task.manage) deja la habitación
 * usada limpia otra vez (el check-out la marca sucia y agotaría las Dobles
 * listas del tenant tras unas cuantas corridas).
 */
async function releaseFixture(request: APIRequestContext, session: ChkSession, fixture: Pick<GuestFixture, "reservation" | "roomId">): Promise<void> {
  const current = await request.get(`${E2E_API_URL}/reservations/${fixture.reservation.id}`, { headers: session.headers });
  if (current.ok() && ((await current.json()) as { status: string }).status === "checked_in") {
    await request.post(`${E2E_API_URL}/reservations/${fixture.reservation.id}/check-out`, { headers: session.headers, data: { acknowledgeBalance: true } });
  }
  const direccion = await loginAsChk(request, "direccion");
  const cleaned = await request.post(`${E2E_API_URL}/rooms/${fixture.roomId}/mark-clean`, { headers: direccion.headers, data: {} });
  expect(cleaned.ok(), `POST /rooms/:id/mark-clean → ${cleaned.status()} ${(await cleaned.text().catch(() => "")).slice(0, 200)}`).toBeTruthy();
}

/** «12,50 €» como lo pinta el portal (Intl es-ES). */
function euros(amount: number): string {
  return new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(amount);
}

test.use({ viewport: { width: 390, height: 844 } });

test("el huésped alojado ve su estancia, los datos del hotel, su cuenta con pago en recepción, pide la salida tardía y, tras el check-out, ve la estancia terminada", async ({ page, request }, testInfo) => {
  test.setTimeout(150_000);

  // 0 · Fixture por API: reserva alojada con llave, consumo en el folio y datos del hotel.
  const recepcion = await loginAsChk(request, "recepcion");
  const fixture = await provisionInHouse(request, recepcion);
  try {
    const folio = await postMinibar(request, recepcion, fixture.reservation.id);
    const info = await ensureHotelInfo(request, fixture.guestHeaders);
    const watch = watchConsole(page, fixture.token);
    // El token que el portal obtiene al entrar por código + correo tampoco puede viajar en ninguna URL.
    const requestUrls: string[] = [];
    page.on("request", (req) => requestUrls.push(req.url()));
    const back = () => page.getByRole("button", { name: "Volver a mi estancia" }).first();

    // 1 · Entrada por código de reserva + correo → estancia «En el hotel».
    await test.step("sign-in por código y correo → en el hotel", async () => {
      await forceCoarse(page);
      await page.goto(`${E2E_GUEST_BASE_URL}/`, { waitUntil: "domcontentloaded" });
      await page.getByLabel("Código de reserva").fill(fixture.reservation.code);
      await page.getByLabel("Correo electrónico").fill(fixture.reservation.email);
      const signIn = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/guest-portal/sign-in"));
      await page.getByRole("button", { name: "Continuar", exact: true }).click();
      const signedIn = (await (await signIn).json()) as { ok: boolean; token?: string };
      expect(signedIn.ok, "código + correo del titular inventado entran").toBe(true);
      const stay = page.locator(".gp-card.gp-stay");
      await expect(stay).toBeVisible({ timeout: 20_000 });
      expect(page.url(), "sin token en la barra de direcciones").not.toContain("token=");
      await expect(page.getByRole("heading", { name: `Hola, ${SYNTHETIC_GUEST.firstName}` })).toBeVisible();
      await expect(page.locator(".gp-hero-code")).toHaveText(fixture.reservation.code);
      await expect(stay.locator(".gp-pill")).toHaveText("En el hotel");
      await expect(stay).toContainText(`Habitación asignada · ${fixture.room}`);
      await expect(stay).toContainText(euros(folio.balanceDue));
      const checkInBlock = page.locator(".gp-precheckin");
      await expect(checkInBlock).toContainText("Check-in hecho");
      await expect(checkInBlock.locator(".gp-pill")).toHaveText("Llave emitida");
      await expect(page.locator(".gp-folio .gp-pill")).toHaveText(`Pendiente de pago: ${euros(folio.balanceDue)}`);
      // En casa: «Pedir un servicio» manda y «Salida y cuenta» acompaña (stay.ts stayActions).
      await expect(page.locator(".gp-action-primary")).toContainText("Pedir un servicio");
      await expect(page.locator(".gp-actions .gp-action", { hasText: "Salida y cuenta" })).toHaveCount(1);
      await expect(page.getByRole("button", { name: "Pagar ahora", exact: true })).toHaveCount(0);
      await shot(page, "stay-01-en-el-hotel");
      await assertTargets(page, testInfo, "stay-01-en-el-hotel");
    });

    // 2 · Datos del hotel: solo lo publicado por el API.
    await test.step("información del hotel", async () => {
      await page.locator(".gp-actions .gp-action", { hasText: "Información del hotel" }).click();
      await expect(page.getByRole("heading", { name: "Datos útiles del hotel" })).toBeVisible({ timeout: 15_000 });
      const rows = page.locator(".gp-info .gp-info-row");
      const expected: Array<[string, string | null]> = [["Wifi", info.wifiName], ["Contraseña del wifi", info.wifiPassword], ["Desayuno", info.breakfastHours], ["Hora de salida", info.checkOutTime], ["Teléfono de recepción", info.receptionPhone], ["Dirección", info.address]];
      const published = expected.filter(([, value]) => Boolean(value && value.trim()));
      await expect(rows, "una fila por dato publicado, ninguna inventada").toHaveCount(published.length);
      for (const [label, value] of published) {
        // Etiqueta exacta: «Wifi» no debe casar con «Contraseña del wifi».
        const row = rows.filter({ has: page.locator("dt", { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) });
        await expect(row).toHaveCount(1);
        await expect(row.locator("dd")).toHaveText(value!.trim());
      }
      await expect(page.getByText("El hotel todavía no ha publicado esta información.")).toHaveCount(0);
      const call = page.getByRole("link", { name: "Llamar a recepción" });
      await expect(call).toHaveCount(1);
      await expect(call).toHaveAttribute("href", /^tel:\+?\d{6,15}$/);
      await shot(page, "stay-02-informacion");
      await assertTargets(page, testInfo, "stay-02-informacion");
      await back().click();
      await expect(page.locator(".gp-card.gp-stay")).toBeVisible({ timeout: 15_000 });
    });

    // 3 · Cuenta: el cargo real y el pago honesto sin PSP.
    await test.step("cuenta: cargo real y «se cobra en recepción»", async () => {
      await page.locator(".gp-actions .gp-action", { hasText: "Salida y cuenta" }).click();
      await expect(page.getByRole("heading", { name: "Tu cuenta y tu salida" })).toBeVisible({ timeout: 15_000 });
      const folioCard = page.locator(".gp-folio");
      await expect(folioCard.locator(".gp-pill")).toHaveText(`Pendiente de pago: ${euros(folio.balanceDue)}`);
      const line = folioCard.locator(".gp-line", { hasText: MINIBAR.description });
      await expect(line).toHaveCount(1);
      await expect(line.locator(".gp-line-amount")).toHaveText(euros(MINIBAR.unitPrice));
      await expect(folioCard.locator(".gp-folio-balance .gp-value")).toHaveText(euros(folio.balanceDue));
      const payment = page.locator(".gp-payment");
      await expect(payment.locator(".gp-payment-message")).toHaveText(`Pendiente: ${euros(folio.balanceDue)}`);
      await expect(page.getByRole("button", { name: "Pagar ahora", exact: true })).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Pagar ahora", exact: true })).toHaveCount(0);
      await shot(page, "stay-03-cuenta");
      await assertTargets(page, testInfo, "stay-03-cuenta");
      const linkResponse = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/guest-portal/stay/payment-link"));
      await payment.getByRole("button", { name: "Quiero pagar ahora" }).click();
      const link = await linkResponse;
      expect(link.status()).toBe(200);
      const outcome = (await link.json()) as { status: string; reason?: string };
      expect(outcome.status, "sin PSP configurado el saldo se cobra en recepción").toBe("at_reception");
      expect(outcome.reason).toBe("PSP_NOT_CONFIGURED");
      await expect(payment.locator(".gp-payment-message")).toHaveText("El saldo pendiente se cobra en recepción; no tienes que hacer nada más ahora.");
      await expect(page.getByRole("button", { name: "Pagar ahora", exact: true })).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Pagar ahora", exact: true })).toHaveCount(0);
      await expect(payment.getByRole("button", { name: "Quiero pagar ahora" }), "el botón no se vuelve a ofrecer tras la respuesta").toHaveCount(0);
      await shot(page, "stay-04-pago-en-recepcion");
      await assertTargets(page, testInfo, "stay-04-pago-en-recepcion");
    });

    // 4 · Petición de salida tardía → nº SRQ y la misma fila en recepción.
    let ticket: { id: string; ticketNumber: string };
    await test.step("petición «Salida tardía» → SRQ-<8> visible en recepción", async () => {
      await page.locator("label.gp-category", { hasText: "Salida tardía" }).click();
      await expect(page.locator('label.gp-category.is-active input[type="radio"]')).toHaveValue("late_checkout");
      await page.getByLabel(/^Hora preferida/).fill("13:00");
      await page.getByLabel(/^Comentario/).fill("Prueba e2e: salida a las 13:00 si es posible.");
      const created = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/guest-portal/stay/requests"));
      await page.getByRole("button", { name: "Enviar a recepción" }).click();
      const response = await created;
      expect(response.status()).toBe(201);
      ticket = (await response.json()) as { id: string; ticketNumber: string; kind: string; status: string };
      expect(ticket.ticketNumber).toMatch(/^SRQ-[A-Z0-9]{8}$/);
      await expect(page.getByRole("heading", { name: "Petición recibida" })).toBeVisible();
      await expect(page.locator(".gp-confirmation")).toHaveText(ticket.ticketNumber);
      await expect(page.locator(".gp-checkout-requests")).toContainText("Salida tardía");
      await shot(page, "stay-05-peticion-recibida");
      await assertTargets(page, testInfo, "stay-05-peticion-recibida");

      // Recepción la ve en el feed de actividad de la reserva, abierta y del mismo id.
      const activity = await readJson<{ items: Array<{ id: string; kind: string; title: string; status: string; open: boolean; department: string }>; counts: { serviceRequests: number; openTotal: number } }>(
        await request.get(`${E2E_API_URL}/reservations/${fixture.reservation.id}/activity`, { headers: recepcion.headers }),
        "GET /reservations/:id/activity"
      );
      const item = activity.items.find((entry) => entry.kind === "service_request" && entry.id === ticket.id);
      expect(item, `la petición ${ticket.ticketNumber} aparece en la actividad de recepción`).toBeTruthy();
      expect(item!.title).toBe("Salida tardía");
      expect(item!.status).toBe("open");
      expect(item!.open).toBe(true);
      expect(activity.counts.serviceRequests).toBeGreaterThanOrEqual(1);

      // Y el huésped la ve en «Tus peticiones» de su estancia, abierta.
      await back().click();
      const requests = page.locator(".gp-requests");
      await expect(requests).toBeVisible({ timeout: 15_000 });
      const row = requests.locator(".gp-list-item", { hasText: "Salida tardía" });
      await expect(row).toHaveCount(1);
      await expect(row.locator(".gp-pill")).toHaveText("Abierta");
      await shot(page, "stay-06-estancia-con-peticion");
      await assertTargets(page, testInfo, "stay-06-estancia-con-peticion");
    });

    // 5 · Recepción cobra y hace el check-out → estancia terminada.
    await test.step("cobro en recepción + check-out por API → estancia terminada", async () => {
      await readJson(
        await request.post(`${E2E_API_URL}/folios/${folio.folio.id}/payments`, { headers: recepcion.headers, data: { amount: folio.balanceDue, currency: "EUR", method: "cash", clientRequestId: `e2e-stay-${fixture.reservation.code}` } }),
        "POST /folios/:id/payments"
      );
      const checkedOut = await readJson<{ reservation?: { status?: string }; status?: string; warnings?: string[] }>(
        await request.post(`${E2E_API_URL}/reservations/${fixture.reservation.id}/check-out`, { headers: recepcion.headers, data: {} }),
        "POST /reservations/:id/check-out"
      );
      expect(checkedOut.reservation?.status ?? checkedOut.status).toBe("checked_out");
      expect(checkedOut.warnings ?? []).not.toContain("balance_due");

      await page.reload({ waitUntil: "domcontentloaded" });
      const stay = page.locator(".gp-card.gp-stay");
      await expect(stay).toBeVisible({ timeout: 20_000 });
      await expect(stay.locator(".gp-pill")).toHaveText("Estancia terminada");
      await expect(stay).toContainText("Salida hecha");
      await expect(page.locator(".gp-folio .gp-pill")).toHaveText("Sin saldo pendiente.");
      await expect(page.locator(".gp-precheckin"), "tras la salida no hay bloque de check-in").toHaveCount(0);
      await expect(page.locator(".gp-action-primary")).toContainText("Cuenta y facturas");
      await expect(page.locator(".gp-survey")).toContainText("Gracias por tu estancia");
      await expect(page.locator(".gp-requests .gp-list-item", { hasText: "Salida tardía" })).toHaveCount(1);
      await shot(page, "stay-07-estancia-terminada");
      await assertTargets(page, testInfo, "stay-07-estancia-terminada");

      const view = await readJson<{ stage: string; folio: { status: string; balanceDue: number; charges: unknown[]; payments: unknown[] } }>(await request.get(`${E2E_API_URL}/guest-portal/stay`, { headers: fixture.guestHeaders }), "GET /guest-portal/stay");
      expect(view.stage).toBe("post_stay");
      expect(view.folio.status).toBe("settled");
      expect(view.folio.charges.length).toBeGreaterThanOrEqual(1);
      expect(view.folio.payments.length).toBeGreaterThanOrEqual(1);
    });

    const pageToken = await page.evaluate(() => {
      try {
        return (JSON.parse(window.sessionStorage.getItem("hotelos.guest.session") ?? "{}") as { token?: string }).token ?? "";
      } catch {
        return "";
      }
    });
    expect(pageToken, "la sesión del portal vive en sessionStorage con su token").not.toBe("");
    expect(requestUrls.filter((url) => url.includes(pageToken)), "el token del portal viajó en una URL").toEqual([]);
    assertConsoleClean(watch, []);
  } finally {
    // Pase lo que pase, la reserva no se queda con la habitación y la habitación vuelve a estar lista.
    await releaseFixture(request, recepcion, fixture);
  }
});
