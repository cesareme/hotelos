// Tanda RRHH (RRHH-4): motor de reglas puro (hr/rules.engine.ts). Sin base de
// datos ni reloj del sistema. Desde apps/api:
//   node --import tsx --test src/modules/hr/__tests__/rules-engine.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HR_AGREEMENT_DEFAULTS, HR_HEADCOUNT_THRESHOLD } from "@hotelos/shared";
import { contractFraction, ET_DEFAULT_RULES, evaluateShifts, headcountThreshold, HR_RULE_VIOLATION_CODE, resolveRules, type RuleShift } from "../rules.engine.js";

const ES15 = HR_AGREEMENT_DEFAULTS["ES-15-HOST"].rules;
const ES33 = HR_AGREEMENT_DEFAULTS["ES-33-HOST"].rules;

const shift = (id: string, start: string, hours: number): RuleShift => {
  const startAt = new Date(start);
  return { id, startAt: startAt.toISOString(), endAt: new Date(startAt.getTime() + hours * 3_600_000).toISOString() };
};

/** Turnos de lunes a viernes (09:00 UTC, `hours` h) durante `weeks` semanas desde el lunes `firstMonday`. */
function weekdayShifts(firstMonday: string, weeks: number, hours: number): RuleShift[] {
  const out: RuleShift[] = [];
  const monday = new Date(firstMonday);
  for (let week = 0; week < weeks; week += 1) {
    for (let day = 0; day < 5; day += 1) {
      const start = new Date(monday.getTime() + (week * 7 + day) * 86_400_000);
      out.push(shift(`s_${week}_${day}`, start.toISOString(), hours));
    }
  }
  return out;
}

const rulesOf = (violations: ReturnType<typeof evaluateShifts>, rule: string) => violations.filter((violation) => violation.rule === rule);

describe("RRHH-4 · reglas y defectos", () => {
  it("resolveRules completa con el ET lo que el convenio no fija y descarta valores inválidos", () => {
    assert.deepEqual(resolveRules(null), ET_DEFAULT_RULES);
    assert.deepEqual(resolveRules({}), ET_DEFAULT_RULES);
    const asturias = resolveRules(ES33);
    assert.equal(asturias.max_daily_hours, 8);
    assert.equal(asturias.weekly_rest_days, 2);
    assert.equal(asturias.annual_hours, 1782);
    const broken = resolveRules({ max_daily_hours: "nueve", rest_between_shifts_h: -1, overtime_max_year: 0 });
    assert.equal(broken.max_daily_hours, 9);
    assert.equal(broken.rest_between_shifts_h, 12);
    assert.equal(broken.overtime_max_year, 80);
  });

  it("contractFraction: partTimePct manda, después weeklyHours/40, y sin contrato es jornada completa", () => {
    assert.equal(contractFraction(null), 1);
    assert.equal(contractFraction({ weeklyHours: 20 }), 0.5);
    assert.equal(contractFraction({ weeklyHours: 40, partTimePct: 75 }), 0.75);
    assert.equal(contractFraction({ weeklyHours: 60 }), 1, "nunca por encima de la jornada completa");
  });

  it("sin turnos (o con turnos inválidos) no hay avisos", () => {
    assert.deepEqual(evaluateShifts([], null, ES15), []);
    assert.deepEqual(evaluateShifts([{ startAt: "ayer", endAt: "hoy" }, { startAt: "2026-10-01T17:00:00.000Z", endAt: "2026-10-01T09:00:00.000Z" }], null, ES15), []);
  });
});

describe("RRHH-4 · rest_between_shifts (12 h entre jornadas)", () => {
  it("10 h entre el fin de un turno y el inicio del siguiente es un aviso con los dos turnos; 12 h exactas no", () => {
    const short = evaluateShifts([shift("a", "2026-10-01T09:00:00.000Z", 8), shift("b", "2026-10-02T03:00:00.000Z", 8)], null, ES15);
    const rest = rulesOf(short, "rest_between_shifts");
    assert.equal(rest.length, 1);
    assert.equal(rest[0]!.code, HR_RULE_VIOLATION_CODE);
    assert.equal(rest[0]!.severity, "warning");
    assert.deepEqual(rest[0]!.shiftIds, ["a", "b"]);
    assert.equal(rest[0]!.value, 10);
    assert.equal(rest[0]!.limit, 12);
    assert.equal(rest[0]!.period, "2026-10-02");
    assert.match(rest[0]!.message, /Descanso entre jornadas de 10 h \(mínimo 12 h\)/);
    const exact = evaluateShifts([shift("b", "2026-10-02T05:00:00.000Z", 8), shift("a", "2026-10-01T09:00:00.000Z", 8)], null, ES15);
    assert.equal(rulesOf(exact, "rest_between_shifts").length, 0, "el orden de entrada no importa y 12 h cumplen");
  });
});

