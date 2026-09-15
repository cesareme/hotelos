// Assets dashboard — Operaciones › Activos (/operaciones/activos).
//
// Cocoa 22 (docs/design/COCOA-22.md §4 · ola 4 · lote 4-C): CocoaPage →
// CocoaKpiStrip → CocoaGrid 6/6 × 2 with CocoaTable (assets by category, top
// assets, capex projects with CocoaChart.Progress) and the warranty
// expirations as a section list. Read only; GET /dashboards/assets is
// consolidated every 5 minutes.

import type { CSSProperties } from "react";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { ACTIONS, FIELD_LABELS, STATUS_LABELS, errorStateFor } from "../../content/actions";
import { treeHeaderFor } from "../tabs/tab-helpers";
import { date, money, number, percent, plural } from "../../lib/format";
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
// Menu labels of the tree (Operaciones › Activos), never retyped here.
const HEADER = treeHeaderFor("AssetsDashboard", { eyebrow: "Operaciones", title: "Activos" });
const LOAD_ERROR = errorStateFor("el registro de activos");

type CategoryRow = { category: string; count: number; netBookValueEur: number };
type TopAsset = {
  id: string;
  name: string;
  category?: string;
  acquisitionValueEur: number;
  netBookValueEur: number;
  acquisitionDate?: string;
};
type CapexProject = {
  id: string;
  name: string;
  status: string;
  budgetEur?: number;
  spentEur?: number;
  progressPct?: number;
};
type WarrantyRow = { id: string; assetName: string; warrantyEndsAt: string };
type AssetsDashboardData = {
  kpis: {
    totalAssets: number;
    totalNetBookValueEur: number;
    depreciationMtdEur: number;
    openCapexProjects: number;
    nextWarrantyExpiries: number;
  };
  assetsByCategory: CategoryRow[];
  topAssets: TopAsset[];
  capexProjects: CapexProject[];
  upcomingWarrantyExpirations: WarrantyRow[];
};

const EMPTY: AssetsDashboardData = {
  kpis: {
    totalAssets: 0,
    totalNetBookValueEur: 0,
    depreciationMtdEur: 0,
    openCapexProjects: 0,
    nextWarrantyExpiries: 0
  },
  assetsByCategory: [],
  topAssets: [],
  capexProjects: [],
  upcomingWarrantyExpirations: []
};

const CLOSED_STATUSES = new Set(["completed", "closed", "done"]);
// API status codes of a capex project → Spanish label (unknown codes fall back to the code).
const CAPEX_STATUS_LABEL: Record<string, string> = {
  completed: STATUS_LABELS.completed,
  done: STATUS_LABELS.completed,
  closed: "Cerrado",
  cancelled: STATUS_LABELS.cancelled,
  in_progress: STATUS_LABELS.inProgress,
  approved: STATUS_LABELS.approved,
  pending: STATUS_LABELS.pending,
  draft: STATUS_LABELS.draft,
  planned: "Planificado"
};

function capexTone(status: string): CocoaTone {
  if (CLOSED_STATUSES.has(status)) return "success";
  if (status === "cancelled") return "danger";
  if (status === "in_progress" || status === "approved") return "warning";
  return "neutral";
}

function daysUntil(iso: string): number | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((d.getTime() - Date.now()) / 86_400_000);
}

function warrantyTone(days: number): CocoaTone {
  if (days <= 30) return "danger";
  if (days <= 60) return "warning";
  return "success";
}

function progressTone(pct: number): CocoaTone {
  if (pct >= 100) return "danger";
  if (pct >= 80) return "warning";
  return "accent";
}

// Secondary line under a cell value or a list row: caption secondary.
const subStyle: CSSProperties = {
  display: "block",
  fontSize: "var(--cocoa-fs-caption)",
  fontWeight: "var(--cocoa-fw-regular)" as CSSProperties["fontWeight"],
  color: "var(--cocoa-label-secondary)"
};
const growStyle: CSSProperties = { flex: "1 1 auto", minWidth: 0 };

