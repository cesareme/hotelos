// Quick Check-out Drawer — flujo guiado de ≤ 60 segundos en una sola pantalla.
//
// Directriz ehotelOS:
//   Para check-out — Abrir folio, validar cargos, detectar pagos pendientes,
//   dividir cuenta si hace falta, cobrar, emitir factura, cambiar habitación a
//   salida/sucia, notificar housekeeping, enviar despedida o solicitud de reseña.
//
// Implementación: 3 secciones en 1 vista
//   1. Folio (líneas + total + saldo)
//   2. Cobro (capture si hay saldo, método)
//   3. Salida y factura (a quién se factura; la habitación pasa a sucia en el servidor)
// CTA único que dice lo que hará («Cobrar 120,00 € y cerrar» / «Hacer check-out»):
//   - POST /folios/:id/payments (si saldo > 0 y no se eligió "Sin cobro")
//   - POST /reservations/:id/check-out (cierra folio + crea tarea HK + libera room)
//   - POST /folios/:id/invoice (BORRADOR, como hasta ahora: lo emite Facturación)
//     y, solo si el recepcionista marca «Emitir ahora con número», POST
//     /invoices/:id/issue ESPERANDO la respuesta: el toast lleva el número real
//
// Tanda 2 · REC-08 / QC-06:
//   - El folio ya NO se traga a null: si no carga, error visible con reintento y
//     la opción explícita "Sin cobro" (el saldo se muestra como no disponible,
//     nunca como 0,00 € "Saldado").
//   - Si el API responde 409 BALANCE_DUE, el drawer muestra el saldo y ofrece
//     "Cobrar" o "Salir con saldo pendiente" (reintento con acknowledgeBalance).
//
// Tanda L3 · lote F2 (quick check-out): cuerpo del cobro por el módulo puro
// `quickCheckoutPayment.ts` con exactamente las claves de `ApplyPaymentSchema`
// (nunca `status`); `card` → card_terminal; un 202 payment_intent aborta;
// una `clientRequestId` por intento reutilizada en los reintientos del mismo cobro.
//
// Tanda UX-1 · lote U6 (docs/design/UX-RECEPCION-FEEL.md §5.4, F5, F14 parcial,
// D6, §6.2): reserva ∥ folio ∥ rooms desde la caché compartida (1 ronda; abre
// con datos si la fila hizo prefetch); esqueleto espejo tras 300 ms; el cuerpo
// es un `<form>` (Intro confirma); el switch «Avisar a housekeeping» se retira
// (no viajaba en ninguna petición y el servidor ya ensucia la habitación en
// cada check-out: pms.service.ts applyRoomTransition check_out) y queda la
// frase «La habitación pasará a sucia.»; «Factura a: Huésped / Empresa [NIF]
// [Razón social]» recordados de la reserva (WCAG 3.3.7) → `customerType` /
// `customerName` / `customerTaxId` (folios.schemas.ts IssueInvoiceSchema);
// la factura se ESPERA: por defecto queda en borrador («Borrador de factura
// creado: emítela desde Facturación», que es lo que POST /folios/:id/invoice
// hace); con «Emitir ahora con número» se emite (irreversible: hash VeriFactu)
// y el toast dice «Factura FAC-… emitida» con el número real;
// dos etiquetas de CTA; cierre inmediato al éxito; el estado de la reserva se
// pinta con el diccionario (CocoaStatusBadge), nunca el enum crudo.

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { useToast } from "../../components/Toast";
import { apiRequest } from "../../services/api-client";
import { getActivePropertyId } from "../../services/activeProperty";
import { invalidateApi, useApiData } from "../../hooks/useApiData";
import { balanceDueConflict, postFolioPayment, type AdminReservation, type BalanceDueConflict, type InvoiceDraft } from "../../services/pmsCommerceApi";
import { newClientRequestId } from "../../services/finance-contracts";
import {
  QUICK_CHECKOUT_METHOD_OPTIONS,
  assertQuickCheckoutPaymentCaptured,
  buildQuickCheckoutPaymentBody,
  resolveQuickCheckoutAttempt,
  type QuickCheckoutMethodOption,
  type QuickCheckoutPaymentAttempt
} from "./quickCheckoutPayment";
import { logBreadcrumb } from "../../lib/breadcrumb";
import { reservationStatusLabel } from "./frontdesk-labels";
import { reservationStatus } from "../../content/status-dictionary";
import { DEFAULT_CURRENCY, money, plural } from "../../lib/format";
import { ACTIONS, FRONT_DESK_ACTIONS, FRONT_DESK_NOTES, FRONT_DESK_TOASTS, STATUS_LABELS } from "../../content/actions";
import { ClockIcon } from "../../components/cocoa-icons/StatusIcons";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDrawer,
  CocoaField,
  CocoaInput,
  CocoaSection,
  CocoaSegmentedControl,
  CocoaSelect,
  CocoaSkeleton,
  CocoaState,
  CocoaStatusBadge,
  CocoaSwitch,
  CocoaTable,
  toneInk,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

