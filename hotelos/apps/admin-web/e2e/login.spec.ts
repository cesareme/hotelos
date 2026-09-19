import { expect, test } from "@playwright/test";
import { loginAsUxDay } from "./_helpers";

/**
 * Login (Tanda UX-1 · lote U1): dos superficies válidas del arranque, ambas
 * comprobadas de forma explícita (sin tolerancia «una de las dos»):
 *
 *  (a) sin sesión en localStorage → LoginScreen con el eyebrow
 *      «ehotelOS · Back Office» y el botón «Iniciar sesión»;
 *  (b) con el dev-bypass (loginAsUxDay: sesión real del tenant UXDAY escrita
 *      antes de cargar) → la app aterriza en Mi día con el saludo.
 */
test("sin sesión renderiza la LoginScreen", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByText(/ehotelOS · Back Office/).first()).toBeVisible({ timeout: 10_000 });
  // El botón queda deshabilitado hasta rellenar correo y contraseña
  // (LoginScreen.tsx `disabled={!email.trim() || !password}`): solo se comprueba que existe.
  await expect(page.getByRole("button", { name: /Iniciar sesión/i })).toBeVisible();
});

test("con el dev-bypass aterriza autenticado en Mi día", async ({ page, request }) => {
  await loginAsUxDay(page, request);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByText(/Buenos días|Buenas tardes|Buenas noches/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: /Iniciar sesión/i })).toHaveCount(0);
});
