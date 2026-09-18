// Detalle de la reserva — Recepción › Reservas › Detalle (/recepcion/reservas/:id).
//
// Cocoa 22 · ola 3 · lote 3-A (workspace archetype, templates `Workspace` and
// `Detalle`): CocoaPage with the reservation code, its status badge and the
// inner views (Resumen · Folio · Actividad · Huéspedes · Documentos) as
// `tabs` → CocoaGrid 8/4: the view on the left, an aside with CocoaStat
// (total, saldo, cargos, cobrado) and the deep links on the right → every
// write through CocoaButton; cancel and no-show ask first in a CocoaDialog
// with `busy`; «Cobrar» / «Devolver» keep the Tanda 6 PaymentDialog /
// RefundDialog (enum method, clientRequestId per attempt, 202 → PSP, 409
// PSP_NOT_CONFIGURED). Same API calls as before. The id follows the URL
// (usePathname → reservationIdFromPathname); hosted inside ReservasTabs the
// container paints the title. The unused list workspace that lived in this
// file (no importer) was retired in this lot. fix:3-A qa#7: the meta of
// «Resumen» and the Huéspedes view name the primary guest the API joins in
// /reservations/:id, never its internal id.
//
// Tanda L3 · lote F1 (2026-09-18):
//   · «Cobrar» / «Devolver» also live in the «Importes» aside, visible from
//     the initial Resumen view → list row → «Cobrar» → confirm = 3 clicks
//     (decision §6.13; the ⌘K «Cobrar en RES-x» shortcut stays);
//   · «Añadir cargo» offers the manual charge types of the fiscal catalogue
//     (components/billing/charge-types) and an explicit «Categoría fiscal»
//     sent as `taxCategory` (POST /folios/:id/lines);
//   · cancel / no-show dialogs read GET /reservations/:id/cancellation-charge
//     (?mode=) when they open and show the penalty, the policy and the free
//     window; the reason is required; confirm sends `applyPolicy` (L3-B) and
//     the toast names the penalty posted and the folio outcome.

import { useEffect, useMemo, useState } from "react";
import { previewCancellationCharge, type ChargeBreakdown, type ChargeMode } from "../../services/cancellationApi";
import { financeErrorCode, financeErrorMessage } from "../../services/finance-contracts";
import { TAX_CATEGORY_LABELS, TAX_CATEGORY_OPTIONS, type TaxCategory } from "../../services/taxesApi";
import { chargeTypeLabel, defaultTaxCategoryForType, lifecycleOutcomeSummary, manualChargeTypeOptions, penaltyPreviewSummary, taxCategoryOptionsForType, type LifecycleOutcomeLike } from "../../components/billing/charge-types";
import { SupervisorPinDialog } from "../../components/SupervisorPinDialog";
import type { SupervisorAuthorizationDto } from "@hotelos/shared";
import { usePathname } from "../tabs/usePathname";
import { reservationIdFromPathname } from "./reservation-route";
import { guestFullName, reservationGuestLabel, type GuestNameParts } from "./reservation-guest-label";
import {
  assignReservationRoom,
  balanceDueConflict,
  cancelReservation,
  checkInReservation,
  checkOutReservation,
  fetchGuestActivity,
  fetchReservation,
  fetchReservationFolio,
  fetchRooms,
  noShowReservation,
  postFolioLine,
  type ActivityItem,
  type AdminReservation,
  type AdminRoom,
  type BalanceDueConflict,
  type FolioBalance,
  type GuestActivity
} from "../../services/pmsCommerceApi";
import { useToast } from "../../components/Toast";
import { useTabHost } from "../tabs/TabHost";
import { urlForScreen } from "../../navigation/nav-tree";
import { navigateTo } from "../../lib/navigate";
import { channelLabel, dateRange, dateTime, marketSegmentLabel, money, plural } from "../../lib/format";
import { ACTIONS, FIELD_LABELS } from "../../content/actions";
import { PaymentDialog } from "../../components/billing/PaymentDialog";
import { RefundDialog } from "../../components/billing/RefundDialog";
import { refundablePayments } from "../../components/billing/payment-flow";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDialog,
  CocoaField,
  CocoaFormRow,
  CocoaGrid,
  CocoaInput,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaSkeleton,
  CocoaSpan,
  CocoaStat,
  CocoaState,
  CocoaSwitch,
  CocoaTable,
  openTabPath,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

const STATUS_LABEL: Record<string, string> = {
  draft: "Borrador",
  confirmed: "Confirmada",
  checked_in: "Alojada",
  checked_out: "Salida",
  cancelled: "Cancelada",
  no_show: "No-show"
};

function statusTone(status: string): CocoaTone {
  switch (status) {
    case "confirmed":
      return "info";
    case "checked_in":
      return "success";
    case "cancelled":
    case "no_show":
      return "danger";
    case "draft":
      return "warning";
    default:
      return "neutral";
  }
}

// /reservations/:id joins the primary guest (firstName · surname1 · surname2);
// the shared list type does not declare it, so it is narrowed here.
type ReservationDetail = AdminReservation & { primaryGuest?: GuestNameParts | null };

function primaryGuestName(reservation: ReservationDetail): string | null {
  return guestFullName(reservation.primaryGuest);
}

function guestLabel(reservation: ReservationDetail): string {
  return reservationGuestLabel(reservation, primaryGuestName(reservation));
}

