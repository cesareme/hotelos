// Campañas de marketing — orquesta segmento + canal + plantilla + horario.
// Conecta con la mensajería omnichannel (P1-6) y los segmentos CRM (P1-14).
//
// Datos reales (apps/api/src/server.ts:2186-2188):
//   GET   /crm/campaigns      — lista de campañas de la organización
//   POST  /crm/campaigns      — crear campaña (nace como borrador)
//   PATCH /crm/campaigns/:id  — cambiar estado (programar / pausar / reactivar)
//
// Estados del backend (CrmCampaignRecord): draft | scheduled | sent | paused.
// Las métricas de envío/apertura/ingresos no existen aún en la API, así que la
// tabla muestra solo campos reales (segmento, canal, tipo, estado, fecha).

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createCampaign,
  fetchCampaigns,
  fetchSegments,
  updateCampaign,
  type CampaignStatus,
  type CrmCampaign,
  type CrmSegment
} from "../../services/crmApi";
import { EmptyState, ErrorState, LoadingBlock } from "../../components/States";
import { useToast } from "../../components/Toast";

const CHANNEL_ICON: Record<string, string> = {
  email: "📧",
  whatsapp: "💬",
  sms: "📱",
  push: "🔔"
};

const STATUS_BADGE: Record<CampaignStatus, "ok" | "warn" | "info"> = {
  scheduled: "ok",
  draft: "info",
  sent: "info",
  paused: "warn"
};

const STATUS_LABEL: Record<CampaignStatus, string> = {
  draft: "borrador",
  scheduled: "programada",
  sent: "enviada",
  paused: "pausada"
};

/** Acción de transición disponible por estado (PATCH { status }). */
const NEXT_ACTION: Record<CampaignStatus, { label: string; target: CampaignStatus; done: string } | null> = {
  draft: { label: "Programar", target: "scheduled", done: "programada" },
  scheduled: { label: "Pausar", target: "paused", done: "pausada" },
  paused: { label: "Reactivar", target: "scheduled", done: "reactivada" },
  sent: null
};

const CAMPAIGN_TYPES = [
  { value: "promocional", label: "Promocional" },
  { value: "bienvenida", label: "Bienvenida" },
  { value: "winback", label: "Winback (recuperación)" },
  { value: "newsletter", label: "Newsletter" }
];

const CHANNELS = [
  { value: "email", label: "Email" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "sms", label: "SMS" },
  { value: "push", label: "Push" }
];

type CampaignDraft = {
  name: string;
  channel: string;
  campaignType: string;
  segmentId: string;
  subject: string;
};

function emptyDraft(): CampaignDraft {
  return { name: "", channel: "email", campaignType: "promocional", segmentId: "", subject: "" };
}