const CATEGORY_COLUMNS: CocoaTableColumn<CategoryRow>[] = [
  { key: "category", label: "Categoría", render: (r) => <strong>{r.category}</strong> },
  { key: "count", label: FIELD_LABELS.quantity, align: "right", render: (r) => number(r.count) },
  { key: "netBookValueEur", label: "Valor neto contable", align: "right", render: (r) => money(r.netBookValueEur) }
];

const TOP_ASSET_COLUMNS: CocoaTableColumn<TopAsset>[] = [
  {
    key: "name",
    label: "Activo",
    render: (a) => (
      <>
        <strong>{a.name}</strong>
        {a.acquisitionDate ? <span style={subStyle}>adquirido el {date(a.acquisitionDate)}</span> : null}
      </>
    )
  },
  { key: "category", label: "Categoría", hideOnNarrow: true, render: (a) => a.category ?? "—" },
  { key: "acquisitionValueEur", label: "Adquisición", align: "right", render: (a) => money(a.acquisitionValueEur) },
  { key: "netBookValueEur", label: "Valor neto", align: "right", render: (a) => money(a.netBookValueEur) }
];

const CAPEX_COLUMNS: CocoaTableColumn<CapexProject>[] = [
  { key: "name", label: "Proyecto", render: (p) => <strong>{p.name}</strong> },
  {
    key: "status",
    label: FIELD_LABELS.status,
    render: (p) => (
      <CocoaBadge tone={capexTone(p.status)} variant="tinted" size="small">
        {CAPEX_STATUS_LABEL[p.status] ?? p.status}
      </CocoaBadge>
    )
  },
  { key: "budgetEur", label: "Presupuesto", align: "right", hideOnNarrow: true, render: (p) => (p.budgetEur !== undefined ? money(p.budgetEur) : "—") },
  { key: "spentEur", label: "Gastado", align: "right", render: (p) => (p.spentEur !== undefined ? money(p.spentEur) : "—") },
  {
    key: "progressPct",
    label: "Avance",
    minWidth: 140,
    render: (p) =>
      p.progressPct !== undefined ? (
        <CocoaChart.Progress value={p.progressPct} tone={progressTone(p.progressPct)} aria-label={`Avance ${percent(p.progressPct)}`} />
      ) : (
        "—"
      )
  }
];