type Reservation = {
  id: string;
  propertyId: string;
  code?: string;
  status: string;
  arrivalDate: string;
  departureDate: string;
  totalAmount: number;
  currency: string;
  assignedRoomId?: string;
  /** Instrucción de facturación y empresa recordadas de la reserva (3.3.7). */
  billingInstruction?: string | null;
  companyName?: string | null;
  primaryGuest?: Guest | null;
};

type Guest = { id: string; firstName: string; surname1?: string; surname2?: string; company?: string | null; documentNumber?: string | null };

type FolioLine = { id: string; type: string; description: string; quantity: number; unitPrice: number; total: number };

type FolioBalance = {
  folio: { id: string; status: string; currency: string };
  lines: Array<FolioLine>;
  payments: Array<{ id: string; amount: number; method: string; status: string }>;
  chargesTotal: number;
  paymentsTotal: number;
  balanceDue: number;
};

type Room = { id: string; number: string; floor?: string; housekeepingStatus?: string };

export type InvoiceCustomerType = "guest" | "company";

/** Qué pasa con la factura al cerrar: borrador (Facturación la emite), emitida ahora (irreversible) o ninguna. */
export type InvoiceMode = "draft" | "issue" | "none";

export type QuickCheckOutCompleted = {
  reservationId: string;
  elapsedSeconds: number;
  /** Reserva que devuelve POST check-out (`checked_out`): para reconciliar la fila sin recargar. */
  reservation: AdminReservation | null;
  roomNumber: string | null;
  invoiceNumber: string | null;
};

export type QuickCheckOutProps = {
  reservationId: string;
  onClose: () => void;
  onCompleted?: (info: QuickCheckOutCompleted) => void;
};

// Payment method options (and the `card` → card_terminal normalisation) live in
// quickCheckoutPayment.ts: only methods the API captures in the same call.
const PAYMENT_METHOD_OPTIONS = QUICK_CHECKOUT_METHOD_OPTIONS;
const CATALOG_STALE_MS = 5 * 60_000;
const RESERVATION_STALE_MS = 30_000;

function fmtEur(value: number | undefined | null): string {
  return money(value);
}

function fmtName(g: Guest | null | undefined): string {
  if (!g) return "Huésped";
  return [g.firstName, g.surname1, g.surname2].filter(Boolean).join(" ").trim() || "Huésped";
}

function elapsedText(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** «Factura a» por defecto: empresa si la reserva se factura a empresa (recordado, WCAG 3.3.7); si no, huésped. */
export function defaultInvoiceCustomer(reservation: Pick<Reservation, "billingInstruction" | "companyName"> | null | undefined): { customerType: InvoiceCustomerType; customerName: string } {
  const toCompany = reservation?.billingInstruction === "company_invoice" || Boolean(reservation?.companyName);
  return { customerType: toCompany ? "company" : "guest", customerName: toCompany ? (reservation?.companyName ?? "") : "" };
}

/** Cuerpo de POST /folios/:id/invoice (IssueInvoiceSchema strict): solo las claves con valor. */
export function buildInvoiceBody(input: { customerType: InvoiceCustomerType; customerName: string; customerTaxId: string }): { customerType: InvoiceCustomerType; customerName?: string; customerTaxId?: string } {
  const body: { customerType: InvoiceCustomerType; customerName?: string; customerTaxId?: string } = { customerType: input.customerType };
  if (input.customerType === "company") {
    const name = input.customerName.trim();
    const taxId = input.customerTaxId.trim();
    if (name) body.customerName = name;
    if (taxId) body.customerTaxId = taxId;
  }
  return body;
}

const nameStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-headline)",
  fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"],
  color: "var(--cocoa-label)"
};

