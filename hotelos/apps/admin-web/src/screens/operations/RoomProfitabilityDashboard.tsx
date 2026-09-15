import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { CocoaPageHeader } from "../../components/cocoa/CocoaPageHeader";
import { ACTIONS, UI_STATES } from "../../content/actions";
import { money as formatMoney, percent } from "../../lib/format";

const PROPERTY_ID = getActivePropertyId();

type RoomProfitabilityData = {
  kpis: {
    totalRevenueEur: number;
    occupancyPct: number;
    adrEur: number;
    revparEur: number;
    goppar30dEur: number;
  };
  byRoomType: Array<{
    roomTypeName: string;
    roomCount: number;
    occupancyPct: number;
    adrEur: number;
    revparEur: number;
    revenueEur: number;
  }>;
  byChannel: Array<{
    channelName: string;
    reservations: number;
    revenueEur: number;
    netRevenueEur: number;
    marginPct: number;
  }>;
  topRooms: Array<{
    id: string;
    number: string;
    roomTypeName: string;
    revenue30dEur: number;
    nightsBooked: number;
  }>;
};

function money(value: number | null | undefined): string {
  return formatMoney(value);
}

function pct(value: number | null | undefined): string {
  return percent(value);
}

type Status = "ok" | "warn" | "error";

function occupancyStatus(value: number | undefined): Status {
  if (!Number.isFinite(value as number)) return "warn";
  const v = value as number;
  if (v >= 70) return "ok";
  if (v >= 45) return "warn";
  return "error";
}

function revparStatus(value: number | undefined, adr: number | undefined): Status {
  if (!Number.isFinite(value as number) || !Number.isFinite(adr as number)) return "warn";
  const v = value as number;
  const a = adr as number;
  if (a <= 0) return "warn";
  const ratio = v / a;
  if (ratio >= 0.7) return "ok";
  if (ratio >= 0.45) return "warn";
  return "error";
}

function marginStatus(value: number): Status {
  if (!Number.isFinite(value)) return "warn";
  if (value >= 70) return "ok";
  if (value >= 50) return "warn";
  return "error";
}

function marginPill(value: number) {
  const status = marginStatus(value);
  const cls = status === "ok" ? "cm-pill-ok" : status === "warn" ? "cm-pill-warn" : "cm-pill-error";
  return <span className={`cm-pill ${cls}`}>{pct(value)}</span>;
}

