// Tanda 5 (L1c · api): enabling a module whose dependencies are not active,
// or disabling an essential one, is a 409 with a Spanish message that names
// the modules — never a 200 with `status: "rejected"` (the front announced
// «activado» on any 2xx). Pure builders, no database. Run from apps/api with
//   node --import tsx --test src/modules/product-modules/__tests__/module-conflicts.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getHotelModuleManifest } from "@hotelos/product";
import { coreModuleConflict, moduleDependenciesConflict } from "../product-modules.service.js";
import { ConflictError } from "../../../lib/http-error.js";

describe("product modules · dependency and core-module conflicts are 409 in Spanish", () => {
  it("names the module and the missing dependencies with their Spanish names and exposes the codes in details", () => {
    const error = moduleDependenciesConflict("reputation_quality", ["ai_concierge"]);
    assert.ok(error instanceof ConflictError);
    assert.equal(error.statusCode, 409);
    assert.equal(
      error.message,
      `No se puede activar ${getHotelModuleManifest("reputation_quality").name}: falta activar ${getHotelModuleManifest("ai_concierge").name}.`
    );
    assert.match(error.message, /Reputación y calidad/);
    assert.match(error.message, /Conserje con IA/);
    assert.deepEqual(error.details, {
      code: "MODULE_DEPENDENCIES_MISSING",
      moduleCode: "reputation_quality",
      missingDependencies: ["ai_concierge"],
      missingDependencyNames: [getHotelModuleManifest("ai_concierge").name]
    });
  });

  it("lists several missing dependencies separated by commas", () => {
    const error = moduleDependenciesConflict("reputation_quality", ["guest_experience", "ai_concierge"]);
    assert.match(error.message, /falta activar Experiencia del huésped, Conserje con IA\./);
    assert.deepEqual((error.details as { missingDependencies: string[] }).missingDependencies, ["guest_experience", "ai_concierge"]);
  });

  it("refuses to disable an essential module with a 409 and the CORE_MODULE code", () => {
    const error = coreModuleConflict("pms_core");
    assert.equal(error.statusCode, 409);
    assert.equal(error.message, `No se puede desactivar ${getHotelModuleManifest("pms_core").name}: es un módulo esencial.`);
    assert.deepEqual(error.details, { code: "CORE_MODULE", moduleCode: "pms_core" });
  });
});
