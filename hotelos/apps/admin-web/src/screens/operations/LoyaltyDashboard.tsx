// Fidelización — Comercial › Clientes y fidelización › Fidelización
// (/comercial/clientes/fidelizacion, hosted inside ClientesTabs).
//
// Cocoa 22 · ola 7 · lote 7-B (docs/design/COCOA-22.md §4, archetype
// «dashboard alojado»): CocoaPage → CocoaKpiStrip (active members, points
// in circulation, redemptions, member stays) → CocoaGrid 6/6 (members by
// tier · top members as CocoaTables) → recent enrolments as a CocoaTable.
// Read-only.
//
// Data: GET /dashboards/loyalty, polled every 5 minutes — only once the
// guest_data_crm_loyalty module is known to be enabled (qa#14): while the
// module list loads the page keeps its skeleton, and with the module off it
// paints «Módulo no activado» (+ «Activar módulo» for users with modules.enable).

import { useApiData } from "../../hooks/useApiData";
import { getActiveProperty } from "../../services/activeProperty";
import { toArray } from "../../utils/toArray";
import { ACTIONS, FIELD_LABELS, STATUS_LABELS } from "../../content/actions";
import { treeHeaderFor } from "../tabs/tab-helpers";
import { dateTime, money, number, percent, plural } from "../../lib/format";
import { moduleDisabledCopy } from "./module-gate";
import { useScreenModuleGate } from "./useScreenModuleGate";
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
  type CocoaKpiStatus,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

// Menu labels of the tree (Comercial › Clientes y fidelización › Fidelización), never retyped here.
const HEADER = treeHeaderFor("LoyaltyDashboard", { eyebrow: "Comercial · Clientes y fidelización", title: "Fidelización" });

type Kpis = {
  activeMembers: number;
  totalPointsInCirculation: number;
  redemptions30dCount: number;
  redemptions30dPointsBurned: number;
  staysWithMemberPct: number;
};
type TierRow = { tier: string; count: number; pointsBalance: number };
type MemberRow = { id: string; fullName: string; tier: string; points: number; lifetimeSpendEur?: number };
type EnrollmentRow = { id: string; fullName: string; programName: string; enrolledAt: string };
type LoyaltyDashboardData = {
  kpis: Kpis;
  membersByTier: TierRow[];
  topMembers: MemberRow[];
  recentEnrollments: EnrollmentRow[];
};

/** Tier row with the total of the list, so the share is computed in the static column. */
type TierTableRow = TierRow & { total: number };

const EMPTY_KPIS: Kpis = { activeMembers: 0, totalPointsInCirculation: 0, redemptions30dCount: 0, redemptions30dPointsBurned: 0, staysWithMemberPct: 0 };
const MAX_ROWS = 12;

function fmtInt(n: number): string {
  return number(n, { maximumFractionDigits: 0 });
}

/** Platinum and diamond success · gold warning · silver and the rest neutral. */
function tierTone(tier: string): CocoaTone {
  const key = tier.toLowerCase();
  if (key.includes("platin") || key.includes("diam")) return "success";
  if (key.includes("gold") || key === "oro") return "warning";
  return "neutral";
}

function memberStaysStatus(pct: number): CocoaKpiStatus {
  if (pct >= 25) return "ok";
  if (pct >= 10) return "warning";
  return "critical";
}

function TierBadge({ tier }: { tier: string }) {
  return (
    <CocoaBadge tone={tierTone(tier)} variant="tinted" size="small">
      {tier || "sin nivel"}
    </CocoaBadge>
  );
}

const TIER_COLUMNS: CocoaTableColumn<TierTableRow>[] = [
  { key: "tier", label: "Nivel", render: (row) => <TierBadge tier={row.tier} /> },
  { key: "count", label: "Miembros", align: "right", fit: true, render: (row) => fmtInt(row.count) },
  {
    key: "share",
    label: "% del total",
    align: "right",
    fit: true,
    render: (row) => percent(row.total > 0 ? (row.count / row.total) * 100 : 0, { maximumFractionDigits: 0 })
  },
  { key: "pointsBalance", label: "Puntos", align: "right", fit: true, render: (row) => fmtInt(row.pointsBalance) }
];

const MEMBER_COLUMNS: CocoaTableColumn<MemberRow>[] = [
  { key: "fullName", label: "Miembro", render: (m) => <strong>{m.fullName}</strong> },
  { key: "tier", label: "Nivel", fit: true, render: (m) => <TierBadge tier={m.tier} /> },
  { key: "points", label: "Puntos", align: "right", fit: true, render: (m) => fmtInt(m.points) },
  {
    key: "lifetimeSpendEur",
    label: "Gasto acumulado",
    align: "right",
    fit: true,
    hideOnNarrow: true,
    render: (m) => (m.lifetimeSpendEur !== undefined ? money(m.lifetimeSpendEur, { decimals: 0 }) : "—")
  }
];

const ENROLLMENT_COLUMNS: CocoaTableColumn<EnrollmentRow>[] = [
  { key: "fullName", label: FIELD_LABELS.guest, render: (e) => <strong>{e.fullName}</strong> },
  { key: "programName", label: "Programa", hideOnNarrow: true, render: (e) => e.programName },
  { key: "enrolledAt", label: "Alta", align: "right", fit: true, render: (e) => dateTime(e.enrolledAt) }
];

// Mirror skeleton: the KPI strip, the 6/6 row and the enrolments table.
function LoyaltySkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={4} />
      <CocoaSkeleton.Grid rows={[[6, 6]]} height={220} />
      <CocoaSkeleton variant="card" height={200} />
    </div>
  );
}

