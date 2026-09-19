import { expect, test } from "@playwright/test";
import { E2E_API_URL, UXDAY, assertNoLoginGate, loginAsUxDay } from "./_helpers";

/** Acción primaria de una llegada confirmada (U6): «Hacer check-in» o «Check-in en 118» (habitación sugerida). */
const CHECK_IN_ROW = /^(Hacer check-in|Check-in en \d+[A-Za-z]?)$/;

/**
 * Check-in rápido (Tanda UX-1 · lotes U1/U6 · F2, F24, F30): flujo real del
 * drawer con el seed «día de prueba»:
 *   1. Mi día (`/hoy`) con la sesión de recepción del tenant UXDAY.
 *   2. Fila de la llegada sin habitación UXDAY-T1 (identificada por el código
 *      que el seed deja en «Solicitudes» de la fila) → acción primaria
 *      «Check-in en NNN» (la candidata del motor ya preseleccionada, R14).
 *      Si UXDAY-T1 ya se registró (el proyecto «measure» corre antes en
 *      `pnpm e2e`), se usa la segunda llegada sin habitación UXDAY-A2.
 *   3. El drawer abre con esa habitación (limpia y LIBRE: F24 corregido) y el
 *      CTA «Hacer check-in» (sin flecha, T1 no debe nada) habilitado.
 *   4. Confirmar → toast «Check-in de la NNN hecho · parte enviado a SES» o
 *      «Check-in de la NNN hecho» y la fila pasa a «En el hotel»; el cajón se
 *      cierra solo si el parte SES se encoló (el seed lo tiene desactivado:
 *      SES_DISABLED → el cajón se queda abierto con el motivo).
 * Sin llegadas disponibles la spec FALLA (el seed debe rearmarse con --reset).
 */
test("el drawer de check-in registra la llegada UXDAY-T1 sin habitación con la candidata preseleccionada", async ({ page, request }, testInfo) => {
  const session = await loginAsUxDay(page, request);
  await page.goto("/hoy", { waitUntil: "domcontentloaded" });
  await assertNoLoginGate(page, testInfo);

  const arrivals = page.getByRole("table", { name: "Llegadas de hoy" });
  await expect(arrivals).toBeVisible({ timeout: 15_000 });

  // Fila UXDAY-T1 (o UXDAY-A2 si T1 ya está alojada) con la acción primaria de check-in.
  let code = "UXDAY-T1";
  let row = arrivals.getByRole("row").filter({ hasText: code }).first();
  let checkIn = row.getByRole("button", { name: CHECK_IN_ROW });
  if (!(await checkIn.isVisible().catch(() => false))) {
    code = "UXDAY-A2";
    row = arrivals.getByRole("row").filter({ hasText: code }).first();
    checkIn = row.getByRole("button", { name: CHECK_IN_ROW });
  }
  await expect(checkIn, `ninguna llegada sin habitación disponible (${code}); rearma el seed con --reset`).toBeEnabled();
  const primaryLabel = (await checkIn.textContent())?.trim() ?? "";
  expect(primaryLabel, "sin habitación la acción primaria nombra la candidata («Check-in en NNN»)").toMatch(/^Check-in en \d+/);
  const suggestedNumber = /(\d+)/.exec(primaryLabel)![1];
  await checkIn.click();

  // Drawer «Check-in» con el código de la reserva en el subtítulo, la candidata ya seleccionada y el CTA sin flecha.
  const drawer = page.getByRole("dialog").filter({ hasText: code }).first();
  await expect(drawer).toBeVisible({ timeout: 10_000 });
  // El velo lo pinta el CSS real (U4; sin override de e2e, UX1-REV-08 / R8).
  await expect.poll(async () => page.locator('.c22-scrim[data-open="true"]').first().evaluate((node) => getComputedStyle(node).display)).toBe("block");
  const roomSelect = drawer.getByLabel("Cambiar habitación");
  await expect(roomSelect).toBeVisible({ timeout: 10_000 });
  const headers = { Authorization: `Bearer ${session.token}`, "x-property-id": UXDAY.propertyId };
  const rooms = (await (await request.get(`${E2E_API_URL}/properties/${UXDAY.propertyId}/rooms`, { headers })).json()) as Array<{ id: string; number: string; status: string; housekeepingStatus: string }>;
  const selectedId = await roomSelect.inputValue();
  const selectedRoom = rooms.find((room) => room.id === selectedId);
  expect(selectedRoom?.number, "la habitación preseleccionada es la candidata de la fila").toBe(suggestedNumber);
  expect(selectedRoom?.status, "F24: la candidata nunca está ocupada").not.toBe("occupied");
  expect(selectedRoom?.housekeepingStatus).toMatch(/^(clean|inspected)$/);

  const confirm = drawer.getByRole("button", { name: /^Hacer check-in$/ });
  await expect(confirm).toBeEnabled({ timeout: 10_000 });
  await confirm.click();

  await expect(page.locator('[data-cocoa="toast"]').filter({ hasText: new RegExp(`Check-in de la ${suggestedNumber} hecho`) }).first()).toBeVisible({ timeout: 15_000 });
  // Reconciliación optimista (F23): la fila pasa a «En el hotel» sin recargar.
  await expect(row.getByText("En el hotel")).toBeVisible({ timeout: 10_000 });
  const after = (await (await request.get(`${E2E_API_URL}/reservations/${code === "UXDAY-T1" ? "res_uxday_t1" : "res_uxday_a2"}`, { headers })).json()) as { status: string; assignedRoomId: string | null };
  expect(after.status).toBe("checked_in");
  expect(after.assignedRoomId).toBe(selectedId);
});

