// Channel manager — OTA aggregator hub (Comercial › Canales de venta, /comercial/canales).
//
// Cocoa 22 · ola 7 · lote 7-A (dashboard: DashboardAlojado / DashboardStandalone).
// CocoaPage (hosted inside CanalesTabs the container paints category and H1;
// standalone the page paints eyebrow · title · subtitle) → CocoaKpiStrip
// (active channels, last sync, open parity alerts, reservations 24 h) → the
// Rate grid v2 layer (alta, channels connected to the editor, deliveries log)
// → aggregator channel cards (readiness checklist + expandable mappings) →
// unified push → recent sync jobs → open parity alerts. Every table is a
// CocoaTable, every control a Cocoa primitive; the archive confirmation is a
// CocoaDialog and the write-only credentials are captured in a CocoaDrawer
// instead of a row cell (same POST, same fields).
//
// Data (unchanged):
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

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useTabHost } from "../tabs/TabHost";
import { treeHeaderFor } from "../tabs/tab-helpers";
import { getActivePropertyId, getActivePropertyName } from "../../services/activeProperty";
import { apiRequest } from "../../services/api-client";
import { useApiData } from "../../hooks/useApiData";
import { useToast } from "../../components/Toast";
import { navigateTo } from "../../lib/navigate";
import { CocoaScreenInstructionsCard } from "../../components/cocoa-guidance";
import { CHANNELS_INSTRUCTIONS } from "../../content/screen-instructions/channels";
import { ACTIONS } from "../../content/actions";
import { ExclamationCircleIcon } from "../../components/cocoa-icons/StatusIcons";
import {
  CHANNEL_MODE_LABELS,
  CHANNEL_PROVIDER_CATALOG,
  archiveChannel,
  createChannel,
  drainDeliveries,
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
import { channelModeLabel, channelTypeLabel, deliveryStatusLabel, providerLabel } from "../../components/cocoa-rate-grid/helpers";
import { date, dateRange, dateTime, money, number, plural, time } from "../../lib/format";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDatePicker,
  CocoaDialog,
  CocoaDrawer,
  CocoaField,
  CocoaFormRow,
  CocoaGrid,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  CocoaTable,
  CocoaToolbar,
  toneInk,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

const PROPERTY_ID = getActivePropertyId();

/** Spanish labels for the raw statuses of channels, sync jobs and legacy push results. */
const CHANNEL_STATUS_LABELS: Record<string, string> = {
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

/** Parity alert severities as the hotelier reads them (the raw value stays in the tooltip). */
const SEVERITY_LABELS: Record<string, string> = {
  critical: "crítica",
  high: "alta",
  medium: "media",
  warn: "media",
  warning: "media",
  low: "baja",
  info: "informativa"
};

/** Credential field names of the providers (write-only; keys unchanged, labels for the drawer). */
const CREDENTIAL_FIELD_LABELS: Record<string, string> = {
  apiKey: "Clave de API",
  propertyId: "Identificador de la propiedad en el canal",
  username: "Usuario",
  password: "Contraseña",
  hotelId: "Identificador del hotel",
  secret: "Secreto"
};

function statusLabel(status: string): string {
  return CHANNEL_STATUS_LABELS[status.toLowerCase()] ?? status;
}

function statusTone(status: string): CocoaTone {
  const s = status.toLowerCase();
  if (s === "active" || s === "success" || s === "succeeded" || s === "ok" || s === "completed" || s === "connected") return "success";
  if (s === "failed" || s === "error" || s === "inactive" || s === "cancelled" || s === "disconnected") return "danger";
  return "warning";
}

function StatusBadge({ status }: { status: string }) {
  const label = statusLabel(status);
  // Tooltip in Spanish too (the raw enum only when there is no translation).
  const title = label === status ? status : `Estado: ${label}`;
  return (
    <CocoaBadge tone={statusTone(status)} title={title}>
      {label}
    </CocoaBadge>
  );
}

function severityTone(severity: string): CocoaTone {
  const s = severity.toLowerCase();
  if (s === "critical" || s === "high") return "danger";
  if (s === "medium" || s === "warn" || s === "warning") return "warning";
  return "info";
}

function SeverityBadge({ severity }: { severity: string }) {
  const label = SEVERITY_LABELS[severity.toLowerCase()] ?? severity;
  return (
    <CocoaBadge tone={severityTone(severity)} title={label === severity ? undefined : severity}>
      {label}
    </CocoaBadge>
  );
}

function deliveryTone(status: string): CocoaTone {
  if (status === "confirmed" || status === "sent") return "success";
  if (status === "rejected" || status === "timeout") return "danger";
  return "warning";
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

const CHECK_TONE: Record<ReadinessCheck["status"], CocoaTone> = { ok: "success", warn: "warning", error: "danger" };

const MAPPING_MISSING = /No (room|rate) mappings configured/i;

function fmtTime(value: string | null | undefined): string {
  return dateTime(value, { style: "dayMonth" });
}

/** "2026-12-16" → "16/12/2026" (es-ES). */
function fmtDate(iso: string | null | undefined): string {
  return date(iso);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function inDaysIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// Secondary paragraph inside a card (callout size, secondary ink); the only
// text style of the screen, so every note reads the same.
const noteStyle: CSSProperties = { margin: 0, fontSize: "var(--cocoa-fs-callout)", lineHeight: "var(--cocoa-lh-callout)", color: "var(--cocoa-label-secondary)" };
const noteRightStyle: CSSProperties = { ...noteStyle, textAlign: "right", minWidth: 0 };
// Error text inside a table cell: the AA-safe danger ink (never the hue at 13 px).
const dangerTextStyle: CSSProperties = { color: toneInk("danger") };
// Tables inside a card: clip to the radius without creating a scroll container (§4.2 D26).
const clipStyle: CSSProperties = { overflow: "clip" };
const markupInputStyle: CSSProperties = { width: 72 };
const modeSelectStyle: CSSProperties = { width: 168 };

function Note({ children, title, align }: { children: ReactNode; title?: string; align?: "right" }) {
  return (
    <p style={align === "right" ? noteRightStyle : noteStyle} title={title}>
      {children}
    </p>
  );
}

function CoverageBadge({ mapped, total, noun }: { mapped: number; total: number; noun: string }) {
  const complete = total > 0 && mapped >= total;
  return (
    <CocoaBadge tone={complete ? "success" : total === 0 ? "neutral" : "warning"}>
      {number(mapped)}/{number(total)} {noun}
    </CocoaBadge>
  );
}

// Per-channel readiness mini-panel: a dot checklist + a go-live badge.
// Fetches on mount (lightweight; one call per visible channel card).
function ChannelReadinessPanel({ channelId, refreshKey }: { channelId: string; refreshKey: number }) {
  const [data, setData] = useState<ChannelReadiness | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiRequest<ChannelReadiness>(`/channel-manager/channels/${channelId}/readiness`)
      .then((value) => {
        if (!cancelled) {
          setData(value);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [channelId, refreshKey]);

  if (error) {
    return <CocoaState kind="error" inline title="Preparación no disponible" message={error} />;
  }
  if (!data) {
    return <CocoaState kind="loading" inline />;
  }
  return (
    <div className="cocoa-stack" data-gap="2">
      <div className="cocoa-row" data-justify="between" data-gap="2">
        <strong className="cocoa-caption">Preparación del canal</strong>
        {data.readyToGoLive ? <CocoaBadge tone="success">Listo para producción</CocoaBadge> : <CocoaBadge tone="warning">Configuración incompleta</CocoaBadge>}
      </div>
      <ul className="c22-section__list" aria-label="Comprobaciones de preparación">
        {data.checks.map((c) => (
          <li key={c.key}>
            <CocoaBadge tone={CHECK_TONE[c.status]} variant="dot" size="small" title={c.detail}>
              {c.label}
            </CocoaBadge>
            <Note align="right" title={c.detail}>
              {c.detail}
            </Note>
          </li>
        ))}
      </ul>
      <Note>Modo del conector: {channelModeLabel(data.adapterMode)}</Note>
    </div>
  );
}

const ROOM_MAPPING_COLUMNS: CocoaTableColumn<RoomMappingRow>[] = [
  { key: "roomType", label: "Tipo de habitación", render: (m) => m.roomTypeName ?? m.roomTypeId },
  { key: "externalRoomCode", label: "Código externo", fit: true },
  { key: "externalRoomId", label: "ID externo", fit: true, hideOnNarrow: true, render: (m) => m.externalRoomId ?? "—" }
];

const RATE_MAPPING_COLUMNS: CocoaTableColumn<RateMappingRow>[] = [
  { key: "ratePlan", label: "Plan tarifario", render: (m) => m.ratePlanName ?? m.ratePlanId },
  { key: "externalRateCode", label: "Código externo", fit: true },
  { key: "externalRateId", label: "ID externo", fit: true, hideOnNarrow: true, render: (m) => m.externalRateId ?? "—" }
];

// Per-channel mappings section: room-type and rate-plan tables with inline
// add / delete, plus a coverage badge («3/5 tipos con código»). Expandable so
// the card stays compact until the hotelier needs to wire mappings.
function ChannelMappingsPanel({ channelId, onChanged }: { channelId: string; onChanged: () => void }) {
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
      setRoomTypeId("");
      setRoomExtId("");
      setRoomExtCode("");
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
      setRatePlanId("");
      setRateExtId("");
      setRateExtCode("");
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

  if (loading) return <CocoaState kind="loading" inline />;

  return (
    <div className="cocoa-stack" data-gap="3">
      {error ? (
        <CocoaCallout tone="danger" role="alert">
          {error}
        </CocoaCallout>
      ) : null}

      <div className="cocoa-row" data-gap="2">
        <strong className="cocoa-caption">Tipos de habitación → código externo</strong>
        {coverage ? <CoverageBadge mapped={coverage.roomTypesMapped} total={coverage.roomTypesTotal} noun="tipos con código" /> : null}
      </div>
      {rooms.length === 0 ? (
        <CocoaState kind="empty" inline title="Sin correspondencias de habitación para este canal." />
      ) : (
        <CocoaTable
          columns={ROOM_MAPPING_COLUMNS}
          rows={rooms}
          rowKey="id"
          density="compact"
          caption="Correspondencias de tipos de habitación"
          rowActions={(m) => (
            <CocoaButton variant="plain" tone="destructive" size="small" disabled={busy} onClick={() => void deleteRoom(m.id)}>
              {ACTIONS.delete}
            </CocoaButton>
          )}
        />
      )}
      <CocoaFormRow columns={3} min={160}>
        <CocoaField label="Id del tipo de habitación">
          <CocoaInput size="small" value={roomTypeId} onChange={setRoomTypeId} placeholder="id del tipo de habitación" />
        </CocoaField>
        <CocoaField label="Código externo">
          <CocoaInput size="small" value={roomExtCode} onChange={setRoomExtCode} placeholder="código externo" />
        </CocoaField>
        <CocoaField label="Id externo" hint="opcional">
          <CocoaInput size="small" value={roomExtId} onChange={setRoomExtId} placeholder="id externo" />
        </CocoaField>
      </CocoaFormRow>
      <div className="cocoa-row" data-justify="end">
        <CocoaButton variant="tinted" tone="accent" size="small" loading={busy} disabled={busy || !roomTypeId.trim() || !roomExtCode.trim()} onClick={() => void addRoom()}>
          Añadir habitación
        </CocoaButton>
      </div>

      <div className="cocoa-row" data-gap="2">
        <strong className="cocoa-caption">Planes tarifarios → código externo</strong>
        {coverage ? <CoverageBadge mapped={coverage.ratePlansMapped} total={coverage.ratePlansTotal} noun="planes con código" /> : null}
      </div>
      {rates.length === 0 ? (
        <CocoaState kind="empty" inline title="Sin correspondencias de tarifa para este canal." />
      ) : (
        <CocoaTable
          columns={RATE_MAPPING_COLUMNS}
          rows={rates}
          rowKey="id"
          density="compact"
          caption="Correspondencias de planes tarifarios"
          rowActions={(m) => (
            <CocoaButton variant="plain" tone="destructive" size="small" disabled={busy} onClick={() => void deleteRate(m.id)}>
              {ACTIONS.delete}
            </CocoaButton>
          )}
        />
      )}
      <CocoaFormRow columns={3} min={160}>
        <CocoaField label="Id del plan tarifario">
          <CocoaInput size="small" value={ratePlanId} onChange={setRatePlanId} placeholder="id del plan tarifario" />
        </CocoaField>
        <CocoaField label="Código externo">
          <CocoaInput size="small" value={rateExtCode} onChange={setRateExtCode} placeholder="código externo" />
        </CocoaField>
        <CocoaField label="Id externo" hint="opcional">
          <CocoaInput size="small" value={rateExtId} onChange={setRateExtId} placeholder="id externo" />
        </CocoaField>
      </CocoaFormRow>
      <div className="cocoa-row" data-justify="end">
        <CocoaButton variant="tinted" tone="accent" size="small" loading={busy} disabled={busy || !ratePlanId.trim() || !rateExtCode.trim()} onClick={() => void addRate()}>
          Añadir plan
        </CocoaButton>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rate grid v2 · channel layer (GET /properties/:id/channels for the list;
// /channel-manager/channels/:channelId/* and /channel-manager/deliveries* for
// everything else — services/channelsApi.ts). Kept as ONE self-contained panel
// (three sections) so the legacy hub keeps working against the old API: when
// the v2 routes answer 404 the panel says so and nothing else on the screen
// breaks.
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

const MODE_OPTIONS = (Object.keys(CHANNEL_MODE_LABELS) as ChannelMode[]).map((m) => ({ value: m, label: CHANNEL_MODE_LABELS[m] }));
const PROVIDER_OPTIONS = CHANNEL_PROVIDER_CATALOG.map((c) => ({ value: c.code, label: c.label }));
const DELIVERY_STATUS_OPTIONS = DELIVERY_STATUSES.map((st) => ({ value: st, label: st ? deliveryStatusLabel(st) : "Todos los estados" }));

function describeV2Error(err: unknown, route = "/properties/:id/channels"): string {
  const info = classifyRateGridError(err);
  if (info.kind === "not_deployed") return `El servidor todavía no admite esta función (${route}): hace falta reiniciarlo con el módulo de canales activado.`;
  if (info.kind === "forbidden") return "Sin permiso (channel_manager.manage) para esta operación.";
  return info.message;
}

function ChannelV2Panel({ propertyId, refreshKey, onChanged }: { propertyId: string; refreshKey: number; onChanged: () => void }) {
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

  // Per-row markup drafts (the input commits on blur; the draft clears when the rows reload).
  const [markupDraft, setMarkupDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    setMarkupDraft({});
  }, [rows]);

  // Credentials (write-only) — captured in a drawer.
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
  }, [propertyId, nonce, refreshKey]);

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
  }, [propertyId, filterChannel, filterStatus, filterFrom, filterTo, deliveriesNonce, refreshKey]);

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
      "Canal creado. Carga las credenciales y relaciona los productos antes de publicar."
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

  function commitMarkup(row: ChannelAdminRow) {
    const draft = markupDraft[row.id];
    if (draft === undefined) return;
    if (draft !== String(row.markupPercent ?? 0)) void handleMarkupChange(row, draft);
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
      showToast(`${row.name} archivado (se conservan ${number(res.keptDeliveries)} entregas en el historial). Volver a dar de alta ${row.providerCode} lo revive.`, { variant: "success" });
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
      showToast(`Drenaje ejecutado: ${number(res.processed)} de ${number(res.candidates)} entregas procesadas${res.errors.length > 0 ? ` · ${plural(res.errors.length, "error", "errores")}` : ""}.`, { variant: res.errors.length > 0 ? "info" : "success" });
      setDeliveriesNonce((n) => n + 1);
      refresh();
    });
  }

  async function handleRetry(delivery: ChannelDeliveryRow) {
    await run(
      `retry:${delivery.id}`,
      async () => {
        await retryDelivery(delivery.id);
        setDeliveriesNonce((n) => n + 1);
      },
      "Entrega reencolada."
    );
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
  const catalog = CHANNEL_PROVIDER_CATALOG.find((c) => c.code === providerCode);
  const credRow = credChannelId ? (rows.find((r) => r.id === credChannelId) ?? null) : null;
  const credentialsReady = Object.values(credValues).some((v) => v.trim() !== "");

  function closeCredentials() {
    setCredChannelId(null);
    setCredValues({});
  }

  const channelColumns: CocoaTableColumn<ChannelAdminRow>[] = [
    {
      key: "name",
      label: "Canal",
      minWidth: 220,
      render: (row) => (
        <div className="cocoa-stack" data-gap="1">
          <strong>{row.name}</strong>
          <span className="cocoa-cluster">
            <Note title={row.providerCode}>{providerLabel(row.providerCode)}</Note>
            <StatusBadge status={row.status} />
            {row.readyToPush ? (
              <CocoaBadge tone="success">listo</CocoaBadge>
            ) : (
              <CocoaBadge tone="warning" uppercase={false} title={row.readinessSummary ?? undefined}>
                {row.readinessSummary ?? "incompleto"}
              </CocoaBadge>
            )}
          </span>
          {testResult[row.id] ? <Note>Prueba: {testResult[row.id]}</Note> : null}
        </div>
      )
    },
    {
      key: "mode",
      label: "Modo",
      render: (row) => (
        <div className="cocoa-stack" data-gap="1">
          {/* The select edits the REQUESTED mode; the instance cap (CHANNEL_MAX_MODE) decides the effective one. */}
          <CocoaSelect
            size="small"
            value={row.requestedMode ?? row.mode}
            options={MODE_OPTIONS}
            disabled={busy !== null}
            aria-label={`Modo de ${row.name}`}
            onChange={(value) => void handleModeChange(row, value as ChannelMode)}
            style={modeSelectStyle}
          />
          {row.requestedMode && row.requestedMode !== row.mode ? (
            <Note title={`Solicitado: ${channelModeLabel(row.requestedMode)} · tope de la instancia (CHANNEL_MAX_MODE): ${channelModeLabel(row.maxMode)}`}>
              <ExclamationCircleIcon size={12} aria-hidden="true" /> Efectivo: <strong>{channelModeLabel(row.mode)}</strong> (solicitado {channelModeLabel(row.requestedMode)}; la instancia lo limita a{" "}
              {channelModeLabel(row.maxMode ?? row.mode)})
            </Note>
          ) : null}
        </div>
      )
    },
    {
      key: "markupPercent",
      label: "Recargo",
      align: "right",
      fit: true,
      render: (row) => (
        <span className="cocoa-row" data-gap="1" data-wrap="nowrap">
          <CocoaInput
            size="small"
            inputMode="decimal"
            value={markupDraft[row.id] ?? String(row.markupPercent ?? 0)}
            onChange={(value) => setMarkupDraft((prev) => ({ ...prev, [row.id]: value }))}
            onBlur={() => commitMarkup(row)}
            disabled={busy !== null}
            aria-label={`Recargo de ${row.name} en porcentaje`}
            style={markupInputStyle}
          />
          <span aria-hidden="true">%</span>
        </span>
      )
    },
    {
      key: "credentials",
      label: "Credenciales",
      fit: true,
      render: (row) => (
        <div className="cocoa-stack" data-gap="1">
          <span className="cocoa-row" data-gap="1" data-wrap="nowrap">
            {row.credentialsUndecryptable ? (
              <CocoaBadge tone="danger" uppercase={false} title="Hay credenciales guardadas pero la clave de cifrado actual no puede abrirlas (clave rotada sin backfill): vuelve a guardarlas.">
                ilegibles (clave rotada)
              </CocoaBadge>
            ) : row.hasCredentials ? (
              <CocoaBadge tone="success">cargadas</CocoaBadge>
            ) : (
              <CocoaBadge tone="warning">sin credenciales</CocoaBadge>
            )}
            <CocoaButton
              variant="plain"
              tone="accent"
              size="small"
              onClick={() => {
                setCredChannelId(row.id);
                setCredValues({});
              }}
            >
              {row.hasCredentials ? "Sustituir" : "Cargar"}
            </CocoaButton>
          </span>
          {row.credentialsUndecryptable ? <Note>Vuelve a guardarlas para que el canal pueda usarlas.</Note> : null}
        </div>
      )
    },
    { key: "mappedProducts", label: "Productos", align: "right", fit: true, showFrom: "laptop", render: (row) => number(row.mappedProducts) }
  ];

  const deliveryColumns: CocoaTableColumn<ChannelDeliveryRow>[] = [
    { key: "when", label: "Cuándo", fit: true, render: (d) => fmtTime(d.updatedAt ?? d.createdAt) },
    { key: "channel", label: "Canal", fit: true, render: (d) => channelName(d.channelId) },
    { key: "kind", label: "Tipo", fit: true, render: (d) => DELIVERY_KIND_LABELS[d.kind] ?? d.kind },
    {
      key: "product",
      label: "Producto",
      minWidth: 180,
      render: (d) => <Note title={`${d.roomTypeId} · ${d.ratePlanId}`}>{productLabel(d.roomTypeId, d.ratePlanId)}</Note>
    },
    { key: "date", label: "Fecha", fit: true, hideOnNarrow: true, render: (d) => fmtDate(d.date) },
    {
      key: "status",
      label: "Estado",
      fit: true,
      render: (d) => (
        <CocoaBadge tone={deliveryTone(d.status)} title={d.status}>
          {deliveryStatusLabel(d.status)}
        </CocoaBadge>
      )
    },
    { key: "attempts", label: "Intentos", align: "right", fit: true, showFrom: "laptop", render: (d) => number(d.attempts) },
    { key: "lastError", label: "Error", minWidth: 160, showFrom: "desktop", render: (d) => <Note>{d.lastError ?? "—"}</Note> }
  ];

  const channelsReady = !loading && rows.length > 0;
  const deliveriesReady = !deliveriesError && deliveries.length > 0;

  return (
    <>
      <CocoaSection title="Dar de alta un canal" meta="Editor de tarifas">
        <div className="cocoa-stack" data-gap="3">
          <Note>
            Los cambios publicados desde el editor se encolan como entregas por canal (tarifas / disponibilidad / restricciones) y un proceso las envía con reintentos. Modo{" "}
            <strong>simulado</strong> = sin red; <strong>modo de pruebas</strong> = entorno de pruebas del proveedor; <strong>real</strong> solo con credenciales cargadas. Nada sale a
            Internet sin modo real.
          </Note>
          {error ? (
            <CocoaCallout tone="danger" role="alert">
              {error}
            </CocoaCallout>
          ) : null}
          <CocoaFormRow columns={4} min={160}>
            <CocoaField label="Proveedor">
              <CocoaSelect value={providerCode} onChange={setProviderCode} options={PROVIDER_OPTIONS} />
            </CocoaField>
            <CocoaField label="Nombre" required>
              <CocoaInput value={name} onChange={setName} placeholder={`Booking.com · ${getActivePropertyName() || "mi hotel"}`} />
            </CocoaField>
            <CocoaField label="Modo">
              <CocoaSelect value={mode} onChange={(value) => setMode(value as ChannelMode)} options={MODE_OPTIONS} />
            </CocoaField>
            <CocoaField label="Recargo (%)">
              <CocoaInput value={markup} onChange={setMarkup} inputMode="decimal" />
            </CocoaField>
          </CocoaFormRow>
          <div className="cocoa-row" data-justify="between" data-gap="2">
            {catalog ? <Note>{catalog.note}</Note> : <span />}
            <CocoaButton variant="filled" tone="accent" loading={busy === "create"} disabled={busy !== null || !name.trim()} onClick={() => void handleCreate()}>
              Dar de alta
            </CocoaButton>
          </div>
        </div>
      </CocoaSection>

      <CocoaSection
        title="Canales conectados al editor de tarifas"
        meta={plural(rows.length, "canal", "canales")}
        padding={channelsReady ? "none" : "md"}
        style={clipStyle}
        action={
          <CocoaButton variant="plain" tone="accent" size="small" loading={busy === "drain"} disabled={busy !== null} onClick={() => void handleDrain()}>
            Drenar ahora
          </CocoaButton>
        }
      >
        {loading ? (
          <CocoaState kind="loading" inline />
        ) : rows.length === 0 && !error ? (
          <CocoaState kind="empty" inline title="Sin canales todavía." message="Da de alta el primero arriba (empieza en modo simulado o de pruebas)." />
        ) : rows.length === 0 ? (
          <CocoaState kind="error" inline title="No se pudieron cargar los canales" message={error ?? undefined} onRetry={refresh} />
        ) : (
          <CocoaTable
            columns={channelColumns}
            rows={rows}
            rowKey="id"
            caption="Canales conectados al editor de tarifas"
            rowActions={(row) => (
              <>
                <CocoaButton variant="bordered" tone="neutral" size="small" loading={busy === `test:${row.id}`} disabled={busy !== null} onClick={() => void handleTest(row)}>
                  Probar conexión
                </CocoaButton>
                <CocoaButton variant="plain" tone="accent" size="small" onClick={() => navigateTo("ChannelMappings", `channel=${encodeURIComponent(row.id)}`)}>
                  Correspondencias
                </CocoaButton>
                <CocoaButton
                  variant="plain"
                  tone="neutral"
                  size="small"
                  loading={busy === `status:${row.id}`}
                  disabled={busy !== null}
                  title={row.status === "active" ? "El canal deja de ofrecerse en el editor y no se le encola nada; conserva credenciales y correspondencias" : "Vuelve a ofrecer el canal en el editor"}
                  onClick={() => void handleToggleStatus(row)}
                >
                  {row.status === "active" ? ACTIONS.deactivate : ACTIONS.activate}
                </CocoaButton>
                <CocoaButton
                  variant="plain"
                  tone="destructive"
                  size="small"
                  loading={busy === `archive:${row.id}`}
                  disabled={busy !== null}
                  title="Archivado lógico: el canal desaparece del editor y del hub; el historial de entregas se conserva y una nueva alta del mismo proveedor lo revive"
                  onClick={() => setArchiveTarget(row)}
                >
                  {ACTIONS.archive}
                </CocoaButton>
              </>
            )}
          />
        )}
      </CocoaSection>

      <CocoaDialog
        open={archiveTarget !== null}
        onClose={() => setArchiveTarget(null)}
        title={archiveTarget ? `Archivar ${archiveTarget.name}` : "Archivar canal"}
        description="El canal desaparece del editor de tarifas y de este hub; sus entregas y correspondencias se conservan en el historial. No se archiva si tiene entregas pendientes de envío (en cola o en vuelo): drena primero. Dar de alta de nuevo el mismo proveedor lo revive."
        tone="destructive"
        confirmLabel={ACTIONS.archive}
        cancelLabel={ACTIONS.cancel}
        onConfirm={() => {
          if (archiveTarget) void handleArchive(archiveTarget);
        }}
      />

      <CocoaDrawer
        open={credRow !== null}
        onClose={closeCredentials}
        title={credRow ? `Credenciales de ${credRow.name}` : "Credenciales"}
        subtitle="Solo escritura: se cifran en el servidor y no se vuelven a mostrar."
        side="right"
        size="sm"
        dismissible={busy === null}
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={closeCredentials} disabled={busy !== null}>
              {ACTIONS.cancel}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" loading={credRow !== null && busy === `cred:${credRow.id}`} disabled={busy !== null || !credentialsReady} onClick={() => credRow && void handleSaveCredentials(credRow)}>
              {ACTIONS.save}
            </CocoaButton>
          </>
        }
      >
        {credRow ? (
          <div className="cocoa-stack" data-gap="3">
            {(CREDENTIAL_FIELDS[credRow.providerCode] ?? ["apiKey"]).map((field) => (
              <CocoaField key={field} label={CREDENTIAL_FIELD_LABELS[field] ?? field}>
                <CocoaInput
                  type={/password|secret/i.test(field) ? "password" : "text"}
                  value={credValues[field] ?? ""}
                  onChange={(value) => setCredValues((prev) => ({ ...prev, [field]: value }))}
                  autoComplete="off"
                  placeholder={field}
                />
              </CocoaField>
            ))}
          </div>
        ) : null}
      </CocoaDrawer>

      <CocoaSection
        title="Log de entregas"
        meta={deliveriesReady ? plural(deliveries.length, "entrega", "entregas") : "Cola de envíos"}
        padding={deliveriesReady ? "none" : "md"}
        style={clipStyle}
        footer={
          deliveriesReady && deliveriesCursor ? (
            <CocoaButton variant="plain" tone="accent" size="small" loading={busy === "more"} disabled={busy !== null} onClick={() => void handleLoadMoreDeliveries()}>
              Cargar más
            </CocoaButton>
          ) : undefined
        }
      >
        <div className="cocoa-stack" data-gap="3">
          <CocoaToolbar
            variant="content"
            aria-label="Filtros del log de entregas"
            leftSlot={
              <>
                <CocoaSelect size="small" value={filterChannel} onChange={setFilterChannel} aria-label="Canal" options={[{ value: "", label: "Todos los canales" }, ...rows.map((r) => ({ value: r.id, label: r.name }))]} />
                <CocoaSelect size="small" value={filterStatus} onChange={setFilterStatus} aria-label="Estado" options={DELIVERY_STATUS_OPTIONS} />
                <CocoaDatePicker size="small" value={filterFrom} onChange={setFilterFrom} aria-label="Desde" />
                <CocoaDatePicker size="small" value={filterTo} onChange={setFilterTo} aria-label="Hasta" />
              </>
            }
            rightSlot={
              <CocoaButton variant="bordered" tone="neutral" size="small" aria-label="Actualizar el log de entregas" onClick={() => setDeliveriesNonce((n) => n + 1)}>
                {ACTIONS.refresh}
              </CocoaButton>
            }
          />
          {deliveriesError ? (
            <CocoaState kind="error" inline title="No se pudo cargar el log de entregas" message={deliveriesError} onRetry={() => setDeliveriesNonce((n) => n + 1)} />
          ) : deliveries.length === 0 ? (
            <CocoaState kind="empty" inline title="Sin entregas con estos filtros." />
          ) : (
            <CocoaTable
              columns={deliveryColumns}
              rows={deliveries}
              rowKey="id"
              density="compact"
              caption="Log de entregas"
              rowActions={(d) => {
                const retryable = d.status === "rejected" || d.status === "timeout";
                return (
                  <CocoaButton
                    variant="plain"
                    tone="accent"
                    size="small"
                    loading={busy === `retry:${d.id}`}
                    disabled={busy !== null || !retryable}
                    title={retryable ? "Vuelve a encolar la entrega" : `Solo se reintentan entregas rechazadas o sin respuesta (estado: ${deliveryStatusLabel(d.status)})`}
                    onClick={() => void handleRetry(d)}
                  >
                    {ACTIONS.retry}
                  </CocoaButton>
                );
              }}
            />
          )}
        </div>
      </CocoaSection>
    </>
  );
}

// ---------------------------------------------------------------------------
// Aggregator layer (legacy routes): channel cards, unified push, sync jobs,
// parity alerts.
// ---------------------------------------------------------------------------

type PushResultRow = PushResult["results"][number] & { channelName: string };

const PUSH_RESULT_COLUMNS: CocoaTableColumn<PushResultRow>[] = [
  { key: "channelName", label: "Canal" },
  { key: "providerCode", label: "Proveedor", fit: true, hideOnNarrow: true, render: (r) => providerLabel(r.providerCode) },
  { key: "ok", label: "Estado", fit: true, render: (r) => <StatusBadge status={r.ok ? "success" : "failed"} /> },
  { key: "pushed", label: "Enviados", align: "right", fit: true, render: (r) => number(r.pushed ?? 0) },
  { key: "latencyMs", label: "Latencia", align: "right", fit: true, showFrom: "tablet", render: (r) => (r.latencyMs ? `${number(r.latencyMs)} ms` : "—") },
  {
    key: "errors",
    label: "Errores",
    minWidth: 200,
    render: (r) => {
      const errText = r.errors?.join("; ") ?? "";
      if (!errText) return "—";
      const mappingMissing = MAPPING_MISSING.test(errText);
      return <span style={mappingMissing ? dangerTextStyle : undefined}>{mappingMissing ? `${errText} — abre «Correspondencias» en la tarjeta del canal para corregirlo.` : errText}</span>;
    }
  }
];

type SyncJobView = SyncJobRow & { channelName: string; latency: string };

const SYNC_JOB_COLUMNS: CocoaTableColumn<SyncJobView>[] = [
  { key: "createdAt", label: "Cuándo", fit: true, render: (j) => fmtTime(j.createdAt) },
  { key: "channelName", label: "Canal" },
  { key: "syncType", label: "Tarea", render: (j) => <span title={j.syncType}>{SYNC_TYPE_LABELS[j.syncType] ?? j.syncType}</span> },
  { key: "status", label: "Estado", fit: true, render: (j) => <StatusBadge status={j.status} /> },
  { key: "latency", label: "Latencia", align: "right", fit: true, showFrom: "tablet" },
  { key: "errorMessage", label: "Error", minWidth: 160, hideOnNarrow: true, render: (j) => <Note>{j.errorMessage ?? "—"}</Note> }
];

const PARITY_COLUMNS: CocoaTableColumn<ParityAlertRow>[] = [
  { key: "stayDate", label: "Noche", fit: true, render: (a) => fmtDate(a.stayDate) },
  { key: "sourceChannel", label: "Canal", fit: true, render: (a) => a.sourceChannel ?? "—" },
  { key: "severity", label: "Gravedad", fit: true, render: (a) => <SeverityBadge severity={a.severity} /> },
  { key: "directRate", label: "Nuestro precio", align: "right", fit: true, render: (a) => money(a.directRate, a.currency ?? undefined) },
  { key: "channelRate", label: "Precio en el canal", align: "right", fit: true, render: (a) => money(a.channelRate, a.currency ?? undefined) },
  { key: "message", label: "Mensaje", minWidth: 200, hideOnNarrow: true, render: (a) => <Note>{a.message}</Note> }
];

function HubSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={4} />
      <CocoaSkeleton variant="card" height={220} />
      <CocoaSkeleton variant="card" height={240} />
    </div>
  );
}

