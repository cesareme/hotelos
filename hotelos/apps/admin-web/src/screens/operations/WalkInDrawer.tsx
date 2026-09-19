// WalkInDrawer — alta de una llegada sin reserva desde Mi día (Tanda UX-1 ·
// lote U6 · docs/design/UX-RECEPCION-FEEL.md §5.3, F4, §2.1 fila 2).
//
// Una sola vista: estancia (hoy → mañana), adultos, tipo con precio en vivo
// (POST /properties/:id/availability/quote con 300 ms de espera), primera
// habitación limpia y libre del tipo preseleccionada, nombre y apellido (lo
// mínimo del API: `roomTypeId` + `primaryGuest`), cobro (saldo / sin cobro) y
// dos CTA: «Solo crear reserva» y «Crear y hacer check-in» (Intro). Peticiones:
// rooms y room-types desde la caché compartida (5 min), la cotización, POST
// reservations con `bookingSource: "walk_in"`, GET folio, y el runner del
// check-in (assign si hace falta → cobro → check-in → partes → SES). El parte
// de viajeros se completa después desde la ficha o el cajón de check-in.
//
// El folio de una reserva recién creada nace sin el cargo de alojamiento (lo
// asienta el cierre del día), así que «Cobrar 89,00 €» registra el importe de
// la estancia como anticipo: el saldo queda a favor hasta el cierre.
//
// Sin estilos en línea (contrato Cocoa 22): layout con las utilidades `cocoa-stack` /
// `cocoa-row`; copy de content/actions.ts. Las funciones puras se prueban en
// __tests__/walk-in-drawer.test.mts.

import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useToast } from "../../components/Toast";
import { ApiError, apiRequest } from "../../services/api-client";
import { invalidateApi, useApiData } from "../../hooks/useApiData";
import { createReservation, postFolioPayment, quoteAvailability, shiftIsoDate, todayIsoLocal, type AdminReservation, type AdminRoom, type AdminRoomType, type AvailabilityQuote } from "../../services/pmsCommerceApi";
import { newClientRequestId } from "../../services/finance-contracts";
import { queueSesSubmissions, sesQueueOutcomeFromError, sesQueueOutcomeFromResponse } from "../../services/complianceApi";
import { listReservationGuestRegisterRecords, markGuestRegisterIdentityVerified } from "../../services/guestRegisterApi";
import { QUICK_CHECKIN_METHOD_OPTIONS, type QuickCheckinMethodOption } from "./quickCheckinPayment";
import { CheckinRunError, progressLabel, runCheckin, type CheckinProgress } from "./checkinRunner";
import { roomOptionLabel } from "./frontdesk-labels";
import { roomStatus } from "../../content/status-dictionary";
import { logBreadcrumb } from "../../lib/breadcrumb";
import { DEFAULT_CURRENCY, money, plural } from "../../lib/format";
import { ACTIONS, FRONT_DESK_ACTIONS, FRONT_DESK_TOASTS } from "../../content/actions";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDatePicker,
  CocoaDrawer,
  CocoaField,
  CocoaInput,
  CocoaSection,
  CocoaSegmentedControl,
  CocoaSelect,
  CocoaSkeleton,
  CocoaStatusBadge
} from "../../components/cocoa";

// =============================================================== lógica pura

export const WALK_IN_QUOTE_DEBOUNCE_MS = 300;

