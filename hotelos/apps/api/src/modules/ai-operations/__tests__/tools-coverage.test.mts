// Tanda L6a (lote 3): cobertura del catálogo de herramientas. Todo nombre de
// tool-names.ts tiene definición (147/147), toda implementación tiene
// definición con `effect` EXPLÍCITO en registry.ts que coincide con el de la
// implementación, las 12 escrituras son "write" y las 15 lecturas "read", y
// nada que toque dinero/fiscal tiene execute. Sin base de datos ni red.
// From apps/api:
//   node --import tsx --test src/modules/ai-operations/__tests__/tools-coverage.test.mts
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { RISK_MATRIX } from "@hotelos/compliance";
import { ALL_TOOL_NAMES, DOCUMENTS_TOOL_NAMES, TOOL_DEFINITIONS, TOOL_RISK_KEYS, getToolDefinition } from "@hotelos/ai-tools";
import { AI_READ_TOOL_NAMES, AI_TOOL_IMPLEMENTATIONS, AI_WRITE_TOOL_NAMES } from "../tools/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..", "..", "..");
const REGISTRY_SOURCE = readFileSync(join(REPO, "packages", "ai-tools", "src", "registry.ts"), "utf8");
const TOOLS_DIR = join(HERE, "..", "tools");

const EXPECTED_READS = [
  "findReservation",
  "matchGuestToReservation",
  "validateRoomAssignment",
  "quoteAvailability",
  "checkGuestRegisterCompleteness",
  "validateSpainGuestRegister",
  "getHousekeepingBoard",
  "classifyOnboardingFile",
  "analyzeReviewSentiment",
  "classifyIncomingDocument",
  "extractIncomingDocumentFields",
  "extractGuestIdentityFieldsTemporary",
  "draftReviewResponse",
  "answerGuestQuestion",
  // Tanda CHK (W4-D): sugerencia de habitación con motivo (lectura; la pre-asignación autónoma queda desactivada, D4).
  "suggestRoomAssignment"
].sort();

const EXPECTED_WRITES = [
  "assignRoom",
  "checkInReservation",
  "createWorkOrder",
  "blockRoomForMaintenance",
  "resolveWorkOrder",
  "createHousekeepingTask",
  "markRoomClean",
  "markRoomInspected",
  "prepareGuestRegisterRecord",
  "queueSesHospedajesSubmission",
  "sendGuestMessage",
  // Tanda CHK (W4-D): peticiones del bot del huésped (late check-out, toallas…); recepción confirma.
  "createServiceRequest"
].sort();

/** Nombres que tocan dinero o fiscal: SIN execute en la Tanda L6a (honesto: denied tool_not_implemented). */
const MONEY_TOOL_NAMES = [
  "getFolioBalance",
  "postFolioCharge",
  "createPaymentLink",
  "recordPayment",
  "issueInvoice",
  "createRectifyingInvoice",
  "createSupplierBillDraft",
  "extractSupplierBill",
  "suggestAccountingCoding",
  "matchBankTransaction",
  "createJournalEntryDraft",
  "explainFinancialVariance",
  "createCapexProject",
  "createCapexItem",
  "applyRevenueRecommendation",
  "recommendRateChanges",
  "syncChannelRates"
];

/** Módulos de dinero/fiscal que ninguna implementación puede importar. */
const FORBIDDEN_IMPORTS = /modules\/(invoicing|payments|pos|rate-manager|fiscal|folio|accounting|payables|treasury|financial-statements|fixed-assets)\//;

/** Efecto explícito en la fuente del registro para un nombre (advancedTool con 6.º argumento u objeto con `effect:`). */
function explicitEffectInSource(name: string): "read" | "write" | null {
  const call = new RegExp(`advancedTool\\("${name}",[^)]*\\)`).exec(REGISTRY_SOURCE);
  if (call) {
    const match = /,\s*"(read|write)"\s*\)$/.exec(call[0]);
    return match ? (match[1] as "read" | "write") : null;
  }
  const start = REGISTRY_SOURCE.indexOf(`name: "${name}"`);
  if (start === -1) return null;
  const end = REGISTRY_SOURCE.indexOf("\n  }", start);
  const block = REGISTRY_SOURCE.slice(start, end === -1 ? undefined : end);
  const match = /effect: "(read|write)"/.exec(block);
  return match ? (match[1] as "read" | "write") : null;
}