function ChannelCard({
  channel,
  readinessNonce,
  testing,
  syncing,
  expanded,
  onTest,
  onSync,
  onToggleMappings,
  onMappingsChanged
}: {
  channel: ChannelRow;
  readinessNonce: number;
  testing: boolean;
  syncing: boolean;
  expanded: boolean;
  onTest: () => void;
  onSync: () => void;
  onToggleMappings: () => void;
  onMappingsChanged: () => void;
}) {
  const errorMessage = channel.latestSync?.errorMessage ?? null;
  return (
    <CocoaSection title={channel.name} meta={<StatusBadge status={channel.status} />}>
      <div className="cocoa-stack" data-gap="3">
        {/* Labelled and never uppercase: «AIRBNB · VACATION_RENTAL» read as a raw enum (browser-ux-final#12). */}
        <Note title={`${channel.providerCode} · ${channel.channelType}`}>
          {providerLabel(channel.providerCode)} · {channelTypeLabel(channel.channelType)}
        </Note>
        <ul className="c22-section__list" aria-label={`Resumen de ${channel.name}`}>
          <li>
            <span>Última sincronización</span>
            <strong>{fmtTime(channel.latestSync?.finishedAt ?? channel.latestSync?.createdAt ?? channel.lastSyncAt)}</strong>
          </li>
          <li>
            <span>Correspondencias</span>
            <strong>
              {plural(channel.roomMappingsCount, "habitación", "habitaciones")} · {plural(channel.rateMappingsCount, "tarifa", "tarifas")}
            </strong>
          </li>
        </ul>
        {errorMessage ? (
          <CocoaCallout tone="danger" icon={<ExclamationCircleIcon size={16} />}>
            {MAPPING_MISSING.test(errorMessage) ? `${errorMessage}. Configura las correspondencias más abajo.` : errorMessage}
          </CocoaCallout>
        ) : null}
        <div className="cocoa-row" data-gap="2">
          <CocoaButton variant="bordered" tone="neutral" size="small" loading={testing} disabled={testing} onClick={onTest}>
            Probar
          </CocoaButton>
          <CocoaButton variant="bordered" tone="neutral" size="small" loading={syncing} disabled={syncing} onClick={onSync}>
            Sincronizar ahora
          </CocoaButton>
          <CocoaButton variant="plain" tone="accent" size="small" aria-expanded={expanded} onClick={onToggleMappings}>
            {expanded ? "Ocultar correspondencias" : "Correspondencias"}
          </CocoaButton>
        </div>
        <ChannelReadinessPanel channelId={channel.id} refreshKey={readinessNonce} />
        {expanded ? <ChannelMappingsPanel channelId={channel.id} onChanged={onMappingsChanged} /> : null}
      </div>
    </CocoaSection>
  );
}

