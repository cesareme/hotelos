// Unit tests · Tanda 6b · L4 — treasury scope predicate (bank account of the
// centre or of the sociedad) and the whole-sociedad read guard (fix:L4
// t6b#15). No database. Run from apps/api with
//   node --import tsx --test src/modules/treasury/__tests__/structure-l4-treasury.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PermissionKey } from "@hotelos/shared";
import { HttpError } from "../../../lib/http-error.js";
import { assertFinanceReadScope, type FinanceScopeContext } from "../../accounting/ledger.routes.js";
import { assertTreasuryEntityScope, bankAccountServesCentre, type TreasuryScopeInput } from "../treasury.service.js";

function ctx(permissions: PermissionKey[], extra: Partial<FinanceScopeContext> = {}): FinanceScopeContext {
  return { permissions, ...extra };
}

describe("assertTreasuryEntityScope · `?scope=entity` answers like every other whole-sociedad finance read (fix:L4 t6b#15)", () => {
  const directorHs = ctx(["banking.read", "accounting.read"], { assignedPropertyIds: ["prop_hs"] });

  it("a centre-bound director without accounting.entity.read → opaque 404 ENTITY_SCOPE_REQUIRED, never a 403 naming the key", () => {
    assert.throws(
      () => assertTreasuryEntityScope(directorHs),
      (error: unknown) => {
        assert.ok(error instanceof HttpError, String(error));
        assert.equal(error.statusCode, 404);
        assert.notEqual(error.statusCode, 403);
        assert.deepEqual(error.details, { code: "ENTITY_SCOPE_REQUIRED", requiredPermission: "accounting.entity.read" });
        assert.doesNotMatch(error.message, /requiere|accounting\.entity\.read/, "the message must not confirm the scope or name the missing key");
        return true;
      }
    );
  });

  it("passes for a holder of accounting.entity.read, a platform admin and an EXPLICIT organisation-wide context; an empty assignment list is refused (Tanda 8a)", () => {
    assert.doesNotThrow(() => assertTreasuryEntityScope(ctx(["accounting.entity.read"], { assignedPropertyIds: ["prop_hs"] })));
    assert.doesNotThrow(() => assertTreasuryEntityScope(ctx(["banking.read"], { assignedPropertyIds: ["prop_hs"], isPlatformAdmin: true })));
    assert.doesNotThrow(() => assertTreasuryEntityScope(ctx(["banking.read", "accounting.read"])), "a context assembled without a list keeps the organisation");
    assert.doesNotThrow(() => assertTreasuryEntityScope(ctx(["banking.read"], { assignedPropertyIds: [], orgScope: true })), "a live organisation / sociedad assignment");
    assert.throws(() => assertTreasuryEntityScope(ctx(["banking.read"], { assignedPropertyIds: [] })), (error: unknown) => error instanceof HttpError && error.statusCode === 404, "no assignments = nothing (H1/H2 closed)");
  });

  it("is the SAME predicate as the ledger / fiscal / statements reads (no treasury-only semantics)", () => {
    for (const context of [directorHs, ctx(["accounting.entity.read"]), ctx([], { isPlatformAdmin: true }), ctx(["banking.read"])]) {
      const shared = (() => {
        try {
          assertFinanceReadScope(context, null);
          return "pass";
        } catch (error) {
          return `${(error as HttpError).statusCode}:${((error as HttpError).details as { code?: string })?.code}`;
        }
      })();
      const treasury = (() => {
        try {
          assertTreasuryEntityScope(context);
          return "pass";
        } catch (error) {
          return `${(error as HttpError).statusCode}:${((error as HttpError).details as { code?: string })?.code}`;
        }
      })();
      assert.equal(treasury, shared);
    }
  });
});

describe("bankAccountServesCentre · the ONE predicate shared by treasury, SEPA and CSB43", () => {
  it("an account attached to the centre serves it; another centre's does not", () => {
    assert.equal(bankAccountServesCentre({ propertyId: "prop_hotel" }, "prop_hotel"), true);
    assert.equal(bankAccountServesCentre({ propertyId: "prop_hotel" }, "prop_office"), false);
  });

  it("an account of the sociedad (no centre) serves every centre", () => {
    assert.equal(bankAccountServesCentre({ propertyId: null }, "prop_hotel"), true);
    assert.equal(bankAccountServesCentre({ propertyId: null }, "prop_office"), true);
  });
});

describe("TreasuryScopeInput · the historical `{ propertyId }` contract still compiles next to the sociedad scope", () => {
  it("accepts both shapes", () => {
    const centre: TreasuryScopeInput = { propertyId: "prop_123", asOf: new Date("2026-09-15T00:00:00Z") };
    const entity: TreasuryScopeInput = { scope: "entity", organizationId: "org_123" };
    assert.equal(centre.scope ?? "property", "property");
    assert.equal(entity.scope, "entity");
  });
});
