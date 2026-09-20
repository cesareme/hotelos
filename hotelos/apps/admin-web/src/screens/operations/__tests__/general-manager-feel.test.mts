// Contract test · Tanda UX-2 · lote D3 — Mi día › Dirección
// (screens/operations/GeneralManagerScreen.tsx): una verdad con su ventana, en
// español, con «Riesgos de hoy» y comandos ⌘K de tarea. Estático sobre el fuente
// (la pantalla carga api-client con `import.meta.env`), patrón de
// general-manager-reputation.test.mts:
//   · 0 rótulos ingleses de la lista F-D2 (Arrivals · Departures · OOO rooms ·
//     Net contribution · Pace · Pickup 7d · HK · Workforce · Safety · POS ·
//     Demand spikes 14d · vs LY · Revenue € · Forecast);
//   · subtítulo «Datos de la fecha de negocio DD/MM · actualizado HH:MM» desde
//     `businessDate`/`businessDateSource` (aditivos) y `time(generatedAt)`;
//   · deltas de la tira solo con base > 0 (deltaVsWeek: nunca «▲100 %» sobre 0);
//   · bloque «Riesgos de hoy» que reúne cierre (preflight, 60 s), pendientes de
//     aprobación (listPendingApprovals + pendingForViewer, solo con clave), IA
//     (/ai-operations/review/stats, solo con ai_governance.read), riesgo de
//     cancelación y anomalías, cada fila con un CocoaButton hacia su pantalla;
//   · comandos general-manager-pendientes · -cierre · -cartera · -exportar;
//   · density comfortable; style={ no crece (6, techo T8 10); skeleton pinado intacto.
// Desde apps/api:
//   TSX_TSCONFIG_PATH=../admin-web/tsconfig.json node --import tsx --test ../admin-web/src/screens/operations/__tests__/general-manager-feel.test.mts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const src = readFileSync(new URL("../GeneralManagerScreen.tsx", import.meta.url), "utf8");

/** Fuente sin comentarios (los comentarios describen la historia; el contrato es sobre los literales que ve dirección). */
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Rótulos ingleses del recon UX-2 (delta 5 · F-D2): ninguno puede seguir en un literal. */
const ENGLISH_LABELS = [
  '"Arrivals"',
  '"Departures"',
  '"OOO rooms"',
  '"Net contribution"',
  "Pace próximos 30 días",
  '"Pickup 7d"',
  'title="HK"',
  '"Workforce"',
  '"Safety"',
  'title="POS"',
  "Demand spikes 14d",
  "vs LY",
  "Revenue €",
  '"Forecast"',
  'centerLabel="revenue"',
  'primaryLabel="OOO"',
  'deltaLabel="proxy"'
] as const;

/** Rótulos que los sustituyen (una verdad en español). */
const SPANISH_LABELS = [
  'label="Llegadas"',
  'label="Salidas"',
  'label="Bloqueadas"',
  'title="Contribución neta"',
  'label="Contribución neta"',
  'title="Ritmo 30 días"',
  'title="Captación 7 días"',
  'title="Pisos"',
  'title="Personal"',
  'title="Seguridad"',
  'title="TPV"',
  'title="Picos de demanda 14 días"',
  'title="Riesgo cancelación"',
  'yLabel="Ingresos €"',
  'label: "Previsión"'
] as const;

const STYLE_CEILING = 6;

describe("Mi día › Dirección · español (F-D2)", () => {
  it("0 rótulos ingleses de la lista en el código (fuera de comentarios)", () => {
    for (const label of ENGLISH_LABELS) {
      assert.ok(!code.includes(label), `sigue el rótulo inglés ${label}`);
    }
  });

  it("los rótulos en español existen: Llegadas · Salidas · Bloqueadas · Contribución neta · Ritmo 30 días · Captación 7 días · Pisos · Personal · Seguridad · TPV · Picos de demanda 14 días", () => {
    for (const label of SPANISH_LABELS) {
      assert.ok(code.includes(label), `falta el rótulo ${label}`);
    }
  });

  it("la captación dice «frente al año anterior» y nunca «vs LY»", () => {
    assert.match(code, /frente al año anterior: —/);
    assert.match(code, /meta="neto frente al año anterior"/);
  });
});