/** Balance figure (13 px): AA tone ink — danger while something is owed, success when settled. */
function balanceStyle(hasBalance: boolean): CSSProperties {
  return { color: hasBalance ? toneInk("danger") : toneInk("success") };
}

// Columns declared outside the component (rule A5); the type/quantity caption goes under the description.
const FOLIO_COLUMNS: CocoaTableColumn<FolioLine>[] = [
  {
    key: "description",
    label: "Concepto",
    render: (line) => (
      <div className="cocoa-stack" data-gap="1">
        <span>{line.description}</span>
        <span className="cocoa-note">
          {line.type}
          {line.quantity > 1 ? ` · ${line.quantity}x` : ""}
        </span>
      </div>
    )
  },
  { key: "total", label: "Importe", align: "right", width: "12ch", render: (line) => fmtEur(line.total) }
];

// Mirror skeleton of the three steps (§5.4 (5)).
function CheckOutSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton variant="card" height={56} />
      <CocoaSkeleton variant="card" height={160} />
      <CocoaSkeleton variant="card" height={96} />
      <CocoaSkeleton variant="card" height={96} />
    </div>
  );
}

export function QuickCheckOutDrawer({ reservationId, onClose, onCompleted }: QuickCheckOutProps) {
  const { showToast } = useToast();
  const formId = useId();
  const submitId = useId();
  const taxIdFieldId = useId();
  const activePropertyId = getActivePropertyId();

  // One round: reservation ∥ folio ∥ rooms from the shared cache (prefetched by the row of Mi día).
  const reservationState = useApiData<Reservation>(`/reservations/${reservationId}`, { staleTime: RESERVATION_STALE_MS });
  const folioState = useApiData<FolioBalance>(`/reservations/${reservationId}/folio`, { staleTime: RESERVATION_STALE_MS });
  const reservation = reservationState.data;
  const propertyId = reservation?.propertyId ?? activePropertyId;
  const roomsState = useApiData<Room[]>(`/properties/${propertyId}/rooms`, { staleTime: CATALOG_STALE_MS });
  const guest = reservation?.primaryGuest ?? null;
  const folio = folioState.data;
  const folioError = folioState.error;
  const folioLoading = folioState.loading || (folioState.isValidating && !folio);
  const room = useMemo(() => (reservation?.assignedRoomId ? roomsState.data?.find((r) => r.id === reservation.assignedRoomId) ?? null : null), [reservation, roomsState.data]);

  const [paymentMethod, setPaymentMethod] = useState<QuickCheckoutMethodOption>("card");
  // Idempotency key of the current payment attempt (L3-F2): kept across
  // renders so a retry of the same payment replays instead of charging twice.
  const paymentAttempt = useRef<QuickCheckoutPaymentAttempt | null>(null);
  // Explicit operator choice to leave without collecting (required when the
  // folio could not be loaded; optional otherwise).
  const [skipPayment, setSkipPayment] = useState(false);
  const [invoiceMode, setInvoiceMode] = useState<InvoiceMode>("draft");
  const issueInvoice = invoiceMode !== "none";
  // «Factura a»: recordado de la reserva (3.3.7) la primera vez que llega.
  const [customerType, setCustomerType] = useState<InvoiceCustomerType>("guest");
  const [customerName, setCustomerName] = useState("");
  const [customerTaxId, setCustomerTaxId] = useState("");
  const customerInitialised = useRef(false);
  useEffect(() => {
    if (customerInitialised.current || !reservation) return;
    customerInitialised.current = true;
    const defaults = defaultInvoiceCustomer(reservation);
    setCustomerType(defaults.customerType);
    setCustomerName(defaults.customerName);
  }, [reservation]);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState<{ elapsedSeconds: number; invoiceNumber: string | null } | null>(null);
  // 409 BALANCE_DUE returned by /check-out: the operator must decide.
  const [balancePrompt, setBalancePrompt] = useState<BalanceDueConflict | null>(null);

  const [tick, setTick] = useState(0);
  const startedAt = useMemo(() => Date.now(), []);
  useEffect(() => {
    logBreadcrumb("checkout.opened", "ui", { reservationId });
    // El efecto se ejecuta una sola vez al montar; reservationId es estable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (completed) return;
    const t = window.setInterval(() => setTick((x) => x + 1), 1000);
    return () => window.clearInterval(t);
  }, [completed]);
  void tick;
  const elapsedSeconds = completed ? completed.elapsedSeconds : Math.floor((Date.now() - startedAt) / 1000);
  const elapsedLabel = elapsedText(elapsedSeconds);
  const timerTone: CocoaTone = elapsedSeconds < 60 ? "success" : elapsedSeconds < 90 ? "warning" : "danger";

  // null = unknown (folio not loaded); never fall back to 0.
  const balanceDue: number | null = folio ? folio.balanceDue : null;
  const hasBalance = balanceDue !== null && balanceDue > 0.01;
  const willCollect = hasBalance && !skipPayment;
  const companyInvoiceIncomplete = issueInvoice && customerType === "company" && (!customerName.trim() || !customerTaxId.trim());
  const canSubmit = Boolean(reservation && reservation.status === "checked_in" && (folio || skipPayment) && !companyInvoiceIncomplete);
  const blockingReason = !reservation
    ? ""
    : reservation.status !== "checked_in"
      ? `Reserva en estado «${reservationStatusLabel(reservation.status)}»: el check-out solo procede con la reserva en el hotel.`
      : !folio && !skipPayment
        ? "No se pudo cargar el folio: reintenta o elige «Sin cobro» de forma explícita."
        : companyInvoiceIncomplete
          ? "Para facturar a una empresa hacen falta la razón social y el NIF."
          : "";

  // `collectAmount` overrides the derived decision (used by the 409 prompt so
  // the retry does not depend on state updates that have not rendered yet):
  // a positive number collects that amount first; null skips the payment.
  async function executeCheckOut(options: { acknowledgeBalance?: boolean; collectAmount?: number | null } = {}) {
    if (!reservation) return;
    if (!folio && !skipPayment) return;
    const amountToCollect = options.collectAmount !== undefined ? options.collectAmount : willCollect ? balanceDue : null;
    const collecting = Boolean(folio) && amountToCollect !== null && amountToCollect > 0.01 && !options.acknowledgeBalance;
    setBusy(true);
    setError(null);
    setBalancePrompt(null);
    logBreadcrumb("checkout.submitted", "mutation", {
      reservationId: reservation.id,
      balanceDue,
      skipPayment,
      acknowledgeBalance: Boolean(options.acknowledgeBalance),
      invoiceMode,
      customerType,
      paymentMethod: collecting ? paymentMethod : undefined
    });
    try {
      // 1) Cobrar saldo si > 0 y no se eligió "Sin cobro". Un fallo de cobro
      //    ABORTA el check-out con error visible; el folio sigue abierto.
      if (folio && collecting && amountToCollect !== null) {
        try {
          // L3-F2: body with exactly the keys ApplyPaymentSchema (strict)
          // accepts — never `status` (the API decides it). Same
          // clientRequestId while the payment is the same (retries replay).
          const currency = reservation.currency || DEFAULT_CURRENCY;
          const attempt = resolveQuickCheckoutAttempt(paymentAttempt.current, { folioId: folio.folio.id, amount: amountToCollect, currency, method: paymentMethod }, newClientRequestId);
          paymentAttempt.current = attempt;
          const result = await postFolioPayment(folio.folio.id, buildQuickCheckoutPaymentBody({ amount: amountToCollect, currency, method: paymentMethod, clientRequestId: attempt.clientRequestId }));
          // 202 payment_intent (PSP) or a non-captured row: nothing is cobrado.
          assertQuickCheckoutPaymentCaptured(result);
        } catch (err) {
          throw new Error(`No se pudo registrar el cobro del saldo (${err instanceof Error ? err.message : "error"}). El check-out NO se ha realizado; el folio sigue abierto.`);
        }
      }
      // 2) Check-out (el endpoint cierra el folio + crea tarea departure HK y
      //    deja la habitación libre y sucia). Con saldo pendiente responde 409
      //    BALANCE_DUE salvo acknowledgeBalance.
      const checkedOut = await apiRequest<{ reservation?: AdminReservation } | null>(`/reservations/${reservation.id}/check-out`, {
        method: "POST",
        body: { acknowledgeBalance: options.acknowledgeBalance }
      });
      const reservationAfter = checkedOut && typeof checkedOut === "object" && checkedOut.reservation ? checkedOut.reservation : null;
      // 3) Factura: se ESPERA la respuesta (P7). POST /folios/:id/invoice crea el
      //    BORRADOR (sin número); «Emitir ahora» lo emite y el toast lleva el número real.
      let invoiceNumber: string | null = null;
      let invoiceDrafted = false;
      let invoiceFailed = false;
      if (issueInvoice) {
        if (folio) {
          try {
            const draft = await apiRequest<InvoiceDraft>(`/folios/${folio.folio.id}/invoice`, { method: "POST", body: buildInvoiceBody({ customerType, customerName, customerTaxId }) });
            invoiceDrafted = true;
            if (invoiceMode === "issue") {
              const issued = await apiRequest<InvoiceDraft>(`/invoices/${draft.id}/issue`, { method: "POST", body: {} });
              invoiceNumber = issued?.invoiceNumber ?? null;
              if (!invoiceNumber) invoiceFailed = true;
            }
          } catch {
            invoiceFailed = true;
          }
        } else {
          invoiceFailed = true;
        }
      }
      invalidateApi(`/reservations/${reservation.id}`);
      invalidateApi(`/properties/${reservation.propertyId}/rooms`);
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      const roomNumber = room?.number ?? null;
      setCompleted({ elapsedSeconds: elapsed, invoiceNumber });
      onCompleted?.({ reservationId: reservation.id, elapsedSeconds: elapsed, reservation: reservationAfter, roomNumber, invoiceNumber });
      showToast(FRONT_DESK_TOASTS.checkOutDone(roomNumber), { variant: "success" });
      if (invoiceNumber) showToast(FRONT_DESK_TOASTS.invoiceIssued(invoiceNumber), { variant: "success", duration: 8000 });
      else if (invoiceFailed) showToast(folio ? FRONT_DESK_TOASTS.invoiceFailed : "Check-out hecho sin folio cargado: emite la factura desde Facturación.", { variant: folio ? "error" : "info", duration: 9000 });
      else if (invoiceDrafted) showToast(FRONT_DESK_TOASTS.invoiceDrafted, { variant: "info", duration: 6000 });
      // Cierre inmediato (§5.4 (5)): los toasts dicen qué pasó.
      onClose();
    } catch (err) {
      const conflict = balanceDueConflict(err);
      if (conflict) {
        // The API refused: show the balance and let the operator decide.
        setBalancePrompt({ ...conflict, balanceDue: conflict.balanceDue ?? balanceDue });
        logBreadcrumb("checkout.balanceDue", "ui", { reservationId: reservation.id, balanceDue: conflict.balanceDue ?? balanceDue });
        return;
      }
      const message = err instanceof Error ? err.message : "Error ejecutando check-out";
      setError(message);
      showToast(message, { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || busy || balancePrompt) return;
    void executeCheckOut();
  }

  // Dos etiquetas (§5.4 (4)): «Cobrar X € y cerrar» cuando se cobra; «Hacer check-out» en el resto.
  const ctaLabel = willCollect ? FRONT_DESK_ACTIONS.collectAndClose(fmtEur(balanceDue)) : FRONT_DESK_ACTIONS.checkOut;
  const loadingReservation = !reservation && (reservationState.loading || reservationState.isValidating);

  let body: ReactNode;
  if (!reservation) {
    body = <CocoaState kind="error" title={STATUS_LABELS.loadError} message={reservationState.error ?? "No se encontró la reserva."} onRetry={reservationState.refresh} />;
  } else if (completed) {
    body = <CompletedView elapsed={elapsedLabel} roomNumber={room?.number} invoiceNumber={completed.invoiceNumber} />;
  } else {
    body = (
      <form id={formId} onSubmit={onSubmit} className="cocoa-stack" data-gap="3" aria-label="Check-out rápido">
        {error ? (
          <CocoaCallout tone="danger" role="alert">
            {error}
          </CocoaCallout>
        ) : null}

        {/* Guest + room header */}
        <div className="cocoa-row" data-gap="2" data-justify="between">
          <div className="cocoa-stack" data-gap="1">
            <strong style={nameStyle}>{fmtName(guest)}</strong>
            <span className="cocoa-note">{room ? `Hab. ${room.number}${room.floor ? ` · planta ${room.floor}` : ""}` : "Sin habitación asignada"}</span>
          </div>
          <CocoaStatusBadge entry={reservationStatus(reservation.status)} dense />
        </div>

        {/* STEP 1: folio */}
        <Step title="1 · Folio" badge={folio ? plural(folio.lines.length, "línea", "líneas") : folioLoading ? STATUS_LABELS.loading : "No disponible"} badgeTone={folio ? "info" : folioLoading ? "info" : "danger"}>
          {folioLoading ? (
            <CocoaState kind="loading" title="Cargando folio…" />
          ) : !folio ? (
            <CocoaCallout
              tone="danger"
              title={`No se pudo cargar el folio${folioError ? `: ${folioError}` : "."}`}
              actions={
                <>
                  <CocoaButton variant="bordered" tone="neutral" size="small" onClick={folioState.refresh} disabled={busy}>
                    {ACTIONS.retry}
                  </CocoaButton>
                  <CocoaButton variant={skipPayment ? "filled" : "tinted"} tone="accent" size="small" onClick={() => setSkipPayment(true)} disabled={busy} aria-pressed={skipPayment}>
                    {FRONT_DESK_ACTIONS.noCharge}
                  </CocoaButton>
                </>
              }
            >
              Sin folio no es posible cobrar ni saber el saldo real. Reintenta o elige «Sin cobro» para salir sin cobrar.
            </CocoaCallout>
          ) : (
            <div className="cocoa-stack" data-gap="2">
              {folio.lines.length > 0 ? (
                <CocoaTable columns={FOLIO_COLUMNS} rows={folio.lines} rowKey="id" density="compact" caption="Líneas del folio" aria-label="Líneas del folio" />
              ) : (
                <CocoaState kind="empty" inline title="Sin líneas en el folio." />
              )}
              <ul className="c22-section__list" aria-label="Totales del folio">
                <li>
                  <span>Total cargos</span>
                  <strong>{fmtEur(folio.chargesTotal)}</strong>
                </li>
                <li>
                  <span className="cocoa-note">Pagos previos</span>
                  <strong>{fmtEur(folio.paymentsTotal)}</strong>
                </li>
                <li>
                  <span>Saldo</span>
                  <strong style={balanceStyle(hasBalance)}>{fmtEur(balanceDue)}</strong>
                </li>
              </ul>
            </div>
          )}
        </Step>

        {/* STEP 2: cobro */}
        <Step title="2 · Cobro" badge={!folio ? "Saldo no disponible" : hasBalance ? (skipPayment ? FRONT_DESK_ACTIONS.noCharge : "Saldo abierto") : "Saldado"} badgeTone={!folio ? "danger" : hasBalance ? "warning" : "success"}>
          {!folio ? (
            <p className="cocoa-note">
              {skipPayment ? "Has elegido salir sin cobrar. El saldo real se comprobará en el servidor: si queda importe pendiente te lo mostraremos antes de cerrar." : "El saldo no está disponible porque el folio no se ha cargado."}
            </p>
          ) : hasBalance ? (
            <div className="cocoa-stack" data-gap="2">
              <p className="cocoa-note">
                Importe a cobrar: <strong>{fmtEur(balanceDue)}</strong>
              </p>
              <CocoaField label="Método">
                <CocoaSelect value={paymentMethod} onChange={(value) => setPaymentMethod(value as QuickCheckoutMethodOption)} options={PAYMENT_METHOD_OPTIONS} disabled={skipPayment || busy} />
              </CocoaField>
              <CocoaSwitch checked={skipPayment} onChange={setSkipPayment} size="small" disabled={busy} label="Sin cobro ahora (el huésped saldrá con saldo pendiente)" />
            </div>
          ) : (
            <p className="cocoa-note">El folio está saldado. No hay nada que cobrar.</p>
          )}
        </Step>

        {/* 409 BALANCE_DUE: decide before retrying */}
        {balancePrompt ? (
          <CocoaCallout tone="warning" variant="banner" title="Saldo pendiente detectado" role="alert">
            <div className="cocoa-stack" data-gap="2">
              <p className="cocoa-note">
                {balancePrompt.message}
                {balancePrompt.balanceDue !== null ? ` Saldo: ${fmtEur(balancePrompt.balanceDue)}.` : ""}
              </p>
              <div className="cocoa-row" data-gap="2">
                {folio ? (
                  <CocoaButton
                    variant="filled"
                    tone="accent"
                    size="small"
                    disabled={busy}
                    onClick={() => {
                      // The API-reported balance is authoritative; the folio one is the fallback.
                      setSkipPayment(false);
                      void executeCheckOut({ collectAmount: balancePrompt.balanceDue ?? balanceDue });
                    }}
                  >
                    {FRONT_DESK_ACTIONS.collectAndClose(fmtEur(balancePrompt.balanceDue ?? balanceDue))}
                  </CocoaButton>
                ) : null}
                <CocoaButton variant="bordered" tone="neutral" size="small" disabled={busy} onClick={() => void executeCheckOut({ acknowledgeBalance: true })}>
                  {FRONT_DESK_ACTIONS.leaveWithBalance}
                </CocoaButton>
                <CocoaButton variant="plain" tone="neutral" size="small" disabled={busy} onClick={() => setBalancePrompt(null)}>
                  {ACTIONS.cancel}
                </CocoaButton>
              </div>
            </div>
          </CocoaCallout>
        ) : null}

        {/* STEP 3: salida y factura (D6: la habitación pasa a sucia en el servidor; sin switch decorativo) */}
        <Step title="3 · Salida y factura" badge={issueInvoice ? (customerType === "company" ? FRONT_DESK_NOTES.invoiceCompany : FRONT_DESK_NOTES.invoiceGuest) : FRONT_DESK_NOTES.invoiceNone} badgeTone="info">
          <div className="cocoa-stack" data-gap="2">
            <p className="cocoa-note">{FRONT_DESK_NOTES.roomWillBeDirty} Housekeeping recibe la tarea de limpieza de salida.</p>
            <CocoaField label="Factura" help={invoiceMode === "issue" ? "Se emite con número al cerrar (irreversible: entra en la cadena VeriFactu)." : invoiceMode === "draft" ? "Queda como borrador con los cargos del folio; Facturación la emite." : "No se crea ninguna factura ahora."}>
              <CocoaSegmentedControl
                size="small"
                aria-label="Factura"
                value={invoiceMode}
                onChange={(value) => setInvoiceMode(value as InvoiceMode)}
                options={[
                  { value: "draft", label: FRONT_DESK_NOTES.invoiceDraft },
                  { value: "issue", label: FRONT_DESK_NOTES.invoiceIssueNow },
                  { value: "none", label: FRONT_DESK_NOTES.invoiceNone }
                ]}
              />
            </CocoaField>
            {issueInvoice ? (
              <div className="cocoa-stack" data-gap="2">
                <CocoaField label={FRONT_DESK_NOTES.invoiceTo}>
                  <CocoaSegmentedControl
                    size="small"
                    aria-label={FRONT_DESK_NOTES.invoiceTo}
                    value={customerType}
                    onChange={(value) => setCustomerType(value as InvoiceCustomerType)}
                    options={[
                      { value: "guest", label: FRONT_DESK_NOTES.invoiceGuest },
                      { value: "company", label: FRONT_DESK_NOTES.invoiceCompany }
                    ]}
                  />
                </CocoaField>
                {customerType === "company" ? (
                  <div className="cocoa-row" data-gap="2" data-align="end">
                    <CocoaField label={FRONT_DESK_NOTES.companyName} required>
                      <CocoaInput value={customerName} onChange={setCustomerName} autoComplete="organization" disabled={busy} maxLength={500} />
                    </CocoaField>
                    <CocoaField label={FRONT_DESK_NOTES.taxId} required htmlFor={taxIdFieldId}>
                      <CocoaInput id={taxIdFieldId} value={customerTaxId} onChange={setCustomerTaxId} autoComplete="off" disabled={busy} maxLength={40} placeholder="B12345674" />
                    </CocoaField>
                  </div>
                ) : (
                  <p className="cocoa-note">Factura simplificada a nombre del huésped; si la reserva tiene comunidad con tasa turística, se incluye como línea exenta.</p>
                )}
              </div>
            ) : null}
          </div>
        </Step>

        {blockingReason ? (
          <CocoaCallout tone="warning" role="status">
            {blockingReason}
          </CocoaCallout>
        ) : null}
      </form>
    );
  }

  return (
    <CocoaDrawer
      open
      onClose={onClose}
      title="Check-out"
      subtitle={reservation ? `${fmtName(guest)}${room ? ` · Hab. ${room.number}` : ""}` : undefined}
      side="right"
      size="md"
      loading={loadingReservation}
      skeleton={<CheckOutSkeleton />}
      focusKey={`${reservation && (folio || folioError) ? "ready" : "loading"}:${canSubmit ? "ready" : "wait"}`}
      initialFocus={() => document.getElementById(submitId)}
      footer={
        <>
          <CocoaButton variant="bordered" tone="neutral" onClick={onClose} disabled={busy}>
            {ACTIONS.cancel}
          </CocoaButton>
          {completed ? (
            <CocoaButton variant="filled" tone="accent" onClick={onClose}>
              {ACTIONS.close}
            </CocoaButton>
          ) : (
            <CocoaButton id={submitId} variant="filled" tone="accent" type="submit" form={formId} disabled={!canSubmit || busy || Boolean(balancePrompt)} loading={busy} title={blockingReason || "Intro también confirma"}>
              {ctaLabel}
            </CocoaButton>
          )}
        </>
      }
    >
      <div className="cocoa-stack" data-gap="3">
        <div className="cocoa-row" data-gap="2">
          <CocoaBadge tone={timerTone} icon={<ClockIcon size={12} />} title="Objetivo: < 60 segundos" aria-label={`Cronómetro ${elapsedLabel}`}>
            {elapsedLabel}
          </CocoaBadge>
          {completed ? (
            <CocoaBadge tone="success" variant="tinted">
              {STATUS_LABELS.completed}
            </CocoaBadge>
          ) : null}
        </div>
        {body}
      </div>
    </CocoaDrawer>
  );
}

function Step({ title, badge, badgeTone = "neutral", children }: { title: string; badge?: string; badgeTone?: CocoaTone; children: ReactNode }) {
  return (
    <CocoaSection
      title={title}
      meta={
        badge ? (
          <CocoaBadge tone={badgeTone} size="small">
            {badge}
          </CocoaBadge>
        ) : undefined
      }
    >
      {children}
    </CocoaSection>
  );
}

function CompletedView({ elapsed, roomNumber, invoiceNumber }: { elapsed: string; roomNumber?: string; invoiceNumber: string | null }) {
  return (
    <div className="cocoa-stack" data-gap="3">
      <CocoaState kind="empty" illustration="success" title="Check-out completado" message={roomNumber ? `La habitación ${roomNumber} ha pasado a sucia.` : "Folio cerrado y huésped despedido."} role="status" />
      <div className="cocoa-row" data-gap="2" data-justify="center">
        <CocoaBadge tone="success" icon={<ClockIcon size={12} />}>
          {elapsed} · objetivo &lt; 1:00
        </CocoaBadge>
      </div>
      <p className="cocoa-note">{invoiceNumber ? FRONT_DESK_TOASTS.invoiceIssued(invoiceNumber) : "Sin factura emitida desde aquí (si la pediste, queda en borrador en Facturación)."} Housekeeping recibirá una tarea de limpieza de salida.</p>
    </div>
  );
}
