import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { ACCOUNTING_SETTINGS_CTA, describeReportError } from "../ReportErrorCard.tsx";
import { UI_STATES } from "../../../content/actions.ts";

const API_409 =
  "Falta la cuenta contable 477 (H.P. IVA repercutido) en el plan de cuentas de esta organización: crea o importa el plan contable (PGC) antes de generar el modelo 303.";

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

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

  it("the shared model screen, the VAT books and the settlement paint it with a retry (Cocoa 22 · lote 8-B)", () => {
    for (const file of ["FiscalModelReport.tsx", "VatBooksScreen.tsx", "VatSettlementScreen.tsx"]) {
      const source = read(`../${file}`);
      assert.match(source, /<ReportErrorCard message=\{errorText\} onRetry=\{(?:report|resource)\.refresh\} \/>/, file);
      assert.doesNotMatch(source, />\s*No hemos podido cargar este informe/, `${file} never paints the generic copy as JSX text (it is only the fallback of fiscalErrorText)`);
    }
  });

  it("the six Modelo screens are thin wrappers over FiscalModelScreen with their own code and title", () => {
    for (const n of ["303", "390", "347", "111", "115", "180"]) {
      const source = read(`../Modelo${n}Screen.tsx`);
      assert.match(source, new RegExp(`<FiscalModelScreen modelo="${n}" title="Modelo ${n}"`), `Modelo${n}Screen`);
      assert.doesNotMatch(source, /useApiData|\/accounting\/reports\/modelo-/, `Modelo${n}Screen must not call the legacy report route by itself`);
    }
  });

  it("ReportErrorCard is a Cocoa error state (no raw card, no raw buttons)", () => {
    const source = read("../ReportErrorCard.tsx");
    assert.match(source, /<CocoaState\s+kind="error"/);
    assert.doesNotMatch(source, /bo-card|<button\b/);
  });
});
