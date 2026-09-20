import { expect, test } from "@playwright/test";
import { E2E_API_URL, assertNoLoginGate } from "../_helpers";
import { loginAsDirector, waitForDireccion } from "../_helpers-direccion";
import { createMeasure, dataRows, toastContaining } from "./_measure-direccion";

/**
 * D2 · «Hay solicitudes pendientes de tu aprobación: aprueba la primera.»
 * Camino DESPUÉS de UX-2 (lotes D4/D5; corrector UX2-REV-06: spec oficial actualizada al camino nuevo): tarjeta «Pendientes · N aprobaciones · M de la IA»
 * de Mi día (grupo «Pendientes de hoy», MiDiaTabs.tsx) → /hoy/pendientes → «Aprobar»
 * (primaria de la fila decidible) → diálogo nominal «Aprobar <tipo> de <importe>» → su
 * botón homónimo → POST /approvals/:id/approve → toast «Aprobada: … · solicitud XXXXXX».
 * Objetivo ≤ 3 clics, ≤ 16 peticiones. Éxito verificable: GET /approvals?status=approved.
 */
test("d2 · aprobar una solicitud pendiente", async ({ page, request }, testInfo) => {
  const session = await loginAsDirector(page, request);
  const measure = createMeasure(page, "d2");
  await page.goto("/hoy/direccion", { waitUntil: "domcontentloaded" });
  await assertNoLoginGate(page, testInfo);
  await waitForDireccion(page);
  measure.step("Mi día de dirección cargado");

  // La tarjeta depende de las claves de aprobación del perfil (asíncrono): hasta 10 s tras los KPIs.
  const card = page.getByRole("group", { name: "Pendientes de hoy" }).getByRole("button", { name: /^Pendientes · \d+ aprobaci/ }).first();
  if (!(await card.waitFor({ state: "visible", timeout: 10_000 }).then(() => true, () => false))) {
    await measure.finish(page, { completed: false, note: "sin tarjeta «Pendientes · N aprobaciones»: el perfil no tiene claves de aprobación (seed D1)" });
    return;
  }

  await measure.start(page);
  await measure.countedClick(card, "Pendientes · N aprobaciones (tarjeta de Mi día)");
  await expect(page).toHaveURL(/\/hoy\/pendientes/, { timeout: 15_000 });
  const table = page.getByRole("table", { name: "Solicitudes de aprobación" });
  const empty = page.getByText("Nada pendiente de aprobar");
  await expect(table.or(empty).first()).toBeVisible({ timeout: 15_000 });
  const row = dataRows(table).filter({ hasNotText: /Propia|Doble aprobación/ }).filter({ has: page.getByRole("button", { name: "Aprobar", exact: true }) }).first();
  if (!(await row.isVisible().catch(() => false))) {
    await measure.finish(page, { completed: false, note: "sin solicitudes pendientes decidibles en la bandeja (rearma el seed D1 con --reset)" });
    return;
  }

  const rowApprove = row.getByRole("button", { name: "Aprobar", exact: true }).first();
  await measure.countedClick(rowApprove, "Aprobar (primaria de la fila)");
  const confirm = page.getByRole("dialog", { name: /^Aprobar / });
  await expect(confirm).toBeVisible({ timeout: 10_000 });
  await measure.mark(page, "dialog-open");
  const posted = page.waitForResponse((response) => response.request().method() === "POST" && /\/approvals\/[^/]+\/approve$/.test(response.url()), { timeout: 20_000 });
  await measure.countedClick(confirm.getByRole("button", { name: /^Aprobar / }), "Aprobar <tipo> de <importe> (diálogo nominal)");
  const response = await posted;
  const approvalId = decodeURIComponent(new URL(response.url()).pathname.split("/").at(-2) ?? "");
  const decided = response.ok() ? ((await response.json().catch(() => ({}))) as { status?: string }) : {};
  const completed = response.ok() && decided.status === "approved";
  if (response.ok()) await expect(toastContaining(page, /^Aprobada: |Primera aprobación registrada/)).toBeVisible({ timeout: 15_000 });

  const result = await measure.finish(page, {
    completed,
    context: { approvalId, status: response.status(), decidedStatus: decided.status ?? null },
    note: completed ? "camino UX-2 (D4/D5): tarjeta → «Aprobar» en la fila → diálogo nominal" : `POST /approvals/:id/approve → ${response.status()} · estado ${decided.status ?? "desconocido"}`
  });

  if (completed) {
    const approved = await request.get(`${E2E_API_URL}/approvals?status=approved`, { headers: session.headers });
    expect(approved.ok(), `GET /approvals?status=approved → ${approved.status()}`).toBeTruthy();
    const payload = (await approved.json()) as Array<{ id: string }> | { items?: Array<{ id: string }> };
    const ids = (Array.isArray(payload) ? payload : (payload.items ?? [])).map((item) => item.id);
    expect(ids).toContain(approvalId);
    expect(result.clicks).toBe(3);
  }
});
