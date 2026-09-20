// Contrato estático · Tanda UX-2 · lote D8 — Mi día › Operaciones
// (screens/operations/OperationsDirectorScreen.tsx). Estático sobre el fuente
// (la pantalla carga api-client con `import.meta.env`), patrón de
// general-manager-feel.test.mts:
//   · destinos del drill-down por puntero: `mobileDrillDown(tier, coarse)` es
//     puro (phone + coarse ⇒ móvil; cualquier otra combinación ⇒ tablero) y
//     los builders de Pisos / Mantenimiento navegan a HousekeepingDashboard /
//     MaintenanceDashboard salvo en móvil (HousekeepingMobileScreen /
//     MaintenanceMobileScreen); ya no hay navigateTo("…MobileScreen") directo;
//   · comandos ⌘K de tarea: «Ver alertas» (pestaña alertas), «Ir a pisos» e
//     «Ir a mantenimiento» (mismo destino por puntero) además de «Actualizar»;
//   · densidad: las cuatro tablas de detalle van en `comfortable` (P5: panel
//     de dirección, no lista operativa) y ninguna en `compact`;
//   · style={ no crece (3).
// Desde apps/admin-web:
//   node --import ../api/node_modules/tsx/dist/loader.mjs --test src/screens/operations/__tests__/operations-director-feel.test.mts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const src = readFileSync(new URL("../OperationsDirectorScreen.tsx", import.meta.url), "utf8");
/** Fuente sin comentarios (los comentarios cuentan la historia; el contrato es sobre el código). */
const code = src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const STYLE_CEILING = 3;
const TIERS = ["phone", "tablet", "laptop", "desktop"] as const;

/** Evalúa la expresión pura de `mobileDrillDown` tal como está escrita (sin importar la pantalla). */
function mobileDrillDownOf(source: string): (tier: string, coarse: boolean) => boolean {
  const match = /export function mobileDrillDown\(tier: CocoaViewportTier, coarse: boolean\): boolean \{\s*return ([^;]+);\s*\}/.exec(source);
  assert.ok(match, "falta `export function mobileDrillDown(tier, coarse): boolean { return …; }`");
  return new Function("tier", "coarse", `return (${match[1]});`) as (tier: string, coarse: boolean) => boolean;
}

