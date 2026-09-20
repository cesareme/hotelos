// Unit tests · Tanda UX-2 · lote D3 (F-D1 «una verdad») — ventana «hoy» del
// panel del director (dashboards/general-manager.service.ts) = fecha de negocio
// de la propiedad (business_dates.current_date) y, sin fila, el día natural UTC;
// llegadas/salidas con la regla del preflight del cierre. `resolveGmWindow` es
// pura; `readGmBusinessDate` se prueba con un Prisma falso inyectado (ambas
// ramas + lectura fallida); el fuente se lee para pinar el cableado. Sin base de
// datos, sin red. Desde apps/api:
//   node --import tsx --test src/modules/dashboards/__tests__/general-manager-business-date.test.mts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it, mock } from "node:test";
import { readGmBusinessDate, resolveGmWindow, type GmBusinessDateClient } from "../general-manager.service.js";

const SOURCE = readFileSync(new URL("../general-manager.service.ts", import.meta.url), "utf8");
const PREFLIGHT = readFileSync(new URL("../../night-audit/night-audit-preflight.service.ts", import.meta.url), "utf8");

const NOW = new Date("2026-09-20T09:30:00.000Z");

function clientWith(row: { currentDate: Date } | null | Error): GmBusinessDateClient {
  return {
    businessDate: {
      findUnique: async () => {
        if (row instanceof Error) throw row;
        return row;
      }
    }
  };
}

describe("resolveGmWindow (pura)", () => {
  it("con fila: «hoy» es la medianoche UTC de la fecha de negocio, aunque el reloj vaya por otro día", () => {
    const w = resolveGmWindow({ businessDate: "2026-09-19", now: NOW });
    assert.equal(w.source, "business_date");
    assert.equal(w.businessDate, "2026-09-19");
    assert.equal(w.today.toISOString(), "2026-09-19T00:00:00.000Z");
    assert.equal(w.tomorrow.toISOString(), "2026-09-20T00:00:00.000Z");
  });

  it("sin fila: el día natural UTC de `now` y lo dice (source utc_day)", () => {
    for (const missing of [undefined, null, ""]) {
      const w = resolveGmWindow({ businessDate: missing, now: NOW });
      assert.equal(w.source, "utc_day");
      assert.equal(w.businessDate, "2026-09-20");
      assert.equal(w.today.toISOString(), "2026-09-20T00:00:00.000Z");
      assert.equal(w.tomorrow.toISOString(), "2026-09-21T00:00:00.000Z");
    }
  });

  it("una fecha que no es YYYY-MM-DD cuenta como «sin fila» (nunca una ventana NaN)", () => {
    for (const bad of ["19/09/2026", "2026-13-45", "hoy"]) {
      const w = resolveGmWindow({ businessDate: bad, now: NOW });
      assert.equal(w.source, "utc_day", bad);
      assert.equal(w.businessDate, "2026-09-20", bad);
      assert.ok(!Number.isNaN(w.today.getTime()));
    }
  });

  it("la ventana es [today, tomorrow) de exactamente 24 h, como toda fecha de reserva", () => {
    const w = resolveGmWindow({ businessDate: "2026-03-29", now: NOW });
    assert.equal(w.tomorrow.getTime() - w.today.getTime(), 86400000);
  });
});

