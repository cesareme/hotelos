// Channel Manager · Correspondencias (Comercial › Canales de venta › Correspondencias,
// /comercial/canales/correspondencias).
//
// Cocoa 22 · ola 7 · lote 7-A (lista · ListaTabla). CocoaPage (hosted inside
// CanalesTabs the container paints category, H1 and subtitle; standalone the
// page paints them) → product mappings panel (CocoaToolbar with the channel
// select, coverage badge and the two actions; CocoaTable of roomType × ratePlan
// with inline CocoaInput / CocoaSelect / CocoaSwitch, dirty rows washed in the
// accent tone) → legacy channels table (a row selects the channel) → the
// selected channel's room-type and rate-plan mappings in a 6/6 grid.
//
// Read view over the Prisma-backed mapping endpoints the aggregator pushes with:
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
// legacy block below share `selectedId`, so «Correspondencias» on a channel row of the
// hub (deep link `#channel=<id>`) lands on THAT channel in both places and an
// edit at the top never silently targets a different channel than the one
// highlighted at the bottom. The hash follows the selection too (lib/channel-hash).

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useTabHost } from "./tabs/TabHost";
import { treeHeaderFor } from "./tabs/tab-helpers";
import { useApiData } from "../hooks/useApiData";
import { apiRequest } from "../services/api-client";
import { getActivePropertyId } from "../services/activeProperty";
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
import { ACTIONS } from "../content/actions";
import { dateTime, number, percent, plural } from "../lib/format";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaGrid,
  CocoaInput,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  CocoaSwitch,
  CocoaTable,
  CocoaToolbar,
  type CocoaTableColumn,
  type CocoaTone
} from "../components/cocoa";

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

function channelStatusTone(status: string): CocoaTone {
  const s = status.toLowerCase();
  return s === "connected" || s === "active" ? "success" : s === "error" ? "danger" : "warning";
}

function channelStatusLabel(status: string): string {
  const s = status.toLowerCase();
  return s === "connected" || s === "active" ? "Conectado" : s === "error" ? "Error" : s === "disabled" ? "Desactivado" : status;
}

function MappingStatusBadge({ status }: { status: string }) {
  const s = status.toLowerCase();
  const tone: CocoaTone = s === "active" ? "success" : s === "error" ? "danger" : "warning";
  return <CocoaBadge tone={tone}>{s === "active" ? "Activo" : status}</CocoaBadge>;
}

function CoverageBadge({ mapped, total, noun }: { mapped: number; total: number; noun: string }) {
  const complete = total > 0 && mapped >= total;
  return (
    <CocoaBadge tone={complete ? "success" : total === 0 ? "neutral" : "warning"}>
      {number(mapped)}/{number(total)} {noun}
    </CocoaBadge>
  );
}

// Secondary paragraph inside a card (callout size, secondary ink).
const noteStyle: CSSProperties = { margin: 0, fontSize: "var(--cocoa-fs-callout)", lineHeight: "var(--cocoa-lh-callout)", color: "var(--cocoa-label-secondary)" };
// Tables inside a card: clip to the radius without creating a scroll container (§4.2 D26).
const clipStyle: CSSProperties = { overflow: "clip" };
const codeInputStyle: CSSProperties = { width: 128 };

function Note({ children }: { children: ReactNode }) {
  return <p style={noteStyle}>{children}</p>;
}

// «por estancia» (los) was retired (cierre 2026-09-15): the API answers 400
// «no está implementado todavía»; a legacy row still stored as "los" is shown
// as «por día» and only rewritten when the hotelier edits it.
type PricingModel = "per_day" | "obp";
type ProductDraft = Record<string, { externalRoomCode: string; externalRateCode: string; pricingModel: PricingModel; active: boolean }>;

const PRICING_MODEL_OPTIONS = [
  { value: "per_day", label: "por día" },
  { value: "obp", label: "por ocupación" }
];

function asPricingModel(value: string | null | undefined): PricingModel {
  return value === "obp" ? "obp" : "per_day";
}