function subjectOf(campaign: CrmCampaign): string | null {
  const raw = (campaign.contentJson ?? {})["subject"];
  return typeof raw === "string" && raw.trim() !== "" ? raw : null;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "2-digit" });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function CampaignManagerScreen() {
  const { showToast } = useToast();
  const [campaigns, setCampaigns] = useState<CrmCampaign[]>([]);
  const [segments, setSegments] = useState<CrmSegment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | CampaignStatus>("all");
  const [draft, setDraft] = useState<CampaignDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [mutatingId, setMutatingId] = useState<string | null>(null);

  const load = useCallback(async (): Promise<CrmCampaign[] | null> => {
    setError(null);
    try {
      // Los segmentos solo alimentan el selector y la resolución de nombres:
      // si fallan, la pantalla sigue funcionando con los ids en crudo.
      const [campaignRecords, segmentRecords] = await Promise.all([
        fetchCampaigns(),
        fetchSegments().catch(() => null)
      ]);
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
    void load();
  }, [load]);

  const stats = useMemo(() => {
    const byStatus = (status: CampaignStatus) => campaigns.filter((c) => c.status === status).length;
    return {
      total: campaigns.length,
      scheduled: byStatus("scheduled"),
      draft: byStatus("draft"),
      sent: byStatus("sent")
    };
  }, [campaigns]);

  const segmentName = useCallback(
    (segmentId: string | undefined): string => {
      if (!segmentId) return "—";
      return segments.find((s) => s.id === segmentId)?.name ?? segmentId;
    },
    [segments]
  );

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
        showToast(
          `La API aceptó la petición, pero «${campaign.name}» sigue en estado «${STATUS_LABEL[shownStatus] ?? shownStatus}».`,
          { variant: "info" }
        );
      }
    } catch (err) {
      showToast(`No se pudo actualizar «${campaign.name}»: ${errMsg(err)}`, { variant: "error" });
    } finally {
      setMutatingId(null);
    }
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

  const filtered = filter === "all" ? campaigns : campaigns.filter((c) => c.status === filter);

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header className="bo-card-head">
        <div>
          <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12 }}>
            Comercial · Marketing
          </p>
          <h2 style={{ color: "var(--ink)" }}>Campañas de marketing</h2>
          <p className="bo-muted" style={{ marginTop: 4, textTransform: "none" }}>
            Cada campaña une un <strong>segmento CRM</strong> con una <strong>plantilla</strong> y un <strong>canal</strong>.
            El motor de mensajería omnichannel se encarga del envío, con cascada de fallback si el canal primario falla.
          </p>
        </div>
        <button type="button" className="primary" onClick={() => setDraft(emptyDraft())} disabled={loading}>+ Nueva campaña</button>
      </header>

      {loading ? (
        <LoadingBlock label="Cargando campañas…" />
      ) : error ? (
        <ErrorState
          title="No se pudieron cargar las campañas"
          message={error}
          onRetry={() => {
            setLoading(true);
            void load();
          }}
        />
      ) : (
        <>
          <div className="rev-kpi-grid">
            <article className="rev-kpi rev-kpi-ok">
              <div className="rev-kpi-head"><span className="rev-kpi-label">Campañas</span><span className="bo-status info">total</span></div>
              <div className="rev-kpi-value">{stats.total}</div>
            </article>
            <article className="rev-kpi rev-kpi-ok">
              <div className="rev-kpi-head"><span className="rev-kpi-label">Programadas</span><span className="bo-status ok">activas</span></div>
              <div className="rev-kpi-value">{stats.scheduled}</div>
            </article>
            <article className="rev-kpi rev-kpi-ok">
              <div className="rev-kpi-head"><span className="rev-kpi-label">Borradores</span></div>
              <div className="rev-kpi-value">{stats.draft}</div>
            </article>
            <article className="rev-kpi rev-kpi-ok">
              <div className="rev-kpi-head"><span className="rev-kpi-label">Enviadas</span></div>
              <div className="rev-kpi-value">{stats.sent}</div>
            </article>
          </div>

          {draft ? (
            <article className="bo-card" style={{ background: "var(--surface-2, var(--surface))", border: "1px solid var(--accent)" }}>
              <div className="bo-card-head">
                <h3 style={{ color: "var(--ink)" }}>Nueva campaña</h3>
                <button type="button" onClick={() => setDraft(null)} disabled={saving}>Cancelar</button>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
                <label>Nombre<input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
                <label>Canal
                  <select value={draft.channel} onChange={(e) => setDraft({ ...draft, channel: e.target.value })}>
                    {CHANNELS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                </label>
                <label>Tipo
                  <select value={draft.campaignType} onChange={(e) => setDraft({ ...draft, campaignType: e.target.value })}>
                    {CAMPAIGN_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </label>
                <label>Segmento CRM
                  <select value={draft.segmentId} onChange={(e) => setDraft({ ...draft, segmentId: e.target.value })}>
                    <option value="">— sin segmento —</option>
                    {segments.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </label>
                <label style={{ gridColumn: "1 / -1" }}>Asunto / plantilla
                  <input value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} placeholder="P. ej. Tu próxima estancia en A Coruña" />
                </label>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                <button type="button" className="primary" onClick={() => void saveDraft()} disabled={!draft.name.trim() || saving}>
                  {saving ? "Creando…" : "Crear borrador"}
                </button>
              </div>
            </article>
          ) : null}

          {/* Filter */}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(["all", "draft", "scheduled", "sent", "paused"] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={filter === f ? "primary" : ""}
                style={{ padding: "6px 12px" }}
              >
                {f === "all" ? "Todas" : f === "draft" ? "Borradores" : f === "scheduled" ? "Programadas" : f === "sent" ? "Enviadas" : "Pausadas"}
              </button>
            ))}
          </div>

          {/* Campaigns table */}
          <article className="bo-card" style={{ background: "var(--surface)" }}>
            <div className="bo-card-head">
              <h3 style={{ color: "var(--ink)" }}>Campañas ({filtered.length})</h3>
            </div>
            {campaigns.length === 0 ? (
              <EmptyState
                title="Sin campañas todavía"
                message="Crea la primera campaña para conectar un segmento CRM con un canal de envío."
                actions={<button type="button" className="primary" onClick={() => setDraft(emptyDraft())}>+ Nueva campaña</button>}
              />
            ) : filtered.length === 0 ? (
              <p className="bo-muted" style={{ textTransform: "none" }}>No hay campañas con este filtro.</p>
            ) : (
              <div className="rev-report-wrap">
                <table className="cm-table">
                  <thead>
                    <tr>
                      <th>Campaña</th><th>Segmento</th><th>Canal</th><th>Tipo</th>
                      <th>Estado</th><th>Creada</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((c) => {
                      const action = NEXT_ACTION[c.status] ?? null;
                      const subject = subjectOf(c);
                      return (
                        <tr key={c.id}>
                          <td>
                            <strong>{c.name}</strong>
                            {subject ? <small className="bo-muted" style={{ display: "block" }}>{subject}</small> : null}
                          </td>
                          <td style={{ fontSize: 12 }}>{segmentName(c.segmentId)}</td>
                          <td>{CHANNEL_ICON[c.channel] ?? "•"} {c.channel}</td>
                          <td style={{ fontSize: 12 }}>{c.campaignType}</td>
                          <td><span className={`bo-status ${STATUS_BADGE[c.status] ?? "info"}`} style={{ fontSize: 10 }}>{STATUS_LABEL[c.status] ?? c.status}</span></td>
                          <td className="mono">{fmtDate(c.createdAt)}</td>
                          <td>
                            {action ? (
                              <button
                                type="button"
                                onClick={() => void changeStatus(c, action.target, action.done)}
                                disabled={mutatingId !== null}
                              >
                                {mutatingId === c.id ? "Aplicando…" : action.label}
                              </button>
                            ) : (
                              <span className="bo-muted">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </article>

          <p className="bo-muted" style={{ fontSize: 11, textTransform: "none" }}>
            Las métricas de envío (audiencia, open rate, conversión, ingresos) se mostrarán cuando el motor de mensajería
            publique resultados por campaña — la API aún no las expone.
          </p>
        </>
      )}
    </section>
  );
}