export function RoomProfitabilityDashboard() {
  const { data, loading, error, refresh } = useApiData<RoomProfitabilityData>(
    "/dashboards/room-profitability",
    { pollIntervalMs: 300000, query: { propertyId: PROPERTY_ID } }
  );

  const kpis = data?.kpis;
  const byRoomType = data?.byRoomType ?? [];
  const byChannel = data?.byChannel ?? [];
  const topRooms = data?.topRooms ?? [];

  const occStatus = occupancyStatus(kpis?.occupancyPct);
  const revparKpiStatus = revparStatus(kpis?.revparEur, kpis?.adrEur);
  const gopparStatus: Status = !kpis
    ? "warn"
    : kpis.goppar30dEur > 0
      ? "ok"
      : kpis.goppar30dEur === 0
        ? "warn"
        : "error";

  return (
    <>
      <CocoaPageHeader
        eyebrow="Informes"
        title="Rentabilidad por habitación"
        subtitle="RevPAR, ADR, ocupación y GOPPAR por tipo de habitación y por canal en los últimos 30 días. Solo lectura; se actualiza cada 5 minutos."
        actions={<button type="button" className="ghost" onClick={refresh}>↻ {ACTIONS.refresh}</button>}
      />

      {error ? (
        <section className="bo-card" style={{ borderColor: "var(--danger-ink)" }}>
          {UI_STATES.error.title}. {UI_STATES.error.message}
        </section>
      ) : null}

      <section className="rev-kpi-grid">
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Ingresos totales</span></div>
          <div className="rev-kpi-value">{loading && !data ? "…" : money(kpis?.totalRevenueEur)}</div>
          <div className="rev-kpi-delta">Suma de los últimos 30 días</div>
        </article>
        <article className={`rev-kpi rev-kpi-${occStatus}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Ocupación</span></div>
          <div className="rev-kpi-value">{loading && !data ? "…" : pct(kpis?.occupancyPct)}</div>
          <div className="rev-kpi-delta">Noches vendidas sobre noches disponibles</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">ADR</span></div>
          <div className="rev-kpi-value">{loading && !data ? "…" : money(kpis?.adrEur)}</div>
          <div className="rev-kpi-delta">Ingreso de habitaciones por noche vendida</div>
        </article>
        <article className={`rev-kpi rev-kpi-${revparKpiStatus}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">RevPAR</span></div>
          <div className="rev-kpi-value">{loading && !data ? "…" : money(kpis?.revparEur)}</div>
          <div className="rev-kpi-delta">Ingreso de habitaciones por noche disponible</div>
        </article>
        <article className={`rev-kpi rev-kpi-${gopparStatus}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">GOPPAR · 30 días</span></div>
          <div className="rev-kpi-value">{loading && !data ? "…" : money(kpis?.goppar30dEur)}</div>
          <div className="rev-kpi-delta">Beneficio operativo bruto por habitación disponible</div>
        </article>
      </section>

      <section className="bo-grid two">
        <article className="bo-card">
          <div className="bo-card-head">
            <div>
              <p className="bo-muted">Por tipo</p>
              <h3>Por tipo de habitación</h3>
            </div>
            <span className="bo-chip">{byRoomType.length} tipos</span>
          </div>
          {byRoomType.length === 0 ? (
            <p className="bo-muted">No hay datos por tipo de habitación en el periodo.</p>
          ) : (
            <div className="rev-report-wrap">
              <table className="cm-table">
                <thead>
                  <tr>
                    <th>Tipo</th>
                    <th style={{ textAlign: "right" }}>Habitaciones</th>
                    <th style={{ textAlign: "right" }}>Ocupación</th>
                    <th style={{ textAlign: "right" }}>ADR</th>
                    <th style={{ textAlign: "right" }}>RevPAR</th>
                    <th style={{ textAlign: "right" }}>Ingresos</th>
                  </tr>
                </thead>
                <tbody>
                  {byRoomType.map((row, idx) => (
                    <tr key={`${row.roomTypeName}-${idx}`}>
                      <td><strong>{row.roomTypeName}</strong></td>
                      <td style={{ textAlign: "right" }}>{row.roomCount}</td>
                      <td style={{ textAlign: "right" }}>{pct(row.occupancyPct)}</td>
                      <td style={{ textAlign: "right" }}>{money(row.adrEur)}</td>
                      <td style={{ textAlign: "right" }}>{money(row.revparEur)}</td>
                      <td style={{ textAlign: "right" }}>{money(row.revenueEur)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </article>

        <article className="bo-card">
          <div className="bo-card-head">
            <div>
              <p className="bo-muted">Canales</p>
              <h3>Por canal</h3>
            </div>
            <span className="bo-chip">{byChannel.length} canales</span>
          </div>
          {byChannel.length === 0 ? (
            <p className="bo-muted">No hay actividad de canales en el periodo.</p>
          ) : (
            <div className="rev-report-wrap">
              <table className="cm-table">
                <thead>
                  <tr>
                    <th>Canal</th>
                    <th style={{ textAlign: "right" }}>Reservas</th>
                    <th style={{ textAlign: "right" }}>Ingresos</th>
                    <th style={{ textAlign: "right" }}>Ingreso neto</th>
                    <th style={{ textAlign: "right" }}>Margen</th>
                  </tr>
                </thead>
                <tbody>
                  {byChannel.map((row, idx) => (
                    <tr key={`${row.channelName}-${idx}`}>
                      <td><strong>{row.channelName}</strong></td>
                      <td style={{ textAlign: "right" }}>{row.reservations}</td>
                      <td style={{ textAlign: "right" }}>{money(row.revenueEur)}</td>
                      <td style={{ textAlign: "right" }}>{money(row.netRevenueEur)}</td>
                      <td style={{ textAlign: "right" }}>{marginPill(row.marginPct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </article>
      </section>

      <section className="bo-card">
        <div className="bo-card-head">
          <div>
            <p className="bo-muted">Habitaciones</p>
            <h3>Habitaciones más rentables (30 días)</h3>
          </div>
          <span className="bo-chip">{topRooms.length} habitaciones</span>
        </div>
        {topRooms.length === 0 ? (
          <p className="bo-muted">No hay reservas asignadas a habitaciones en el periodo.</p>
        ) : (
          <div className="rev-report-wrap">
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Habitación</th>
                  <th>Tipo</th>
                  <th style={{ textAlign: "right" }}>Noches</th>
                  <th style={{ textAlign: "right" }}>Ingresos · 30 días</th>
                </tr>
              </thead>
              <tbody>
                {topRooms.map((room) => (
                  <tr key={room.id}>
                    <td><strong>{room.number}</strong></td>
                    <td>{room.roomTypeName}</td>
                    <td style={{ textAlign: "right" }}>{room.nightsBooked}</td>
                    <td style={{ textAlign: "right" }}>{money(room.revenue30dEur)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
