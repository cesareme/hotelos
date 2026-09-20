// Tanda L6b · lote L6b-03 · panel del asistente unificado. Sin DOM ni React
// montado: se prueban las funciones puras del contexto de pantalla
// (components/assistant/assistant-context.ts), el store del panel
// (assistant-panel-store.ts), los formateadores del hilo (AssistantThread.tsx)
// y los ayudantes del panel (AssistantPanel.tsx), más un contrato de fuente
// sobre los cuatro ficheros (solo Cocoa, 0 `style=`) y el cliente
// services/assistantApi.ts. Los módulos .tsx llegan a services/api-client.ts
// (`import.meta.env`): mismo gancho que components/__tests__/CommandPalette.test.mts.
// Desde apps/admin-web:
//   node --import ../api/node_modules/tsx/dist/loader.mjs --test src/components/__tests__/assistant-panel.test.mts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("/src/services/api-client.ts")) {
      const source = stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), { mode: "strip" });
      return { format: "module", source: `import.meta.env ??= {};\n${source}`, shortCircuit: true };
    }
    return nextLoad(url, context);
  }
});

const context = await import("../assistant/assistant-context.ts");
const store = await import("../assistant/assistant-panel-store.ts");
const thread = await import("../assistant/AssistantThread.tsx");
const panel = await import("../assistant/AssistantPanel.tsx");
const api = await import("../../services/assistantApi.ts");
const format = await import("../../lib/format.ts");

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
const SOURCES: Record<string, string> = {
  "assistant/AssistantPanel.tsx": read("../assistant/AssistantPanel.tsx"),
  "assistant/AssistantThread.tsx": read("../assistant/AssistantThread.tsx"),
  "assistant/assistant-panel-store.ts": read("../assistant/assistant-panel-store.ts"),
  "assistant/assistant-context.ts": read("../assistant/assistant-context.ts")
};
const API_SOURCE = read("../../services/assistantApi.ts");
const TOOLS_SOURCE = readFileSync(new URL("../../../../api/src/modules/assistant/assistant.tools.ts", import.meta.url), "utf8");

describe("assistant-context · buildScreenContext sin PII ni query", () => {
  it("clave, URL sin query ni hash y entidad por id de una ficha de reserva", () => {
    const ctx = context.buildScreenContext({
      screenKey: "ReservationDetailWorkspace",
      pathname: "/recepcion/reservas/res_8f3a2c?tab=folio&q=apellido%20del%20huesped#cargos",
      pageCommands: [
        { id: "reservation-checkin", label: "Hacer check-in", run: () => undefined },
        { id: "reservation-refresh", label: "Actualizar", run: () => undefined }
      ]
    });
    assert.deepEqual(ctx, {
      screenKey: "ReservationDetailWorkspace",
      url: "/recepcion/reservas/res_8f3a2c",
      entity: { type: "reservation", id: "res_8f3a2c" },
      commands: ["reservation-checkin", "reservation-refresh"]
    });
    const serialized = JSON.stringify(ctx);
    assert.ok(!serialized.includes("?") && !serialized.includes("apellido") && !serialized.includes("Hacer check-in") && !serialized.includes("#"));
  });

  it("un segmento que no es un id (nombre codificado, espacios) no produce entidad", () => {
    assert.equal(context.buildScreenContext({ screenKey: "GuestDetail", pathname: "/recepcion/huespedes/Nombre%20Apellido" }).entity, undefined);
    assert.equal(context.buildScreenContext({ screenKey: "GuestDetail", pathname: "/recepcion/huespedes/nueva" }).entity, undefined);
    assert.deepEqual(context.buildScreenContext({ screenKey: "GuestDetail", pathname: "/recepcion/huespedes/gst_01/cronologia" }).entity, { type: "guest", id: "gst_01" });
    assert.deepEqual(context.buildScreenContext({ screenKey: "FolioDetail", pathname: "/finanzas/facturacion/folios/fol_9" }).entity, { type: "folio", id: "fol_9" });
  });

  it("sin ficha: solo clave y URL; sin comandos no hay `commands`; una URL completa se reduce a su ruta", () => {
    const ctx = context.buildScreenContext({ screenKey: "FrontDesk", pathname: "https://demo.ehotelos.com/recepcion/mi-dia/?dia=hoy", pageCommands: [] });
    assert.deepEqual(ctx, { screenKey: "FrontDesk", url: "/recepcion/mi-dia" });
    assert.deepEqual(context.buildScreenContext({ screenKey: null, pathname: null }), { screenKey: "", url: "/" });
  });

  it("los ids de comandos se filtran (solo ids seguros, sin duplicados) y se acotan a MAX_CONTEXT_COMMANDS", () => {
    const many = Array.from({ length: 20 }, (_, index) => ({ id: `cmd-${index}` }));
    assert.equal(context.commandIds(many).length, context.MAX_CONTEXT_COMMANDS);
    assert.deepEqual(context.commandIds([{ id: "ok" }, { id: "ok" }, { id: "con espacio" }, { id: "" }]), ["ok"]);
  });

  it("stripQuery es puro y estable", () => {
    assert.equal(context.stripQuery("/a/b/?x=1"), "/a/b");
    assert.equal(context.stripQuery("a//b#h"), "/a/b");
    assert.equal(context.stripQuery(""), "/");
    assert.equal(context.stripQuery("/"), "/");
  });
});

