import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { E2E_API_URL, UXDAY, assertNoLoginGate, loginAsUxDay } from "./_helpers";

/**
 * Panel del asistente unificado (Tanda L6b · lote L6b-10 · objetivo 5 del
 * brief: e2e mínimo del panel). Proyecto `chromium`, tenant sintético UXDAY
 * (seed-ux-day): ninguna aserción ni captura lleva nombres de personas.
 *
 *  (1) recepción: el botón «Asistente ehotelOS» de la toolbar abre el panel
 *      (CocoaDrawer) con la superficie de recepción; la sugerida «¿Cuántas
 *      llegadas tengo hoy?» responde con el badge «Por reglas», cita
 *      `get_arrivals_today` con su fuente y ningún badge ni el turno del API
 *      nombran un modelo.
 *  (2) ⌘K con «ocupación ahora mismo» → ítem «Preguntar al asistente…» →
 *      Intro → la paleta se cierra, el panel se abre y responde
 *      (`get_occupancy_today`).
 *  (3) memoria: tras recargar, la conversación de (1) sigue en
 *      «Conversaciones» (panel y GET /assistant/conversations) y al abrirla
 *      vuelve el hilo guardado (pregunta + respuesta por reglas).
 *  (3b) la cita de la conversación reabierta conserva la herramienta
 *      (`get_arrivals_today · fuente · sin coste`), como en el turno en vivo.
 *  (4) privacidad por usuario: direccion@uxday.test no ve la conversación de
 *      recepción ni en el panel ni por API (lista sin ella; GET
 *      /assistant/conversations/:id → 404).
 *  (5) accesibilidad: el panel es `role="dialog"` modal, el foco entra en el
 *      compositor al abrir, el hilo es un `role="log"`, Esc cierra (el cajón se
 *      desmonta) y el foco vuelve al botón de la toolbar.
 *
 * Orden del fichero (1 worker, sin paralelismo). (3), (3b) y (4) localizan por
 * API la conversación que crea (1) —la más reciente de recepción con ese
 * título— en vez de compartir estado del módulo: Playwright reinicia el worker
 * tras un fallo y lo perdería. Al empezar, (1) retira por API las conversaciones
 * de la pasada anterior del usuario de recepción con los dos títulos de la spec
 * (DELETE /assistant/conversations/:id, solo las suyas), y deja las de esta
 * pasada para inspección. Sin proveedor de IA (AI_PROVIDER none) el núcleo
 * responde por reglas (assistant-router.ts): las sugeridas están cubiertas al
 * 100 % y el badge es «Por reglas».
 */

const ASSISTANT_NAME = "Asistente ehotelOS";
const RECEPTION_URL = "/recepcion/reservas/lista";
const SUGGESTED_QUESTION = "¿Cuántas llegadas tengo hoy?";
const CMDK_QUESTION = "ocupación ahora mismo";
const ROUTED_BY_RULES = /por reglas/i;
const NO_COST = "sin coste";
/** «herramienta · fuente · coste» con una fuente no vacía (AssistantThread.formatCitation). */
const CITED_WITH_SOURCE = (tool: string) => new RegExp(`${tool} · [^·]*\\S[^·]* · `);

type ConversationSummary = { id: string; title: string | null; surface: string; lastMessageAt?: string | null; createdAt?: string };
/** Campos de AssistantTurn v2 (services/assistantApi.ts) que lee la spec. */
type ChatTurn = { conversationId?: string | null; routedBy?: string; mode?: string; cost?: { eur?: number | null; model?: string | null } | null };
type ApiSession = { token: string };

/** Botón de la toolbar (BackOfficeLayout AssistantButton, hook `data-tour="assistant"`): el menú lateral tiene un ítem con el mismo nombre (/asistente). */
function toolbarAssistant(page: Page): Locator {
  return page.getByRole("button", { name: ASSISTANT_NAME, exact: true }).and(page.locator('[data-tour="assistant"]'));
}