/**
 * Check-in con cobro (Tanda UX-1 · lotes U0b/U6 · F1/F19, D8): la llegada
 * elegida TIENE saldo (UXDAY-A5: 178 € de estancia, 50 € cobrados → 128 €,
 * habitación 111 asignada y limpia). Ahora:
 *   1. el paso «3 · Pago» muestra el saldo pendiente, el modo por defecto es
 *      «Cobrar saldo» (sin la palabra «Preautorizar») y anuncia el importe;
 *   2. el CTA dice lo que hará: «Cobrar 128,00 € y hacer check-in» (U6);
 *   3. Intro desde el campo del método también confirma (el cuerpo es un <form>);
 *   4. por API (token de la sesión): un pago nuevo `captured` por el saldo,
 *      saldo 0 y reserva `checked_in`.
 * Si UXDAY-A5 ya no está confirmada la spec FALLA (rearma el seed con --reset).
 */
test("el drawer de check-in cobra el saldo de UXDAY-A5 (saldo > 0) con Intro y registra la llegada", async ({ page, request }, testInfo) => {
  const session = await loginAsUxDay(page, request);
  const headers = { Authorization: `Bearer ${session.token}`, "x-property-id": UXDAY.propertyId };
  const code = "UXDAY-A5";

  // La fila elegida debe tener saldo > 0 (comprobado por API antes de tocar la UI).
  const confirmed = (await (await request.get(`${E2E_API_URL}/properties/${UXDAY.propertyId}/reservations?status=confirmed`, { headers })).json()) as Array<{ id: string; code: string; status: string }>;
  const reservation = confirmed.find((row) => row.code === code);
  expect(reservation, `${code} no está confirmada; rearma el seed con --reset`).toBeTruthy();
  type Folio = { folio: { id: string }; balanceDue: number; payments: Array<{ id: string; amount: number; status: string; methodCode?: string | null }> };
  const folioBefore = (await (await request.get(`${E2E_API_URL}/reservations/${reservation!.id}/folio`, { headers })).json()) as Folio;
  expect(folioBefore.balanceDue, `${code} debe tener saldo pendiente > 0`).toBeGreaterThan(0);
  const balanceText = folioBefore.balanceDue.toFixed(2).replace(".", ",");

  await page.goto("/hoy", { waitUntil: "domcontentloaded" });
  await assertNoLoginGate(page, testInfo);
  const arrivals = page.getByRole("table", { name: "Llegadas de hoy" });
  await expect(arrivals).toBeVisible({ timeout: 15_000 });
  const row = arrivals.getByRole("row").filter({ hasText: code }).first();
  const checkIn = row.getByRole("button", { name: /^Hacer check-in$/ });
  await expect(checkIn, `${code} sin botón de check-in habilitado`).toBeEnabled();
  await checkIn.click();

  const drawer = page.getByRole("dialog").filter({ hasText: code }).first();
  await expect(drawer).toBeVisible({ timeout: 10_000 });
  // Paso 3 · Pago: saldo real del folio, modo «Cobrar saldo» por defecto e importe anunciado (D8: nada de «Preautorizar»).
  await expect(drawer.getByText(new RegExp(`${balanceText}\\s*€\\s*pendiente`))).toBeVisible({ timeout: 10_000 });
  const modeControl = drawer.getByRole("tablist", { name: "Modo de cobro" });
  await expect(modeControl.getByRole("tab", { name: "Cobrar saldo" })).toHaveAttribute("aria-selected", "true");
  await expect(modeControl.getByRole("tab", { name: "Cobrar depósito" })).toBeDisabled();
  await expect(modeControl.getByRole("tab", { name: "Sin cobro" })).toBeVisible();
  await expect(drawer.getByText(/Preautorizar/i)).toHaveCount(0);
  await expect(drawer.getByText(new RegExp(`Se cobrarán\\s+${balanceText}\\s*€\\s+al confirmar`))).toBeVisible();

  // CTA descriptivo (U6) y confirmación con Intro desde el campo del método (F6: <form>).
  const confirm = drawer.getByRole("button", { name: new RegExp(`^Cobrar ${balanceText} € y hacer check-in$`) });
  await expect(confirm).toBeEnabled({ timeout: 10_000 });
  const method = drawer.getByLabel("Método");
  await expect(method).toBeFocused({ timeout: 5_000 });
  await method.press("Enter");
  await expect(page.locator('[data-cocoa="toast"]').filter({ hasText: /Check-in de la 111 hecho/ }).first()).toBeVisible({ timeout: 15_000 });

  // Por API: el cobro quedó `captured` por el saldo, el folio a 0 y la reserva alojada.
  const folioAfter = (await (await request.get(`${E2E_API_URL}/reservations/${reservation!.id}/folio`, { headers })).json()) as Folio;
  const newPayments = folioAfter.payments.filter((payment) => !folioBefore.payments.some((previous) => previous.id === payment.id));
  expect(newPayments, "debe haber exactamente un cobro nuevo").toHaveLength(1);
  expect(newPayments[0].status).toBe("captured");
  expect(newPayments[0].amount).toBe(folioBefore.balanceDue);
  expect(newPayments[0].methodCode).toBe("card_terminal");
  expect(folioAfter.balanceDue).toBe(0);
  const after = (await (await request.get(`${E2E_API_URL}/reservations/${reservation!.id}`, { headers })).json()) as { status: string; assignedRoomId: string | null };
  expect(after.status).toBe("checked_in");
  expect(after.assignedRoomId).toBeTruthy();
});

