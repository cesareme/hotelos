import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  aiUsageStatus,
  callStatusLabel,
  callStatusTone,
  COST_UNKNOWN_TITLE,
  costCallsTotal,
  costLabel,
  readinessCheckLabel,
  readinessDetail,
  type ReadinessCheckLike
} from "../ai-operations-labels.ts";
import { money } from "../../../lib/format";

// Regression of the fix:10-B lot (Cocoa 22 · ola 10 · lote 10-B): qa#3 (the
// readiness checklist of /configuracion/ia painted the API's English
// label/detail), qa#11 («COMPLETED» badge in warning tone in
// /configuracion/ia/actividad), qa#4 (disconnecting a mailbox without a
// dialog; Gmail rows created while the authorisation is unavailable) and
// qa#18 («Descartar cambios» without a dirty guard).
// Tanda L6b · lote 04 (front honesto de IA-ops): `skipped` and the runtime
// readiness checks `provider` / `budget` have a Spanish label and a tone, a
// NULL cost is «—» with its reason, and «En uso» needs real tool calls.

const SCREENS = fileURLToPath(new URL("../", import.meta.url));
const read = (file: string) => readFileSync(`${SCREENS}${file}`, "utf8");
const check = (key: string, status: ReadinessCheckLike["status"], detail = "raw"): ReadinessCheckLike => ({ key, label: key, status, detail });
const ENGLISH = /\b(AI|locale|configured|disabled|enabled|disclosure|provider|budget|model|raw)\b/;

/** Live payload of GET /ai-operations/property/readiness (Rías Altas, 2026-09-16, evidence of qa#3). */
const RIAS_ALTAS: ReadinessCheckLike[] = [
  { key: "enabled", label: "AI enabled", status: "warn", detail: "AI is currently disabled. No AI features will run for this property." },
  { key: "disclosure", label: "Guest-facing disclosure", status: "ok", detail: "A guest-facing AI disclosure is configured." },
  { key: "voice_locales", label: "Voice locales", status: "ok", detail: "2 locale(s) configured: es-ES, en-GB." },
  { key: "automation_level", label: "Automation level", status: "ok", detail: 'Default automation level is "suggest_and_confirm".' }
];
const RIAS_ALTAS_SETTINGS = { voiceLocales: ["es-ES", "en-GB"], automationLevel: "suggest_and_confirm", automationLevelLabel: "Sugerir y confirmar" };

describe("ai-operations-labels · preparación de la IA (qa#3)", () => {
  it("titles every check the API produces today in Spanish", () => {
    assert.deepEqual(
      RIAS_ALTAS.map((check) => readinessCheckLabel(check)),
      ["IA activada", "Aviso de IA al huésped", "Idiomas de voz", "Nivel de automatización"]
    );
  });

  it("renders the live Rías Altas checklist without a word of the API's English", () => {
    const details = RIAS_ALTAS.map((check) => readinessDetail(check, RIAS_ALTAS_SETTINGS));
    assert.deepEqual(details, [
      "La IA está desactivada: no se ejecutará ninguna función de IA en esta propiedad.",
      "Hay un aviso de IA al huésped configurado.",
      "2 idiomas configurados: es-ES, en-GB.",
      "Nivel de automatización por defecto: Sugerir y confirmar."
    ]);
    for (const text of details) assert.doesNotMatch(text, /\b(AI|locale|configured|disabled|enabled|disclosure)\b/);
  });

  it("covers the warning and error variants of every check", () => {
    assert.equal(readinessDetail(check("enabled", "ok")), "La IA está activada para esta propiedad.");
    assert.equal(readinessDetail(check("disclosure", "error")), "No hay aviso de IA al huésped. Informar al huésped de que interviene la IA es un requisito legal.");
    assert.equal(readinessDetail(check("voice_locales", "warn")), "No hay idiomas de voz configurados: la IA de voz no tendría ningún idioma en el que responder.");
    assert.equal(readinessDetail(check("voice_locales", "ok"), { voiceLocales: ["es-ES"] }), "1 idioma configurado: es-ES.");
    assert.equal(readinessDetail(check("voice_locales", "ok")), "Hay idiomas de voz configurados.");
    assert.equal(
      readinessDetail(check("automation_level", "ok"), { automationLevel: "autonomous", approvedBy: "Responsable de prueba" }),
      "Modo autónomo, aprobado por Responsable de prueba."
    );
    assert.equal(
      readinessDetail(check("automation_level", "error"), { automationLevel: "autonomous" }),
      "El modo autónomo está activado sin un responsable de aprobación registrado."
    );
    assert.equal(readinessDetail(check("automation_level", "error"), { automationLevel: "weird" }), "No se reconoce el nivel de automatización configurado.");
    assert.equal(
      readinessDetail(check("automation_level", "error")),
      "El nivel de automatización no está listo: revisa el nivel por defecto y, si es autónomo, el responsable de aprobación."
    );
  });

  it("keeps the API text for checks it does not know", () => {
    const unknown: ReadinessCheckLike = { key: "runtime", label: "Runtime", status: "ok", detail: "Runtime is fine." };
    assert.equal(readinessCheckLabel(unknown), "Runtime");
    assert.equal(readinessDetail(unknown), "Runtime is fine.");
  });
});