describe("RRHH-4 · max_daily_hours (tope diario del convenio)", () => {
  it("9 h cumplen en A Coruña (9) y avisan en Asturias (8); dos turnos del mismo día se suman", () => {
    const nine = [shift("a", "2026-10-01T08:00:00.000Z", 9)];
    assert.equal(rulesOf(evaluateShifts(nine, null, ES15), "max_daily_hours").length, 0);
    const asturias = rulesOf(evaluateShifts(nine, null, ES33), "max_daily_hours");
    assert.equal(asturias.length, 1);
    assert.equal(asturias[0]!.limit, 8);
    assert.equal(asturias[0]!.value, 9);
    assert.equal(asturias[0]!.period, "2026-10-01");
    const split = rulesOf(evaluateShifts([shift("m", "2026-10-01T07:00:00.000Z", 5), shift("t", "2026-10-01T19:30:00.000Z", 4.5)], null, ES15), "max_daily_hours");
    assert.equal(split.length, 1, "5 + 4,5 = 9,5 h > 9");
    assert.deepEqual(split[0]!.shiftIds, ["m", "t"]);
    assert.equal(split[0]!.value, 9.5);
  });
});

describe("RRHH-4 · weekly_rest (descanso semanal continuo)", () => {
  // Semana ISO 2026-W41: lunes 5 → domingo 11 de octubre; vecinos el domingo 4 y el lunes 12.
  const everyDay = (from: string, days: number): RuleShift[] => Array.from({ length: days }, (_, index) => shift(`d${index}`, new Date(new Date(from).getTime() + index * 86_400_000).toISOString(), 8));

  it("siete días seguidos con huecos de 16 h (y vecinos a ambos lados) es un aviso de la semana 2026-W41", () => {
    const violations = rulesOf(evaluateShifts(everyDay("2026-10-04T09:00:00.000Z", 9), null, ES15), "weekly_rest");
    const week = violations.find((violation) => violation.period === "2026-W41");
    assert.ok(week, `sin aviso para 2026-W41: ${JSON.stringify(violations)}`);
    assert.equal(week.value, 16);
    assert.equal(week.limit, 1.5);
    assert.equal(week.shiftIds.length, 7);
  });

  it("un hueco de 40 h dentro de la semana (miércoles libre) cumple el día y medio; en Asturias (2 días) no", () => {
    const rows = everyDay("2026-10-04T09:00:00.000Z", 9).filter((row) => row.id !== "d3"); // miércoles 7 libre: martes 17:00 → jueves 09:00 = 40 h
    assert.equal(rulesOf(evaluateShifts(rows, null, ES15), "weekly_rest").filter((violation) => violation.period === "2026-W41").length, 0);
    const asturias = rulesOf(evaluateShifts(rows, null, ES33), "weekly_rest").filter((violation) => violation.period === "2026-W41");
    assert.equal(asturias.length, 1, "48 h exigidas > 40 h");
    assert.equal(asturias[0]!.value, 40);
  });

  it("sin turno vecino antes del primero o después del último no se inventa la infracción", () => {
    const openEdge = everyDay("2026-10-05T09:00:00.000Z", 7); // lunes 5 → domingo 11 sin vecinos
    assert.equal(rulesOf(evaluateShifts(openEdge, null, ES15), "weekly_rest").length, 0);
  });
});

