// Cocoa 22 · ola 11 · lote api-datos (qa#3): the AI readiness checklist of a
// property (GET /ai-operations/property/readiness) reads in Spanish at the
// source. Pure core only (buildAiReadinessChecks): no database. Tanda L6a
// (lote 4): the checklist gains `provider` (model configured?) and `budget`
// (monthly budget vs month-to-date cost) at the end, fed by an injected runtime.
// Run from apps/api with
//   node --import tsx --test src/modules/ai-operations/__tests__/property-ai-readiness.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AiConfigSummary } from "../../../lib/ai-config.js";
import { AUTOMATION_LEVELS, BUDGET_WARN_RATIO, buildAiReadinessChecks, formatEur, type AiReadinessRuntime, type PropertyAiSettings } from "../property-ai.service.js";

const ENGLISH = /\b(AI is|enabled|disabled|disclosure|locales|level)\b/;
const KEYS = ["enabled", "disclosure", "voice_locales", "automation_level", "provider", "budget"];
const MODELS = { default: "claude-sonnet-5", classify: "claude-haiku-4-5-20251001", insights: "claude-opus-5" } as const;

function provider(overrides: Partial<AiConfigSummary> = {}): AiConfigSummary {
  return { provider: "none", configured: false, reason: "not_configured", models: { ...MODELS }, monthlyBudgetEurDefault: 25, ...overrides };
}

const NOT_CONFIGURED: AiReadinessRuntime = { provider: provider(), mtdCostEur: 0 };
const CONFIGURED: AiReadinessRuntime = { provider: provider({ provider: "anthropic", configured: true, reason: undefined }), mtdCostEur: 0 };

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

function checks(variant: PropertyAiSettings, runtime: AiReadinessRuntime = NOT_CONFIGURED) {
  return buildAiReadinessChecks(variant, runtime);
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
    settings({ configurationJson: { monthlyBudgetEur: 0 } }),
    settings({ configurationJson: { monthlyBudgetEur: "abc" } }),
    ...AUTOMATION_LEVELS.map((level) => settings({ defaultAutomationLevel: level }))
  ];
  const runtimes: AiReadinessRuntime[] = [
    NOT_CONFIGURED,
    CONFIGURED,
    { provider: provider({ reason: "provider_unsupported" }), mtdCostEur: 0 },
    { provider: provider({ reason: "model_forbidden" }), mtdCostEur: 30 },
    { provider: provider(), mtdCostEur: 21 },
    { provider: provider() }
  ];

  it("always returns the six stable keys in order, with Spanish label and detail", () => {
    for (const variant of variants) {
      for (const runtime of runtimes) {
        const result = checks(variant, runtime);
        assert.deepEqual(result.map((check) => check.key), KEYS);
        for (const check of result) {
          assert.doesNotMatch(check.label, ENGLISH, `${check.key} label «${check.label}»`);
          assert.doesNotMatch(check.detail, ENGLISH, `${check.key} detail «${check.detail}»`);
          assert.match(check.detail, /^[A-ZÁÉÍÓÚ0-9].*\.$/, `${check.key} detail «${check.detail}»`);
          assert.ok(["ok", "warn", "error"].includes(check.status));
        }
      }
    }
  });

  it("labels match the product wording", () => {
    const labels = checks(settings()).map((check) => check.label);
    assert.deepEqual(labels, ["IA activada", "Aviso a los huéspedes", "Idiomas de voz", "Nivel de automatización", "Proveedor de IA", "Presupuesto de IA"]);
  });

  it("statuses: switch off warns, missing disclosure errors, no locale warns, unknown level errors; provider warns without key, budget ok", () => {
    const result = checks(settings({ aiEnabled: false, guestFacingDisclosure: null, voiceLocales: [], defaultAutomationLevel: "x" as PropertyAiSettings["defaultAutomationLevel"] }));
    assert.deepEqual(result.map((check) => check.status), ["warn", "error", "warn", "error", "warn", "ok"]);
    assert.equal(result[0]!.detail, "La IA está desactivada: no se ejecutará ninguna función de IA en esta propiedad.");
    assert.equal(result[2]!.detail, "No hay idiomas de voz configurados: la IA de voz no tendría ningún idioma en el que responder.");
    assert.equal(result[3]!.detail, "No se reconoce el nivel de automatización configurado.");
  });

  it("details name the locales and the automation level in Spanish", () => {
    const ok = checks(settings(), CONFIGURED);
    assert.deepEqual(ok.map((check) => check.status), ["ok", "ok", "ok", "ok", "ok", "ok"]);
    assert.equal(ok[2]!.detail, "2 idiomas configurados: es-ES, en-GB.");
    assert.equal(ok[3]!.detail, "Nivel de automatización por defecto: sugerir y confirmar.");
    assert.equal(checks(settings({ voiceLocales: ["es-ES"] }))[2]!.detail, "1 idioma configurado: es-ES.");
    assert.equal(checks(settings({ defaultAutomationLevel: "off" }))[3]!.detail, "Nivel de automatización por defecto: desactivado.");
  });

  it("autonomous mode needs an approver of record", () => {
    const approved = checks(settings({ defaultAutomationLevel: "autonomous", configurationJson: { autonomousApprovedBy: "Carmen" } }))[3]!;
    assert.equal(approved.status, "ok");
    assert.equal(approved.detail, "Modo autónomo, aprobado por Carmen.");
    const unapproved = checks(settings({ defaultAutomationLevel: "autonomous", configurationJson: { autonomousApprovedBy: " " } }))[3]!;
    assert.equal(unapproved.status, "error");
    assert.equal(unapproved.detail, "El modo autónomo está activado sin un responsable de aprobación registrado.");
  });
});

