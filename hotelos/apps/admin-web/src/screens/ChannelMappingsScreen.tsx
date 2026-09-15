import { useTabHost } from "./tabs/TabHost";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useApiData } from "../hooks/useApiData";
import { apiRequest } from "../services/api-client";
import { getActivePropertyId } from "../services/activeProperty";
import { EmptyState, ErrorState, LoadingBlock } from "../components/States";
import { toArray } from "../utils/toArray";
import { navigateTo } from "../lib/navigate";
import {
  fetchMappingCoverage,
  listChannels,
  listProductMappings,
  migrateLegacyMappings,
  upsertProductMappings,
  type ChannelAdminRow,
  type ChannelMappingCoverage,
  type ChannelProductMappingInput,
  type ChannelProductMappingRow
} from "../services/channelsApi";
import { classifyRateGridError, fetchRatePlans } from "../services/rateGridApi";
import { channelModeLabel, providerLabel } from "../components/cocoa-rate-grid/helpers";
import { channelIdFromHash, withChannelHash } from "../lib/channel-hash";
import { fetchRoomTypes, type AdminRoomType } from "../services/pmsCommerceApi";
import type { RateGridRatePlan } from "@hotelos/shared";
import { useToast } from "../components/Toast";
import { dateTime } from "../lib/format";

// =====================================================================================
// Channel Manager · Mapeos de canales — read view over the Prisma-backed mapping
// endpoints the aggregator pushes with:
//   GET /channel-manager/channels?propertyId=…                → { channels }
//   GET /channel-manager/channels/:channelId/room-mappings    → { mappings }
//   GET /channel-manager/channels/:channelId/rate-mappings    → { mappings }
//   GET /channel-manager/channels/:channelId/mapping-coverage → coverage
// Editing (add/remove) stays in ChannelAggregatorHub, next to connect/test/push,
// so there is a single write surface for the channel.
//
// Rate grid v2 (ProductMappingsPanel, top of the screen): mappings per PRODUCT
// (roomType × ratePlan → external room/rate codes) against the real routes
//   GET  /properties/:id/channels                                   (channel list)
//   GET  /channel-manager/channels/:channelId/product-mappings       → { mappings }
//   POST /channel-manager/channels/:channelId/product-mappings       one mapping (upsert)
//   POST /channel-manager/channels/:channelId/product-mappings/migrate-legacy
//   GET  /channel-manager/channels/:channelId/product-coverage
// The editor only publishes cells whose product is mapped on the channel.
//
// ONE selected channel for the whole screen: the v2 product panel and the
// legacy block below share `selectedId`, so «Mapeos» on a channel row of the
// hub (deep link `#channel=<id>`) lands on THAT channel in both places and an
// edit at the top never silently targets a different channel than the one
// highlighted at the bottom. The hash follows the selection too (lib/channel-hash).
// =====================================================================================

export { channelIdFromHash } from "../lib/channel-hash";

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
  return dateTime(value);
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

// «por estancia» (los) was retired (cierre 2026-09-15): the API answers 400
// «no está implementado todavía»; a legacy row still stored as "los" is shown
// as «por día» and only rewritten when the hotelier edits it.
type PricingModel = "per_day" | "obp";
type ProductDraft = Record<string, { externalRoomCode: string; externalRateCode: string; pricingModel: PricingModel; active: boolean }>;

function asPricingModel(value: string | null | undefined): PricingModel {
  return value === "obp" ? "obp" : "per_day";
}

function productKey(roomTypeId: string, ratePlanId: string): string {
  return `${roomTypeId}|${ratePlanId}`;
}

function describeV2Error(err: unknown): string {
  const info = classifyRateGridError(err);
  if (info.kind === "not_deployed") return "Este API no expone todavía las rutas v2 de mapeos por producto: hace falta reiniciar el API con el módulo cableado.";
  if (info.kind === "forbidden") return "Sin permiso (channel_manager.mappings.manage) para editar mapeos.";
  return info.message;
}

