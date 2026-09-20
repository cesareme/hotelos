// Unit tests · Tanda RRHH · RRHH-3 — motor puro de previsión de plantilla
// (hr/labor-forecast.engine.ts) y las funciones puras de estándares
// (hr/standards.service.ts: normalización, fusión y vigencia). Sin base de datos.
// Ejemplo verificado del diseño §5 :171 (LT agosto 2026): pisos 5,2 FTE (4,7 sin
// repaso), recepción 2-2-1 8,1 FTE. Desde apps/api:
//   node --import tsx --test src/modules/hr/__tests__/labor-forecast-engine.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HR_STANDARD_DEFAULTS, type LaborStandardBand } from "@hotelos/shared";
import { HttpError } from "../../../lib/http-error.js";
import {
  ANNUAL_HOURS_DEFAULT,
  computeDepartmentRequirement,
  computeLaborRequirement,
  computeStandardLine,
  estimateDailyCost,
  evaluateLaborAlerts,
  monthlyFte,
  pickBand,
  type AlertRow,
  type EngineDrivers,
  type EngineStandard
} from "../labor-forecast.engine.js";
import { activeStandardsAt, mergeSameDriverStandards, normaliseLaborStandardInput, normaliseLaborStandardSet, toEngineStandard } from "../standards.service.js";

const RULES = { annualHours: 1792 };
const round1 = (n: number | null): number | null => (n === null ? null : Math.round(n * 10) / 10);

/** LT agosto 2026 por día (D §5 :171): 55,7 ocupadas · 27,6 llegadas · 27,3 salidas · 112,4 pax. */
const LT_AUGUST: EngineDrivers = { date: "2026-08-15", rooms: 55.7, arrivals: 27.6, departures: 27.3, pax: 112.4, coversBreakfast: 100, coversRestaurant: 40, roomsInventory: 92, source: "actual", degraded: [] };

function std(partial: Partial<EngineStandard> & Pick<EngineStandard, "usaliDepartment" | "driver" | "unit" | "value">): EngineStandard {
  return { bands: null, allowancePct: 0, coverageFactor: 1.4, ...partial };
}

const PISOS_4STAR: EngineStandard[] = [
  std({ usaliDepartment: "rooms", driver: "stayovers", unit: "minutes_per_unit", value: 20, allowancePct: 12 }),
  std({ usaliDepartment: "rooms", driver: "departures", unit: "minutes_per_unit", value: 32, allowancePct: 12 }),
  std({ usaliDepartment: "rooms", driver: "arrivals", unit: "minutes_per_unit", value: 5, allowancePct: 12 })
];
const BANDS_4STAR: LaborStandardBand[] = [
  { maxOccupiedRooms: 60, posts: [1, 1, 1] },
  { maxOccupiedRooms: 150, posts: [2, 2, 1] },
  { maxOccupiedRooms: 250, posts: [2, 2, 2] },
  { maxOccupiedRooms: null, posts: [3, 3, 3] }
];
const RECEPTION_4STAR = std({ usaliDepartment: "rooms", driver: "occupied_rooms", unit: "posts_by_band", value: 8, bands: BANDS_4STAR });