describe("assistant-panel-store · store abre con pregunta y superficie", () => {
  beforeEach(() => store.resetAssistantPanel());

  it("arranca cerrado; openAssistantWith abre, fija la superficie y deja la pregunta pendiente una sola vez", () => {
    assert.deepEqual(store.getAssistantPanelState(), { open: false, surface: null, pendingQuestion: null, requestId: 0 });
    store.openAssistantWith({ question: "  ¿Cuántas   llegadas tengo hoy? ", surface: "reception" });
    const state = store.getAssistantPanelState();
    assert.equal(state.open, true);
    assert.equal(state.surface, "reception");
    assert.equal(state.pendingQuestion, "¿Cuántas llegadas tengo hoy?");
    assert.equal(state.requestId, 1);
    assert.equal(store.takePendingQuestion(), "¿Cuántas llegadas tengo hoy?");
    assert.equal(store.takePendingQuestion(), null);
    assert.equal(store.getAssistantPanelState().pendingQuestion, null);
  });

  it("una superficie desconocida se ignora y la anterior se conserva; la pregunta vacía no queda pendiente", () => {
    store.openAssistantWith({ surface: "reception" });
    store.openAssistantWith({ question: "   ", surface: "housekeeping" as never });
    const state = store.getAssistantPanelState();
    assert.equal(state.surface, "reception");
    assert.equal(state.pendingQuestion, null);
    assert.equal(state.requestId, 2);
  });

  it("toggle / close: cerrar vacía la pregunta pendiente; requestId sube en cada apertura aunque ya esté abierto", () => {
    store.toggleAssistant();
    assert.equal(store.getAssistantPanelState().open, true);
    store.openAssistantWith({ question: "Estado de pisos hoy" });
    assert.equal(store.getAssistantPanelState().requestId, 2);
    store.toggleAssistant();
    assert.deepEqual(store.getAssistantPanelState(), { open: false, surface: null, pendingQuestion: null, requestId: 2 });
  });

  it("notifica a los suscriptores con una referencia nueva solo cuando algo cambia", () => {
    const seen: unknown[] = [];
    const off = store.subscribeAssistantPanel((state) => seen.push(state));
    store.openAssistant();
    const first = store.getAssistantPanelState();
    store.setAssistantSurface(null);
    assert.equal(store.getAssistantPanelState(), first);
    store.setAssistantSurface("guest");
    off();
    store.closeAssistant();
    assert.equal(seen.length, 2);
  });

  it("requestOpenAssistant sin window abre el store directamente; el evento se llama hotelos-open-assistant", () => {
    assert.equal(store.OPEN_ASSISTANT_EVENT, "hotelos-open-assistant");
    store.requestOpenAssistant({ question: "¿Cuál es la ocupación ahora mismo?", surface: "backoffice" });
    assert.equal(store.getAssistantPanelState().open, true);
    assert.equal(store.getAssistantPanelState().surface, "backoffice");
    store.resetAssistantPanel();
    store.handleOpenAssistantEvent({ detail: { question: "x".repeat(3000), surface: 42 } });
    assert.equal(store.getAssistantPanelState().pendingQuestion?.length, store.MAX_QUESTION_LENGTH);
    assert.equal(store.getAssistantPanelState().surface, null);
    assert.equal(typeof store.listenOpenAssistantEvents(), "function");
  });
});

