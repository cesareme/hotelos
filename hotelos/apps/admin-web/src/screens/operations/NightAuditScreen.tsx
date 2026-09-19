// Night Audit Screen — checklist guiada para el cierre del día («Cierre del
// día», /hoy/cierre-del-dia, standalone).
//
// Directriz ehotelOS (Nov 2026):
//   "La auditoría nocturna debe ser una checklist inteligente. El sistema debe
//    decir: 'No puedes cerrar todavía porque hay 3 folios con saldo pendiente
//    y 2 llegadas sin resolver.'"
//
// Cocoa 22 (docs/design/COCOA-22.md §4, plantilla DashboardStandalone):
//   - CocoaPage with the can-close banner as a CocoaCallout (success/danger)
//     that carries the «Cerrar día» CocoaButton
//   - ok / warning / blocker summary as a CocoaKpiStrip
//   - checks as stacked CocoaCallout cards (status icon, count badge, affected
//     items expandable, fix action → typed navigateTo)
//   - previous runs in a CocoaTable (sticky head, stacked cards under 600 px);
//     a row opens the PERSISTED REPORT of that run in a CocoaDrawer (Tanda 6 ·
//     lote 6-E: NightAuditReportWire — steps with their status, room charges
//     from the rate grid, no-shows, revenue by type, the payments_summary step
//     by method, cash closures of the day and the warnings of reservations
//     without a rate), fetched fresh from GET …/night-audit/runs/:runId; the
//     run just executed opens its report at once.
// Tanda L5 (lote L5-D):
//   - the preflight is a GATE in the API: with blockers, «Cerrar día» gives way
//     to «Cerrar de todos modos» (only with night_audit.run) → CocoaDialog with
//     the reason (≥ 10 characters) → POST …/run { force, reasonText }; the
//     report then carries `preflightOverride` (section «Cierre forzado»);
//   - the report shows the close_settled_folios step («Folios liquidados»);
//   - the drawer shows who ran / reviewed / reopened the day and offers the T8a
//     actions: «Marcar como revisado» (night_audit.review; the API answers 409
//     runner_ne_reviewer to the runner) and «Reabrir día» (night_audit.reopen;
//     reason code + text; > 7 days → 409 APPROVAL_REQUIRED with the request id).
//   Permissions are read from the session (getUser().permissions, as the shell
//   does); the API re-checks every one of them.
// Data: GET /properties/:id/night-audit/preflight (30 s poll),
// GET /properties/:id/night-audit/runs, GET …/runs/:runId;
// POST /properties/:id/night-audit/run (409 NIGHT_AUDIT_ALREADY_COMPLETED /
// NIGHT_AUDIT_IN_PROGRESS / NIGHT_AUDIT_PREFLIGHT_BLOCKED mapped by posErrorMessage),
// POST …/runs/:runId/review, POST …/runs/:runId/reopen (services/posApi).

import { useEffect, useId, useState, type CSSProperties } from "react";
import { useApiData } from "../../hooks/useApiData";
// CF-05 (tests/admin-web-no-raw-fetch): every call goes through api-client
// (the typed readers and writers live in services/posApi; ApiError carries the
// `details` the 409s of review / reopen bring).
import { ApiError, apiRequest } from "../../services/api-client";
import {
  fetchNightAuditRun,
  posErrorMessage,
  reopenNightAuditRun,
  reviewNightAuditRun,
  runNightAudit,
  type NightAuditReopenReasonCode,
  type NightAuditReportWire,
  type NightAuditRunWire
} from "../../services/posApi";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { getUser } from "../../services/auth-storage";
import { useToast } from "../../components/Toast";
import { toArray } from "../../utils/toArray";
import { navigateTo, type ScreenKey } from "../../lib/navigate";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { date, dateTime, money, number, plural } from "../../lib/format";
import { CheckCircleIcon, ExclamationCircleIcon, XCircleIcon } from "../../components/cocoa-icons/StatusIcons";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDialog,
  CocoaDrawer,
  CocoaField,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaSkeleton,
  CocoaState,
  CocoaTable,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";
import { closureOutletLabel, closureStatusLabel, closureStatusTone, differenceKind } from "../pos/cash-closure-helpers";
import {
  PRICE_SOURCE_LABELS,
  REOPEN_REASON_CODES,
  REOPEN_REASON_LABELS,
  ROOM_CHARGE_OUTCOME_LABELS,
  RUN_REVIEW_LABELS,
  blockerLabel,
  canForceClose,
  labelledAmounts,
  paymentMethodLabel,
  preflightOverrideSummary,
  reopenReasonLabel,
  reportSummary,
  revenueTypeLabel,
  roomChargeOutcomeTone,
  runActionsFor,
  runReviewState,
  runReviewTone,
  runStatusLabel,
  runStatusTone,
  settledFoliosSummary,
  stepLabel,
  stepStatusLabel,
  stepTone,
  unchargedReservations
} from "./night-audit-report";

type Status = "ok" | "warning" | "blocker";

