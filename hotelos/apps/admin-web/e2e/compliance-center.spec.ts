import { expect, test } from "@playwright/test";
import { assertNoLoginGate, loginAsUxDay, UXDAY } from "./_helpers";

/**
 * Centro de cumplimiento (Tanda UX-1 · lote U1 · F30): `/cumplimiento/centro`
 * (nav-tree.generated.json · ComplianceCenter, perfiles finanzas / dirección /
 * admin / activos / auditoría) con la sesión de DIRECCIÓN del tenant UXDAY
 * (recepción no tiene acceso a esta pantalla): renderiza el título, la
 * pestaña «Matriz» seleccionada y la tabla «Cumplimiento por área».
 */
test("el centro de cumplimiento renderiza el título y la superficie de estado", async ({ page, request }, testInfo) => {
  await loginAsUxDay(page, request, { email: UXDAY.users.direccion });
  await page.goto("/cumplimiento/centro", { waitUntil: "domcontentloaded" });
  await assertNoLoginGate(page, testInfo);

  await expect(page.getByRole("heading", { name: /Centro de cumplimiento/i, level: 1 })).toBeVisible({ timeout: 15_000 });
  // Pestaña «Matriz» por defecto y la tabla por área (el tenant de prueba nace
  // con 0 controles: las etiquetas Cumple / Pendiente / Vencido son cabeceras).
  await expect(page.getByRole("tab", { name: "Matriz" })).toHaveAttribute("aria-selected", "true");
  const matrix = page.getByRole("table", { name: "Cumplimiento por área" });
  await expect(matrix).toBeVisible({ timeout: 15_000 });
  await expect(matrix.getByRole("columnheader", { name: /Cumplidos|Pendientes|Vencidos/ }).first()).toBeVisible();
});