describe("AssistantThread · formatCitation con y sin coste", () => {
  it("con coste: herramienta · fuente · euros con cuatro decimales", () => {
    const label = thread.formatCitation({ tool: "get_occupancy_today", source: "Prisma · reservations", costEur: 0.0012 });
    assert.equal(label, `get_occupancy_today · Prisma · reservations · ${format.money(0.0012, { decimals: 4 })}`);
    assert.match(label, /0,0012/);
  });

  it("sin coste: null, 0, ausente o inválido → «sin coste»; fuente vacía → «fuente no indicada»", () => {
    assert.equal(thread.formatCitation({ tool: "get_arrivals_today", source: "Prisma · reservations", costEur: null }), "get_arrivals_today · Prisma · reservations · sin coste");
    assert.equal(thread.formatCitation({ tool: "t", source: "s", costEur: 0 }), "t · s · sin coste");
    assert.equal(thread.formatCitation({ tool: "t", source: "s" }), "t · s · sin coste");
    assert.equal(thread.formatCitation({ tool: "t", source: "s", costEur: Number.NaN }), "t · s · sin coste");
    assert.equal(thread.formatCitation({ tool: "t", source: "  " }), "t · fuente no indicada · sin coste");
  });

  it("routedByLabel: v2 `routedBy` manda; sin él, `mode` v1 (llm → Modelo, deterministic → Por reglas)", () => {
    assert.equal(thread.routedByLabel({ mode: "deterministic" }), "Por reglas");
    assert.equal(thread.routedByLabel({ mode: "llm" }), "Modelo");
    assert.equal(thread.routedByLabel({ mode: "llm", routedBy: "rules" }), "Por reglas");
    assert.equal(thread.routedByLabel({ mode: "deterministic", routedBy: "model" }), "Modelo");
    assert.equal(api.routedByOf({ mode: "deterministic", routedBy: null }), "rules");
  });

  it("citationsOf convierte las toolCalls v1 sin coste; turnCostLabel usa cost.eur o la suma de las citas", () => {
    const v1 = { toolCalls: [{ name: "get_pickup_7d", ok: true, source: "Prisma", summary: "7 días" }] };
    assert.deepEqual(thread.citationsOf(v1), [{ tool: "get_pickup_7d", source: "Prisma", ok: true, summary: "7 días", costEur: null }]);
    assert.equal(thread.turnCostLabel(v1), "sin coste");
    assert.equal(thread.turnCostLabel({ toolCalls: [], cost: { eur: 0.02 } }), format.money(0.02, { decimals: 4 }));
    assert.equal(thread.turnCostLabel({ toolCalls: [], citations: [{ tool: "a", source: "s", costEur: 0.001 }, { tool: "b", source: "s", costEur: 0.002 }] }), format.money(0.003, { decimals: 4 }));
    assert.equal(thread.turnCostLabel({ toolCalls: [], cost: { eur: null } }), "sin coste");
  });
});