/** Noches entre dos fechas ISO (YYYY-MM-DD); 0 si la salida no es posterior. */
export function walkInNights(arrivalDate: string, departureDate: string): number {
  const a = Date.parse(`${arrivalDate}T00:00:00Z`);
  const d = Date.parse(`${departureDate}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(d)) return 0;
  return Math.max(0, Math.round((d - a) / 86_400_000));
}

/** Hoy → mañana (fecha local de la propiedad, `todayIsoLocal`). */
export function walkInDefaultDates(today: string = todayIsoLocal()): { arrivalDate: string; departureDate: string } {
  return { arrivalDate: today, departureDate: shiftIsoDate(today, 1) };
}

/** «limpia» con el vocabulario cerrado de pisos: clean | inspected (nunca `status`). */
export function isWalkInRoomClean(room: Pick<AdminRoom, "housekeepingStatus">): boolean {
  const hk = (room.housekeepingStatus ?? "").trim().toLowerCase();
  return hk === "clean" || hk === "inspected";
}

/** Habitaciones del tipo que se pueden ofrecer: vendibles, no ocupadas ni fuera de servicio y limpias (F24). */
export function walkInCandidateRooms(rooms: readonly AdminRoom[], roomTypeId: string): AdminRoom[] {
  return rooms.filter((room) => {
    if (room.roomTypeId !== roomTypeId) return false;
    if (room.sellable === false) return false;
    const status = (room.status ?? "").trim().toLowerCase();
    if (status === "occupied" || status === "blocked" || status === "out_of_order" || status === "ooo" || status === "out_of_service") return false;
    return isWalkInRoomClean(room);
  });
}

/** La primera limpia y libre del tipo (por número), o null. */
export function pickWalkInRoom(rooms: readonly AdminRoom[], roomTypeId: string): AdminRoom | null {
  const candidates = walkInCandidateRooms(rooms, roomTypeId).sort((a, b) => a.number.localeCompare(b.number, "es", { numeric: true }));
  return candidates[0] ?? null;
}

/** Importe de la estancia según la cotización del tipo (una habitación); null sin cotización. */
export function walkInAmount(quotes: readonly AvailabilityQuote[], roomTypeId: string): number | null {
  const quote = quotes.find((entry) => entry.roomTypeId === roomTypeId);
  if (!quote || !Number.isFinite(quote.totalAmount)) return null;
  return Math.round(quote.totalAmount * 100) / 100;
}

/** Tipo preseleccionado: el primero con disponibilidad según la cotización; si no hay cotización, el primero del catálogo. */
export function pickWalkInRoomType(roomTypes: readonly AdminRoomType[], quotes: readonly AvailabilityQuote[]): string {
  const available = quotes.find((quote) => quote.availableRooms > 0 && roomTypes.some((type) => type.id === quote.roomTypeId));
  if (available) return available.roomTypeId;
  return roomTypes[0]?.id ?? "";
}

/** «Doble · 89,00 € · 4 libres» (la etiqueta del tipo con el precio en vivo). */
export function walkInRoomTypeLabel(type: Pick<AdminRoomType, "id" | "name">, quote: AvailabilityQuote | undefined, formatAmount: (amount: number, currency?: string) => string): string {
  if (!quote) return type.name;
  const price = Number.isFinite(quote.totalAmount) ? formatAmount(quote.totalAmount, quote.currency) : null;
  const free = quote.availableRooms === 1 ? "1 libre" : `${quote.availableRooms} libres`;
  return [type.name, price, free].filter(Boolean).join(" · ");
}

export type WalkInForm = {
  arrivalDate: string;
  departureDate: string;
  adults: number;
  roomTypeId: string;
  roomId: string | null;
  firstName: string;
  surname1: string;
  documentNumber: string;
};

/** Cuerpo de POST /properties/:id/reservations: lo mínimo del API más el origen `walk_in`; nunca cadenas vacías (400 en correos y país). */
export function buildWalkInReservationBody(form: WalkInForm): Record<string, unknown> {
  const primaryGuest: Record<string, string> = { firstName: form.firstName.trim(), surname1: form.surname1.trim() };
  const documentNumber = form.documentNumber.trim();
  if (documentNumber) primaryGuest.documentNumber = documentNumber;
  const body: Record<string, unknown> = {
    arrivalDate: form.arrivalDate,
    departureDate: form.departureDate,
    adults: form.adults,
    children: 0,
    roomsCount: 1,
    roomTypeId: form.roomTypeId,
    channel: "direct",
    bookingSource: "walk_in",
    currency: DEFAULT_CURRENCY,
    primaryGuest
  };
  if (form.roomId) body.assignedRoomId = form.roomId;
  return body;
}

/** Qué falta para poder crear (en el orden de la vista): [] si todo está. */
export function walkInMissing(form: Pick<WalkInForm, "arrivalDate" | "departureDate" | "roomTypeId" | "firstName" | "surname1">): Array<"dates" | "roomType" | "guest"> {
  const missing: Array<"dates" | "roomType" | "guest"> = [];
  if (walkInNights(form.arrivalDate, form.departureDate) < 1) missing.push("dates");
  if (!form.roomTypeId) missing.push("roomType");
  if (!form.firstName.trim() || !form.surname1.trim()) missing.push("guest");
  return missing;
}

// =============================================================== componente

export type WalkInDrawerProps = {
  propertyId: string;
  onClose: () => void;
  /** Reserva creada (con o sin check-in): Mi día revalida sus tablas. */
  onCompleted?: (info: { reservationId: string; code: string; roomNumber: string | null; checkedIn: boolean }) => void;
};

type PaymentMode = "balance" | "none";

const ADULT_OPTIONS = [1, 2, 3, 4].map((count) => ({ value: String(count), label: plural(count, "adulto", "adultos") }));

const ROOM_TYPES_STALE_MS = 5 * 60_000;

function WalkInSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton variant="card" height={72} />
      <CocoaSkeleton variant="card" height={96} />
      <CocoaSkeleton variant="card" height={72} />
      <CocoaSkeleton variant="card" height={72} />
    </div>
  );
}

export function WalkInDrawer({ propertyId, onClose, onCompleted }: WalkInDrawerProps) {
  const { showToast } = useToast();
  const formId = useId();
  const firstNameId = useId();
  const roomSelectId = useId();
  const defaults = useMemo(() => walkInDefaultDates(), []);

  const rooms = useApiData<AdminRoom[]>(`/properties/${propertyId}/rooms`, { staleTime: ROOM_TYPES_STALE_MS });
  const roomTypes = useApiData<AdminRoomType[]>(`/properties/${propertyId}/room-types`, { staleTime: ROOM_TYPES_STALE_MS });

  const [arrivalDate, setArrivalDate] = useState(defaults.arrivalDate);
  const [departureDate, setDepartureDate] = useState(defaults.departureDate);
  const [adults, setAdults] = useState(2);
  const [roomTypeId, setRoomTypeId] = useState("");
  const [roomId, setRoomId] = useState<string | null>(null);
  const [roomTouched, setRoomTouched] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [surname1, setSurname1] = useState("");
  const [documentNumber, setDocumentNumber] = useState("");
  const [paymentMode, setPaymentMode] = useState<PaymentMode>("balance");
  const [paymentMethod, setPaymentMethod] = useState<QuickCheckinMethodOption>("card");

  const [quotes, setQuotes] = useState<AvailabilityQuote[]>([]);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const quoteSeq = useRef(0);

  const [busy, setBusy] = useState<"create" | "checkin" | null>(null);
  const [progress, setProgress] = useState<CheckinProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    logBreadcrumb("walkin.opened", "ui", { propertyId });
    // Una vez al montar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const roomTypeList = roomTypes.data ?? [];
  const roomList = rooms.data ?? [];
  const catalogLoading = (rooms.loading && !rooms.data) || (roomTypes.loading && !roomTypes.data);
  const nights = walkInNights(arrivalDate, departureDate);

  // Precio en vivo: cotización de todos los tipos al cambiar fechas o adultos (300 ms).
  useEffect(() => {
    if (nights < 1) {
      setQuotes([]);
      setQuoteError(null);
      return;
    }
    const seq = ++quoteSeq.current;
    setQuoting(true);
    const timer = window.setTimeout(() => {
      quoteAvailability(propertyId, { arrivalDate, departureDate, adults })
        .then((response) => {
          if (seq !== quoteSeq.current) return;
          setQuotes(response);
          setQuoteError(null);
        })
        .catch((err: unknown) => {
          if (seq !== quoteSeq.current) return;
          setQuotes([]);
          setQuoteError(err instanceof Error ? err.message : "No se pudo consultar la disponibilidad.");
        })
        .finally(() => {
          if (seq === quoteSeq.current) setQuoting(false);
        });
    }, WALK_IN_QUOTE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [propertyId, arrivalDate, departureDate, adults, nights]);

  // Tipo preseleccionado (el primero con disponibilidad) y habitación (la primera limpia y libre del tipo).
  useEffect(() => {
    if (roomTypeId || roomTypeList.length === 0) return;
    setRoomTypeId(pickWalkInRoomType(roomTypeList, quotes));
  }, [roomTypeId, roomTypeList, quotes]);

  useEffect(() => {
    if (roomTouched || !roomTypeId) return;
    setRoomId(pickWalkInRoom(roomList, roomTypeId)?.id ?? null);
  }, [roomTouched, roomTypeId, roomList]);

  const candidateRooms = useMemo(() => walkInCandidateRooms(roomList, roomTypeId).sort((a, b) => a.number.localeCompare(b.number, "es", { numeric: true })), [roomList, roomTypeId]);
  const selectedRoom = useMemo(() => (roomId ? roomList.find((room) => room.id === roomId) ?? null : null), [roomId, roomList]);
  const selectedQuote = useMemo(() => quotes.find((quote) => quote.roomTypeId === roomTypeId), [quotes, roomTypeId]);
  const amount = walkInAmount(quotes, roomTypeId);
  const willCollect = paymentMode === "balance" && amount !== null && amount > 0;
  const amountLabel = amount !== null ? money(amount, selectedQuote?.currency ?? DEFAULT_CURRENCY) : null;

  const form: WalkInForm = { arrivalDate, departureDate, adults, roomTypeId, roomId, firstName, surname1, documentNumber };
  const missing = walkInMissing(form);
  const canSubmit = missing.length === 0 && busy === null && !catalogLoading;
  const blockingReason =
    missing[0] === "dates" ? "La salida debe ser posterior a la llegada." : missing[0] === "roomType" ? "Elige un tipo de habitación." : missing[0] === "guest" ? "Indica nombre y apellido del huésped." : "";

  const roomTypeOptions = useMemo(
    () => roomTypeList.map((type) => ({ value: type.id, label: walkInRoomTypeLabel(type, quotes.find((quote) => quote.roomTypeId === type.id), (value, currency) => money(value, currency)) })),
    [roomTypeList, quotes]
  );
  const roomOptions = useMemo(() => {
    const options = [{ value: "", label: "Sin asignar (se asigna al llegar)" }];
    for (const room of candidateRooms) options.push({ value: room.id, label: roomOptionLabel(room, roomStatus(room.housekeepingStatus).label) });
    if (selectedRoom && !candidateRooms.some((room) => room.id === selectedRoom.id)) options.push({ value: selectedRoom.id, label: roomOptionLabel(selectedRoom, roomStatus(selectedRoom.housekeepingStatus).label) });
    return options;
  }, [candidateRooms, selectedRoom]);

  const create = useCallback(async (): Promise<AdminReservation> => {
    const reservation = await createReservation(propertyId, buildWalkInReservationBody(form));
    logBreadcrumb("walkin.created", "mutation", { reservationId: reservation.id, roomTypeId, roomId, nights });
    invalidateApi("/dashboards/front-desk");
    invalidateApi(`/properties/${propertyId}/reservations`);
    return reservation;
    // El formulario es un valor derivado del estado: sus campos ya están en las dependencias.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propertyId, arrivalDate, departureDate, adults, roomTypeId, roomId, firstName, surname1, documentNumber, nights]);

  async function createOnly() {
    if (!canSubmit) return;
    setBusy("create");
    setError(null);
    try {
      const reservation = await create();
      showToast(`${FRONT_DESK_TOASTS.reservationCreated(reservation.code)} · ${money(reservation.totalAmount, reservation.currency)}`, { variant: "success" });
      onCompleted?.({ reservationId: reservation.id, code: reservation.code, roomNumber: selectedRoom?.number ?? null, checkedIn: false });
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : "No se pudo crear la reserva.";
      setError(message);
      showToast(message, { variant: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function createAndCheckIn() {
    if (!canSubmit) return;
    if (!roomId) {
      setError("Para hacer el check-in hace falta una habitación limpia y libre del tipo elegido.");
      return;
    }
    setBusy("checkin");
    setError(null);
    let reservation: AdminReservation | null = null;
    try {
      reservation = await create();
      const folio = willCollect ? await apiRequest<{ folio: { id: string } }>(`/reservations/${encodeURIComponent(reservation.id)}/folio`) : null;
      const total = Math.round(Number(reservation.totalAmount) * 100) / 100;
      const collect = willCollect && folio && total > 0 ? { folioId: folio.folio.id, amount: total, method: paymentMethod } : null;
      const result = await runCheckin(
        {
          reservationId: reservation.id,
          propertyId,
          assignedRoomId: reservation.assignedRoomId ?? null,
          roomId,
          currency: reservation.currency || DEFAULT_CURRENCY,
          payment: collect
        },
        {
          request: apiRequest,
          postPayment: (folioId, body) => postFolioPayment(folioId, body),
          listPartes: () => listReservationGuestRegisterRecords(reservation!.id, { retries: 0 }),
          markIdentity: (parteId) => markGuestRegisterIdentityVerified(parteId, "visual_document_check"),
          queueSes: (pid, rid) => queueSesSubmissions(pid, rid).then(sesQueueOutcomeFromResponse, sesQueueOutcomeFromError),
          newClientRequestId,
          isForbidden: (err) => err instanceof ApiError && err.status === 403,
          onProgress: setProgress
        }
      );
      logBreadcrumb("walkin.checkedIn", "mutation", { reservationId: reservation.id, ses: result.ses.kind });
      invalidateApi("/dashboards/front-desk");
      const roomNumber = selectedRoom?.number ?? null;
      showToast(FRONT_DESK_TOASTS.walkInDone(reservation.code, roomNumber), { variant: "success" });
      if (result.ses.kind !== "queued") {
        showToast("Parte de viajeros no encolado en SES: complétalo desde la ficha o la bandeja de cumplimiento.", { variant: "warning", duration: 8000 });
      }
      onCompleted?.({ reservationId: reservation.id, code: reservation.code, roomNumber, checkedIn: true });
      onClose();
    } catch (err) {
      const message = err instanceof CheckinRunError ? `Reserva ${reservation?.code ?? ""} creada, pero ${err.message}` : err instanceof Error ? err.message : "No se pudo completar el walk-in.";
      setError(message);
      showToast(message, { variant: "error", duration: 9000 });
      if (reservation) onCompleted?.({ reservationId: reservation.id, code: reservation.code, roomNumber: selectedRoom?.number ?? null, checkedIn: false });
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void createAndCheckIn();
  }

  const catalogError = rooms.error ?? roomTypes.error;

  return (
    <CocoaDrawer
      open
      onClose={onClose}
      title={FRONT_DESK_ACTIONS.walkIn}
      subtitle={`${arrivalDate === defaults.arrivalDate ? "Hoy" : arrivalDate} → ${departureDate === defaults.departureDate ? "mañana" : departureDate} · ${plural(nights, "noche", "noches")}`}
      side="right"
      size="md"
      loading={catalogLoading}
      skeleton={<WalkInSkeleton />}
      focusKey={catalogLoading ? "loading" : "ready"}
      initialFocus={() => document.getElementById(firstNameId)}
      footer={
        <>
          <CocoaButton variant="bordered" tone="neutral" onClick={onClose} disabled={busy !== null}>
            {ACTIONS.cancel}
          </CocoaButton>
          <CocoaButton variant="bordered" tone="neutral" disabled={!canSubmit} loading={busy === "create"} onClick={() => void createOnly()} title="Crea la reserva sin cobrar ni hacer el check-in">
            {FRONT_DESK_ACTIONS.createOnly}
          </CocoaButton>
          <CocoaButton variant="filled" tone="accent" type="submit" form={formId} disabled={!canSubmit || !roomId} loading={busy === "checkin"} title={blockingReason || (!roomId ? "Sin habitación limpia y libre del tipo" : "Intro también confirma")}>
            {FRONT_DESK_ACTIONS.createAndCheckIn}
          </CocoaButton>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} className="cocoa-stack" data-gap="3" aria-label="Alta de walk-in">
        {error ? (
          <CocoaCallout tone="danger" role="alert">
            {error}
          </CocoaCallout>
        ) : null}
        {catalogError ? (
          <CocoaCallout tone="warning" role="status" actions={<CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => { rooms.refresh(); roomTypes.refresh(); }}>{ACTIONS.retry}</CocoaButton>}>
            No se pudo cargar el catálogo de habitaciones: {catalogError}
          </CocoaCallout>
        ) : null}
        {progress ? (
          <CocoaCallout tone="info" role="status">
            {progressLabel(progress)}
          </CocoaCallout>
        ) : null}

        <CocoaSection title="Estancia" meta={<CocoaBadge tone="neutral" size="small" uppercase={false}>{plural(nights, "noche", "noches")}</CocoaBadge>}>
          <div className="cocoa-row" data-gap="2" data-align="end">
            <CocoaField label="Llegada">
              <CocoaDatePicker value={arrivalDate} onChange={setArrivalDate} disabled={busy !== null} />
            </CocoaField>
            <CocoaField label="Salida">
              <CocoaDatePicker value={departureDate} onChange={setDepartureDate} min={arrivalDate} disabled={busy !== null} />
            </CocoaField>
            <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => setDepartureDate(shiftIsoDate(departureDate, 1))} disabled={busy !== null}>
              +1 noche
            </CocoaButton>
            <CocoaField label="Adultos">
              <CocoaSelect value={String(adults)} onChange={(value) => setAdults(Number(value) || 1)} options={ADULT_OPTIONS} disabled={busy !== null} />
            </CocoaField>
          </div>
        </CocoaSection>

        <CocoaSection
          title="Tipo y habitación"
          meta={
            quoting ? (
              <CocoaBadge tone="info" size="small" uppercase={false}>
                Cotizando…
              </CocoaBadge>
            ) : selectedQuote ? (
              <CocoaBadge tone={selectedQuote.availableRooms > 0 ? "success" : "danger"} size="small" uppercase={false}>
                {plural(selectedQuote.availableRooms, "disponible", "disponibles")}
              </CocoaBadge>
            ) : undefined
          }
        >
          <div className="cocoa-stack" data-gap="2">
            <CocoaField label="Tipo" help={quoteError ? `Sin precio en vivo: ${quoteError}` : selectedQuote?.priceSource === "fallback" ? "Precio de relleno: alguna noche no tiene tarifa publicada." : "Precio de la estancia según la tarifa publicada."}>
              <CocoaSelect
                value={roomTypeId}
                onChange={(value) => {
                  setRoomTypeId(value);
                  setRoomTouched(false);
                }}
                options={roomTypeOptions}
                disabled={busy !== null || roomTypeOptions.length === 0}
              />
            </CocoaField>
            <CocoaField label="Habitación" htmlFor={roomSelectId} help={candidateRooms.length === 0 ? "No hay ninguna habitación limpia y libre de este tipo ahora mismo." : `${plural(candidateRooms.length, "limpia y libre", "limpias y libres")}: la primera va preseleccionada.`}>
              <CocoaSelect
                id={roomSelectId}
                value={roomId ?? ""}
                onChange={(value) => {
                  setRoomTouched(true);
                  setRoomId(value || null);
                }}
                options={roomOptions}
                disabled={busy !== null}
              />
            </CocoaField>
            {selectedRoom ? (
              <div className="cocoa-row" data-gap="2" data-align="baseline">
                <strong>Hab. {selectedRoom.number}</strong>
                <CocoaStatusBadge entry={roomStatus(selectedRoom.housekeepingStatus)} dense />
              </div>
            ) : null}
          </div>
        </CocoaSection>

        <CocoaSection title="Huésped" meta={<CocoaBadge tone="neutral" size="small" uppercase={false}>Lo mínimo: nombre y apellido</CocoaBadge>}>
          <div className="cocoa-stack" data-gap="2">
            <div className="cocoa-row" data-gap="2">
              <CocoaField label="Nombre" required htmlFor={firstNameId}>
                <CocoaInput id={firstNameId} value={firstName} onChange={setFirstName} autoComplete="off" disabled={busy !== null} required />
              </CocoaField>
              <CocoaField label="Apellido" required>
                <CocoaInput value={surname1} onChange={setSurname1} autoComplete="off" disabled={busy !== null} required />
              </CocoaField>
            </div>
            <CocoaField label="Documento" help="Opcional ahora: el parte de viajeros se completa desde la ficha o el cajón de check-in.">
              <CocoaInput value={documentNumber} onChange={setDocumentNumber} autoComplete="off" disabled={busy !== null} />
            </CocoaField>
          </div>
        </CocoaSection>

        <CocoaSection title="Cobro" meta={amountLabel ? <CocoaBadge tone="warning" size="small" uppercase={false}>{amountLabel}</CocoaBadge> : undefined}>
          <div className="cocoa-stack" data-gap="2">
            <CocoaSegmentedControl
              size="small"
              aria-label="Modo de cobro"
              value={paymentMode}
              onChange={(value) => setPaymentMode(value as PaymentMode)}
              options={[
                { value: "balance", label: amountLabel ? FRONT_DESK_ACTIONS.collect(amountLabel) : FRONT_DESK_ACTIONS.collect("la estancia"), disabled: amount === null || amount <= 0 },
                { value: "none", label: FRONT_DESK_ACTIONS.noCharge }
              ]}
            />
            {willCollect ? (
              <CocoaField label="Método">
                <CocoaSelect value={paymentMethod} onChange={(value) => setPaymentMethod(value as QuickCheckinMethodOption)} options={QUICK_CHECKIN_METHOD_OPTIONS} disabled={busy !== null} />
              </CocoaField>
            ) : null}
            <p className="cocoa-note">
              {willCollect ? "El cobro se registra al hacer el check-in, como anticipo del importe de la estancia." : "Sin cobro ahora: el saldo se cobra desde la ficha o al hacer el check-out."}
            </p>
          </div>
        </CocoaSection>

        {blockingReason ? (
          <CocoaCallout tone="warning" role="status">
            {blockingReason}
          </CocoaCallout>
        ) : null}
      </form>
    </CocoaDrawer>
  );
}

export default WalkInDrawer;
