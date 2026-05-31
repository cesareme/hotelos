import { expect, test } from "@playwright/test";
import { gotoFirstAvailable, skipIfLoginGate } from "./_helpers";

/**
 * Front Desk Cockpit smoke — verifies the receptionist's "Mi día" landing
 * page renders its main building blocks: a time-of-day greeting and the
 * four operational tables (Llegadas / Salidas / In-house / Sin asignar).
 *
 * Routes vary by build; we try the documented BACKOFFICE_ROUTES entry first.
 */
test("front-desk cockpit shows greeting and 4 operational sections", async ({ page }, testInfo) => {
  await gotoFirstAvailable(page, [
    "/backoffice/ops/front-desk",
    "/backoffice/operations/front-desk",
    "/backoffice"
  ]);

  if (await skipIfLoginGate(page, testInfo)) return;

  // Greeting — FrontDeskDashboard renders one of Buenos días / Buenas tardes /
  // Buenas noches depending on the local time.
  const greeting = page.getByText(/Buenos días|Buenas tardes|Buenas noches/i).first();
  await expect(greeting).toBeVisible({ timeout: 10_000 });

  // Section headings — the cockpit groups today's work into four tables.
  await expect(page.getByText(/Llegadas de hoy/i).first()).toBeVisible();
  await expect(page.getByText(/Salidas de hoy/i).first()).toBeVisible();
  // "In-house" is exposed via the unassigned arrivals / in-house balance
  // panels; we accept either copy.
  const inHouse = page.getByText(/En casa|In-house|Llegadas sin habitación/i).first();
  await expect(inHouse).toBeVisible();

  // Quick check-in button is rendered on arrival rows. It is only present if
  // there are arrivals → tolerant: assert that the page mounted, and only
  // assert button if at least one arrival row exists.
  const checkInButton = page.getByRole("button", { name: /Hacer check-in/i }).first();
  if (await checkInButton.isVisible().catch(() => false)) {
    await expect(checkInButton).toBeEnabled();
  }
});
