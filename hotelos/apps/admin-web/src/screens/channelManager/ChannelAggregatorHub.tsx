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
//   Rate grid v2 (ChannelV2Panel): GET /properties/:id/channels, /channel-manager/channels/:channelId/*,
//   /channel-manager/deliveries (list, :id/retry, drain) — see services/channelsApi.ts
//
// Sharp edge: push operations fail with a `"No rate mappings configured"` (or
// `"No room mappings configured"`) error from the aggregator if the channel
// has not been mapped yet. The result table surfaces that text from the API
// response so the user can act on it.

import { useTabHost } from "../tabs/TabHost";
import { getActivePropertyId } from "../../services/activeProperty";
import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../../services/api-client";
import { useApiData } from "../../hooks/useApiData";
import { useToast } from "../../components/Toast";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { CocoaScreenInstructionsCard } from "../../components/cocoa-guidance";
import { CocoaButton } from "../../components/cocoa/CocoaButton";
import { CHANNELS_INSTRUCTIONS } from "../../content/screen-instructions/channels";
import {
  CHANNEL_MODE_LABELS,
  CHANNEL_PROVIDER_CATALOG,
  archiveChannel,
  createChannel,
  drainDeliveries,
  listChannels,
  listChannelsWithDetails,
  listDeliveries,
  patchChannel,
  retryDelivery,
  setChannelCredentials,
  testChannel,
  type ChannelAdminRow,
  type ChannelDeliveryRow,
  type ChannelMode
} from "../../services/channelsApi";
import { CHANNEL_HAS_PENDING_DELIVERIES_CODE, classifyRateGridError, fetchRatePlans } from "../../services/rateGridApi";
import { fetchRoomTypes } from "../../services/pmsCommerceApi";
import { getActivePropertyName } from "../../services/activeProperty";
import { channelModeLabel, channelTypeLabel, deliveryStatusLabel, providerLabel } from "../../components/cocoa-rate-grid/helpers";
import { date, dateTime, money } from "../../lib/format";

function navigateToScreen(screen: string): void {
  window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: screen }));
}

const PROPERTY_ID = getActivePropertyId();

/** Spanish labels for the raw statuses of channels, sync jobs and legacy push results. */
const STATUS_LABELS: Record<string, string> = {
  active: "activo",
  inactive: "inactivo",
  paused: "en pausa",
  error: "error",
  connected: "conectado",
  disconnected: "desconectado",
  success: "correcto",
  succeeded: "correcto",
  ok: "correcto",
  completed: "completado",
  failed: "fallido",
  cancelled: "cancelado",
  pending: "pendiente",
  running: "en curso",
  queued: "en cola"
};

const DELIVERY_KIND_LABELS: Record<string, string> = { rates: "tarifas", availability: "disponibilidad", restrictions: "restricciones" };

const SYNC_TYPE_LABELS: Record<string, string> = {
  push_rates: "envío de tarifas",
  push_availability: "envío de disponibilidad",
  push_restrictions: "envío de restricciones",
  ingest_reservations: "importación de reservas",
  test: "prueba de conexión",
  parity_check: "chequeo de paridad"
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status.toLowerCase()] ?? status;
}

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

function fmtTime(value: string | null | undefined): string {
  return dateTime(value, { style: "dayMonth" });
}

/** "2026-12-16" → "16/12/2026" (es-ES). */
function fmtDate(iso: string | null | undefined): string {
  return date(iso);
}

function severityClass(severity: string): "ok" | "warn" | "error" {
  const s = severity.toLowerCase();
  if (s === "critical" || s === "high") return "error";
  if (s === "medium" || s === "warn" || s === "warning") return "warn";
  return "ok";
}