function assistantDrawer(page: Page): Locator {
  return page.getByRole("dialog", { name: ASSISTANT_NAME });
}

function composer(drawer: Locator): Locator {
  return drawer.getByRole("textbox", { name: "Pregunta", exact: true });
}

function answers(drawer: Locator): Locator {
  return drawer.getByRole("group", { name: "Respuesta del asistente" });
}

function historyList(drawer: Locator): Locator {
  return drawer.getByRole("list", { name: "Conversaciones" });
}

function citationOf(bubble: Locator, tool: string): Locator {
  return bubble.getByRole("list", { name: "Fuentes consultadas" }).getByRole("listitem").filter({ hasText: tool });
}

/** Espera a que la sección «Conversaciones» termine de cargar (lista o estado vacío; nunca «Historial no disponible»). */
async function expectHistoryLoaded(drawer: Locator): Promise<void> {
  await expect(historyList(drawer).or(drawer.getByText("Sin conversaciones guardadas"))).toBeVisible({ timeout: 10_000 });
  await expect(drawer.getByText("Historial no disponible")).toHaveCount(0);
}

async function openPanelFromToolbar(page: Page): Promise<Locator> {
  await toolbarAssistant(page).click();
  const drawer = assistantDrawer(page);
  await expect(drawer).toBeVisible();
  return drawer;
}

/** Abre la conversación guardada `title` desde la lista del panel y espera su hilo. */
async function reopenSavedConversation(drawer: Locator, title: string): Promise<Locator> {
  await expectHistoryLoaded(drawer);
  const entry = historyList(drawer).getByRole("button", { name: title, exact: true }).first();
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(drawer.locator('[data-cocoa="callout"]').filter({ hasText: title })).toBeVisible({ timeout: 10_000 });
  const bubble = answers(drawer).first();
  await expect(bubble).toBeVisible();
  return bubble;
}

/** POST /assistant/chat que dispara `action`: devuelve el turno (AssistantTurn v2) tal y como lo recibió el panel. */
async function chatTurn(page: Page, action: () => Promise<void>): Promise<ChatTurn> {
  const response = page.waitForResponse((r) => r.request().method() === "POST" && /\/assistant\/chat$/.test(r.url()), { timeout: 20_000 });
  await action();
  const turn = await response;
  expect(turn.ok(), `POST /assistant/chat → ${turn.status()}`).toBeTruthy();
  return (await turn.json()) as ChatTurn;
}

/**
 * Badges de una respuesta por reglas: «Por reglas» (nunca «Modelo») y coste
 * «sin coste»; ningún badge nombra un modelo. El cuerpo de la respuesta por
 * reglas del núcleo termina con «(por reglas, sin modelo)»
 * (assistant-core.service.ts), así que la ausencia de modelo se exige sobre
 * los badges y sobre el turno del API (`expectNoModelTurn`), no sobre la
 * palabra en el texto.
 */
async function expectRulesBadges(bubble: Locator): Promise<void> {
  await expect(bubble).toBeVisible({ timeout: 20_000 });
  const badges = bubble.locator('[data-cocoa="badge"]');
  await expect(badges.first()).toHaveText(ROUTED_BY_RULES);
  await expect(badges.nth(1)).toHaveText(NO_COST);
  for (const badge of await badges.all()) await expect(badge).not.toContainText(/modelo/i);
}

/** Cita «tool · fuente · sin coste» con fuente no vacía. */
async function expectCitation(bubble: Locator, tool: string): Promise<void> {
  const citation = citationOf(bubble, tool);
  await expect(citation).toHaveCount(1);
  await expect(citation).toContainText(CITED_WITH_SOURCE(tool));
  await expect(citation).toContainText(NO_COST);
  await expect(citation).not.toContainText("fuente no indicada");
}