export function AssetsDashboard() {
  const propertyName = getActiveProperty().propertyName;
  const state = useApiData<AssetsDashboardData>(
    `/dashboards/assets?propertyId=${PROPERTY_ID}`,
    { pollIntervalMs: 300000 }
  );

  const data = state.data ?? EMPTY;
  const { kpis, assetsByCategory, topAssets, capexProjects, upcomingWarrantyExpirations } = data;
  const pageState = state.loading && !state.data ? "loading" : state.error && !state.data ? "error" : "ready";

  return (
    <CocoaPage
      eyebrow={`${HEADER.eyebrow} · ${propertyName}`}
      title={HEADER.title}
      subtitle="Registro de activos físicos y proyectos de inversión: valor neto contable, amortización del mes (estimada), proyectos abiertos y garantías próximas a vencer. Datos consolidados cada 5 minutos."
      actions={
        <>
          {state.error && state.data ? (
            <CocoaBadge tone="danger" title={state.error}>
              {STATUS_LABELS.loadError}
            </CocoaBadge>
          ) : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => state.refresh()} title={ACTIONS.refresh}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      state={pageState}
      skeleton={<AssetsSkeleton />}
      error={{ title: LOAD_ERROR.title, message: LOAD_ERROR.message, onRetry: () => state.refresh() }}
      commands={[{ id: "assets-refresh", label: "Actualizar activos", run: () => state.refresh() }]}
    >
      <CocoaKpiStrip stagger aria-label="Indicadores de activos">
        <CocoaKpi label="Activos" value={number(kpis.totalAssets)} deltaLabel="en el registro" polarity="neutral" status="ok" />
        <CocoaKpi
          label="Valor neto contable"
          value={money(kpis.totalNetBookValueEur, { compact: true })}
          deltaLabel={money(kpis.totalNetBookValueEur)}
          polarity="neutral"
          status="ok"
        />
        <CocoaKpi label="Amortización del mes" value={money(kpis.depreciationMtdEur, { compact: true })} deltaLabel="estimación lineal" polarity="neutral" status="ok" />
        <CocoaKpi
          label="Inversiones abiertas"
          value={number(kpis.openCapexProjects)}
          deltaLabel="proyectos activos"
          polarity="neutral"
          status={kpis.openCapexProjects > 0 ? "warning" : "ok"}
        />
        <CocoaKpi
          label="Garantías · 30 días"
          value={number(kpis.nextWarrantyExpiries)}
          deltaLabel="vencen pronto"
          polarity="neutral"
          status={kpis.nextWarrantyExpiries > 0 ? "warning" : "ok"}
        />
      </CocoaKpiStrip>

      <CocoaGrid align="start">
        <CocoaSpan cols={6} min={320}>
          <CocoaSection
            title="Activos por categoría"
            meta={plural(assetsByCategory.length, "categoría", "categorías")}
            padding={assetsByCategory.length === 0 ? "md" : "none"}
            style={{ overflow: "clip" }}
          >
            {assetsByCategory.length === 0 ? (
              <CocoaState kind="empty" inline title="No hay activos registrados." />
            ) : (
              <CocoaTable columns={CATEGORY_COLUMNS} rows={assetsByCategory} rowKey="category" caption="Activos por categoría" aria-label="Activos por categoría" />
            )}
          </CocoaSection>
        </CocoaSpan>

        <CocoaSpan cols={6} min={320}>
          <CocoaSection
            title="Activos de mayor valor"
            meta={plural(topAssets.length, "activo", "activos")}
            padding={topAssets.length === 0 ? "md" : "none"}
            style={{ overflow: "clip" }}
          >
            {topAssets.length === 0 ? (
              <CocoaState kind="empty" inline title="No hay activos que mostrar." />
            ) : (
              <CocoaTable columns={TOP_ASSET_COLUMNS} rows={topAssets} rowKey="id" caption="Activos de mayor valor" aria-label="Activos de mayor valor" />
            )}
          </CocoaSection>
        </CocoaSpan>

        <CocoaSpan cols={6} min={320}>
          <CocoaSection
            title="Proyectos de inversión"
            meta={plural(capexProjects.length, "proyecto", "proyectos")}
            padding={capexProjects.length === 0 ? "md" : "none"}
            style={{ overflow: "clip" }}
          >
            {capexProjects.length === 0 ? (
              <CocoaState kind="empty" inline title="No hay proyectos de inversión registrados." />
            ) : (
              <CocoaTable columns={CAPEX_COLUMNS} rows={capexProjects} rowKey="id" caption="Proyectos de inversión" aria-label="Proyectos de inversión" />
            )}
          </CocoaSection>
        </CocoaSpan>

        <CocoaSpan cols={6} min={320}>
          <CocoaSection title="Garantías que vencen (próximos 90 días)" meta={plural(upcomingWarrantyExpirations.length, "garantía", "garantías")}>
            {upcomingWarrantyExpirations.length === 0 ? (
              <CocoaState kind="empty" inline title="Ninguna garantía vence en los próximos 90 días." />
            ) : (
              <ul className="c22-section__list" aria-label="Garantías que vencen">
                {upcomingWarrantyExpirations.map((row) => {
                  const days = daysUntil(row.warrantyEndsAt);
                  return (
                    <li key={row.id}>
                      {days !== null ? (
                        <CocoaBadge tone={warrantyTone(days)} variant="tinted" size="small">
                          {plural(days, "día", "días")}
                        </CocoaBadge>
                      ) : null}
                      <div className="cocoa-stack" data-gap="1" style={growStyle}>
                        <strong>{row.assetName}</strong>
                        <span style={subStyle}>vence el {date(row.warrantyEndsAt)}</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>
    </CocoaPage>
  );
}

// Mirror skeleton: the KPI strip and the two 6/6 rows.
function AssetsSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={5} />
      <CocoaSkeleton.Grid rows={[[6, 6], [6, 6]]} height={240} />
    </div>
  );
}

export default AssetsDashboard;
