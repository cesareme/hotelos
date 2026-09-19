// Tanda UX-1 · corrector L-02: una llegada anterior a hoy no se crea sin
// confirmación explícita (400 PAST_ARRIVAL_DATE). Pura (isPastArrival) más el
// contrato de fuente: la ruta solo honra `allowPastArrival` con el permiso
// pms.reservation.modify y el importador (que ya valida fila a fila) opta fuera.
//
//   node --import tsx --test src/modules/pms/__tests__/reservation-past-arrival.test.mts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { isPastArrival } from "../pms.service.js";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("createReservation · llegada pasada (L-02)", () => {
  it("isPastArrival compara solo la fecha (YYYY-MM-DD) y tolera horas", () => {
    assert.equal(isPastArrival("2026-03-10", "2026-09-19"), true);
    assert.equal(isPastArrival("2026-09-18", "2026-09-19"), true);
    assert.equal(isPastArrival("2026-09-19", "2026-09-19"), false);
    assert.equal(isPastArrival("2026-09-20", "2026-09-19"), false);
    assert.equal(isPastArrival("2026-09-19T15:00:00.000Z", "2026-09-19"), false);
  });

  it("el servicio rechaza con PAST_ARRIVAL_DATE salvo historical o allowPastArrival; la ruta exige pms.reservation.modify; el importador opta fuera", () => {
    const service = read("../pms.service.ts");
    assert.match(service, /if \(!input\.historical && !input\.allowPastArrival\) \{[\s\S]*?isPastArrival\(input\.arrivalDate, localToday\)[\s\S]*?code: "PAST_ARRIVAL_DATE"/);
    const server = read("../../../server.ts");
    assert.match(server, /allowPastArrival: body\.allowPastArrival === true && request\.userContext\.permissions\.includes\("pms\.reservation\.modify"\)/);
    const schema = read("../../../schemas/reservations.schemas.ts");
    assert.match(schema, /allowPastArrival: z\.boolean\(\)\.optional\(\)/);
    const importer = read("../reservation-import.service.ts");
    assert.match(importer, /allowPastArrival: true,/);
  });
});