describe("RRHH-4 · overtime_annual (80 h extra al año)", () => {
  it("1.920 h planificadas sobre 1.792 de jornada anual son 128 h extra → aviso; 1.840 h (48 extra) no", () => {
    const heavy = weekdayShifts("2026-01-05T09:00:00.000Z", 48, 8); // 240 × 8 = 1.920 h, fines de semana libres
    const violations = evaluateShifts(heavy, { weeklyHours: 40 }, ES15);
    assert.equal(rulesOf(violations, "rest_between_shifts").length, 0);
    assert.equal(rulesOf(violations, "max_daily_hours").length, 0);
    assert.equal(rulesOf(violations, "weekly_rest").length, 0, "viernes 17:00 → lunes 09:00 = 64 h");
    const overtime = rulesOf(violations, "overtime_annual");
    assert.equal(overtime.length, 1);
    assert.equal(overtime[0]!.period, "2026");
    assert.equal(overtime[0]!.value, 128);
    assert.equal(overtime[0]!.limit, 80);
    assert.equal(overtime[0]!.shiftIds.length, 240);
    const fair = weekdayShifts("2026-01-05T09:00:00.000Z", 46, 8); // 230 × 8 = 1.840 h → 48 extra
    assert.equal(rulesOf(evaluateShifts(fair, { weeklyHours: 40 }, ES15), "overtime_annual").length, 0);
  });

  it("a media jornada la jornada anual es proporcional: 1.120 h sobre 896 son 224 extra", () => {
    const partTime = weekdayShifts("2026-01-05T09:00:00.000Z", 28, 8); // 140 × 8 = 1.120 h
    const overtime = rulesOf(evaluateShifts(partTime, { partTimePct: 50 }, ES15), "overtime_annual");
    assert.equal(overtime.length, 1);
    assert.equal(overtime[0]!.value, 224);
    assert.equal(rulesOf(evaluateShifts(partTime, { weeklyHours: 40 }, ES15), "overtime_annual").length, 0, "a jornada completa 1.120 h no superan 1.792");
  });
});

describe("RRHH-4 · headcountThreshold (RD 901/2020, ≥ 50)", () => {
  const asOf = "2026-09-20T00:00:00.000Z";
  const daysAgo = (days: number) => new Date(Date.parse(asOf) - days * 86_400_000).toISOString();
  const active = (n: number, partTimePct: number | null = null) => Array.from({ length: n }, () => ({ status: "active", partTimePct, hiredAt: daysAgo(400) }));

  it("49 personas no alcanzan el umbral; 49 + 1 a tiempo parcial sí (parciales = 1)", () => {
    const below = headcountThreshold(active(49), asOf);
    assert.equal(below.headcount, 49);
    assert.equal(below.threshold, HR_HEADCOUNT_THRESHOLD);
    assert.equal(below.reached, false);
    const reached = headcountThreshold([...active(49), ...active(1, 50)], asOf);
    assert.equal(reached.headcount, 50);
    assert.equal(reached.active, 50);
    assert.equal(reached.reached, true);
    assert.equal(reached.asOf, asOf);
  });

  it("un temporal extinguido hace 30 días con 120 días trabajados en la ventana suma 2 (100 días o fracción = 1)", () => {
    const result = headcountThreshold([...active(48), { status: "inactive", temporary: true, hiredAt: daysAgo(150), terminatedAt: daysAgo(30) }], asOf);
    assert.equal(result.active, 48);
    assert.equal(result.temporaryTerminated, 2);
    assert.equal(result.headcount, 50);
    assert.equal(result.reached, true);
  });

  it("fuera de la ventana de 6 meses, o inactivo sin ser temporal, no cuenta; en excedencia (leave) sí", () => {
    const result = headcountThreshold(
      [
        ...active(10),
        { status: "leave", hiredAt: daysAgo(300) },
        { status: "inactive", temporary: true, hiredAt: daysAgo(400), terminatedAt: daysAgo(200) },
        { status: "inactive", hiredAt: daysAgo(400), terminatedAt: daysAgo(10) },
        { status: "active", hiredAt: daysAgo(400), terminatedAt: daysAgo(5) }
      ],
      asOf
    );
    assert.equal(result.active, 11, "10 activos + 1 en excedencia; el extinguido hace 5 días ya no está en plantilla");
    assert.equal(result.temporaryTerminated, 0);
    assert.equal(result.headcount, 11);
    assert.equal(result.reached, false);
  });
});