/**
 * Solo teclado por el camino diseñado (§5.1 inspector, P2, §8.3 «≥ 1 tarea solo
 * con teclado»; corrector L-01): Intro en la fila abre el inspector, Tab llega a
 * «Hacer check-in» del detalle, Intro abre el cajón y el foco ENTRA en él aunque
 * el CTA nazca deshabilitado; Intro confirma. Se registra la segunda llegada sin
 * habitación (UXDAY-A2) o, si ya está alojada, la llegada con habitación UXDAY-A3.
 */
test("solo teclado: inspector → Intro → cajón con el foco dentro → Intro registra la llegada (L-01)", async ({ page, request }, testInfo) => {
  const session = await loginAsUxDay(page, request);
  const headers = { Authorization: `Bearer ${session.token}`, "x-property-id": UXDAY.propertyId };
  await page.goto("/hoy", { waitUntil: "domcontentloaded" });
  await assertNoLoginGate(page, testInfo);
  const arrivals = page.getByRole("table", { name: "Llegadas de hoy" });
  await expect(arrivals).toBeVisible({ timeout: 15_000 });

  const confirmed = (await (await request.get(`${E2E_API_URL}/properties/${UXDAY.propertyId}/reservations?status=confirmed&arrivalFrom=${new Date().toISOString().slice(0, 10)}&arrivalTo=${new Date().toISOString().slice(0, 10)}`, { headers })).json()) as Array<{ id: string; code: string }>;
  const target = confirmed.find((row) => row.code === "UXDAY-A2") ?? confirmed.find((row) => row.code === "UXDAY-A3") ?? confirmed[0];
  expect(target, "ninguna llegada confirmada de hoy; rearma el seed con --reset").toBeTruthy();
  const row = arrivals.getByRole("row").filter({ hasText: target!.code }).first();
  await expect(row).toBeVisible({ timeout: 10_000 });

  // Intro en la fila → inspector (no modal) con la primaria del detalle.
  await row.focus();
  await page.keyboard.press("Enter");
  const inspector = page.locator('[data-cocoa="inspector"]').first();
  await expect(inspector).toBeVisible({ timeout: 10_000 });
  const primary = inspector.getByRole("button", { name: /^(Hacer check-in|Check-in en \d+[A-Za-z]?)$/ });
  await expect(primary).toBeEnabled({ timeout: 10_000 });
  await primary.focus();
  await page.keyboard.press("Enter");

  // El cajón abre y el foco entra en él (antes se quedaba en la fila y Tab recorría la tabla por detrás del velo).
  const drawer = page.getByRole("dialog").filter({ hasText: target!.code }).first();
  await expect(drawer).toBeVisible({ timeout: 10_000 });
  const confirm = drawer.getByRole("button", { name: /^(Hacer check-in|Cobrar .* y hacer check-in)$/ });
  await expect(confirm).toBeEnabled({ timeout: 10_000 });
  await expect.poll(async () => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))), { timeout: 5_000 }).toBe(true);
  // Tab nunca sale del cajón mientras está abierto.
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);
  await confirm.focus();
  await page.keyboard.press("Enter");

  await expect(page.locator('[data-cocoa="toast"]').filter({ hasText: /Check-in de la \S+ hecho/ }).first()).toBeVisible({ timeout: 15_000 });
  const after = (await (await request.get(`${E2E_API_URL}/reservations/${target!.id}`, { headers })).json()) as { status: string };
  expect(after.status).toBe("checked_in");
});
