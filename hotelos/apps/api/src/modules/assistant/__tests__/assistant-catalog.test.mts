// Catálogo unificado del asistente (Tanda L6b · L6b-02): 12 locales + 10 del copiloto + 15
// lecturas del registro, filtrado por permisos RBAC y superficie. Sin BD: solo se construye el
// catálogo (importa Prisma sin conectar, como tools-coverage.test.mts).
// Run: cd apps/api && node --import tsx --test src/modules/assistant/__tests__/assistant-catalog.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getToolDefinition } from "@hotelos/ai-tools";
import { PERMISSIONS, ROLE_PERMISSION_MAP, type PermissionKey } from "@hotelos/shared";
import { AI_READ_TOOL_NAMES } from "../../ai-operations/tools/index.js";
import { COPILOT_PRESET_QUESTIONS, COPILOT_RESOLVERS, INTENT_KEYWORDS } from "../../copilot/copilot.service.js";
import { ASSISTANT_CATALOG, ASSISTANT_SURFACES, catalogFor, copilotToolName, getAssistantTool, toModelTools } from "../assistant-catalog.js";
import { ASSISTANT_TOOLS } from "../assistant.tools.js";

const names = (tools: readonly { name: string }[]) => tools.map((tool) => tool.name).sort();
const ofOrigin = (tools: readonly { origin: string }[], origin: string) => tools.filter((tool) => tool.origin === origin);

const HOUSEKEEPING_TOOLS = ["get_housekeeping_status", "get_rooms_ready_for_delivery", "copilot_rooms_ready_for_delivery", "copilot_overdue_hk_tasks", "copilot_arrivals_no_clean_room", "copilot_rooms_blocked"];

describe("assistant-catalog · composición", () => {
  it("une 12 locales + 10 del copiloto + 15 lecturas del registro (37) con nombres únicos", () => {
    assert.equal(ASSISTANT_CATALOG.length, 37);
    assert.equal(ofOrigin(ASSISTANT_CATALOG, "assistant").length, 12);
    assert.equal(ofOrigin(ASSISTANT_CATALOG, "copilot").length, 10);
    assert.equal(ofOrigin(ASSISTANT_CATALOG, "registry").length, 15);
    assert.equal(new Set(ASSISTANT_CATALOG.map((tool) => tool.name)).size, ASSISTANT_CATALOG.length);
    assert.deepEqual(names(ofOrigin(ASSISTANT_CATALOG, "assistant")), names(ASSISTANT_TOOLS));
    assert.deepEqual(names(ofOrigin(ASSISTANT_CATALOG, "registry")), [...AI_READ_TOOL_NAMES].sort());
    assert.equal(getAssistantTool("get_arrivals_today")?.origin, "assistant");
    assert.equal(getAssistantTool("no_existe"), null);
  });

  it("las locales (assistant y copiloto) tienen run y kind local; las del registro no tienen run y heredan permisos y descripción de su definición", () => {
    for (const tool of ASSISTANT_CATALOG) {
      if (tool.origin === "registry") {
        assert.equal(tool.kind, "registry", tool.name);
        assert.equal(tool.run, undefined, `${tool.name}: el runner (runAiTool) la ejecuta, no el catálogo`);
        assert.equal(tool.registryName, tool.name);
        assert.deepEqual(tool.requiredPermissions, getToolDefinition(tool.registryName!).requiredPermissions, tool.name);
        assert.ok(tool.requiredPermissions.includes("ai.tool.execute"), `${tool.name}: toda lectura del registro exige ai.tool.execute`);
      } else {
        assert.equal(tool.kind, "local", tool.name);
        assert.equal(typeof tool.run, "function", tool.name);
        assert.ok(!tool.requiredPermissions.includes("ai.tool.execute"), `${tool.name}: una lectura local no pasa por el runner`);
      }
      assert.ok(tool.description.length > 10, `${tool.name}: sin descripción`);
      assert.ok(tool.surfaces.length >= 1, `${tool.name}: sin superficie`);
      assert.ok(tool.surfaces.every((surface) => ASSISTANT_SURFACES.includes(surface)), tool.name);
      assert.equal(tool.modelInputSchema.type, "object", `${tool.name}: modelInputSchema de objeto`);
      assert.ok(tool.requiredPermissions.length >= 1, `${tool.name}: toda herramienta exige al menos un permiso`);
      assert.ok(tool.keywords.length >= 1, `${tool.name}: sin keywords no la alcanza el router por reglas`);
    }
  });

  it("las 10 del copiloto envuelven COPILOT_RESOLVERS: copilot_<intent>, keywords ⊇ INTENT_KEYWORDS y un preset por intención", () => {
    const intents = Object.keys(COPILOT_RESOLVERS).sort();
    assert.equal(intents.length, 10);
    assert.deepEqual(names(ofOrigin(ASSISTANT_CATALOG, "copilot")), intents.map((intent) => `copilot_${intent}`).sort());
    for (const tool of ofOrigin(ASSISTANT_CATALOG, "copilot")) {
      assert.ok(tool.intent, tool.name);
      assert.equal(tool.name, copilotToolName(tool.intent!));
      for (const keyword of INTENT_KEYWORDS[tool.intent!]) assert.ok(tool.keywords.includes(keyword), `${tool.name}: falta la keyword del copiloto «${keyword}»`);
      assert.ok(COPILOT_PRESET_QUESTIONS.some((preset) => preset.id === tool.intent), `${tool.name}: sin preset`);
    }
  });

  it("ninguna keyword es un solo token genérico («hoy», «ahora», «hotel»…)", () => {
    const generic = new Set(["hoy", "ahora", "hotel", "hay", "tengo", "cuantas", "cuantos", "que", "el", "la", "de", "en", "reserva", "habitacion", "habitaciones"]);
    for (const tool of ASSISTANT_CATALOG) {
      for (const keyword of tool.keywords) {
        const tokens = keyword.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/\s+/).filter(Boolean);
        assert.ok(tokens.length >= 1, `${tool.name}: keyword vacía`);
        if (tokens.length === 1) assert.ok(!generic.has(tokens[0]!), `${tool.name}: keyword genérica «${keyword}»`);
      }
    }
  });

  it("toModelTools expone nombre, descripción e input_schema (tools de ai-core)", () => {
    const model = toModelTools(ASSISTANT_CATALOG.slice(0, 2));
    assert.deepEqual(Object.keys(model[0]!).sort(), ["description", "input_schema", "name"]);
    assert.equal(model[0]!.input_schema.type, "object");
  });
});

