import { expect, test } from "@playwright/test";
import { E2E_API_URL, UXDAY, assertNoLoginGate, loginAsUxDay } from "../_helpers";
import { createMeasure, waitForMiDia } from "./_measure";

/**
 * T6 · «Un huésped alojado, apellido Zeta, ha consumido 12 € del minibar.
 * Añádeselo a la cuenta.» (§8.2 · éxito: línea en el folio; objetivo ≤ 6,
 * óptimo UX-1: 4 = ⌘K + Enter + importe + Enter).
 *
 * Camino UX-1 (U7), solo teclado: ⌘K → «Zeta» → Intro (ficha UXDAY-T6) → ⌘K →
 * «cargo» → Intro (comando de página «Añadir cargo»: pestaña Folio y foco en
 * el importe) → 12 → Intro (<form>). 0 clics. El cargo es optimista con
 * «Deshacer» 8 s: la escritura llega al API al agotarse la ventana, y la
 * medida espera ese POST antes de cerrar (el tiempo incluye los 8 s).
 */
test("t6 · buscar por apellido y añadir un cargo de 12 €", async ({ page, request }, testInfo) => {
  const session = await loginAsUxDay(page, request);
  const measure = createMeasure(page, "t6");
  await page.goto("/hoy", { waitUntil: "domcontentloaded" });
  await assertNoLoginGate(page, testInfo);
  await waitForMiDia(page);
  measure.step("Mi día cargado");

  await measure.start(page);
  await measure.countedPress(page, "ControlOrMeta+k", "⌘K");
  const palette = page.getByRole("dialog", { name: "Buscar en la aplicación" });
  await expect(palette).toBeVisible({ timeout: 10_000 });
  await measure.countedFill(palette.getByRole("searchbox").first(), "Zeta", "Búsqueda (apellido)");
  await expect(palette.getByRole("option").filter({ hasText: "UXDAY-T6" }).first()).toBeVisible({ timeout: 10_000 });
  await measure.countedPress(page, "Enter", "Enter (primer resultado)");
  await expect(page).toHaveURL(/\/recepcion\/reservas\/res_uxday_t6/, { timeout: 15_000 });
  await expect(page.getByRole("group", { name: "Acciones de la reserva" })).toBeVisible({ timeout: 15_000 });
  await measure.mark(page, "ficha-open");

  await measure.countedPress(page, "ControlOrMeta+k", "⌘K (comandos de la ficha)");
  await expect(palette).toBeVisible({ timeout: 10_000 });
  await measure.countedFill(palette.getByRole("searchbox").first(), "cargo", "Comando «Añadir cargo»");
  await expect(palette.getByRole("option").filter({ hasText: /^Añadir cargo en UXDAY-T6/ }).first()).toBeVisible({ timeout: 10_000 });
  await measure.countedPress(page, "Enter", "Enter (Añadir cargo)");
  const amount = page.getByLabel("Importe (€)");
  await expect(amount).toBeFocused({ timeout: 10_000 });
  await measure.countedFill(amount, "12", "Importe (€)");
  const posted = page.waitForResponse((response) => response.request().method() === "POST" && /\/folios\/[^/]+\/lines$/.test(response.url()), { timeout: 20_000 });
  await measure.countedPress(page, "Enter", "Intro (Añadir cargo)");
  // Toast anunciado por la región viva del shell (sin role=status, R5): se localiza por data-cocoa.
  await expect(page.locator('[data-cocoa="toast"]').filter({ hasText: /Cargo de 12,00\s€ añadido/ }).first()).toBeVisible({ timeout: 15_000 });
  expect((await posted).ok(), "POST /folios/:id/lines").toBeTruthy();

  const result = await measure.finish(page, {
    completed: true,
    context: { reservationCode: "UXDAY-T6", amountEur: 12, keyboardOnly: true },
    note: "solo teclado (⌘K → Zeta → Intro → ⌘K → cargo → Intro → 12 → Intro); el tiempo incluye la ventana de deshacer de 8 s antes del POST"
  });

  const headers = { Authorization: `Bearer ${session.token}`, "x-property-id": UXDAY.propertyId };
  const folio = (await (await request.get(`${E2E_API_URL}/reservations/res_uxday_t6/folio`, { headers })).json()) as {
    lines?: Array<{ total: number | string; unitPrice?: number | string }>;
    balanceDue: number;
  };
  const lines = folio.lines ?? [];
  expect(lines.some((line) => Math.round(Number(line.total) * 100) === 1_200)).toBeTruthy();
  expect(Math.round(folio.balanceDue * 100)).toBeGreaterThanOrEqual(1_200);
  expect(result.clicks).toBe(0);
  expect(result.keys).toBeGreaterThan(0);
});
