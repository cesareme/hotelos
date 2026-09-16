// Campañas de marketing — Comercial › Clientes y fidelización › Campañas
// (/comercial/clientes/campanas, hosted inside ClientesTabs).
//
// Cocoa 22 · ola 7 · lote 7-B (docs/design/COCOA-22.md §4, archetype
// «dashboard alojado»): CocoaPage → CocoaKpiStrip (total, scheduled, drafts,
// sent) → CocoaToolbar with the status filter → CocoaSection with a
// CocoaTable of the campaigns (transition as a row action) → a CocoaDrawer
// creates a campaign (it is born as a draft). «Nueva campaña» lives in the
// page actions and in ⌘K.
//
// A campaign joins a CRM segment with a template and a channel; the
// omnichannel messaging engine sends it. Data (apps/api/src/server.ts:2186-2188,
// module guest_data_crm_loyalty):
//   GET   /crm/campaigns      — campaigns of the organisation
//   POST  /crm/campaigns      — create (status draft)
//   PATCH /crm/campaigns/:id  — change status (schedule / pause / resume)
//
// Backend statuses (CrmCampaignRecord): draft | scheduled | sent | paused.
// Delivery metrics (audience, open rate, revenue) do not exist in the API
// yet, so the table shows real fields only. Module gate (qa#14): nothing is
// requested until the module is known to be enabled; with it off the page
// paints «Módulo no activado» (+ «Activar módulo» for users with modules.enable).

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { treeHeaderFor } from "../tabs/tab-helpers";
import { getActiveProperty } from "../../services/activeProperty";
import {
  createCampaign,
  fetchCampaigns,
  fetchSegments,
  updateCampaign,
  type CampaignStatus,
  type CrmCampaign,
  type CrmSegment
} from "../../services/crmApi";
import { useToast } from "../../components/Toast";
import { ACTIONS, FIELD_LABELS, newLabel } from "../../content/actions";
import { date, number, plural } from "../../lib/format";
import { moduleDisabledCopy } from "../operations/module-gate";
import { useScreenModuleGate } from "../operations/useScreenModuleGate";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDrawer,
  CocoaField,
  CocoaFormRow,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaSkeleton,
  CocoaState,
  CocoaTable,
  CocoaToolbar,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

// Menu labels of the tree (Comercial › Clientes y fidelización › Campañas), never retyped here.
const HEADER = treeHeaderFor("CampaignManagerReal", { eyebrow: "Comercial · Clientes y fidelización", title: "Campañas" });

const STATUS_TONE: Record<CampaignStatus, CocoaTone> = {
  scheduled: "success",
  draft: "neutral",
  sent: "info",
  paused: "warning"
};

const STATUS_LABEL: Record<CampaignStatus, string> = {
  draft: "borrador",
  scheduled: "programada",
  sent: "enviada",
  paused: "pausada"
};

/** Transition available per status (PATCH { status }). */
const NEXT_ACTION: Record<CampaignStatus, { label: string; target: CampaignStatus; done: string } | null> = {
  draft: { label: "Programar", target: "scheduled", done: "programada" },
  scheduled: { label: "Pausar", target: "paused", done: "pausada" },
  paused: { label: "Reactivar", target: "scheduled", done: "reactivada" },
  sent: null
};

const CAMPAIGN_TYPES = [
  { value: "promocional", label: "Promocional" },
  { value: "bienvenida", label: "Bienvenida" },
  { value: "winback", label: "Recuperación de clientes" },
  { value: "newsletter", label: "Boletín" }
];

const CHANNELS = [
  { value: "email", label: "Correo electrónico" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "sms", label: "SMS" },
  { value: "push", label: "Notificación push" }
];

type StatusFilter = "all" | CampaignStatus;

const FILTER_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "Todas las campañas" },
  { value: "draft", label: "Borradores" },
  { value: "scheduled", label: "Programadas" },
  { value: "sent", label: "Enviadas" },
  { value: "paused", label: "Pausadas" }
];

type CampaignDraft = {
  name: string;
  channel: string;
  campaignType: string;
  segmentId: string;
  subject: string;
};

/** Campaign row with the segment name resolved (the columns are static, §4.2 A5). */
type CampaignTableRow = CrmCampaign & { segmentLabel: string; subject: string | null };

const NEW_LABEL = newLabel("f", "campaña");
const CREATE_LABEL = "Crear borrador";
const MAX_ROWS = 200;