type CheckItem = { ref: string; label: string; detail?: string };

type Check = {
  id: string;
  title: string;
  status: Status;
  /** Affected items; `null` when the check itself could not run (the API explains it in `detail`). */
  count: number | null;
  detail: string;
  items?: CheckItem[];
};

type PreflightData = {
  propertyId: string;
  businessDate?: string;
  generatedAt: string;
  canClose: boolean;
  blockingMessage?: string;
  checks: Check[];
  summary: { ok: number; warning: number; blocker: number };
};

type NightAuditActionKey = "night_audit.run" | "night_audit.review" | "night_audit.reopen";

const STATUS_TONE: Record<Status, CocoaTone> = { ok: "success", warning: "warning", blocker: "danger" };
const STATUS_LABEL: Record<Status, string> = { ok: "Correcto", warning: "Atención", blocker: "Bloquea" };

const MAX_RUNS = 10;
/** Minimum length of the reason of a forced close (NightAuditRunSchema of the API). */
const FORCE_REASON_MIN = 10;

const REOPEN_OPTIONS = REOPEN_REASON_CODES.map((code) => ({ value: code, label: REOPEN_REASON_LABELS[code] }));

/**
 * Same rule as the shell's setup banner (layouts/BackOfficeLayout): a session
 * without a permission list (demo mode) still offers the action; the API
 * decides (403 / 409) and the screen shows its message.
 */
function sessionCan(key: NightAuditActionKey): boolean {
  const user = getUser();
  return !user?.permissions || user.permissions.includes(key);
}

/** «Tú» for the session's own user id; the id otherwise (the wire carries ids, not names). */
function actorLabel(userId: string | null | undefined): string {
  if (!userId) return "—";
  return getUser()?.userId === userId ? "Tú" : userId;
}

/**
 * Message of a failed review / reopen: the API's own sentence on a 409
 * (runner_ne_reviewer, NOT_COMPLETED, ALREADY_REVIEWED, APPROVAL_REQUIRED —
 * the last one with the id of the approval request to follow), posErrorMessage
 * otherwise.
 */
function actionErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.status === 409) {
    const details = (error.details ?? null) as { code?: string; requestId?: string } | null;
    if (details?.code === "APPROVAL_REQUIRED") {
      return details.requestId ? `${error.message} Solicitud de aprobación: ${details.requestId}.` : `${error.message} Pide la aprobación en la bandeja de aprobaciones.`;
    }
    return error.message || posErrorMessage(error, fallback);
  }
  return posErrorMessage(error, fallback);
}

function fixActionFor(checkId: string): { label: string; screen: ScreenKey } | null {
  switch (checkId) {
    case "arrivals_pending":
    case "unresolved_no_shows":
    case "open_folios_with_balance":
    case "departures_not_checked_out":
      return { label: "Abrir cola operativa", screen: "FrontDeskDashboard" };
    case "dirty_in_house_rooms":
      return { label: "Abrir tablero de habitaciones", screen: "RoomRackScreen" };
    case "unposted_room_charges":
      return { label: "Cargar ahora", screen: "FrontDeskDashboard" };
    case "invoices_pending":
      return { label: "Ver facturas", screen: "FiscalSubmissionsCenter" };
    default:
      return null;
  }
}

function StatusIcon({ status }: { status: Status }) {
  if (status === "blocker") return <XCircleIcon size={16} />;
  if (status === "warning") return <ExclamationCircleIcon size={16} />;
  return <CheckCircleIcon size={16} />;
}

// Text styles (colours and sizes from the tokens; layout from the utilities).
const detailStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-callout)",
  color: "var(--cocoa-label-secondary)"
};

const growStyle: CSSProperties = { flex: "1 1 auto", minWidth: 0 };

const RUN_COLUMNS: CocoaTableColumn<NightAuditRunWire>[] = [
  { key: "businessDate", label: "Fecha de negocio", render: (r) => <strong>{date(r.businessDate, "short")}</strong> },
  {
    key: "status",
    label: "Estado",
    render: (r) => (
      <CocoaBadge tone={runStatusTone(r.status)} size="small">
        {runStatusLabel(r.status)}
      </CocoaBadge>
    )
  },
  {
    key: "review",
    label: "Revisión",
    hideOnNarrow: true,
    render: (r) => {
      const state = runReviewState(r);
      return state === "not_applicable" ? (
        "—"
      ) : (
        <CocoaBadge tone={runReviewTone(state)} variant="tinted" size="small">
          {RUN_REVIEW_LABELS[state]}
        </CocoaBadge>
      );
    }
  },
  { key: "steps", label: "Pasos", align: "right", hideOnNarrow: true, render: (r) => number(r.stepResults?.length ?? 0) },
  {
    key: "warnings",
    label: "Avisos",
    align: "right",
    hideOnNarrow: true,
    render: (r) => (r.report ? (r.report.warnings.length > 0 ? <CocoaBadge tone="warning" variant="tinted" size="small">{number(r.report.warnings.length)}</CocoaBadge> : number(0)) : "—")
  },
  { key: "completedAt", label: "Completado", render: (r) => dateTime(r.completedAt) }
];