function productKey(roomTypeId: string, ratePlanId: string): string {
  return `${roomTypeId}|${ratePlanId}`;
}

function describeV2Error(err: unknown): string {
  const info = classifyRateGridError(err);
  if (info.kind === "not_deployed") return "El servidor todavía no admite las correspondencias por producto: hace falta reiniciarlo con el módulo de canales activado.";
  if (info.kind === "forbidden") return "No tienes permiso para editar las correspondencias (hace falta channel_manager.mappings.manage).";
  return info.message;
}

type ProductRow = { key: string; roomType: AdminRoomType; plan: RateGridRatePlan };

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
    fetchRoomTypes(propertyId)
      .then((list) => {
        if (!cancelled) setRoomTypes(list);
      })
      .catch(() => {
        /* table shows ids */
      });
    fetchRatePlans(propertyId)
      .then((list) => {
        if (!cancelled) setRatePlans(list);
      })
      .catch(() => {
        /* table shows ids */
      });
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
  const productRows = useMemo<ProductRow[]>(() => roomTypes.flatMap((rt) => plans.map((plan) => ({ key: productKey(rt.id, plan.id), roomType: rt, plan }))), [roomTypes, plans]);
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
      const savedLabel = plural(mappings.length, "correspondencia guardada", "correspondencias guardadas");
      showToast(found.length ? `${savedLabel} con ${found.length === 1 ? "un aviso" : plural(found.length, "aviso", "avisos")} (ver arriba).` : `${savedLabel}.`, { variant: found.length ? "info" : "success" });
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
      showToast(`Recuperadas de las correspondencias anteriores: ${number(res.created)} nuevas, ${number(res.skippedExisting)} ya existentes (${plural(res.pairs, "par", "pares")}).`, { variant: "success" });
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
  const channelOptions = channels.length === 0 ? [{ value: "", label: "Sin canales" }] : channels.map((c) => ({ value: c.id, label: `${c.name} · ${channelModeLabel(c.mode)}` }));

  const columns: CocoaTableColumn<ProductRow>[] = [
    { key: "roomType", label: "Tipo de habitación", minWidth: 160, render: (r) => `${r.roomType.code} · ${r.roomType.name}` },
    {
      key: "plan",
      label: "Plan",
      fit: true,
      render: (r) => (
        <>
          {r.plan.code}
          {r.plan.derivation.mode !== "none" ? <Note>(derivado)</Note> : null}
        </>
      )
    },
    {
      key: "externalRoomCode",
      label: "Código hab. externo",
      fit: true,
      render: (r) => (
        <CocoaInput
          size="small"
          value={cellValue(r.roomType.id, r.plan.id).externalRoomCode}
          placeholder="p. ej. 123456"
          aria-label={`Código de habitación externo de ${r.roomType.code} · ${r.plan.code}`}
          onChange={(value) => edit(r.roomType.id, r.plan.id, { externalRoomCode: value })}
          style={codeInputStyle}
        />
      )
    },
    {
      key: "externalRateCode",
      label: "Código tarifa externo",
      fit: true,
      render: (r) => (
        <CocoaInput
          size="small"
          value={cellValue(r.roomType.id, r.plan.id).externalRateCode}
          placeholder="p. ej. 789"
          aria-label={`Código de tarifa externo de ${r.roomType.code} · ${r.plan.code}`}
          onChange={(value) => edit(r.roomType.id, r.plan.id, { externalRateCode: value })}
          style={codeInputStyle}
        />
      )
    },
    {
      key: "pricingModel",
      label: "Modelo",
      fit: true,
      render: (r) => (
        <span title="Por ocupación exige precios por ocupación en la celda; si faltan, la entrega no se encola y el guardado avisa">
          <CocoaSelect
            size="small"
            value={cellValue(r.roomType.id, r.plan.id).pricingModel}
            options={PRICING_MODEL_OPTIONS}
            aria-label={`Modelo de precio de ${r.roomType.code} · ${r.plan.code}`}
            onChange={(value) => edit(r.roomType.id, r.plan.id, { pricingModel: asPricingModel(value) })}
          />
        </span>
      )
    },
    {
      key: "active",
      label: "Activo",
      fit: true,
      render: (r) => {
        const v = cellValue(r.roomType.id, r.plan.id);
        return (
          <span className="cocoa-row" data-gap="2" data-wrap="nowrap">
            <CocoaSwitch size="small" checked={v.active} onChange={(checked) => edit(r.roomType.id, r.plan.id, { active: checked })} aria-label={`Correspondencia activa de ${r.roomType.code} · ${r.plan.code}`} />
            {v.mapped ? <CocoaBadge tone="success">guardada</CocoaBadge> : null}
          </span>
        );
      }
    }
  ];

  return (
    <CocoaSection
      title="Correspondencias por producto (tipo × plan)"
      meta={
        coverage ? (
          <CocoaBadge tone={coverage.complete ? "success" : "warning"} title={`${plural(coverage.roomTypesActive, "tipo", "tipos")} × ${plural(coverage.ratePlansDistributable, "plan distribuible", "planes distribuibles")} · ${percent(coverage.coveragePct)}`}>
            {number(coverage.productsMapped)}/{number(coverage.productsTotal)} productos
          </CocoaBadge>
        ) : undefined
      }
    >
      <div className="cocoa-stack" data-gap="3">
        <CocoaToolbar
          variant="content"
          aria-label="Canal y acciones de las correspondencias por producto"
          leftSlot={<CocoaSelect value={channelId} onChange={onChannelChange} aria-label="Canal" disabled={channels.length === 0} options={channelOptions} />}
          rightSlot={
            <>
              <CocoaButton variant="bordered" tone="neutral" size="small" loading={busy === "migrate"} disabled={!channelId || busy !== null} onClick={() => void migrate()}>
                Recuperar las correspondencias anteriores
              </CocoaButton>
              <CocoaButton variant="filled" tone="accent" size="small" loading={busy === "save"} disabled={!channelId || dirtyCount === 0 || busy !== null} onClick={() => void save()}>
                {dirtyCount > 0 ? `Guardar correspondencias (${number(dirtyCount)})` : "Guardar correspondencias"}
              </CocoaButton>
            </>
          }
        />
        <Note>
          El editor de tarifas solo publica en un canal las celdas cuyo producto (tipo de habitación + plan) tiene aquí una correspondencia activa. Los códigos externos son los
          identificadores de habitación y de tarifa que ese canal (Booking.com, Channex…) muestra en su extranet.
        </Note>
        {channelsError ? (
          <CocoaCallout tone="danger" role="alert">
            {channelsError}
          </CocoaCallout>
        ) : null}
        {error ? (
          <CocoaCallout tone="danger" role="alert">
            {error}
          </CocoaCallout>
        ) : null}
        {warnings.length > 0 ? (
          <CocoaCallout
            tone="warning"
            role="status"
            title={`Correspondencias guardadas con ${warnings.length === 1 ? "un aviso" : plural(warnings.length, "aviso", "avisos")}`}
            actions={
              <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => setWarnings([])}>
                Cerrar avisos
              </CocoaButton>
            }
          >
            <ul className="c22-section__list">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </CocoaCallout>
        ) : null}
        {!channelsError && channels.length === 0 ? (
          <CocoaState kind="empty" inline title="Da de alta un canal en Canales de venta para relacionar productos." />
        ) : selected && (roomTypes.length === 0 || plans.length === 0) ? (
          <CocoaState kind="empty" inline title="Faltan tipos de habitación o planes activos en la propiedad." />
        ) : selected ? (
          <CocoaTable
            columns={columns}
            rows={productRows}
            rowKey="key"
            loading={loading}
            density="compact"
            caption={`Correspondencias por producto de ${selected.name}`}
            rowTone={(r) => (draft[r.key] ? "accent" : undefined)}
          />
        ) : null}
      </div>
    </CocoaSection>
  );
}