describe("AssistantPanel · ayudantes puros", () => {
  it("turnsFromMessages empareja usuario → asistente y conserva enrutado, citas y coste", () => {
    const turns = panel.turnsFromMessages([
      { id: "m1", role: "user", content: "¿Cuántas llegadas tengo hoy?", createdAt: "2026-09-20T08:00:00.000Z", correlationId: "corr_1" },
      { id: "m2", role: "tool", content: "{}", createdAt: "2026-09-20T08:00:01.000Z" },
      { id: "m3", role: "assistant", content: "Hoy llegan 12 reservas.", createdAt: "2026-09-20T08:00:02.000Z", routedBy: "rules", citations: [{ tool: "get_arrivals_today", source: "Prisma", costEur: null }], cost: { eur: 0 } },
      { id: "m4", role: "assistant", content: "Además…", createdAt: "2026-09-20T08:01:00.000Z", routedBy: "model", cost: { eur: 0.004 } },
      { id: "m5", role: "user", content: "¿Y salidas?", createdAt: "2026-09-20T08:02:00.000Z" }
    ]);
    assert.equal(turns.length, 3);
    assert.equal(turns[0].question, "¿Cuántas llegadas tengo hoy?");
    assert.equal(turns[0].answer, "Hoy llegan 12 reservas.");
    assert.equal(turns[0].correlationId, "corr_1");
    assert.equal(turns[0].routedBy, "rules");
    assert.equal(turns[0].mode, "deterministic");
    assert.equal(turns[0].citations?.length, 1);
    assert.equal(turns[1].question, "");
    assert.equal(turns[1].mode, "llm");
    assert.equal(turns[1].generatedAt, "2026-09-20T08:01:00.000Z");
    assert.equal(turns[2].question, "¿Y salidas?");
    assert.equal(turns[2].answer, "");
    assert.equal(turns[2].correlationId, "m5");
  });

  it("REV-01: una conversación reabierta convierte las citas GUARDADAS ({ tool, source… }, GET /assistant/conversations/:id) a la forma del hilo: «herramienta · fuente · sin coste», nunca «undefined»", () => {
    const stored = [{ tool: "get_occupancy_today", source: "prisma:Room + Reservation.status=checked_in (today · Property.timezone)", ok: true, summary: "Ocupación hoy: 80 %", aiToolCallId: "call_1" }];
    const turns = panel.turnsFromMessages([
      { id: "m1", role: "user", content: "¿Cuál es la ocupación ahora mismo?", createdAt: "2026-09-20T08:00:00.000Z" },
      { id: "m2", role: "assistant", content: "Ocupación hoy: 80 %.", createdAt: "2026-09-20T08:00:02.000Z", routedBy: "rules", toolCalls: stored, cost: { eur: 0 } }
    ]);
    assert.equal(turns.length, 1);
    const turn = turns[0];
    assert.deepEqual(turn.toolCalls, [{ name: "get_occupancy_today", ok: true, source: stored[0].source, summary: "Ocupación hoy: 80 %" }]);
    assert.deepEqual(turn.citations, [{ tool: "get_occupancy_today", source: stored[0].source, ok: true, summary: "Ocupación hoy: 80 %", costEur: null, aiToolCallId: "call_1" }]);
    const labels = thread.citationsOf(turn).map((citation) => thread.formatCitation(citation));
    assert.deepEqual(labels, [`get_occupancy_today · ${stored[0].source} · sin coste`]);
    assert.ok(labels.every((label) => !label.includes("undefined")));
    // `citations` v2 explícitas mandan sobre las guardadas; sin ninguna, listas vacías.
    const explicit = panel.turnsFromMessages([{ id: "m3", role: "assistant", content: "x", createdAt: "2026-09-20T08:01:00.000Z", toolCalls: stored, citations: [{ tool: "otra", source: "s" }] }]);
    assert.deepEqual(explicit[0].citations, [{ tool: "otra", source: "s" }]);
    const none = panel.turnsFromMessages([{ id: "m4", role: "assistant", content: "x", createdAt: "2026-09-20T08:01:00.000Z" }]);
    assert.deepEqual(none[0].toolCalls, []);
    assert.deepEqual(none[0].citations, []);
    assert.deepEqual(panel.toolCallFromStored({ tool: "t", source: "s" }), { name: "t", ok: true, source: "s", summary: "" });
  });

  it("REV-08: una pregunta de ⌘K con el panel cerrado abre un hilo nuevo; con el panel abierto continúa el activo", () => {
    assert.equal(panel.threadForPendingQuestion({ panelWasOpen: false, activeId: "cnv_antigua" }), null);
    assert.equal(panel.threadForPendingQuestion({ panelWasOpen: true, activeId: "cnv_antigua" }), "cnv_antigua");
    assert.equal(panel.threadForPendingQuestion({ panelWasOpen: true, activeId: null }), null);
    const source = SOURCES["assistant/AssistantPanel.tsx"];
    assert.ok(source.includes("threadForPendingQuestion({ panelWasOpen: wasOpen, activeId: activeIdRef.current }) === null) startNewConversation()"), "el efecto de la pregunta pendiente decide el hilo con el ayudante");
  });

  it("REV-05 / REV-09: el panel lista solo las conversaciones de la superficie activa y el compositor se estira al ancho del cajón", () => {
    const source = SOURCES["assistant/AssistantPanel.tsx"];
    assert.ok(source.includes("listConversations({ surface, signal })"), "GET /assistant/conversations?surface=");
    assert.ok(/<form className="cocoa-stack c22-assistant-composer"/.test(source), "clase del compositor");
    const shell = read("../../styles/cocoa-22-shell.css");
    assert.match(shell, /\.c22-drawer__foot > \.c22-assistant-composer \{ flex: 1 1 100%; min-width: 0; \}/);
  });

  it("mergePending deduplica por id con las nuevas primero; conversationTitle y confirmNotice", () => {
    const a = { id: "tc_1", toolName: "assignRoom", createdAt: "2026-09-20T08:00:00.000Z" };
    const b = { id: "tc_2", toolName: "sendGuestMessage", createdAt: "2026-09-20T08:01:00.000Z" };
    assert.deepEqual(panel.mergePending([a], [b, { ...a, summary: "nuevo" }]).map((call) => call.id), ["tc_2", "tc_1"]);
    assert.equal(panel.mergePending([a], [b, { ...a, summary: "nuevo" }])[1].summary, "nuevo");
    assert.equal(panel.conversationTitle({ title: "  Llegadas de hoy ", surface: "reception" }), "Llegadas de hoy");
    assert.equal(panel.conversationTitle({ title: null, surface: "reception" }), "Conversación · Recepción");
    assert.equal(panel.conversationTitle({ title: "", surface: "otra" }), "Conversación");
    assert.equal(panel.confirmNotice({ status: "succeeded", toolCallId: "tc_1", output: {}, configured: false }).tone, "success");
    assert.equal(panel.confirmNotice({ status: "rejected", toolCallId: "tc_1" }).tone, "neutral");
    assert.equal(panel.confirmNotice({ status: "failed", toolCallId: "tc_1", reason: "tool_denied", message: "Herramienta no permitida" }).text, "Herramienta no permitida");
  });

  it("toda pregunta sugerida de toda superficie la cubre una palabra clave de assistant.tools.ts (100 % sin proveedor)", () => {
    const normalize = (text: string) =>
      text
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[¿?¡!.,;:]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const tokenize = (text: string) => normalize(text).split(" ").filter(Boolean);
    const keywords = Array.from(TOOLS_SOURCE.matchAll(/keywords:\s*\[([^\]]*)\]/g)).flatMap((match) => Array.from(match[1].matchAll(/"([^"]+)"/g)).map((inner) => inner[1]));
    assert.ok(keywords.length >= 40, `catálogo de palabras clave leído: ${keywords.length}`);
    const matches = (question: string) =>
      keywords.some((keyword) => {
        const kwTokens = tokenize(keyword);
        if (kwTokens.length === 1) return normalize(question).includes(kwTokens[0]);
        const qTokens = new Set(tokenize(question));
        return kwTokens.every((token) => qTokens.has(token));
      });
    assert.deepEqual(panel.suggestionsFor("guest"), [], "el bot del huésped no recibe sugerencias de personal");
    for (const surface of api.ASSISTANT_SURFACES) {
      const questions = panel.suggestionsFor(surface);
      if (surface !== "guest") assert.ok(questions.length >= 6, `${surface}: al menos 6 sugerencias`);
      for (const question of questions) assert.ok(matches(question), `${surface}: «${question}» no la cubre ninguna regla`);
    }
    assert.equal(panel.suggestionsFor("desconocida"), panel.SUGGESTED_QUESTIONS_BY_SURFACE.backoffice);
    assert.equal(panel.suggestionsFor(null), panel.SUGGESTED_QUESTIONS_BY_SURFACE.backoffice);
  });
});

