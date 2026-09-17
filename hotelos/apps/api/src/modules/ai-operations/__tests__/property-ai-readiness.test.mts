// Cocoa 22 · ola 11 · lote api-datos (qa#3): the AI readiness checklist of a
// property (GET /ai-operations/property/readiness) reads in Spanish at the
// source. Pure core only (buildAiReadinessChecks): no database. Run from apps/api with
//   node --import tsx --test src/modules/ai-operations/__tests__/property-ai-readiness.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AUTOMATION_LEVELS, buildAiReadinessChecks, type PropertyAiSettings } from "../property-ai.service.js";

const ENGLISH = /\b(AI is|enabled|disabled|disclosure|locales|level)\b/;
const KEYS = ["enabled", "disclosure", "voice_locales", "automation_level"];

function settings(overrides: Partial<PropertyAiSettings> = {}): PropertyAiSettings {
  return {
    propertyId: "prop_123",
    aiEnabled: true,
    defaultAutomationLevel: "suggest_and_confirm",
    guestFacingDisclosure: "Parte de la atención puede estar gestionada por un asistente de IA.",
    voiceLocales: ["es-ES", "en-GB"],
    configurationJson: {},
    updatedAt: null,
    isDefault: false,
    ...overrides
  };
}

describe("buildAiReadinessChecks · Spanish labels and details (qa#3)", () => {
  const variants: PropertyAiSettings[] = [
    settings(),
    settings({ aiEnabled: false, guestFacingDisclosure: "   ", voiceLocales: [] }),
    settings({ voiceLocales: ["es-ES"] }),
    settings({ defaultAutomationLevel: "autonomous", configurationJson: { autonomousApprovedBy: "Carmen" } }),
    settings({ defaultAutomationLevel: "autonomous", configurationJson: {} }),
    settings({ defaultAutomationLevel: "autonomous", configurationJson: { autonomousApprovedBy: "  " } }),
    settings({ defaultAutomationLevel: "nonsense" as PropertyAiSettings["defaultAutomationLevel"] }),
    ...AUTOMATION_LEVELS.map((level) => settings({ defaultAutomationLevel: level }))
  ];

  it("always returns the four stable keys in order, with Spanish label and detail", () => {
    for (const variant of variants) {
      const checks = buildAiReadinessChecks(variant);
      assert.deepEqual(checks.map((check) => check.key), KEYS);
      for (const check of checks) {
        assert.doesNotMatch(check.label, ENGLISH, `${check.key} label «${check.label}»`);
        assert.doesNotMatch(check.detail, ENGLISH, `${check.key} detail «${check.detail}»`);
        assert.match(check.detail, /^[A-ZÁÉÍÓÚ0-9].*\.$/, `${check.key} detail «${check.detail}»`);
        assert.ok(["ok", "warn", "error"].includes(check.status));
      }
    }
  });

  it("labels match the product wording", () => {
    const labels = buildAiReadinessChecks(settings()).map((check) => check.label);
    assert.deepEqual(labels, ["IA activada", "Aviso a los huéspedes", "Idiomas de voz", "Nivel de automatización"]);
  });

  it("statuses: switch off warns, missing disclosure errors, no locale warns, unknown level errors", () => {
    const checks = buildAiReadinessChecks(settings({ aiEnabled: false, guestFacingDisclosure: null, voiceLocales: [], defaultAutomationLevel: "x" as PropertyAiSettings["defaultAutomationLevel"] }));
    assert.deepEqual(checks.map((check) => check.status), ["warn", "error", "warn", "error"]);
    assert.equal(checks[0]!.detail, "La IA está desactivada: no se ejecutará ninguna función de IA en esta propiedad.");
    assert.equal(checks[2]!.detail, "No hay idiomas de voz configurados: la IA de voz no tendría ningún idioma en el que responder.");
    assert.equal(checks[3]!.detail, "No se reconoce el nivel de automatización configurado.");
  });

  it("details name the locales and the automation level in Spanish", () => {
    const ok = buildAiReadinessChecks(settings());
    assert.deepEqual(ok.map((check) => check.status), ["ok", "ok", "ok", "ok"]);
    assert.equal(ok[2]!.detail, "2 idiomas configurados: es-ES, en-GB.");
    assert.equal(ok[3]!.detail, "Nivel de automatización por defecto: sugerir y confirmar.");
    assert.equal(buildAiReadinessChecks(settings({ voiceLocales: ["es-ES"] }))[2]!.detail, "1 idioma configurado: es-ES.");
    assert.equal(buildAiReadinessChecks(settings({ defaultAutomationLevel: "off" }))[3]!.detail, "Nivel de automatización por defecto: desactivado.");
  });

  it("autonomous mode needs an approver of record", () => {
    const approved = buildAiReadinessChecks(settings({ defaultAutomationLevel: "autonomous", configurationJson: { autonomousApprovedBy: "Carmen" } }))[3]!;
    assert.equal(approved.status, "ok");
    assert.equal(approved.detail, "Modo autónomo, aprobado por Carmen.");
    const unapproved = buildAiReadinessChecks(settings({ defaultAutomationLevel: "autonomous", configurationJson: { autonomousApprovedBy: " " } }))[3]!;
    assert.equal(unapproved.status, "error");
    assert.equal(unapproved.detail, "El modo autónomo está activado sin un responsable de aprobación registrado.");
  });
});
