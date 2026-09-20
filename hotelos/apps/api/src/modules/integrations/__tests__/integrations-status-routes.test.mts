// Corrector L8 (REV-07) · resolveRequestedPropertyId (integrations-status.routes.ts):
// la propiedad pedida por query se toma TAL CUAL (sin recortar): un id con espacios
// es otro id y recibe el 404 opaco del guard de ámbito / grantPropertyAccess; solo
// «presente pero vacío o no textual» es 400 y «ausente» cae a la del contexto.
// Desde apps/api:
//   node --import tsx --test src/modules/integrations/__tests__/integrations-status-routes.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BadRequestError } from "../../../lib/http-error.js";
import { resolveRequestedPropertyId } from "../integrations-status.routes.js";

describe("resolveRequestedPropertyId — propiedad por query o del contexto", () => {
  it("sin propertyId en la query → la propiedad activa del contexto; sin contexto → 400", () => {
    assert.equal(resolveRequestedPropertyId({}, "prop_ctx"), "prop_ctx");
    assert.equal(resolveRequestedPropertyId(undefined, "prop_ctx"), "prop_ctx");
    assert.throws(() => resolveRequestedPropertyId({}, ""), (error: unknown) => error instanceof BadRequestError && /obligatorio/.test((error as Error).message));
  });

  it("presente pero vacío o no textual → 400 (nunca cae en silencio a la del contexto)", () => {
    for (const bad of ["", ["a", "b"], 12, null, {}]) {
      assert.throws(() => resolveRequestedPropertyId({ propertyId: bad }, "prop_ctx"), (error: unknown) => error instanceof BadRequestError && /no vacío/.test((error as Error).message), JSON.stringify(bad));
    }
  });

  it("un id textual se devuelve tal cual: los espacios no se recortan (el guard responde 404 opaco a « prop_x » y a «  »)", () => {
    assert.equal(resolveRequestedPropertyId({ propertyId: "prop_x" }, "prop_ctx"), "prop_x");
    assert.equal(resolveRequestedPropertyId({ propertyId: " prop_x " }, "prop_ctx"), " prop_x ");
    assert.equal(resolveRequestedPropertyId({ propertyId: "  " }, "prop_ctx"), "  ");
  });
});
