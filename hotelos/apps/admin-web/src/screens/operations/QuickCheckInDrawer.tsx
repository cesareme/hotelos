// Quick Check-in Drawer — flujo guiado de ≤ 90 segundos en una sola pantalla.
//
// Directriz Anfitorio (Nov 2026):
//   "Diseñar check-in/check-out de 90 segundos. Buscar reserva, validar
//    identidad, confirmar datos, ver alertas importantes, asignar habitación
//    limpia, cobrar o preautorizar, firmar digitalmente, emitir llave, enviar
//    mensaje de bienvenida. Evitar saltos entre pantallas."
//
// Este drawer concentra todo el flujo en una sola vista deslizante:
//   1. Huésped + identidad + alertas (VIP, recurrente, peticiones)
//   2. Habitación asignada + estado HK (con sugerencia de cambio si no lista)
//   3. Folio + saldo + método de pago (preautorización vs captura)
//   4. Compliance (parte viajeros SES) + firma
// Un único CTA "Hacer check-in" ejecuta:
//   - POST /reservations/:id/assign-room (si hay que reasignar)
//   - POST /reservations/:id/check-in
//   - POST /properties/:id/ses/submissions → { status, queued, submissions[], failed[] }
//     (Tanda 3 · cierre): el resultado se lee de verdad. «Encolado» solo si
//     queued > 0 y failed vacío; un 409 SES_ESTABLISHMENT_INCOMPLETE
//     (details.missing) o entradas en failed[] se muestran con los campos que
//     faltan y un enlace a Ajustes fiscales. Nunca «enviado» en falso.
// Mostramos cronómetro: la directriz exige < 90 s.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useToast } from "../../components/Toast";
import { LoadingBlock } from "../../components/States";
import { apiRequest } from "../../services/api-client";
import {
  queueSesSubmissions,
  sesEstablishmentIssueLabel,
  sesFailureMessages,
  sesQueueOutcomeFromError,
  sesQueueOutcomeFromResponse,
  type SesQueueOutcome
} from "../../services/complianceApi";
import { logBreadcrumb } from "../../lib/breadcrumb";
import { navigateTo } from "../../lib/navigate";

// =============================================================== shapes

type Reservation = {
  id: string;
  propertyId: string;
  code: string;
  channel: string;
  status: string;
  arrivalDate: string;
  departureDate: string;
  adults: number;
  children: number;
  roomTypeId: string;
  assignedRoomId?: string;
  ratePlanId?: string;
  boardType?: string;
  specialRequests?: string;
  notes?: string;
  cancellationPolicyCode?: string;
  totalAmount: number;
  currency: string;
};

type Guest = {
  id: string;
  firstName: string;
  surname1?: string;
  surname2?: string;
  documentType?: string;
  documentNumber?: string;
  email?: string;
  phone?: string;
  nationality?: string;
  vipCode?: string;
  loyaltyTier?: string;
  loyaltyNumber?: string;
};

type Room = {
  id: string;
  number: string;
  floor?: string;
  status: string;
  housekeepingStatus?: string;
  roomTypeId: string;
};

type RoomType = { id: string; name: string };

type FolioBalance = {
  folio: { id: string; status: string; currency: string };
  lines: Array<{ id: string; type: string; description: string; total: number }>;
  payments: Array<{ id: string; amount: number; method: string; status: string }>;
  chargesTotal: number;
  paymentsTotal: number;
  balanceDue: number;
};

export type QuickCheckInProps = {
  reservationId: string;
  onClose: () => void;
  onCompleted?: (info: { reservationId: string; elapsedSeconds: number }) => void;
};

// =============================================================== utils