describe("assistantApi · cliente v2 compatible con v1", () => {
  it("assistantAskBody: una cadena viaja como { question }; los campos v2 solo cuando tienen valor", () => {
    assert.deepEqual(api.assistantAskBody("  ¿Cuál es la ocupación?  "), { question: "¿Cuál es la ocupación?" });
    assert.deepEqual(api.assistantAskBody({ question: "x", conversationId: null, surface: undefined }), { question: "x" });
    const screen = { screenKey: "FrontDesk", url: "/recepcion/mi-dia" };
    assert.deepEqual(api.assistantAskBody({ question: "x", conversationId: "cnv_1", surface: "reception", screen }), { question: "x", conversationId: "cnv_1", surface: "reception", screen });
  });

  it("endpoints v2 en el cliente y sin fetch crudo", () => {
    for (const path of ['"/assistant/chat"', '"/assistant/conversations"', "/assistant/conversations/${", '"/assistant/pending"', "/ai/tool-calls/${", '"/assistant/tools"']) {
      assert.ok(API_SOURCE.includes(path), `assistantApi.ts referencia ${path}`);
    }
    assert.ok(API_SOURCE.includes('method: "DELETE"'), "deleteConversation usa DELETE");
    assert.ok(!/\bfetch\(/.test(API_SOURCE), "sin fetch crudo (tests/admin-web-no-raw-fetch)");
    assert.ok(api.isAssistantSurface("reception") && !api.isAssistantSurface("guest-bot"));
    for (const name of ["askAssistant", "listConversations", "getConversation", "deleteConversation", "listPending", "confirmToolCall", "fetchAssistantTools"]) {
      assert.equal(typeof (api as Record<string, unknown>)[name], "function", name);
    }
  });
});

describe("components/assistant · contrato de fuente (Cocoa solo, 0 style=)", () => {
  it("0 `style=` en los cuatro ficheros y solo primitivas Cocoa (sin <button>, <input>, <textarea>, <table>, <select>)", () => {
    for (const [name, source] of Object.entries(SOURCES)) {
      assert.equal((source.match(/\bstyle=\{/g) ?? []).length, 0, `${name}: style=`);
      assert.equal((source.match(/<(button|input|textarea|table|select)\b/g) ?? []).length, 0, `${name}: elemento crudo`);
      assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(source), `${name}: color literal`);
    }
  });

  it("el panel es un CocoaDrawer lateral derecho con compositor multiline y el hilo pinta el badge de enrutado y las citas", () => {
    const panelSource = SOURCES["assistant/AssistantPanel.tsx"];
    assert.ok(/<CocoaDrawer[\s\S]*side="right"/.test(panelSource));
    assert.ok(/<CocoaInput[\s\S]*multiline/.test(panelSource));
    assert.ok(panelSource.includes("listenOpenAssistantEvents()"), "escucha hotelos-open-assistant");
    assert.ok(panelSource.includes("buildScreenContext({"), "cada pregunta lleva el contexto de pantalla");
    const threadSource = SOURCES["assistant/AssistantThread.tsx"];
    assert.ok(threadSource.includes('"Por reglas"') && threadSource.includes('"Modelo"'));
    assert.ok(threadSource.includes("formatCitation(citation)"));
    assert.ok(threadSource.includes("ACTIONS.approve") && threadSource.includes("ACTIONS.reject"));
    assert.ok(/role="log"[^>]*aria-live="polite"/.test(threadSource), "una sola live region: el log del hilo");
  });

  it("los componentes importan Cocoa desde el barrel y el shell monta el panel una sola vez (L6b-07, BackOfficeLayout)", () => {
    for (const [name, source] of Object.entries(SOURCES)) {
      if (!name.endsWith(".tsx")) continue;
      assert.ok(/from "\.\.\/cocoa"/.test(source), `${name}: barrel components/cocoa`);
    }
    const layout = read("../../layouts/BackOfficeLayout.tsx");
    assert.ok(
      /from "\.\.\/components\/assistant\/AssistantPanel"/.test(layout),
      "BackOfficeLayout importa AssistantPanel desde components/assistant/",
    );
    assert.equal((layout.match(/<AssistantPanel\b/g) ?? []).length, 1, "BackOfficeLayout monta <AssistantPanel> exactamente una vez");
    let app = "";
    try {
      app = read("../../App.tsx");
    } catch {
      app = "";
    }
    assert.ok(!app.includes("components/assistant/"), "App.tsx no monta el panel: el único montaje vive en BackOfficeLayout");
  });
});