function ProductMappingsPanel({ propertyId, channelId, onChannelChange }: { propertyId: string; channelId: string; onChannelChange: (id: string) => void }) {
  const { showToast } = useToast();
  const [channels, setChannels] = useState<ChannelAdminRow[]>([]);
  const [channelsError, setChannelsError] = useState<string | null>(null);
  const [roomTypes, setRoomTypes] = useState<AdminRoomType[]>([]);
  const [ratePlans, setRatePlans] = useState<RateGridRatePlan[]>([]);
  const [rows, setRows] = useState<ChannelProductMappingRow[]>([]);
  const [coverage, setCoverage] = useState<ChannelMappingCoverage | null>(null);
  const [draft, setDraft] = useState<ProductDraft>({});
  const [error, setError] = useState<string | null>(null);
  // Non-blocking findings the upsert returns per saved mapping (e.g. a Channex
  // rate plan code shared by several room types): the rows ARE saved.
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    listChannels(propertyId)
      .then((list) => {
        if (cancelled) return;
        setChannels(list);
        setChannelsError(null);
        // Keep the shared selection when it exists on the v2 list; otherwise
        // (no selection yet, or a stale deep link) fall back to the first one.
        if (!(channelId && list.some((c) => c.id === channelId))) onChannelChange(list[0]?.id ?? "");
      })
      .catch((err: unknown) => {
        if (!cancelled) setChannelsError(describeV2Error(err));
      });
    fetchRoomTypes(propertyId).then((list) => { if (!cancelled) setRoomTypes(list); }).catch(() => { /* table shows ids */ });
    fetchRatePlans(propertyId).then((list) => { if (!cancelled) setRatePlans(list); }).catch(() => { /* table shows ids */ });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- channelId is validated against the list once it loads, not on every change
  }, [propertyId, nonce]);

  useEffect(() => {
    if (!channelId) {
      setRows([]);
      setCoverage(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([listProductMappings(channelId), fetchMappingCoverage(channelId).catch(() => null)])
      .then(([list, cov]) => {
        if (cancelled) return;
        setRows(list);
        setCoverage(cov);
        setDraft({});
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeV2Error(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [propertyId, channelId, nonce]);

  // The warnings belong to the channel they were saved on; the reload that
  // follows a save must NOT clear them (they are the reason the toast points
  // «arriba»), only a channel switch does.
  useEffect(() => {
    setWarnings([]);
  }, [channelId]);

  const existing = useMemo(() => {
    const m = new Map<string, ChannelProductMappingRow>();
    for (const r of rows) m.set(productKey(r.roomTypeId, r.ratePlanId), r);
    return m;
  }, [rows]);

  const plans = useMemo(() => ratePlans.filter((p) => p.active), [ratePlans]);
  const dirtyCount = Object.keys(draft).length;

  function cellValue(roomTypeId: string, ratePlanId: string) {
    const key = productKey(roomTypeId, ratePlanId);
    const d = draft[key];
    const e = existing.get(key);
    return {
      externalRoomCode: d?.externalRoomCode ?? e?.externalRoomCode ?? "",
      externalRateCode: d?.externalRateCode ?? e?.externalRateCode ?? "",
      pricingModel: d?.pricingModel ?? asPricingModel(e?.pricingModel),
      active: d?.active ?? (e ? e.status === "active" : false),
      mapped: Boolean(e)
    };
  }

  function edit(roomTypeId: string, ratePlanId: string, patch: Partial<ProductDraft[string]>) {
    const key = productKey(roomTypeId, ratePlanId);
    setDraft((prev) => {
      const current = prev[key] ?? { ...cellValue(roomTypeId, ratePlanId) };
      return { ...prev, [key]: { externalRoomCode: current.externalRoomCode, externalRateCode: current.externalRateCode, pricingModel: current.pricingModel, active: current.active, ...patch } };
    });
  }

  async function save() {
    if (!channelId || dirtyCount === 0) return;
    const mappings: ChannelProductMappingInput[] = [];
    for (const [key, value] of Object.entries(draft)) {
      const [roomTypeId, ratePlanId] = key.split("|");
      if (!value.externalRoomCode.trim() || !value.externalRateCode.trim()) continue;
      mappings.push({
        roomTypeId,
        ratePlanId,
        externalRoomCode: value.externalRoomCode.trim(),
        externalRateCode: value.externalRateCode.trim(),
        pricingModel: value.pricingModel,
        status: value.active ? "active" : "inactive"
      });
    }
    if (mappings.length === 0) {
      showToast("Rellena el código de habitación y el de tarifa antes de guardar.", { variant: "info" });
      return;
    }
    setBusy("save");
    try {
      const saved = await upsertProductMappings(channelId, mappings);
      const found = Array.from(new Set(saved.flatMap((row) => row.warnings ?? [])));
      setWarnings(found);
      const savedLabel = mappings.length === 1 ? "1 mapeo guardado" : `${mappings.length} mapeos guardados`;
      showToast(found.length ? `${savedLabel} con ${found.length === 1 ? "un aviso" : `${found.length} avisos`} (ver arriba).` : `${savedLabel}.`, { variant: found.length ? "info" : "success" });
      setNonce((n) => n + 1);
    } catch (err) {
      const message = describeV2Error(err);
      setError(message);
      showToast(message, { variant: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function migrate() {
    if (!channelId) return;
    setBusy("migrate");
    try {
      const res = await migrateLegacyMappings(channelId);
      showToast(`Derivados de los mapeos antiguos: ${res.created} nuevos, ${res.skippedExisting} ya existentes (${res.pairs} pares).`, { variant: "success" });
      setNonce((n) => n + 1);
    } catch (err) {
      const message = describeV2Error(err);
      setError(message);
      showToast(message, { variant: "error" });
    } finally {
      setBusy(null);
    }
  }

  const selected = channels.find((c) => c.id === channelId) ?? null;
  const inputStyle = { fontSize: 12, padding: "3px 6px", width: 110 } as const;

  return (
    <section className="bo-card" style={{ marginBottom: "var(--space-4)" }}>
      <div className="bo-card-head">
        <div>
          <p className="bo-muted">Rate grid v2</p>
          <h3>Mapeos por producto (tipo × plan)</h3>
        </div>
        <div className="bo-actions" style={{ margin: 0, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select value={channelId} onChange={(e) => onChannelChange(e.target.value)} aria-label="Canal" disabled={channels.length === 0}>
            {channels.length === 0 ? <option value="">Sin canales</option> : null}
            {channels.map((c) => (
              <option key={c.id} value={c.id}>{c.name} · {channelModeLabel(c.mode)}</option>
            ))}
          </select>
          {coverage ? (
            <span className={`bo-status ${coverage.complete ? "ok" : "warn"}`} title={`${coverage.roomTypesActive} tipos × ${coverage.ratePlansDistributable} planes distribuibles · ${coverage.coveragePct} %`}>
              {coverage.productsMapped}/{coverage.productsTotal} productos
            </span>
          ) : null}
          <button type="button" className="ghost" disabled={!channelId || busy !== null} onClick={() => void migrate()}>
            {busy === "migrate" ? "Derivando…" : "Derivar de los mapeos antiguos"}
          </button>
          <button type="button" className="primary" disabled={!channelId || dirtyCount === 0 || busy !== null} onClick={() => void save()}>
            {busy === "save" ? "Guardando…" : `Guardar mapeos${dirtyCount > 0 ? ` (${dirtyCount})` : ""}`}
          </button>
        </div>
      </div>
      <p className="bo-muted" style={{ marginTop: 0, textTransform: "none" }}>
        El editor de tarifas solo publica en un canal las celdas cuyo producto (tipo de habitación + plan) tiene mapeo activo aquí. Los códigos externos
        son los identificadores de habitación y tarifa en el extranet del canal (Booking: room id / rate id; Channex: room type / rate plan).
      </p>
      {channelsError ? <p className="bo-muted" style={{ fontSize: 12, color: "var(--danger-ink, #b3261e)", textTransform: "none" }} role="alert">{channelsError}</p> : null}
      {error ? <p className="bo-muted" style={{ fontSize: 12, color: "var(--danger-ink, #b3261e)", textTransform: "none" }} role="alert">{error}</p> : null}
      {warnings.length > 0 ? (
        <div role="status" style={{ fontSize: 12, textTransform: "none", padding: "8px 10px", marginBottom: 8, borderRadius: 8, border: "1px solid var(--warning, #b8860b)", background: "var(--surface-2, var(--surface-1))" }}>
          <strong>Mapeos guardados con {warnings.length === 1 ? "un aviso" : `${warnings.length} avisos`}</strong>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          <button type="button" className="bo-button-link" style={{ marginTop: 4 }} onClick={() => setWarnings([])}>Cerrar avisos</button>
        </div>
      ) : null}
      {!channelsError && channels.length === 0 ? (
        <p className="bo-muted">Da de alta un canal v2 en el Channel Manager para mapear productos.</p>
      ) : selected && (roomTypes.length === 0 || plans.length === 0) ? (
        <p className="bo-muted">Faltan tipos de habitación o planes activos en la propiedad.</p>
      ) : selected ? (
        <div className="bo-table-wrap">
          {loading ? <p className="bo-muted">Cargando mapeos…</p> : null}
          <table className="cm-table">
            <thead>
              <tr>
                <th>Tipo de habitación</th>
                <th>Plan</th>
                <th>Código hab. externo</th>
                <th>Código tarifa externo</th>
                <th>Modelo</th>
                <th>Activo</th>
              </tr>
            </thead>
            <tbody>
              {roomTypes.map((rt) =>
                plans.map((plan) => {
                  const v = cellValue(rt.id, plan.id);
                  const dirty = Boolean(draft[productKey(rt.id, plan.id)]);
                  return (
                    <tr key={productKey(rt.id, plan.id)} style={dirty ? { background: "var(--surface-2, var(--surface-1))" } : undefined}>
                      <td>{rt.code} · {rt.name}</td>
                      <td>{plan.code}{plan.derivation.mode !== "none" ? <span className="bo-muted" style={{ fontSize: 11 }}> (derivado)</span> : null}</td>
                      <td><input style={inputStyle} value={v.externalRoomCode} placeholder="p. ej. 123456" onChange={(e) => edit(rt.id, plan.id, { externalRoomCode: e.target.value })} /></td>
                      <td><input style={inputStyle} value={v.externalRateCode} placeholder="p. ej. 789" onChange={(e) => edit(rt.id, plan.id, { externalRateCode: e.target.value })} /></td>
                      <td>
                        <select value={v.pricingModel} onChange={(e) => edit(rt.id, plan.id, { pricingModel: asPricingModel(e.target.value) })} title="Por ocupación exige precios por ocupación en la celda; si faltan, la entrega no se encola y el guardado avisa">
                          <option value="per_day">por día</option>
                          <option value="obp">por ocupación</option>
                        </select>
                      </td>
                      <td>
                        <input type="checkbox" checked={v.active} onChange={(e) => edit(rt.id, plan.id, { active: e.target.checked })} aria-label="Mapeo activo" />
                        {v.mapped ? <span className="cm-pill cm-pill-ok" style={{ marginLeft: 6 }}>mapeado</span> : null}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

export function ChannelMappingsScreen() {
  // Hosted inside a routed tab container (Tanda 5): the container paints the page header.
  const embedded = useTabHost() !== null;
  const propertyId = useMemo(() => getActivePropertyId(), []);
  const channelsState = useApiData<{ channels: ChannelRow[] }>(`/channel-manager/channels?propertyId=${propertyId}`);
  const channels = useMemo(() => toArray<ChannelRow>(channelsState.data?.channels ?? channelsState.data), [channelsState.data]);

  // Shared selection (v2 panel + legacy block). Seeded from the `#channel=`
  // deep link the hub emits; a later hash change (another «Mapeos» click
  // while this screen is mounted) re-targets it.
  const [selectedId, setSelectedId] = useState<string>(() => (typeof window === "undefined" ? "" : channelIdFromHash(window.location.hash)));
  const onHashChange = useCallback(() => {
    const fromHash = channelIdFromHash(window.location.hash);
    if (fromHash) setSelectedId(fromHash);
  }, []);
  useEffect(() => {
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [onHashChange]);
  // Selection → hash (replaceState: no history entry, no hashchange event), so
  // F5 or a shared link reopen the channel the hotelier is looking at.
  useEffect(() => {
    if (!selectedId || typeof window === "undefined") return;
    const next = withChannelHash(window.location.hash, selectedId);
    if (next === window.location.hash) return;
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${next}`);
  }, [selectedId]);
  const [detail, setDetail] = useState<MappingDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailNonce, setDetailNonce] = useState(0);

  // Default to the first channel once the list is known (keeps a manual choice
  // and the deep link; the v2 panel validates the id against its own list).
  useEffect(() => {
    if (!selectedId && channels.length > 0) setSelectedId(channels[0].id);
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
          {embedded ? null : (
            <>
              <div className="bo-page-eyebrow">Comercial · Canales de venta</div>
              <h1 className="bo-page-title">Correspondencias</h1>
            </>
          )}
          <p className="bo-page-subtitle">
            Correspondencia entre tipos de habitación y planes tarifarios internos y los códigos de cada canal. Un mapeo incompleto bloquea el envío de ARI.
          </p>
        </div>
        <div className="bo-page-head-actions">
          <button type="button" className="primary" onClick={() => navigateTo("ChannelAggregatorHub")}>Gestionar en el Channel Manager</button>
        </div>
      </div>

      <ProductMappingsPanel propertyId={propertyId} channelId={selectedId} onChannelChange={setSelectedId} />

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
                      <td className="bo-muted" style={{ textTransform: "none" }} title={channel.providerCode}>{providerLabel(channel.providerCode)}</td>
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
