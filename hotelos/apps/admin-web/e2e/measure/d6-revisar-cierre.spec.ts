import { expect, test } from "@playwright/test";
import { E2E_API_URL, assertNoLoginGate } from "../_helpers";
import { loginAsDirector, waitForDireccion } from "../_helpers-direccion";
import { createMeasure, navItem, toastContaining } from "./_measure-direccion";

/**
 * D6 · «Revisa el cierre de anoche (auditoría de ingresos).»
 * Camino DESPUÉS de UX-2 (lote D8; corrector UX2-REV-06: spec oficial actualizada al camino nuevo): menú «Cierre del día» → callout del último cierre
 * pendiente de revisión con la primaria «Marcar como revisado» (encima del historial;
 * la del cajón queda para cierres antiguos) → diálogo «Marcar el cierre como revisado»
 * → «Marcar como revisado» → POST …/runs/:id/review → toast «Cierre del DD/MM/AAAA
 * marcado como revisado». Objetivo ≤ 3 clics, ≤ 14 peticiones. Éxito verificable:
 * GET …/night-audit/runs/:id con reviewedByUserId del director.
 */
test("d6 · revisar el cierre del día", async ({ page, request }, testInfo) => {
  const session = await loginAsDirector(page, request);
  const measure = createMeasure(page, "d6");
  await page.goto("/hoy/direccion", { waitUntil: "domcontentloaded" });
  await assertNoLoginGate(page, testInfo);
  await waitForDireccion(page);
  measure.step("Mi día de dirección cargado");

  await measure.start(page);
  await measure.countedClick(navItem(page, "NightAuditScreen"), "Cierre del día (menú)");
  await expect(page).toHaveURL(/\/hoy\/cierre-del-dia/, { timeout: 15_000 });
  const table = page.getByRole("table", { name: "Historial de cierres" });
  const empty = page.getByText("Todavía no se ha ejecutado ningún cierre del día");
  await expect(table.or(empty).first()).toBeVisible({ timeout: 20_000 });
  const review = page.getByRole("button", { name: "Marcar como revisado" }).first();
  if (!(await review.isVisible({ timeout: 10_000 }).catch(() => false))) {
    await measure.finish(page, { completed: false, note: "sin callout «Marcar como revisado»: no hay cierre pendiente de revisión (rearma el seed D1 con --reset) o falta night_audit.review" });
    return;
  }

  await measure.countedClick(review, "Marcar como revisado (primaria del último cierre pendiente)");
  const dialog = page.getByRole("dialog", { name: "Marcar el cierre como revisado" });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await measure.mark(page, "dialog-open");
  const posted = page.waitForResponse((response) => response.request().method() === "POST" && /\/night-audit\/runs\/[^/]+\/review$/.test(response.url()), { timeout: 20_000 });
  await measure.countedClick(dialog.getByRole("button", { name: "Marcar como revisado" }), "Marcar como revisado (diálogo)");
  const response = await posted;
  const runId = decodeURIComponent(new URL(response.url()).pathname.split("/").at(-2) ?? "");
  const completed = response.ok();
  if (completed) await expect(toastContaining(page, /marcado como revisado/)).toBeVisible({ timeout: 15_000 });

  const result = await measure.finish(page, {
    completed,
    context: { runId, status: response.status() },
    note: completed ? "camino UX-2 (D8): menú → primaria del callout → diálogo nominal" : `POST …/night-audit/runs/:id/review → ${response.status()} (409 = quien ejecutó el cierre no puede revisarlo)`
  });

  if (completed) {
    const detail = await request.get(`${E2E_API_URL}/properties/${session.propertyId}/night-audit/runs/${runId}`, { headers: session.headers });
    expect(detail.ok(), `GET …/night-audit/runs/:id → ${detail.status()}`).toBeTruthy();
    const run = (await detail.json()) as { reviewedByUserId: string | null; reviewedAt?: string | null };
    expect(run.reviewedByUserId).toBeTruthy();
    const userId = typeof session.user.userId === "string" ? session.user.userId : null;
    if (userId) expect(run.reviewedByUserId).toBe(userId);
    expect(result.clicks).toBe(3);
  }
});