describe("assistant-catalog · catalogFor", () => {
  it("catalogFor filtra por permisos y superficie", () => {
    assert.deepEqual(catalogFor({ permissions: [], surface: "backoffice" }), []);
    const onlyReservations = catalogFor({ permissions: ["pms.reservation.read"], surface: "backoffice" });
    assert.deepEqual(names(onlyReservations), ["copilot_late_checkouts", "copilot_reservations_at_risk", "get_arrivals_today", "get_arrivals_without_room", "get_departures_today", "get_in_house_guests", "get_incomplete_precheckins", "get_occupancy_today", "get_pickup_7d"]);
    // Dos claves necesarias: con una sola no aparece; con las dos, sí.
    assert.ok(!names(onlyReservations).includes("copilot_arrivals_pending_balance"));
    assert.ok(names(catalogFor({ permissions: ["pms.reservation.read", "folio.read"], surface: "reception" })).includes("copilot_arrivals_pending_balance"));
    // Superficie: el huésped solo ve lecturas del registro pensadas para el bot; nada local.
    const guest = catalogFor({ permissions: ROLE_PERMISSION_MAP.receptionist, surface: "guest" });
    assert.deepEqual(names(guest), ["answerGuestQuestion", "findReservation", "matchGuestToReservation", "quoteAvailability"]);
    assert.ok(guest.every((tool) => tool.origin === "registry"));
    for (const surface of ASSISTANT_SURFACES) {
      const granted = new Set<PermissionKey>(ROLE_PERMISSION_MAP.owner);
      for (const tool of catalogFor({ permissions: ROLE_PERMISSION_MAP.owner, surface })) {
        assert.ok(tool.surfaces.includes(surface), `${tool.name} no es de ${surface}`);
        assert.ok(tool.requiredPermissions.every((permission) => granted.has(permission)), `${tool.name} sin permiso`);
      }
    }
  });

  it("recepción de la plantilla ve las 12+10 y contable no ve pisos", () => {
    const reception = catalogFor({ permissions: ROLE_PERMISSION_MAP.receptionist, surface: "reception" });
    assert.deepEqual(names(ofOrigin(reception, "assistant")), names(ASSISTANT_TOOLS), "recepción ve las 12 locales");
    assert.equal(ofOrigin(reception, "copilot").length, 10, "recepción ve los 10 intents del copiloto");
    assert.ok(ofOrigin(reception, "registry").length >= 1, "recepción tiene ai.tool.execute: ve lecturas del registro");

    const accountant = catalogFor({ permissions: ROLE_PERMISSION_MAP.accountant, surface: "backoffice" });
    assert.ok(!ROLE_PERMISSION_MAP.accountant.includes("housekeeping.read"), "la plantilla contable no tiene housekeeping.read");
    for (const name of HOUSEKEEPING_TOOLS) assert.ok(!names(accountant).includes(name), `contable no debería ver ${name}`);
    assert.ok(accountant.every((tool) => !tool.requiredPermissions.includes("housekeeping.read")));
    assert.ok(names(accountant).includes("get_open_balance"), "contable sí ve el saldo pendiente");
    assert.ok(names(accountant).includes("get_compliance_summary"));
    assert.equal(ofOrigin(accountant, "assistant").length, 9);
  });

  it("toda clave existe en PERMISSION_KEYS (PERMISSIONS de @hotelos/shared)", () => {
    const known = new Set(Object.keys(PERMISSIONS));
    for (const tool of ASSISTANT_CATALOG) {
      for (const permission of tool.requiredPermissions) assert.ok(known.has(permission), `${tool.name}: la clave «${permission}» no existe en PERMISSIONS`);
    }
  });
});
