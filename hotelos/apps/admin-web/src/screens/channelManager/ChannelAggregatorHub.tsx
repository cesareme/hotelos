// Channel manager — OTA aggregator hub.
//
// Top of the screen: KPI cards (active channels, last sync, open parity alerts,
// reservations 24h). Then a channel cards grid (with logo placeholder built
// from the provider code initial), then an unified push panel (rates,
// availability, restrictions), then a sync jobs table and a parity alerts
// panel.
//
// Data:
//   /channel-manager/channels             (30s poll)
//   /channel-manager/sync-jobs            (30s poll)
//   /channel-manager/parity/alerts        (30s poll, status=open)
//
// Sharp edge: push operations fail with a `"No rate mappings configured"` (or
// `"No room mappings configured"`) error from the aggregator if the channel
// has not been mapped yet. The result table surfaces that text from the API
// response so the user can act on it.

import { getActivePropertyId } from "../../services/activeProperty";
import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../../services/api-client";
import { useApiData } from "../../hooks/useApiData";
import { useToast } from "../../components/Toast";
import { CocoaScreenInstructionsCard } from "../../components/cocoa-guidance";
import { CocoaButton } from "../../components/cocoa/CocoaButton";
import { CHANNELS_INSTRUCTIONS } from "../../content/screen-instructions/channels";

function navigateToScreen(screen: string): void {
  window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: screen }));
}

const PROPERTY_ID = getActivePropertyId();

type ChannelRow = {
  id: string;
  propertyId: string;
  providerCode: string;
  name: string;
  channelType: string;
  status: string;
  commissionPercent: number | null;
  lastSyncAt: string | null;
  roomMappingsCount: number;
  rateMappingsCount: number;
  latestSync: {
    id: string;
    syncType: string;
    status: string;
    errorMessage: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    createdAt: string;
  } | null;
};

type SyncJobRow = {
  id: string;
  channelId: string | null;
  syncType: string;
  status: string;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  responsePayloadJson: unknown;
};

type ParityAlertRow = {
  id: string;
  severity: string;
  stayDate: string;
  sourceChannel: string | null;
  directRate: number | null;
  channelRate: number | null;
  currency: string | null;
  message: string;
  status: string;
  createdAt: string;
};

type PushResult = {
  propertyId: string;
  dateRange: { from: string; to: string };
  results: Array<{
    channelId: string;
    providerCode: string;
    ok: boolean;
    pushed?: number;
    latencyMs?: number;
    errors?: string[];
  }>;
};

type ReadinessCheck = {
  key: string;
  label: string;
  status: "ok" | "warn" | "error";
  detail: string;
};

type ChannelReadiness = {
  channelId: string;
  providerCode: string;
  adapterMode: "stub" | "sandbox" | "real";
  checks: ReadinessCheck[];
  readyToGoLive: boolean;
};

type RoomMappingRow = {
  id: string;
  channelId: string;
  roomTypeId: string;
  roomTypeName: string | null;
  roomTypeCode: string | null;
  externalRoomId: string | null;
  externalRoomCode: string;
  status: string;
};