describe("Mi día › Operaciones · drill-down por puntero (P2/P5)", () => {
  it("mobileDrillDown es puro: solo un teléfono con puntero grueso va a las pantallas móviles", () => {
    const mobile = mobileDrillDownOf(code);
    assert.equal(mobile("phone", true), true, "phone + coarse ⇒ móvil");
    assert.equal(mobile("phone", false), false, "phone + puntero fino ⇒ tablero");
    for (const tier of TIERS.filter((value) => value !== "phone")) {
      assert.equal(mobile(tier, true), false, `${tier} + coarse ⇒ tablero`);
      assert.equal(mobile(tier, false), false, `${tier} + puntero fino ⇒ tablero`);
    }
  });

  it("lee el tier de cocoa-viewport y el puntero de useCoarsePointer y calcula `mobile` una vez", () => {
    assert.match(code, /import \{ useCoarsePointer \} from "\.\.\/\.\.\/lib\/useCoarsePointer";/);
    assert.match(code, /\buseViewportTier,/, "useViewportTier importado de components/cocoa");
    assert.match(code, /type CocoaViewportTier\b/);
    assert.match(code, /const tier = useViewportTier\(\);\s*const coarse = useCoarsePointer\(\);/);
    assert.match(code, /const mobile = mobileDrillDown\(tier, coarse\);/);
  });

  it("Pisos y Mantenimiento navegan al tablero con puntero fino y a la vista móvil solo en móvil", () => {
    assert.match(code, /housekeeping: \{ board: "HousekeepingDashboard", mobile: "HousekeepingMobileScreen" \}/);
    assert.match(code, /maintenance: \{ board: "MaintenanceDashboard", mobile: "MaintenanceMobileScreen" \}/);
    assert.match(code, /export function drillDownScreen\(module: keyof typeof DRILL_DOWN_SCREENS, mobile: boolean\): ScreenKey \{\s*return mobile \? DRILL_DOWN_SCREENS\[module\]\.mobile : DRILL_DOWN_SCREENS\[module\]\.board;/);
    assert.match(code, /function buildHkMiniProps\(mc: MiniCards\["housekeeping"\], deltaDegraded: boolean, mobile: boolean\)/);
    assert.match(code, /function buildMaintenanceMiniProps\(mc: MiniCards\["maintenance"\], deltaDegraded: boolean, mobile: boolean\)/);
    assert.match(code, /onDrillDown: \(\) => navigateTo\(drillDownScreen\("housekeeping", mobile\)\)/);
    assert.match(code, /onDrillDown: \(\) => navigateTo\(drillDownScreen\("maintenance", mobile\)\)/);
    assert.match(code, /buildHkMiniProps\(miniCards\.housekeeping, isDegraded\(DEGRADED_LABEL\.hkDelta, degraded\), mobile\)/);
    assert.match(code, /buildMaintenanceMiniProps\(miniCards\.maintenance, isDegraded\(DEGRADED_LABEL\.maintenanceDelta, degraded\), mobile\)/);
    assert.doesNotMatch(code, /navigateTo\("HousekeepingMobileScreen"\)/, "drill-down directo a la vista móvil de pisos");
    assert.doesNotMatch(code, /navigateTo\("MaintenanceMobileScreen"\)/, "drill-down directo a la vista móvil de mantenimiento");
  });

  it("el resto de tarjetas de salud siguen yendo a su tablero (Personal · Seguridad · TPV)", () => {
    assert.match(code, /navigateTo\("WorkforceDashboard"\)/);
    assert.match(code, /navigateTo\("SafetyDashboard"\)/);
    assert.match(code, /navigateTo\("PosDashboard"\)/);
  });
});

describe("Mi día › Operaciones · comandos ⌘K de tarea (F-D11)", () => {
  it("registra Actualizar · Ver alertas · Ir a pisos · Ir a mantenimiento", () => {
    assert.match(code, /\{ id: "operations-director-refresh", label: "Actualizar estado operativo", run: refresh \}/);
    assert.match(code, /\{ id: "operations-director-alertas", label: "Ver alertas", run: \(\) => setActiveTab\("alertas"\) \}/);
    assert.match(code, /\{ id: "operations-director-pisos", label: "Ir a pisos", run: \(\) => navigateTo\(drillDownScreen\("housekeeping", mobile\)\) \}/);
    assert.match(code, /\{ id: "operations-director-mantenimiento", label: "Ir a mantenimiento", run: \(\) => navigateTo\(drillDownScreen\("maintenance", mobile\)\) \}/);
    assert.match(code, /\{ value: "alertas", label: `Alertas \(\$\{number\(alerts\.length\)\}\)` \}/, "la pestaña «Alertas» a la que va «Ver alertas» sigue existiendo");
  });

  it("los ids de comando son únicos", () => {
    const ids = Array.from(code.matchAll(/id: "(operations-director-[a-z-]+)"/g), (m) => m[1]);
    assert.equal(ids.length, 4);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe("Mi día › Operaciones · densidad y estilos (P5, Cocoa)", () => {
  it("las cuatro tablas de detalle van en comfortable y ninguna en compact", () => {
    // Cada tabla va en una línea (el genérico `toArray<…>(…)` impide cortar por «>»).
    const tables = code.split("\n").filter((line) => line.includes("<CocoaTable "));
    assert.equal(tables.length, 4, `${tables.length} CocoaTable`);
    for (const table of tables) assert.match(table, /density="comfortable"/, table.trim().slice(0, 80));
    assert.doesNotMatch(code, /density="compact"/);
  });

  it(`style={ no crece (techo ${STYLE_CEILING})`, () => {
    const count = (code.match(/\bstyle=\{/g) ?? []).length;
    assert.ok(count <= STYLE_CEILING, `${count} style={ > ${STYLE_CEILING}`);
  });
});
