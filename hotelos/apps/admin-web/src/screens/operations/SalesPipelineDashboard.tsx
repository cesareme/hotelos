// Ventas a empresas — Comercial › Ventas a empresas (/comercial/ventas-empresas).
//
// Cocoa 22 · ola 7 · lote 7-C: standalone dashboard (template
// DashboardStandalone, pilot ShiftManagerScreen): KPI strip → 6/6 row (cartera
// por fase with scaled bars · principales cuentas) → oportunidades recientes.
// Read only; GET /dashboards/sales-pipeline every two minutes.

import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { toArray } from "../../utils/toArray";
import { date, money, number, percent, plural } from "../../lib/format";
import { ACTIONS, STATUS_LABELS, errorStateFor } from "../../content/actions";
import { treeHeaderFor } from "../tabs/tab-helpers";
import {
  CocoaBadge,
  CocoaButton,
  CocoaChart,
  CocoaGrid,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  CocoaTable,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

const PROPERTY_ID = getActivePropertyId();
// Menu labels of the tree (Comercial › Ventas a empresas), never retyped here.
const HEADER = treeHeaderFor("SalesPipelineDashboard", { eyebrow: "Comercial", title: "Ventas a empresas" });
const LOAD_ERROR = errorStateFor("las ventas a empresas");

type StageRow = { stage: string; count: number; totalValue: number };
type AccountRow = { accountName: string; openOpps: number; totalValue: number };
type Opportunity = {
  id: string;
  name: string;
  stage: string;
  expectedValue?: number;
  probability?: number;
  accountName?: string;
  expectedCloseDate?: string;
};

type SalesPipelineDashboardData = {
  kpis: {
    openOpportunities: number;
    pipelineValueEur: number;
    weightedPipelineEur: number;
    closedWonMtdEur: number;
    conversionRatePct: number;
  };
  opportunitiesByStage: StageRow[];
  topAccounts: AccountRow[];
  recentOpportunities: Opportunity[];
};

// Funnel bars are scaled to the largest stage (as the legacy bars were); the
// row carries the maximum so the cell can read it.
type StageTableRow = StageRow & { maxCount: number };

const WON_STAGES = new Set(["won", "closed_won", "closed-won", "closedwon"]);
const LOST_STAGES = new Set(["lost", "closed_lost", "closed-lost", "closedlost"]);

function normaliseStage(stage: string): string {
  return stage.toLowerCase().replace(/[\s-]+/g, "_").trim();
}

function stageTone(stage: string): CocoaTone {
  const key = normaliseStage(stage);
  if (WON_STAGES.has(key)) return "success";
  if (LOST_STAGES.has(key)) return "danger";
  return "warning";
}

const STAGE_COLUMNS: CocoaTableColumn<StageTableRow>[] = [
  { key: "stage", label: "Fase", fit: true, render: (row) => <CocoaBadge tone={stageTone(row.stage)}>{row.stage}</CocoaBadge> },
  { key: "count", label: "Número", align: "right", fit: true, render: (row) => number(row.count) },
  {
    key: "funnel",
    label: "Embudo",
    minWidth: 120,
    render: (row) => (
      <CocoaChart.Progress
        value={row.maxCount > 0 ? Math.max(row.count > 0 ? 2 : 0, (row.count / row.maxCount) * 100) : 0}
        showValue={false}
        aria-label={plural(row.count, "oportunidad", "oportunidades")}
      />
    )
  },
  { key: "totalValue", label: "Valor total", align: "right", fit: true, render: (row) => money(row.totalValue) }
];

const ACCOUNT_COLUMNS: CocoaTableColumn<AccountRow>[] = [
  { key: "accountName", label: "Cuenta", render: (row) => <strong>{row.accountName}</strong> },
  { key: "openOpps", label: "Abiertas", align: "right", fit: true, render: (row) => number(row.openOpps) },
  { key: "totalValue", label: "Valor total", align: "right", fit: true, render: (row) => money(row.totalValue) }
];

const RECENT_COLUMNS: CocoaTableColumn<Opportunity>[] = [
  { key: "name", label: "Oportunidad", minWidth: 160, render: (row) => <strong>{row.name}</strong> },
  { key: "accountName", label: "Cuenta", hideOnNarrow: true, render: (row) => row.accountName ?? "—" },
  { key: "stage", label: "Fase", fit: true, render: (row) => <CocoaBadge tone={stageTone(row.stage)}>{row.stage}</CocoaBadge> },
  { key: "expectedValue", label: "Valor previsto", align: "right", fit: true, render: (row) => (row.expectedValue !== undefined ? money(row.expectedValue) : "—") },
  { key: "probability", label: "Probabilidad", align: "right", fit: true, render: (row) => percent(row.probability, { ratio: true, maximumFractionDigits: 0 }) },
  { key: "expectedCloseDate", label: "Cierre previsto", fit: true, hideOnNarrow: true, render: (row) => date(row.expectedCloseDate) }
];

// Skeleton espejo: strip of 5 tiles, then 6/6 · 12.
function PipelineSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={5} />
      <CocoaSkeleton.Grid rows={[[6, 6], [12]]} height={200} />
    </div>
  );
}

