import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  COMPARE_DEFAULT_SORT,
  COMPARE_METRICS,
  DELTA_EPSILON,
  TABLE_DEFAULT_SORT,
  averageOf,
  canCompare,
  compareRows,
  compareView,
  deltaLabel,
  deltaTone,
  deltaVsAverage,
  nextSort,
  sortKeyOf,
  sortRows,
  type PortfolioPropertyRow
} from "../portfolio-compare.ts";

// Tanda UX-2 · lote D6 (F-D9 / F-D10): Cartera «Tabla · Comparar» (delta frente a
// la media simple de la cartera, un solo hotel avisa, ⌘K «Comparar hoteles» /
// «Ordenar por …») y acciones del detalle («PyG del hotel» con `?ambito=`;
// «Cierre del día» / «Exportar informe» solo para el hotel activo).
const stripComments = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
const dashboard = stripComments(readFileSync(new URL("../PortfolioDashboard.tsx", import.meta.url), "utf8"));
const detail = stripComments(readFileSync(new URL("../PropertyDetailScreen.tsx", import.meta.url), "utf8"));
const count = (source: string, needle: string) => source.split(needle).length - 1;

function row(overrides: Partial<PortfolioPropertyRow> & { propertyId: string }): PortfolioPropertyRow {
  return {
    name: overrides.propertyId,
    status: "open",
    roomsCount: 10,
    arrivalsToday: 0,
    departuresToday: 0,
    inHouseNow: 0,
    occupancyPct: 0,
    adrEur: 0,
    revparEur: 0,
    revenueMtdEur: 0,
    pendingFiscalSubmissions: 0,
    pendingBalanceEur: 0,
    health: "ok",
    ...overrides
  };
}

// Cifras del tenant de prueba UXDAY (prop_uxday el 2026-09-19) y un segundo hotel inventado.
const A = row({ propertyId: "prop_a", name: "Hotel A", occupancyPct: 96.7, adrEur: 101.24, revparEur: 97.87, revenueMtdEur: 21410 });
const B = row({ propertyId: "prop_b", name: "Hotel B", occupancyPct: 50.3, adrEur: 80, revparEur: 40.24, revenueMtdEur: 8000 });
const C = row({ propertyId: "prop_c", name: "Hotel C", occupancyPct: 50.3, adrEur: 80, revparEur: 40.24, revenueMtdEur: 8000, status: "closed", health: "warn" });

describe("Cartera · media de la cartera", () => {
  it("media simple por métrica (sin ponderar por habitaciones); 0 sin filas", () => {
    assert.equal(averageOf([A, B], "occupancyPct"), 73.5);
    assert.equal(averageOf([A, B], "adrEur"), 90.62);
    assert.equal(averageOf([A, B], "revenueMtdEur"), 14705);
    assert.equal(averageOf([], "adrEur"), 0);
    assert.equal(averageOf([A], "occupancyPct"), 96.7);
  });

  it("un valor no finito cuenta como 0 y no rompe la media", () => {
    assert.equal(averageOf([A, row({ propertyId: "prop_nan", adrEur: Number.NaN })], "adrEur"), 50.62);
  });
});

describe("Cartera · delta frente a la media", () => {
  it("delta = valor − media a dos decimales y los deltas de la cartera suman 0", () => {
    assert.equal(deltaVsAverage(96.7, 73.5), 23.2);
    assert.equal(deltaVsAverage(50.3, 73.5), -23.2);
    assert.equal(deltaVsAverage(Number.NaN, 10), -10);
    const { average, rows } = compareView([A, B]);
    for (const metric of COMPARE_METRICS) {
      const sum = rows.reduce((acc, r) => acc + r.delta[metric], 0);
      assert.ok(Math.abs(sum) < 0.011, `${metric}: los deltas suman ${sum}`);
      assert.equal(average[metric], averageOf([A, B], metric));
    }
    const a = rows.find((r) => r.propertyId === "prop_a")!;
    // El delta se calcula sobre la media ya redondeada (la que pinta el pie): 97,87 − 69,06 = 28,81.
    assert.deepEqual(a.delta, { occupancyPct: 23.2, adrEur: 10.62, revparEur: 28.81, revenueMtdEur: 6705 });
  });

  it("tono por signo: encima de la media success, debajo danger, en la media neutral", () => {
    assert.equal(deltaTone(23.2), "success");
    assert.equal(deltaTone(-0.01), "danger");
    assert.equal(deltaTone(0), "neutral");
    assert.equal(deltaTone(DELTA_EPSILON / 2), "neutral");
    assert.equal(deltaTone(Number.NaN), "neutral");
  });

  it("etiqueta: puntos porcentuales en ocupación, euros en dinero, signo tipográfico y «en la media»", () => {
    assert.match(deltaLabel("occupancyPct", 23.2), /^\+23,2\s?pp$/u);
    assert.match(deltaLabel("occupancyPct", -23.2), /^−23,2\s?pp$/u);
    assert.match(deltaLabel("adrEur", 10.62), /^\+10,62\s?€$/u);
    assert.match(deltaLabel("revenueMtdEur", -6705), /^−6705,00\s?€$|^−6\.705,00\s?€$/u);
    assert.equal(deltaLabel("revparEur", 0), "en la media");
  });
});