describe("motor · ejemplo LT agosto (D §5 :171)", () => {
  it("pisos 4★: (27,3 × 32 + 28,4 × 20 + 27,6 × 5) × 1,12 / 60 = 29,5 h/día → 5,2 FTE", () => {
    const rooms = computeDepartmentRequirement("rooms", LT_AUGUST, PISOS_4STAR, RULES);
    assert.equal(rooms.degraded, false);
    assert.equal(round1(rooms.requiredHours), 29.5);
    assert.equal(round1(rooms.requiredFte), 5.2);
    assert.equal(rooms.lines.length, 3);
    assert.equal(rooms.lines.find((l) => l.driver === "stayovers")?.units, 28.4);
  });

  it("sin el término de repaso de llegadas → 4,7 FTE", () => {
    const rooms = computeDepartmentRequirement("rooms", LT_AUGUST, PISOS_4STAR.filter((s) => s.driver !== "arrivals"), RULES);
    assert.equal(round1(rooms.requiredFte), 4.7);
  });

  it("recepción 2-2-1 (día pico de 70 ocupadas) = 5 puestos × 8 h × 365 / 1.792 = 8,1 FTE; noche siempre ≥ 1", () => {
    const peak: EngineDrivers = { ...LT_AUGUST, rooms: 70 };
    const line = computeStandardLine(peak, RECEPTION_4STAR, RULES);
    assert.deepEqual(line.posts, [2, 2, 1]);
    assert.equal(line.hours, 40);
    assert.equal(line.fte, 8.15);
    assert.equal(((40 * 365) / 1792).toFixed(1), "8.1");
    // Con 55,7 ocupadas cae en el tramo ≤ 60 (1-1-1): 24 h → 4,9 FTE.
    const avg = computeStandardLine(LT_AUGUST, RECEPTION_4STAR, RULES);
    assert.deepEqual(avg.posts, [1, 1, 1]);
    assert.equal(round1(avg.fte), 4.9);
    // Un tramo sin puesto de noche se corrige a 1.
    const noNight = computeStandardLine(peak, { ...RECEPTION_4STAR, bands: [{ maxOccupiedRooms: null, posts: [1, 1, 0] }] }, RULES);
    assert.deepEqual(noNight.posts, [1, 1, 1]);
  });

  it("rooms completo = pisos + recepción (la cobertura del puesto 24/7 sale de la jornada anual, no del 1,4)", () => {
    const rooms = computeDepartmentRequirement("rooms", LT_AUGUST, [...PISOS_4STAR, RECEPTION_4STAR], RULES);
    assert.equal(round1(rooms.requiredHours), 53.5);
    assert.equal(round1(rooms.requiredFte), 10.1);
    // Otra jornada anual cambia SOLO la parte de recepción.
    const asturias = computeDepartmentRequirement("rooms", LT_AUGUST, [...PISOS_4STAR, RECEPTION_4STAR], { annualHours: 1782 });
    assert.ok((asturias.requiredFte ?? 0) > (rooms.requiredFte ?? 0));
    assert.equal(round1((asturias.requiredFte ?? 0) - (rooms.requiredFte ?? 0)), 0);
  });
});

describe("motor · tramos de recepción (pickBand)", () => {
  it("elige el primer tramo cuyo tope es null o ≥ ocupadas, ordenando los tramos aunque lleguen desordenados", () => {
    const shuffled = [BANDS_4STAR[3]!, BANDS_4STAR[1]!, BANDS_4STAR[0]!, BANDS_4STAR[2]!];
    assert.deepEqual(pickBand(shuffled, 0), [1, 1, 1]);
    assert.deepEqual(pickBand(shuffled, 60), [1, 1, 1]);
    assert.deepEqual(pickBand(shuffled, 61), [2, 2, 1]);
    assert.deepEqual(pickBand(shuffled, 150), [2, 2, 1]);
    assert.deepEqual(pickBand(shuffled, 250), [2, 2, 2]);
    assert.deepEqual(pickBand(shuffled, 251), [3, 3, 3]);
    assert.deepEqual(pickBand(shuffled, 399), [3, 3, 3]);
  });

  it("sin tramos → null (la línea queda sin cifra, no 0)", () => {
    assert.equal(pickBand(null, 50), null);
    assert.equal(pickBand([], 50), null);
    const line = computeStandardLine(LT_AUGUST, { ...RECEPTION_4STAR, bands: [] }, RULES);
    assert.equal(line.hours, null);
    assert.equal(line.fte, null);
  });
});

describe("motor · F&B por cubiertos (proxy boardType × pax), mantenimiento y dirección", () => {
  const fnb: EngineStandard[] = [
    // Desayunos: sala 2,4 min + cocina 10,667 min por cubierto (fusión de los valores 4★).
    std({ usaliDepartment: "fnb", driver: "covers_breakfast", unit: "minutes_per_unit", value: 13.067 }),
    std({ usaliDepartment: "fnb", driver: "covers_restaurant", unit: "minutes_per_unit", value: 3 }),
    std({ usaliDepartment: "fnb", driver: "fixed", unit: "units_per_shift", value: 1 })
  ];

  it("100 cubiertos de desayuno + 40 de restaurante + bar fijo → 31,8 h → 5,6 FTE", () => {
    const r = computeDepartmentRequirement("fnb", LT_AUGUST, fnb, RULES);
    assert.equal(round1(r.requiredHours), 31.8);
    assert.equal(round1(r.requiredFte), 5.6);
  });

  it("cubiertos desconocidos (null) → F&B degradado sin cifra, aunque el bar fijo sí se conozca", () => {
    const r = computeDepartmentRequirement("fnb", { ...LT_AUGUST, coversBreakfast: null, coversRestaurant: null }, fnb, RULES);
    assert.equal(r.requiredHours, null);
    assert.equal(r.requiredFte, null);
    assert.equal(r.degraded, true);
    assert.deepEqual(r.degradedReasons, ["driver_missing:covers_breakfast", "driver_missing:covers_restaurant"]);
    assert.equal(r.lines.find((l) => l.driver === "fixed")?.hours, 8);
  });

  it("cocina como cupo por turno (1 cocinero / 45 cubiertos) equivale a 10,667 min por cubierto", () => {
    const perShift = computeStandardLine(LT_AUGUST, std({ usaliDepartment: "fnb", driver: "covers_breakfast", unit: "units_per_shift", value: 45 }), RULES);
    const perMinute = computeStandardLine(LT_AUGUST, std({ usaliDepartment: "fnb", driver: "covers_breakfast", unit: "minutes_per_unit", value: 10.667 }), RULES);
    assert.equal(round1(perShift.hours), round1(perMinute.hours));
  });

  it("mantenimiento 1,4 FTE/100 hab. × 92 → 10,3 h → 1,3 FTE (cobertura 1,0); dirección 2 puestos fijos → 16 h → 2,0 FTE", () => {
    const pom = computeDepartmentRequirement("pom", LT_AUGUST, [std({ usaliDepartment: "pom", driver: "rooms_inventory", unit: "fte_per_100", value: 1.4, coverageFactor: 1 })], RULES);
    assert.equal(round1(pom.requiredHours), 10.3);
    assert.equal(round1(pom.requiredFte), 1.3);
    const admin = computeDepartmentRequirement("admin_general", LT_AUGUST, [std({ usaliDepartment: "admin_general", driver: "fixed", unit: "units_per_shift", value: 2, coverageFactor: 1 })], RULES);
    assert.equal(admin.requiredHours, 16);
    assert.equal(admin.requiredFte, 2);
  });
});

