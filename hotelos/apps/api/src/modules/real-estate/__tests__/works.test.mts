// Tanda ACT · correcciones de revisión · obras (puro, sin BD):
//   · capitalizationDateFor (ACT-REV-12): fin de obra como fecha de alta del inmovilizado;
//   · CapexCapitalizeSchema: cuerpo opcional { acquisitionDate } con forma AAAA-MM-DD;
//   · CAPEX_WORK_PATCH_STATUSES: el PATCH …/work solo in_progress | completed.
//   node --import tsx --test src/modules/real-estate/__tests__/works.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CAPEX_WORK_PATCH_STATUSES, CapexCapitalizeSchema, capitalizationDateFor } from "../works.service.js";

const TODAY = "2026-09-20";
const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

describe("ACT-REV-12 · fecha de alta del inmovilizado al capitalizar (diseño §6: startDate = fin de obra)", () => {
  it("la del cuerpo manda (nunca posterior a hoy); si no, targetEndDate ya cumplido; si no, hoy", () => {
    assert.equal(capitalizationDateFor({ targetEndDate: day("2026-06-30") }, "2026-07-15", TODAY), "2026-07-15");
    assert.equal(capitalizationDateFor({ targetEndDate: day("2026-06-30") }, "2027-01-01", TODAY), TODAY, "una fecha futura se recorta a hoy");
    assert.equal(capitalizationDateFor({ targetEndDate: day("2026-06-30") }, undefined, TODAY), "2026-06-30", "fin de obra previsto y ya pasado");
    assert.equal(capitalizationDateFor({ targetEndDate: day(TODAY) }, undefined, TODAY), TODAY);
    assert.equal(capitalizationDateFor({ targetEndDate: day("2026-12-31") }, undefined, TODAY), TODAY, "fin previsto aún futuro: hoy");
    assert.equal(capitalizationDateFor({ targetEndDate: null }, undefined, TODAY), TODAY);
  });

  it("CapexCapitalizeSchema: sin cuerpo, {} o { acquisitionDate } válidos; otras claves o formatos, no", () => {
    assert.deepEqual(CapexCapitalizeSchema.parse({}), {});
    assert.deepEqual(CapexCapitalizeSchema.parse({ acquisitionDate: "2026-06-30" }), { acquisitionDate: "2026-06-30" });
    assert.equal(CapexCapitalizeSchema.safeParse({ acquisitionDate: "30/06/2026" }).success, false);
    assert.equal(CapexCapitalizeSchema.safeParse({ acquisitionDate: 20260630 }).success, false);
    assert.equal(CapexCapitalizeSchema.safeParse({ startDate: "2026-06-30" }).success, false, "strict");
  });

  it("PATCH …/work solo admite in_progress | completed (approved va por POST …/approve; cancelled no es una obra)", () => {
    assert.deepEqual([...CAPEX_WORK_PATCH_STATUSES], ["in_progress", "completed"]);
  });
});