const ROOM_COLUMNS: CocoaTableColumn<RoomMappingRow>[] = [
  { key: "roomType", label: "Tipo de habitación", render: (m) => m.roomTypeName ?? m.roomTypeCode ?? m.roomTypeId },
  { key: "externalRoomCode", label: "Código externo", fit: true },
  { key: "externalRoomId", label: "ID externo", fit: true, hideOnNarrow: true, render: (m) => m.externalRoomId ?? "—" },
  { key: "status", label: "Estado", fit: true, render: (m) => <MappingStatusBadge status={m.status} /> }
];

const RATE_COLUMNS: CocoaTableColumn<RateMappingRow>[] = [
  { key: "ratePlan", label: "Plan tarifario", render: (m) => m.ratePlanName ?? m.ratePlanCode ?? m.ratePlanId },
  { key: "externalRateCode", label: "Código externo", fit: true },
  { key: "externalRateId", label: "ID externo", fit: true, hideOnNarrow: true, render: (m) => m.externalRateId ?? "—" },
  { key: "status", label: "Estado", fit: true, render: (m) => <MappingStatusBadge status={m.status} /> }
];

const CHANNEL_COLUMNS: CocoaTableColumn<ChannelRow>[] = [
  { key: "name", label: "Canal", render: (c) => <strong>{c.name}</strong> },
  { key: "providerCode", label: "Proveedor", fit: true, render: (c) => <span title={c.providerCode}>{providerLabel(c.providerCode)}</span> },
  { key: "status", label: "Estado", fit: true, render: (c) => <CocoaBadge tone={channelStatusTone(c.status)}>{channelStatusLabel(c.status)}</CocoaBadge> },
  { key: "roomMappingsCount", label: "Habitaciones", align: "right", fit: true, render: (c) => number(c.roomMappingsCount) },
  { key: "rateMappingsCount", label: "Tarifas", align: "right", fit: true, render: (c) => number(c.rateMappingsCount) },
  { key: "lastSyncAt", label: "Última sincronización", fit: true, hideOnNarrow: true, render: (c) => fmtDateTime(c.lastSyncAt) }
];

function MappingsSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton variant="card" height={260} />
      <CocoaSkeleton variant="card" height={200} />
    </div>
  );
}

export function ChannelMappingsScreen() {
  // Hosted inside a routed tab container (Tanda 5): the container paints the page header.
  const hosted = useTabHost() !== null;
  const propertyId = useMemo(() => getActivePropertyId(), []);
  const channelsState = useApiData<{ channels: ChannelRow[] }>(`/channel-manager/channels?propertyId=${propertyId}`);
  const channels = useMemo(() => toArray<ChannelRow>(channelsState.data?.channels ?? channelsState.data), [channelsState.data]);

  // Shared selection (v2 panel + legacy block). Seeded from the `#channel=`
  // deep link the hub emits; a later hash change (another «Correspondencias» click
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
        setDetailError(err instanceof Error ? err.message : "No se pudieron cargar las correspondencias del canal.");
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
  const header = treeHeaderFor("ChannelMappings", { eyebrow: "Comercial · Canales de venta", title: "Correspondencias" });
  const openHub = () => navigateTo("ChannelAggregatorHub");
  const initialLoading = channelsState.loading && !channelsState.data;
  const initialError = channelsState.error && !channelsState.data;

  return (
    <CocoaPage
      eyebrow={header.eyebrow}
      title={header.title}
      subtitle={hosted ? undefined : "Correspondencia entre los tipos de habitación y planes tarifarios de la propiedad y los códigos de cada canal. Una correspondencia incompleta bloquea el envío de tarifas y disponibilidad."}
      actions={
        <CocoaButton variant="filled" tone="accent" onClick={openHub}>
          Gestionar en Canales de venta
        </CocoaButton>
      }
      state={initialLoading ? "loading" : initialError ? "error" : "ready"}
      skeleton={<MappingsSkeleton />}
      error={{ title: "No se pudieron cargar los canales", message: channelsState.error ?? undefined, onRetry: channelsState.refresh }}
      commands={[{ id: "correspondencias-channel-manager", label: "Gestionar en Canales de venta", run: openHub }]}
    >
      <ProductMappingsPanel propertyId={propertyId} channelId={selectedId} onChannelChange={setSelectedId} />

      {channels.length === 0 ? (
        <CocoaSection aria-label="Canales">
          <CocoaState
            kind="empty"
            illustration="connection"
            title="Ningún canal conectado"
            message="Conecta un canal (Booking.com, Expedia, motor directo…) en Canales de venta para poder relacionar habitaciones y tarifas."
            primaryAction={{ label: "Abrir Canales de venta", onClick: openHub }}
          />
        </CocoaSection>
      ) : (
        <>
          <CocoaSection title="Canales" meta={plural(channels.length, "canal", "canales")} padding="none" style={clipStyle}>
            <CocoaTable
              columns={CHANNEL_COLUMNS}
              rows={channels}
              rowKey="id"
              selectedKey={selectedId}
              onSelect={(c) => setSelectedId(c.id)}
              rowTitle={(c) => `Ver las correspondencias de ${c.name}`}
              caption="Canales conectados"
              rowActions={(c) => (
                <CocoaButton
                  variant="plain"
                  tone="accent"
                  size="small"
                  onClick={(event) => {
                    event.stopPropagation();
                    setSelectedId(c.id);
                  }}
                >
                  {c.id === selectedId ? "Seleccionado" : "Ver correspondencias"}
                </CocoaButton>
              )}
            />
          </CocoaSection>

          {selected ? (
            <CocoaSection
              title={`Correspondencias de «${selected.name}»`}
              meta={detail?.coverage ? <CocoaBadge tone={detail.coverage.complete ? "success" : "warning"}>{detail.coverage.complete ? "Cobertura completa" : "Cobertura incompleta"}</CocoaBadge> : undefined}
              action={
                <CocoaButton variant="plain" tone="accent" size="small" loading={detailLoading} disabled={detailLoading} onClick={() => setDetailNonce((n) => n + 1)}>
                  {ACTIONS.refresh}
                </CocoaButton>
              }
            >
              {detailError ? (
                <CocoaState kind="error" inline title="No se pudieron cargar las correspondencias" message={detailError} onRetry={() => setDetailNonce((n) => n + 1)} />
              ) : detailLoading && !detail ? (
                <CocoaState kind="loading" inline />
              ) : detail ? (
                <CocoaGrid align="start">
                  <CocoaSpan cols={6} min={320}>
                    <div className="cocoa-stack" data-gap="2">
                      <div className="cocoa-row" data-gap="2">
                        <strong className="cocoa-caption">Tipos de habitación → código externo</strong>
                        {detail.coverage ? <CoverageBadge mapped={detail.coverage.roomTypesMapped} total={detail.coverage.roomTypesTotal} noun="con código" /> : null}
                      </div>
                      {detail.rooms.length === 0 ? (
                        <CocoaState kind="empty" inline title="Sin correspondencias de habitación para este canal." />
                      ) : (
                        <CocoaTable columns={ROOM_COLUMNS} rows={detail.rooms} rowKey="id" density="compact" caption={`Correspondencias de habitación de ${selected.name}`} />
                      )}
                    </div>
                  </CocoaSpan>
                  <CocoaSpan cols={6} min={320}>
                    <div className="cocoa-stack" data-gap="2">
                      <div className="cocoa-row" data-gap="2">
                        <strong className="cocoa-caption">Planes tarifarios → código externo</strong>
                        {detail.coverage ? <CoverageBadge mapped={detail.coverage.ratePlansMapped} total={detail.coverage.ratePlansTotal} noun="con código" /> : null}
                      </div>
                      {detail.rates.length === 0 ? (
                        <CocoaState kind="empty" inline title="Sin correspondencias de tarifa para este canal." />
                      ) : (
                        <CocoaTable columns={RATE_COLUMNS} rows={detail.rates} rowKey="id" density="compact" caption={`Correspondencias de tarifa de ${selected.name}`} />
                      )}
                    </div>
                  </CocoaSpan>
                </CocoaGrid>
              ) : null}
            </CocoaSection>
          ) : null}
        </>
      )}
    </CocoaPage>
  );
}