function emptyDraft(): CampaignDraft {
  return { name: "", channel: "email", campaignType: "promocional", segmentId: "", subject: "" };
}

function subjectOf(campaign: CrmCampaign): string | null {
  const raw = (campaign.contentJson ?? {})["subject"];
  return typeof raw === "string" && raw.trim() !== "" ? raw : null;
}

function channelLabel(channel: string): string {
  return CHANNELS.find((c) => c.value === channel)?.label ?? channel;
}

function typeLabel(type: string): string {
  return CAMPAIGN_TYPES.find((t) => t.value === type)?.label ?? type;
}

function statusLabel(status: CampaignStatus | string): string {
  return STATUS_LABEL[status as CampaignStatus] ?? status;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Footnote text (subject under the name, row count) in the secondary ink; outside a literal `style={{…}}` (rule 6).
const footnoteStyle: CSSProperties = { display: "block", fontSize: "var(--cocoa-fs-footnote)", color: "var(--cocoa-label-secondary)" };

const COLUMNS: CocoaTableColumn<CampaignTableRow>[] = [
  {
    key: "name",
    label: "Campaña",
    minWidth: 180,
    render: (c) => (
      <>
        <strong>{c.name}</strong>
        {c.subject ? <span style={footnoteStyle}>{c.subject}</span> : null}
      </>
    )
  },
  { key: "segment", label: "Segmento", hideOnNarrow: true, render: (c) => c.segmentLabel },
  { key: "channel", label: FIELD_LABELS.channel, fit: true, render: (c) => channelLabel(c.channel) },
  { key: "campaignType", label: FIELD_LABELS.type, fit: true, showFrom: "laptop", render: (c) => typeLabel(c.campaignType) },
  {
    key: "status",
    label: FIELD_LABELS.status,
    fit: true,
    render: (c) => (
      <CocoaBadge tone={STATUS_TONE[c.status] ?? "neutral"} variant="dot" size="small">
        {statusLabel(c.status)}
      </CocoaBadge>
    )
  },
  { key: "createdAt", label: FIELD_LABELS.createdAt, fit: true, hideOnNarrow: true, render: (c) => date(c.createdAt, "medium") }
];

// Mirror skeleton: the KPI strip and the campaigns table.
function CampaignsSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={4} />
      <CocoaSkeleton variant="card" height={280} />
    </div>
  );
}