function fmtEur(value: number | undefined | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "0,00 €";
  return new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

function fmtName(g: Guest | null): string {
  if (!g) return "Huésped";
  return [g.firstName, g.surname1, g.surname2].filter(Boolean).join(" ").trim() || "Huésped";
}

function nightsBetween(arrival: string, departure: string): number {
  const a = new Date(arrival).getTime();
  const d = new Date(departure).getTime();
  return Math.max(0, Math.round((d - a) / 86400000));
}

function missingLabels(missing: string[]): string {
  return missing.map(sesEstablishmentIssueLabel).join(", ");
}

/** Toast copy for a non-queued SES outcome (the queued case has its own success toast). */
function sesOutcomeToast(outcome: SesQueueOutcome): string {
  switch (outcome.kind) {
    case "queued":
      return `Parte de viajeros encolado en SES.HOSPEDAJES (${outcome.queued}).`;
    case "no_records":
      return "La reserva no tiene registros de viajeros: no se ha encolado ningún parte SES. Completa el registro de viajeros.";
    case "partial":
      return `Parte SES: ${outcome.queued} encolado${outcome.queued === 1 ? "" : "s"}, ${outcome.failed.length} sin encolar${outcome.missing.length > 0 ? ` (faltan: ${missingLabels(outcome.missing)})` : ""}.`;
    case "incomplete":
      return `Parte SES no encolado: faltan datos del establecimiento${outcome.missing.length > 0 ? ` (${missingLabels(outcome.missing)})` : ""}. Complétalos en Ajustes fiscales.`;
    case "error":
      return `Parte SES no encolado${outcome.code ? ` (${outcome.code})` : ""}: ${outcome.message} Revísalo en la bandeja de cumplimiento.`;
  }
}

// =============================================================== component

export function QuickCheckInDrawer({ reservationId, onClose, onCompleted }: QuickCheckInProps) {
  const { showToast } = useToast();
  const [reservation, setReservation] = useState<Reservation | null>(null);
  const [guest, setGuest] = useState<Guest | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [roomType, setRoomType] = useState<RoomType | null>(null);
  const [folio, setFolio] = useState<FolioBalance | null>(null);
  // QC-06: the folio is money-path. A failed load is surfaced (with retry) and
  // the operator must explicitly pick "Sin cobro" to continue without it.
  const [folioError, setFolioError] = useState<string | null>(null);
  const [folioLoading, setFolioLoading] = useState(false);
  const [availableRooms, setAvailableRooms] = useState<Room[]>([]);
  const [priorStays, setPriorStays] = useState<number>(0);

  const [selectedRoomId, setSelectedRoomId] = useState<string | undefined>(undefined);
  const [paymentMode, setPaymentMode] = useState<"none" | "preauth" | "capture">("preauth");
  // Values match the API PaymentRecord.method union.
  const [paymentMethod, setPaymentMethod] = useState<"card" | "cash" | "bank_transfer">("card");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState<{ elapsedSeconds: number } | null>(null);
  // Real result of the SES queue call after the check-in (null until then).
  const [sesOutcome, setSesOutcome] = useState<SesQueueOutcome | null>(null);

  // Cronómetro — empieza al abrir, congela al completar.
  const [tick, setTick] = useState(0);
  const startedAt = useMemo(() => Date.now(), []);
  useEffect(() => {
    logBreadcrumb("checkin.opened", "ui", { reservationId });
    // El efecto se ejecuta una sola vez al montar; reservationId es estable
    // durante la vida del drawer (cambiar reserva implica reabrirlo).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (completed) return;
    const t = window.setInterval(() => setTick((x) => x + 1), 1000);
    return () => window.clearInterval(t);
  }, [completed]);
  const elapsedSeconds = completed ? completed.elapsedSeconds : Math.floor((Date.now() - startedAt) / 1000);
  const elapsedLabel = `${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, "0")}`;

  // ------------------------------------------------------------- data load
  const loadFolio = useCallback(async () => {
    setFolioLoading(true);
    setFolioError(null);
    try {
      setFolio(await apiRequest<FolioBalance>(`/reservations/${reservationId}/folio`));
    } catch (err) {
      setFolio(null);
      setFolioError(err instanceof Error ? err.message : "No se pudo cargar el folio.");
    } finally {
      setFolioLoading(false);
    }
  }, [reservationId]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiRequest<Reservation>(`/reservations/${reservationId}`);
      setReservation(res);
      setSelectedRoomId(res.assignedRoomId);

      // Parallel fetches — the folio failure is tracked separately (folioError)
      // instead of being swallowed into a fake "0 € pending".
      const [, roomsData, roomTypesData] = await Promise.all([
        loadFolio(),
        apiRequest<Room[]>(`/properties/${res.propertyId}/rooms`),
        apiRequest<RoomType[]>(`/properties/${res.propertyId}/room-types`)
      ]);
      setAvailableRooms(roomsData);
      const rt = roomTypesData.find((t) => t.id === res.roomTypeId) ?? null;
      setRoomType(rt);
      const r = res.assignedRoomId ? roomsData.find((x) => x.id === res.assignedRoomId) ?? null : null;
      setRoom(r);

      // Guest — el endpoint /reservations/:id ya devuelve `primaryGuest`
      // enriquecido (id + name + dni + vip). Evitamos /guests/:id porque tiene
      // scope por org y la cadena demo usa varias orgs.
      const primaryGuest = (res as unknown as { primaryGuest?: Guest | null }).primaryGuest;
      if (primaryGuest) setGuest(primaryGuest);

      // Stays anteriores (cliente recurrente) — best-effort: only feeds the
      // "Recurrente" badge, so a failure degrades to "no badge" (not money-path).
      const reservationGuestsList = await apiRequest<Array<{ guestId: string; reservation: { propertyId: string; status: string; departureDate: string } }>>(
        `/reservations/${reservationId}/guest-history`
      ).catch(() => []);
      setPriorStays(reservationGuestsList.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error cargando reserva");
    } finally {
      setLoading(false);
    }
  }, [reservationId, loadFolio]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // ------------------------------------------------------------- derived

  const selectedRoom = useMemo(
    () => (selectedRoomId ? availableRooms.find((r) => r.id === selectedRoomId) : undefined),
    [selectedRoomId, availableRooms]
  );

  const roomIsClean = useMemo(() => {
    if (!selectedRoom) return false;
    const hk = (selectedRoom.housekeepingStatus ?? "").toLowerCase();
    return hk === "clean" || hk === "inspected" || hk === "ready" || selectedRoom.status === "clean";
  }, [selectedRoom]);

  const candidateRooms = useMemo(() => {
    if (!reservation) return [];
    const occupiedIds = new Set<string>(); // se podría enriquecer con in-house ids
    return availableRooms.filter((r) => {
      if (occupiedIds.has(r.id)) return false;
      if (r.roomTypeId !== reservation.roomTypeId) return false;
      const hk = (r.housekeepingStatus ?? "").toLowerCase();
      const clean = hk === "clean" || hk === "inspected" || hk === "ready" || r.status === "clean";
      return clean;
    });
  }, [availableRooms, reservation]);

  // null = unknown (folio not loaded). The reservation total is NOT a balance:
  // it ignores deposits already captured, so it is never used as a fallback.
  const balanceDue: number | null = folio ? folio.balanceDue : null;
  const preauthAmount = Math.max(0, Math.round((reservation?.totalAmount ?? 0) * 100) / 100);
  const paymentRequiresFolio = paymentMode !== "none";

  // ------------------------------------------------------------- execute
  const canSubmit = Boolean(
    reservation && selectedRoomId && guest && reservation.status === "confirmed" && (folio || !paymentRequiresFolio)
  );
  const blockingReason = !reservation
    ? ""
    : reservation.status !== "confirmed"
    ? `Reserva en estado "${reservation.status}". No procede check-in.`
    : !selectedRoomId
    ? "Asigna una habitación primero."
    : !guest
    ? "Sin huésped principal vinculado."
    : !roomIsClean
    ? "La habitación seleccionada no está limpia. Cambia o avisa a housekeeping."
    : !folio && paymentRequiresFolio
    ? "No se pudo cargar el folio: reintenta o elige «Sin cobro» de forma explícita."
    : "";

  async function executeCheckIn() {
    if (!reservation || !selectedRoomId) return;
    setBusy(true);
    setError(null);
    logBreadcrumb("checkin.submitted", "mutation", {
      reservationId: reservation.id,
      paymentMode,
      reassignRoom: selectedRoomId !== reservation.assignedRoomId
    });
    try {
      // 1) Reassign si el room cambió.
      if (selectedRoomId !== reservation.assignedRoomId) {
        await apiRequest(`/reservations/${reservation.id}/assign-room`, {
          method: "POST",
          body: { roomId: selectedRoomId }
        });
      }
      // 2) Cobro previo si capture/preauth con saldo.
      // Auditoría 2026-07: antes `.catch(()=>undefined)` — si el cobro fallaba se
      // tragaba el error y el check-in seguía como si se hubiera cobrado. Ahora
      // un fallo de cobro ABORTA el check-in con error visible; el recepcionista
      // puede reintentar o elegir explícitamente "Sin cobro".
      // QC-06: sin folio cargado no se puede cobrar; la UI exige "Sin cobro"
      // explícito antes de llegar aquí, y este guard lo hace imposible de saltar.
      if (paymentMode !== "none" && !folio) {
        throw new Error("No se pudo cargar el folio: no es posible cobrar. Reintenta o elige «Sin cobro».");
      }
      if (paymentMode !== "none" && folio && balanceDue !== null && balanceDue > 0) {
        try {
          await apiRequest(`/folios/${folio.folio.id}/payments`, {
            method: "POST",
            body: {
              amount: paymentMode === "capture" ? balanceDue : preauthAmount,
              currency: reservation.currency || "EUR",
              method: paymentMethod,
              status: paymentMode === "capture" ? "captured" : "pending"
            }
          });
        } catch (err) {
          throw new Error(
            `No se pudo registrar el cobro (${err instanceof Error ? err.message : "error"}). ` +
              `El check-in NO se ha realizado. Reintenta o selecciona "Sin cobro".`
          );
        }
      }
      // 3) Check-in.
      await apiRequest(`/reservations/${reservation.id}/check-in`, {
        method: "POST",
        body: { roomId: selectedRoomId, signatureObjectKey: "sig_drawer_checkin" }
      });
      // 4) Parte de viajeros SES.HOSPEDAJES. The check-in is already done; the
      // queue response is read honestly (queued > 0 and no failed record) and
      // a 409 SES_ESTABLISHMENT_INCOMPLETE / failed[] is surfaced with the
      // missing establishment fields instead of a fake "enviado".
      let ses: SesQueueOutcome;
      try {
        ses = sesQueueOutcomeFromResponse(await queueSesSubmissions(reservation.propertyId, reservation.id));
      } catch (sesError) {
        ses = sesQueueOutcomeFromError(sesError);
      }
      setSesOutcome(ses);
      logBreadcrumb("checkin.ses", "mutation", { reservationId: reservation.id, outcome: ses.kind });

      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      const elapsedText = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;
      setCompleted({ elapsedSeconds: elapsed });
      onCompleted?.({ reservationId: reservation.id, elapsedSeconds: elapsed });
      if (ses.kind === "queued") {
        showToast(`Check-in completado en ${elapsedText} · parte de viajeros encolado en SES (${ses.queued}).`, { variant: "success" });
        window.setTimeout(() => onClose(), 2500);
      } else {
        // The drawer stays open: the operator must see what SES is missing.
        showToast(`Check-in completado en ${elapsedText}.`, { variant: "success" });
        showToast(sesOutcomeToast(ses), { variant: ses.kind === "no_records" ? "info" : "error", duration: 9000 });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Error ejecutando check-in";
      setError(message);
      showToast(message, { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  // =============================================================== render
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        justifyContent: "flex-end",
        zIndex: 60
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: "min(560px, 100vw)",
          height: "100%",
          background: "var(--surface)",
          color: "var(--ink)",
          boxShadow: "-8px 0 24px rgba(0,0,0,0.2)",
          display: "flex",
          flexDirection: "column"
        }}
      >
        {/* Header con cronómetro */}
        <div
          style={{
            padding: "12px 16px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <strong style={{ fontSize: 16 }}>Check-in</strong>
            <span
              className={`bo-status ${elapsedSeconds < 90 ? "ok" : elapsedSeconds < 120 ? "warn" : "error"}`}
              title="Objetivo: < 90 segundos"
            >
              ⏱ {elapsedLabel}
            </span>
            {completed ? <span className="bo-status ok">✓ Completado</span> : null}
          </div>
          <button type="button" className="ghost" onClick={onClose}>✕</button>
        </div>

        <div style={{ padding: 16, overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: 16 }}>
          {loading ? (
            <LoadingBlock label="Cargando reserva…" />
          ) : error ? (
            <p className="bo-status error">{error}</p>
          ) : !reservation ? (
            <p className="bo-status error">No se encontró la reserva.</p>
          ) : completed ? (
            <CompletedView elapsed={elapsedLabel} guest={fmtName(guest)} roomNumber={selectedRoom?.number} ses={sesOutcome} />
          ) : (
            <>
              {/* STEP 1: huésped + alertas */}
              <Section
                title="1 · Huésped"
                badge={guest?.vipCode ? "VIP" : priorStays > 0 ? "Recurrente" : undefined}
                badgeTone={guest?.vipCode ? "accent" : "info"}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <strong style={{ fontSize: 15 }}>{fmtName(guest)}</strong>
                  <div className="bo-muted" style={{ fontSize: 12 }}>
                    {guest?.documentType ?? "Documento"} {guest?.documentNumber ?? "—"} · {guest?.nationality ?? "?"}
                    {guest?.email ? ` · ${guest.email}` : ""}
                  </div>
                  {guest?.vipCode ? (
                    <div className="bo-status accent" style={{ marginTop: 4 }}>
                      ⭐ VIP {guest.vipCode}{guest.loyaltyTier ? ` · ${guest.loyaltyTier}` : ""}
                    </div>
                  ) : null}
                  {priorStays > 0 ? (
                    <div className="bo-status info" style={{ marginTop: 4 }}>
                      🔁 Cliente recurrente · {priorStays} estancias previas
                    </div>
                  ) : null}
                  {reservation.specialRequests || reservation.notes ? (
                    <div
                      style={{
                        marginTop: 6,
                        padding: "6px 8px",
                        background: "var(--surface-elevated, rgba(0,0,0,0.04))",
                        borderRadius: 6,
                        fontSize: 13
                      }}
                    >
                      💬 {reservation.specialRequests ?? reservation.notes}
                    </div>
                  ) : null}
                </div>
              </Section>

              {/* STEP 2: habitación */}
              <Section
                title="2 · Habitación"
                badge={roomIsClean ? "Limpia" : "No lista"}
                badgeTone={roomIsClean ? "ok" : "warning"}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div>
                    <strong>{selectedRoom ? `Hab. ${selectedRoom.number}` : "Sin asignar"}</strong>
                    {selectedRoom?.floor ? <span className="bo-muted" style={{ marginLeft: 6 }}>Planta {selectedRoom.floor}</span> : null}
                    {roomType ? <span className="bo-muted" style={{ marginLeft: 6 }}>· {roomType.name}</span> : null}
                  </div>
                  {!roomIsClean && candidateRooms.length > 0 ? (
                    <div
                      style={{
                        padding: "6px 8px",
                        borderLeft: "3px solid var(--warn, #d29b00)",
                        background: "var(--surface-elevated, rgba(0,0,0,0.03))",
                        fontSize: 13
                      }}
                    >
                      💡 Sugerencia: la {candidateRooms[0].number} está limpia y es del mismo tipo.{" "}
                      <button type="button" className="ghost" onClick={() => setSelectedRoomId(candidateRooms[0].id)}>
                        Cambiar a {candidateRooms[0].number}
                      </button>
                    </div>
                  ) : null}
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                    <span className="bo-muted">Cambiar habitación:</span>
                    <select
                      value={selectedRoomId ?? ""}
                      onChange={(e) => setSelectedRoomId(e.target.value || undefined)}
                      style={{ padding: 6 }}
                    >
                      <option value="">— Sin asignar —</option>
                      {candidateRooms.map((r) => (
                        <option key={r.id} value={r.id}>
                          Hab. {r.number} · planta {r.floor ?? "?"} · limpia
                        </option>
                      ))}
                      {selectedRoom && !candidateRooms.find((c) => c.id === selectedRoom.id) ? (
                        <option value={selectedRoom.id}>
                          Hab. {selectedRoom.number} · {(selectedRoom.housekeepingStatus ?? "desconocido")}
                        </option>
                      ) : null}
                    </select>
                  </label>
                </div>
              </Section>

              {/* STEP 3: pago */}
              <Section
                title="3 · Pago"
                badge={
                  folioLoading
                    ? "Cargando folio…"
                    : balanceDue === null
                    ? "Folio no disponible"
                    : balanceDue > 0
                    ? `${fmtEur(balanceDue)} pendiente`
                    : "Saldado"
                }
                badgeTone={folioLoading ? "info" : balanceDue === null ? "danger" : balanceDue > 0 ? "warning" : "ok"}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
                  {!folio && !folioLoading ? (
                    <div
                      style={{
                        padding: "6px 8px",
                        borderLeft: "3px solid var(--danger, #d23b3b)",
                        background: "var(--surface-elevated, rgba(0,0,0,0.03))"
                      }}
                    >
                      <div>No se pudo cargar el folio{folioError ? `: ${folioError}` : "."}</div>
                      <div className="bo-muted" style={{ fontSize: 12, marginTop: 2 }}>
                        Sin folio no se puede cobrar ni preautorizar. Reintenta o elige «Sin cobro» de forma explícita.
                      </div>
                      <div style={{ marginTop: 6 }}>
                        <button type="button" onClick={() => void loadFolio()} disabled={busy}>Reintentar</button>
                      </div>
                    </div>
                  ) : null}
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>Total estancia ({nightsBetween(reservation.arrivalDate, reservation.departureDate)} noches)</span>
                    <strong>{fmtEur(reservation.totalAmount)}</strong>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>Pagos hasta ahora</span>
                    <span>{folio ? fmtEur(folio.paymentsTotal) : "No disponible"}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>Saldo pendiente</span>
                    <strong>{balanceDue === null ? "No disponible (folio no cargado)" : fmtEur(balanceDue)}</strong>
                  </div>
                  <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      className={paymentMode === "preauth" ? "primary" : "ghost"}
                      onClick={() => setPaymentMode("preauth")}
                      disabled={!folio}
                      title={!folio ? "Requiere el folio cargado" : ""}
                    >
                      Preautorizar
                    </button>
                    <button
                      type="button"
                      className={paymentMode === "capture" ? "primary" : "ghost"}
                      onClick={() => setPaymentMode("capture")}
                      disabled={!folio}
                      title={!folio ? "Requiere el folio cargado" : ""}
                    >
                      Cobrar ahora
                    </button>
                    <button
                      type="button"
                      className={paymentMode === "none" ? "primary" : "ghost"}
                      onClick={() => setPaymentMode("none")}
                    >
                      Sin cobro
                    </button>
                  </div>
                  {paymentMode !== "none" ? (
                    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                      <span className="bo-muted">Método:</span>
                      <select
                        value={paymentMethod}
                        onChange={(e) => setPaymentMethod(e.target.value as "card" | "cash" | "bank_transfer")}
                        style={{ padding: 6 }}
                      >
                        <option value="card">Tarjeta</option>
                        <option value="cash">Efectivo</option>
                        <option value="bank_transfer">Transferencia</option>
                      </select>
                    </label>
                  ) : null}
                </div>
              </Section>

              {/* STEP 4: compliance */}
              <Section title="4 · Cumplimiento" badge="Al confirmar" badgeTone="info">
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "var(--ink)" }}>
                  <li>Al confirmar se encola el parte de viajeros (SES.HOSPEDAJES); aquí verás el resultado real del encolado.</li>
                  <li>Firma digital aplicada con sello "sig_drawer_checkin".</li>
                  <li>Política de cancelación: {reservation.cancellationPolicyCode ?? "estándar"}.</li>
                </ul>
              </Section>

              {blockingReason ? (
                <p className="bo-status warn">{blockingReason}</p>
              ) : null}
            </>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: 12,
            borderTop: "1px solid var(--border)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8
          }}
        >
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          {!completed ? (
            <button
              type="button"
              className="primary"
              disabled={!canSubmit || busy || !roomIsClean}
              onClick={executeCheckIn}
              title={blockingReason || "Pulsa para completar el check-in"}
            >
              {busy ? "Procesando…" : "Hacer check-in →"}
            </button>
          ) : (
            <button type="button" className="primary" onClick={onClose}>
              Cerrar
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// =============================================================== sub-components

function Section({
  title,
  badge,
  badgeTone,
  children
}: {
  title: string;
  badge?: string;
  badgeTone?: "ok" | "warning" | "danger" | "info" | "accent";
  children: React.ReactNode;
}) {
  const toneClass =
    badgeTone === "ok" ? "ok" :
    badgeTone === "warning" ? "warn" :
    badgeTone === "danger" ? "error" :
    badgeTone === "accent" ? "info" :
    "info";
  return (
    <section
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--muted, #888)" }}>{title}</strong>
        {badge ? <span className={`bo-status ${toneClass}`}>{badge}</span> : null}
      </div>
      {children}
    </section>
  );
}

/** Real SES queue outcome after the check-in: never claims "enviado" unless every record was queued. */
function SesOutcomeBlock({ outcome }: { outcome: SesQueueOutcome | null }) {
  if (!outcome) {
    return (
      <p className="bo-muted" style={{ fontSize: 12, margin: 0 }}>
        Sin resultado del parte de viajeros todavía.
      </p>
    );
  }
  if (outcome.kind === "queued") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "center" }}>
        <span className="bo-status ok">Parte de viajeros encolado en SES.HOSPEDAJES ({outcome.queued})</span>
        <p className="bo-muted" style={{ fontSize: 12, margin: 0 }}>
          Encolado no es aceptado: el envío real al MIR se ve en el Centro de envíos. Esta ventana se cierra automáticamente.
        </p>
      </div>
    );
  }
  const tone = outcome.kind === "no_records" ? "warn" : "error";
  const title =
    outcome.kind === "no_records"
      ? "No se ha encolado ningún parte de viajeros"
      : outcome.kind === "partial"
        ? `Parte SES parcial: ${outcome.queued} encolado${outcome.queued === 1 ? "" : "s"}, ${outcome.failed.length} sin encolar`
        : outcome.kind === "incomplete"
          ? "Parte SES no encolado: faltan datos del establecimiento"
          : "Parte SES no encolado";
  const missing = outcome.kind === "partial" || outcome.kind === "incomplete" ? outcome.missing : [];
  const detail =
    outcome.kind === "no_records"
      ? "La reserva no tiene registros de viajeros (SES_NO_GUEST_REGISTER_RECORDS). Completa el registro de viajeros y vuelve a encolar el parte desde la bandeja de cumplimiento."
      : outcome.kind === "error"
        ? `${outcome.message}${outcome.code ? ` (${outcome.code})` : ""}`
        : outcome.kind === "incomplete" && missing.length === 0
          ? outcome.message
          : null;
  // Per-parte server messages (failed[]), verbatim; the one already used as `detail` is not repeated.
  const failed = outcome.kind === "partial" || outcome.kind === "incomplete" || outcome.kind === "error" ? outcome.failed : [];
  const headlineMessage = outcome.kind === "incomplete" || outcome.kind === "error" ? outcome.message : null;
  const failureMessages = sesFailureMessages(failed).filter((message) => message !== headlineMessage);
  const failedCount = failed.length;
  return (
    <div
      style={{
        width: "100%",
        textAlign: "left",
        padding: "8px 10px",
        borderLeft: `3px solid ${tone === "error" ? "var(--danger, #d23b3b)" : "var(--warn, #d29b00)"}`,
        background: "var(--surface-elevated, rgba(0,0,0,0.03))",
        borderRadius: 6,
        fontSize: 13,
        display: "flex",
        flexDirection: "column",
        gap: 6
      }}
    >
      <span className={`bo-status ${tone}`} style={{ alignSelf: "flex-start" }}>{title}</span>
      {missing.length > 0 ? (
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {missing.map((issue) => (
            <li key={issue}>{sesEstablishmentIssueLabel(issue)}</li>
          ))}
        </ul>
      ) : null}
      {detail ? <div className="bo-muted" style={{ fontSize: 12 }}>{detail}</div> : null}
      {failureMessages.length > 0 ? (
        <div className="bo-muted" style={{ fontSize: 12 }}>
          Motivo{failedCount === 1 ? "" : "s"} del servidor ({failedCount} parte{failedCount === 1 ? "" : "s"} sin encolar):
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {failureMessages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {outcome.kind === "incomplete" || outcome.kind === "partial" ? (
          <button type="button" onClick={() => navigateTo("TaxComplianceSettings")}>Ajustes fiscales</button>
        ) : null}
        {outcome.kind === "no_records" ? (
          <button type="button" onClick={() => navigateTo("GuestRegisterSettings")}>Registro de huéspedes</button>
        ) : null}
        <button type="button" className="ghost" onClick={() => navigateTo("ComplianceInbox")}>Bandeja de cumplimiento</button>
      </div>
      <div className="bo-muted" style={{ fontSize: 12 }}>
        El check-in sí se ha realizado. Esta ventana no se cierra sola para que puedas revisar el parte.
      </div>
    </div>
  );
}

function CompletedView({ elapsed, guest, roomNumber, ses }: { elapsed: string; guest: string; roomNumber?: string; ses: SesQueueOutcome | null }) {
  return (
    <div
      style={{
        textAlign: "center",
        padding: "32px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        alignItems: "center"
      }}
    >
      <div style={{ fontSize: 48 }}>✓</div>
      <h3 style={{ margin: 0 }}>Check-in completado</h3>
      <p className="bo-muted" style={{ margin: 0 }}>
        {guest} alojado en {roomNumber ? `Hab. ${roomNumber}` : "su habitación"}.
      </p>
      <div className="bo-status ok">⏱ {elapsed} · objetivo &lt; 1:30</div>
      <SesOutcomeBlock outcome={ses} />
    </div>
  );
}