/** El turno v2 del API declara la respuesta por reglas: sin modelo, sin tokens ni coste. */
function expectNoModelTurn(turn: ChatTurn): void {
  expect(turn.routedBy, "routedBy del turno").toBe("rules");
  expect(turn.mode, "mode del turno").toBe("deterministic");
  expect(turn.cost?.model ?? null, "cost.model del turno").toBeNull();
  expect(turn.cost?.eur ?? 0, "cost.eur del turno").toBe(0);
}

// ---------------------------------------------------------------------------
// API (solo lectura y DELETE de conversaciones propias): sesión aparte de la
// del navegador para poder consultar recepción mientras la página es de dirección.
// ---------------------------------------------------------------------------

const apiSessions = new Map<string, ApiSession>();

async function apiSession(request: APIRequestContext, email: string): Promise<ApiSession> {
  const cached = apiSessions.get(email);
  if (cached) return cached;
  const response = await request.post(`${E2E_API_URL}/auth/login`, { data: { email, password: UXDAY.password, deviceId: "e2e-assistant" } });
  expect(response.ok(), `POST /auth/login (${email}) → ${response.status()}`).toBeTruthy();
  const session = { token: ((await response.json()) as { token: string }).token };
  apiSessions.set(email, session);
  return session;
}

function apiHeaders(session: ApiSession): Record<string, string> {
  return { Authorization: `Bearer ${session.token}`, "x-property-id": UXDAY.propertyId };
}

async function listConversationsViaApi(request: APIRequestContext, session: ApiSession): Promise<ConversationSummary[]> {
  const response = await request.get(`${E2E_API_URL}/assistant/conversations`, { headers: apiHeaders(session) });
  expect(response.ok(), `GET /assistant/conversations → ${response.status()}`).toBeTruthy();
  const payload = (await response.json()) as { items?: ConversationSummary[] } | ConversationSummary[];
  return Array.isArray(payload) ? payload : (payload.items ?? []);
}

/** La conversación de recepción que creó (1): la más reciente con ese título y superficie `reception`. */
async function receptionConversation(request: APIRequestContext): Promise<ConversationSummary> {
  const session = await apiSession(request, UXDAY.users.recepcion);
  const mine = (await listConversationsViaApi(request, session)).filter((c) => c.surface === "reception" && c.title === SUGGESTED_QUESTION);
  mine.sort((a, b) => String(b.lastMessageAt ?? b.createdAt ?? "").localeCompare(String(a.lastMessageAt ?? a.createdAt ?? "")));
  expect(mine.length, "(1) debe haber creado la conversación de recepción").toBeGreaterThan(0);
  return mine[0];
}

/** Retira las conversaciones de la pasada anterior del usuario de recepción (solo los dos títulos de esta spec). Devuelve cuántas. */
async function retirePreviousRun(request: APIRequestContext): Promise<number> {
  const session = await apiSession(request, UXDAY.users.recepcion);
  const stale = (await listConversationsViaApi(request, session)).filter((c) => c.title === SUGGESTED_QUESTION || c.title === CMDK_QUESTION);
  for (const conversation of stale) {
    const response = await request.delete(`${E2E_API_URL}/assistant/conversations/${encodeURIComponent(conversation.id)}`, { headers: apiHeaders(session) });
    expect([204, 404], `DELETE /assistant/conversations/${conversation.id} → ${response.status()}`).toContain(response.status());
  }
  return stale.length;
}

