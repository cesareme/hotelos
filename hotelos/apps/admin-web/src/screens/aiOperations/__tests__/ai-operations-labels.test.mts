import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { callStatusLabel, callStatusTone, readinessCheckLabel, readinessDetail, type ReadinessCheckLike } from "../ai-operations-labels.ts";

// Regression of the fix:10-B lot (Cocoa 22 · ola 10 · lote 10-B): qa#3 (the
// readiness checklist of /configuracion/ia painted the API's English
// label/detail), qa#11 («COMPLETED» badge in warning tone in
// /configuracion/ia/actividad), qa#4 (disconnecting a mailbox without a
// dialog; Gmail rows created while the authorisation is unavailable) and
// qa#18 («Descartar cambios» without a dirty guard).

const SCREENS = fileURLToPath(new URL("../", import.meta.url));
const read = (file: string) => readFileSync(`${SCREENS}${file}`, "utf8");

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
    const check = (key: string, status: ReadinessCheckLike["status"]): ReadinessCheckLike => ({ key, label: key, status, detail: "raw" });
    assert.equal(readinessDetail(check("enabled", "ok")), "La IA está activada para esta propiedad.");
    assert.equal(readinessDetail(check("disclosure", "error")), "No hay aviso de IA al huésped. Informar al huésped de que interviene la IA es un requisito legal.");
    assert.equal(readinessDetail(check("voice_locales", "warn")), "No hay idiomas de voz configurados: la IA de voz no tendría ningún idioma en el que responder.");
    assert.equal(readinessDetail(check("voice_locales", "ok"), { voiceLocales: ["es-ES"] }), "1 idioma configurado: es-ES.");
    assert.equal(readinessDetail(check("voice_locales", "ok")), "Hay idiomas de voz configurados.");
    assert.equal(
      readinessDetail(check("automation_level", "ok"), { automationLevel: "autonomous", approvedBy: "Juana Pérez" }),
      "Modo autónomo, aprobado por Juana Pérez."
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
    const unknown: ReadinessCheckLike = { key: "budget", label: "Monthly budget", status: "ok", detail: "Budget is set." };
    assert.equal(readinessCheckLabel(unknown), "Monthly budget");
    assert.equal(readinessDetail(unknown), "Budget is set.");
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

describe("aiOperations · contratos de fuente del lote fix:10-B", () => {
  it("AiPipelineStatusScreen paints statuses through the shared labels (qa#11)", () => {
    const source = read("AiPipelineStatusScreen.tsx");
    assert.match(source, /import \{ callStatusLabel, callStatusTone \} from "\.\/ai-operations-labels";/);
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