describe("ai-operations-labels · estado de las acciones de la IA (qa#11)", () => {
  it("renders the governance «completed» status like «succeeded»", () => {
    assert.equal(callStatusLabel("completed"), "completada");
    assert.equal(callStatusLabel("COMPLETED"), "completada");
    assert.equal(callStatusLabel("succeeded"), "completada");
    assert.equal(callStatusTone("completed"), "success");
    assert.equal(callStatusTone("succeeded"), "success");
    assert.equal(callStatusTone("confirmed"), "success");
  });

  it("keeps the other tones and shows unknown statuses as received", () => {
    assert.equal(callStatusTone("failed"), "danger");
    assert.equal(callStatusTone("rejected"), "danger");
    assert.equal(callStatusTone("awaiting_confirmation"), "warning");
    assert.equal(callStatusLabel("awaiting_confirmation"), "pendiente de confirmar");
    assert.equal(callStatusLabel("stalled"), "stalled");
  });
});

describe("ai-operations-labels · skipped, provider y budget tienen etiqueta y tono (L6b-04)", () => {
  it("«skipped» (respaldo por reglas sin modelo) es «omitida (sin modelo)» en tono neutral, no un aviso", () => {
    assert.equal(callStatusLabel("skipped"), "omitida (sin modelo)");
    assert.equal(callStatusLabel("SKIPPED"), "omitida (sin modelo)");
    assert.equal(callStatusTone("skipped"), "neutral");
    assert.equal(callStatusTone("Skipped"), "neutral");
  });

  it("titles the runtime checks of Tanda L6a in Spanish whatever the API label says", () => {
    assert.equal(readinessCheckLabel({ key: "provider", label: "Model provider" }), "Proveedor de IA");
    assert.equal(readinessCheckLabel({ key: "budget", label: "Monthly budget" }), "Presupuesto de IA");
  });

  it("provider: warn (sin modelo) and error/ok without usable API data speak Spanish", () => {
    const warn = readinessDetail(check("provider", "warn", "Model provider is not configured."));
    assert.equal(warn, "Sin modelo configurado: la IA responde por reglas y las funciones de modelo quedan omitidas.");
    const error = readinessDetail(check("provider", "error"));
    assert.equal(error, "El proveedor de IA no es utilizable: la IA responde por reglas hasta corregir la configuración.");
    const ok = readinessDetail(check("provider", "ok", ""));
    assert.equal(ok, "Proveedor de IA configurado: las funciones de modelo están disponibles.");
    for (const text of [warn, error, ok]) assert.doesNotMatch(text, ENGLISH);
  });

  it("provider: keeps the API sentence only when it carries the model id (ok) or the typed reason (error)", () => {
    const live = "Proveedor anthropic con modelo claude-sonnet-5 (clasificación: claude-haiku-4-5-20251001).";
    assert.equal(readinessDetail(check("provider", "ok", live)), live);
    const reason = "Presupuesto de IA no aplicable: falta el tipo de cambio USD→EUR (AI_USD_EUR_RATE): la IA responde por reglas hasta corregir la configuración.";
    assert.equal(readinessDetail(check("provider", "error", reason)), reason);
    // A warn never keeps the API text, even a Spanish one: the screen owns it.
    assert.equal(readinessDetail(check("provider", "warn", live)), "Sin modelo configurado: la IA responde por reglas y las funciones de modelo quedan omitidas.");
  });

  it("budget: keeps the API amounts when present and otherwise speaks Spanish by status", () => {
    const withAmounts = "Presupuesto mensual: 25,00 € (gastado 3,10 €).";
    assert.equal(readinessDetail(check("budget", "ok", withAmounts)), withAmounts);
    const exceeded = "Presupuesto mensual agotado: 25,00 € (gastado 25,40 €).";
    assert.equal(readinessDetail(check("budget", "error", exceeded)), exceeded);
    assert.equal(readinessDetail(check("budget", "ok")), "Presupuesto mensual de IA dentro del límite.");
    assert.equal(readinessDetail(check("budget", "warn", "Budget almost exhausted.")), "Presupuesto mensual de IA casi agotado: al alcanzarlo la IA dejará de llamar al modelo.");
    assert.equal(readinessDetail(check("budget", "error", "Budget exceeded.")), "Presupuesto mensual de IA agotado: la IA no llama al modelo hasta el mes siguiente.");
    for (const status of ["ok", "warn", "error"] as const) assert.doesNotMatch(readinessDetail(check("budget", status)), ENGLISH);
  });

  it("costLabel: NULL (hubo llamada sin coste calculable) is «—» with its reason; 0 and figures are real euros", () => {
    assert.deepEqual(costLabel(null), { text: "—", title: COST_UNKNOWN_TITLE });
    assert.deepEqual(costLabel(undefined), { text: "—", title: COST_UNKNOWN_TITLE });
    assert.deepEqual(costLabel(Number.NaN), { text: "—", title: COST_UNKNOWN_TITLE });
    assert.equal(COST_UNKNOWN_TITLE, "hubo llamada sin tipo de cambio");
    // Real euros go through lib/format money() (es-ES, non-breaking space before «€»); no title.
    assert.deepEqual(costLabel(0), { text: money(0) });
    assert.deepEqual(costLabel(1.5), { text: money(1.5) });
    assert.match(costLabel(1.5).text, /^1,50\s€$/);
  });

  it("costCallsTotal: the cost dashboard has no callsTotal, it is the sum of byTool[].calls", () => {
    assert.equal(costCallsTotal(undefined), undefined);
    assert.equal(costCallsTotal(null), undefined);
    assert.equal(costCallsTotal({}), undefined);
    assert.equal(costCallsTotal({ byTool: [] }), 0);
    assert.equal(costCallsTotal({ byTool: [{ calls: 3 }, { calls: 4 }, { calls: Number.NaN }] }), 7);
  });

  it("aiUsageStatus: «En uso» only with real calls, «Sin modelo» while provider is not ok, never by aiEnabled alone", () => {
    assert.deepEqual(aiUsageStatus({ aiEnabled: false, providerOk: true, callsTotal: 12 }), { value: "Apagada", caption: "Sin uso", ok: false });
    assert.deepEqual(aiUsageStatus({ aiEnabled: true, providerOk: false, callsTotal: 12 }), { value: "Encendida", caption: "Sin modelo", ok: false });
    assert.deepEqual(aiUsageStatus({ aiEnabled: true, providerOk: true, callsTotal: 0 }), { value: "Encendida", caption: "Sin uso en 30 días", ok: true });
    assert.deepEqual(aiUsageStatus({ aiEnabled: true, providerOk: true, callsTotal: 1, windowDays: 7 }), { value: "Encendida", caption: "En uso · 1 acción en 7 días", ok: true });
    assert.deepEqual(aiUsageStatus({ aiEnabled: true, providerOk: true, callsTotal: 12 }), { value: "Encendida", caption: "En uso · 12 acciones en 30 días", ok: true });
    // Readiness not answered yet: the calls decide; cost not answered: no guess.
    assert.match(aiUsageStatus({ aiEnabled: true, providerOk: undefined, callsTotal: 2 }).caption, /^En uso/);
    assert.deepEqual(aiUsageStatus({ aiEnabled: true, providerOk: true, callsTotal: undefined }), { value: "Encendida", caption: "Uso no disponible", ok: true });
  });
});

