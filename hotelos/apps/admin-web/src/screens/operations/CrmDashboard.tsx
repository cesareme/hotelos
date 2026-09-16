// Clientes — Comercial › Clientes y fidelización (/comercial/clientes, base
// tab of ClientesTabs).
//
// Cocoa 22 · ola 7 · lote 7-B (docs/design/COCOA-22.md §4, archetype
// «dashboard alojado»): CocoaPage → CocoaKpiStrip (guests, profiles, VIPs,
// lifetime value, churn) → CocoaGrid 6/6 (top segments with their reach as
// CocoaChart.Progress · active campaigns) → CocoaGrid 6/6 (upcoming
// birthdays as a section list · recent guests as a CocoaTable). Read-only.
//
// Data: GET /dashboards/crm?propertyId=, polled every 2 minutes — only once
// the guest_data_crm_loyalty module is known to be enabled (qa#14): while the
// module list loads the page keeps its skeleton, and with the module off it
// paints «Módulo no activado» (+ «Activar módulo» for users with
// modules.enable). Guest profiles, segments and campaigns still live in the
// in-memory demo store of the API: what this dashboard shows is what that
// store holds for the property.

import { useApiData } from "../../hooks/useApiData";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { toArray } from "../../utils/toArray";
import { ACTIONS, FIELD_LABELS, STATUS_LABELS, TIME_LABELS } from "../../content/actions";
import { treeHeaderFor } from "../tabs/tab-helpers";
import { date, money, number, percent, plural } from "../../lib/format";
import { moduleDisabledCopy } from "./module-gate";
import { useScreenModuleGate } from "./useScreenModuleGate";
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
  type CocoaKpiStatus,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

const PROPERTY_ID = getActivePropertyId();
// Menu labels of the tree (Comercial › Clientes y fidelización), never retyped here.
const HEADER = treeHeaderFor("CrmDashboard", { eyebrow: "Comercial", title: "Clientes y fidelización" });

type Kpis = {
  totalGuests: number;
  activeProfiles: number;
  vipCount: number;
  avgLifetimeValueEur: number;
  churnRate90dPct: number;
};
type SegmentRow = { segmentName: string; memberCount: number; revenue90dEur: number };
type CampaignRow = { id: string; name: string; status: string; recipients: number; ctrPct?: number };
type BirthdayRow = { id: string; fullName: string; dateOfBirth: string; daysAway: number };
type GuestRow = { id: string; fullName: string; lastStayAt?: string; totalStays: number; totalRevenue?: number };
type CrmDashboardData = {
  kpis: Kpis;
  topSegments: SegmentRow[];
  activeCampaigns: CampaignRow[];
  upcomingBirthdays: BirthdayRow[];
  recentGuests: GuestRow[];
};

/** Segment row with the largest count of the list, so the reach bar scales to it. */
type SegmentTableRow = SegmentRow & { maxCount: number };

const EMPTY_KPIS: Kpis = { totalGuests: 0, activeProfiles: 0, vipCount: 0, avgLifetimeValueEur: 0, churnRate90dPct: 0 };
const MAX_ROWS = 12;
const UNNAMED_GUEST = "Huésped sin nombre";

const CAMPAIGN_STATUS: Record<string, { label: string; tone: CocoaTone }> = {
  active: { label: "activa", tone: "success" },
  running: { label: "en curso", tone: "success" },
  live: { label: "en curso", tone: "success" },
  scheduled: { label: "programada", tone: "success" },
  paused: { label: "pausada", tone: "warning" },
  draft: { label: STATUS_LABELS.draft.toLowerCase(), tone: "neutral" },
  sent: { label: "enviada", tone: "neutral" }
};

function campaignStatus(status: string): { label: string; tone: CocoaTone } {
  return CAMPAIGN_STATUS[status.toLowerCase()] ?? { label: status, tone: "warning" };
}

function churnStatus(pct: number): CocoaKpiStatus {
  if (pct < 20) return "ok";
  if (pct < 40) return "warning";
  return "critical";
}

function guestName(name: string): string {
  return name || UNNAMED_GUEST;
}

const SEGMENT_COLUMNS: CocoaTableColumn<SegmentTableRow>[] = [
  { key: "segmentName", label: "Segmento", render: (row) => <strong>{row.segmentName}</strong> },
  { key: "memberCount", label: "Miembros", align: "right", fit: true, render: (row) => number(row.memberCount) },
  {
    key: "reach",
    label: "Alcance",
    minWidth: 140,
    render: (row) => (
      <CocoaChart.Progress
        value={row.maxCount > 0 ? Math.max(row.memberCount > 0 ? 2 : 0, (row.memberCount / row.maxCount) * 100) : 0}
        showValue={false}
        aria-label={`${row.segmentName}: ${plural(row.memberCount, "miembro", "miembros")}`}
      />
    )
  },
  { key: "revenue90dEur", label: "Ingresos 90 días", align: "right", fit: true, render: (row) => money(row.revenue90dEur) }
];

