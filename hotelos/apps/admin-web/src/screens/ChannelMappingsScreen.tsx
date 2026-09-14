import { useEffect, useMemo, useState } from "react";
import { useApiData } from "../hooks/useApiData";
import { apiRequest } from "../services/api-client";
import { getActivePropertyId } from "../services/activeProperty";
import { EmptyState, ErrorState, LoadingBlock } from "../components/States";
import { toArray } from "../utils/toArray";
import { navigateTo } from "../lib/navigate";

// =====================================================================================
// Channel Manager · Mapeos de canales — read view over the Prisma-backed mapping
// endpoints the aggregator pushes with:
//   GET /channel-manager/channels?propertyId=…                → { channels }
//   GET /channel-manager/channels/:channelId/room-mappings    → { mappings }
//   GET /channel-manager/channels/:channelId/rate-mappings    → { mappings }
//   GET /channel-manager/channels/:channelId/mapping-coverage → coverage
// Editing (add/remove) stays in ChannelAggregatorHub, next to connect/test/push,
// so there is a single write surface for the channel.
// =====================================================================================

type ChannelRow = {
  id: string;
  providerCode: string;
  name: string;
  channelType: string;
  status: string;
  lastSyncAt: string | null;
  roomMappingsCount: number;
  rateMappingsCount: number;
};

type RoomMappingRow = {
  id: string;
  roomTypeId: string;
  roomTypeName: string | null;
  roomTypeCode: string | null;
  externalRoomId: string | null;
  externalRoomCode: string;
  status: string;
};

type RateMappingRow = {
  id: string;
  ratePlanId: string;
  ratePlanName: string | null;
  ratePlanCode: string | null;
  externalRateId: string | null;
  externalRateCode: string;
  status: string;
};

type MappingCoverage = {
  channelId: string;
  roomTypesTotal: number;
  roomTypesMapped: number;
  ratePlansTotal: number;
  ratePlansMapped: number;
  complete: boolean;
};

type MappingDetail = {
  rooms: RoomMappingRow[];
  rates: RateMappingRow[];
  coverage: MappingCoverage | null;
};

function fmtDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("es-ES", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(d);
}

function channelStatusPill(status: string) {
  const s = status.toLowerCase();
  const cls = s === "connected" || s === "active" ? "cm-pill-ok" : s === "error" ? "cm-pill-error" : "cm-pill-warn";
  const label = s === "connected" || s === "active" ? "Conectado" : s === "error" ? "Error" : s === "disabled" ? "Desactivado" : status;
  return <span className={`cm-pill ${cls}`}>{label}</span>;
}

function mappingStatusPill(status: string) {
  const s = status.toLowerCase();
  const cls = s === "active" ? "cm-pill-ok" : s === "error" ? "cm-pill-error" : "cm-pill-warn";
  return <span className={`cm-pill ${cls}`}>{s === "active" ? "Activo" : status}</span>;
}

function coveragePill(mapped: number, total: number, noun: string) {
  const complete = total > 0 && mapped >= total;
  const cls = complete ? "cm-pill-ok" : total === 0 ? "" : "cm-pill-warn";
  return <span className={`cm-pill ${cls}`}>{mapped}/{total} {noun}</span>;
}