function statusPill(status: string) {
  const s = status.toLowerCase();
  const label = statusLabel(status);
  // Tooltip in Spanish too (the raw enum only when there is no translation).
  const title = label === status ? status : `Estado: ${label}`;
  if (s === "active" || s === "success" || s === "succeeded" || s === "ok" || s === "completed") {
    return <span className="cm-pill cm-pill-ok" title={title}>{label}</span>;
  }
  if (s === "failed" || s === "error" || s === "inactive" || s === "cancelled" || s === "disconnected") {
    return <span className="cm-pill cm-pill-error" title={title}>{label}</span>;
  }
  return <span className="cm-pill cm-pill-warn" title={title}>{label}</span>;
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
    return <div className="bo-muted" style={{ fontSize: 12, color: "var(--danger-ink, #b3261e)" }}>Preparación: {error}</div>;
  }
  if (!data) {
    return <div className="bo-muted" style={{ fontSize: 12 }}>Preparación: …</div>;
  }
  return (
    <div style={{ marginTop: 8, padding: 8, borderRadius: 8, background: "var(--surface-2, #f5f6f8)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <strong style={{ fontSize: 12 }}>Preparación del canal</strong>
        {data.readyToGoLive ? (
          <span className="cm-pill cm-pill-ok">Listo para producción</span>
        ) : (
          <span className="cm-pill cm-pill-warn">Configuración incompleta</span>
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
      <div className="bo-muted" style={{ fontSize: 11, marginTop: 4 }}>Modo del conector: {channelModeLabel(data.adapterMode)}</div>
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
        <div className="bo-muted" style={{ fontSize: 12 }}>Cargando mapeos…</div>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <strong style={{ fontSize: 12 }}>Tipos de habitación → código externo</strong>
            {coverage ? (
              <span className={`cm-pill ${coverage.roomTypesMapped >= coverage.roomTypesTotal && coverage.roomTypesTotal > 0 ? "cm-pill-ok" : "cm-pill-warn"}`}>
                {coverage.roomTypesMapped}/{coverage.roomTypesTotal} tipos mapeados
              </span>
            ) : null}
          </div>
          <table className="cm-table" style={{ fontSize: 12 }}>
            <thead>
              <tr>
                <th>Tipo de habitación</th>
                <th>Código externo</th>
                <th>ID externo</th>
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
                <td><input style={inputStyle} placeholder="id del tipo de habitación" aria-label="Id del tipo de habitación" value={roomTypeId} onChange={(e) => setRoomTypeId(e.target.value)} /></td>
                <td><input style={inputStyle} placeholder="código externo" aria-label="Código externo de la habitación" value={roomExtCode} onChange={(e) => setRoomExtCode(e.target.value)} /></td>
                <td><input style={inputStyle} placeholder="id externo (opcional)" aria-label="Id externo de la habitación" value={roomExtId} onChange={(e) => setRoomExtId(e.target.value)} /></td>
                <td><button type="button" className="primary" disabled={busy} onClick={addRoom}>Añadir</button></td>
              </tr>
            </tbody>
          </table>

          <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "10px 0 6px" }}>
            <strong style={{ fontSize: 12 }}>Planes tarifarios → código externo</strong>
            {coverage ? (
              <span className={`cm-pill ${coverage.ratePlansMapped >= coverage.ratePlansTotal && coverage.ratePlansTotal > 0 ? "cm-pill-ok" : "cm-pill-warn"}`}>
                {coverage.ratePlansMapped}/{coverage.ratePlansTotal} planes mapeados
              </span>
            ) : null}
          </div>
          <table className="cm-table" style={{ fontSize: 12 }}>
            <thead>
              <tr>
                <th>Plan tarifario</th>
                <th>Código externo</th>
                <th>ID externo</th>
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
                <td><input style={inputStyle} placeholder="id del plan tarifario" aria-label="Id del plan tarifario" value={ratePlanId} onChange={(e) => setRatePlanId(e.target.value)} /></td>
                <td><input style={inputStyle} placeholder="código externo" aria-label="Código externo del plan" value={rateExtCode} onChange={(e) => setRateExtCode(e.target.value)} /></td>
                <td><input style={inputStyle} placeholder="id externo (opcional)" aria-label="Id externo del plan" value={rateExtId} onChange={(e) => setRateExtId(e.target.value)} /></td>
                <td><button type="button" className="primary" disabled={busy} onClick={addRate}>Añadir</button></td>
              </tr>
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rate grid v2 · channel layer (GET /properties/:id/channels for the list;
// /channel-manager/channels/:channelId/* and /channel-manager/deliveries* for
// everything else — services/channelsApi.ts). Kept as ONE self-contained panel so
// the legacy hub above keeps working against the old API: when the v2 routes
// answer 404 the panel says so and nothing else on the screen breaks.
// ---------------------------------------------------------------------------

const DELIVERY_STATUSES = ["", "queued", "sending", "sent", "confirmed", "rejected", "timeout", "superseded"];
const CREDENTIAL_FIELDS: Record<string, string[]> = {
  channex: ["apiKey", "propertyId"],
  booking_com: ["username", "password", "hotelId"],
  expedia: ["username", "password", "hotelId"],
  airbnb: ["apiKey"],
  hotelbeds: ["apiKey", "secret"],
  vrbo: ["apiKey"]
};

function describeV2Error(err: unknown, route = "/properties/:id/channels"): string {
  const info = classifyRateGridError(err);
  if (info.kind === "not_deployed") return `Este API no expone todavía la ruta v2 ${route}: hace falta reiniciar el API con el módulo cableado.`;
  if (info.kind === "forbidden") return "Sin permiso (channel_manager.manage) para esta operación.";
  return info.message;
}

function ChannelV2Panel({ propertyId, onChanged }: { propertyId: string; onChanged: () => void }) {
  const { showToast } = useToast();
  const [rows, setRows] = useState<ChannelAdminRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // Alta
  const [providerCode, setProviderCode] = useState(CHANNEL_PROVIDER_CATALOG[0].code);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<ChannelMode>("stub");
  const [markup, setMarkup] = useState("0");

  // Credentials (write-only)
  const [credChannelId, setCredChannelId] = useState<string | null>(null);
  const [credValues, setCredValues] = useState<Record<string, string>>({});
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  // «Archivar» asks for confirmation: the channel leaves the editor but its
  // history stays and a new alta of the same provider revives it.
  const [archiveTarget, setArchiveTarget] = useState<ChannelAdminRow | null>(null);

  // Product names for the deliveries log (ids are meaningless to the hotelier).
  const [roomTypeNames, setRoomTypeNames] = useState<Map<string, string>>(() => new Map());
  const [ratePlanCodes, setRatePlanCodes] = useState<Map<string, string>>(() => new Map());
  useEffect(() => {
    let cancelled = false;
    fetchRoomTypes(propertyId)
      .then((list) => {
        if (!cancelled) setRoomTypeNames(new Map(list.map((rt) => [rt.id, rt.name])));
      })
      .catch(() => {
        /* ids shown instead of names */
      });
    fetchRatePlans(propertyId)
      .then((list) => {
        if (!cancelled) setRatePlanCodes(new Map(list.map((p) => [p.id, p.code])));
      })
      .catch(() => {
        /* ids shown instead of codes */
      });
    return () => {
      cancelled = true;
    };
  }, [propertyId]);
  const productLabel = (roomTypeId: string, ratePlanId: string) =>
    `${roomTypeNames.get(roomTypeId) ?? roomTypeId} · ${ratePlanId === "*" ? "todos los planes" : (ratePlanCodes.get(ratePlanId) ?? ratePlanId)}`;

  // Deliveries log
  const [deliveries, setDeliveries] = useState<ChannelDeliveryRow[]>([]);
  const [deliveriesCursor, setDeliveriesCursor] = useState<string | null>(null);
  const [deliveriesError, setDeliveriesError] = useState<string | null>(null);
  const [filterChannel, setFilterChannel] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [deliveriesNonce, setDeliveriesNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // Detail per channel: the list route has no hasCredentials / autoPushOnSave.
    listChannelsWithDetails(propertyId)
      .then((list) => {
        if (cancelled) return;
        setRows(list);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(describeV2Error(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [propertyId, nonce]);

  useEffect(() => {
    let cancelled = false;
    listDeliveries(propertyId, { channelId: filterChannel || undefined, status: filterStatus || undefined, from: filterFrom || undefined, to: filterTo || undefined, limit: 50 })
      .then((page) => {
        if (cancelled) return;
        setDeliveries(page.items);
        setDeliveriesCursor(page.nextCursor);
        setDeliveriesError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setDeliveries([]);
        setDeliveriesError(describeV2Error(err, "/channel-manager/deliveries"));
      });
    return () => {
      cancelled = true;
    };
  }, [propertyId, filterChannel, filterStatus, filterFrom, filterTo, deliveriesNonce]);

  const refresh = () => {
    setNonce((n) => n + 1);
    onChanged();
  };

  async function run(label: string, fn: () => Promise<void>, successMessage?: string) {
    setBusy(label);
    try {
      await fn();
      if (successMessage) showToast(successMessage, { variant: "success" });
    } catch (err) {
      const message = describeV2Error(err);
      setError(message);
      showToast(message, { variant: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function handleCreate() {
    const catalog = CHANNEL_PROVIDER_CATALOG.find((c) => c.code === providerCode);
    if (!catalog || !name.trim()) return;
    const markupPercent = Number(markup.replace(",", "."));
    await run(
      "create",
      async () => {
        // channelType is derived server-side from the provider code; the
        // channel starts "active" so the readiness check does not stop at
        // "Canal inactivo" before credentials/mappings are even loaded.
        await createChannel({
          propertyId,
          providerCode,
          name: name.trim(),
          mode,
          status: "active",
          defaultMarkupPercent: Number.isFinite(markupPercent) ? markupPercent : 0
        });
        setName("");
        refresh();
      },
      "Canal creado. Carga credenciales y mapea productos antes de publicar."
    );
  }

  async function handleModeChange(row: ChannelAdminRow, nextMode: ChannelMode) {
    await run(`mode:${row.id}`, async () => {
      await patchChannel(row.id, { mode: nextMode });
      refresh();
    });
  }

  async function handleMarkupChange(row: ChannelAdminRow, value: string) {
    const pct = Number(value.replace(",", "."));
    if (!Number.isFinite(pct)) return;
    await run(`markup:${row.id}`, async () => {
      await patchChannel(row.id, { defaultMarkupPercent: pct });
      refresh();
    });
  }

  // Desactivar / Activar (PATCH status): an inactive channel keeps its
  // credentials and mappings but leaves «Precio visto por», the channels view
  // and the publish drawer of the editor; nothing is queued for it.
  async function handleToggleStatus(row: ChannelAdminRow) {
    const next = row.status === "active" ? "inactive" : "active";
    await run(
      `status:${row.id}`,
      async () => {
        await patchChannel(row.id, { status: next });
        refresh();
      },
      next === "inactive" ? `${row.name} desactivado: el editor deja de ofrecerlo y no se le encola nada.` : `${row.name} activado.`
    );
  }

  // Archivar (DELETE = logical): refused with 409 CHANNEL_HAS_PENDING_DELIVERIES
  // while deliveries are queued / in flight — the message explains what to do.
  async function handleArchive(row: ChannelAdminRow) {
    setArchiveTarget(null);
    setBusy(`archive:${row.id}`);
    try {
      const res = await archiveChannel(row.id);
      showToast(`${row.name} archivado (se conservan ${res.keptDeliveries} entregas en el historial). Volver a dar de alta ${row.providerCode} lo revive.`, { variant: "success" });
      refresh();
    } catch (err) {
      const info = classifyRateGridError(err);
      const message =
        info.code === CHANNEL_HAS_PENDING_DELIVERIES_CODE
          ? `No se puede archivar ${row.name} todavía: ${info.message}`
          : describeV2Error(err, "/channel-manager/channels/:id");
      setError(message);
      showToast(message, { variant: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function handleSaveCredentials(row: ChannelAdminRow) {
    const entries = Object.entries(credValues).filter(([, v]) => v.trim() !== "");
    if (entries.length === 0) return;
    await run(
      `cred:${row.id}`,
      async () => {
        await setChannelCredentials(row.id, Object.fromEntries(entries));
        setCredValues({});
        setCredChannelId(null);
        refresh();
      },
      "Credenciales guardadas (cifradas; no se vuelven a mostrar)."
    );
  }

  async function handleTest(row: ChannelAdminRow) {
    await run(`test:${row.id}`, async () => {
      const res = await testChannel(row.id);
      // Only the metadata the hotelier can act on (routing / hotel id); the
      // provider and mode are already on the row, hashes and blobs would
      // stretch it.
      const metaRecord = (res.metadata ?? {}) as Record<string, unknown>;
      const metaParts: string[] = [];
      if (typeof metaRecord.routedVia === "string") metaParts.push(`vía ${metaRecord.routedVia}`);
      if (typeof metaRecord.hotelId === "string" || typeof metaRecord.hotelId === "number") metaParts.push(`hotel ${String(metaRecord.hotelId)}`);
      setTestResult((prev) => ({
        ...prev,
        [row.id]: `${res.ok ? "Conexión correcta" : "Fallo de conexión"} · ${CHANNEL_MODE_LABELS[res.mode] ?? channelModeLabel(res.mode)}${res.error ? ` · ${res.error}` : ""}${metaParts.length ? ` · ${metaParts.join(" · ")}` : ""}`
      }));
      refresh();
    });
  }

  async function handleDrain() {
    await run("drain", async () => {
      // One run per channel of this property (the API takes a single channelId).
      const res = await drainDeliveries({ channelIds: rows.map((r) => r.id) });
      showToast(`Drenaje ejecutado: ${res.processed} de ${res.candidates} entregas procesadas${res.errors.length > 0 ? ` · ${res.errors.length} errores` : ""}.`, { variant: res.errors.length > 0 ? "info" : "success" });
      setDeliveriesNonce((n) => n + 1);
      refresh();
    });
  }

  async function handleRetry(delivery: ChannelDeliveryRow) {
    await run(`retry:${delivery.id}`, async () => {
      await retryDelivery(delivery.id);
      setDeliveriesNonce((n) => n + 1);
    }, "Entrega reencolada.");
  }

  async function handleLoadMoreDeliveries() {
    if (!deliveriesCursor) return;
    await run("more", async () => {
      const page = await listDeliveries(propertyId, { channelId: filterChannel || undefined, status: filterStatus || undefined, from: filterFrom || undefined, to: filterTo || undefined, limit: 50, cursor: deliveriesCursor });
      setDeliveries((prev) => [...prev, ...page.items]);
      setDeliveriesCursor(page.nextCursor);
    });
  }

  const channelName = (id: string) => rows.find((r) => r.id === id)?.name ?? id;
  const inputStyle: CSSProperties = { fontSize: 12, padding: "3px 6px" };
  const catalog = CHANNEL_PROVIDER_CATALOG.find((c) => c.code === providerCode);

  return (
    <section className="bo-card">
      <div className="bo-card-head">
        <div>
          <p className="bo-muted">Rate grid v2</p>
          <h3>Canales conectados al editor de tarifas</h3>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span className="bo-chip">{rows.length} canales</span>
          <button type="button" className="ghost" disabled={busy !== null} onClick={handleDrain}>
            {busy === "drain" ? "Drenando…" : "Drenar ahora"}
          </button>
          <button type="button" className="ghost" onClick={refresh}>
            ↻
          </button>
        </div>
      </div>
      <p className="bo-muted" style={{ marginTop: 0, textTransform: "none" }}>
        Los cambios publicados desde el editor se encolan como entregas por canal (tarifas / disponibilidad / restricciones) y un proceso las envía con
        reintentos. Modo <strong>simulado</strong> = sin red; <strong>modo de pruebas</strong> = entorno de pruebas del proveedor; <strong>real</strong> solo
        con credenciales cargadas. Nada sale a Internet sin modo real.
      </p>

      {error ? (
        <div className="bo-muted" style={{ fontSize: 12, color: "var(--danger-ink, #b3261e)", marginBottom: 8, textTransform: "none" }} role="alert">
          {error}
        </div>
      ) : null}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end", marginBottom: 12 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="bo-muted" style={{ fontSize: 12 }}>Proveedor</span>
          <select value={providerCode} onChange={(e) => setProviderCode(e.target.value)}>
            {CHANNEL_PROVIDER_CATALOG.map((c) => (
              <option key={c.code} value={c.code}>{c.label}</option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="bo-muted" style={{ fontSize: 12 }}>Nombre</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={`Booking.com · ${getActivePropertyName() || "mi hotel"}`} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="bo-muted" style={{ fontSize: 12 }}>Modo</span>
          <select value={mode} onChange={(e) => setMode(e.target.value as ChannelMode)}>
            {(Object.keys(CHANNEL_MODE_LABELS) as ChannelMode[]).map((m) => (
              <option key={m} value={m}>{CHANNEL_MODE_LABELS[m]}</option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="bo-muted" style={{ fontSize: 12 }}>Recargo %</span>
          <input value={markup} onChange={(e) => setMarkup(e.target.value)} inputMode="decimal" style={{ width: 80 }} />
        </label>
        <button type="button" className="primary" disabled={busy !== null || !name.trim()} onClick={handleCreate}>
          {busy === "create" ? "Creando…" : "Dar de alta"}
        </button>
        {catalog ? <span className="bo-muted" style={{ fontSize: 12, flexBasis: "100%", textTransform: "none" }}>{catalog.note}</span> : null}
      </div>

      {loading ? (
        <p className="bo-muted">Cargando canales v2…</p>
      ) : rows.length === 0 && !error ? (
        <p className="bo-muted">Sin canales todavía. Da de alta el primero arriba (empieza en modo simulado o de pruebas).</p>
      ) : (
        <div className="rev-report-wrap">
          <table className="cm-table">
            <thead>
              <tr>
                <th>Canal</th>
                <th>Modo</th>
                <th style={{ textAlign: "right" }}>Recargo</th>
                <th>Credenciales</th>
                <th style={{ textAlign: "right" }}>Productos</th>
                <th>Listo</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <strong>{row.name}</strong>
                    <div className="bo-muted" style={{ fontSize: 12, textTransform: "none" }}>{row.providerCode} · {statusPill(row.status)}</div>
                    {testResult[row.id] ? <div className="bo-muted" style={{ fontSize: 12, textTransform: "none" }}>Prueba: {testResult[row.id]}</div> : null}
                  </td>
                  <td>
                    {/* The select edits the REQUESTED mode; the instance cap (CHANNEL_MAX_MODE) decides the effective one. */}
                    <select value={row.requestedMode ?? row.mode} disabled={busy !== null} aria-label={`Modo de ${row.name}`} onChange={(e) => void handleModeChange(row, e.target.value as ChannelMode)}>
                      {(Object.keys(CHANNEL_MODE_LABELS) as ChannelMode[]).map((m) => (
                        <option key={m} value={m}>{CHANNEL_MODE_LABELS[m]}</option>
                      ))}
                    </select>
                    {row.requestedMode && row.requestedMode !== row.mode ? (
                      <div className="bo-muted" style={{ fontSize: 11, textTransform: "none", marginTop: 4 }} title={`Solicitado: ${channelModeLabel(row.requestedMode)} · tope de la instancia (CHANNEL_MAX_MODE): ${channelModeLabel(row.maxMode)}`}>
                        ⚠ Efectivo: <strong>{channelModeLabel(row.mode)}</strong> (solicitado {channelModeLabel(row.requestedMode)}; la instancia lo limita a {channelModeLabel(row.maxMode ?? row.mode)})
                      </div>
                    ) : null}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <input
                      key={`${row.id}:${row.markupPercent}`}
                      defaultValue={String(row.markupPercent ?? 0)}
                      style={{ ...inputStyle, width: 60, textAlign: "right" }}
                      inputMode="decimal"
                      onBlur={(e) => {
                        if (e.target.value !== String(row.markupPercent ?? 0)) void handleMarkupChange(row, e.target.value);
                      }}
                    />
                    %
                  </td>
                  <td>
                    {row.credentialsUndecryptable ? (
                      <span className="cm-pill cm-pill-error" style={{ textTransform: "none" }} title="Hay credenciales guardadas pero la clave de cifrado actual no puede abrirlas (clave rotada sin backfill): vuelve a guardarlas.">
                        ilegibles (clave rotada)
                      </span>
                    ) : row.hasCredentials ? (
                      <span className="cm-pill cm-pill-ok">cargadas</span>
                    ) : (
                      <span className="cm-pill cm-pill-warn">sin credenciales</span>
                    )}
                    {row.credentialsUndecryptable && credChannelId !== row.id ? (
                      <div className="bo-muted" style={{ fontSize: 11, textTransform: "none", marginTop: 4 }}>Vuelve a guardarlas para que el canal pueda usarlas.</div>
                    ) : null}
                    {credChannelId === row.id ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
                        {(CREDENTIAL_FIELDS[row.providerCode] ?? ["apiKey"]).map((field) => (
                          <input
                            key={field}
                            style={inputStyle}
                            type={/password|secret/i.test(field) ? "password" : "text"}
                            placeholder={field}
                            value={credValues[field] ?? ""}
                            onChange={(e) => setCredValues((prev) => ({ ...prev, [field]: e.target.value }))}
                            autoComplete="off"
                          />
                        ))}
                        <div style={{ display: "flex", gap: 4 }}>
                          <button type="button" className="primary" disabled={busy !== null} onClick={() => void handleSaveCredentials(row)}>Guardar</button>
                          <button type="button" className="ghost" onClick={() => { setCredChannelId(null); setCredValues({}); }}>Cancelar</button>
                        </div>
                        <span className="bo-muted" style={{ fontSize: 11 }}>Solo escritura: se cifran en el servidor y no se vuelven a mostrar.</span>
                      </div>
                    ) : (
                      <button type="button" className="ghost" style={{ marginLeft: 6 }} onClick={() => { setCredChannelId(row.id); setCredValues({}); }}>
                        {row.hasCredentials ? "Sustituir" : "Cargar"}
                      </button>
                    )}
                  </td>
                  <td style={{ textAlign: "right" }}>{row.mappedProducts}</td>
                  <td>
                    {row.readyToPush ? (
                      <span className="cm-pill cm-pill-ok">listo</span>
                    ) : (
                      <span className="cm-pill cm-pill-warn" style={{ textTransform: "none" }} title={row.readinessSummary ?? undefined}>
                        {row.readinessSummary ?? "incompleto"}
                      </span>
                    )}
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      <button type="button" className="ghost" disabled={busy !== null} onClick={() => void handleTest(row)}>
                        {busy === `test:${row.id}` ? "…" : "Probar conexión"}
                      </button>
                      <button type="button" className="ghost" onClick={() => navigateToScreen(`ChannelMappings#channel=${encodeURIComponent(row.id)}`)}>
                        Mapeos
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        disabled={busy !== null}
                        title={row.status === "active" ? "El canal deja de ofrecerse en el editor y no se le encola nada; conserva credenciales y mapeos" : "Vuelve a ofrecer el canal en el editor"}
                        onClick={() => void handleToggleStatus(row)}
                      >
                        {busy === `status:${row.id}` ? "…" : row.status === "active" ? "Desactivar" : "Activar"}
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        disabled={busy !== null}
                        style={{ color: "var(--danger-ink, #b3261e)" }}
                        title="Archivado lógico: el canal desaparece del editor y del hub; el historial de entregas se conserva y una nueva alta del mismo proveedor lo revive"
                        onClick={() => setArchiveTarget(row)}
                      >
                        {busy === `archive:${row.id}` ? "…" : "Archivar"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={archiveTarget !== null}
        title={archiveTarget ? `Archivar ${archiveTarget.name}` : "Archivar canal"}
        description="El canal desaparece del editor de tarifas y de este hub; sus entregas y mapeos se conservan en el historial. No se archiva si tiene entregas pendientes de envío (en cola o en vuelo): drena primero. Dar de alta de nuevo el mismo proveedor lo revive."
        confirmLabel="Archivar"
        cancelLabel="Cancelar"
        variant="danger"
        onConfirm={() => {
          if (archiveTarget) void handleArchive(archiveTarget);
        }}
        onCancel={() => setArchiveTarget(null)}
      />

      <div className="bo-card-head" style={{ marginTop: 16 }}>
        <div>
          <p className="bo-muted">Cola de envíos</p>
          <h3>Log de entregas</h3>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          <select value={filterChannel} onChange={(e) => setFilterChannel(e.target.value)} aria-label="Canal">
            <option value="">Todos los canales</option>
            {rows.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
          <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} aria-label="Estado">
            {DELIVERY_STATUSES.map((st) => (
              <option key={st || "all"} value={st}>{st ? deliveryStatusLabel(st) : "Todos los estados"}</option>
            ))}
          </select>
          <input type="date" value={filterFrom} onChange={(e) => setFilterFrom(e.target.value)} aria-label="Desde" />
          <input type="date" value={filterTo} onChange={(e) => setFilterTo(e.target.value)} aria-label="Hasta" />
          <button type="button" className="ghost" aria-label="Actualizar el log de entregas" onClick={() => setDeliveriesNonce((n) => n + 1)}>↻</button>
        </div>
      </div>
      {deliveriesError ? (
        <p className="bo-muted" style={{ fontSize: 12, color: "var(--danger-ink, #b3261e)", textTransform: "none" }} role="alert">{deliveriesError}</p>
      ) : deliveries.length === 0 ? (
        <p className="bo-muted">Sin entregas con estos filtros.</p>
      ) : (
        <div className="rev-report-wrap">
          <table className="cm-table">
            <thead>
              <tr>
                <th>Cuándo</th>
                <th>Canal</th>
                <th>Tipo</th>
                <th>Producto</th>
                <th>Fecha</th>
                <th>Estado</th>
                <th style={{ textAlign: "right" }}>Intentos</th>
                <th>Error</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {deliveries.map((d) => (
                <tr key={d.id}>
                  <td>{fmtTime(d.updatedAt ?? d.createdAt)}</td>
                  <td>{channelName(d.channelId)}</td>
                  <td>{DELIVERY_KIND_LABELS[d.kind] ?? d.kind}</td>
                  <td className="bo-muted" style={{ fontSize: 12, textTransform: "none" }} title={`${d.roomTypeId} · ${d.ratePlanId}`}>{productLabel(d.roomTypeId, d.ratePlanId)}</td>
                  <td>{fmtDate(d.date)}</td>
                  <td><span className={`cm-pill ${d.status === "confirmed" || d.status === "sent" ? "cm-pill-ok" : d.status === "rejected" || d.status === "timeout" ? "cm-pill-error" : "cm-pill-warn"}`} title={d.status}>{deliveryStatusLabel(d.status)}</span></td>
                  <td style={{ textAlign: "right" }}>{d.attempts}</td>
                  <td className="bo-muted" style={{ fontSize: 12 }}>{d.lastError ?? "—"}</td>
                  <td>
                    <button
                      type="button"
                      className="ghost"
                      disabled={busy !== null || !(d.status === "rejected" || d.status === "timeout")}
                      title={d.status === "rejected" || d.status === "timeout" ? "Vuelve a encolar la entrega" : `Solo se reintentan entregas rechazadas o sin respuesta (estado: ${deliveryStatusLabel(d.status)})`}
                      onClick={() => void handleRetry(d)}
                    >
                      {busy === `retry:${d.id}` ? "…" : "Reintentar"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {deliveriesCursor ? (
            <button type="button" className="ghost" style={{ marginTop: 8 }} disabled={busy !== null} onClick={() => void handleLoadMoreDeliveries()}>
              Cargar más
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}

export function ChannelAggregatorHub() {
  // Hosted inside a routed tab container (Tanda 5): the container paints the page header.
  const embedded = useTabHost() !== null;
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

  // The legacy list route returns every row of the property, archived ones
  // included (aggregator.service.listChannels filters by `active` only): hide
  // them here, as the v2 panel and the editor do.
  const channels = (channelsState.data?.channels ?? []).filter((c) => c.status?.toLowerCase() !== "archived");
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
      showToast(`Envío de ${DELIVERY_KIND_LABELS[kind] ?? kind} lanzado`, { variant: "success" });
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
      showToast("Prueba de canal lanzada", { variant: "success" });
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
          {embedded ? null : (
            <>
              <div className="bo-page-eyebrow">Comercial · Canales de venta</div>
              <h1 className="bo-page-title">Canales de venta</h1>
            </>
          )}
          <p className="bo-page-subtitle">
            Un único punto para tarifas, disponibilidad y restricciones: cada publicación del editor de tarifas llega a Booking, Expedia, Airbnb,
            Hotelbeds y Vrbo. Las reservas de los canales entran como reservas externas y la paridad de precios se vigila de forma continua.
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
            ↻ Actualizar
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

      <ChannelV2Panel propertyId={PROPERTY_ID} onChanged={() => { channelsState.refresh(); setReadinessNonce((n) => n + 1); }} />

      <section className="rev-kpi-grid">
        <article className={`rev-kpi rev-kpi-${kpis.activeChannels > 0 ? "ok" : "warn"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Canales activos</span></div>
          <div className="rev-kpi-value">{channelsState.loading && !channelsState.data ? "…" : kpis.activeChannels}</div>
          <div className="rev-kpi-delta">Canales con estado «activo»</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Última sincronización correcta</span></div>
          <div className="rev-kpi-value" style={{ fontSize: 22 }}>{fmtTime(kpis.lastSync)}</div>
          <div className="rev-kpi-delta">Más reciente entre todos los canales</div>
        </article>
        <article className={`rev-kpi rev-kpi-${kpis.pendingAlerts === 0 ? "ok" : kpis.pendingAlerts <= 2 ? "warn" : "error"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Alertas de paridad abiertas</span></div>
          <div className="rev-kpi-value">{alertsState.loading && !alertsState.data ? "…" : kpis.pendingAlerts}</div>
          <div className="rev-kpi-delta">Diferencias de precio sin resolver</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Reservas importadas (24 h)</span></div>
          <div className="rev-kpi-value">{jobsState.loading && !jobsState.data ? "…" : kpis.reservations24h}</div>
          <div className="rev-kpi-delta">Recibidas de los canales en las últimas 24 horas</div>
        </article>
      </section>

      <section className="bo-card">
        <div className="bo-card-head">
          <div>
            <p className="bo-muted">Canales</p>
            <h3>Canales conectados (agregador)</h3>
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
                      {/* Labelled and without .bo-muted's uppercase: «AIRBNB · VACATION_RENTAL» read as a raw enum (browser-ux-final#12). */}
                      <div className="bo-muted" style={{ fontSize: 12, textTransform: "none" }} title={`${c.providerCode} · ${c.channelType}`}>
                        {providerLabel(c.providerCode)} · {channelTypeLabel(c.channelType)}
                      </div>
                    </div>
                    {statusPill(c.status)}
                  </div>
                  <div className="bo-muted" style={{ fontSize: 12, marginBottom: 6 }}>
                    Última sincronización: {fmtTime(c.latestSync?.finishedAt ?? c.latestSync?.createdAt ?? c.lastSyncAt)}
                  </div>
                  <div className="bo-muted" style={{ fontSize: 12, marginBottom: 10 }}>
                    Mapeos: {c.roomMappingsCount} habitaciones · {c.rateMappingsCount} tarifas
                  </div>
                  {c.latestSync?.errorMessage ? (
                    <div className="bo-muted" style={{ fontSize: 12, marginBottom: 8, color: "var(--danger-ink, #b3261e)" }}>
                      {/^No (room|rate) mappings configured/i.test(c.latestSync.errorMessage) ? (
                        <>
                          ⚠ {c.latestSync.errorMessage}. Configura los mapeos más abajo.
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
                      {testingChannel === c.id ? "…" : "Probar"}
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      disabled={syncingChannel === c.id}
                      onClick={() => handleSyncChannel(c.id)}
                    >
                      {syncingChannel === c.id ? "…" : "Sincronizar ahora"}
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => setExpandedMappings((prev) => ({ ...prev, [c.id]: !prev[c.id] }))}
                    >
                      {expandedMappings[c.id] ? "Ocultar mapeos" : "Mapeos"}
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
            <p className="bo-muted">Envío unificado (agregador)</p>
            <h3>Enviar a todos los canales</h3>
          </div>
        </div>
        <p className="bo-muted" style={{ marginTop: 0, marginBottom: 12, textTransform: "none" }}>
          Para cambiar tarifas o restricciones antes de enviarlas, usa el editor de tarifas.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end", marginBottom: 12 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="bo-muted" style={{ fontSize: 12 }}>Desde</span>
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="bo-muted" style={{ fontSize: 12 }}>Hasta</span>
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </label>
          <button type="button" className="primary" disabled={pushBusy !== null} onClick={() => pushAction("rates")}>
            {pushBusy === "rates" ? "Enviando…" : "Enviar tarifas"}
          </button>
          <button type="button" className="primary" disabled={pushBusy !== null} onClick={() => pushAction("availability")}>
            {pushBusy === "availability" ? "Enviando…" : "Enviar disponibilidad"}
          </button>
          <button type="button" className="primary" disabled={pushBusy !== null} onClick={() => pushAction("restrictions")}>
            {pushBusy === "restrictions" ? "Enviando…" : "Enviar restricciones"}
          </button>
          <button type="button" className="ghost" onClick={handleParityCheck}>
            Comprobar paridad
          </button>
        </div>
        {pushResult ? (
          <div className="rev-report-wrap">
            <div className="bo-muted" style={{ fontSize: 12, marginBottom: 6 }}>
              Último envío: <strong>{DELIVERY_KIND_LABELS[pushResult.label] ?? pushResult.label}</strong> · {fmtDate(pushResult.payload.dateRange.from)} → {fmtDate(pushResult.payload.dateRange.to)}
            </div>
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Canal</th>
                  <th>Proveedor</th>
                  <th>Estado</th>
                  <th style={{ textAlign: "right" }}>Enviados</th>
                  <th style={{ textAlign: "right" }}>Latencia</th>
                  <th>Errores</th>
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
                          ? `⚠ ${errText} — abre «Mapeos» en la tarjeta del canal para corregirlo.`
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
            <p className="bo-muted">Actividad</p>
            <h3>Sincronizaciones recientes</h3>
          </div>
          <span className="bo-chip">{jobs.length}</span>
        </div>
        {jobs.length === 0 ? (
          <p className="bo-muted">Todavía no hay sincronizaciones registradas.</p>
        ) : (
          <div className="rev-report-wrap">
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Cuándo</th>
                  <th>Canal</th>
                  <th>Tarea</th>
                  <th>Estado</th>
                  <th style={{ textAlign: "right" }}>Latencia</th>
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
                      <td title={j.syncType}>{SYNC_TYPE_LABELS[j.syncType] ?? j.syncType}</td>
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
            <p className="bo-muted">Paridad de precios</p>
            <h3>Alertas de paridad abiertas</h3>
          </div>
          <span className="bo-chip">{openAlerts.length}</span>
        </div>
        {openAlerts.length === 0 ? (
          <p className="bo-muted">No hay alertas de paridad abiertas.</p>
        ) : (
          <div className="rev-report-wrap">
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Noche</th>
                  <th>Canal</th>
                  <th>Gravedad</th>
                  <th style={{ textAlign: "right" }}>Nuestro precio</th>
                  <th style={{ textAlign: "right" }}>Precio en el canal</th>
                  <th>Mensaje</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {openAlerts.map((a) => (
                  <tr key={a.id}>
                    <td>{fmtDate(a.stayDate)}</td>
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
                        {resolvingAlert === a.id ? "…" : "Resolver"}
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
