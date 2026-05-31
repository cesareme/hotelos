import { expect, test } from "@playwright/test";
import { gotoFirstAvailable, skipIfLoginGate } from "./_helpers";

/**
 * Compliance Center smoke — verifies that the centralized compliance
 * dashboard renders its title and at least the matrix tab / control
 * surface that aggregates VeriFactu and SES Hospedajes signals.
 */
test("compliance center renders title and matrix/status surface", async ({ page }, testInfo) => {
  await gotoFirstAvailable(page, [
    "/backoffice/compliance/center",
    "/backoffice/compliance"
  ]);

  if (await skipIfLoginGate(page, testInfo)) return;

  // Title — the screen renders an h2 with "Centro de cumplimiento".
  const title = page.getByText(/Centro de cumplimiento|Centro de Cumplimiento/i).first();
  await expect(title).toBeVisible({ timeout: 10_000 });

  // The matrix tab is the default tab — surface any of the localized
  // status labels (Cumple / Pendiente / Vencido) to confirm the data
  // pipeline has hydrated. Tolerant: also accept "Riesgo" / "Cumplimiento"
  // generic terms.
  const statusBadge = page
    .getByText(/Cumple|Pendiente|Vencido|Vence pronto|En revisión|Riesgo/i)
    .first();
  await expect(statusBadge).toBeVisible({ timeout: 10_000 });

  // TODO(e2e-verifactu-ses-tiles): once the compliance center exposes
  // dedicated VeriFactu and SES Hospedajes status tiles with stable test
  // labels, assert against them explicitly here.
});