describe("motor · día sin OTB ni previsión → degraded sin FTE inventado", () => {
  const empty: EngineDrivers = { date: "2026-10-05", rooms: null, arrivals: null, departures: null, pax: null, coversBreakfast: null, coversRestaurant: null, roomsInventory: 92, source: null, degraded: ["no_otb_no_forecast"] };
  const all = HR_STANDARD_DEFAULTS[4].map((d) => toEngineStandard(d));

  it("todos los departamentos con drivers de ocupación quedan sin horas ni FTE; el total es null, nunca 0", () => {
    const day = computeLaborRequirement(empty, all, RULES);
    assert.equal(day.degraded, true);
    assert.equal(day.source, null);
    assert.ok(day.degradedReasons.includes("no_otb_no_forecast"));
    const rooms = day.departments.find((d) => d.usaliDepartment === "rooms")!;
    assert.equal(rooms.requiredHours, null);
    assert.equal(rooms.requiredFte, null);
    const fnb = day.departments.find((d) => d.usaliDepartment === "fnb")!;
    assert.equal(fnb.requiredFte, null);
    // Mantenimiento y dirección solo dependen del inventario / puestos fijos: sí se calculan.
    const pom = day.departments.find((d) => d.usaliDepartment === "pom")!;
    assert.ok((pom.requiredFte ?? 0) > 0);
    const admin = day.departments.find((d) => d.usaliDepartment === "admin_general")!;
    assert.equal(admin.requiredFte, 2);
    assert.equal(day.totalHours, Math.round(((pom.requiredHours ?? 0) + (admin.requiredHours ?? 0)) * 100) / 100);
  });

  it("sin estándares → sin departamentos y total null", () => {
    const day = computeLaborRequirement(LT_AUGUST, [], RULES);
    assert.deepEqual(day.departments, []);
    assert.equal(day.totalHours, null);
    assert.equal(day.totalFte, null);
  });

  it("estándares 4★ completos (fusionados) con los drivers de LT → cifras positivas en los 4 departamentos", () => {
    const merged = mergeSameDriverStandards([...HR_STANDARD_DEFAULTS[4]]).map((d) => toEngineStandard(d));
    const day = computeLaborRequirement(LT_AUGUST, merged, RULES);
    assert.equal(day.degraded, false);
    assert.deepEqual(day.departments.map((d) => d.usaliDepartment).sort(), ["admin_general", "fnb", "pom", "rooms"]);
    for (const dept of day.departments) assert.ok((dept.requiredFte ?? 0) > 0, dept.usaliDepartment);
  });
});

describe("motor · FTE del mes y coste estimado", () => {
  it("FTE mes = Σ horas / (jornada anual / 12): 40 h × 31 días con 1.792 h → 8,3", () => {
    assert.equal(monthlyFte(40 * 31, 1792), 8.3);
    assert.equal(monthlyFte(1000, 0), Math.round((1000 / (ANNUAL_HOURS_DEFAULT / 12)) * 100) / 100);
  });

  it("coste del día = FTE × coste mensual por empleado / días del mes; null sin FTE o sin referencia", () => {
    assert.equal(estimateDailyCost(5.16, 1894.95, 31), 315.42);
    assert.equal(estimateDailyCost(null, 1894.95, 31), null);
    assert.equal(estimateDailyCost(5.16, null, 31), null);
  });
});

