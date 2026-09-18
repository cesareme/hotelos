// Tanda 5 (L1c · api): property scope inside the organization. A user with
// property roles (user_property_roles) only reaches those properties; a
// context without assignments (demo fallback, contexts assembled elsewhere)
// keeps the organization-wide scope, and platform admins are exempt in the
// callers. Pure predicate, no database. Run from apps/api with
//   node --import tsx --test src/lib/__tests__/tenancy-property-scope.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPropertyAssigned } from "../tenancy.js";

const TILOS = "cmu1mifcp0000fyo1wzvq7txo";
const RIAS_ALTAS = "cmrhw9jy40003fyvbuu2ec2w7";

describe("isPropertyAssigned · property scope of a user context", () => {
  it("a role in the property grants it; a sister property of the same organization does not", () => {
    const reception = { assignedPropertyIds: [TILOS] };
    assert.equal(isPropertyAssigned(reception, TILOS), true);
    assert.equal(isPropertyAssigned(reception, RIAS_ALTAS), false);
  });

  it("an owner assigned to every property of the group reaches all of them", () => {
    const owner = { assignedPropertyIds: [RIAS_ALTAS, TILOS] };
    assert.equal(isPropertyAssigned(owner, TILOS), true);
    assert.equal(isPropertyAssigned(owner, RIAS_ALTAS), true);
  });

  it("a real session with an EMPTY assignment list reaches nothing (Tanda 8a); a context with no list at all keeps the organization unless it says orgScope: false", () => {
    assert.equal(isPropertyAssigned({ assignedPropertyIds: [] }, RIAS_ALTAS), false);
    assert.equal(isPropertyAssigned({ assignedPropertyIds: [], orgScope: false }, RIAS_ALTAS), false);
    assert.equal(isPropertyAssigned({}, TILOS), true, "contexts assembled outside loadUserContext (jobs, scripts) keep the organization");
    assert.equal(isPropertyAssigned({ assignedPropertyIds: undefined }, RIAS_ALTAS), true);
    assert.equal(isPropertyAssigned({ assignedPropertyIds: undefined, orgScope: false }, RIAS_ALTAS), false);
  });

  it("orgScope true (live organization / legal_entity assignment, or the demo fallback) covers every property", () => {
    assert.equal(isPropertyAssigned({ orgScope: true }, TILOS), true);
    assert.equal(isPropertyAssigned({ assignedPropertyIds: [], orgScope: true }, RIAS_ALTAS), true);
    assert.equal(isPropertyAssigned({ assignedPropertyIds: [TILOS], orgScope: true }, RIAS_ALTAS), true);
    assert.equal(isPropertyAssigned({ assignedPropertyIds: [TILOS], orgScope: false }, RIAS_ALTAS), false);
  });
});
