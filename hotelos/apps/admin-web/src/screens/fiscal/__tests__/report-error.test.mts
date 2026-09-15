import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { ACCOUNTING_SETTINGS_CTA, describeReportError } from "../ReportErrorCard.tsx";
import { UI_STATES } from "../../../content/actions.ts";

const API_409 =
  "Falta la cuenta contable 477 (H.P. IVA repercutido) en el plan de cuentas de esta organización: crea o importa el plan contable (PGC) antes de generar el modelo 303.";

// browser-roles#5: the Modelo screens hid the actionable API message behind a
// generic «No hemos podido cargar este informe».
describe("Modelos AEAT · error accionable", () => {
  it("paints the API message and offers the accounting settings when the PGC is missing", () => {
    const info = describeReportError(API_409);
    assert.equal(info.message, API_409);
    assert.equal(info.needsChartOfAccounts, true);
    assert.equal(info.title, "Falta el plan contable");
    assert.match(ACCOUNTING_SETTINGS_CTA, /Contabilidad/);
  });

  it("keeps a generic title for other errors and a generic message for empty ones", () => {
    const other = describeReportError("Propiedad no encontrada.");
    assert.equal(other.needsChartOfAccounts, false);
    assert.equal(other.title, UI_STATES.error.title);
    assert.equal(other.message, "Propiedad no encontrada.");
    const empty = describeReportError("");
    assert.equal(empty.message, "No hemos podido cargar este informe. Inténtalo de nuevo.");
    assert.equal(describeReportError(null).needsChartOfAccounts, false);
  });

  it("is used by the five Modelo screens (303, 111, 115, 180, 390)", () => {
    for (const n of ["303", "111", "115", "180", "390"]) {
      const source = readFileSync(new URL(`../Modelo${n}Screen.tsx`, import.meta.url), "utf8");
      assert.match(source, /<ReportErrorCard message=\{error\} onRetry=\{refresh\} \/>/, `Modelo${n}Screen`);
      assert.doesNotMatch(source, /No hemos podido cargar este informe/, `Modelo${n}Screen keeps the generic copy`);
    }
  });
});