export function NightAuditScreen() {
  const propertyId = getActivePropertyId();
  const propertyName = getActiveProperty().propertyName;
  const { showToast } = useToast();
  const { data: preflight, loading: ploading, error: perror, refresh } = useApiData<PreflightData>(
    `/properties/${propertyId}/night-audit/preflight`,
    { pollIntervalMs: 30000 }
  );
  const { data: runsData, refresh: refreshRuns } = useApiData<NightAuditRunWire[]>(`/properties/${propertyId}/night-audit/runs`);

  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Forced close (Tanda L5 · L5-D): reason dialog over the blocked banner.
  const forceReasonId = useId();
  const [forceOpen, setForceOpen] = useState(false);
  const [forceReason, setForceReason] = useState("");

  // Report drawer: the selected run (list row or the run just executed) and
  // its fresh detail from GET …/runs/:runId.
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<NightAuditRunWire | null>(null);
  const [runLoading, setRunLoading] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  // T8a actions of the selected run (review / reopen): dialogs, busy flag and
  // the outcome notice painted inside the drawer.
  const reviewNoteId = useId();
  const reopenCodeId = useId();
  const reopenTextId = useId();
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewNote, setReviewNote] = useState("");
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenCode, setReopenCode] = useState<NightAuditReopenReasonCode>("missing_charge");
  const [reopenText, setReopenText] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [actionNotice, setActionNotice] = useState<{ tone: CocoaTone; text: string } | null>(null);

  const checks = toArray<Check>(preflight?.checks);
  const runs = toArray<NightAuditRunWire>(runsData);
  const shownRuns = runs.slice(0, MAX_RUNS);
  const state = !preflight ? (perror ? "error" : "loading") : "ready";
  const selectedRow = runs.find((r) => r.id === selectedRunId) ?? null;
  const shownRun = runDetail && runDetail.id === selectedRunId ? runDetail : selectedRow;
  const blockers = checks.filter((check) => check.status === "blocker");

  useEffect(() => {
    if (!selectedRunId) return;
    let cancelled = false;
    setRunLoading(true);
    setRunError(null);
    setActionNotice(null);
    void fetchNightAuditRun(selectedRunId, propertyId)
      .then((run) => {
        if (!cancelled) setRunDetail(run);
      })
      .catch((err: unknown) => {
        if (!cancelled) setRunError(posErrorMessage(err, "No se pudo cargar el informe del cierre."));
      })
      .finally(() => {
        if (!cancelled) setRunLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRunId, propertyId]);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Plain close (no argument) or forced close with the reason the dialog collected. */
  async function runAudit(forceReasonText?: string) {
    const forced = typeof forceReasonText === "string";
    if (!forced && !preflight?.canClose) return;
    setBusy(true);
    try {
      // Tanda UX-1 · U6 (F15): «Cerrar día» recomprueba el preflight AL PULSAR y
      // espera el resultado, en vez de fiarse del sondeo cacheado de 30 s: si
      // entre tanto apareció un bloqueo, no se cierra y se repinta la lista.
      if (!forced) {
        const fresh = await apiRequest<PreflightData>(`/properties/${propertyId}/night-audit/preflight`);
        if (!fresh.canClose) {
          showToast(fresh.blockingMessage ?? "Han aparecido bloqueos desde la última comprobación: revisa la lista antes de cerrar.", { variant: "warning" });
          refresh();
          return;
        }
      }
      const run = await runNightAudit(propertyId, forced ? { force: true, reasonText: forceReasonText } : undefined);
      const warnings = run.report?.warnings.length ?? 0;
      showToast(
        run.status === "failed"
          ? `El cierre del día ha fallado: ${run.errorMessage ?? "revisa el informe."}`
          : forced
            ? `Cierre del día ejecutado con bloqueos (motivo auditado)${warnings > 0 ? ` y ${plural(warnings, "aviso", "avisos")}` : ""}. Revisa el informe.`
            : warnings > 0
              ? `Cierre del día ejecutado con ${plural(warnings, "aviso", "avisos")}. Revisa el informe.`
              : "Cierre del día ejecutado. Día cerrado.",
        { variant: run.status === "failed" ? "error" : forced || warnings > 0 ? "warning" : "success" }
      );
      setForceOpen(false);
      setForceReason("");
      setRunDetail(run);
      setSelectedRunId(run.id);
    } catch (err) {
      showToast(posErrorMessage(err, "No se pudo ejecutar el cierre del día."), { variant: "error" });
    } finally {
      setBusy(false);
      refresh();
      refreshRuns();
    }
  }

  async function reviewRun() {
    if (!shownRun) return;
    setActionBusy(true);
    try {
      const updated = await reviewNightAuditRun(shownRun.id, reviewNote, propertyId);
      setRunDetail(updated);
      setReviewOpen(false);
      setReviewNote("");
      setActionNotice({ tone: "success", text: "Cierre marcado como revisado." });
      showToast("Cierre del día revisado.", { variant: "success" });
    } catch (err) {
      setActionNotice({ tone: "danger", text: actionErrorMessage(err, "No se pudo marcar el cierre como revisado.") });
      setReviewOpen(false);
    } finally {
      setActionBusy(false);
      refreshRuns();
    }
  }

  async function reopenRun() {
    if (!shownRun) return;
    setActionBusy(true);
    try {
      const reasonText = reopenText.trim();
      const updated = await reopenNightAuditRun(shownRun.id, { reasonCode: reopenCode, ...(reasonText ? { reasonText } : {}) }, propertyId);
      setRunDetail(updated);
      setReopenOpen(false);
      setReopenText("");
      // Corrector L5 (OP-04): el último día cerrado vuelve a ser la fecha de negocio
      // (se corrige y se vuelve a cerrar); un día anterior solo queda reabierto para revisión.
      setActionNotice({
        tone: "warning",
        text: updated.businessDateRewound
          ? `Día reabierto: la fecha de negocio vuelve al ${date(updated.businessDate, "short")}. No se revierte ningún cargo ni asiento: corrige lo necesario y vuelve a ejecutar el cierre.`
          : "Día reabierto. No es el último día cerrado, así que la fecha de negocio no retrocede: corrige con cargos o asientos fechados y márcalo como revisado cuando termines."
      });
      showToast("Día reabierto con motivo.", { variant: "warning" });
    } catch (err) {
      setActionNotice({ tone: "danger", text: actionErrorMessage(err, "No se pudo reabrir el día.") });
      setReopenOpen(false);
    } finally {
      setActionBusy(false);
      // La reapertura del último día cerrado retrocede la fecha de negocio: el preflight se relee.
      refresh();
      refreshRuns();
    }
  }

  const canClose = Boolean(preflight?.canClose);
  const canForce = canForceClose(sessionCan);
  const runActions = shownRun ? runActionsFor(shownRun, sessionCan) : { review: false, reopen: false };
  const reviewState = shownRun ? runReviewState(shownRun) : "not_applicable";

  return (
    <CocoaPage
      eyebrow={`Hoy · ${propertyName}`}
      title="Cierre del día"
      subtitle={`Comprobaciones guiadas antes de cerrar: si algo bloquea, te dice qué arreglar y dónde.${preflight?.businessDate ? ` Fecha de negocio actual: ${date(preflight.businessDate, "short")}.` : ""}`}
      actions={
        <>
          {ploading ? <CocoaBadge tone="info">{STATUS_LABELS.loading}</CocoaBadge> : null}
          {perror ? <CocoaBadge tone="danger">{perror}</CocoaBadge> : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh} aria-label={ACTIONS.refresh} title={ACTIONS.refresh}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      state={state}
      skeleton={<NightAuditSkeleton />}
      error={{ title: "No se pudo cargar el cierre del día", message: perror ?? undefined, onRetry: refresh }}
      commands={[{ id: "night-audit-refresh", label: "Actualizar el cierre del día", run: refresh }]}
    >
      {preflight ? (
        <>
          {/* Banner principal — audit 2026-06 · #10: while the first fetch has no
              data the page shows loading/error instead of a misleading red
              «no puedes cerrar» banner. With blockers the API refuses the plain
              close (409 NIGHT_AUDIT_PREFLIGHT_BLOCKED): the only way through is
              the forced close with a reason, offered to night_audit.run only. */}
          <CocoaCallout
            tone={canClose ? "success" : "danger"}
            icon={canClose ? <CheckCircleIcon size={20} /> : <XCircleIcon size={20} />}
            title={canClose ? "Puedes cerrar el día" : "No puedes cerrar todavía"}
            actions={
              canClose ? (
                <CocoaButton variant="filled" tone="accent" disabled={busy} loading={busy} onClick={() => void runAudit()} title="Ejecuta el cierre del día y avanza la fecha de negocio">
                  Cerrar día
                </CocoaButton>
              ) : canForce ? (
                <CocoaButton variant="bordered" tone="destructive" disabled={busy} loading={busy} onClick={() => setForceOpen(true)} title="Cierra el día pese a los bloqueos: el motivo queda auditado y en el informe">
                  Cerrar de todos modos
                </CocoaButton>
              ) : (
                <CocoaButton variant="filled" tone="accent" disabled title="Resuelve los bloqueos primero">
                  Cerrar día
                </CocoaButton>
              )
            }
          >
            {preflight.blockingMessage ?? "Todas las comprobaciones críticas están en verde. Ejecuta el cierre del día cuando estés listo."}
          </CocoaCallout>

          <CocoaKpiStrip min={200} stagger aria-label="Resumen de comprobaciones">
            <CocoaKpi label="Comprobaciones correctas" value={preflight.summary.ok} polarity="neutral" status="ok" />
            <CocoaKpi label="Avisos" value={preflight.summary.warning} polarity="neutral" status={preflight.summary.warning > 0 ? "warning" : "ok"} />
            <CocoaKpi label="Bloqueos" value={preflight.summary.blocker} polarity="neutral" status={preflight.summary.blocker > 0 ? "critical" : "ok"} />
          </CocoaKpiStrip>

          <CocoaSection title="Comprobaciones previas al cierre" meta={plural(checks.length, "comprobación", "comprobaciones")}>
            {checks.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin comprobaciones para la fecha de negocio actual." />
            ) : (
              <div className="cocoa-stack" data-gap="2" role="list" aria-label="Comprobaciones previas al cierre">
                {checks.map((check) => {
                  const tone = STATUS_TONE[check.status];
                  const items = check.items ?? [];
                  const isExpanded = expanded.has(check.id);
                  const fix = fixActionFor(check.id);
                  const itemsId = `night-audit-items-${check.id}`;
                  return (
                    <CocoaCallout
                      key={check.id}
                      tone={tone}
                      icon={<StatusIcon status={check.status} />}
                      title={check.title}
                      actions={
                        <CocoaBadge tone={tone} variant="tinted" size="small">
                          {STATUS_LABEL[check.status]} · {number(check.count)}
                        </CocoaBadge>
                      }
                    >
                      <span style={detailStyle}>{check.detail}</span>
                      {items.length > 0 || (fix && check.status !== "ok") ? (
                        <div className="cocoa-row" data-gap="2">
                          {items.length > 0 ? (
                            <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => toggle(check.id)} aria-expanded={isExpanded} aria-controls={itemsId}>
                              {isExpanded ? "Ocultar" : `Ver ${plural(items.length, "elemento", "elementos")}`}
                            </CocoaButton>
                          ) : null}
                          {fix && check.status !== "ok" ? (
                            <CocoaButton variant="tinted" tone="accent" size="small" onClick={() => navigateTo(fix.screen)}>
                              {fix.label}
                            </CocoaButton>
                          ) : null}
                        </div>
                      ) : null}
                      {isExpanded && items.length > 0 ? (
                        <ul id={itemsId} className="c22-section__list" aria-label={`Elementos afectados · ${check.title}`}>
                          {items.map((item) => (
                            <li key={item.ref}>
                              <div className="cocoa-row" data-gap="2" data-align="baseline" style={growStyle}>
                                <strong>{item.label}</strong>
                                {item.detail ? <span style={detailStyle}>{item.detail}</span> : null}
                              </div>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </CocoaCallout>
                  );
                })}
              </div>
            )}
          </CocoaSection>

          {shownRuns.length > 0 ? (
            <CocoaSection title="Historial de cierres" meta={`Últimos ${number(shownRuns.length)} · una fila abre su informe`} padding="none" style={{ overflow: "clip" }}>
              <CocoaTable
                columns={RUN_COLUMNS}
                rows={shownRuns}
                rowKey="id"
                selectedKey={selectedRunId ?? undefined}
                onSelect={(r) => setSelectedRunId(r.id)}
                rowTitle={() => "Abrir el informe del cierre"}
                caption="Historial de cierres"
                aria-label="Historial de cierres"
              />
            </CocoaSection>
          ) : (
            <CocoaSection title="Historial de cierres">
              <CocoaState kind="empty" inline title="Todavía no se ha ejecutado ningún cierre del día en esta propiedad." />
            </CocoaSection>
          )}
        </>
      ) : null}

      {/* Forced close: the blockers the runner is about to skip and the mandatory reason. */}
      <CocoaDialog
        open={forceOpen}
        onClose={() => {
          if (!busy) setForceOpen(false);
        }}
        title="Cerrar el día con bloqueos"
        description="El cierre se ejecutará aunque las comprobaciones bloqueen. El motivo queda en la auditoría (quién, cuándo, qué bloqueos) y en el informe del cierre."
        tone="destructive"
        size="md"
        confirmLabel="Cerrar de todos modos"
        busy={busy}
        confirmDisabled={forceReason.trim().length < FORCE_REASON_MIN}
        onConfirm={() => runAudit(forceReason.trim())}
        initialFocus={() => document.getElementById(forceReasonId)}
      >
        <div className="cocoa-stack" data-gap="3">
          {blockers.length > 0 ? (
            <ul className="c22-section__list" aria-label="Bloqueos que se van a saltar">
              {blockers.map((blocker) => (
                <li key={blocker.id}>
                  <span>{blockerLabel(blocker)}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <CocoaField label="Motivo" htmlFor={forceReasonId} required help={`Al menos ${FORCE_REASON_MIN} caracteres.`}>
            <CocoaInput id={forceReasonId} value={forceReason} onChange={setForceReason} multiline rows={3} maxLength={1000} placeholder="Por qué se cierra con bloqueos y quién lo ha acordado" disabled={busy} />
          </CocoaField>
        </div>
      </CocoaDialog>

      <CocoaDrawer
        open={selectedRunId !== null}
        onClose={() => setSelectedRunId(null)}
        title={shownRun ? `Informe del cierre · ${date(shownRun.businessDate, "short")}` : "Informe del cierre"}
        subtitle={shownRun ? `${runStatusLabel(shownRun.status)}${shownRun.completedAt ? ` · ${dateTime(shownRun.completedAt)}` : ""}` : undefined}
        side="right"
        size="lg"
        focusKey={shownRun?.id}
      >
        {runError && !shownRun ? (
          <CocoaState kind="error" title="No se pudo cargar el informe" message={runError} onRetry={() => setSelectedRunId((id) => id)} />
        ) : shownRun ? (
          <div className="cocoa-stack" data-gap="4">
            {actionNotice ? (
              <CocoaCallout tone={actionNotice.tone} role="status">
                {actionNotice.text}
              </CocoaCallout>
            ) : null}
            <CocoaSection
              title="Revisión y reapertura"
              meta={
                reviewState === "not_applicable" ? undefined : (
                  <CocoaBadge tone={runReviewTone(reviewState)} variant="tinted" size="small">
                    {RUN_REVIEW_LABELS[reviewState]}
                  </CocoaBadge>
                )
              }
              action={
                runActions.review || runActions.reopen ? (
                  <span className="cocoa-cluster">
                    {runActions.review ? (
                      <CocoaButton variant="tinted" tone="accent" size="small" disabled={actionBusy} onClick={() => setReviewOpen(true)} title="Revisión de ingresos de la mañana siguiente: la hace alguien distinto de quien ejecutó el cierre">
                        Marcar como revisado
                      </CocoaButton>
                    ) : null}
                    {runActions.reopen ? (
                      <CocoaButton variant="bordered" tone="destructive" size="small" disabled={actionBusy} onClick={() => setReopenOpen(true)} title="Reabre el día con un motivo; no se revierte nada">
                        Reabrir día
                      </CocoaButton>
                    ) : null}
                  </span>
                ) : undefined
              }
            >
              <ul className="c22-section__list" aria-label="Revisión y reapertura">
                <li>
                  <span>Ejecutado por</span>
                  <strong>{actorLabel(shownRun.startedBy)}</strong>
                </li>
                <li>
                  <span>Revisado</span>
                  <strong>{shownRun.reviewedByUserId ? `${actorLabel(shownRun.reviewedByUserId)} · ${dateTime(shownRun.reviewedAt ?? undefined)}` : "Pendiente"}</strong>
                </li>
                <li>
                  <span>Reabierto</span>
                  <strong>
                    {shownRun.reopenedByUserId
                      ? `${actorLabel(shownRun.reopenedByUserId)} · ${dateTime(shownRun.reopenedAt ?? undefined)} · ${reopenReasonLabel(shownRun.reopenReasonCode)}`
                      : "No"}
                  </strong>
                </li>
              </ul>
            </CocoaSection>
            <RunReport run={shownRun} loading={runLoading} error={runError} />
          </div>
        ) : runLoading ? (
          <CocoaSkeleton variant="card" height={320} />
        ) : null}
      </CocoaDrawer>

      {/* Income audit: optional note; the API refuses the runner (409 runner_ne_reviewer). */}
      <CocoaDialog
        open={reviewOpen}
        onClose={() => {
          if (!actionBusy) setReviewOpen(false);
        }}
        title="Marcar el cierre como revisado"
        description="Confirma la revisión de ingresos de este cierre. Quien lo ejecutó no puede revisarlo: el sistema lo rechaza."
        confirmLabel="Marcar como revisado"
        busy={actionBusy}
        onConfirm={reviewRun}
        initialFocus={() => document.getElementById(reviewNoteId)}
      >
        <CocoaField label="Nota" htmlFor={reviewNoteId} hint="opcional">
          <CocoaInput id={reviewNoteId} value={reviewNote} onChange={setReviewNote} multiline rows={3} maxLength={1000} placeholder="Observaciones de la revisión" disabled={actionBusy} />
        </CocoaField>
      </CocoaDialog>

      {/* Reopening: reason code of the API catalogue + text; > 7 days needs the day_reopen approval of another person. */}
      <CocoaDialog
        open={reopenOpen}
        onClose={() => {
          if (!actionBusy) setReopenOpen(false);
        }}
        title="Reabrir el día"
        description="El día vuelve a estado reabierto para la revisión. No se revierte ningún cargo, cobro ni asiento. Pasados 7 días desde la fecha de negocio hace falta la aprobación de otra persona."
        tone="destructive"
        size="md"
        confirmLabel="Reabrir día"
        busy={actionBusy}
        confirmDisabled={reopenCode === "other" && reopenText.trim().length === 0}
        onConfirm={reopenRun}
        initialFocus={() => document.getElementById(reopenCodeId)}
      >
        <div className="cocoa-stack" data-gap="3">
          <CocoaField label="Motivo" htmlFor={reopenCodeId} required>
            <CocoaSelect id={reopenCodeId} value={reopenCode} onChange={(value) => setReopenCode(value as NightAuditReopenReasonCode)} options={REOPEN_OPTIONS} disabled={actionBusy} />
          </CocoaField>
          <CocoaField label="Detalle" htmlFor={reopenTextId} hint={reopenCode === "other" ? undefined : "opcional"} required={reopenCode === "other"}>
            <CocoaInput id={reopenTextId} value={reopenText} onChange={setReopenText} multiline rows={3} maxLength={1000} placeholder="Qué hay que corregir en el día reabierto" disabled={actionBusy} />
          </CocoaField>
        </div>
      </CocoaDialog>
    </CocoaPage>
  );
}

// ── report of a run ──────────────────────────────────────────────────────────

function RunReport({ run, loading, error }: { run: NightAuditRunWire; loading: boolean; error: string | null }) {
  const report: NightAuditReportWire | null = run.report;
  const summary = report ? reportSummary(report) : null;
  const uncharged = unchargedReservations(report);
  const payments = labelledAmounts(report?.payments.byMethod, paymentMethodLabel);
  const revenue = labelledAmounts(report?.revenue.byType, revenueTypeLabel);
  const settled = settledFoliosSummary(report);
  const override = preflightOverrideSummary(report);
  return (
    <div className="cocoa-stack" data-gap="4">
      {error ? (
        <CocoaCallout tone="warning" role="status">
          {error} Se muestra la copia del historial.
        </CocoaCallout>
      ) : null}
      {loading ? <CocoaBadge tone="info">{STATUS_LABELS.loading}</CocoaBadge> : null}
      {run.status === "failed" ? (
        <CocoaCallout tone="danger" title="La corrida falló">
          {run.errorMessage ?? "Sin detalle del error. Puede volver a ejecutarse: los pasos son idempotentes."}
        </CocoaCallout>
      ) : null}

      {override ? (
        <CocoaCallout tone="danger" icon={<ExclamationCircleIcon size={16} />} title="Cierre forzado">
          <div className="cocoa-stack" data-gap="2">
            <span>Motivo: {override.reasonText}</span>
            {override.blockers.length > 0 ? (
              <ul className="c22-section__list" aria-label="Bloqueos saltados en el cierre forzado">
                {override.blockers.map((blocker) => (
                  <li key={blocker.id}>
                    <div className="cocoa-stack" data-gap="1">
                      <strong>{blockerLabel(blocker)}</strong>
                      <span className="cocoa-caption">{blocker.detail}</span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </CocoaCallout>
      ) : null}

      {summary && report ? (
        <>
          <CocoaKpiStrip min={200} aria-label="Cifras del cierre">
            <CocoaKpi label="Cargos de alojamiento" value={summary.posted} deltaLabel={`${money(summary.totalPosted)} cargados`} polarity="neutral" status={summary.withoutRate > 0 ? "warning" : "ok"} />
            <CocoaKpi label="Producción del día" value={money(summary.revenueTotal)} deltaLabel={plural(summary.revenueLines, "cargo", "cargos")} polarity="neutral" status="ok" />
            <CocoaKpi label="Cobros del día" value={money(summary.paymentsTotal)} deltaLabel={plural(summary.paymentsCount, "cobro", "cobros")} polarity="neutral" status="ok" />
            <CocoaKpi label="No-shows" value={summary.noShows} deltaLabel={summary.noShows > 0 ? `${money(summary.noShowsCharged)} de penalización` : "ninguno"} polarity="neutral" status="ok" />
          </CocoaKpiStrip>

          {report.warnings.length > 0 ? (
            <CocoaCallout tone="warning" icon={<ExclamationCircleIcon size={16} />} title={plural(report.warnings.length, "aviso", "avisos")}>
              <ul className="c22-section__list" aria-label="Avisos del cierre">
                {report.warnings.map((warning, index) => (
                  <li key={index}>
                    <span>{warning}</span>
                  </li>
                ))}
              </ul>
            </CocoaCallout>
          ) : null}
        </>
      ) : (
        <CocoaState kind="empty" inline title="Esta corrida no guardó informe (anterior a la contabilidad de la Tanda 6): solo se conservan sus pasos." />
      )}

      <CocoaSection title="Pasos de la corrida" meta={plural(run.stepResults.length, "paso", "pasos")}>
        {run.stepResults.length === 0 ? (
          <CocoaState kind="empty" inline title="Sin pasos registrados." />
        ) : (
          <ol className="c22-section__list" aria-label="Pasos de la corrida">
            {run.stepResults.map((step) => (
              <li key={step.step}>
                <div className="cocoa-stack" data-gap="1">
                  <strong>{stepLabel(step.step)}</strong>
                  {step.detail ? <span>{step.detail}</span> : null}
                </div>
                <CocoaBadge tone={stepTone(step.status)} variant="tinted" size="small">
                  {stepStatusLabel(step.status)}
                </CocoaBadge>
              </li>
            ))}
          </ol>
        )}
      </CocoaSection>

      {settled ? (
        <CocoaSection title="Folios liquidados" meta="Reservas canceladas, no presentadas o con salida hecha">
          <ul className="c22-section__list" aria-label="Folios liquidados">
            <li>
              <span>Cerrados en este cierre</span>
              <strong>{number(settled.closed)}</strong>
            </li>
            <li>
              <span>Abiertos con cargos sin facturar</span>
              <strong>{number(settled.pendingInvoice)}</strong>
            </li>
            <li>
              <span>Abiertos con saldo</span>
              <span className="cocoa-cluster">
                {settled.withBalance > 0 ? (
                  <CocoaBadge tone="warning" variant="tinted" size="small">
                    {number(settled.withBalance)}
                  </CocoaBadge>
                ) : (
                  <strong>{number(0)}</strong>
                )}
                {settled.withBalance > 0 ? <strong>{money(settled.totalWithBalance)}</strong> : null}
              </span>
            </li>
          </ul>
        </CocoaSection>
      ) : null}

      {uncharged.length > 0 ? (
        <CocoaSection title="Reservas sin cargo de alojamiento" meta={plural(uncharged.length, "reserva", "reservas")}>
          <ul className="c22-section__list" aria-label="Reservas sin cargo de alojamiento">
            {uncharged.map((item) => (
              <li key={item.reservationId}>
                <div className="cocoa-stack" data-gap="1">
                  <strong>{item.reservationCode}</strong>
                  <span>{item.detail ?? `Origen del precio: ${PRICE_SOURCE_LABELS[item.priceSource]}.`}</span>
                </div>
                <CocoaBadge tone={roomChargeOutcomeTone(item.outcome)} variant="tinted" size="small">
                  {ROOM_CHARGE_OUTCOME_LABELS[item.outcome]}
                </CocoaBadge>
              </li>
            ))}
          </ul>
        </CocoaSection>
      ) : null}

      {report ? (
        <>
          <CocoaSection title="Cobros por método" meta="Resumen, no conciliación: el arqueo es el recuento">
            {payments.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin cobros capturados ese día." />
            ) : (
              <ul className="c22-section__list" aria-label="Cobros por método">
                {payments.map((row) => (
                  <li key={row.key}>
                    <span>{row.label}</span>
                    <strong>{money(row.amount)}</strong>
                  </li>
                ))}
                <li>
                  <span>Total</span>
                  <strong>{money(report.payments.total)}</strong>
                </li>
              </ul>
            )}
          </CocoaSection>

          <CocoaSection title="Producción por concepto" meta={plural(report.revenue.lines, "cargo", "cargos")}>
            {revenue.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin cargos posteados ese día." />
            ) : (
              <ul className="c22-section__list" aria-label="Producción por concepto">
                {revenue.map((row) => (
                  <li key={row.key}>
                    <span>{row.label}</span>
                    <strong>{money(row.amount)}</strong>
                  </li>
                ))}
                <li>
                  <span>Total</span>
                  <strong>{money(report.revenue.total)}</strong>
                </li>
              </ul>
            )}
          </CocoaSection>

          <CocoaSection
            title="Cierres de caja del día"
            meta={report.cashClosures.length > 0 ? plural(report.cashClosures.length, "caja", "cajas") : undefined}
            action={
              <CocoaButton variant="plain" tone="accent" size="small" onClick={() => navigateTo("CashClosureScreen")}>
                Ir al cierre de caja
              </CocoaButton>
            }
          >
            {report.cashClosures.length === 0 ? (
              <CocoaState kind="empty" inline title="Ningún cierre de caja registrado para esa fecha de negocio." />
            ) : (
              <ul className="c22-section__list" aria-label="Cierres de caja del día">
                {report.cashClosures.map((closure) => (
                  <li key={closure.outletId}>
                    <span>{closureOutletLabel({ outletId: closure.outletId, outletName: null })}</span>
                    <span className="cocoa-cluster">
                      <CocoaBadge tone={closureStatusTone(closure.status)} size="small">
                        {closureStatusLabel(closure.status)}
                      </CocoaBadge>
                      {closure.difference !== null ? <strong>{differenceKind(closure.difference) === "balanced" ? "Cuadra" : money(closure.difference, { signDisplay: "exceptZero" })}</strong> : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CocoaSection>

          <ul className="c22-section__list" aria-label="Fechas de la corrida">
            <li>
              <span>Fecha de negocio cerrada</span>
              <strong>{date(report.businessDate, "medium")}</strong>
            </li>
            <li>
              <span>Nueva fecha de negocio</span>
              <strong>{date(report.nextBusinessDate, "medium")}</strong>
            </li>
            <li>
              <span>Reservas alojadas</span>
              <strong>{number(report.inHouseReservations)}</strong>
            </li>
          </ul>
        </>
      ) : null}
    </div>
  );
}

// Mirror skeleton: banner, three KPI tiles and the checklist card.
function NightAuditSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton variant="card" height={72} />
      <CocoaSkeleton.Strip count={3} min={200} />
      <CocoaSkeleton variant="card" height={320} />
    </div>
  );
}

export default NightAuditScreen;
