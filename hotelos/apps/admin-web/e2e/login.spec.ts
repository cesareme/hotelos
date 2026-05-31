import { expect, test } from "@playwright/test";

/**
 * Login flow — verifies that the app boot path renders one of two valid
 * surfaces:
 *
 *  (a) LoginScreen (no session in localStorage) → heading "HotelOS" and
 *      a submit button "Iniciar sesión" are visible.
 *  (b) Authenticated dashboard (dev-bypass active) → BackOffice layout has
 *      mounted (we look for a generic "Buenos días" / "Buenas tardes" /
 *      "Buenas noches" greeting on FrontDesk, or any heading that signals
 *      we are past the auth gate).
 */
test("renders login screen or authenticated dashboard at /", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });

  const loginHeading = page.getByRole("heading", { name: /HotelOS/i }).first();
  const loginButton = page.getByRole("button", { name: /Iniciar sesión/i });
  const greeting = page.getByText(/Buenos días|Buenas tardes|Buenas noches/i).first();

  const loginVisible = await loginButton.isVisible().catch(() => false);
  const greetingVisible = await greeting.isVisible().catch(() => false);

  // One of the two surfaces must be present. If neither is, the screenshot
  // and trace from Playwright will be diagnostic.
  expect(loginVisible || greetingVisible).toBeTruthy();

  if (loginVisible) {
    await expect(loginHeading).toBeVisible();
    await expect(loginButton).toBeEnabled();
  } else {
    await expect(greeting).toBeVisible();
  }
});
