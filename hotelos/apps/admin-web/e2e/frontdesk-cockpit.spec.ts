import { expect, test } from "@playwright/test";
import { E2E_API_URL, UXDAY, assertNoLoginGate, loginAsUxDay } from "./_helpers";

/**
 * Mi día (Tanda UX-1 · lotes U1/U6 · F30, §5.1): con la sesión del tenant
 * UXDAY, la pantalla `/hoy` (nav-tree.generated.json · FrontDeskDashboard)
 * muestra el saludo, los tres KPI reales («Llegan hoy», «Salen hoy», «En el
 * hotel», FrontDeskDashboard.tsx CocoaKpi) con las cifras del seed (6 · 5 · 41;
 * «En el hotel» no cuenta las salidas de hoy y las medidas solo suman),
 * las cuatro vistas del segmentado con el vocabulario D5 («Llegan hoy · Salen
 * hoy · En el hotel · Sin habitación») y UNA acción primaria por fila (P1).
 */
test("Mi día muestra saludo, KPI reales y una acción primaria por fila", async ({ page, request }, testInfo) => {
  await loginAsUxDay(page, request);
  await page.goto("/hoy", { waitUntil: "domcontentloaded" });
  await assertNoLoginGate(page, testInfo);

  await expect(page.getByText(/Buenos días|Buenas tardes|Buenas noches/i).first()).toBeVisible({ timeout: 15_000 });

  // KPI reales de la cabecera (CocoaKpi «Llegan hoy» · «Salen hoy» · «En el hotel» (mismo literal que las pestañas, L-16)).
  // Las cifras dependen de lo que hayan hecho las medidas (measure corre antes
  // en `pnpm e2e`): se comprueba que son números y coherentes con las pestañas.
  const kpiValue = async (label: string): Promise<number> => {
    const kpi = page.locator(".c22-kpi").filter({ hasText: label }).first();
    await expect(kpi).toBeVisible();
    const text = (await kpi.innerText()).replace(label, "");
    const match = /(\d[\d.]*)/.exec(text);
    expect(match, `${label} sin cifra`).not.toBeNull();
    return Number(match![1].replace(/\./g, ""));
  };
  const arrivalsToday = await kpiValue("Llegan hoy");
  const departuresToday = await kpiValue("Salen hoy");
  const inHouseNow = await kpiValue("En el hotel");
  expect(arrivalsToday).toBeGreaterThanOrEqual(5);
  // «Salen hoy» cuenta las PENDIENTES (las hechas van aparte, L-16): la medida t3 cierra una de las 5 del seed.
  expect(departuresToday).toBeGreaterThanOrEqual(1);
  expect(inHouseNow, "41 alojados del seed más las salidas de hoy aún alojadas (L-16); measure solo añade").toBeGreaterThanOrEqual(41);

  // Segmentado de vistas (role="tablist" de CocoaSegmentedControl «Vista de recepción») con el vocabulario D5.
  const views = page.getByRole("tablist", { name: "Vista de recepción" });
  await expect(views.getByRole("tab", { name: /^Llegan hoy \(\d+\)/ })).toBeVisible();
  await expect(views.getByRole("tab", { name: /^Salen hoy \(\d+/ })).toBeVisible();
  await expect(views.getByRole("tab", { name: /^En el hotel \(\d+\)/ })).toBeVisible();
  await expect(views.getByRole("tab", { name: /^Sin habitación \(\d+\)/ })).toBeVisible();

  // Tabla de llegadas: una única acción `filled` por fila (P1) y, en las confirmadas, «Hacer check-in» / «Check-in en NNN» (F2: también sin habitación).
  const arrivals = page.getByRole("table", { name: "Llegadas de hoy" });
  await expect(arrivals).toBeVisible();
  const bodyRows = arrivals.locator("tbody tr[data-interactive]");
  const rowCount = await bodyRows.count();
  expect(rowCount).toBeGreaterThanOrEqual(5);
  const filled = arrivals.locator('tbody tr [data-cocoa="button"][data-variant="filled"]');
  await expect(filled).toHaveCount(rowCount);
  const checkInButtons = arrivals.getByRole("button", { name: /^(Hacer check-in|Check-in en \d+)$/ });
  expect(await checkInButtons.count()).toBeGreaterThanOrEqual(1);
  // Cada fila tiene su menú «⋯» con acciones con id (F3).
  await expect(arrivals.getByRole("button", { name: /^Más acciones de / })).toHaveCount(rowCount);
});

/**
 * Lote (U6 · §5.1 (3), §5.4 (6), F25): en «Salen hoy» se marcan dos estancias
 * con saldo 0 (UXDAY-D3 en la 206 y UXDAY-D4 en la 207; D2 debe 45 € y queda
 * fuera) y «Check-out de 2 con saldo 0» las cierra EN SERIE: toast «2
 * check-outs hechos», las filas pasan a «Salida hecha» y el API confirma
 * `checked_out`. Si ya salieron la spec FALLA (rearma el seed con --reset).
 */
test("Mi día · lote «Check-out de 2 con saldo 0» en Salen hoy", async ({ page, request }, testInfo) => {
  const session = await loginAsUxDay(page, request);
  const headers = { Authorization: `Bearer ${session.token}`, "x-property-id": UXDAY.propertyId };
  for (const id of ["res_uxday_d3", "res_uxday_d4"]) {
    const detail = (await (await request.get(`${E2E_API_URL}/reservations/${id}`, { headers })).json()) as { status: string };
    expect(detail.status, `${id} debe estar en el hotel; rearma el seed con --reset`).toBe("checked_in");
  }

  await page.goto("/hoy", { waitUntil: "domcontentloaded" });
  await assertNoLoginGate(page, testInfo);
  await page.getByRole("tablist", { name: "Vista de recepción" }).getByRole("tab", { name: /^Salen hoy/ }).click();
  const departures = page.getByRole("table", { name: "Salidas de hoy" });
  await expect(departures).toBeVisible({ timeout: 10_000 });

  for (const roomNumber of ["206", "207"]) {
    const row = departures.getByRole("row").filter({ has: page.getByRole("cell", { name: roomNumber, exact: true }) }).first();
    await expect(row).toBeVisible();
    await row.getByRole("checkbox").check();
  }
  const batch = page.getByRole("button", { name: /^Check-out de 2 con saldo 0$/ });
  await expect(batch).toBeEnabled({ timeout: 5_000 });
  await batch.click();
  // N > 1 pasa por el diálogo nominal (UX1-REV-01): lista las habitaciones y confirma con el mismo literal.
  const prompt = page.getByRole("dialog").filter({ hasText: /Se cerrarán 2 estancias con saldo 0 que salen hoy/ });
  await expect(prompt).toBeVisible({ timeout: 5_000 });
  await prompt.getByRole("button", { name: /^Check-out de 2 con saldo 0$/ }).click();
  await expect(page.locator('[data-cocoa="toast"]').filter({ hasText: /2 check-outs hechos/ }).first()).toBeVisible({ timeout: 20_000 });
  for (const roomNumber of ["206", "207"]) {
    const row = departures.getByRole("row").filter({ has: page.getByRole("cell", { name: roomNumber, exact: true }) }).first();
    await expect(row.getByText("Salida hecha")).toBeVisible({ timeout: 10_000 });
  }
  for (const id of ["res_uxday_d3", "res_uxday_d4"]) {
    const detail = (await (await request.get(`${E2E_API_URL}/reservations/${id}`, { headers })).json()) as { status: string };
    expect(detail.status).toBe("checked_out");
  }
});