const CAMPAIGN_COLUMNS: CocoaTableColumn<CampaignRow>[] = [
  {
    key: "status",
    label: FIELD_LABELS.status,
    fit: true,
    render: (c) => {
      const status = campaignStatus(c.status);
      return (
        <CocoaBadge tone={status.tone} variant="dot" size="small">
          {status.label}
        </CocoaBadge>
      );
    }
  },
  { key: "name", label: "Campaña", render: (c) => <strong>{c.name}</strong> },
  { key: "recipients", label: "Destinatarios", align: "right", fit: true, render: (c) => number(c.recipients) },
  { key: "ctrPct", label: "CTR", align: "right", fit: true, render: (c) => (c.ctrPct !== undefined ? percent(c.ctrPct, { maximumFractionDigits: 1 }) : "—") }
];

const GUEST_COLUMNS: CocoaTableColumn<GuestRow>[] = [
  { key: "fullName", label: FIELD_LABELS.guest, render: (g) => <strong>{guestName(g.fullName)}</strong> },
  { key: "lastStayAt", label: "Última estancia", fit: true, hideOnNarrow: true, render: (g) => date(g.lastStayAt) },
  { key: "totalStays", label: "Estancias", align: "right", fit: true, render: (g) => number(g.totalStays) },
  { key: "totalRevenue", label: "Ingresos", align: "right", fit: true, render: (g) => (g.totalRevenue !== undefined ? money(g.totalRevenue) : "—") }
];

// Mirror skeleton: the KPI strip and the two 6/6 rows.
function CrmSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={5} />
      <CocoaSkeleton.Grid rows={[[6, 6], [6, 6]]} height={220} />
    </div>
  );
}