test("(1) recepción: el botón de la toolbar abre el panel y la sugerida responde por reglas citando get_arrivals_today", async ({ page, request }, testInfo) => {
  const retired = await retirePreviousRun(request);
  if (retired > 0) {
    // eslint-disable-next-line no-console
    console.log(`[e2e:assistant-panel] retiradas ${retired} conversaciones de la pasada anterior (recepción, títulos de la spec)`);
  }
  await loginAsUxDay(page, request);
  await page.goto(RECEPTION_URL, { waitUntil: "domcontentloaded" });
  await assertNoLoginGate(page, testInfo);

  const button = toolbarAssistant(page);
  await expect(button).toBeVisible({ timeout: 15_000 });
  await expect(button).toHaveAttribute("aria-haspopup", "dialog");
  const drawer = await openPanelFromToolbar(page);
  await expect(drawer.getByText(/Con el contexto de esta pantalla · Recepción/)).toBeVisible();

  const suggested = drawer.getByRole("list", { name: "Preguntas sugeridas" }).getByRole("button", { name: SUGGESTED_QUESTION, exact: true });
  await expect(suggested).toBeVisible();
  const turn = await chatTurn(page, () => suggested.click());
  expectNoModelTurn(turn);
  expect(typeof turn.conversationId === "string" && turn.conversationId.length > 0, "el turno abre una conversación con memoria").toBe(true);

  await expect(drawer.locator('[data-cocoa="callout"]').filter({ hasText: SUGGESTED_QUESTION })).toBeVisible();
  const bubble = answers(drawer).first();
  await expectRulesBadges(bubble);
  await expectCitation(bubble, "get_arrivals_today");
  await expect(bubble).toContainText(/llegada/i);
  await page.screenshot({ path: testInfo.outputPath("1-recepcion-por-reglas.png") });

  // La conversación queda guardada a nombre de recepción (la localizan (3), (3b) y (4)).
  expect((await receptionConversation(request)).id).toBe(turn.conversationId);
});

test("(2) ⌘K con «ocupación ahora mismo» → «Preguntar al asistente» → Intro abre el panel con la respuesta", async ({ page, request }, testInfo) => {
  await loginAsUxDay(page, request);
  await page.goto("/hoy", { waitUntil: "domcontentloaded" });
  await assertNoLoginGate(page, testInfo);
  await expect(toolbarAssistant(page)).toBeVisible({ timeout: 15_000 });

  await page.keyboard.press("ControlOrMeta+K");
  const palette = page.getByRole("dialog", { name: "Buscar en la aplicación" });
  await expect(palette).toBeVisible();
  await expect(palette.getByRole("searchbox")).toBeFocused();
  await page.keyboard.type(CMDK_QUESTION);

  const askItem = palette.getByRole("option", { name: /Preguntar al asistente/ });
  await expect(askItem).toBeVisible();
  await expect(askItem).toContainText(CMDK_QUESTION);
  await askItem.hover();
  await expect(askItem).toHaveAttribute("aria-selected", "true");
  await page.screenshot({ path: testInfo.outputPath("2-cmdk-preguntar.png") });

  const turn = await chatTurn(page, () => page.keyboard.press("Enter"));
  expectNoModelTurn(turn);
  await expect(palette).toHaveCount(0);
  const drawer = assistantDrawer(page);
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('[data-cocoa="callout"]').filter({ hasText: CMDK_QUESTION })).toBeVisible();
  const bubble = answers(drawer).first();
  await expectRulesBadges(bubble);
  await expectCitation(bubble, "get_occupancy_today");
  await page.screenshot({ path: testInfo.outputPath("2-cmdk-respuesta.png") });
});

test("(3) memoria: tras recargar, la conversación de recepción sigue en la lista y al abrirla vuelve el hilo", async ({ page, request }, testInfo) => {
  // Por API: la conversación de (1) sigue a nombre de recepción con su título y superficie.
  const saved = await receptionConversation(request);
  expect(saved.surface).toBe("reception");
  expect(saved.title).toBe(SUGGESTED_QUESTION);

  await loginAsUxDay(page, request);
  await page.goto(RECEPTION_URL, { waitUntil: "domcontentloaded" });
  await assertNoLoginGate(page, testInfo);
  await expect(toolbarAssistant(page)).toBeVisible({ timeout: 15_000 });

  // En el panel, tras una carga nueva de la página: la lista la muestra y al abrirla vuelve el hilo guardado.
  const drawer = await openPanelFromToolbar(page);
  await expect(drawer.getByRole("list", { name: "Preguntas sugeridas" })).toBeVisible();
  const bubble = await reopenSavedConversation(drawer, SUGGESTED_QUESTION);
  await expectRulesBadges(bubble);
  await expect(bubble).toContainText(/llegada/i);
  await expect(drawer.getByRole("list", { name: "Preguntas sugeridas" })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("3-memoria-recargada.png") });
});