describe("Cartera · orden", () => {
  it("la comparativa arranca por ocupación descendente y la tabla por ingresos del mes", () => {
    assert.deepEqual(COMPARE_DEFAULT_SORT, { key: "occupancyPct", dir: "desc" });
    assert.deepEqual(TABLE_DEFAULT_SORT, { key: "revenueMtdEur", dir: "desc" });
    assert.deepEqual(
      compareView([B, A]).rows.map((r) => r.propertyId),
      ["prop_a", "prop_b"]
    );
  });

  it("compareRows: números por valor, texto por localeCompare, sentido invertido en desc", () => {
    assert.ok(compareRows(A, B, "occupancyPct", "asc") > 0);
    assert.ok(compareRows(A, B, "occupancyPct", "desc") < 0);
    assert.ok(compareRows(A, B, "name", "asc") < 0);
    assert.ok(compareRows(A, C, "status", "asc") > 0);
    assert.ok(compareRows(A, C, "health", "asc") < 0);
    assert.equal(compareRows(B, C, "occupancyPct", "asc"), 0);
  });

  it("sortRows es estable: los empates conservan el orden de entrada en ambos sentidos y no muta la entrada", () => {
    const input = [B, C, A];
    assert.deepEqual(sortRows(input, { key: "occupancyPct", dir: "asc" }).map((r) => r.propertyId), ["prop_b", "prop_c", "prop_a"]);
    assert.deepEqual(sortRows(input, { key: "occupancyPct", dir: "desc" }).map((r) => r.propertyId), ["prop_a", "prop_b", "prop_c"]);
    assert.deepEqual(sortRows([C, B, A], { key: "revenueMtdEur", dir: "desc" }).map((r) => r.propertyId), ["prop_a", "prop_c", "prop_b"]);
    assert.deepEqual(input.map((r) => r.propertyId), ["prop_b", "prop_c", "prop_a"]);
  });

  it("nextSort: la misma clave invierte; una clave nueva empieza asc si es texto y desc si es numérica", () => {
    assert.deepEqual(nextSort({ key: "occupancyPct", dir: "desc" }, "occupancyPct"), { key: "occupancyPct", dir: "asc" });
    assert.deepEqual(nextSort({ key: "occupancyPct", dir: "desc" }, "name"), { key: "name", dir: "asc" });
    assert.deepEqual(nextSort({ key: "name", dir: "asc" }, "revenueMtdEur"), { key: "revenueMtdEur", dir: "desc" });
  });

  it("sortKeyOf: una columna delta ordena por su métrica; una clave desconocida no ordena", () => {
    assert.equal(sortKeyOf("delta:occupancyPct"), "occupancyPct");
    assert.equal(sortKeyOf("revenueMtdEur"), "revenueMtdEur");
    assert.equal(sortKeyOf("delta:nope"), null);
    assert.equal(sortKeyOf("city"), null);
  });
});

describe("Cartera · un solo hotel", () => {
  it("no hay comparación: la media es el propio hotel y los deltas son 0", () => {
    assert.equal(canCompare([A]), false);
    assert.equal(canCompare([]), false);
    assert.equal(canCompare([A, B]), true);
    const only = compareView([A]);
    assert.deepEqual(only.rows[0]!.delta, { occupancyPct: 0, adrEur: 0, revparEur: 0, revenueMtdEur: 0 });
    assert.equal(deltaLabel("occupancyPct", only.rows[0]!.delta.occupancyPct), "en la media");
  });

  it("la pantalla lo dice en vez de ocultar la vista", () => {
    assert.ok(dashboard.includes('title="Solo hay un hotel: la comparación aparece con dos o más"'));
    assert.ok(dashboard.includes("canCompare(properties)"));
  });
});