export function LoyaltyDashboard() {
  // Hosted inside ClientesTabs the container paints eyebrow + H1; CocoaPage adds the subtitle and actions row.
  const propertyName = getActiveProperty().propertyName;
  // Module gate (qa#14): no request (and no 5-minute poll) until guest_data_crm_loyalty is known to be enabled.
  const moduleGate = useScreenModuleGate("LoyaltyDashboard");
  const { data, loading, error, refresh } = useApiData<LoyaltyDashboardData>(moduleGate.ready ? "/dashboards/loyalty" : null, { pollIntervalMs: 300000 });

  const kpis = data?.kpis ?? EMPTY_KPIS;
  const membersByTier = toArray<TierRow>(data?.membersByTier);
  const topMembers = toArray<MemberRow>(data?.topMembers);
  const recentEnrollments = toArray<EnrollmentRow>(data?.recentEnrollments);
  const totalTierMembers = membersByTier.reduce((total, row) => total + row.count, 0);
  const tierRows: TierTableRow[] = membersByTier.slice(0, MAX_ROWS).map((row) => ({ ...row, total: totalTierMembers }));

  // Module not active → the whole body is the «Módulo no activado» state (§3.10).
  const moduleDisabled = moduleGate.status === "disabled";
  const disabledCopy = moduleDisabledCopy(moduleGate.canEnable);
  const state =
    moduleGate.status === "loading" ? "loading" : moduleDisabled ? "empty" : loading && !data ? "loading" : error && !data ? "error" : "ready";

  return (
    <CocoaPage
      eyebrow={`${HEADER.eyebrow} · ${propertyName}`}
      title={HEADER.title}
      subtitle="Miembros activos, reparto por niveles, puntos en circulación y altas recientes del programa de fidelización. Se actualiza cada 5 minutos."
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
      skeleton={<LoyaltySkeleton />}
      empty={{
        title: disabledCopy.title,
        message: disabledCopy.message,
        primaryAction: disabledCopy.cta ? { label: disabledCopy.cta, onClick: moduleGate.enable } : undefined
      }}
      error={{ title: "No se pudo cargar la fidelización", message: error ?? undefined, onRetry: refresh }}
      commands={
        moduleGate.ready
          ? [{ id: "loyalty-refresh", label: "Actualizar fidelización", run: refresh }]
          : moduleDisabled && disabledCopy.cta
            ? [{ id: "loyalty-enable-module", label: `${disabledCopy.cta} · ${HEADER.title}`, run: moduleGate.enable }]
            : []
      }
    >
      <CocoaKpiStrip stagger aria-label="Indicadores de fidelización">
        <CocoaKpi label="Miembros activos" value={fmtInt(kpis.activeMembers)} caption="con membresía activa" polarity="neutral" status={kpis.activeMembers > 0 ? "ok" : "warning"} />
        <CocoaKpi label="Puntos en circulación" value={fmtInt(kpis.totalPointsInCirculation)} caption="saldo total acumulado" polarity="neutral" status="ok" />
        <CocoaKpi
          label="Canjes · 30 días"
          value={fmtInt(kpis.redemptions30dCount)}
          caption={`${fmtInt(kpis.redemptions30dPointsBurned)} puntos canjeados`}
          polarity="neutral"
          status={kpis.redemptions30dCount > 0 ? "ok" : "warning"}
        />
        <CocoaKpi
          label="Estancias de miembros"
          value={percent(kpis.staysWithMemberPct, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
          caption="reservas con huésped fidelizado"
          polarity="neutral"
          status={memberStaysStatus(kpis.staysWithMemberPct)}
        />
      </CocoaKpiStrip>

      <CocoaGrid align="start" aria-label="Niveles y principales miembros">
        <CocoaSpan cols={6} min={320}>
          <CocoaSection
            title="Miembros por nivel"
            meta={`${plural(totalTierMembers, "miembro activo", "miembros activos")}`}
            padding={tierRows.length === 0 ? "md" : "none"}
            style={{ overflow: "clip" }}
          >
            {tierRows.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin miembros activos en el programa." />
            ) : (
              <CocoaTable columns={TIER_COLUMNS} rows={tierRows} rowKey="tier" caption="Miembros por nivel" aria-label="Miembros por nivel" />
            )}
          </CocoaSection>
        </CocoaSpan>

        <CocoaSpan cols={6} min={320}>
          <CocoaSection
            title="Principales miembros"
            meta="mayor saldo de puntos · 10 primeros"
            padding={topMembers.length === 0 ? "md" : "none"}
            style={{ overflow: "clip" }}
          >
            {topMembers.length === 0 ? (
              <CocoaState
                kind="empty"
                title="No hay miembros activos para listar"
                message="Cuando los huéspedes acumulen puntos en el programa, los principales saldos aparecerán aquí."
              />
            ) : (
              <CocoaTable columns={MEMBER_COLUMNS} rows={topMembers.slice(0, MAX_ROWS)} rowKey="id" caption="Principales miembros" aria-label="Principales miembros" />
            )}
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>

      <CocoaSection
        title="Altas recientes"
        meta={plural(recentEnrollments.length, "alta", "altas")}
        padding={recentEnrollments.length === 0 ? "md" : "none"}
        style={{ overflow: "clip" }}
      >
        {recentEnrollments.length === 0 ? (
          <CocoaState
            kind="empty"
            title="No hay altas recientes en el programa"
            message="Las nuevas inscripciones aparecerán aquí en cuanto los huéspedes se den de alta."
          />
        ) : (
          <CocoaTable columns={ENROLLMENT_COLUMNS} rows={recentEnrollments.slice(0, MAX_ROWS)} rowKey="id" caption="Altas recientes" aria-label="Altas recientes" />
        )}
      </CocoaSection>
    </CocoaPage>
  );
}
