// Unit tests · Tanda UX-2 · corrector UX2-REV-01 (F-D1 «una verdad por dato») —
// la Cartera (portfolio.service.ts) y el detalle de la propiedad
// (property-overview.service.ts) resuelven su ventana «hoy» con el MISMO lector
// (`readGmBusinessDate`) y la MISMA función pura (`resolveGmWindow`) que Mi día ›
// Dirección (general-manager.service.ts): la fecha de negocio de la propiedad y,
// sin fila, el día natural UTC. Ambas respuestas exponen `businessDate` +
// `businessDateSource` (aditivos) para que la pantalla diga su ventana. Contrato
// sobre el fuente (sin base de datos) + la función pura compartida. Desde apps/api:
//   node --import tsx --test src/modules/dashboards/__tests__/dashboards-business-date-window.test.mts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { resolveGmWindow } from "../general-manager.service.js";

const PORTFOLIO = readFileSync(new URL("../portfolio.service.ts", import.meta.url), "utf8");
const OVERVIEW = readFileSync(new URL("../property-overview.service.ts", import.meta.url), "utf8");
const GM = readFileSync(new URL("../general-manager.service.ts", import.meta.url), "utf8");

const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

describe("una verdad por dato · la misma ventana en los tres servicios de dirección", () => {
  it("los tres importan el lector y la función pura del panel del director (una sola definición)", () => {
    const importLine = /import \{ readGmBusinessDate, resolveGmWindow, type GmBusinessDateSource(?:, type GmWindow)? \} from "\.\/general-manager\.service\.js";/;
    assert.match(PORTFOLIO, importLine, "portfolio.service.ts importa el lector de general-manager.service.ts");
    assert.match(OVERVIEW, importLine, "property-overview.service.ts importa el lector de general-manager.service.ts");
    assert.match(GM, /export function resolveGmWindow\(/);
    assert.match(GM, /export async function readGmBusinessDate\(/);
    // Ninguno de los dos vuelve a definir su propia medianoche UTC para «hoy».
    for (const [name, source] of [["portfolio", PORTFOLIO], ["property-overview", OVERVIEW]] as const) {
      const code = stripComments(source);
      assert.doesNotMatch(code, /function endOfUtcDay\(/, `${name}: sin endOfUtcDay propio`);
      assert.doesNotMatch(code, /const dayStart = startOfUtcDay\(asOfDate\);\s*const dayEnd = endOfUtcDay\(dayStart\);/, `${name}: la ventana ya no es el día UTC del reloj`);
    }
  });

  it("property-overview: ventana = resolveGmWindow(readGmBusinessDate(propertyId)); el mes cuelga de ella; la respuesta dice su ventana", () => {
    const code = stripComments(OVERVIEW);
    assert.match(code, /const window = resolveGmWindow\(\{ businessDate: await readGmBusinessDate\(propertyId\), now: asOfDate \}\);/);
    assert.match(code, /const dayStart = window\.today;\s*const dayEnd = window\.tomorrow;\s*const monthStart = startOfUtcMonth\(dayStart\);/);
    assert.match(code, /businessDate: string;\s*businessDateSource: GmBusinessDateSource;\s*today: \{/, "campos aditivos en PropertyOverview");
    assert.match(code, /businessDate: window\.businessDate,\s*businessDateSource: window\.source,\s*today: \{/, "la respuesta los rellena");
    // Las cuentas de hoy siguen usando [dayStart, dayEnd).
    assert.match(code, /prisma\.reservation\.count\(\{ where: \{ propertyId, arrivalDate: \{ gte: dayStart, lt: dayEnd \} \} \}\)/);
    assert.match(code, /prisma\.reservation\.count\(\{ where: \{ propertyId, departureDate: \{ gte: dayStart, lt: dayEnd \} \} \}\)/);
  });

  it("portfolio: cada propiedad se agrega en su propia fecha de negocio y la fila lo dice", () => {
    const code = stripComments(PORTFOLIO);
    assert.match(code, /properties\.map\(async \(p\) => aggregateProperty\(p, resolveGmWindow\(\{ businessDate: await readGmBusinessDate\(p\.id\), now: asOfDate \}\)\)\)/);
    assert.match(code, /async function aggregateProperty\(\s*property: \{[^}]*\},\s*window: GmWindow\s*\)/);
    assert.match(code, /const dayStart = window\.today;\s*const dayEnd = window\.tomorrow;\s*const monthStart = startOfUtcMonth\(dayStart\);/);
    assert.match(code, /businessDate: string;\s*businessDateSource: GmBusinessDateSource;\s*arrivalsToday: number;/, "campos aditivos en perProperty");
    assert.match(code, /businessDate: window\.businessDate,\s*businessDateSource: window\.source,/, "el agregado los rellena");
    assert.match(code, /businessDate: a\.businessDate,\s*businessDateSource: a\.businessDateSource,/, "la fila pública los copia");
    // El sobre conserva `asOf` = día UTC de la petición (no cambia el contrato existente).
    assert.match(code, /const dayStart = startOfUtcDay\(asOfDate\);/);
    assert.match(code, /asOf: dayStart\.toISOString\(\),/);
  });

  it("la función pura compartida da la misma ventana a los tres: [medianoche UTC de la fecha de negocio, +24 h)", () => {
    const now = new Date("2026-09-20T09:30:00.000Z");
    const gm = resolveGmWindow({ businessDate: "2026-09-19", now });
    const cartera = resolveGmWindow({ businessDate: "2026-09-19", now });
    assert.deepEqual([gm.businessDate, gm.source, gm.today.toISOString(), gm.tomorrow.toISOString()], ["2026-09-19", "business_date", "2026-09-19T00:00:00.000Z", "2026-09-20T00:00:00.000Z"]);
    assert.deepEqual(cartera, gm);
    const sinFila = resolveGmWindow({ businessDate: undefined, now });
    assert.deepEqual([sinFila.businessDate, sinFila.source], ["2026-09-20", "utc_day"]);
  });
});
