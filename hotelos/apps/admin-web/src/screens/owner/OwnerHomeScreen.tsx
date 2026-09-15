// Owner home — the "1-page verdict": portfolio value, performance KPIs, alerts.
//
// Cocoa 22 (ola 2 · lote 2-A): `CocoaPage` (hosted in Mi día the container
// paints the H1; standalone the page paints eyebrow + H1 + subtitle), one
// `CocoaKpiStrip` with six `CocoaKpi`, a 6/6 `CocoaGrid` with the alerts list
// and the top properties `CocoaTable`, mirror skeleton and honest states.
// Same endpoint (`/dashboards/portfolio`), same polling, same navigation.

import type { CSSProperties } from "react";
import { getActiveOrganizationId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { toArray } from "../../utils/toArray";
import { navigateTo } from "../../lib/navigate";
import { date, money, number, percent, plural } from "../../lib/format";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import {
  CocoaBadge,
  CocoaButton,
  CocoaGrid,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  CocoaTable,
  type CocoaTableColumn
} from "../../components/cocoa";

const ORGANIZATION_ID = getActiveOrganizationId();

type PortfolioTotals = {
  propertiesCount: number;
  activePropertiesCount: number;
  roomsCount: number;
  arrivalsToday: number;
  departuresToday: number;
  inHouseNow: number;
  occupancyPct: number;
  adrEur: number;
  revparEur: number;
  revenueMtdEur: number;
  pendingFiscalSubmissions: number;
  pendingBalanceEur: number;
  unattended: { reservations: number; messages: number; tasks: number };
};

type PortfolioAlert = {
  propertyId: string;
  severity: "critical" | "warning";
  title: string;
  description: string;
};

type PortfolioPropertyRow = {
  propertyId: string;
  name: string;
  occupancyPct: number;
  adrEur: number;
  revparEur: number;
  revenueMtdEur: number;
  health: "ok" | "warn" | "error";
};

type PortfolioDashboardData = {
  asOf: string;
  totals: PortfolioTotals;
  perProperty: PortfolioPropertyRow[];
  alerts: PortfolioAlert[];
};

// Single es-ES formatter (lib/format.ts): missing values read «—», never «0 €».
const fmtNumber = (value: number | null | undefined) => number(value);
const fmtEur = (value: number | null | undefined) => money(value, { decimals: 0 });
const fmtPct = (value: number | null | undefined) => percent(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

// Secondary text of the alerts list (caption, secondary ink).
const mutedStyle: CSSProperties = { fontSize: "var(--cocoa-fs-caption)", color: "var(--cocoa-label-secondary)" };

// Columns outside the component (rule A5); the table sorts nothing itself —
// the rows arrive already ordered by MTD revenue.
const PROPERTY_COLUMNS: CocoaTableColumn<PortfolioPropertyRow>[] = [
  { key: "name", label: "Propiedad", render: (row) => <strong>{row.name}</strong> },
  { key: "occupancyPct", label: "Ocup.", align: "right", render: (row) => fmtPct(row.occupancyPct) },
  { key: "revparEur", label: "RevPAR", align: "right", render: (row) => fmtEur(row.revparEur), hideOnNarrow: true },
  { key: "revenueMtdEur", label: "Ingresos (mes)", align: "right", render: (row) => fmtEur(row.revenueMtdEur) }
];

// Mirror skeleton: the KPI strip and the 6/6 grid below (no layout shift).
function OwnerSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={6} />
      <CocoaSkeleton.Grid rows={[[6, 6]]} height={260} />
    </div>
  );
}