export function CrmDashboard() {
  // Hosted inside ClientesTabs the container paints eyebrow + H1; CocoaPage adds the subtitle and actions row.
  const propertyName = getActiveProperty().propertyName;
  // Module gate (qa#14): no request (and no 2-minute poll) until guest_data_crm_loyalty is known to be enabled.
  const moduleGate = useScreenModuleGate("CrmDashboard");
  const { data, loading, error, refresh } = useApiData<CrmDashboardData>(moduleGate.ready ? `/dashboards/crm?propertyId=${PROPERTY_ID}` : null, {
    pollIntervalMs: 120000
  });

  const kpis = data?.kpis ?? EMPTY_KPIS;
  const topSegments = toArray<SegmentRow>(data?.topSegments);
  const activeCampaigns = toArray<CampaignRow>(data?.activeCampaigns);
  const upcomingBirthdays = toArray<BirthdayRow>(data?.upcomingBirthdays);
  const recentGuests = toArray<GuestRow>(data?.recentGuests);

  const maxSegmentCount = topSegments.reduce((max, row) => Math.max(max, row.memberCount), 0);
  const segmentRows: SegmentTableRow[] = topSegments.slice(0, MAX_ROWS).map((row) => ({ ...row, maxCount: maxSegmentCount }));

  // Module not active → the whole body is the «Módulo no activado» state (§3.10).
  const moduleDisabled = moduleGate.status === "disabled";
  const disabledCopy = moduleDisabledCopy(moduleGate.canEnable);
  const state =
    moduleGate.status === "loading" ? "loading" : moduleDisabled ? "empty" : loading && !data ? "loading" : error && !data ? "error" : "ready";

  return (
    <CocoaPage
      eyebrow={`${HEADER.eyebrow} · ${propertyName}`}
      title={HEADER.title}
      subtitle="Base de contactos, perfiles activos, VIP, valor medio por cliente y bajas a 90 días, con segmentos principales, campañas activas, próximos cumpleaños y huéspedes recientes. Se actualiza cada 2 minutos."
      actions={
        moduleGate.ready ? (
          <>
            {loading && data ? <CocoaBadge tone="info">{STATUS_LABELS.loading}</CocoaBadge> : null}
            {error && data ? (
              <CocoaBadge tone="danger" title={error}>
                {STATUS_LABELS.loadError}
              </CocoaBadge>
            ) : null}
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh} disabled={loading}>
              {ACTIONS.refresh}
            </CocoaButton>
          </>
        ) : null
      }
      state={state}
      skeleton={<CrmSkeleton />}
      empty={{
        title: disabledCopy.title,
        message: disabledCopy.message,
        primaryAction: disabledCopy.cta ? { label: disabledCopy.cta, onClick: moduleGate.enable } : undefined
      }}
      error={{ title: "No se pudo cargar la vista de clientes", message: error ?? undefined, onRetry: refresh }}
      commands={
        moduleGate.ready
          ? [{ id: "crm-refresh", label: "Actualizar clientes", run: refresh }]
          : moduleDisabled && disabledCopy.cta
            ? [{ id: "crm-enable-module", label: `${disabledCopy.cta} · ${HEADER.title}`, run: moduleGate.enable }]
            : []
      }
    >
      <CocoaKpiStrip stagger aria-label="Indicadores de clientes">
        <CocoaKpi label="Huéspedes totales" value={number(kpis.totalGuests)} caption="contactos en la base" polarity="neutral" status={kpis.totalGuests > 0 ? "ok" : "warning"} />
        <CocoaKpi label="Perfiles activos" value={number(kpis.activeProfiles)} caption="perfiles sin duplicados" polarity="neutral" status={kpis.activeProfiles > 0 ? "ok" : "warning"} />
        <CocoaKpi label="VIP" value={number(kpis.vipCount)} caption="perfiles con nivel VIP" polarity="neutral" status={kpis.vipCount > 0 ? "ok" : "warning"} />
        <CocoaKpi label="Valor medio por cliente" value={money(kpis.avgLifetimeValueEur)} caption="sobre los perfiles activos" polarity="neutral" status={kpis.avgLifetimeValueEur > 0 ? "ok" : "warning"} />
        <CocoaKpi
          label="Bajas en 90 días"
          value={percent(kpis.churnRate90dPct, { maximumFractionDigits: 1 })}
          caption="última estancia hace más de 90 días"
          polarity="negative-good"
          status={churnStatus(kpis.churnRate90dPct)}
        />
      </CocoaKpiStrip>

      <CocoaGrid align="start" aria-label="Segmentos y campañas">
        <CocoaSpan cols={6} min={320}>
          <CocoaSection
            title="Principales segmentos"
            meta={plural(topSegments.length, "segmento", "segmentos")}
            padding={segmentRows.length === 0 ? "md" : "none"}
            style={{ overflow: "clip" }}
          >
            {segmentRows.length === 0 ? (
              <CocoaState kind="empty" inline title="Todavía no hay segmentos configurados." />
            ) : (
              <CocoaTable columns={SEGMENT_COLUMNS} rows={segmentRows} rowKey="segmentName" caption="Principales segmentos" aria-label="Principales segmentos" />
            )}
          </CocoaSection>
        </CocoaSpan>

        <CocoaSpan cols={6} min={320}>
          <CocoaSection
            title="Campañas activas"
            meta={plural(activeCampaigns.length, "campaña", "campañas")}
            padding={activeCampaigns.length === 0 ? "md" : "none"}
            style={{ overflow: "clip" }}
          >
            {activeCampaigns.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin campañas activas." />
            ) : (
              <CocoaTable columns={CAMPAIGN_COLUMNS} rows={activeCampaigns.slice(0, MAX_ROWS)} rowKey="id" caption="Campañas activas" aria-label="Campañas activas" />
            )}
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>

      <CocoaGrid align="start" aria-label="Cumpleaños y huéspedes recientes">
        <CocoaSpan cols={6} min={320}>
          <CocoaSection title="Próximos cumpleaños" meta={`próximos 30 días · ${number(upcomingBirthdays.length)}`}>
            {upcomingBirthdays.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin cumpleaños en los próximos 30 días." />
            ) : (
              <ul className="c22-section__list" aria-label="Próximos cumpleaños">
                {upcomingBirthdays.slice(0, MAX_ROWS).map((g) => (
                  <li key={g.id}>
                    <span className="cocoa-cluster">
                      <CocoaBadge tone={g.daysAway === 0 ? "accent" : "neutral"} variant="tinted" size="small" uppercase={false}>
                        {g.daysAway === 0 ? TIME_LABELS.today : `en ${plural(g.daysAway, "día", "días")}`}
                      </CocoaBadge>
                      <span>{guestName(g.fullName)}</span>
                    </span>
                    <strong>{date(g.dateOfBirth, "dayMonth")}</strong>
                  </li>
                ))}
              </ul>
            )}
          </CocoaSection>
        </CocoaSpan>

        <CocoaSpan cols={6} min={320}>
          <CocoaSection
            title="Huéspedes recientes"
            meta={plural(recentGuests.length, "huésped", "huéspedes")}
            padding={recentGuests.length === 0 ? "md" : "none"}
            style={{ overflow: "clip" }}
          >
            {recentGuests.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin huéspedes recientes en esta propiedad." />
            ) : (
              <CocoaTable columns={GUEST_COLUMNS} rows={recentGuests.slice(0, MAX_ROWS)} rowKey="id" caption="Huéspedes recientes" aria-label="Huéspedes recientes" />
            )}
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>
    </CocoaPage>
  );
}
