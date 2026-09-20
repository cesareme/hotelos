// AI Human Review Queue (HITL) — «Pendientes de la IA», /hoy/pendientes-ia
// (standalone). Triage screen for high-risk / low-confidence AI actions
// awaiting a human decision. Read-only polling every 20 s; decisions hit the
// /ai-operations/review/* endpoints.
//
// Cocoa 22 (docs/design/COCOA-22.md §4, lista + KPI):
//   CocoaPage → CocoaKpiStrip (pending, SLA, 24 h decisions, resolution)
//   → CocoaToolbar variant="content" (status / type selects, «Asignadas a mí»)
//   → CocoaSection padding="none" + CocoaTable (row actions, selection opens
//   the detail CocoaDrawer with the payload and the decision form).
// Copy: the API ships review types, entity types and payload keys as raw
// English identifiers; ./ai-review-labels.ts translates and formats them
// (qa#15) and lifts the reserved `_review` envelope into its own section.
//
// Tanda UX-2 · D5 (docs/design/UX-DIRECCION-FEEL.md §1 P1/P4, F-D8): a row carries
// only «Aprobar» (`tinted`, one click) and «Rechazar» (opens the drawer for the
// mandatory reason); «Asignar a mí» and «Escalar» live in the drawer footer.
// Corrector UX2-REV-04 — DEFERRED COMMIT (the API has no reopen route, so the
// undo has to happen BEFORE the POST): «Aprobar» flips the row to «Aprobada»
// and shows the CocoaUndoBar (8 s, «Deshacer» / ⌘Z); the POST
// /ai-operations/review/:id/approve leaves when the countdown ends (or the bar
// is closed), when the screen unmounts or on `beforeunload` (keepalive), or when
// another approval replaces it (one bar alive at a time). Undo = nothing sent.
// Pure controller: ./ai-review-deferred.ts. Toasts name the item type
// («Aprobada: Recomendación de tarifa»). ⌘K: «Aprobar la propuesta seleccionada»
// while the drawer shows a pending item. One live region of its own
// (CocoaLiveRegion; the undo bar is the announcement of the change).

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { getActiveOrganizationId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { apiRequest } from "../../services/api-client";
import { useToast } from "../../components/Toast";
import { toArray } from "../../utils/toArray";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { dateTime, number, plural } from "../../lib/format";
import {
  entityTypeLabel,
  formatPayloadValue,
  payloadKeyLabel,
  reviewEnvelopeRows,
  reviewHistoryRows,
  reviewTypeLabel,
  splitReviewPayload
} from "./ai-review-labels";
import { DEFERRED_APPROVAL_NOTE, createDeferredCommit, type DeferredApproval, type DeferredCommitReason } from "./ai-review-deferred";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDrawer,
  CocoaField,
  CocoaFormSection,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaLiveRegion,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaSkeleton,
  CocoaState,
  CocoaSwitch,
  CocoaTable,
  CocoaToolbar,
  CocoaUndoBar,
  toneInk,
  type CocoaUndoEntry,
  type CocoaSelectOption,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

const CURRENT_USER_ID = "usr_123";

type ReviewStatus = "pending" | "approved" | "rejected" | "escalated";

type ReviewItem = {
  id: string;
  organizationId: string;
  propertyId?: string;
  reviewType: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
  payloadJson: Record<string, unknown>;
  status: ReviewStatus;
  assignedTo?: string;
  createdAt: string;
  ageMinutes: number;
  slaBreached: boolean;
};

type ReviewStats = {
  pending: number;
  approved24h: number;
  rejected24h: number;
  escalated: number;
  slaBreached: number;
  avgResolutionMinutes: number;
  byReviewType: Array<{ reviewType: string; pending: number }>;
};

const STATUS_FILTERS: ReviewStatus[] = ["pending", "approved", "rejected", "escalated"];

const REVIEW_STATUS_LABEL: Record<string, string> = {
  pending: "Pendiente",
  approved: "Aprobada",
  rejected: "Rechazada",
  escalated: "Escalada"
};

const REVIEW_STATUS_TONE: Record<ReviewStatus, CocoaTone> = {
  pending: "warning",
  approved: "success",
  rejected: "danger",
  escalated: "warning"
};

function statusLabel(status: string): string {
  return REVIEW_STATUS_LABEL[status] ?? status;
}

/** Age in minutes → «45 min», «2 h», «2 h 5 min». */
function fmtAge(minutes: number): string {
  if (minutes < 60) return `${number(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${number(h)} h` : `${number(h)} h ${number(m)} min`;
}

/** Toast of a finished action with the type of the item: «Aprobada: Recomendación de tarifa». */
export function actionToast(key: string, item: Pick<ReviewItem, "reviewType">): string {
  const verb = key.startsWith("approve") ? "Aprobada" : key.startsWith("reject") ? "Rechazada" : key.startsWith("escalate") ? "Escalada" : key.startsWith("assign") ? "Asignada" : "Hecho";
  return `${verb}: ${reviewTypeLabel(item.reviewType)}`;
}

function isDecided(status: ReviewStatus): boolean {
  return status !== "pending" && status !== "escalated";
}

function statusBadge(status: ReviewStatus) {
  return (
    <CocoaBadge tone={REVIEW_STATUS_TONE[status] ?? "neutral"} size="small">
      {statusLabel(status)}
    </CocoaBadge>
  );
}

// Text styles (tokens only; layout comes from the utilities).
const secondaryStyle: CSSProperties = { color: "var(--cocoa-label-secondary)" };

const valueStyle: CSSProperties = {
  overflowWrap: "anywhere",
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
  color: "var(--cocoa-label)"
};

function ageStyle(breached: boolean): CSSProperties {
  return {
    fontVariantNumeric: "tabular-nums",
    color: breached ? toneInk("danger") : "var(--cocoa-label)",
    fontWeight: breached ? "var(--cocoa-fw-semibold)" : "inherit"
  };
}

type DetailRow = { key: string; label: string; value: ReactNode };

/** Two-column «label / value» list of a drawer section (`c22-section__list`). */
function DetailRows({ rows, "aria-label": ariaLabel }: { rows: DetailRow[]; "aria-label": string }) {
  return (
    <ul className="c22-section__list" aria-label={ariaLabel}>
      {rows.map((row) => (
        <li key={row.key}>
          <span style={secondaryStyle}>{row.label}</span>
          <span style={valueStyle}>{row.value}</span>
        </li>
      ))}
    </ul>
  );
}

const COLUMNS: CocoaTableColumn<ReviewItem>[] = [
  { key: "reviewType", label: "Tipo de revisión", render: (item) => <strong>{reviewTypeLabel(item.reviewType)}</strong> },
  {
    key: "entity",
    label: "Entidad relacionada",
    hideOnNarrow: true,
    render: (item) =>
      item.relatedEntityType ? (
        <span>
          {entityTypeLabel(item.relatedEntityType)}
          {item.relatedEntityId ? <span style={secondaryStyle}> · {item.relatedEntityId}</span> : null}
        </span>
      ) : (
        <span style={secondaryStyle}>—</span>
      )
  },
  { key: "age", label: "Antigüedad", align: "right", render: (item) => <span style={ageStyle(item.slaBreached)}>{fmtAge(item.ageMinutes)}</span> },
  { key: "assignedTo", label: "Revisor", hideOnNarrow: true, render: (item) => item.assignedTo ?? <span style={secondaryStyle}>sin asignar</span> },
  { key: "status", label: "Estado", render: (item) => statusBadge(item.status) }
];

const STATUS_OPTIONS: CocoaSelectOption[] = [{ value: "", label: "Todos los estados" }, ...STATUS_FILTERS.map((s) => ({ value: s, label: statusLabel(s) }))];

export function AiHumanReviewQueueScreen() {
  const organizationId = getActiveOrganizationId();
  const { showToast } = useToast();
  const [statusFilter, setStatusFilter] = useState<string>("pending");
  const [reviewTypeFilter, setReviewTypeFilter] = useState<string>("");
  const [assignedToMe, setAssignedToMe] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rejectHint, setRejectHint] = useState(false);
  const [notes, setNotes] = useState("");
  const [reason, setReason] = useState("");
  const [escalateRole, setEscalateRole] = useState("");
  const [runningAction, setRunningAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  // Aprobación en espera (commit diferido, UX2-REV-04): la fila ya se pinta «Aprobada»; el POST sale al expirar la barra.
  const [deferred, setDeferred] = useState<DeferredApproval<ReviewItem> | null>(null);

  const query = useMemo(
    () => ({
      organizationId,
      ...(statusFilter ? { status: statusFilter } : {}),
      ...(reviewTypeFilter ? { reviewType: reviewTypeFilter } : {}),
      ...(assignedToMe ? { assignedTo: CURRENT_USER_ID } : {})
    }),
    [organizationId, statusFilter, reviewTypeFilter, assignedToMe]
  );

  const {
    data: queueData,
    loading,
    error,
    refresh: refreshQueue
  } = useApiData<ReviewItem[]>("/ai-operations/review/queue", {
    pollIntervalMs: 20000,
    query
  });

  const { data: statsData, refresh: refreshStats } = useApiData<ReviewStats>("/ai-operations/review/stats", {
    pollIntervalMs: 20000,
    query: { organizationId }
  });

  const rawItems = useMemo(() => toArray<ReviewItem>(queueData), [queueData]);
  // La fila en espera se ve «Aprobada» hasta que el POST sale y la cola se revalida (sin optimismo en la caché: nada se ha enviado aún).
  const items = useMemo(
    () => (deferred ? rawItems.map((item) => (item.id === deferred.item.id ? { ...item, status: "approved" as ReviewStatus } : item)) : rawItems),
    [rawItems, deferred]
  );
  const stats = statsData;
  const reviewTypeOptions = useMemo<CocoaSelectOption[]>(() => {
    const set = new Set<string>(items.map((i) => i.reviewType));
    for (const r of stats?.byReviewType ?? []) set.add(r.reviewType);
    return [{ value: "", label: "Todos los tipos" }, ...[...set].sort().map((t) => ({ value: t, label: reviewTypeLabel(t) }))];
  }, [items, stats]);

  const selected = items.find((i) => i.id === selectedId) ?? null;
  // Visible payload fields vs the reserved `_review` envelope (decision history).
  const payloadView = useMemo(() => (selected ? splitReviewPayload(selected.payloadJson) : null), [selected]);
  const envelopeRows = payloadView?.envelope ? reviewEnvelopeRows(payloadView.envelope) : [];
  const historyRows = payloadView?.envelope ? reviewHistoryRows(payloadView.envelope) : [];
  const firstLoad = loading && !queueData && !statsData;
  const pageState = firstLoad ? "loading" : "ready";

  function refreshAll() {
    refreshQueue();
    refreshStats();
  }

  function openDetail(id: string, hint = false) {
    setSelectedId(id);
    setRejectHint(hint);
  }

  function closeDetail() {
    setSelectedId(null);
    setRejectHint(false);
  }

  const isRunning = (key: string, id: string) => runningAction === `${key}-${id}`;

  // ---- commit diferido de la aprobación (UX2-REV-04) ----------------------
  // `post` lee los callbacks vivos a través de una ref: el controlador se crea una vez.
  const postRef = useRef<(approval: DeferredApproval<ReviewItem>, reason: DeferredCommitReason) => Promise<void>>(async () => undefined);
  postRef.current = async (approval, reason) => {
    const { item, body } = approval;
    try {
      // `keepalive`: la petición sobrevive al cierre de la pestaña y a la navegación (api-client, UX1-REV-02).
      await apiRequest(`/ai-operations/review/${item.id}/approve`, { method: "POST", body, keepalive: reason === "unload" || reason === "unmount" });
      if (reason === "unload") return;
      showToast(actionToast(`approve-${item.id}`, item), { variant: "success" });
    } catch (err) {
      if (reason === "unload") return;
      const message = err instanceof Error ? err.message : String(err);
      setActionError(message);
      showToast(message, { variant: "error" });
    } finally {
      if (reason !== "unload") refreshAll();
    }
  };
  const deferredCommit = useMemo(
    () => createDeferredCommit<ReviewItem>({ post: (approval, reason) => postRef.current(approval, reason), onChange: setDeferred }),
    []
  );
  // Flush al desmontar y en beforeunload: la aprobación en espera nunca se pierde.
  useEffect(() => {
    const onBeforeUnload = () => {
      void deferredCommit.flush("unload");
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      void deferredCommit.flush("unmount");
    };
  }, [deferredCommit]);
  const undoEntry = useMemo<CocoaUndoEntry | null>(
    () => (deferred ? { label: actionToast(`approve-${deferred.item.id}`, deferred.item), note: DEFERRED_APPROVAL_NOTE } : null),
    [deferred]
  );

  async function runAction(path: string, body: unknown, key: string, item: ReviewItem) {
    setRunningAction(key);
    setActionError(null);
    setActionMessage(null);
    try {
      await apiRequest(path, { method: "POST", body });
      setActionMessage("Hecho.");
      setNotes("");
      setReason("");
      setEscalateRole("");
      setRejectHint(false);
      refreshAll();
      showToast(actionToast(key, item), { variant: "success" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setActionError(message);
      showToast(message, { variant: "error" });
    } finally {
      setRunningAction(null);
    }
  }

  const assign = (item: ReviewItem) => runAction(`/ai-operations/review/${item.id}/assign`, { userId: CURRENT_USER_ID }, `assign-${item.id}`, item);
  // «Aprobar» (fila, cajón o ⌘K): commit diferido — nada se envía hasta que la barra expira (o la pantalla se va).
  const approve = (item: ReviewItem, withNotes: boolean) => {
    setActionError(null);
    setActionMessage(null);
    if (withNotes) setNotes("");
    if (selectedId === item.id) closeDetail();
    return deferredCommit.schedule(item, withNotes && notes ? { notes } : {});
  };
  const reject = (item: ReviewItem) => runAction(`/ai-operations/review/${item.id}/reject`, { reason }, `reject-${item.id}`, item);
  const escalate = (item: ReviewItem) => runAction(`/ai-operations/review/${item.id}/escalate`, { toRole: escalateRole || undefined }, `escalate-${item.id}`, item);
  const selectedPending = selected !== null && !isDecided(selected.status);

  // Static callout: the CocoaLiveRegion below already announces the same text (one live region of its own).
  const feedback =
    actionError || actionMessage ? (
      <CocoaCallout tone={actionError ? "danger" : "success"}>
        {actionError ?? actionMessage}
      </CocoaCallout>
    ) : null;

  let body;
  if (loading && !queueData) {
    body = <CocoaTable columns={COLUMNS} rows={[]} loading aria-label="Cola de revisión" />;
  } else if (error && !queueData) {
    body = <CocoaState kind="error" title="No se ha podido cargar la cola de revisión ahora mismo." message={error} onRetry={refreshAll} />;
  } else if (items.length === 0) {
    body = <CocoaState kind="empty" illustration="search" title={STATUS_LABELS.noResults} message="Ningún elemento de revisión coincide con estos filtros." />;
  } else {
    body = (
      <CocoaTable
        columns={COLUMNS}
        rows={items}
        rowKey="id"
        selectedKey={selectedId ?? undefined}
        onSelect={(item) => (selectedId === item.id ? closeDetail() : openDetail(item.id))}
        caption="Cola de revisión"
        aria-label="Cola de revisión"
        rowActionsVisible="always"
        rowActions={(item) => {
          // P1: one primary per row («Aprobar» tinted, one click, no dialog; deferred commit + undo bar) + «Rechazar» (the drawer asks the reason). Nothing on decided rows (the deferred one included).
          const decided = isDecided(item.status);
          if (decided) return null;
          return (
            <>
              <CocoaButton variant="tinted" tone="accent" size="small" loading={isRunning("approve", item.id)} disabled={runningAction !== null} onClick={() => void approve(item, false)} title={`Aprobar: ${reviewTypeLabel(item.reviewType)}`}>
                {ACTIONS.approve}
              </CocoaButton>
              <CocoaButton variant="bordered" tone="destructive" size="small" disabled={runningAction !== null} onClick={() => openDetail(item.id, true)} title={`Rechazar: ${reviewTypeLabel(item.reviewType)}`}>
                {ACTIONS.reject}
              </CocoaButton>
            </>
          );
        }}
      />
    );
  }

  return (
    <CocoaPage
      eyebrow="Hoy"
      title="Pendientes de la IA"
      subtitle="Lo que la inteligencia artificial propone y una persona debe aprobar o rechazar antes de aplicarse: acciones de riesgo o de baja confianza, ordenadas por antigüedad. Se actualiza cada 20 s."
      actions={
        <>
          {loading && queueData ? <CocoaBadge tone="info">{STATUS_LABELS.loading}</CocoaBadge> : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refreshAll} aria-label={ACTIONS.refresh} title={ACTIONS.refresh}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      state={pageState}
      skeleton={<QueueSkeleton />}
      commands={[
        { id: "ai-review-refresh", label: "Actualizar los pendientes de la IA", run: refreshAll },
        ...(selected && selectedPending ? [{ id: "ai-review-approve-selected", label: "Aprobar la propuesta seleccionada", run: () => void approve(selected, true) }] : [])
      ]}
    >
      <CocoaLiveRegion message={actionError ?? actionMessage ?? ""} announceKey={runningAction ?? undefined} />

      {/* Deshacer antes que confirmar (P4): the bar IS the announcement of the pending approval; «Cerrar» or the countdown sends it. */}
      <CocoaUndoBar
        entry={undoEntry}
        onUndo={() => {
          deferredCommit.undo();
        }}
        onDismiss={() => void deferredCommit.expire()}
      />

      <CocoaKpiStrip min={200} stagger aria-label="Resumen de la cola de revisión">
        <CocoaKpi label="Pendientes" value={stats ? stats.pending : "—"} deltaLabel="esperando decisión" polarity="neutral" status={stats && stats.pending > 0 ? "warning" : "ok"} degraded={!stats} />
        <CocoaKpi label="Fuera de plazo" value={stats ? stats.slaBreached : "—"} deltaLabel="pendientes más de 60 min" polarity="neutral" status={stats && stats.slaBreached > 0 ? "critical" : "ok"} degraded={!stats} />
        <CocoaKpi label="Aprobadas (24 h)" value={stats ? stats.approved24h : "—"} deltaLabel="últimas 24 h" polarity="neutral" status="ok" degraded={!stats} />
        <CocoaKpi label="Rechazadas (24 h)" value={stats ? stats.rejected24h : "—"} deltaLabel="últimas 24 h" polarity="neutral" status={stats && stats.rejected24h > 0 ? "warning" : "ok"} degraded={!stats} />
        <CocoaKpi label="Resolución media" value={stats ? number(stats.avgResolutionMinutes) : "—"} unit="min" deltaLabel="tiempo medio de decisión" polarity="neutral" status="ok" degraded={!stats} />
      </CocoaKpiStrip>

      <CocoaToolbar
        variant="content"
        aria-label="Filtros de la cola"
        leftSlot={
          <>
            <CocoaSelect value={statusFilter} onChange={setStatusFilter} options={STATUS_OPTIONS} aria-label="Estado" style={{ maxWidth: 280 }} />
            <CocoaSelect value={reviewTypeFilter} onChange={setReviewTypeFilter} options={reviewTypeOptions} aria-label="Tipo de revisión" style={{ maxWidth: 280 }} />
          </>
        }
        rightSlot={<CocoaSwitch checked={assignedToMe} onChange={setAssignedToMe} label="Asignadas a mí" />}
      />

      <CocoaSection title="Cola" meta={plural(items.length, "elemento", "elementos")} padding="none" style={{ overflow: "clip" }} footer={selected ? undefined : feedback} aria-label="Cola de revisión">
        {body}
      </CocoaSection>

      <CocoaDrawer
        open={selected !== null}
        onClose={closeDetail}
        title={selected ? reviewTypeLabel(selected.reviewType) : "Detalle"}
        subtitle={selected ? `${statusLabel(selected.status)} · creada ${dateTime(selected.createdAt)}` : undefined}
        size="md"
        footer={
          selected ? (
            <>
              <CocoaButton variant="bordered" tone="neutral" loading={isRunning("assign", selected.id)} disabled={runningAction !== null} onClick={() => void assign(selected)}>
                {ACTIONS.assignToMe}
              </CocoaButton>
              <CocoaButton variant="bordered" tone="neutral" loading={isRunning("escalate", selected.id)} disabled={!selectedPending || runningAction !== null} onClick={() => void escalate(selected)}>
                {ACTIONS.escalate}
              </CocoaButton>
              <CocoaButton
                variant="bordered"
                tone="destructive"
                disabled={isDecided(selected.status) || !reason.trim() || runningAction !== null}
                loading={isRunning("reject", selected.id)}
                onClick={() => void reject(selected)}
              >
                {ACTIONS.reject}
              </CocoaButton>
              <CocoaButton
                variant="filled"
                tone="accent"
                disabled={isDecided(selected.status) || runningAction !== null}
                loading={isRunning("approve", selected.id)}
                onClick={() => void approve(selected, true)}
              >
                {ACTIONS.approve}
              </CocoaButton>
            </>
          ) : undefined
        }
      >
        {selected ? (
          <div className="cocoa-stack" data-gap="4">
            <div className="cocoa-cluster">
              {statusBadge(selected.status)}
              {selected.slaBreached ? (
                <CocoaBadge tone="danger" variant="tinted" size="small">
                  Fuera de plazo
                </CocoaBadge>
              ) : null}
            </div>

            {rejectHint ? <CocoaCallout tone="warning">Introduce un motivo y después pulsa «{ACTIONS.reject}».</CocoaCallout> : null}
            {feedback}

            <CocoaSection title="Datos">
              <DetailRows
                aria-label="Datos de la revisión"
                rows={[
                  { key: "id", label: "Identificador", value: selected.id },
                  {
                    key: "entity",
                    label: "Relacionada",
                    value: `${selected.relatedEntityType ? entityTypeLabel(selected.relatedEntityType) : "—"} · ${selected.relatedEntityId ?? "—"}`
                  },
                  { key: "assignee", label: "Asignada a", value: selected.assignedTo ?? "sin asignar" },
                  { key: "created", label: "Creada", value: dateTime(selected.createdAt) },
                  {
                    key: "age",
                    label: "Antigüedad",
                    value: (
                      <span style={ageStyle(selected.slaBreached)}>
                        {fmtAge(selected.ageMinutes)}
                        {selected.slaBreached ? " (fuera de plazo)" : ""}
                      </span>
                    )
                  }
                ]}
              />
            </CocoaSection>

            <CocoaSection title="Contenido">
              {!payloadView || payloadView.fields.length === 0 ? (
                <CocoaState kind="empty" inline title="Sin contenido." />
              ) : (
                <DetailRows
                  aria-label="Contenido de la propuesta"
                  rows={payloadView.fields.map(([key, value]) => ({ key, label: payloadKeyLabel(key), value: formatPayloadValue(key, value) }))}
                />
              )}
            </CocoaSection>

            {payloadView?.envelope ? (
              <CocoaSection title="Historial de la revisión" meta={plural(historyRows.length, "acción", "acciones")}>
                <DetailRows
                  aria-label="Historial de la revisión"
                  rows={[...envelopeRows.map((row) => ({ key: `campo-${row.label}`, label: row.label, value: row.value })), ...historyRows]}
                />
              </CocoaSection>
            ) : null}

            <CocoaFormSection title="Decisión" columns={1}>
              <CocoaField label="Notas de aprobación" hint={STATUS_LABELS.optional}>
                <CocoaInput value={notes} onChange={setNotes} multiline rows={2} placeholder="Notas adjuntas a la aprobación…" />
              </CocoaField>
              <CocoaField label="Motivo del rechazo" help="Obligatorio para rechazar." error={rejectHint && !reason.trim() ? "Escribe el motivo del rechazo." : undefined}>
                <CocoaInput value={reason} onChange={setReason} multiline rows={2} placeholder="Por qué se rechaza…" />
              </CocoaField>
              <CocoaField label="Escalar a rol" hint={STATUS_LABELS.optional}>
                <CocoaInput value={escalateRole} onChange={setEscalateRole} placeholder="p. ej. revenue_manager" />
              </CocoaField>
            </CocoaFormSection>
          </div>
        ) : null}
      </CocoaDrawer>
    </CocoaPage>
  );
}

// Mirror skeleton: KPI strip, filter row and the queue card.
function QueueSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={5} min={200} />
      <CocoaSkeleton variant="row" />
      <CocoaSkeleton variant="card" height={320} />
    </div>
  );
}

export default AiHumanReviewQueueScreen;