type RateMappingRow = {
  id: string;
  channelId: string;
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

const eur = new Intl.NumberFormat("es-ES", { useGrouping: true, style: "currency", currency: "EUR" });

function money(value: number | null | undefined): string {
  return eur.format(Number.isFinite(value as number) ? (value as number) : 0);
}

function fmtTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("es-ES", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(d);
}

function severityClass(severity: string): "ok" | "warn" | "error" {
  const s = severity.toLowerCase();
  if (s === "critical" || s === "high") return "error";
  if (s === "medium" || s === "warn" || s === "warning") return "warn";
  return "ok";
}

function statusPill(status: string) {
  const s = status.toLowerCase();
  if (s === "active" || s === "success" || s === "succeeded" || s === "ok" || s === "completed") {
    return <span className="cm-pill cm-pill-ok">{status}</span>;
  }
  if (s === "failed" || s === "error" || s === "inactive" || s === "cancelled" || s === "disconnected") {
    return <span className="cm-pill cm-pill-error">{status}</span>;
  }
  return <span className="cm-pill cm-pill-warn">{status}</span>;
}

function severityPill(severity: string) {
  const cls = severityClass(severity);
  const pill = cls === "ok" ? "cm-pill-ok" : cls === "warn" ? "cm-pill-warn" : "cm-pill-error";
  return <span className={`cm-pill ${pill}`}>{severity}</span>;
}

function statusDotColor(status: "ok" | "warn" | "error"): string {
  if (status === "ok") return "var(--success-ink, #1e7d34)";
  if (status === "warn") return "var(--warning-ink, #b8860b)";
  return "var(--danger-ink, #b3261e)";
}

function StatusDot({ status, title }: { status: "ok" | "warn" | "error"; title?: string }) {
  return (
    <span
      aria-hidden
      title={title}
      style={{
        display: "inline-block",
        width: 10,
        height: 10,
        borderRadius: "50%",
        background: statusDotColor(status),
        flexShrink: 0
      }}
    />
  );
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function inDaysIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// Per-channel readiness mini-panel: a colored-dot checklist + a go-live badge.
// Fetches on mount (lightweight; one call per visible channel card).
function ChannelReadinessPanel({ channelId, refreshKey }: { channelId: string; refreshKey: number }) {
  const [data, setData] = useState<ChannelReadiness | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiRequest<ChannelReadiness>(`/channel-manager/channels/${channelId}/readiness`)
      .then((value) => { if (!cancelled) { setData(value); setError(null); } })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [channelId, refreshKey]);

  if (error) {
    return <div className="bo-muted" style={{ fontSize: 12, color: "var(--danger-ink, #b3261e)" }}>Readiness: {error}</div>;
  }
  if (!data) {
    return <div className="bo-muted" style={{ fontSize: 12 }}>Readiness: …</div>;
  }
  return (
    <div style={{ marginTop: 8, padding: 8, borderRadius: 8, background: "var(--surface-2, #f5f6f8)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <strong style={{ fontSize: 12 }}>Readiness</strong>
        {data.readyToGoLive ? (
          <span className="cm-pill cm-pill-ok">Ready to go live</span>
        ) : (
          <span className="cm-pill cm-pill-warn">Setup incomplete</span>
        )}
      </div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
        {data.checks.map((c) => (
          <li key={c.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <StatusDot status={c.status} title={c.detail} />
            <span style={{ fontSize: 12 }}>{c.label}</span>
            <span className="bo-muted" style={{ fontSize: 11, marginLeft: "auto", textAlign: "right" }} title={c.detail}>
              {c.detail}
            </span>
          </li>
        ))}
      </ul>
      <div className="bo-muted" style={{ fontSize: 11, marginTop: 4 }}>Adapter mode: {data.adapterMode}</div>
    </div>
  );
}

// Per-channel mappings section: room-type and rate-plan tables with inline
// add / delete, plus a coverage line ("3/5 room types mapped"). Expandable so
// the card stays compact until the hotelier needs to wire mappings.
function ChannelMappingsPanel({
  channelId,
  onChanged
}: {
  channelId: string;
  onChanged: () => void;
}) {
  const [rooms, setRooms] = useState<RoomMappingRow[]>([]);
  const [rates, setRates] = useState<RateMappingRow[]>([]);
  const [coverage, setCoverage] = useState<MappingCoverage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Add-room form
  const [roomTypeId, setRoomTypeId] = useState("");
  const [roomExtId, setRoomExtId] = useState("");
  const [roomExtCode, setRoomExtCode] = useState("");
  // Add-rate form
  const [ratePlanId, setRatePlanId] = useState("");
  const [rateExtId, setRateExtId] = useState("");
  const [rateExtCode, setRateExtCode] = useState("");

  async function reload() {
    setLoading(true);
    try {
      const [r1, r2, cov] = await Promise.all([
        apiRequest<{ mappings: RoomMappingRow[] }>(`/channel-manager/channels/${channelId}/room-mappings`),
        apiRequest<{ mappings: RateMappingRow[] }>(`/channel-manager/channels/${channelId}/rate-mappings`),
        apiRequest<MappingCoverage>(`/channel-manager/channels/${channelId}/mapping-coverage`)
      ]);
      setRooms(r1.mappings);
      setRates(r2.mappings);
      setCoverage(cov);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  async function afterMutate() {
    await reload();
    onChanged();
  }

  async function addRoom() {
    if (!roomTypeId.trim() || !roomExtCode.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/channel-manager/channels/${channelId}/room-mappings`, {
        method: "POST",
        body: { roomTypeId: roomTypeId.trim(), externalRoomId: roomExtId.trim() || null, externalRoomCode: roomExtCode.trim() }
      });
      setRoomTypeId(""); setRoomExtId(""); setRoomExtCode("");
      await afterMutate();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function deleteRoom(id: string) {
    setBusy(true);
    try {
      await apiRequest(`/channel-manager/room-mappings/${id}`, { method: "DELETE" });
      await afterMutate();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function addRate() {
    if (!ratePlanId.trim() || !rateExtCode.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/channel-manager/channels/${channelId}/rate-mappings`, {
        method: "POST",
        body: { ratePlanId: ratePlanId.trim(), externalRateId: rateExtId.trim() || null, externalRateCode: rateExtCode.trim() }
      });
      setRatePlanId(""); setRateExtId(""); setRateExtCode("");
      await afterMutate();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function deleteRate(id: string) {
    setBusy(true);
    try {
      await apiRequest(`/channel-manager/rate-mappings/${id}`, { method: "DELETE" });
      await afterMutate();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const inputStyle: CSSProperties = { fontSize: 12, padding: "3px 6px" };

  return (
    <div style={{ marginTop: 8, padding: 8, borderRadius: 8, background: "var(--surface-2, #f5f6f8)" }}>
      {error ? (
        <div className="bo-muted" style={{ fontSize: 12, color: "var(--danger-ink, #b3261e)", marginBottom: 6 }}>{error}</div>
      ) : null}
      {loading ? (
        <div className="bo-muted" style={{ fontSize: 12 }}>Loading mappings…</div>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <strong style={{ fontSize: 12 }}>Room types → external</strong>
            {coverage ? (
              <span className={`cm-pill ${coverage.roomTypesMapped >= coverage.roomTypesTotal && coverage.roomTypesTotal > 0 ? "cm-pill-ok" : "cm-pill-warn"}`}>
                {coverage.roomTypesMapped}/{coverage.roomTypesTotal} room types mapped
              </span>
            ) : null}
          </div>
          <table className="cm-table" style={{ fontSize: 12 }}>
            <thead>
              <tr>
                <th>Room type</th>
                <th>External code</th>
                <th>External id</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rooms.map((m) => (
                <tr key={m.id}>
                  <td>{m.roomTypeName ?? m.roomTypeId}</td>
                  <td>{m.externalRoomCode}</td>
                  <td className="bo-muted">{m.externalRoomId ?? "—"}</td>
                  <td>
                    <button type="button" className="ghost" disabled={busy} onClick={() => deleteRoom(m.id)}>Eliminar</button>
                  </td>
                </tr>
              ))}
              <tr>
                <td><input style={inputStyle} placeholder="roomTypeId" value={roomTypeId} onChange={(e) => setRoomTypeId(e.target.value)} /></td>
                <td><input style={inputStyle} placeholder="external code" value={roomExtCode} onChange={(e) => setRoomExtCode(e.target.value)} /></td>
                <td><input style={inputStyle} placeholder="external id (optional)" value={roomExtId} onChange={(e) => setRoomExtId(e.target.value)} /></td>
                <td><button type="button" className="primary" disabled={busy} onClick={addRoom}>Añadir</button></td>
              </tr>
            </tbody>
          </table>

          <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "10px 0 6px" }}>
            <strong style={{ fontSize: 12 }}>Rate plans → external</strong>
            {coverage ? (
              <span className={`cm-pill ${coverage.ratePlansMapped >= coverage.ratePlansTotal && coverage.ratePlansTotal > 0 ? "cm-pill-ok" : "cm-pill-warn"}`}>
                {coverage.ratePlansMapped}/{coverage.ratePlansTotal} rate plans mapped
              </span>
            ) : null}
          </div>
          <table className="cm-table" style={{ fontSize: 12 }}>
            <thead>
              <tr>
                <th>Rate plan</th>
                <th>External code</th>
                <th>External id</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rates.map((m) => (
                <tr key={m.id}>
                  <td>{m.ratePlanName ?? m.ratePlanId}</td>
                  <td>{m.externalRateCode}</td>
                  <td className="bo-muted">{m.externalRateId ?? "—"}</td>
                  <td>
                    <button type="button" className="ghost" disabled={busy} onClick={() => deleteRate(m.id)}>Eliminar</button>
                  </td>
                </tr>
              ))}
              <tr>
                <td><input style={inputStyle} placeholder="ratePlanId" value={ratePlanId} onChange={(e) => setRatePlanId(e.target.value)} /></td>
                <td><input style={inputStyle} placeholder="external code" value={rateExtCode} onChange={(e) => setRateExtCode(e.target.value)} /></td>
                <td><input style={inputStyle} placeholder="external id (optional)" value={rateExtId} onChange={(e) => setRateExtId(e.target.value)} /></td>
                <td><button type="button" className="primary" disabled={busy} onClick={addRate}>Añadir</button></td>
              </tr>
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

export function ChannelAggregatorHub() {
  const { showToast } = useToast();
  const channelsState = useApiData<{ channels: ChannelRow[] }>(
    `/channel-manager/channels?propertyId=${PROPERTY_ID}`,
    { pollIntervalMs: 30000 }
  );
  const jobsState = useApiData<{ jobs: SyncJobRow[] }>(
    `/channel-manager/sync-jobs?propertyId=${PROPERTY_ID}`,
    { pollIntervalMs: 30000 }
  );
  const alertsState = useApiData<{ alerts: ParityAlertRow[] }>(
    `/channel-manager/parity/alerts?propertyId=${PROPERTY_ID}&status=open`,
    { pollIntervalMs: 30000 }
  );

  const channels = channelsState.data?.channels ?? [];
  const jobs = jobsState.data?.jobs ?? [];
  const openAlerts = alertsState.data?.alerts ?? [];

  // Push panel state.
  const [fromDate, setFromDate] = useState<string>(todayIso());
  const [toDate, setToDate] = useState<string>(inDaysIso(14));
  const [pushResult, setPushResult] = useState<{ label: string; payload: PushResult } | null>(null);
  const [pushBusy, setPushBusy] = useState<string | null>(null);
  const [pushError, setPushError] = useState<string | null>(null);

  const [resolvingAlert, setResolvingAlert] = useState<string | null>(null);
  const [testingChannel, setTestingChannel] = useState<string | null>(null);
  const [syncingChannel, setSyncingChannel] = useState<string | null>(null);
  // Per-channel "mappings" expand toggle + a bump counter that re-fetches the
  // readiness panel after a mapping changes (mappings feed the readiness check).
  const [expandedMappings, setExpandedMappings] = useState<Record<string, boolean>>({});
  const [readinessNonce, setReadinessNonce] = useState(0);

  const kpis = useMemo(() => {
    const activeChannels = channels.filter((c) => c.status.toLowerCase() === "active").length;
    let lastSync: string | null = null;
    for (const c of channels) {
      const candidate = c.latestSync?.finishedAt ?? c.latestSync?.createdAt ?? c.lastSyncAt;
      if (!candidate) continue;
      if (!lastSync || new Date(candidate).getTime() > new Date(lastSync).getTime()) {
        lastSync = candidate;
      }
    }
    const pendingAlerts = openAlerts.length;
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const reservations24h = jobs.filter(
      (j) => j.syncType === "ingest_reservations" && new Date(j.createdAt).getTime() >= dayAgo
    ).reduce((sum, j) => {
      const payload = j.responsePayloadJson as { imported?: number } | null;
      return sum + (typeof payload?.imported === "number" ? payload.imported : 0);
    }, 0);
    return { activeChannels, lastSync, pendingAlerts, reservations24h };
  }, [channels, jobs, openAlerts]);

  async function pushAction(kind: "rates" | "availability" | "restrictions") {
    setPushBusy(kind);
    setPushError(null);
    setPushResult(null);
    try {
      const path =
        kind === "rates"
          ? "/channel-manager/push-rates"
          : kind === "availability"
            ? "/channel-manager/push-availability"
            : "/channel-manager/push-restrictions";
      const payload = await apiRequest<PushResult>(path, {
        method: "POST",
        body: { propertyId: PROPERTY_ID, from: fromDate, to: toDate }
      });
      setPushResult({ label: kind, payload });
      jobsState.refresh();
      channelsState.refresh();
      showToast(`Push ${kind} enviado`, { variant: "success" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setPushError(message);
      showToast(message, { variant: "error" });
    } finally {
      setPushBusy(null);
    }
  }

  async function handleTestChannel(channelId: string) {
    setTestingChannel(channelId);
    try {
      await apiRequest(`/channel-manager/channels/${channelId}/test`, { method: "POST" });
      channelsState.refresh();
      jobsState.refresh();
      showToast("Test de canal lanzado", { variant: "success" });
    } catch (err) {
      // Surface inline; reuse pushError slot since it's free.
      const message = err instanceof Error ? err.message : String(err);
      setPushError(message);
      showToast(message, { variant: "error" });
    } finally {
      setTestingChannel(null);
    }
  }

  async function handleSyncChannel(channelId: string) {
    setSyncingChannel(channelId);
    try {
      await apiRequest(`/channel-manager/channels/${channelId}/ingest`, {
        method: "POST",
        body: {}
      });
      channelsState.refresh();
      jobsState.refresh();
      showToast("Sincronización lanzada", { variant: "success" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setPushError(message);
      showToast(message, { variant: "error" });
    } finally {
      setSyncingChannel(null);
    }
  }

  async function handleResolveAlert(alertId: string) {
    setResolvingAlert(alertId);
    try {
      await apiRequest(`/channel-manager/parity/alerts/${alertId}/resolve`, { method: "POST" });
      alertsState.refresh();
      showToast("Alerta resuelta", { variant: "success" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setPushError(message);
      showToast(message, { variant: "error" });
    } finally {
      setResolvingAlert(null);
    }
  }

  async function handleParityCheck() {
    setPushError(null);
    try {
      await apiRequest("/channel-manager/parity/check", {
        method: "POST",
        body: { propertyId: PROPERTY_ID, from: fromDate, to: toDate }
      });
      alertsState.refresh();
      showToast("Chequeo de paridad lanzado", { variant: "success" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setPushError(message);
      showToast(message, { variant: "error" });
    }
  }

  useEffect(() => {
    if (!pushError) return;
    const id = window.setTimeout(() => setPushError(null), 6000);
    return () => window.clearTimeout(id);
  }, [pushError]);

  const channelById = useMemo(() => {
    const m = new Map<string, ChannelRow>();
    for (const c of channels) m.set(c.id, c);
    return m;
  }, [channels]);

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Channels · Aggregator</div>
          <h1 className="bo-page-title">Channel Manager (agregador OTA)</h1>
          <p className="bo-page-subtitle">
            SiteMinder-style hub. Rates, availability and restrictions fan out to Booking, Expedia,
            Airbnb, Hotelbeds and Vrbo from a single push. Reservations come back as ExternalReservation;
            parity is monitored continuously.
          </p>
        </div>
        <div className="bo-page-head-actions">
          <CocoaButton
            variant="filled"
            tone="accent"
            onClick={() => navigateToScreen("RateGridEditorScreen")}
          >
            Editar tarifas en grid
          </CocoaButton>
          <button type="button" className="ghost" onClick={() => { channelsState.refresh(); jobsState.refresh(); alertsState.refresh(); }}>
            ↻ Refresh
          </button>
        </div>
      </div>

      <CocoaScreenInstructionsCard
        title={CHANNELS_INSTRUCTIONS.whatIsThis}
        description="Conecta y monitoriza tus canales OTA desde un único punto."
        steps={[...CHANNELS_INSTRUCTIONS.howToUse]}
        tip={CHANNELS_INSTRUCTIONS.tips.join(" · ")}
        dismissible
        persistKey="channels"
      />

      {pushError ? (
        <section className="bo-card" style={{ borderColor: "var(--danger-ink)" }}>
          {pushError}
        </section>
      ) : null}

      <section className="rev-kpi-grid">
        <article className={`rev-kpi rev-kpi-${kpis.activeChannels > 0 ? "ok" : "warn"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Active channels</span></div>
          <div className="rev-kpi-value">{channelsState.loading && !channelsState.data ? "…" : kpis.activeChannels}</div>
          <div className="rev-kpi-delta">Canales con status “active”</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Last successful sync</span></div>
          <div className="rev-kpi-value" style={{ fontSize: 22 }}>{fmtTime(kpis.lastSync)}</div>
          <div className="rev-kpi-delta">Más reciente entre todos los canales</div>
        </article>
        <article className={`rev-kpi rev-kpi-${kpis.pendingAlerts === 0 ? "ok" : kpis.pendingAlerts <= 2 ? "warn" : "error"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Pending parity alerts</span></div>
          <div className="rev-kpi-value">{alertsState.loading && !alertsState.data ? "…" : kpis.pendingAlerts}</div>
          <div className="rev-kpi-delta">Estado “open”</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Reservations 24h</span></div>
          <div className="rev-kpi-value">{jobsState.loading && !jobsState.data ? "…" : kpis.reservations24h}</div>
          <div className="rev-kpi-delta">Importadas vía ingest jobs</div>
        </article>
      </section>

      <section className="bo-card">
        <div className="bo-card-head">
          <div>
            <p className="bo-muted">Channels</p>
            <h3>Connected channels</h3>
          </div>
          <span className="bo-chip">{channels.length} canales</span>
        </div>
        {channels.length === 0 ? (
          <p className="bo-muted">No hay canales conectados todavía.</p>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
              gap: 12
            }}
          >
            {channels.map((c) => {
              const initial = (c.providerCode?.[0] ?? "?").toUpperCase();
              return (
                <article key={c.id} className="bo-card" style={{ padding: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                    <div
                      aria-hidden
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: "50%",
                        background: "var(--accent-ink, #2f6feb)",
                        color: "#fff",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontWeight: 700,
                        fontSize: 18
                      }}
                    >
                      {initial}
                    </div>
                    <div style={{ flex: 1 }}>
                      <strong>{c.name}</strong>
                      <div className="bo-muted" style={{ fontSize: 12 }}>{c.providerCode} · {c.channelType}</div>
                    </div>
                    {statusPill(c.status)}
                  </div>
                  <div className="bo-muted" style={{ fontSize: 12, marginBottom: 6 }}>
                    Last sync: {fmtTime(c.latestSync?.finishedAt ?? c.latestSync?.createdAt ?? c.lastSyncAt)}
                  </div>
                  <div className="bo-muted" style={{ fontSize: 12, marginBottom: 10 }}>
                    Mappings: {c.roomMappingsCount} rooms · {c.rateMappingsCount} rates
                  </div>
                  {c.latestSync?.errorMessage ? (
                    <div className="bo-muted" style={{ fontSize: 12, marginBottom: 8, color: "var(--danger-ink, #b3261e)" }}>
                      {/^No (room|rate) mappings configured/i.test(c.latestSync.errorMessage) ? (
                        <>
                          ⚠ {c.latestSync.errorMessage}. Configure mappings below.
                        </>
                      ) : (
                        c.latestSync.errorMessage
                      )}
                    </div>
                  ) : null}
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      className="ghost"
                      disabled={testingChannel === c.id}
                      onClick={() => handleTestChannel(c.id)}
                    >
                      {testingChannel === c.id ? "…" : "Test"}
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      disabled={syncingChannel === c.id}
                      onClick={() => handleSyncChannel(c.id)}
                    >
                      {syncingChannel === c.id ? "…" : "Sync now"}
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => setExpandedMappings((prev) => ({ ...prev, [c.id]: !prev[c.id] }))}
                    >
                      {expandedMappings[c.id] ? "Hide mappings" : "Mappings"}
                    </button>
                  </div>
                  <ChannelReadinessPanel channelId={c.id} refreshKey={readinessNonce} />
                  {expandedMappings[c.id] ? (
                    <ChannelMappingsPanel
                      channelId={c.id}
                      onChanged={() => {
                        setReadinessNonce((n) => n + 1);
                        channelsState.refresh();
                      }}
                    />
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="bo-card">
        <div className="bo-card-head">
          <div>
            <p className="bo-muted">Unified push</p>
            <h3>Push to all channels</h3>
          </div>
        </div>
        <p className="bo-muted" style={{ marginTop: 0, marginBottom: 12 }}>
          Para editar tarifas/restricciones antes del push, usa el editor de Rate Grid
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end", marginBottom: 12 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="bo-muted" style={{ fontSize: 12 }}>From</span>
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="bo-muted" style={{ fontSize: 12 }}>To</span>
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </label>
          <button type="button" className="primary" disabled={pushBusy !== null} onClick={() => pushAction("rates")}>
            {pushBusy === "rates" ? "Pushing…" : "Push rates"}
          </button>
          <button type="button" className="primary" disabled={pushBusy !== null} onClick={() => pushAction("availability")}>
            {pushBusy === "availability" ? "Pushing…" : "Push availability"}
          </button>
          <button type="button" className="primary" disabled={pushBusy !== null} onClick={() => pushAction("restrictions")}>
            {pushBusy === "restrictions" ? "Pushing…" : "Push restrictions"}
          </button>
          <button type="button" className="ghost" onClick={handleParityCheck}>
            Run parity check
          </button>
        </div>
        {pushResult ? (
          <div className="rev-report-wrap">
            <div className="bo-muted" style={{ fontSize: 12, marginBottom: 6 }}>
              Last push: <strong>{pushResult.label}</strong> · {pushResult.payload.dateRange.from} → {pushResult.payload.dateRange.to}
            </div>
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Channel</th>
                  <th>Provider</th>
                  <th>Status</th>
                  <th style={{ textAlign: "right" }}>Pushed</th>
                  <th style={{ textAlign: "right" }}>Latency</th>
                  <th>Errors</th>
                </tr>
              </thead>
              <tbody>
                {pushResult.payload.results.map((row) => {
                  const ch = channelById.get(row.channelId);
                  const errText = row.errors?.join("; ") ?? "";
                  const mappingMissing = /No (room|rate) mappings configured/i.test(errText);
                  return (
                    <tr key={row.channelId}>
                      <td>{ch?.name ?? row.channelId}</td>
                      <td>{row.providerCode}</td>
                      <td>{row.ok ? statusPill("success") : statusPill("failed")}</td>
                      <td style={{ textAlign: "right" }}>{row.pushed ?? 0}</td>
                      <td style={{ textAlign: "right" }}>{row.latencyMs ? `${row.latencyMs} ms` : "—"}</td>
                      <td
                        className="bo-muted"
                        style={{ fontSize: 12, color: mappingMissing ? "var(--danger-ink, #b3261e)" : undefined }}
                      >
                        {mappingMissing
                          ? `⚠ ${errText} — open “Mappings” on the channel card to fix.`
                          : errText || "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section className="bo-card">
        <div className="bo-card-head">
          <div>
            <p className="bo-muted">Activity</p>
            <h3>Recent sync jobs</h3>
          </div>
          <span className="bo-chip">{jobs.length}</span>
        </div>
        {jobs.length === 0 ? (
          <p className="bo-muted">No sync jobs registrados todavía.</p>
        ) : (
          <div className="rev-report-wrap">
            <table className="cm-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Channel</th>
                  <th>Job</th>
                  <th>Status</th>
                  <th style={{ textAlign: "right" }}>Latency</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {jobs.slice(0, 50).map((j) => {
                  const ch = j.channelId ? channelById.get(j.channelId) : null;
                  const start = j.startedAt ? new Date(j.startedAt).getTime() : null;
                  const end = j.finishedAt ? new Date(j.finishedAt).getTime() : null;
                  const latency = start !== null && end !== null ? `${Math.max(0, end - start)} ms` : "—";
                  return (
                    <tr key={j.id}>
                      <td>{fmtTime(j.createdAt)}</td>
                      <td>{ch?.name ?? j.channelId ?? "—"}</td>
                      <td>{j.syncType}</td>
                      <td>{statusPill(j.status)}</td>
                      <td style={{ textAlign: "right" }}>{latency}</td>
                      <td className="bo-muted" style={{ fontSize: 12 }}>{j.errorMessage ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="bo-card">
        <div className="bo-card-head">
          <div>
            <p className="bo-muted">Parity</p>
            <h3>Open parity alerts</h3>
          </div>
          <span className="bo-chip">{openAlerts.length}</span>
        </div>
        {openAlerts.length === 0 ? (
          <p className="bo-muted">No hay alertas de parity abiertas.</p>
        ) : (
          <div className="rev-report-wrap">
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Stay date</th>
                  <th>Channel</th>
                  <th>Severity</th>
                  <th style={{ textAlign: "right" }}>Our</th>
                  <th style={{ textAlign: "right" }}>Theirs</th>
                  <th>Message</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {openAlerts.map((a) => (
                  <tr key={a.id}>
                    <td>{a.stayDate}</td>
                    <td>{a.sourceChannel ?? "—"}</td>
                    <td>{severityPill(a.severity)}</td>
                    <td style={{ textAlign: "right" }}>{money(a.directRate)}</td>
                    <td style={{ textAlign: "right" }}>{money(a.channelRate)}</td>
                    <td className="bo-muted" style={{ fontSize: 12 }}>{a.message}</td>
                    <td>
                      <button
                        type="button"
                        className="ghost"
                        disabled={resolvingAlert === a.id}
                        onClick={() => handleResolveAlert(a.id)}
                      >
                        {resolvingAlert === a.id ? "…" : "Resolve"}
                      </button>
                    </td>
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