describe("readGmBusinessDate (Prisma falso inyectado)", () => {
  it("rama con fila: devuelve YYYY-MM-DD de business_dates.current_date y consulta por propertyId", async () => {
    const calls: unknown[] = [];
    const client: GmBusinessDateClient = {
      businessDate: {
        findUnique: async (args) => {
          calls.push(args);
          return { currentDate: new Date("2026-09-19T00:00:00.000Z") };
        }
      }
    };
    assert.equal(await readGmBusinessDate("prop_test", client), "2026-09-19");
    assert.deepEqual(calls, [{ where: { propertyId: "prop_test" } }]);
  });

  it("rama sin fila: undefined (el panel cae al día UTC)", async () => {
    assert.equal(await readGmBusinessDate("prop_test", clientWith(null)), undefined);
  });

  it("lectura fallida: undefined avisado por console.warn, nunca lanza (mejor esfuerzo como el preflight)", async () => {
    const warn = mock.method(console, "warn", () => {});
    try {
      assert.equal(await readGmBusinessDate("prop_test", clientWith(new Error("db down"))), undefined);
      assert.equal(warn.mock.callCount(), 1);
      const [label, meta] = warn.mock.calls[0].arguments as [string, { propertyId: string; error: string }];
      assert.match(label, /businessDate lookup failed/);
      assert.equal(meta.propertyId, "prop_test");
      assert.equal(meta.error, "db down");
    } finally {
      warn.mock.restore();
    }
  });

  it("las dos ramas encadenan con resolveGmWindow: fila → business_date · sin fila → utc_day", async () => {
    const withRow = resolveGmWindow({ businessDate: await readGmBusinessDate("p", clientWith({ currentDate: new Date("2026-09-19T00:00:00.000Z") })), now: NOW });
    const withoutRow = resolveGmWindow({ businessDate: await readGmBusinessDate("p", clientWith(null)), now: NOW });
    assert.deepEqual([withRow.source, withRow.businessDate], ["business_date", "2026-09-19"]);
    assert.deepEqual([withoutRow.source, withoutRow.businessDate], ["utc_day", "2026-09-20"]);
  });
});

describe("general-manager.service.ts · contrato (lectura del fuente)", () => {
  it("buildGmDashboard resuelve la ventana con readGmBusinessDate + resolveGmWindow y cuelga mes y año de `today`", () => {
    assert.match(SOURCE, /const window = resolveGmWindow\(\{ businessDate: await readGmBusinessDate\(propertyId, input\.businessDateClient\), now \}\);/);
    assert.match(SOURCE, /const today = window\.today;\s*const tomorrow = window\.tomorrow;/);
    assert.match(SOURCE, /const monthStart = startOfMonthUtc\(today\);/);
    assert.match(SOURCE, /const yearStart = new Date\(Date\.UTC\(today\.getUTCFullYear\(\), 0, 1\)\);/);
    assert.doesNotMatch(SOURCE, /const today = startOfDayUtc\(now\);/, "la ventana ya no es el día natural UTC del reloj");
  });

  it("la respuesta expone businessDate + businessDateSource (aditivos) y asOf = businessDate", () => {
    assert.match(SOURCE, /businessDate: string;\s*businessDateSource: GmBusinessDateSource;/);
    assert.match(SOURCE, /asOf: window\.businessDate,\s*businessDate: window\.businessDate,\s*businessDateSource: window\.source,/);
    assert.match(SOURCE, /export type GmBusinessDateSource = "business_date" \| "utc_day";/);
  });

  it("llegadas y salidas siguen la regla del preflight: confirmed con arrivalDate en la fecha de negocio · checked_in con departureDate en ella", () => {
    assert.match(SOURCE, /prisma\.reservation\.count\(\{\s*where: \{ propertyId, arrivalDate: \{ gte: today, lt: tomorrow \}, status: "confirmed" \}\s*\}\)/);
    assert.match(SOURCE, /prisma\.reservation\.count\(\{\s*where: \{ propertyId, departureDate: \{ gte: today, lt: tomorrow \}, status: "checked_in" \}\s*\}\)/);
    assert.doesNotMatch(SOURCE, /arrivalDate: \{ gte: today, lt: tomorrow \}, status: \{ in: \["confirmed", "checked_in", "checked_out"\] \}/);
    // Misma lectura de la fila que el preflight (una vez, por propertyId, YYYY-MM-DD).
    assert.match(PREFLIGHT, /prisma\.businessDate\.findUnique\(\{ where: \{ propertyId \} \}\)/);
    assert.match(PREFLIGHT, /arrivalDate: \{ gte: today, lt: tomorrow \}, status: "confirmed"/);
    assert.match(SOURCE, /client\.businessDate\.findUnique\(\{ where: \{ propertyId \} \}\)/);
    assert.match(SOURCE, /row\.currentDate\.toISOString\(\)\.slice\(0, 10\)/);
  });

  it("el bloque `reputation.reviews30` pinado por T8 sigue intacto (30 días hacia atrás desde `today`)", () => {
    assert.match(SOURCE, /safe\(\s*"reputation\.reviews30",\s*prisma\.guestReview\.aggregate\(\{\s*where: \{ propertyId, createdAt: \{ gte: new Date\(today\.getTime\(\) - 30 \* 86400000\) \} \}/);
  });
});