describe("aiOperations · contratos de fuente del lote fix:10-B", () => {
  it("AiPipelineStatusScreen paints statuses through the shared labels (qa#11)", () => {
    const source = read("AiPipelineStatusScreen.tsx");
    assert.match(source, /import \{ callStatusLabel, callStatusTone, costLabel \} from "\.\/ai-operations-labels";/);
    assert.doesNotMatch(source, /const CALL_STATUS_LABEL/);
  });

  it("PropertyAiScreen guards «Descartar cambios» with the discard dialog and speaks Spanish in the readiness list (qa#18, qa#3)", () => {
    const source = read("PropertyAiScreen.tsx");
    assert.match(source, /confirmDiscard\(\)/);
    assert.match(source, /open=\{askDiscard\}/);
    assert.match(source, /label: "Descartar cambios", disabled: !dirty \|\| saving, onClick: \(\) => setAskDiscard\(true\)/);
    assert.doesNotMatch(source, /onClick: \(\) => setValues\(saved\)/);
    assert.match(source, /readinessCheckLabel\(check\)/);
    assert.match(source, /readinessDetail\(check, readinessContext\)/);
    assert.doesNotMatch(source, /\{check\.label\}|\{check\.detail\}/);
  });

  it("EmailConnectorsScreen confirms a disconnect in a destructive dialog and never adds a mailbox the server cannot serve (qa#4)", () => {
    const source = read("EmailConnectorsScreen.tsx");
    // Disconnect: only from the dialog's confirm, never straight from the row button.
    assert.equal(source.match(/disconnectEmailConnection\(/g)?.length, 1, "one call site (the dialog confirm)");
    assert.match(source, /async function confirmDisconnect\(\)/);
    assert.match(source, /<CocoaDialog[\s\S]*tone="destructive"[\s\S]*busy=\{busy\}[\s\S]*onConfirm=\{confirmDisconnect\}/);
    assert.doesNotMatch(source, /onClick=\{\(\) => void run\(\(\) => disconnectEmailConnection/);
    // Disconnected rows offer no «Desconectar».
    assert.match(source, /\{c\.status !== "disconnected" \? \(/);
    // A provider the server declares as not configured cannot create a row.
    assert.match(source, /const providerUnavailable = providerInfo \? !providerInfo\.configured : false;/);
    // SEC-03: a shadow-mode mailbox needs the sender domain (the API schema rejects `pms_shadow` without `fromDomain`).
    assert.match(source, /const shadowIncomplete = purpose === "pms_shadow" && fromDomain\.trim\(\) === "";/);
    assert.match(source, /const canAdd = !busy && !providerUnavailable && !imapIncomplete && !shadowIncomplete;/);
    assert.match(source, /if \(!canAdd\) return;/);
    assert.match(source, /\{oauthProvider \? "Iniciar autorización" : "Añadir buzón"\}/);
  });
});

describe("aiOperations · contratos de fuente del lote L6b-04 (front honesto)", () => {
  it("AiOwnerSummaryScreen decides «Estado de la IA» with aiUsageStatus over readiness + real calls, never by aiEnabled alone", () => {
    const source = read("AiOwnerSummaryScreen.tsx");
    assert.match(source, /import \{ aiUsageStatus, costCallsTotal \} from "\.\/ai-operations-labels";/);
    assert.match(source, /useApiData<AiReadiness>\("\/ai-operations\/property\/readiness"/);
    assert.match(source, /check\.key === "provider"/);
    assert.match(source, /aiUsageStatus\(\{ aiEnabled, providerOk, callsTotal, windowDays: cost\.data\?\.windowDays \}\)/);
    assert.match(source, /value: usage\.value,\s*caption: usage\.caption,\s*ok: usage\.ok/);
    assert.doesNotMatch(source, /caption: aiEnabled \? "En uso"/);
    // A null projection (no real cost) is never painted as «0,00 €».
    assert.doesNotMatch(source, /money\(n \?\? 0\)/);
    assert.match(source, /projectedMonthlyEur: number \| null;/);
    assert.match(source, /cost\.data\.projectedMonthlyEur === null \? "sin coste real todavía: no se proyecta"/);
    // Cocoa: 0 inline styles added by the lot (5 token-only text styles pre-existed).
    assert.equal((source.match(/ style=/g) ?? []).length, 5);
  });

  it("AiPipelineStatusScreen paints every cost through costLabel (NULL → «—» with title), never money() on a nullable cost", () => {
    const source = read("AiPipelineStatusScreen.tsx");
    assert.doesNotMatch(source, /money\((r|c|detail|kpis)\.costEur\)|money\(kpis\.costMtdEur\)/);
    assert.match(source, /function costCell\(costEur: number \| null \| undefined\)/);
    assert.match(source, /<span title=\{cost\.title\}>\{cost\.text\}<\/span>/);
    assert.match(source, /render: \(r\) => costCell\(r\.costEur\)/);
    assert.match(source, /render: \(c\) => costCell\(c\.costEur\)/);
    assert.match(source, /<strong>\{costCell\(detail\.costEur\)\}<\/strong>/);
    assert.match(source, /const mtdCost = costLabel\(kpis\?\.costMtdEur\);/);
    assert.match(source, /value=\{mtdCost\.text\} caption=\{mtdCost\.title \?\? "mes natural actual"\}/);
    assert.match(source, /costMtdEur: number \| null;/);
    // Cocoa: 0 inline styles added by the lot (3 overflow clips + 2 codeStyle pre-existed).
    assert.equal((source.match(/ style=/g) ?? []).length, 5);
  });
});