describe("Mi día › Dirección · una verdad con su ventana (F-D1)", () => {
  it("el tipo Data gana businessDate y businessDateSource (aditivos, alineados con el API)", () => {
    assert.match(code, /businessDate\?: string;/);
    assert.match(code, /businessDateSource\?: "business_date" \| "utc_day";/);
  });

  it("subtítulo «Datos de la fecha de negocio DD/MM · actualizado HH:MM» (y dice «día UTC» sin fila)", () => {
    assert.match(code, /function windowSubtitle\(/);
    assert.match(code, /Datos de la fecha de negocio \$\{day\}/);
    assert.match(code, /Datos del día UTC \$\{day\}/);
    assert.match(code, /· actualizado \$\{time\(k\.generatedAt\)\}/);
    assert.match(code, /subtitle=\{k \? windowSubtitle\(k\) : /);
    assert.match(code, /function ddmm\(iso\?: string\): string/);
    assert.doesNotMatch(code, /asoFLabel/);
  });

  it("los deltas de la tira solo se pintan con base > 0 (deltaVsWeek) y se llaman «vs hace 7 días»", () => {
    assert.match(code, /function deltaVsWeek\(compare: Compare\): number \| undefined \{\s*const base = compare\.vsLastWeek;\s*if \(!base \|\| !\(base\.value > 0\)\) return undefined;\s*return base\.pct;/);
    for (const kpi of ["occupancy", "adr", "revpar", "revenue"]) {
      assert.ok(code.includes(`deltaVsWeek(k.${kpi}.today)`), `el KPI ${kpi} no pasa por deltaVsWeek`);
    }
    assert.doesNotMatch(code, /vsLastWeek\?\.pct/);
    assert.equal((code.match(/deltaLabel=\{[a-z]+VsWeekPct === undefined \? "sin base de comparación" : "vs hace 7 días"\}/g) ?? []).length, 4);
  });

  it("llegadas y salidas se rotulan como pendientes (regla del preflight) y la caja dice su fecha de negocio", () => {
    assert.match(code, /label="Llegadas" value=\{fmtNumber\(arrivals\)\} deltaLabel="pendientes de llegar"/);
    assert.match(code, /label="Salidas" value=\{fmtNumber\(departures\)\} deltaLabel="pendientes de salir"/);
    assert.match(code, /<CocoaSection title="Caja de hoy" meta=\{`fecha de negocio \$\{businessDay\}`\}>/);
    assert.match(code, /function CashList\(/);
  });
});

describe("Mi día › Dirección · «Riesgos de hoy»", () => {
  const block = code.slice(code.indexOf("function buildRiskRows("), code.indexOf("interface CashListProps"));

  it("existe el bloque con su lista, sus fuentes y una acción por fila hacia su pantalla", () => {
    assert.ok(block.length > 0, "buildRiskRows precede a CashList");
    assert.match(code, /<CocoaSection\s+title="Riesgos de hoy"\s+meta=\{`fecha de negocio \$\{businessDay\}`\}/);
    assert.match(code, /<RisksList risks=\{risks\}/);
    assert.match(block, /navigateTo\("NightAuditScreen"\)/);
    assert.match(block, /navigateTo\("ApprovalsInbox"\)/);
    assert.match(block, /navigateTo\("AiHumanReviewQueueScreen"\)/);
    assert.match(block, /navigateTo\("ReservationsListScreen"\)/);
    assert.match(block, /navigateTo\("RevenueHomeDashboard"\)/);
    // Cada fila con acción la pinta con CocoaButton (una por fila) y sin estilos locales.
    assert.match(block, /<CocoaButton variant="tinted" tone="accent" size="small" onClick=\{row\.action\.onClick\}>/);
    assert.match(block, /<CocoaBadge tone=\{row\.tone\}/);
    assert.doesNotMatch(block, /\bstyle=\{/, "el bloque de riesgos no pinta style={");
  });

  it("bloqueos del cierre: preflight con pollIntervalMs 60000, summary.blocker + blockingMessage", () => {
    assert.match(code, /useApiData<PreflightSummary>\(`\/properties\/\$\{propertyId\}\/night-audit\/preflight`, \{\s*pollIntervalMs: 60000\s*\}\)/);
    assert.match(block, /preflight\?\.summary\.blocker/);
    assert.match(block, /preflight\.blockingMessage/);
    assert.match(block, /title: "Cierre del día"/);
  });

  it("pendientes de aprobación: listPendingApprovals + pendingForViewer solo con clave de aprobación", () => {
    assert.match(code, /import \{ listPendingApprovals \} from "\.\.\/\.\.\/services\/approvalsApi";/);
    assert.match(code, /import \{ hasApprovalKeys, pendingForViewer, viewerFromProfile \} from "\.\.\/approvals\/approvals-helpers";/);
    assert.match(code, /const approver = hasApprovalKeys\(gate\.grantedPermissions\);/);
    assert.match(code, /if \(!approver\) return undefined;/);
    assert.match(code, /listPendingApprovals\(\)\s*\.then\(\(rows\) => pendingForViewer\(rows, viewer\)\.length\)/);
    assert.match(code, /pendingApprovals: approver \? pendingApprovals : null/);
    assert.match(block, /if \(risks\.pendingApprovals !== null\) \{/);
    assert.match(block, /title: "Pendientes de aprobación"/);
  });

  it("pendientes de la IA: /ai-operations/review/stats solo con ai_governance.read (enabled)", () => {
    assert.match(code, /const AI_REVIEW_KEY = "ai_governance\.read";/);
    assert.match(code, /const canReadAi = \(gate\.grantedPermissions \?\? \[\]\)\.includes\(AI_REVIEW_KEY\);/);
    assert.match(code, /useApiData<ReviewStats>\("\/ai-operations\/review\/stats", \{\s*query: \{ organizationId \},\s*pollIntervalMs: 60000,\s*enabled: canReadAi\s*\}\)/);
    assert.match(code, /pendingAi: canReadAi \? aiStats\?\.pending : null/);
    assert.match(block, /if \(risks\.pendingAi !== null\) \{/);
    assert.match(block, /title: "Pendientes de la IA"/);
  });

  it("riesgo de cancelación y anomalías viven en el bloque; el gauge de la fila 2 se queda sin botón y la lista antigua desaparece", () => {
    assert.match(block, /title: "Riesgo de cancelación"/);
    assert.match(block, /title: `Anomalía · \$\{a\.kind\.replace\(\/_\/g, " "\)\}`/);
    assert.match(block, /Sin anomalías detectadas frente al año anterior\./);
    assert.match(code, /<CocoaSection title="Riesgo cancelación" meta="próximos 14 días">/);
    assert.doesNotMatch(code, /Revisar →/);
    assert.doesNotMatch(code, /centerRowStyle/);
    assert.doesNotMatch(code, /AnomaliesList/);
    assert.doesNotMatch(code, /title="Anomalías hoy"/);
  });
});

describe("Mi día › Dirección · comandos ⌘K y densidad (F-D11, P5)", () => {
  it("registra las tareas de dirección como comandos de página con ids estables", () => {
    for (const [id, screen] of [
      ["general-manager-pendientes", "ApprovalsInbox"],
      ["general-manager-cierre", "NightAuditScreen"],
      ["general-manager-cartera", "PortfolioDashboard"],
      ["general-manager-exportar", "ReportingCenter"]
    ] as const) {
      const re = new RegExp(`\\{ id: "${id}", label: "[^"]+", run: \\(\\) => navigateTo\\("${screen}"\\) \\}`);
      assert.match(code, re, `falta el comando ${id} → ${screen}`);
    }
    assert.match(code, /\{ id: "general-manager-refresh", label: "Actualizar dashboard del director", run: refresh \}/);
  });

  it("density comfortable (paneles de dirección, UX-1 P5)", () => {
    assert.match(code, /<CocoaPage[\s\S]*?density="comfortable"[\s\S]*?commands=\{\[/);
  });

  it(`style={ no crece (≤ ${STYLE_CEILING}) y el skeleton pinado por T8 sigue intacto con la fila de riesgos añadida`, () => {
    const n = (src.match(/\bstyle=\{/g) ?? []).length;
    assert.ok(n <= STYLE_CEILING, `GeneralManagerScreen tiene ${n} style={ (techo ${STYLE_CEILING})`);
    assert.match(src, /<CocoaSkeleton\.Strip count=\{11\} label="Cargando indicadores de hoy…" \/>\s*<CocoaSkeleton\.Grid rows=\{\[\[12\]\]\} height=\{200\} label="Cargando riesgos de hoy…" \/>\s*<CocoaSkeleton\.Grid rows=\{\[\[8, 2, 2\], \[4, 4, 2, 2\]\]\} label="Cargando pace y mix…" \/>/);
    assert.match(src, /<CocoaSkeleton\.Grid rows=\{\[\[5, 4, 3\]\]\} label="Cargando insights…" \/>/);
  });
});
