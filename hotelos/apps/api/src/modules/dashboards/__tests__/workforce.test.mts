// Unit tests · Tanda RRHH · RRHH-3 — el dashboard de personal (dashboards/workforce.service.ts)
// sigue leyendo `LaborForecast.requiredLaborHours` sin cambios: el escritor único de la
// tanda (hr/labor-forecast.service.ts) persiste una fila por día × departamento USALI y el
// dashboard SUMA esa columna por día, así que la serie «horas previstas» de los 14 días es
// el total del centro. Contrato leído del fuente (sin base de datos). Desde apps/api:
//   node --import tsx --test src/modules/dashboards/__tests__/workforce.test.mts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { maskDashboardAbsenceType } from "../workforce.service.js";

const WORKFORCE = readFileSync(new URL("../workforce.service.ts", import.meta.url), "utf8");
const WRITER = readFileSync(new URL("../../hr/labor-forecast.service.ts", import.meta.url), "utf8");

describe("dashboards/workforce.service.ts · lectura de labor_forecasts", () => {
  it("consulta laborForecast.findMany por centro y ventana de 14 días seleccionando SOLO forecastDate y requiredLaborHours", () => {
    const matches = WORKFORCE.match(/prisma\.laborForecast\.findMany\(\{\s*where: \{\s*propertyId: input\.propertyId,\s*forecastDate: \{ gte: fourteenStart, lt: tomorrowStart \}\s*\},\s*select: \{ forecastDate: true, requiredLaborHours: true \}\s*\}\)/g) ?? [];
    assert.equal(matches.length, 1);
    assert.doesNotMatch(WORKFORCE, /usaliDepartment|requiredFte|driversJson/);
  });

  it("suma requiredLaborHours de TODAS las filas del día (una por departamento) → forecastHours es el total del centro", () => {
    assert.match(WORKFORCE, /forecastByDay\.set\(key, \(forecastByDay\.get\(key\) \?\? 0\) \+ dec\(row\.requiredLaborHours\)\);/);
    assert.match(WORKFORCE, /forecastHours from LaborForecast\.requiredLaborHours per day/);
  });

  it("el escritor único rellena requiredLaborHours en cada fila por departamento y no escribe filas «all» agregadas (evita el doble cómputo)", () => {
    assert.match(WRITER, /requiredLaborHours: text2\(dept\.requiredHours\)/);
    assert.match(WRITER, /prisma\.laborForecast\.upsert\(\{\s*where: \{ propertyId_forecastDate_usaliDepartment: \{ propertyId: property\.id, forecastDate, usaliDepartment: dept\.usaliDepartment \} \}/);
    assert.doesNotMatch(WRITER, /usaliDepartment: "all"/);
    // Filas obsoletas del mismo día (departamento sin estándar) se retiran: la previsión es una foto.
    assert.match(WRITER, /prisma\.laborForecast\.deleteMany\(\{ where: \{ propertyId: property\.id, forecastDate, usaliDepartment: \{ notIn: keep \} \} \}\)/);
  });
});

describe("dashboards/workforce.service.ts · datos de salud de las ausencias (corrector RRHH · SEC-07)", () => {
  it("maskDashboardAbsenceType: IT / nacimiento y cuidado salen como null + restricted sin hr.employee.read / manage; el resto de tipos y null no cambian", () => {
    assert.deepEqual(maskDashboardAbsenceType("it_common", ["workforce.read", "analytics.read"]), { type: null, restricted: true });
    assert.deepEqual(maskDashboardAbsenceType("maternity", []), { type: null, restricted: true });
    assert.deepEqual(maskDashboardAbsenceType("it_accident", undefined), { type: null, restricted: true }, "sin lista de claves también se enmascara");
    assert.deepEqual(maskDashboardAbsenceType("it_common", ["hr.employee.read"]), { type: "it_common", restricted: false });
    assert.deepEqual(maskDashboardAbsenceType("maternity", ["hr.employee.manage"]), { type: "maternity", restricted: false });
    assert.deepEqual(maskDashboardAbsenceType("vacation", []), { type: "vacation", restricted: false });
    assert.deepEqual(maskDashboardAbsenceType(null, []), { type: null, restricted: false });
  });

  it("la ruta GET /dashboards/workforce pasa las claves del actor y pendingAbsences se construye con la máscara", () => {
    assert.match(WORKFORCE, /\.\.\.maskDashboardAbsenceType\(a\.absenceType, input\.permissions\),/);
    const SERVER = readFileSync(new URL("../../../server.ts", import.meta.url), "utf8");
    assert.match(SERVER, /buildWorkforceDashboard\(\{ propertyId: q\.propertyId \?\? request\.userContext\.propertyId, from: q\.from, to: q\.to, permissions: request\.userContext\.permissions \?\? \[\] \}\)/);
  });
});