test("(3b) la cita de la conversación reabierta conserva la herramienta y la fuente", async ({ page, request }, testInfo) => {
  await receptionConversation(request);
  await loginAsUxDay(page, request);
  await page.goto(RECEPTION_URL, { waitUntil: "domcontentloaded" });
  await assertNoLoginGate(page, testInfo);
  await expect(toolbarAssistant(page)).toBeVisible({ timeout: 15_000 });

  const drawer = await openPanelFromToolbar(page);
  const bubble = await reopenSavedConversation(drawer, SUGGESTED_QUESTION);
  // Misma cita que en el turno en vivo (AssistantThread.formatCitation): herramienta · fuente · sin coste.
  await expectCitation(bubble, "get_arrivals_today");
  await expect(bubble.getByRole("list", { name: "Fuentes consultadas" })).not.toContainText("undefined");
});

test("(4) privacidad: dirección no ve la conversación de recepción (ni en el panel ni por API)", async ({ page, request }, testInfo) => {
  const saved = await receptionConversation(request);
  await loginAsUxDay(page, request, { email: UXDAY.users.direccion });
  await page.goto("/hoy", { waitUntil: "domcontentloaded" });
  await assertNoLoginGate(page, testInfo);
  await expect(toolbarAssistant(page)).toBeVisible({ timeout: 15_000 });

  const drawer = await openPanelFromToolbar(page);
  await expectHistoryLoaded(drawer);
  await expect(historyList(drawer).getByRole("button", { name: SUGGESTED_QUESTION, exact: true })).toHaveCount(0);

  const direccion = await apiSession(request, UXDAY.users.direccion);
  const theirs = await listConversationsViaApi(request, direccion);
  expect(theirs.some((conversation) => conversation.id === saved.id), "la memoria es privada por usuario").toBe(false);
  const direct = await request.get(`${E2E_API_URL}/assistant/conversations/${encodeURIComponent(saved.id)}`, { headers: apiHeaders(direccion) });
  expect(direct.status(), "GET /assistant/conversations/:id ajena → 404 opaco").toBe(404);
  await page.screenshot({ path: testInfo.outputPath("4-direccion-sin-conversacion.png") });
});

test("(5) accesibilidad: diálogo modal, foco en el compositor, hilo role=log, Esc cierra y devuelve el foco", async ({ page, request }, testInfo) => {
  await loginAsUxDay(page, request);
  await page.goto(RECEPTION_URL, { waitUntil: "domcontentloaded" });
  await assertNoLoginGate(page, testInfo);

  const button = toolbarAssistant(page);
  await expect(button).toBeVisible({ timeout: 15_000 });
  await expect(button).toHaveAttribute("aria-expanded", "false");
  const drawer = await openPanelFromToolbar(page);
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(drawer).toHaveAttribute("aria-modal", "true");
  await expect(composer(drawer)).toBeFocused();
  const log = drawer.getByRole("log", { name: "Conversación con el asistente" });
  await expect(log).toBeVisible();
  await expect(log).toHaveAttribute("aria-live", "polite");
  await page.screenshot({ path: testInfo.outputPath("5-panel-foco-compositor.png") });

  await page.keyboard.press("Escape");
  // El cajón se desmonta al terminar su transición de salida (CocoaDrawer EXIT_MS).
  await expect(page.locator('[data-cocoa="drawer"]')).toHaveCount(0);
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await expect(button).toBeFocused();
});