describe("motor · alertas calculadas (evaluateLaborAlerts)", () => {
  const base = (over: Partial<AlertRow>): AlertRow => ({ propertyId: "prop_hr", date: "2026-10-01", usaliDepartment: "rooms", requiredHours: 40, requiredFte: 7, plannedHours: 40, availableFte: 8, activeFte: 8, approvedFte: 9, degraded: false, ...over });

  it("understaffed (warning) por planificado < 85 %; critical cuando necesario > disponible", () => {
    const alerts = evaluateLaborAlerts([base({ plannedHours: 30 }), base({ date: "2026-10-02", requiredFte: 9, availableFte: 8 })]);
    assert.deepEqual(alerts.map((a) => [a.kind, a.severity, a.date]), [["understaffed", "warning", "2026-10-01"], ["understaffed", "critical", "2026-10-02"]]);
    assert.equal(alerts[0]!.usaliDepartment, "rooms");
    assert.equal(alerts[0]!.employeeId, null);
  });

  it("overstaffed solo tras 3 días seguidos por encima del 115 % (se emite en el tercero)", () => {
    const two = evaluateLaborAlerts([base({ plannedHours: 50 }), base({ date: "2026-10-02", plannedHours: 50 })]);
    assert.equal(two.filter((a) => a.kind === "overstaffed").length, 0);
    const broken = evaluateLaborAlerts([base({ plannedHours: 50 }), base({ date: "2026-10-02", plannedHours: 40 }), base({ date: "2026-10-03", plannedHours: 50 }), base({ date: "2026-10-04", plannedHours: 50 })]);
    assert.equal(broken.filter((a) => a.kind === "overstaffed").length, 0);
    const three = evaluateLaborAlerts([base({ date: "2026-10-03", plannedHours: 50 }), base({ plannedHours: 50 }), base({ date: "2026-10-02", plannedHours: 50 })]);
    const over = three.filter((a) => a.kind === "overstaffed");
    assert.equal(over.length, 1);
    assert.equal(over[0]!.date, "2026-10-03");
  });

  it("over_approved una vez por departamento; forecast_degraded una por día; sin cuadrante (planned null) no hay over/under", () => {
    const alerts = evaluateLaborAlerts([
      base({ activeFte: 10, approvedFte: 9, plannedHours: null }),
      base({ date: "2026-10-02", activeFte: 10, approvedFte: 9, plannedHours: null }),
      base({ date: "2026-10-03", usaliDepartment: "fnb", requiredHours: null, requiredFte: null, degraded: true, plannedHours: null }),
      base({ date: "2026-10-03", usaliDepartment: "pom", requiredHours: null, requiredFte: null, degraded: true, plannedHours: null })
    ]);
    assert.deepEqual(alerts.map((a) => a.kind).sort(), ["forecast_degraded", "over_approved"]);
    const degradedAlert = alerts.find((a) => a.kind === "forecast_degraded")!;
    assert.equal(degradedAlert.date, "2026-10-03");
    assert.equal(degradedAlert.usaliDepartment, null);
    assert.match(degradedAlert.message, /2 departamento/);
  });

  it("sin filas → sin alertas; filas completas y sanas → sin alertas", () => {
    assert.deepEqual(evaluateLaborAlerts([]), []);
    assert.deepEqual(evaluateLaborAlerts([base({}), base({ date: "2026-10-02" })]), []);
  });
});