const SUBTITLE =
  "Un único punto para tarifas, disponibilidad y restricciones: cada publicación del editor de tarifas llega a Booking, Expedia, Airbnb, Hotelbeds y Vrbo. Las reservas de los canales entran como reservas externas y la paridad de precios se vigila de forma continua.";

export function ChannelAggregatorHub() {
  // Hosted inside a routed tab container (Tanda 5): the container paints the page header.
  const hosted = useTabHost() !== null;
  const { showToast } = useToast();
  const channelsState = useApiData<{ channels: ChannelRow[] }>(`/channel-manager/channels?propertyId=${PROPERTY_ID}`, { pollIntervalMs: 30000 });
  const jobsState = useApiData<{ jobs: SyncJobRow[] }>(`/channel-manager/sync-jobs?propertyId=${PROPERTY_ID}`, { pollIntervalMs: 30000 });
  const alertsState = useApiData<{ alerts: ParityAlertRow[] }>(`/channel-manager/parity/alerts?propertyId=${PROPERTY_ID}&status=open`, { pollIntervalMs: 30000 });

  // The legacy list route returns every row of the property, archived ones
  // included (aggregator.service.listChannels filters by `active` only): hide
  // them here, as the v2 panel and the editor do.
  const channels = useMemo(() => (channelsState.data?.channels ?? []).filter((c) => c.status?.toLowerCase() !== "archived"), [channelsState.data]);
  const jobs = useMemo(() => jobsState.data?.jobs ?? [], [jobsState.data]);
  const openAlerts = useMemo(() => alertsState.data?.alerts ?? [], [alertsState.data]);

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
  // «Actualizar» of the page also reloads the v2 layer.
  const [refreshNonce, setRefreshNonce] = useState(0);

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
    const reservations24h = jobs
      .filter((j) => j.syncType === "ingest_reservations" && new Date(j.createdAt).getTime() >= dayAgo)
      .reduce((sum, j) => {
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
      const path = kind === "rates" ? "/channel-manager/push-rates" : kind === "availability" ? "/channel-manager/push-availability" : "/channel-manager/push-restrictions";
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

  const pushRows = useMemo<PushResultRow[]>(
    () => (pushResult ? pushResult.payload.results.map((row) => ({ ...row, channelName: channelById.get(row.channelId)?.name ?? row.channelId })) : []),
    [pushResult, channelById]
  );

  const jobRows = useMemo<SyncJobView[]>(
    () =>
      jobs.slice(0, 50).map((j) => {
        const start = j.startedAt ? new Date(j.startedAt).getTime() : null;
        const end = j.finishedAt ? new Date(j.finishedAt).getTime() : null;
        return {
          ...j,
          channelName: (j.channelId ? channelById.get(j.channelId)?.name : null) ?? j.channelId ?? "—",
          latency: start !== null && end !== null ? `${number(Math.max(0, end - start))} ms` : "—"
        };
      }),
    [jobs, channelById]
  );

  function refreshAll() {
    channelsState.refresh();
    jobsState.refresh();
    alertsState.refresh();
    setRefreshNonce((n) => n + 1);
    setReadinessNonce((n) => n + 1);
  }

  function openEditor() {
    navigateTo("RateGridEditorScreen");
  }

  const header = treeHeaderFor("ChannelAggregatorHub", { eyebrow: "Comercial", title: "Canales de venta" });
  const initialLoading = channelsState.loading && !channelsState.data;
  const channelsError = channelsState.error && !channelsState.data ? channelsState.error : null;
  const jobsReady = jobRows.length > 0;
  const alertsReady = openAlerts.length > 0;

  return (
    <CocoaPage
      eyebrow={`${header.eyebrow} · ${getActivePropertyName()}`}
      title={header.title}
      subtitle={hosted ? undefined : SUBTITLE}
      actions={
        <>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refreshAll}>
            {ACTIONS.refresh}
          </CocoaButton>
          <CocoaButton variant="filled" tone="accent" onClick={openEditor}>
            Editar tarifas en grid
          </CocoaButton>
        </>
      }
      state={initialLoading ? "loading" : "ready"}
      skeleton={<HubSkeleton />}
      commands={[
        { id: "canales-refresh", label: "Actualizar canales de venta", run: refreshAll },
        { id: "canales-editar-tarifas", label: "Editar tarifas en grid", run: openEditor }
      ]}
    >
      <CocoaScreenInstructionsCard
        title={CHANNELS_INSTRUCTIONS.whatIsThis}
        description="Conecta y monitoriza tus canales OTA desde un único punto."
        steps={[...CHANNELS_INSTRUCTIONS.howToUse]}
        tip={CHANNELS_INSTRUCTIONS.tips.join(" · ")}
        dismissible
        persistKey="channels"
      />

      {pushError ? (
        <CocoaCallout tone="danger" role="alert" icon={<ExclamationCircleIcon size={16} />}>
          {pushError}
        </CocoaCallout>
      ) : null}

      <CocoaKpiStrip stagger aria-label="Indicadores de los canales">
        <CocoaKpi label="Canales activos" value={number(kpis.activeChannels)} caption="con estado «activo»" polarity="neutral" status={kpis.activeChannels > 0 ? "ok" : "warning"} />
        <CocoaKpi
          label="Última sincronización correcta"
          value={kpis.lastSync ? date(kpis.lastSync, "dayMonth") : "—"}
          caption={kpis.lastSync ? `a las ${time(kpis.lastSync)} · la más reciente entre todos los canales` : "Ninguna registrada todavía"}
          polarity="neutral"
          status={kpis.lastSync ? "ok" : undefined}
        />
        <CocoaKpi
          label="Alertas de paridad abiertas"
          value={alertsState.loading && !alertsState.data ? "…" : number(kpis.pendingAlerts)}
          caption="diferencias de precio sin resolver"
          polarity="neutral"
          status={kpis.pendingAlerts === 0 ? "ok" : kpis.pendingAlerts <= 2 ? "warning" : "critical"}
        />
        <CocoaKpi
          label="Reservas importadas (24 h)"
          value={jobsState.loading && !jobsState.data ? "…" : number(kpis.reservations24h)}
          caption="recibidas de los canales en las últimas 24 horas"
          polarity="neutral"
          status="ok"
        />
      </CocoaKpiStrip>

      <ChannelV2Panel
        propertyId={PROPERTY_ID}
        refreshKey={refreshNonce}
        onChanged={() => {
          channelsState.refresh();
          setReadinessNonce((n) => n + 1);
        }}
      />

      <CocoaSection variant="plain" padding="none" title="Canales conectados (agregador)" meta={plural(channels.length, "canal", "canales")}>
        {channelsError ? (
          <CocoaState kind="error" title="No se pudieron cargar los canales" message={channelsError} onRetry={channelsState.refresh} />
        ) : channels.length === 0 ? (
          <CocoaState kind="empty" illustration="connection" title="No hay canales conectados todavía." message="Da de alta un canal en el editor de tarifas para verlo aquí." />
        ) : (
          <CocoaGrid align="start" stagger aria-label="Canales conectados">
            {channels.map((c) => (
              <CocoaSpan key={c.id} cols={4} min={320}>
                <ChannelCard
                  channel={c}
                  readinessNonce={readinessNonce}
                  testing={testingChannel === c.id}
                  syncing={syncingChannel === c.id}
                  expanded={Boolean(expandedMappings[c.id])}
                  onTest={() => void handleTestChannel(c.id)}
                  onSync={() => void handleSyncChannel(c.id)}
                  onToggleMappings={() => setExpandedMappings((prev) => ({ ...prev, [c.id]: !prev[c.id] }))}
                  onMappingsChanged={() => {
                    setReadinessNonce((n) => n + 1);
                    channelsState.refresh();
                  }}
                />
              </CocoaSpan>
            ))}
          </CocoaGrid>
        )}
      </CocoaSection>

      <CocoaSection title="Enviar a todos los canales" meta="Envío unificado (agregador)">
        <div className="cocoa-stack" data-gap="3">
          <Note>Para cambiar tarifas o restricciones antes de enviarlas, usa el editor de tarifas.</Note>
          <CocoaFormRow columns={2} min={160}>
            <CocoaField label="Desde">
              <CocoaDatePicker value={fromDate} onChange={setFromDate} />
            </CocoaField>
            <CocoaField label="Hasta">
              <CocoaDatePicker value={toDate} onChange={setToDate} />
            </CocoaField>
          </CocoaFormRow>
          <div className="cocoa-row" data-gap="2">
            <CocoaButton variant="filled" tone="accent" size="small" loading={pushBusy === "rates"} disabled={pushBusy !== null} onClick={() => void pushAction("rates")}>
              Enviar tarifas
            </CocoaButton>
            <CocoaButton variant="tinted" tone="accent" size="small" loading={pushBusy === "availability"} disabled={pushBusy !== null} onClick={() => void pushAction("availability")}>
              Enviar disponibilidad
            </CocoaButton>
            <CocoaButton variant="tinted" tone="accent" size="small" loading={pushBusy === "restrictions"} disabled={pushBusy !== null} onClick={() => void pushAction("restrictions")}>
              Enviar restricciones
            </CocoaButton>
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void handleParityCheck()}>
              Comprobar paridad
            </CocoaButton>
          </div>
          {pushResult ? (
            <>
              <Note>
                Último envío: <strong>{DELIVERY_KIND_LABELS[pushResult.label] ?? pushResult.label}</strong> · {dateRange(pushResult.payload.dateRange.from, pushResult.payload.dateRange.to)}
              </Note>
              <CocoaTable columns={PUSH_RESULT_COLUMNS} rows={pushRows} rowKey="channelId" density="compact" caption="Resultado del último envío" />
            </>
          ) : null}
        </div>
      </CocoaSection>

      <CocoaSection title="Sincronizaciones recientes" meta={plural(jobs.length, "tarea", "tareas")} padding={jobsReady ? "none" : "md"} style={clipStyle}>
        {jobsState.error && !jobsState.data ? (
          <CocoaState kind="error" inline title="No se pudieron cargar las sincronizaciones" message={jobsState.error} onRetry={jobsState.refresh} />
        ) : !jobsReady ? (
          <CocoaState kind="empty" inline title="Todavía no hay sincronizaciones registradas." />
        ) : (
          <CocoaTable columns={SYNC_JOB_COLUMNS} rows={jobRows} rowKey="id" density="compact" caption="Sincronizaciones recientes" />
        )}
      </CocoaSection>

      <CocoaSection title="Alertas de paridad abiertas" meta={plural(openAlerts.length, "alerta", "alertas")} padding={alertsReady ? "none" : "md"} style={clipStyle}>
        {alertsState.error && !alertsState.data ? (
          <CocoaState kind="error" inline title="No se pudieron cargar las alertas de paridad" message={alertsState.error} onRetry={alertsState.refresh} />
        ) : !alertsReady ? (
          <CocoaState kind="empty" inline title="No hay alertas de paridad abiertas." />
        ) : (
          <CocoaTable
            columns={PARITY_COLUMNS}
            rows={openAlerts}
            rowKey="id"
            caption="Alertas de paridad abiertas"
            rowActions={(a) => (
              <CocoaButton variant="plain" tone="accent" size="small" loading={resolvingAlert === a.id} disabled={resolvingAlert === a.id} onClick={() => void handleResolveAlert(a.id)}>
                Resolver
              </CocoaButton>
            )}
          />
        )}
      </CocoaSection>
    </CocoaPage>
  );
}
