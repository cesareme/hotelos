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

import { useEffect, useMemo, useState } from "react";
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

const CHARGE_TYPES = [
  { value: "minibar", label: "Minibar" },
  { value: "breakfast", label: "Desayuno" },
  { value: "parking", label: "Aparcamiento" },
  { value: "room", label: "Alojamiento" },
  { value: "adjustment", label: "Ajuste" }
];

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
  const [chargeType, setChargeType] = useState("minibar");
  const [chargeDesc, setChargeDesc] = useState("Minibar");
  const [chargeAmount, setChargeAmount] = useState("12");
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const [confirm, setConfirm] = useState<"cancel" | "noshow" | null>(null);
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
      { key: "type", label: FIELD_LABELS.type, fit: true, hideOnNarrow: true, render: (line) => CHARGE_TYPES.find((c) => c.value === line.type)?.label ?? line.type },
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
                      <CocoaFormRow columns={3} min={160}>
                        <CocoaField label={FIELD_LABELS.type}>
                          <CocoaSelect
                            value={chargeType}
                            onChange={(v) => {
                              setChargeType(v);
                              setChargeDesc(CHARGE_TYPES.find((c) => c.value === v)?.label ?? "");
                            }}
                            options={CHARGE_TYPES}
                            disabled={busy}
                          />
                        </CocoaField>
                        <CocoaField label={FIELD_LABELS.description}>
                          <CocoaInput value={chargeDesc} onChange={setChargeDesc} disabled={busy} />
                        </CocoaField>
                        <CocoaField label="Importe (€)">
                          <CocoaInput value={chargeAmount} onChange={setChargeAmount} type="number" inputMode="decimal" disabled={busy} />
                        </CocoaField>
                      </CocoaFormRow>
                      <div className="cocoa-row" data-gap="2">
                        <CocoaButton
                          variant="tinted"
                          tone="accent"
                          disabled={busy || !folioId || !folioOpen || !Number(chargeAmount)}
                          onClick={() =>
                            void runAction("Cargo añadido al folio", () =>
                              postFolioLine(folioId!, {
                                type: chargeType,
                                description: chargeDesc || chargeType,
                                quantity: 1,
                                unitPrice: Number(chargeAmount)
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
              <CocoaSection title="Importes" meta={folio ? (folioOpen ? "folio abierto" : "folio cerrado") : folioError ? "folio no disponible" : "cargando folio"}>
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
            onClose={() => setConfirm(null)}
            tone="destructive"
            title={`¿Cancelar la reserva ${reservation.code}?`}
            description="Se aplicará la política de cancelación y la reserva dejará de contar en la ocupación."
            confirmLabel="Cancelar reserva"
            cancelLabel="Mantener reserva"
            busy={busy}
            onConfirm={async () => {
              await runAction("Reserva cancelada", () => cancelReservation(reservation.id, "Front-desk cancellation"));
              setConfirm(null);
            }}
          />
          <CocoaDialog
            open={confirm === "noshow"}
            onClose={() => setConfirm(null)}
            tone="destructive"
            title={`¿Marcar ${reservation.code} como no-show?`}
            description="El huésped no se ha presentado: la reserva se cierra y se aplica la política de no-show."
            confirmLabel="Marcar no-show"
            cancelLabel="Mantener reserva"
            busy={busy}
            onConfirm={async () => {
              await runAction("No-show registrado", () => noShowReservation(reservation.id, "No-show at front desk"));
              setConfirm(null);
            }}
          />
        </>
      ) : null}
    </CocoaPage>
  );
}
