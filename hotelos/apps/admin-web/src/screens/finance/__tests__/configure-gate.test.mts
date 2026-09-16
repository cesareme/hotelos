import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// qa#1 (Tanda 6 · Finanzas · lote 6-F): Cuentas anuales and USALI gate their
// write actions (snapshots, USALI mapping rules) on `accounting.configure`.
// The gate must read the real grants of the active property through
// `canDo(useNavGate(), …)` (screens/accounting/accounting-ui.ts), like 6-C and
// 6-D do — never `getUser()?.permissions`, which auth-storage.ts documents as
// the demo union of the login payload and «never a role source» (an Owner such
// as Carmen saw «Guardar instantánea», «Nueva regla» and every «Asignar»
// disabled). accounting-ui.ts cannot load under node --test (it reaches
// api-client.ts and import.meta.env), so the recipe is pinned on the source.
const SCREENS = ["AnnualAccountsScreen.tsx", "UsaliScreen.tsx"] as const;
const source = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

describe("Finanzas · gate of accounting.configure in Cuentas anuales and USALI", () => {
  for (const name of SCREENS) {
    describe(name, () => {
      const src = source(name);

      it("decides with the real grants of the active property (canDo over useNavGate)", () => {
        assert.match(src, /import \{ useNavGate \} from "\.\.\/\.\.\/navigation\/useEnabledModules";/);
        assert.match(src, /import \{ canDo \} from "\.\.\/accounting\/accounting-ui";/);
        assert.match(src, /const configurable = canDo\(useNavGate\(\), "accounting\.configure"\);/);
      });

      it("never reads the demo union of the login payload", () => {
        assert.doesNotMatch(src, /auth-storage/, "auth-storage.ts is not a role source for a screen");
        assert.doesNotMatch(src, /getUser\(/);
        assert.doesNotMatch(src, /\?\.permissions/);
      });

      it("keeps the denied branch: disabled controls and the Spanish reason in the section footer", () => {
        assert.match(src, /disabled=\{!configurable\}/);
        assert.match(src, /Necesitas el permiso de configuración contable para /);
        // The gate is a plain boolean now (unknown grants → enabled, the API answers 403): no tri-state left.
        assert.doesNotMatch(src, /configurable === (false|null)/);
        assert.doesNotMatch(src, /configurable: boolean \| null/);
      });
    });
  }
});
