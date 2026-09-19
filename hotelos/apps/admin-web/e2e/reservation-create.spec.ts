import { expect, test } from "@playwright/test";
import { E2E_API_URL, UXDAY, assertNoLoginGate, loginAsUxDay } from "./_helpers";

/**
 * Nueva reserva (Tanda UX-1 · lote U9a · docs/design/UX-RECEPCION-FEEL.md
 * §5.10, F12, F33; U1 · F30): `/recepcion/reservas/nueva` con la sesión UXDAY.
 *   1. Modo rápido (por defecto): fechas hoy → mañana por defecto (se cambian a
 *      +14/+15 para no depender del inventario de hoy), el tipo Doble muestra su
 *      precio en vivo («Doble · 89,00 €/noche · N libres»), nombre + apellido e
 *      Intro en el apellido crean la reserva (POST /properties/:id/reservations)
 *      y abren su ficha con «Total de la reserva» ≠ 0 (precio desde la tarifa
 *      publicada, sin cotización manual).
 *   2. Modo completo (`?modo=completa`): conserva los seis pasos con «Siguiente»
 *      y el CTA «Confirmar y crear reserva» en el último (no se crea nada aquí).
 * La reserva RES-* que crea la prueba 1 no lleva factura: `seed-ux-day --reset`
 * la borra en el siguiente rearmado.
 */
test("nueva reserva rápida: tipo con precio en vivo + nombre y apellido + Intro → ficha con precio", async ({ page, request }, testInfo) => {
  const session = await loginAsUxDay(page, request);
  await page.goto("/recepcion/reservas/nueva", { waitUntil: "domcontentloaded" });
  await assertNoLoginGate(page, testInfo);

  const form = page.getByRole("form", { name: "Nueva reserva rápida" });
  await expect(form).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("tab", { name: "Rápida" }), "modo rápido por defecto").toHaveAttribute("aria-selected", "true");

  // Fechas por defecto: hoy → mañana (Europe/Madrid).
  const dateInputs = form.locator('input[type="date"]');
  const arrivalValue = await dateInputs.nth(0).inputValue();
  const departureValue = await dateInputs.nth(1).inputValue();
  const todayIso = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  expect(arrivalValue).toBe(todayIso);
  expect(departureValue > arrivalValue).toBeTruthy();

  // Estancia dentro de dos semanas: el tenant UXDAY llena el hotel HOY con el seed
  // y las RES-* de otras pruebas (409 «No hay disponibilidad»); la prueba mide el
  // camino, no el inventario del día. Cambiar las fechas recotiza en vivo (300 ms).
  const iso = (offsetDays: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + offsetDays * 86_400_000));
  await dateInputs.nth(0).fill(iso(14));
  await dateInputs.nth(1).fill(iso(15));

  // Precio en vivo en el selector de tipo (POST availability/quote con 300 ms de espera, sin botón).
  const typeSelect = form.locator("#rc-field-roomtype");
  await expect.poll(async () => (await typeSelect.locator("option").allTextContents()).some((text) => /Doble · \d+,\d\d\s€\/noche · [1-9]\d* libres?/.test(text)), { timeout: 10_000 }).toBe(true);
  if (!/Doble/.test((await typeSelect.locator("option:checked").textContent()) ?? "")) await typeSelect.selectOption("rt_uxday_dbl");
  await expect(form.getByText(/^Total/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /^Consultar disponibilidad/ })).toHaveCount(0);

  // Huésped ficticio; Intro en el apellido envía el <form>.
  await form.locator("#rc-field-firstname").fill("Prueba");
  const surname = form.locator("#rc-field-surname1");
  await surname.fill("Rapida");
  const created = page.waitForResponse((response) => response.request().method() === "POST" && /\/properties\/[^/]+\/reservations$/.test(response.url()), { timeout: 20_000 });
  await surname.press("Enter");
  const createdResponse = await created;
  expect(createdResponse.ok(), `POST reservations → ${createdResponse.status()}`).toBeTruthy();
  const reservation = (await createdResponse.json()) as { id: string; code: string; totalAmount: number | string; bookingSource?: string };
  expect(Number(reservation.totalAmount), "precio desde la tarifa publicada (89 €/noche)").toBeGreaterThan(0);

  // Ficha abierta con el precio.
  await expect(page).toHaveURL(new RegExp(`/recepcion/reservas/${reservation.id}`), { timeout: 15_000 });
  await expect(page.getByRole("group", { name: "Acciones de la reserva" })).toBeVisible({ timeout: 15_000 });
  const total = page.getByText("Total de la reserva").locator("..");
  await expect(total).toBeVisible();
  await expect(total).not.toContainText("0,00 €");

  // Éxito verificable en datos: reserva confirmada con el titular y sin correo inventado.
  const headers = { Authorization: `Bearer ${session.token}`, "x-property-id": UXDAY.propertyId };
  const detail = (await (await request.get(`${E2E_API_URL}/reservations/${reservation.id}`, { headers })).json()) as { status: string; totalAmount: number | string; primaryGuestId?: string };
  expect(detail.status).toBe("confirmed");
  expect(Number(detail.totalAmount)).toBe(Number(reservation.totalAmount));
  expect(detail.primaryGuestId).toBeTruthy();
});

test("nueva reserva completa (?modo=completa): seis pasos y CTA «Confirmar y crear reserva» en el último", async ({ page, request }, testInfo) => {
  await loginAsUxDay(page, request);
  await page.goto("/recepcion/reservas/nueva?modo=completa", { waitUntil: "domcontentloaded" });
  await assertNoLoginGate(page, testInfo);

  await expect(page.getByRole("tab", { name: "Completa" })).toHaveAttribute("aria-selected", "true", { timeout: 15_000 });
  await expect(page.getByText(/Paso 1 de 6/).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: /^Consultar disponibilidad/ })).toBeVisible();
  const adults = page.getByLabel("Adultos").first();
  await adults.fill("2");
  await expect(adults).toHaveValue("2");

  const next = page.getByRole("button", { name: /^Siguiente/ });
  for (let step = 1; step < 6; step += 1) {
    await next.click();
    await expect(page.getByText(new RegExp(`Paso ${step + 1} de 6`)).first()).toBeVisible();
  }
  await expect(page.getByRole("button", { name: /^Confirmar y crear reserva$/ })).toBeVisible({ timeout: 10_000 });

  // El conmutador vuelve al modo rápido sin cambiar de ruta (solo ?modo=).
  await page.getByRole("tab", { name: "Rápida" }).click();
  await expect(page.getByRole("form", { name: "Nueva reserva rápida" })).toBeVisible();
  await expect(page).toHaveURL(/\/recepcion\/reservas\/nueva(\?.*)?$/);
  expect(new URL(page.url()).searchParams.get("modo")).toBeNull();
});