describe("estándares · normalización, fusión y vigencia (funciones puras de standards.service)", () => {
  it("normaliza valores y rechaza driver/unit incompatibles, tramos mal formados y valores fuera de rango (400 HR_STANDARD_INVALID)", () => {
    const ok = normaliseLaborStandardInput({ usaliDepartment: "rooms", driver: "departures", unit: "minutes_per_unit", value: "32", allowancePct: 12, coverageFactor: "1,4" });
    assert.deepEqual(ok, { usaliDepartment: "rooms", driver: "departures", unit: "minutes_per_unit", value: "32.000", bands: null, allowancePct: "12.00", coverageFactor: "1.40", source: "measured" });
    const expectInvalid = (input: Parameters<typeof normaliseLaborStandardInput>[0], field: string) => {
      try {
        normaliseLaborStandardInput(input);
      } catch (error) {
        assert.ok(error instanceof HttpError);
        assert.equal(error.statusCode, 400);
        assert.equal((error.details as { code: string; field: string }).code, "HR_STANDARD_INVALID");
        assert.equal((error.details as { field: string }).field, field);
        return;
      }
      assert.fail(`expected 400 for ${field}`);
    };
    expectInvalid({ usaliDepartment: "rooms", driver: "rooms_inventory", unit: "minutes_per_unit", value: 1 }, "unit");
    expectInvalid({ usaliDepartment: "rooms", driver: "occupied_rooms", unit: "posts_by_band", value: 8, bands: [{ maxOccupiedRooms: 60, posts: [1, 1] }] }, "bands[0].posts");
    expectInvalid({ usaliDepartment: "rooms", driver: "occupied_rooms", unit: "posts_by_band", value: 8, bands: [{ maxOccupiedRooms: 60, posts: [1, 1, 1] }] }, "bands");
    expectInvalid({ usaliDepartment: "rooms", driver: "departures", unit: "minutes_per_unit", value: 0 }, "value");
    expectInvalid({ usaliDepartment: "rooms", driver: "departures", unit: "minutes_per_unit", value: 30, allowancePct: 120 }, "allowancePct");
    expectInvalid({ usaliDepartment: "spa", driver: "departures", unit: "minutes_per_unit", value: 30 }, "usaliDepartment");
  });

  it("un conjunto no repite (departamento, driver): la clave única de labor_standards no lleva unit", () => {
    assert.throws(
      () => normaliseLaborStandardSet([{ usaliDepartment: "fnb", driver: "covers_breakfast", unit: "minutes_per_unit", value: 2.4 }, { usaliDepartment: "fnb", driver: "covers_breakfast", unit: "units_per_shift", value: 45 }]),
      (error: unknown) => error instanceof HttpError && error.statusCode === 400 && /repetido/.test(error.message)
    );
  });

  it("mergeSameDriverStandards funde sala (2,4 min) + cocina (1/45 por turno de 8 h) en 13,067 min por cubierto y respeta el resto", () => {
    const merged = mergeSameDriverStandards([...HR_STANDARD_DEFAULTS[4]]);
    const breakfast = merged.filter((s) => s.usaliDepartment === "fnb" && s.driver === "covers_breakfast");
    assert.equal(breakfast.length, 1);
    assert.equal(breakfast[0]!.unit, "minutes_per_unit");
    assert.equal(breakfast[0]!.value, "13.067");
    assert.equal(merged.length, HR_STANDARD_DEFAULTS[4].length - 1);
    const keys = new Set(merged.map((s) => `${s.usaliDepartment}|${s.driver}`));
    assert.equal(keys.size, merged.length, "sin parejas repetidas tras la fusión");
    // Con 2★ no hay restaurante (sin línea covers_restaurant ni bar) y sigue habiendo una sola de desayunos.
    const two = mergeSameDriverStandards([...HR_STANDARD_DEFAULTS[2]]);
    assert.equal(two.filter((s) => s.driver === "covers_restaurant").length, 0);
    assert.equal(two.filter((s) => s.driver === "covers_breakfast").length, 1);
  });

  it("activeStandardsAt: versión vigente por pareja (validFrom ≤ fecha, validTo null o ≥ fecha; gana la más reciente)", () => {
    const row = (validFrom: string, validTo: string | null, value: string) => ({ id: `${validFrom}-${value}`, propertyId: "p", usaliDepartment: "rooms" as const, driver: "departures" as const, unit: "minutes_per_unit" as const, value, bands: null, allowancePct: "12.00", coverageFactor: "1.40", validFrom, validTo, source: "measured" as const });
    const rows = [row("2026-01-01", "2026-06-30", "30.000"), row("2026-07-01", null, "32.000"), row("2027-01-01", null, "34.000")];
    assert.equal(activeStandardsAt(rows, "2026-03-01")[0]!.value, "30.000");
    assert.equal(activeStandardsAt(rows, "2026-07-01")[0]!.value, "32.000");
    assert.equal(activeStandardsAt(rows, "2026-12-31")[0]!.value, "32.000");
    assert.equal(activeStandardsAt(rows, "2027-02-01")[0]!.value, "34.000");
    // Antes de la primera versión rige la primera (retroactiva); tras una versión cerrada sin sucesora, nada.
    assert.equal(activeStandardsAt(rows, "2025-12-31")[0]!.value, "30.000");
    assert.deepEqual(activeStandardsAt([row("2026-01-01", "2026-06-30", "30.000")], "2026-08-01"), []);
    assert.equal(activeStandardsAt([row("2026-01-01", "2026-06-30", "30.000")], "2025-01-01")[0]!.value, "30.000");
  });
});
