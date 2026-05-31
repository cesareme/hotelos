import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";

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

const currencyFormatter = new Intl.NumberFormat("es-ES", { useGrouping: true,
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 2
});

function money(value: number | null | undefined): string {
  return currencyFormatter.format(Number.isFinite(value as number) ? (value as number) : 0);
}

function pct(value: number | null | undefined): string {
  if (!Number.isFinite(value as number)) return "0%";
  return `${value}%`;
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
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Operations · Revenue</div>
          <h1 className="bo-page-title">Room profitability</h1>
          <p className="bo-page-subtitle">
            RevPAR, ADR, ocupación y GOPPAR por tipo de habitación y por canal para los últimos 30 días.
            Solo lectura; refresca automáticamente cada 5 minutos.
          </p>
        </div>
        <div className="bo-page-head-actions">
          <button type="button" className="ghost" onClick={refresh}>↻ Refresh</button>
        </div>
      </div>

      {error ? (
        <section className="bo-card" style={{ borderColor: "var(--danger-ink)" }}>
          Couldn't load this view right now. Refresh to retry.
        </section>
      ) : null}

      <section className="rev-kpi-grid">
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Total revenue</span></div>
          <div className="rev-kpi-value">{loading && !data ? "…" : money(kpis?.totalRevenueEur)}</div>
          <div className="rev-kpi-delta">Suma total revenue 30d</div>
        </article>
        <article className={`rev-kpi rev-kpi-${occStatus}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Occupancy</span></div>
          <div className="rev-kpi-value">{loading && !data ? "…" : pct(kpis?.occupancyPct)}</div>
          <div className="rev-kpi-delta">Habitaciones vendibles / nights</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">ADR</span></div>
          <div className="rev-kpi-value">{loading && !data ? "…" : money(kpis?.adrEur)}</div>
          <div className="rev-kpi-delta">Room revenue / room nights</div>
        </article>
        <article className={`rev-kpi rev-kpi-${revparKpiStatus}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">RevPAR</span></div>
          <div className="rev-kpi-value">{loading && !data ? "…" : money(kpis?.revparEur)}</div>
          <div className="rev-kpi-delta">Room revenue / available room nights</div>
        </article>
        <article className={`rev-kpi rev-kpi-${gopparStatus}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">GOPPAR 30d</span></div>
          <div className="rev-kpi-value">{loading && !data ? "…" : money(kpis?.goppar30dEur)}</div>
          <div className="rev-kpi-delta">Gross operating profit per available room</div>
        </article>
      </section>

      <section className="bo-grid two">
        <article className="bo-card">
          <div className="bo-card-head">
            <div>
              <p className="bo-muted">Mix</p>
              <h3>By room type</h3>
            </div>
            <span className="bo-chip">{byRoomType.length} tipos</span>
          </div>
          {byRoomType.length === 0 ? (
            <p className="bo-muted">No hay snapshots por tipo de habitación en la ventana.</p>
          ) : (
            <div className="rev-report-wrap">
              <table className="cm-table">
                <thead>
                  <tr>
                    <th>Tipo</th>
                    <th style={{ textAlign: "right" }}>Rooms</th>
                    <th style={{ textAlign: "right" }}>Occ</th>
                    <th style={{ textAlign: "right" }}>ADR</th>
                    <th style={{ textAlign: "right" }}>RevPAR</th>
                    <th style={{ textAlign: "right" }}>Revenue</th>
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
              <p className="bo-muted">Channels</p>
              <h3>By channel</h3>
            </div>
            <span className="bo-chip">{byChannel.length} canales</span>
          </div>
          {byChannel.length === 0 ? (
            <p className="bo-muted">No hay actividad de canales en la ventana.</p>
          ) : (
            <div className="rev-report-wrap">
              <table className="cm-table">
                <thead>
                  <tr>
                    <th>Canal</th>
                    <th style={{ textAlign: "right" }}>Reservas</th>
                    <th style={{ textAlign: "right" }}>Revenue</th>
                    <th style={{ textAlign: "right" }}>Net revenue</th>
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
            <p className="bo-muted">Top rooms</p>
            <h3>Most profitable rooms (30d)</h3>
          </div>
          <span className="bo-chip">{topRooms.length} habitaciones</span>
        </div>
        {topRooms.length === 0 ? (
          <p className="bo-muted">No hay reservas asignadas a habitaciones en la ventana.</p>
        ) : (
          <div className="rev-report-wrap">
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Habitación</th>
                  <th>Tipo</th>
                  <th style={{ textAlign: "right" }}>Noches</th>
                  <th style={{ textAlign: "right" }}>Revenue 30d</th>
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