describe("buildAiReadinessChecks · provider and budget (Tanda L6a)", () => {
  it("provider: warn without key (rules), ok with anthropic and the decided models, error for unsupported provider or forbidden model", () => {
    const warn = checks(settings(), NOT_CONFIGURED)[4]!;
    assert.equal(warn.status, "warn");
    assert.equal(warn.detail, "Sin modelo configurado: la IA responde por reglas y las funciones de modelo quedan omitidas.");

    const ok = checks(settings(), CONFIGURED)[4]!;
    assert.equal(ok.status, "ok");
    assert.equal(ok.detail, "Proveedor anthropic con modelo claude-sonnet-5 (clasificación: claude-haiku-4-5-20251001).");

    const unsupported = checks(settings(), { provider: provider({ reason: "provider_unsupported" }), mtdCostEur: 0 })[4]!;
    assert.equal(unsupported.status, "error");
    assert.equal(unsupported.detail, "Proveedor de IA no soportado: la IA responde por reglas hasta corregir la configuración.");

    const forbidden = checks(settings(), { provider: provider({ reason: "model_forbidden" }), mtdCostEur: 0 })[4]!;
    assert.equal(forbidden.status, "error");
    assert.equal(forbidden.detail, "Modelo no permitido por la política de retención: la IA responde por reglas hasta corregir la configuración.");
  });

  it("budget: ok below 80 %, warn from 80 %, error when exhausted; configurationJson.monthlyBudgetEur overrides the default; 0 = no spend allowed", () => {
    const ok = checks(settings(), { provider: provider(), mtdCostEur: 4.5 })[5]!;
    assert.equal(ok.status, "ok");
    assert.equal(ok.detail, "Presupuesto mensual: 25,00 € (gastado 4,50 €).");

    const warn = checks(settings(), { provider: provider(), mtdCostEur: 25 * BUDGET_WARN_RATIO })[5]!;
    assert.equal(warn.status, "warn");
    assert.equal(warn.detail, "Presupuesto mensual casi agotado: 25,00 € (gastado 20,00 €).");

    const error = checks(settings(), { provider: provider(), mtdCostEur: 25 })[5]!;
    assert.equal(error.status, "error");
    assert.equal(error.detail, "Presupuesto mensual agotado: 25,00 € (gastado 25,00 €).");

    const custom = checks(settings({ configurationJson: { monthlyBudgetEur: 100 } }), { provider: provider(), mtdCostEur: 30 })[5]!;
    assert.equal(custom.status, "ok");
    assert.equal(custom.detail, "Presupuesto mensual: 100,00 € (gastado 30,00 €).");

    const zero = checks(settings({ configurationJson: { monthlyBudgetEur: 0 } }), { provider: provider(), mtdCostEur: 0 })[5]!;
    assert.equal(zero.status, "error");
    assert.equal(zero.detail, "Presupuesto mensual agotado: 0,00 € (gastado 0,00 €).");

    const unknownSpend = checks(settings(), { provider: provider() })[5]!;
    assert.equal(unknownSpend.status, "ok");
    assert.equal(unknownSpend.detail, "Presupuesto mensual: 25,00 € (gasto del mes no calculado).");
    assert.equal(formatEur(1234.5), "1234,50 €");
  });
});