describe("PortfolioDashboard · vistas Tabla · Comparar y comandos ⌘K", () => {
  it("vistas internas como tabs de CocoaPage (patrón OperationsDirectorScreen)", () => {
    assert.ok(dashboard.includes('{ value: "tabla", label: "Tabla" }'));
    assert.ok(dashboard.includes('{ value: "comparar", label: "Comparar" }'));
    assert.ok(dashboard.includes("tabs={PORTFOLIO_VIEWS}"));
    assert.ok(dashboard.includes("activeTab={view}"));
  });

  it("la comparativa es la misma CocoaTable con una columna delta por métrica (badge con tono por signo) y la media en el pie", () => {
    for (const metric of COMPARE_METRICS) assert.ok(dashboard.includes(`"${metric}"`), metric);
    assert.ok(dashboard.includes("deltaTone(row.delta[metric])"));
    assert.ok(dashboard.includes("deltaLabel(metric, row.delta[metric])"));
    assert.ok(dashboard.includes("label: `${label} vs media`"));
    assert.ok(dashboard.includes('name: "Media simple de la cartera"'));
    assert.ok(dashboard.includes('caption="Comparativa de la cartera"'));
    assert.ok(dashboard.includes('caption="Propiedades de la cartera"'), "la vista Tabla conserva su nombre accesible (measure d3/d4)");
    assert.equal(count(dashboard, "onSelect={(row) => navigateToProperty(row.propertyId)}"), 2, "Enter/clic en la fila abre el detalle en las dos vistas");
  });

  it("comandos de página: Comparar hoteles · Ordenar por ocupación · Ordenar por ingresos", () => {
    assert.ok(dashboard.includes('{ id: "cartera-comparar", label: "Comparar hoteles", run: () => setView("comparar") }'));
    assert.ok(dashboard.includes('{ id: "cartera-ordenar-ocupacion", label: "Ordenar por ocupación", run: () => sortByMetric("occupancyPct") }'));
    assert.ok(dashboard.includes('{ id: "cartera-ordenar-ingresos", label: "Ordenar por ingresos", run: () => sortByMetric("revenueMtdEur") }'));
  });

  it("orden y media viven en portfolio-compare.ts; 0 style= nuevos (2 como en la base); vocabulario «En el hotel»", () => {
    assert.ok(!/function compareRows/.test(dashboard));
    assert.ok(dashboard.includes('from "./portfolio-compare"'));
    assert.equal(count(dashboard, "style="), 2);
    assert.ok(!/\bEn casa\b/.test(dashboard));
    assert.ok(dashboard.includes('label="En el hotel"'));
  });
});

describe("PropertyDetailScreen · acciones del hotel", () => {
  it("«PyG del hotel» abre ProfitAndLossScreen con ?ambito= de la propiedad (la pantalla lee el ámbito de la URL)", () => {
    assert.ok(detail.includes('urlForScreen("ProfitAndLossScreen")'));
    assert.ok(detail.includes("withFinanceScopeParam(devQueryFrom(window.location.search), propertyId)"));
    assert.ok(detail.includes("PyG del hotel"));
    assert.ok(detail.includes('{ id: "cartera-propiedad-pyg", label: "PyG del hotel", run: () => openProfitAndLoss(propertyId) }'));
  });

  it("«Cierre del día» y «Exportar informe» solo para el hotel activo: deshabilitados con «Cambia a este hotel para verlo»", () => {
    assert.ok(detail.includes('const SWITCH_HINT = "Cambia a este hotel para verlo";'));
    assert.ok(detail.includes("const isActive = useMemo(() => propertyId === getActivePropertyId(), [propertyId]);"));
    assert.equal(count(detail, "disabled={!isActive} title={isActive ? undefined : SWITCH_HINT}"), 2);
    assert.ok(detail.includes('navigateTo("NightAuditScreen")'));
    assert.ok(detail.includes('navigateTo("ReportingCenter")'));
    assert.ok(detail.includes("...(isActive"), "los comandos ⌘K de cierre e informe solo se ofrecen para el hotel activo");
    assert.equal(count(detail, 'variant="filled"'), 1, "una sola acción primaria en la fila (P1)");
  });

  it("KPIs de hoy con el vocabulario de dirección y su ventana real (fecha de negocio del API · media del mes · mes natural)", () => {
    for (const label of ["Llegadas hoy", "Salidas hoy", "En el hotel"]) assert.ok(detail.includes(`label="${label}"`), label);
    // Corrector UX2-REV-01: property-overview cuenta la fecha de negocio (businessDate/businessDateSource aditivos) y la ficha la pinta.
    assert.equal(count(detail, "caption={todayWindow}"), 3);
    assert.ok(detail.includes("const todayWindow = todayWindowCaption(data ?? undefined);"));
    assert.ok(detail.includes("export function todayWindowCaption("));
    assert.ok(detail.includes('if (!overview?.businessDate) return "día natural (UTC)";'), "sin el campo (API antiguo) sigue diciendo día natural");
    assert.ok(detail.includes('return overview.businessDateSource === "utc_day" ? `día UTC ${day}` : `fecha de negocio ${day}`;'));
    assert.ok(detail.includes("businessDate?: string;") && detail.includes('businessDateSource?: "business_date" | "utc_day";'));
    assert.equal(count(detail, "caption={MONTH_AVERAGE_WINDOW}"), 3);
    assert.ok(detail.includes('caption="mes natural"'));
  });

  it("Cartera: la tira «Llegadas hoy · Salidas hoy · En el hotel» dice su ventana y el delta de Comparar no va en mayúsculas (UX2-REV-01/11)", () => {
    assert.ok(dashboard.includes('const TODAY_WINDOW = "fecha de negocio de cada hotel";'));
    assert.equal(count(dashboard, "caption={TODAY_WINDOW}"), 3);
    assert.ok(dashboard.includes('<CocoaBadge tone={deltaTone(row.delta[metric])} size="small" uppercase={false}>'), "«+3,2 pp», nunca «PP»");
  });

  it("0 style= nuevos (2 como en la base)", () => {
    assert.equal(count(detail, "style="), 2);
  });
});