export function CampaignManagerScreen() {
  // Hosted inside ClientesTabs the container paints eyebrow + H1; CocoaPage adds the subtitle and actions row.
  const propertyName = getActiveProperty().propertyName;
  const { showToast } = useToast();
  // Module gate (qa#14): no request until guest_data_crm_loyalty is known to be enabled.
  const moduleGate = useScreenModuleGate("CampaignManagerReal");
  const [campaigns, setCampaigns] = useState<CrmCampaign[]>([]);
  const [segments, setSegments] = useState<CrmSegment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [draft, setDraft] = useState<CampaignDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [mutatingId, setMutatingId] = useState<string | null>(null);

  const load = useCallback(async (): Promise<CrmCampaign[] | null> => {
    setError(null);
    try {
      // The segments only feed the selector and the name resolution: if they
      // fail, the screen keeps working with the raw ids.
      const [campaignRecords, segmentRecords] = await Promise.all([fetchCampaigns(), fetchSegments().catch(() => null)]);
      setCampaigns(campaignRecords);
      if (segmentRecords) setSegments(segmentRecords);
      return campaignRecords;
    } catch (err) {
      setError(errMsg(err));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (moduleGate.ready) void load();
  }, [load, moduleGate.ready]);

  function reload() {
    setLoading(true);
    void load();
  }

  const stats = useMemo(() => {
    const byStatus = (status: CampaignStatus) => campaigns.filter((c) => c.status === status).length;
    return { total: campaigns.length, scheduled: byStatus("scheduled"), draft: byStatus("draft"), sent: byStatus("sent") };
  }, [campaigns]);

  const segmentName = useCallback(
    (segmentId: string | undefined): string => {
      if (!segmentId) return "—";
      return segments.find((s) => s.id === segmentId)?.name ?? segmentId;
    },
    [segments]
  );

  const filtered = useMemo(() => (filter === "all" ? campaigns : campaigns.filter((c) => c.status === filter)), [campaigns, filter]);
  const rows: CampaignTableRow[] = useMemo(
    () => filtered.slice(0, MAX_ROWS).map((c) => ({ ...c, segmentLabel: segmentName(c.segmentId), subject: subjectOf(c) })),
    [filtered, segmentName]
  );

  const segmentOptions = useMemo(() => [{ value: "", label: "Sin segmento" }, ...segments.map((s) => ({ value: s.id, label: s.name }))], [segments]);

  async function changeStatus(campaign: CrmCampaign, target: CampaignStatus, doneLabel: string) {
    if (mutatingId) return;
    setMutatingId(campaign.id);
    try {
      await updateCampaign(campaign.id, { status: target });
      const fresh = await load();
      const updated = fresh?.find((c) => c.id === campaign.id);
      if (updated?.status === target) {
        showToast(`Campaña «${campaign.name}» ${doneLabel}.`, { variant: "success" });
      } else {
        const shownStatus = updated?.status ?? campaign.status;
        showToast(`La petición se aceptó, pero «${campaign.name}» sigue en estado «${statusLabel(shownStatus)}».`, { variant: "info" });
      }
    } catch (err) {
      showToast(`No se pudo actualizar «${campaign.name}»: ${errMsg(err)}`, { variant: "error" });
    } finally {
      setMutatingId(null);
    }
  }

  function startNew() {
    setDraft(emptyDraft());
  }

  async function saveDraft() {
    if (!draft || !draft.name.trim() || saving) return;
    setSaving(true);
    try {
      const created = await createCampaign({
        name: draft.name.trim(),
        campaignType: draft.campaignType,
        channel: draft.channel,
        segmentId: draft.segmentId || undefined,
        contentJson: draft.subject.trim() ? { subject: draft.subject.trim() } : undefined
      });
      setDraft(null);
      await load();
      showToast(`Campaña «${created.name}» creada como borrador.`, { variant: "success" });
    } catch (err) {
      showToast(`No se pudo crear la campaña: ${errMsg(err)}`, { variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  const canSave = draft !== null && draft.name.trim() !== "" && !saving;

  // Module not active → the whole body is the «Módulo no activado» state (§3.10).
  const moduleDisabled = moduleGate.status === "disabled";
  const disabledCopy = moduleDisabledCopy(moduleGate.canEnable);
  const state =
    moduleGate.status === "loading" ? "loading" : moduleDisabled ? "empty" : loading ? "loading" : error ? "error" : "ready";

  return (
    <CocoaPage
      eyebrow={`${HEADER.eyebrow} · ${propertyName}`}
      title={HEADER.title}
      subtitle="Cada campaña une un segmento CRM con una plantilla y un canal; el motor de mensajería se encarga del envío, con canal alternativo si el principal falla."
      actions={
        moduleGate.ready ? (
          <>
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={reload} disabled={loading}>
              {ACTIONS.refresh}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" size="small" onClick={startNew} disabled={loading}>
              {NEW_LABEL}
            </CocoaButton>
          </>
        ) : null
      }
      state={state}
      skeleton={<CampaignsSkeleton />}
      empty={{
        title: disabledCopy.title,
        message: disabledCopy.message,
        primaryAction: disabledCopy.cta ? { label: disabledCopy.cta, onClick: moduleGate.enable } : undefined
      }}
      error={{ title: "No se pudieron cargar las campañas", message: error ?? undefined, onRetry: reload }}
      commands={
        moduleGate.ready
          ? [
              { id: "campaigns-new", label: NEW_LABEL, run: startNew },
              { id: "campaigns-refresh", label: "Actualizar campañas", run: reload }
            ]
          : moduleDisabled && disabledCopy.cta
            ? [{ id: "campaigns-enable-module", label: `${disabledCopy.cta} · ${HEADER.title}`, run: moduleGate.enable }]
            : []
      }
    >
      <CocoaKpiStrip stagger aria-label="Campañas por estado">
        <CocoaKpi label="Campañas" value={number(stats.total)} caption="en la organización" polarity="neutral" status="ok" />
        <CocoaKpi label="Programadas" value={number(stats.scheduled)} caption="pendientes de envío" polarity="neutral" status="ok" />
        <CocoaKpi label="Borradores" value={number(stats.draft)} caption="sin programar" polarity="neutral" status={stats.draft > 0 ? "warning" : "ok"} />
        <CocoaKpi label="Enviadas" value={number(stats.sent)} caption="ya entregadas" polarity="neutral" status="ok" />
      </CocoaKpiStrip>

      <CocoaToolbar
        variant="content"
        aria-label="Filtros de campañas"
        leftSlot={<CocoaSelect value={filter} onChange={(v) => setFilter(v as StatusFilter)} options={FILTER_OPTIONS} size="small" aria-label="Filtrar por estado" />}
        rightSlot={<span style={footnoteStyle}>{`${number(filtered.length)} de ${plural(campaigns.length, "campaña", "campañas")}`}</span>}
      />

      <CocoaSection
        title="Campañas"
        meta={plural(filtered.length, "campaña", "campañas")}
        padding={rows.length === 0 ? "md" : "none"}
        style={{ overflow: "clip" }}
      >
        {campaigns.length === 0 ? (
          <CocoaState
            kind="empty"
            title="Sin campañas todavía"
            message="Crea la primera campaña para conectar un segmento CRM con un canal de envío. Por ahora las campañas se guardan en la memoria del servidor y se pierden al reiniciarlo."
            primaryAction={{ label: NEW_LABEL, onClick: startNew }}
          />
        ) : rows.length === 0 ? (
          <CocoaState kind="empty" inline illustration="search" title="No hay campañas con este filtro." primaryAction={{ label: ACTIONS.clearFilters, onClick: () => setFilter("all") }} />
        ) : (
          <CocoaTable
            columns={COLUMNS}
            rows={rows}
            rowKey="id"
            rowActions={(c) => {
              const action = NEXT_ACTION[c.status] ?? null;
              if (!action) return <span style={footnoteStyle}>—</span>;
              return (
                <CocoaButton
                  variant="tinted"
                  tone="accent"
                  size="small"
                  onClick={() => void changeStatus(c, action.target, action.done)}
                  loading={mutatingId === c.id}
                  disabled={mutatingId !== null}
                >
                  {action.label}
                </CocoaButton>
              );
            }}
            caption="Campañas"
            aria-label="Campañas"
          />
        )}
      </CocoaSection>

      <CocoaCallout tone="neutral" title="Métricas de envío">
        La audiencia, la tasa de apertura, la conversión y los ingresos por campaña aparecerán aquí cuando el motor de mensajería publique resultados; todavía no
        están disponibles.
      </CocoaCallout>

      <CocoaDrawer
        open={draft !== null}
        onClose={() => (saving ? undefined : setDraft(null))}
        title={NEW_LABEL}
        subtitle="La campaña nace como borrador; prográmala desde la lista cuando esté lista."
        side="right"
        size="md"
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={() => setDraft(null)} disabled={saving}>
              {ACTIONS.cancel}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" onClick={() => void saveDraft()} loading={saving} disabled={!canSave}>
              {CREATE_LABEL}
            </CocoaButton>
          </>
        }
      >
        {draft ? (
          <div className="cocoa-stack" data-gap="3">
            <CocoaField label={FIELD_LABELS.name} required>
              <CocoaInput value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} disabled={saving} autoComplete="off" />
            </CocoaField>
            <CocoaFormRow columns={2}>
              <CocoaField label={FIELD_LABELS.channel}>
                <CocoaSelect value={draft.channel} onChange={(v) => setDraft({ ...draft, channel: v })} options={CHANNELS} disabled={saving} />
              </CocoaField>
              <CocoaField label={FIELD_LABELS.type}>
                <CocoaSelect value={draft.campaignType} onChange={(v) => setDraft({ ...draft, campaignType: v })} options={CAMPAIGN_TYPES} disabled={saving} />
              </CocoaField>
            </CocoaFormRow>
            <CocoaField label="Segmento CRM" help={segments.length === 0 ? "Todavía no hay segmentos definidos." : undefined}>
              <CocoaSelect value={draft.segmentId} onChange={(v) => setDraft({ ...draft, segmentId: v })} options={segmentOptions} disabled={saving} />
            </CocoaField>
            <CocoaField label="Asunto o plantilla">
              <CocoaInput value={draft.subject} onChange={(v) => setDraft({ ...draft, subject: v })} placeholder="Por ejemplo: Tu próxima estancia en A Coruña" disabled={saving} />
            </CocoaField>
          </div>
        ) : null}
      </CocoaDrawer>
    </CocoaPage>
  );
}
