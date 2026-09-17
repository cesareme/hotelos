import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { SOURCE_TYPE_LABELS, SOURCE_TYPE_OPTIONS, sourceTypeLabel } from "../accounting-ui.ts";

// Tanda 7c · L4 (design docs/design/FINANZAS-IMPORTACION-SAGE200.md §10.3,
// hueco 8): nothing pinned the catalogue JOURNAL_SOURCE_TYPES of
// packages/shared/src/accounting-types.ts against the Spanish labels the
// diario and the mayor paint (SOURCE_TYPE_LABELS of accounting-ui.ts), so a
// source type added to the catalogue (payroll_cost_import in 6c,
// pms_shadow_revenue in 7b, sage200_journal / sage200_balance in 7c) could
// reach the screens as a raw code. The catalogue is read from the shared
// SOURCE (under node --import tsx the `.js` stubs of @hotelos/shared win over
// the sources, so a runtime import would come back undefined); the labels are
// imported from the pure module.

const shared = readFileSync(new URL("../../../../../../packages/shared/src/accounting-types.ts", import.meta.url), "utf8");

/** Values of JOURNAL_SOURCE_TYPES (doc comments between the entries stripped). */
function journalSourceTypes(): string[] {
  const block = /export const JOURNAL_SOURCE_TYPES = \[([\s\S]*?)\] as const;/.exec(shared);
  assert.ok(block, "JOURNAL_SOURCE_TYPES not found in packages/shared/src/accounting-types.ts");
  const code = block[1].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  return [...code.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
}

/**
 * Labels for source types the API writes but the shared catalogue does not
 * list yet (`fixed_asset_disposal`: apps/api/src/modules/fixed-assets/
 * fixed-assets.service.ts writes it). Adding the value to JOURNAL_SOURCE_TYPES
 * removes it from here; the list can only shrink.
 */
const LABELS_OUTSIDE_CATALOGUE = ["fixed_asset_disposal"];

describe("Contabilidad · SOURCE_TYPE_LABELS ↔ JOURNAL_SOURCE_TYPES (Tanda 7c · hueco 8)", () => {
  const types = journalSourceTypes();

  it("reads a non-trivial catalogue from the shared source", () => {
    assert.ok(types.length >= 28, `expected at least 28 source types, parsed ${types.length}`);
    assert.equal(new Set(types).size, types.length, "duplicate value in JOURNAL_SOURCE_TYPES");
  });

  it("carries one Spanish label per catalogue value (never a raw code with underscores)", () => {
    const missing = types.filter((type) => !SOURCE_TYPE_LABELS[type]);
    assert.deepEqual(missing, [], `source types without a label in SOURCE_TYPE_LABELS: ${missing.join(", ")}`);
    for (const type of types) {
      const label = SOURCE_TYPE_LABELS[type];
      assert.match(label, /^[A-ZÁÉÍÓÚÑ]/, `${type}: the label starts with a capital letter (${label})`);
      assert.doesNotMatch(label, /_/, `${type}: the label is not a raw code (${label})`);
      assert.equal(sourceTypeLabel(type), label);
    }
  });

  it("labels the Tanda 7b / 7c source types (pms_shadow_revenue · sage200_journal · sage200_balance)", () => {
    assert.equal(SOURCE_TYPE_LABELS.pms_shadow_revenue, "Ingresos diarios de OPERA");
    assert.equal(SOURCE_TYPE_LABELS.sage200_journal, "Diario importado de Sage 200");
    assert.equal(SOURCE_TYPE_LABELS.sage200_balance, "Saldos importados de Sage 200");
    for (const type of ["pms_shadow_revenue", "sage200_journal", "sage200_balance"]) assert.ok(types.includes(type), `${type} in JOURNAL_SOURCE_TYPES`);
  });

  it("labels nothing outside the catalogue except the justified list (which can only shrink)", () => {
    const extra = Object.keys(SOURCE_TYPE_LABELS).filter((key) => !types.includes(key));
    assert.deepEqual(extra.sort(), [...LABELS_OUTSIDE_CATALOGUE].sort(), "a label for a source type the catalogue does not list: add the value to JOURNAL_SOURCE_TYPES or justify it here");
    for (const key of LABELS_OUTSIDE_CATALOGUE) assert.ok(SOURCE_TYPE_LABELS[key], `${key} still labelled`);
  });

  it("the diario filter offers every label once, in the order of the record", () => {
    assert.deepEqual(
      SOURCE_TYPE_OPTIONS.map((option) => option.value),
      Object.keys(SOURCE_TYPE_LABELS)
    );
    for (const option of SOURCE_TYPE_OPTIONS) assert.equal(option.label, SOURCE_TYPE_LABELS[option.value]);
  });

  it("an unknown code degrades to a readable text instead of throwing", () => {
    assert.equal(sourceTypeLabel("some_future_type"), "some future type");
    assert.equal(sourceTypeLabel(null), "—");
  });
});