describe("catálogo de herramientas · definiciones", () => {
  it("todo nombre de ALL_TOOL_NAMES tiene definición (147/147: los 5 nombres nuevos de L6a + suggestRoomAssignment de la Tanda CHK) y ninguna definición está fuera del catálogo", () => {
    const defined = new Set(TOOL_DEFINITIONS.map((definition) => definition.name as string));
    const missing = ALL_TOOL_NAMES.filter((name) => !defined.has(name));
    assert.deepEqual(missing, [], `nombres sin definición: ${missing.join(", ")}`);
    assert.equal(ALL_TOOL_NAMES.length, 147);
    assert.equal(TOOL_DEFINITIONS.length, 147);
    assert.equal(new Set(ALL_TOOL_NAMES).size, 147, "sin nombres duplicados");
    const catalog = new Set<string>(ALL_TOOL_NAMES);
    assert.deepEqual(TOOL_DEFINITIONS.filter((definition) => !catalog.has(definition.name)).map((definition) => definition.name), []);
    assert.deepEqual([...DOCUMENTS_TOOL_NAMES], ["classifyIncomingDocument", "extractIncomingDocumentFields"]);
    for (const name of ["parseReservationRequest", "extractPropertyMap", "summarizeComplianceStatus", "classifyIncomingDocument", "extractIncomingDocumentFields"]) {
      assert.equal(getToolDefinition(name as (typeof ALL_TOOL_NAMES)[number]).effect, "read", `${name} es una lectura`);
    }
    assert.equal(getToolDefinition("classifyIncomingDocument").moduleCode, "compliance_hub");
    assert.deepEqual(getToolDefinition("extractIncomingDocumentFields").requiredPermissions, ["ai.tool.execute"]);
  });

  it("toda definición lleva effect y las escrituras exigen confirmación", () => {
    for (const definition of TOOL_DEFINITIONS) {
      assert.ok(definition.effect === "read" || definition.effect === "write", `${definition.name} sin effect`);
      if (definition.effect === "write") assert.equal(definition.requiresConfirmation, true, `${definition.name} es escritura sin requiresConfirmation`);
    }
  });

  it("TOOL_RISK_KEYS apunta solo a nombres del catálogo y a claves existentes de la matriz de riesgo", () => {
    const keys = new Set(RISK_MATRIX.map((entry) => entry.key));
    const catalog = new Set<string>(ALL_TOOL_NAMES);
    for (const [toolName, riskKey] of Object.entries(TOOL_RISK_KEYS)) {
      assert.ok(catalog.has(toolName), `${toolName} no está en el catálogo`);
      assert.ok(riskKey && keys.has(riskKey), `${toolName} → ${riskKey} no existe en risk-matrix.ts`);
    }
    assert.equal(Object.keys(TOOL_RISK_KEYS).length, 20);
  });
});

describe("implementaciones AiTool del API", () => {
  it("toda implementación existe en TOOL_DEFINITIONS con effect EXPLÍCITO en registry.ts igual al de la implementación", () => {
    for (const [name, impl] of Object.entries(AI_TOOL_IMPLEMENTATIONS)) {
      assert.equal(impl.name, name);
      const definition = TOOL_DEFINITIONS.find((candidate) => candidate.name === name);
      assert.ok(definition, `${name} sin definición en el registro`);
      assert.equal(definition.effect, impl.effect, `${name}: effect del registro (${definition.effect}) ≠ implementación (${impl.effect})`);
      assert.equal(explicitEffectInSource(name), impl.effect, `${name}: el effect debe ser explícito en registry.ts`);
      assert.ok(impl.inputSchema && typeof impl.inputSchema.safeParse === "function", `${name} sin inputSchema zod`);
      assert.ok(impl.outputSchema && typeof impl.outputSchema.safeParse === "function", `${name} sin outputSchema zod`);
      assert.equal(typeof impl.execute, "function");
      assert.ok(impl.description.length > 10);
    }
  });

  it("las 12 escrituras tienen effect write (y preview determinista) y las 15 lecturas effect read", () => {
    assert.deepEqual([...AI_WRITE_TOOL_NAMES].sort(), EXPECTED_WRITES);
    assert.deepEqual([...AI_READ_TOOL_NAMES].sort(), EXPECTED_READS);
    assert.equal(Object.keys(AI_TOOL_IMPLEMENTATIONS).length, 27);
    for (const name of EXPECTED_WRITES) {
      assert.equal(typeof AI_TOOL_IMPLEMENTATIONS[name]!.preview, "function", `${name} (escritura) sin preview`);
    }
    // Borradores y clasificaciones son lecturas aunque el registro pida revisión del resultado.
    for (const name of ["draftReviewResponse", "extractGuestIdentityFieldsTemporary", "answerGuestQuestion", "extractIncomingDocumentFields"]) {
      assert.equal(getToolDefinition(name as (typeof ALL_TOOL_NAMES)[number]).requiresConfirmation, true);
      assert.equal(AI_TOOL_IMPLEMENTATIONS[name]!.effect, "read");
    }
  });

  it("ninguna implementación toca dinero/fiscal: lista negra sin execute y sin imports de esos módulos", () => {
    for (const name of MONEY_TOOL_NAMES) {
      assert.equal(AI_TOOL_IMPLEMENTATIONS[name], undefined, `${name} no debe tener execute en la Tanda L6a`);
      assert.ok(TOOL_DEFINITIONS.some((definition) => definition.name === name), `${name} sigue definido en el registro (sin execute)`);
    }
    const files = readdirSync(TOOLS_DIR).filter((file) => file.endsWith(".ts"));
    assert.ok(files.length >= 9, `se esperaban los ficheros de tools/: ${files.join(", ")}`);
    for (const file of files) {
      const source = readFileSync(join(TOOLS_DIR, file), "utf8");
      assert.doesNotMatch(source, FORBIDDEN_IMPORTS, `${file} importa un módulo de dinero/fiscal`);
    }
  });

  it("las entradas se validan con zod: una escritura con entrada inválida no pasa el esquema", () => {
    const assign = AI_TOOL_IMPLEMENTATIONS.assignRoom!;
    assert.equal(assign.inputSchema.safeParse({ reservationId: "res_1", roomId: "room_1" }).success, true);
    assert.equal(assign.inputSchema.safeParse({ reservationId: "res_1" }).success, false);
    assert.equal(assign.inputSchema.safeParse({ reservationId: "res_1", roomId: "room_1", extra: true }).success, false, "esquemas .strict()");
    const quote = AI_TOOL_IMPLEMENTATIONS.quoteAvailability!;
    assert.equal(quote.inputSchema.safeParse({ arrivalDate: "2026-10-01", departureDate: "2026-10-03", adults: 2 }).success, true);
    assert.equal(quote.inputSchema.safeParse({ arrivalDate: "01/10/2026", departureDate: "2026-10-03", adults: 2 }).success, false);
    const find = AI_TOOL_IMPLEMENTATIONS.findReservation!;
    assert.equal(find.inputSchema.safeParse({}).success, false, "findReservation exige reservationId o code");
  });
});
