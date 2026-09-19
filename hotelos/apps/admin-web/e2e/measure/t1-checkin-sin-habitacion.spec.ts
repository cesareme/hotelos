import { expect, test } from "@playwright/test";
import { E2E_API_URL, assertNoLoginGate, loginAsUxDay } from "../_helpers";
import { createMeasure, toastContaining, waitForMiDia } from "./_measure";

/**
 * T1 · «Acaba de llegar el huésped de la reserva UXDAY-T1 sin habitación
 * asignada. Dale habitación y haz el check-in.» (§8.2 · éxito: GuestCheckedIn
 * con roomId; objetivo ≤ 4 clics, óptimo UX-1: 2).
 *
 * Camino U6 (§5.1 (2), §5.2): la fila de Mi día lleva «Check-in en NNN» con
 * la candidata del motor ya preseleccionada (limpia y LIBRE, F24) → el cajón
 * abre en una ronda desde la caché (la fila hizo prefetch al pasar el ratón)
 * → «Hacer check-in» = 2 clics. Si UXDAY-T1 ya está alojada (la spec de humo
 * corrió antes), se mide con UXDAY-A2 (misma situación) y se anota el código.
 */
test("t1 · check-in de una llegada sin habitación", async ({ page, request }, testInfo) => {
  const session = await loginAsUxDay(page, request);
  const measure = createMeasure(page, "t1");
  await page.goto("/hoy", { waitUntil: "domcontentloaded" });
  await assertNoLoginGate(page, testInfo);
  await waitForMiDia(page);
  measure.step("Mi día cargado");

  const arrivals = page.getByRole("table", { name: "Llegadas de hoy" });
  await expect(arrivals).toBeVisible();
  const primary = /^(Hacer check-in|Check-in en \d+[A-Za-z]?)$/;
  const candidates = [
    { code: "UXDAY-T1", id: "res_uxday_t1" },
    { code: "UXDAY-A2", id: "res_uxday_a2" }
  ];
  let picked: { code: string; id: string } | null = null;
  for (const candidate of candidates) {
    const button = arrivals.getByRole("row").filter({ hasText: candidate.code }).first().getByRole("button", { name: primary });
    if (await button.isVisible().catch(() => false)) {
      picked = candidate;
      break;
    }
  }
  if (!picked) {
    await measure.finish(page, { completed: false, note: "sin llegadas sin habitación disponibles: rearma el seed con --reset" });
    return;
  }

  await measure.start(page);
  const row = arrivals.getByRole("row").filter({ hasText: picked.code }).first();
  await measure.countedClick(row.getByRole("button", { name: primary }), "Check-in en NNN (fila de Mi día, candidata preseleccionada)");

  const drawer = page.getByRole("dialog").filter({ hasText: picked.code }).first();
  await expect(drawer).toBeVisible({ timeout: 10_000 });
  await measure.mark(page, "drawer-open");
  const confirm = drawer.getByRole("button", { name: /^Hacer check-in$/ });
  await expect(confirm).toBeEnabled({ timeout: 10_000 });
  await measure.countedClick(confirm, "Hacer check-in (drawer)");

  await expect(toastContaining(page, /Check-in de la \d+ hecho/)).toBeVisible({ timeout: 15_000 });
  const result = await measure.finish(page, { completed: true, context: { reservationCode: picked.code } });

  // Éxito verificable en datos: la reserva queda alojada con habitación asignada.
  const response = await request.get(`${E2E_API_URL}/reservations/${picked.id}`, { headers: { Authorization: `Bearer ${session.token}` } });
  expect(response.ok()).toBeTruthy();
  const reservation = (await response.json()) as { status: string; assignedRoomId: string | null };
  expect(reservation.status).toBe("checked_in");
  expect(reservation.assignedRoomId).toBeTruthy();
  expect(result.clicks).toBe(2);
});