export function SalesPipelineDashboard() {
  const { data, loading, error, refresh } = useApiData<SalesPipelineDashboardData>(`/dashboards/sales-pipeline?propertyId=${PROPERTY_ID}`, {
    pollIntervalMs: 120000
  });

  const kpis = data?.kpis;
  const opportunitiesByStage = toArray<StageRow>(data?.opportunitiesByStage);
  const topAccounts = toArray<AccountRow>(data?.topAccounts);
  const recentOpportunities = toArray<Opportunity>(data?.recentOpportunities);

  const maxStageCount = opportunitiesByStage.reduce((max, row) => Math.max(max, row.count), 0);
  const stageRows: StageTableRow[] = opportunitiesByStage.map((row) => ({ ...row, maxCount: maxStageCount }));

  const openStatus = kpis && kpis.openOpportunities > 0 ? "warning" : "ok";
  const pipelineStatus = kpis && kpis.pipelineValueEur > 0 ? "ok" : "warning";
  const wonStatus = kpis && kpis.closedWonMtdEur > 0 ? "ok" : "warning";
  const conversionStatus = !kpis ? "warning" : kpis.conversionRatePct >= 50 ? "ok" : kpis.conversionRatePct >= 25 ? "warning" : "critical";

  return (
    <CocoaPage
      eyebrow={`${HEADER.eyebrow} · ${getActiveProperty().propertyName}`}
      title={HEADER.title}
      subtitle="Embudo de ventas a empresas en solo lectura: oportunidades abiertas, valor ponderado, cuentas con más peso y conversión del periodo. Se calcula a partir de las oportunidades y las cuentas y se actualiza cada dos minutos."
      actions={
        <>
          {loading && data ? <CocoaBadge tone="info">{STATUS_LABELS.loading}</CocoaBadge> : null}
          {error && data ? <CocoaBadge tone="danger">{LOAD_ERROR.title}</CocoaBadge> : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      state={loading && !data ? "loading" : error && !data ? "error" : "ready"}
      skeleton={<PipelineSkeleton />}
      error={{ title: LOAD_ERROR.title, message: LOAD_ERROR.message, onRetry: refresh }}
      commands={[{ id: "ventas-empresas-refresh", label: "Actualizar las ventas a empresas", run: refresh }]}
    >
      {kpis ? (
        <>
          <CocoaKpiStrip stagger aria-label="Indicadores del embudo de ventas">
            <CocoaKpi label="Oportunidades abiertas" value={number(kpis.openOpportunities)} deltaLabel="en el embudo ahora mismo" polarity="neutral" status={openStatus} />
            <CocoaKpi label="Valor de la cartera" value={money(kpis.pipelineValueEur)} deltaLabel="suma de las oportunidades abiertas" polarity="neutral" status={pipelineStatus} />
            <CocoaKpi label="Cartera ponderada" value={money(kpis.weightedPipelineEur)} deltaLabel="valor × probabilidad" polarity="neutral" status="ok" />
            <CocoaKpi label="Ganadas este mes" value={money(kpis.closedWonMtdEur)} deltaLabel="desde el día 1 hasta hoy" polarity="neutral" status={wonStatus} />
            <CocoaKpi label="Tasa de conversión" value={percent(kpis.conversionRatePct)} deltaLabel="ganadas / (ganadas + perdidas) en el periodo" polarity="neutral" status={conversionStatus} />
          </CocoaKpiStrip>

          <CocoaGrid aria-label="Cartera por fase y principales cuentas" align="start">
            <CocoaSpan cols={6} min={320}>
              <CocoaSection title="Cartera por fase" meta={plural(opportunitiesByStage.length, "fase", "fases")} padding={stageRows.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
                {stageRows.length === 0 ? (
                  <CocoaState kind="empty" inline title="Todavía no hay oportunidades en esta propiedad." />
                ) : (
                  <CocoaTable columns={STAGE_COLUMNS} rows={stageRows} rowKey="stage" caption="Cartera por fase" aria-label="Cartera por fase" />
                )}
              </CocoaSection>
            </CocoaSpan>
            <CocoaSpan cols={6} min={320}>
              <CocoaSection title="Principales cuentas" meta={plural(topAccounts.length, "cuenta", "cuentas")} padding={topAccounts.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
                {topAccounts.length === 0 ? (
                  <CocoaState kind="empty" inline title="Sin cuentas con oportunidades abiertas." />
                ) : (
                  <CocoaTable columns={ACCOUNT_COLUMNS} rows={topAccounts} rowKey="accountName" caption="Principales cuentas" aria-label="Principales cuentas" />
                )}
              </CocoaSection>
            </CocoaSpan>
          </CocoaGrid>

          <CocoaSection title="Oportunidades recientes" meta={plural(recentOpportunities.length, "oportunidad", "oportunidades")} padding={recentOpportunities.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
            {recentOpportunities.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin oportunidades recientes." />
            ) : (
              <CocoaTable columns={RECENT_COLUMNS} rows={recentOpportunities} rowKey="id" caption="Oportunidades recientes" aria-label="Oportunidades recientes" />
            )}
          </CocoaSection>
        </>
      ) : null}
    </CocoaPage>
  );
}