// «Añadir cargo»: the manual types of the fiscal catalogue, labelled like the
// folio column (components/billing/charge-types; every code is inferable by
// the API). The fiscal category is preselected from the type and editable.
const CHARGE_TYPE_OPTIONS = manualChargeTypeOptions();
const DEFAULT_CHARGE_TYPE = "minibar";

// Penalty preview of the cancel / no-show dialogs (GET /reservations/:id/cancellation-charge?mode=).
type PenaltyPreview = { loading: boolean; data: ChargeBreakdown | null; error: string | null };
const IDLE_PREVIEW: PenaltyPreview = { loading: false, data: null, error: null };

// POST /cancel · /no-show answer the record plus `cancellation` (L3-B); the
// shared client type only declares the record, so it is narrowed here.
type LifecycleResponse = AdminReservation & { cancellation?: LifecycleOutcomeLike };

function confirmMode(confirm: "cancel" | "noshow"): ChargeMode {
  return confirm === "noshow" ? "no_show" : "cancellation";
}

// Inner views of the reservation workspace. Routing is local (no URL
// segment) so deep-linking still lands on Resumen by default. Order follows a
// front-desk session: overview → billing → audit → travellers → paperwork.
type DetailTab = "summary" | "folio" | "activity" | "guests" | "documents";
const DETAIL_TABS: { key: DetailTab; label: string }[] = [
  { key: "summary", label: "Resumen" },
  { key: "folio", label: "Folio" },
  { key: "activity", label: "Actividad" },
  { key: "guests", label: "Huéspedes" },
  { key: "documents", label: "Documentos" }
];

// Activity item kinds → short Spanish label for the audit timeline.
const ACTIVITY_KIND_LABEL: Record<ActivityItem["kind"], string> = {
  message: "Mensaje",
  housekeeping: "Limpieza",
  maintenance: "Mantenimiento",
  service_request: "Petición"
};

type FolioLine = FolioBalance["lines"][number];

const ACTIVITY_COLUMNS: CocoaTableColumn<ActivityItem>[] = [
  { key: "at", label: "Cuándo", fit: true, render: (item) => dateTime(item.at, { style: "dayMonth" }) },
  { key: "actor", label: "Quién", fit: true, hideOnNarrow: true, render: (item) => item.channel ?? item.department ?? "sistema" },
  {
    key: "title",
    label: "Acción",
    minWidth: 200,
    render: (item) => (
      <span className="cocoa-cluster">
        <CocoaBadge tone="neutral" size="small">
          {ACTIVITY_KIND_LABEL[item.kind] ?? item.kind}
        </CocoaBadge>
        {item.title}
      </span>
    )
  },
  {
    key: "details",
    label: "Cambios",
    showFrom: "laptop",
    render: (item) =>
      [item.detail, item.status, item.priority]
        .filter((v) => v && String(v).trim().length > 0)
        .join(" · ") || "—"
  }
];

