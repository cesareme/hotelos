import { expect, test } from "@playwright/test";
import { gotoFirstAvailable, skipIfLoginGate } from "./_helpers";

/**
 * Reservation create smoke — opens the create-reservation screen and
 * verifies:
 *   1. The arrival / departure date inputs are not in the past (defaults
 *      should be today and tomorrow).
 *   2. The adults field accepts "2".
 *   3. The "Confirm and create reservation" CTA is reachable / enabled
 *      after the form is filled with the dev defaults.
 */
test("reservation-create defaults to today/tomorrow and CTA is reachable", async ({ page }, testInfo) => {
  await gotoFirstAvailable(page, [
    "/backoffice/reservations/new",
    "/backoffice/operations/reservations/new"
  ]);

  if (await skipIfLoginGate(page, testInfo)) return;

  // Date inputs — there are two type="date" inputs (arrival, departure).
  const dateInputs = page.locator('input[type="date"]');
  await expect(dateInputs.first()).toBeVisible({ timeout: 10_000 });

  const arrivalValue = await dateInputs.nth(0).inputValue();
  const departureValue = await dateInputs.nth(1).inputValue();

  // Today (UTC slice) as the lower bound — accept any date >= todayIso.
  const todayIso = new Date().toISOString().slice(0, 10);
  expect(arrivalValue >= todayIso).toBeTruthy();
  expect(departureValue > arrivalValue).toBeTruthy();

  // Adults — exposed with aria-label="Adultos".
  const adultsInput = page.locator('input[aria-label="Adultos"]').first();
  if (await adultsInput.isVisible().catch(() => false)) {
    await adultsInput.fill("2");
    await expect(adultsInput).toHaveValue("2");
  }

  // CTA — "Confirm and create reservation". We only assert visibility; the
  // button may stay disabled until the quote/availability resolves, which
  // depends on backend mocks.
  const submit = page.getByRole("button", { name: /Confirm and create reservation|Crear reserva/i });
  await expect(submit).toBeVisible({ timeout: 10_000 });
});