export function ChannelMappingsScreen() {
  const propertyId = useMemo(() => getActivePropertyId(), []);
  const channelsState = useApiData<{ channels: ChannelRow[] }>(`/channel-manager/channels?propertyId=${propertyId}`);
  const channels = useMemo(() => toArray<ChannelRow>(channelsState.data?.channels ?? channelsState.data), [channelsState.data]);

  const [selectedId, setSelectedId] = useState<string>("");
  const [detail, setDetail] = useState<MappingDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailNonce, setDetailNonce] = useState(0);

  // Default to the first channel once the list is known (keeps a manual choice).
  useEffect(() => {
    if (!selectedId && channels.length > 0) setSelectedId(channels[0].id);
    if (selectedId && channels.length > 0 && !channels.some((c) => c.id === selectedId)) setSelectedId(channels[0].id);
  }, [channels, selectedId]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    Promise.all([
      apiRequest<{ mappings: RoomMappingRow[] }>(`/channel-manager/channels/${selectedId}/room-mappings`),
      apiRequest<{ mappings: RateMappingRow[] }>(`/channel-manager/channels/${selectedId}/rate-mappings`),
      apiRequest<MappingCoverage>(`/channel-manager/channels/${selectedId}/mapping-coverage`)
    ])
      .then(([rooms, rates, coverage]) => {
        if (cancelled) return;
        setDetail({
          rooms: toArray<RoomMappingRow>(rooms?.mappings ?? rooms),
          rates: toArray<RateMappingRow>(rates?.mappings ?? rates),
          coverage: coverage ?? null
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setDetailError(err instanceof Error ? err.message : "No se pudieron cargar los mapeos del canal.");
        setDetail(null);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, detailNonce]);

  const selected = channels.find((c) => c.id === selectedId) ?? null;

  if (channelsState.loading && !channelsState.data) return <LoadingBlock label="Cargando canales…" />;
  if (channelsState.error && !channelsState.data) {
    return <ErrorState title="No se pudieron cargar los canales" message={channelsState.error} onRetry={channelsState.refresh} />;
  }

  return (
    <>
      <div className="bo-page-head" style={{ marginBottom: "var(--space-6)" }}>
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Channel Manager</div>
          <h1 className="bo-page-title">Mapeos de canales</h1>
          <p className="bo-page-subtitle">
            Correspondencia entre tipos de habitación y planes tarifarios internos y los códigos de cada canal. Un mapeo incompleto bloquea el envío de ARI.
          </p>
        </div>
        <div className="bo-page-head-actions">
          <button type="button" className="primary" onClick={() => navigateTo("ChannelAggregatorHub")}>Gestionar en el Channel Manager</button>
        </div>
      </div>

      {channels.length === 0 ? (
        <section className="bo-card">
          <EmptyState
            title="Ningún canal conectado"
            message="Conecta un canal (Booking.com, Expedia, motor directo…) en el Channel Manager para poder mapear habitaciones y tarifas."
            actions={<button type="button" className="primary" onClick={() => navigateTo("ChannelAggregatorHub")}>Abrir Channel Manager</button>}
          />
        </section>
      ) : (
        <>
          <section className="bo-card" style={{ marginBottom: "var(--space-4)" }}>
            <div className="bo-card-head">
              <h3>Canales</h3>
              <span className="bo-status info">{channels.length}</span>
            </div>
            <div className="bo-table-wrap">
              <table className="cm-table">
                <thead>
                  <tr>
                    <th>Canal</th>
                    <th>Proveedor</th>
                    <th>Estado</th>
                    <th>Habitaciones</th>
                    <th>Tarifas</th>
                    <th>Última sincronización</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {channels.map((channel) => (
                    <tr key={channel.id} style={channel.id === selectedId ? { background: "var(--surface-2, var(--surface-1))" } : undefined}>
                      <td><strong>{channel.name}</strong></td>
                      <td className="bo-muted">{channel.providerCode}</td>
                      <td>{channelStatusPill(channel.status)}</td>
                      <td>{channel.roomMappingsCount}</td>
                      <td>{channel.rateMappingsCount}</td>
                      <td className="bo-muted">{fmtDateTime(channel.lastSyncAt)}</td>
                      <td>
                        <button type="button" className={channel.id === selectedId ? "primary" : "ghost"} onClick={() => setSelectedId(channel.id)}>
                          {channel.id === selectedId ? "Seleccionado" : "Ver mapeos"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {selected ? (
            <section className="bo-card">
              <div className="bo-card-head">
                <h3>Mapeos de «{selected.name}»</h3>
                <div className="bo-actions" style={{ margin: 0 }}>
                  {detail?.coverage ? (
                    <span className={`bo-status ${detail.coverage.complete ? "ok" : "warn"}`}>
                      {detail.coverage.complete ? "Cobertura completa" : "Cobertura incompleta"}
                    </span>
                  ) : null}
                  <button type="button" className="ghost" onClick={() => setDetailNonce((n) => n + 1)} disabled={detailLoading}>
                    {detailLoading ? "Actualizando…" : "Actualizar"}
                  </button>
                </div>
              </div>
              {detailError ? (
                <ErrorState title="No se pudieron cargar los mapeos" message={detailError} onRetry={() => setDetailNonce((n) => n + 1)} />
              ) : detailLoading && !detail ? (
                <LoadingBlock label="Cargando mapeos…" />
              ) : detail ? (
                <div className="bo-grid two">
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                      <strong style={{ fontSize: 13 }}>Tipos de habitación → código externo</strong>
                      {detail.coverage ? coveragePill(detail.coverage.roomTypesMapped, detail.coverage.roomTypesTotal, "mapeados") : null}
                    </div>
                    {detail.rooms.length === 0 ? (
                      <p className="bo-muted" style={{ textTransform: "none" }}>Sin mapeos de habitación para este canal.</p>
                    ) : (
                      <div className="bo-table-wrap">
                        <table className="cm-table">
                          <thead>
                            <tr>
                              <th>Tipo de habitación</th>
                              <th>Código externo</th>
                              <th>ID externo</th>
                              <th>Estado</th>
                            </tr>
                          </thead>
                          <tbody>
                            {detail.rooms.map((m) => (
                              <tr key={m.id}>
                                <td>{m.roomTypeName ?? m.roomTypeCode ?? m.roomTypeId}</td>
                                <td>{m.externalRoomCode}</td>
                                <td className="bo-muted">{m.externalRoomId ?? "—"}</td>
                                <td>{mappingStatusPill(m.status)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                      <strong style={{ fontSize: 13 }}>Planes tarifarios → código externo</strong>
                      {detail.coverage ? coveragePill(detail.coverage.ratePlansMapped, detail.coverage.ratePlansTotal, "mapeados") : null}
                    </div>
                    {detail.rates.length === 0 ? (
                      <p className="bo-muted" style={{ textTransform: "none" }}>Sin mapeos de tarifa para este canal.</p>
                    ) : (
                      <div className="bo-table-wrap">
                        <table className="cm-table">
                          <thead>
                            <tr>
                              <th>Plan tarifario</th>
                              <th>Código externo</th>
                              <th>ID externo</th>
                              <th>Estado</th>
                            </tr>
                          </thead>
                          <tbody>
                            {detail.rates.map((m) => (
                              <tr key={m.id}>
                                <td>{m.ratePlanName ?? m.ratePlanCode ?? m.ratePlanId}</td>
                                <td>{m.externalRateCode}</td>
                                <td className="bo-muted">{m.externalRateId ?? "—"}</td>
                                <td>{mappingStatusPill(m.status)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}
        </>
      )}
    </>
  );
}