/** Owner home: the "1-page verdict" — portfolio value, performance KPIs, alerts. */
export function OwnerHomeScreen() {
  const { data, loading, error, refresh } = useApiData<PortfolioDashboardData>(
    `/dashboards/portfolio?organizationId=${ORGANIZATION_ID}`,
    { pollIntervalMs: 60000 }
  );

  const t = data?.totals;
  const alerts = toArray<PortfolioAlert>(data?.alerts);
  const perProperty = [...toArray<PortfolioPropertyRow>(data?.perProperty)].sort((a, b) => b.revenueMtdEur - a.revenueMtdEur).slice(0, 6);
  const pendingBalance = t?.pendingBalanceEur ?? 0;
  const hasProperties = perProperty.length > 0;

  return (
    <CocoaPage
      eyebrow="Propietario · Resumen ejecutivo"
      title="Resumen del propietario"
      subtitle={
        data
          ? `El estado de tu cartera de un vistazo: rendimiento, ingresos y lo que requiere tu atención · datos a ${date(data.asOf, "short")}`
          : "El estado de tu cartera de un vistazo: rendimiento, ingresos y lo que requiere tu atención."
      }
      actions={
        <>
          {loading ? <CocoaBadge tone="info">{STATUS_LABELS.loading}</CocoaBadge> : null}
          {error ? <CocoaBadge tone="danger">{error}</CocoaBadge> : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh}>
            {ACTIONS.refresh}
          </CocoaButton>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => navigateTo("PortfolioDashboard")}>
            Ver cartera completa
          </CocoaButton>
          <CocoaButton variant="filled" tone="accent" size="small" onClick={() => navigateTo("RevenueHomeDashboard")}>
            Revenue
          </CocoaButton>
        </>
      }
      state={loading && !data ? "loading" : error && !data ? "error" : !t ? "empty" : "ready"}
      skeleton={<OwnerSkeleton />}
      empty={{ title: "Sin datos de la cartera todavía", message: "El resumen se rellena cuando las propiedades registran KPIs y movimientos." }}
      error={{ title: STATUS_LABELS.loadError, message: error ?? undefined, onRetry: refresh }}
      commands={[
        { id: "owner-home-refresh", label: "Actualizar resumen del propietario", run: refresh },
        { id: "owner-home-portfolio", label: "Ver cartera completa", run: () => navigateTo("PortfolioDashboard") }
      ]}
    >
      {t ? (
        <>
          <CocoaKpiStrip stagger aria-label="Rendimiento de la cartera">
            <CocoaKpi label="Ocupación" value={fmtPct(t.occupancyPct)} deltaLabel="cartera" polarity="neutral" status="ok" />
            <CocoaKpi label="ADR" value={fmtEur(t.adrEur)} deltaLabel="media" polarity="neutral" status="ok" />
            <CocoaKpi label="RevPAR" value={fmtEur(t.revparEur)} deltaLabel="media" polarity="neutral" status="ok" />
            <CocoaKpi label="Ingresos (mes)" value={fmtEur(t.revenueMtdEur)} deltaLabel="mes en curso" polarity="neutral" status="ok" />
            <CocoaKpi
              label="Saldo pendiente"
              value={fmtEur(t.pendingBalanceEur)}
              deltaLabel={pendingBalance > 0 ? "por cobrar" : "al día"}
              polarity="neutral"
              status={pendingBalance > 0 ? "warning" : "ok"}
            />
            <CocoaKpi label="Propiedades activas" value={fmtNumber(t.activePropertiesCount)} unit={`de ${fmtNumber(t.propertiesCount)}`} polarity="neutral" status="ok" />
          </CocoaKpiStrip>

          <CocoaGrid align="start" aria-label="Avisos y propiedades destacadas">
            <CocoaSpan cols={6} min={320}>
              <CocoaSection title="Requiere tu atención" meta={plural(alerts.length, "aviso", "avisos")}>
                {alerts.length === 0 ? (
                  <CocoaState kind="empty" inline title="Sin avisos. Todo en orden en la cartera." />
                ) : (
                  <ul className="c22-section__list">
                    {alerts.slice(0, 6).map((a, i) => (
                      <li key={`${a.propertyId}-${i}`}>
                        <div className="cocoa-stack" data-gap="1" style={{ minWidth: 0, flex: "1 1 auto" }}>
                          <strong>{a.title}</strong>
                          <span style={mutedStyle}>{a.description}</span>
                        </div>
                        <CocoaBadge tone={a.severity === "critical" ? "danger" : "warning"} size="small">
                          {a.severity === "critical" ? "crítico" : "atención"}
                        </CocoaBadge>
                      </li>
                    ))}
                  </ul>
                )}
              </CocoaSection>
            </CocoaSpan>

            <CocoaSpan cols={6} min={320}>
              <CocoaSection
                title="Propiedades destacadas"
                padding={hasProperties ? "none" : "md"}
                style={{ overflow: "clip" }}
                action={
                  <CocoaButton variant="plain" tone="accent" size="small" onClick={() => navigateTo("PortfolioDashboard")}>
                    Ver todas
                  </CocoaButton>
                }
              >
                {hasProperties ? (
                  <CocoaTable columns={PROPERTY_COLUMNS} rows={perProperty} rowKey="propertyId" caption="Propiedades destacadas por ingresos del mes" aria-label="Propiedades destacadas" />
                ) : (
                  <CocoaState
                    kind="empty"
                    title="Sin datos de propiedades todavía"
                    message="Las propiedades destacadas aparecerán aquí cuando se registren KPIs y movimientos en la cartera."
                  />
                )}
              </CocoaSection>
            </CocoaSpan>
          </CocoaGrid>
        </>
      ) : null}
    </CocoaPage>
  );
}