export function ReservationDetailWorkspaceScreen() {
  // The id comes from the URL and follows it (popstate, tab changes, shell
  // navigations) so ⌘K, the list row and a pasted deep link all land here.
  const pathname = usePathname();
  const reservationId = useMemo(() => reservationIdFromPathname(pathname), [pathname]);
  const hosted = useTabHost() !== null;
  const { showToast } = useToast();
  const [reservation, setReservation] = useState<ReservationDetail | null>(null);
  const [folio, setFolio] = useState<FolioBalance | null>(null);
  const [rooms, setRooms] = useState<AdminRoom[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState("");
  const [busy, setBusy] = useState(false);
  const [chargeType, setChargeType] = useState(DEFAULT_CHARGE_TYPE);
  const [chargeDesc, setChargeDesc] = useState(chargeTypeLabel(DEFAULT_CHARGE_TYPE));
  const [chargeAmount, setChargeAmount] = useState("12");
  const [chargeTaxCategory, setChargeTaxCategory] = useState<TaxCategory>(defaultTaxCategoryForType(DEFAULT_CHARGE_TYPE));
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const [confirm, setConfirm] = useState<"cancel" | "noshow" | null>(null);
  // Cancel / no-show dialog: required reason, whether the policy penalty is
  // applied (waiving it needs pms.reservation.discount on the API) and the preview.
  const [confirmReason, setConfirmReason] = useState("");
  const [applyPolicy, setApplyPolicy] = useState(true);
  const [preview, setPreview] = useState<PenaltyPreview>(IDLE_PREVIEW);
  // Corrector L3 (DS-02): waiving a penalty above the operative band answers
  // 409 APPROVAL_REQUIRED (discount engine of T8a). The dialog offers the
  // supervisor PIN (pms.reservation.override on this reservation) and resends
  // the same call with `supervisorAuthorizationId`; above the supervisor band
  // only an approved request lifts it (the API says so in the message).
  const [waiverApproval, setWaiverApproval] = useState<{ tier: string | null; message: string } | null>(null);
  const [waiverPinOpen, setWaiverPinOpen] = useState(false);
  const [waiverAuthorization, setWaiverAuthorization] = useState<SupervisorAuthorizationDto | null>(null);
  const [activeTab, setActiveTab] = useState<DetailTab>("summary");
  // Activity feed is fetched lazily on tab open to avoid pulling the audit log
  // when the user is just glancing at the summary.
  const [activity, setActivity] = useState<GuestActivity | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  // QC-06: a failed load is an error state with retry, never the "no
  // reservation selected" empty state.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [folioError, setFolioError] = useState<string | null>(null);
  // REC-08: pending balance reported by /check-out (409 BALANCE_DUE). The
  // operator must choose between collecting it and leaving with the balance.
  const [balancePrompt, setBalancePrompt] = useState<BalanceDueConflict | null>(null);

  async function reload() {
    if (!reservationId) {
      setReservation(null);
      setFolio(null);
      setActivity(null);
      setLoadError(null);
      return;
    }
    setLoadError(null);
    try {
      const res = await fetchReservation(reservationId);
      setReservation(res);
      setSelectedRoomId((current) => current || res.assignedRoomId || "");
      // Rooms feed the assignment select only; a failure leaves it empty and is
      // reported through the select placeholder rather than blocking the page.
      void fetchRooms(res.propertyId).then(setRooms).catch(() => setRooms([]));
    } catch (err) {
      setReservation(null);
      setLoadError(err instanceof Error ? err.message : "No se pudo cargar la reserva.");
    }
    void reloadFolio();
    // Invalidate the cached activity so a post-mutation reload (check-in, charge,
    // cancellation…) triggers a fresh fetch the next time the tab is opened.
    setActivity(null);
  }

  async function reloadFolio() {
    if (!reservationId) return;
    setFolioError(null);
    try {
      setFolio(await fetchReservationFolio(reservationId));
    } catch (err) {
      setFolio(null);
      setFolioError(err instanceof Error ? err.message : "No se pudo cargar el folio.");
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservationId]);

  function loadActivity() {
    if (!reservationId) return;
    setActivityLoading(true);
    setActivityError(null);
    fetchGuestActivity(reservationId)
      .then((data) => setActivity(data))
      .catch(() => setActivityError("No se pudo cargar la actividad. Inténtalo de nuevo."))
      .finally(() => setActivityLoading(false));
  }

  // Lazy-load the activity feed the first time the user opens the Actividad tab.
  useEffect(() => {
    if (activeTab !== "activity" || !reservationId) return;
    if (activity && activity.reservationId === reservationId) return;
    loadActivity();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, reservationId]);

  async function runAction(doneLabel: string, fn: () => Promise<unknown>) {
    setBusy(true);
    setBalancePrompt(null);
    try {
      await fn();
      await reload();
      showToast(doneLabel, { variant: "success" });
    } catch (error) {
      const conflict = balanceDueConflict(error);
      if (conflict) {
        // The API refused the check-out because the folio still has a balance.
        setBalancePrompt({ ...conflict, balanceDue: conflict.balanceDue ?? folio?.balanceDue ?? null });
        showToast(conflict.message, { variant: "warning" });
      } else {
        showToast(error instanceof Error ? error.message : "No se pudo completar la acción.", { variant: "error" });
      }
    } finally {
      setBusy(false);
    }
  }

  // Preview of the penalty when a cancel / no-show dialog opens (read only:
  // GET /reservations/:id/cancellation-charge). A closed dialog resets it.
  useEffect(() => {
    if (!confirm || !reservation) {
      setPreview(IDLE_PREVIEW);
      return;
    }
    setConfirmReason("");
    setApplyPolicy(true);
    setPreview({ loading: true, data: null, error: null });
    let stale = false;
    previewCancellationCharge(reservation.id, confirmMode(confirm))
      .then((data) => {
        if (!stale) setPreview({ loading: false, data, error: null });
      })
      .catch((error: unknown) => {
        if (!stale) setPreview({ loading: false, data: null, error: financeErrorMessage(error, "No se pudo calcular la penalización.") });
      });
    return () => {
      stale = true;
    };
    // The reservation id is what matters; the record object changes on every reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirm, reservation?.id]);

  /**
   * POST /reservations/:id/cancel · /no-show with `applyPolicy` (L3-B): the
   * API posts the penalty line, closes the folio at balance 0 and answers
   * `cancellation` (charge, folio status / balance), which the toast names.
   */
  /** Closes the cancel / no-show dialog and forgets any pending waiver authorisation (single use, bound to that attempt). */
  function closeLifecycleDialog() {
    setConfirm(null);
    setWaiverApproval(null);
    setWaiverAuthorization(null);
    setWaiverPinOpen(false);
  }

  async function handleLifecycle(kind: "cancel" | "noshow") {
    if (!reservation) return;
    const reason = confirmReason.trim();
    if (!reason) {
      showToast(kind === "cancel" ? "Indica el motivo de la cancelación." : "Indica el motivo del no-show.", { variant: "error" });
      return;
    }
    const mode = confirmMode(kind);
    setBusy(true);
    setBalancePrompt(null);
    try {
      const options = { applyPolicy, ...(waiverAuthorization ? { supervisorAuthorizationId: waiverAuthorization.id } : {}) };
      const request = kind === "cancel" ? cancelReservation(reservation.id, reason, options) : noShowReservation(reservation.id, reason, options);
      const result = (await request) as LifecycleResponse;
      closeLifecycleDialog();
      await reload();
      showToast(lifecycleOutcomeSummary(mode, result.cancellation ?? null, (amount) => money(amount, reservation.currency)), { variant: "success" });
    } catch (error) {
      if (!applyPolicy && financeErrorCode(error) === "APPROVAL_REQUIRED") {
        const details = (error as { details?: { tier?: unknown } }).details;
        setWaiverApproval({ tier: typeof details?.tier === "string" ? details.tier : null, message: financeErrorMessage(error, "La renuncia a la penalización necesita autorización.") });
        setWaiverAuthorization(null);
        showToast("La renuncia a la penalización supera tu tramo: pide la autorización de un supervisor.", { variant: "warning" });
      } else {
        showToast(financeErrorMessage(error, kind === "cancel" ? "No se pudo cancelar la reserva." : "No se pudo registrar el no-show."), { variant: "error" });
      }
    } finally {
      setBusy(false);
    }
  }

  const status = reservation?.status ?? "";
  const canAssign = status === "confirmed";
  const canCheckIn = status === "confirmed";
  const canCheckOut = status === "checked_in";
  const canCancel = status === "confirmed";
  const folioId = folio?.folio.id;
  const folioOpen = folio?.folio.status === "open";
  const currency = folio?.folio.currency ?? reservation?.currency;
  const lines = folio?.lines ?? [];
  const payments = folio?.payments ?? [];

  // Inner view options with live counts in the label.
  const tabOptions = useMemo(
    () =>
      DETAIL_TABS.map((tab) => {
        if (tab.key === "folio" && folio) return { value: tab.key, label: `${tab.label} (${folio.lines.length})` };
        if (tab.key === "activity" && activity) return { value: tab.key, label: `${tab.label} (${activity.items.length})` };
        if (tab.key === "guests" && reservation) return { value: tab.key, label: `${tab.label} (${(reservation.adults ?? 0) + (reservation.children ?? 0)})` };
        return { value: tab.key, label: tab.label };
      }),
    [folio, activity, reservation]
  );

  // Rooms for the assignment select — only sellable rooms, plus the currently
  // assigned room if any.
  const roomOptions = useMemo(() => {
    if (!reservation) return [];
    return rooms
      .filter((r) => r.sellable || r.id === reservation.assignedRoomId)
      .map((r) => ({ value: r.id, label: `${r.number} · ${r.housekeepingStatus ?? r.status}` }));
  }, [rooms, reservation]);

  const lineColumns = useMemo<CocoaTableColumn<FolioLine>[]>(
    () => [
      { key: "description", label: FIELD_LABELS.description, minWidth: 160, render: (line) => <strong>{line.description}</strong> },
      { key: "type", label: FIELD_LABELS.type, fit: true, hideOnNarrow: true, render: (line) => chargeTypeLabel(line.type) },
      {
        key: "taxCategory",
        label: "Categoría fiscal",
        fit: true,
        hideOnNarrow: true,
        render: (line) =>
          line.taxCategory && line.taxCategory in TAX_CATEGORY_LABELS ? (
            <CocoaBadge tone={line.taxCategory === "not_subject" ? "info" : "neutral"} size="small" uppercase={false}>
              {TAX_CATEGORY_LABELS[line.taxCategory as TaxCategory]}
            </CocoaBadge>
          ) : (
            "—"
          )
      },
      { key: "quantity", label: "Cantidad × precio", align: "right", hideOnNarrow: true, render: (line) => `${line.quantity} × ${money(line.unitPrice, currency)}` },
      { key: "total", label: FIELD_LABELS.total, align: "right", render: (line) => <strong>{money(line.total, currency)}</strong> }
    ],
    [currency]
  );

  const assignedRoomNumber = reservation ? (rooms.find((r) => r.id === reservation.assignedRoomId)?.number ?? (reservation.assignedRoomId ? reservation.assignedRoomId : null)) : null;

  function goToList() {
    navigateTo("ReservationWorkspace");
  }
  function openGuest(guestId: string) {
    openTabPath(urlForScreen("GuestDetail", { id: guestId }) ?? "/recepcion/huespedes");
  }
  function openJourney(id: string) {
    const url = urlForScreen("GuestJourneyWorkspace", { id });
    if (url) openTabPath(url);
  }

  /** Body of the cancel / no-show dialogs: penalty preview, required reason and the «apply penalty» switch. */
  function lifecycleFields(kind: "cancel" | "noshow") {
    const mode = confirmMode(kind);
    const amountText = (amount: number) => money(amount, reservation?.currency);
    const penalty = preview.data;
    const chargeable = Boolean(penalty && penalty.amount > 0 && !penalty.withinFreeWindow);
    return (
      <div className="cocoa-stack" data-gap="3">
        {preview.loading ? (
          <CocoaState kind="loading" inline title="Calculando la penalización prevista…" />
        ) : (
          <CocoaCallout
            tone={preview.error ? "warning" : chargeable && applyPolicy ? "warning" : "info"}
            title={penalty ? (penalty.policyName ? `Política «${penalty.policyName}»` : "Sin política de cancelación") : "Penalización no calculada"}
            role="status"
          >
            {preview.error ?? penaltyPreviewSummary(mode, penalty, amountText)}
            {penalty?.label ? ` ${penalty.label}` : ""}
            {penalty?.cutoffAt ? ` Plazo gratuito hasta ${dateTime(penalty.cutoffAt, { style: "medium" })}.` : ""}
          </CocoaCallout>
        )}
        <CocoaField label="Motivo" required help="Queda en la auditoría de la reserva.">
          <CocoaInput
            id={`reserva-${kind}-reason`}
            value={confirmReason}
            onChange={setConfirmReason}
            placeholder={kind === "cancel" ? "El huésped anula el viaje" : "No se ha presentado ni ha avisado"}
            maxLength={1000}
            disabled={busy}
            autoComplete="off"
          />
        </CocoaField>
        {chargeable ? (
          <CocoaField
            label="Aplicar la penalización prevista"
            inline
            help={
              applyPolicy
                ? `Se cargarán ${amountText(penalty!.amount)} al folio como línea no sujeta a IVA.`
                : "Renunciar es un descuento: hasta el tramo operativo basta la clave de descuento y el motivo; por encima hace falta la autorización de un supervisor (PIN) o una solicitud aprobada. Queda auditado."
            }
          >
            <CocoaSwitch
              checked={applyPolicy}
              onChange={(next) => {
                setApplyPolicy(next);
                setWaiverApproval(null);
                setWaiverAuthorization(null);
              }}
              size="small"
              disabled={busy}
            />
          </CocoaField>
        ) : null}
        {!applyPolicy && waiverApproval && !waiverAuthorization ? (
          <CocoaCallout
            tone="warning"
            title="Esta renuncia supera tu tramo"
            role="alert"
            actions={
              <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => setWaiverPinOpen(true)} disabled={busy}>
                Autorizar con PIN de supervisor
              </CocoaButton>
            }
          >
            {waiverApproval.message}
            {waiverApproval.tier ? ` Tramo: ${waiverApproval.tier}.` : ""} Un supervisor presente puede autorizar solo esta renuncia con su PIN hasta su tramo; por encima del tramo de supervisión solo vale una solicitud de descuento aprobada.
          </CocoaCallout>
        ) : null}
        {!applyPolicy && waiverAuthorization ? (
          <CocoaCallout tone="success" title="Autorización de supervisor concedida" role="status">
            Válida hasta {dateTime(waiverAuthorization.expiresAt, { style: "medium" })} y solo para esta reserva. Confirma para renunciar a la penalización.
          </CocoaCallout>
        ) : null}
      </div>
    );
  }

  const pageState = !reservationId ? "empty" : loadError && !reservation ? "error" : !reservation ? "loading" : "ready";
  const subtitle = reservation
    ? `${guestLabel(reservation)} · ${dateRange(reservation.arrivalDate, reservation.departureDate, { style: "dayMonth" })} · ${plural(reservation.adults, "adulto", "adultos")}`
    : "Resumen, folio, actividad y huéspedes de una reserva.";

  return (
    <CocoaPage
      eyebrow="Recepción · Reservas"
      title={reservation?.code ?? "Detalle de reserva"}
      subtitle={hosted ? undefined : subtitle}
      tabs={reservation ? tabOptions : undefined}
      activeTab={activeTab}
      onTabChange={(value) => setActiveTab(value as DetailTab)}
      actions={
        reservation ? (
          <>
            <CocoaBadge tone={statusTone(status)}>{STATUS_LABEL[status] ?? status}</CocoaBadge>
            <CocoaButton variant="plain" tone="neutral" size="small" onClick={goToList}>
              {ACTIONS.back} a reservas
            </CocoaButton>
          </>
        ) : undefined
      }
      state={pageState}
      skeleton={<CocoaSkeleton.Grid rows={[[8, 4]]} height={280} />}
      error={{ title: "No se pudo cargar la reserva", message: loadError ?? undefined, onRetry: () => void reload() }}
      empty={{
        title: "Esta dirección no lleva ninguna reserva",
        message: "Vuelve a la lista y abre una reserva para ver su detalle.",
        illustration: "search",
        primaryAction: { label: `${ACTIONS.back} a reservas`, onClick: goToList }
      }}
      commands={
        reservation
          ? [
              { id: "reserva-volver", label: "Volver a la lista de reservas", run: goToList },
              ...(folioId && folioOpen
                ? [
                    {
                      id: "reserva-cobrar",
                      label: `Cobrar en ${reservation.code}`,
                      run: () => {
                        setActiveTab("folio");
                        setPaymentOpen(true);
                      }
                    }
                  ]
                : [])
            ]
          : undefined
      }
    >
      {reservation ? (
        <CocoaGrid align="start" aria-label="Detalle de la reserva">
          <CocoaSpan cols={8} min={480}>
            {activeTab === "summary" ? (
              <div className="cocoa-stack" data-gap="3">
                <CocoaSection title="Resumen" meta={guestLabel(reservation)}>
                  <ul className="c22-section__list">
                    <li>
                      <span>Estancia</span>
                      <strong>{dateRange(reservation.arrivalDate, reservation.departureDate, { style: "dayMonth" })}</strong>
                    </li>
                    <li>
                      <span>Adultos / niños</span>
                      <strong>
                        {reservation.adults} / {reservation.children}
                      </strong>
                    </li>
                    <li>
                      <span>{FIELD_LABELS.channel}</span>
                      <strong title={[reservation.channel, reservation.sourceCode, reservation.marketSegment].filter(Boolean).join(" / ") || undefined}>
                        {[
                          channelLabel(reservation.channel, { empty: "" }),
                          channelLabel(reservation.sourceCode, { empty: "" }),
                          marketSegmentLabel(reservation.marketSegment, { empty: "" })
                        ]
                          .filter(Boolean)
                          .join(" / ") || "Directo"}
                      </strong>
                    </li>
                    <li>
                      <span>Habitación asignada</span>
                      <strong>{assignedRoomNumber ?? "Sin asignar"}</strong>
                    </li>
                    <li>
                      <span>Garantía</span>
                      <strong>{reservation.guaranteeType ?? "Sin definir"}</strong>
                    </li>
                    <li>
                      <span>{FIELD_LABELS.total}</span>
                      <strong>{money(reservation.totalAmount, reservation.currency)}</strong>
                    </li>
                  </ul>
                </CocoaSection>

                <CocoaSection title="Recepción" meta={STATUS_LABEL[status] ?? status}>
                  <CocoaFormRow columns={2} min={240}>
                    <CocoaField label={FIELD_LABELS.room} help={rooms.length === 0 ? "Sin habitaciones disponibles para asignar." : "Solo habitaciones vendibles, además de la asignada."}>
                      <CocoaSelect value={selectedRoomId} onChange={setSelectedRoomId} options={roomOptions} placeholder="Selecciona habitación…" disabled={busy} />
                    </CocoaField>
                  </CocoaFormRow>
                  <div className="cocoa-row" data-gap="2">
                    <CocoaButton
                      variant="tinted"
                      tone="accent"
                      disabled={busy || !canAssign || !selectedRoomId}
                      onClick={() => void runAction("Habitación asignada", () => assignReservationRoom(reservation.id, { roomId: selectedRoomId }))}
                    >
                      Asignar habitación
                    </CocoaButton>
                    <CocoaButton
                      variant="filled"
                      tone="accent"
                      disabled={busy || !canCheckIn || !selectedRoomId}
                      onClick={() => void runAction("Check-in registrado", () => checkInReservation(reservation.id, { roomId: selectedRoomId }))}
                    >
                      Check-in
                    </CocoaButton>
                    <CocoaButton
                      variant="filled"
                      tone="accent"
                      disabled={busy || !canCheckOut}
                      onClick={() => void runAction("Check-out registrado", () => checkOutReservation(reservation.id))}
                    >
                      Check-out
                    </CocoaButton>
                  </div>
                  {balancePrompt ? (
                    <CocoaCallout
                      tone="warning"
                      role="alert"
                      title={`Saldo pendiente${balancePrompt.balanceDue !== null ? `: ${money(balancePrompt.balanceDue, reservation.currency)}` : ""}`}
                      actions={
                        <>
                          <CocoaButton
                            variant="filled"
                            tone="accent"
                            size="small"
                            disabled={busy}
                            onClick={() => {
                              setBalancePrompt(null);
                              setActiveTab("folio");
                            }}
                          >
                            Ir a cobrar
                          </CocoaButton>
                          <CocoaButton
                            variant="bordered"
                            tone="destructive"
                            size="small"
                            disabled={busy}
                            onClick={() => void runAction("Check-out registrado con saldo pendiente", () => checkOutReservation(reservation.id, { acknowledgeBalance: true }))}
                          >
                            Salir con saldo pendiente
                          </CocoaButton>
                        </>
                      }
                    >
                      {balancePrompt.message} Cobra el saldo desde el folio o confirma la salida dejando el saldo pendiente.
                    </CocoaCallout>
                  ) : null}
                  <div className="cocoa-row" data-gap="2">
                    <CocoaButton variant="bordered" tone="destructive" disabled={busy || !canCancel} onClick={() => setConfirm("cancel")}>
                      Cancelar reserva
                    </CocoaButton>
                    <CocoaButton variant="bordered" tone="destructive" disabled={busy || !canCancel} onClick={() => setConfirm("noshow")}>
                      Marcar no-show
                    </CocoaButton>
                  </div>
                </CocoaSection>
              </div>
            ) : null}

            {activeTab === "folio" ? (
              <div className="cocoa-stack" data-gap="3">
                <CocoaSection
                  title="Cargos"
                  meta={folio ? plural(lines.length, "línea", "líneas") : undefined}
                  padding={folio && lines.length > 0 ? "none" : "md"}
                  style={{ overflow: "clip" }}
                  footer={folio && lines.length > 0 ? <span>Total cargos {money(folio.chargesTotal, currency)}</span> : undefined}
                >
                  {folio ? (
                    lines.length > 0 ? (
                      <CocoaTable columns={lineColumns} rows={lines} rowKey="id" caption="Cargos del folio" aria-label="Cargos del folio" />
                    ) : (
                      <CocoaState kind="empty" inline title="Sin cargos todavía." />
                    )
                  ) : folioError ? (
                    <CocoaState kind="error" title="No se pudo cargar el folio" message={folioError} onRetry={() => void reloadFolio()} />
                  ) : (
                    <CocoaTable columns={lineColumns} rows={[]} loading aria-label="Cargos del folio" />
                  )}
                </CocoaSection>

                {folio ? (
                  <>
                    <CocoaSection title="Añadir cargo" meta={folioOpen ? "folio abierto" : "folio cerrado"}>
                      <CocoaFormRow columns={4} min={150}>
                        <CocoaField label={FIELD_LABELS.type}>
                          <CocoaSelect
                            value={chargeType}
                            onChange={(v) => {
                              setChargeType(v);
                              // Keep a description the operator already edited; refresh the default one.
                              setChargeDesc((current) => (current.trim() === "" || current === chargeTypeLabel(chargeType) ? chargeTypeLabel(v) : current));
                              setChargeTaxCategory(defaultTaxCategoryForType(v));
                            }}
                            options={CHARGE_TYPE_OPTIONS}
                            disabled={busy}
                          />
                        </CocoaField>
                        <CocoaField label={FIELD_LABELS.description}>
                          <CocoaInput value={chargeDesc} onChange={setChargeDesc} maxLength={500} disabled={busy} />
                        </CocoaField>
                        <CocoaField label="Importe (€)" help="Precio bruto, con impuestos.">
                          <CocoaInput value={chargeAmount} onChange={setChargeAmount} type="number" inputMode="decimal" disabled={busy} />
                        </CocoaField>
                        <CocoaField label="Categoría fiscal" help="Determina el tipo de IVA al facturar; solo las categorías compatibles con el tipo de cargo.">
                          <CocoaSelect
                            value={chargeTaxCategory}
                            onChange={(v) => setChargeTaxCategory(v as TaxCategory)}
                            options={taxCategoryOptionsForType(chargeType, TAX_CATEGORY_OPTIONS).map((option) => ({ value: option.value, label: option.label }))}
                            disabled={busy}
                          />
                        </CocoaField>
                      </CocoaFormRow>
                      <div className="cocoa-row" data-gap="2">
                        <CocoaButton
                          variant="tinted"
                          tone="accent"
                          disabled={busy || !folioId || !folioOpen || !Number(chargeAmount)}
                          onClick={() =>
                            void runAction(`Cargo añadido al folio (${TAX_CATEGORY_LABELS[chargeTaxCategory]})`, () =>
                              postFolioLine(folioId!, {
                                type: chargeType,
                                description: chargeDesc.trim() || chargeTypeLabel(chargeType),
                                quantity: 1,
                                unitPrice: Number(chargeAmount),
                                taxCategory: chargeTaxCategory
                              })
                            )
                          }
                        >
                          Añadir cargo
                        </CocoaButton>
                      </div>
                    </CocoaSection>

                    <CocoaSection title="Cobros y devoluciones" meta={plural(payments.length, "movimiento", "movimientos")}>
                      <p>
                        {payments.length > 0
                          ? `${plural(payments.length, "movimiento", "movimientos")} · cobrado neto ${money(folio.paymentsTotal, currency)}`
                          : "Sin cobros registrados en el folio."}
                      </p>
                      <div className="cocoa-row" data-gap="2">
                        <CocoaButton variant="filled" tone="accent" disabled={busy || !folioId || !folioOpen} onClick={() => setPaymentOpen(true)}>
                          Cobrar
                        </CocoaButton>
                        <CocoaButton variant="bordered" tone="neutral" disabled={busy || refundablePayments(payments).length === 0} onClick={() => setRefundOpen(true)}>
                          Devolver un cobro
                        </CocoaButton>
                      </div>
                    </CocoaSection>
                  </>
                ) : null}
              </div>
            ) : null}

            {activeTab === "guests" ? (
              <CocoaSection title="Huéspedes" meta={plural((reservation.adults ?? 0) + (reservation.children ?? 0), "viajero", "viajeros")}>
                <ul className="c22-section__list">
                  <li>
                    <span>Titular</span>
                    <strong>{guestLabel(reservation)}</strong>
                  </li>
                  <li>
                    <span>Adultos</span>
                    <strong>{reservation.adults}</strong>
                  </li>
                  <li>
                    <span>Niños</span>
                    <strong>{reservation.children}</strong>
                  </li>
                  <li>
                    <span>Reserva a nombre de</span>
                    <strong>{reservation.bookerName ?? "Sin definir"}</strong>
                  </li>
                  <li>
                    <span>Huésped principal</span>
                    <strong>{primaryGuestName(reservation) ?? "Sin vincular"}</strong>
                  </li>
                  <li>
                    <span>Correo de contacto</span>
                    <strong>{reservation.bookerEmail ?? "Sin definir"}</strong>
                  </li>
                  <li>
                    <span>{FIELD_LABELS.room}</span>
                    <strong>{assignedRoomNumber ?? "Sin asignar"}</strong>
                  </li>
                </ul>
                <p>Los acompañantes y el parte de viajeros completo se gestionan en Cumplimiento › Registro de viajeros.</p>
                {reservation.primaryGuestId ? (
                  <div className="cocoa-row" data-gap="2">
                    <CocoaButton variant="bordered" tone="neutral" onClick={() => openGuest(reservation.primaryGuestId!)}>
                      Abrir ficha del huésped
                    </CocoaButton>
                  </div>
                ) : null}
              </CocoaSection>
            ) : null}

            {activeTab === "activity" ? (
              <CocoaSection
                title="Actividad"
                meta={activity ? plural(activity.items.length, "evento", "eventos") : "Auditoría"}
                padding={activity && activity.items.length > 0 ? "none" : "md"}
                style={{ overflow: "clip" }}
              >
                {activityLoading ? (
                  <CocoaTable columns={ACTIVITY_COLUMNS} rows={[]} loading aria-label="Actividad de la reserva" />
                ) : activityError ? (
                  <CocoaState kind="error" title="No se pudo cargar la actividad" message={activityError} onRetry={loadActivity} />
                ) : !activity || activity.items.length === 0 ? (
                  <CocoaState
                    kind="empty"
                    title="Sin actividad registrada"
                    message="Aún no hay eventos sobre esta reserva. Verás aquí la cronología en cuanto se produzca el primer cambio."
                  />
                ) : (
                  <CocoaTable
                    columns={ACTIVITY_COLUMNS}
                    rows={[...activity.items].sort((a, b) => (a.at > b.at ? -1 : a.at < b.at ? 1 : 0))}
                    rowKey="id"
                    caption="Actividad de la reserva"
                    aria-label="Actividad de la reserva"
                  />
                )}
              </CocoaSection>
            ) : null}

            {activeTab === "documents" ? (
              <CocoaSection title="Documentos">
                <CocoaState
                  kind="empty"
                  title="Sin documentos adjuntos"
                  message="Esta reserva no guarda documentos. El parte de viajeros se consulta en Cumplimiento › Registro de viajeros y las facturas en Finanzas › Facturación."
                />
              </CocoaSection>
            ) : null}
          </CocoaSpan>

          <CocoaSpan cols={4} min={240}>
            <div className="cocoa-stack" data-gap="3">
              <CocoaSection
                title="Importes"
                meta={folio ? (folioOpen ? "folio abierto" : "folio cerrado") : folioError ? "folio no disponible" : "cargando folio"}
                footer={
                  folio ? (
                    <div className="cocoa-row" data-gap="2">
                      <CocoaButton variant="filled" tone="accent" size="small" disabled={busy || !folioId || !folioOpen} title={folioOpen ? "Registrar un cobro en el folio" : "El folio está cerrado"} onClick={() => setPaymentOpen(true)}>
                        Cobrar
                      </CocoaButton>
                      <CocoaButton variant="bordered" tone="neutral" size="small" disabled={busy || refundablePayments(payments).length === 0} onClick={() => setRefundOpen(true)}>
                        Devolver
                      </CocoaButton>
                    </div>
                  ) : undefined
                }
              >
                <div className="cocoa-stack" data-gap="3">
                  <CocoaStat label="Total de la reserva" value={money(reservation.totalAmount, reservation.currency)} size="large" />
                  <CocoaStat
                    label="Saldo pendiente"
                    value={folio ? money(folio.balanceDue, currency) : "—"}
                    tone={folio ? (folio.balanceDue > 0 ? "warning" : folio.balanceDue < 0 ? "info" : "success") : undefined}
                    hint={folioError ?? undefined}
                  />
                  <CocoaStat label="Cargos" value={folio ? money(folio.chargesTotal, currency) : "—"} hint={folio ? plural(lines.length, "línea", "líneas") : undefined} />
                  <CocoaStat label="Cobrado neto" value={folio ? money(folio.paymentsTotal, currency) : "—"} hint={folio ? plural(payments.length, "movimiento", "movimientos") : undefined} />
                </div>
              </CocoaSection>

              <CocoaSection title="Ir a">
                <div className="cocoa-row" data-gap="2">
                  <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => openJourney(reservation.id)}>
                    Recorrido del huésped
                  </CocoaButton>
                  {reservation.primaryGuestId ? (
                    <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => openGuest(reservation.primaryGuestId!)}>
                      Ficha del huésped
                    </CocoaButton>
                  ) : null}
                  <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => navigateTo("BillingCenter")}>
                    Centro de facturación
                  </CocoaButton>
                </div>
              </CocoaSection>
            </div>
          </CocoaSpan>
        </CocoaGrid>
      ) : null}

      {reservation && folioId && folio ? (
        <>
          <PaymentDialog
            open={paymentOpen}
            onClose={() => setPaymentOpen(false)}
            folioId={folioId}
            propertyId={reservation.propertyId}
            currency={folio.folio.currency}
            balanceDue={folio.balanceDue}
            subject={`Reserva ${reservation.code}`}
            onCaptured={() => void reload()}
            onIntent={() => showToast("Intento de cobro creado: pendiente de la pasarela.", { variant: "info" })}
          />
          <RefundDialog open={refundOpen} onClose={() => setRefundOpen(false)} payments={folio.payments} currency={folio.folio.currency} onRefunded={() => void reload()} />
        </>
      ) : null}

      {reservation ? (
        <>
          <CocoaDialog
            open={confirm === "cancel"}
            onClose={closeLifecycleDialog}
            tone="destructive"
            title={`¿Cancelar la reserva ${reservation.code}?`}
            description="La reserva dejará de contar en la ocupación. La penalización prevista por su política se carga al folio como línea no sujeta a IVA y, si el saldo queda a cero, el folio se cierra."
            size="md"
            confirmLabel={busy ? "Cancelando…" : waiverAuthorization ? "Cancelar con autorización" : "Cancelar reserva"}
            cancelLabel="Mantener reserva"
            busy={busy}
            confirmDisabled={!confirmReason.trim() || preview.loading}
            initialFocus={() => document.getElementById("reserva-cancel-reason")}
            onConfirm={() => void handleLifecycle("cancel")}
          >
            {lifecycleFields("cancel")}
          </CocoaDialog>
          <CocoaDialog
            open={confirm === "noshow"}
            onClose={closeLifecycleDialog}
            tone="destructive"
            title={`¿Marcar ${reservation.code} como no-show?`}
            description="El huésped no se ha presentado: la reserva se cierra, la penalización de no-show prevista por su política se carga al folio y, si el saldo queda a cero, el folio se cierra."
            size="md"
            confirmLabel={busy ? "Registrando…" : waiverAuthorization ? "Marcar no-show con autorización" : "Marcar no-show"}
            cancelLabel="Mantener reserva"
            busy={busy}
            confirmDisabled={!confirmReason.trim() || preview.loading}
            initialFocus={() => document.getElementById("reserva-noshow-reason")}
            onConfirm={() => void handleLifecycle("noshow")}
          >
            {lifecycleFields("noshow")}
          </CocoaDialog>
          {confirm ? (
            <SupervisorPinDialog
              open={waiverPinOpen}
              onClose={() => setWaiverPinOpen(false)}
              permissionKey="pms.reservation.override"
              entityType="reservation"
              entityId={reservation.id}
              propertyId={reservation.propertyId}
              amount={preview.data && preview.data.amount > 0 ? preview.data.amount.toFixed(2) : undefined}
              actionLabel={`Renunciar a la penalización de ${preview.data ? money(preview.data.amount, reservation.currency) : "la reserva"} ${reservation.code}`}
              onAuthorized={(granted) => {
                setWaiverAuthorization(granted);
                setWaiverPinOpen(false);
                setWaiverApproval(null);
                showToast("Autorización de supervisor concedida: confirma la renuncia", { variant: "success" });
              }}
            />
          ) : null}
        </>
      ) : null}
    </CocoaPage>
  );
}
