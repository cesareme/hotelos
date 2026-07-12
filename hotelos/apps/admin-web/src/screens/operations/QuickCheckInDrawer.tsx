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
//   - (background) /properties/:id/ses/submissions
// Mostramos cronómetro: la directriz exige < 90 s.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useToast } from "../../components/Toast";
import { LoadingBlock } from "../../components/States";
import { apiRequest } from "../../services/api-client";
import { logBreadcrumb } from "../../lib/breadcrumb";

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

// =============================================================== component

export function QuickCheckInDrawer({ reservationId, onClose, onCompleted }: QuickCheckInProps) {
  const { showToast } = useToast();
  const [reservation, setReservation] = useState<Reservation | null>(null);
  const [guest, setGuest] = useState<Guest | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [roomType, setRoomType] = useState<RoomType | null>(null);
  const [folio, setFolio] = useState<FolioBalance | null>(null);
  const [availableRooms, setAvailableRooms] = useState<Room[]>([]);
  const [priorStays, setPriorStays] = useState<number>(0);

  const [selectedRoomId, setSelectedRoomId] = useState<string | undefined>(undefined);
  const [paymentMode, setPaymentMode] = useState<"none" | "preauth" | "capture">("preauth");
  const [paymentMethod, setPaymentMethod] = useState<"card" | "cash" | "transfer">("card");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState<{ elapsedSeconds: number } | null>(null);

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
  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiRequest<Reservation>(`/reservations/${reservationId}`);
      setReservation(res);
      setSelectedRoomId(res.assignedRoomId);

      // Parallel fetches
      const [folioData, roomsData, roomTypesData] = await Promise.all([
        apiRequest<FolioBalance>(`/reservations/${reservationId}/folio`).catch(() => null),
        apiRequest<Room[]>(`/properties/${res.propertyId}/rooms`),
        apiRequest<RoomType[]>(`/properties/${res.propertyId}/room-types`)
      ]);
      setFolio(folioData);
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

      // Stays anteriores (cliente recurrente) — best effort.
      const reservationGuestsList = await apiRequest<Array<{ guestId: string; reservation: { propertyId: string; status: string; departureDate: string } }>>(
        `/reservations/${reservationId}/guest-history`
      ).catch(() => []);
      setPriorStays(reservationGuestsList.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error cargando reserva");
    } finally {
      setLoading(false);
    }
  }, [reservationId]);

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

  const balanceDue = folio?.balanceDue ?? (reservation?.totalAmount ?? 0) - 0;
  const preauthAmount = Math.max(0, Math.round((reservation?.totalAmount ?? 0) * 100) / 100);

  // ------------------------------------------------------------- execute
  const canSubmit = Boolean(reservation && selectedRoomId && guest && reservation.status === "confirmed");
  const blockingReason = !reservation
    ? "Cargando…"
    : reservation.status !== "confirmed"
    ? `Reserva en estado "${reservation.status}". No procede check-in.`
    : !selectedRoomId
    ? "Asigna una habitación primero."
    : !guest
    ? "Sin huésped principal vinculado."
    : !roomIsClean
    ? "La habitación seleccionada no está limpia. Cambia o avisa a housekeeping."
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
      if (paymentMode !== "none" && folio && balanceDue > 0) {
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
      // 4) Parte de viajeros SES (no bloqueante, pero YA no silencioso): si el
      // envío no se puede encolar, se avisa al operador en vez de fingir éxito.
      void apiRequest(`/properties/${reservation.propertyId}/ses/submissions`, {
        method: "POST",
        body: { reservationId: reservation.id }
      }).catch(() => {
        showToast(
          "Check-in hecho, pero el parte de viajeros (SES) no se pudo enviar. Revísalo en Cumplimiento.",
          { variant: "error" }
        );
      });

      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      setCompleted({ elapsedSeconds: elapsed });
      onCompleted?.({ reservationId: reservation.id, elapsedSeconds: elapsed });
      showToast(`Check-in completado en ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`, { variant: "success" });
      window.setTimeout(() => onClose(), 2500);
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
            <CompletedView elapsed={elapsedLabel} guest={fmtName(guest)} roomNumber={selectedRoom?.number} />
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
                badge={balanceDue > 0 ? `${fmtEur(balanceDue)} pendiente` : "Saldado"}
                badgeTone={balanceDue > 0 ? "warning" : "ok"}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>Total estancia ({nightsBetween(reservation.arrivalDate, reservation.departureDate)} noches)</span>
                    <strong>{fmtEur(reservation.totalAmount)}</strong>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>Pagos hasta ahora</span>
                    <span>{fmtEur(folio?.paymentsTotal ?? 0)}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>Saldo pendiente</span>
                    <strong>{fmtEur(balanceDue)}</strong>
                  </div>
                  <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      className={paymentMode === "preauth" ? "primary" : "ghost"}
                      onClick={() => setPaymentMode("preauth")}
                    >
                      Preautorizar
                    </button>
                    <button
                      type="button"
                      className={paymentMode === "capture" ? "primary" : "ghost"}
                      onClick={() => setPaymentMode("capture")}
                    >
                      Cobrar ahora
                    </button>
                    <button
                      type="button"
                      className={paymentMode === "none" ? "primary" : "ghost"}
                      onClick={() => setPaymentMode("none")}
                    >
                      Saltar
                    </button>
                  </div>
                  {paymentMode !== "none" ? (
                    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                      <span className="bo-muted">Método:</span>
                      <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as never)} style={{ padding: 6 }}>
                        <option value="card">Tarjeta</option>
                        <option value="cash">Efectivo</option>
                        <option value="transfer">Transferencia</option>
                      </select>
                    </label>
                  ) : null}
                </div>
              </Section>

              {/* STEP 4: compliance */}
              <Section title="4 · Cumplimiento" badge="Auto" badgeTone="info">
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "var(--ink)" }}>
                  <li>Parte viajeros (SES Hospedajes) se envía automáticamente al confirmar.</li>
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

function CompletedView({ elapsed, guest, roomNumber }: { elapsed: string; guest: string; roomNumber?: string }) {
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
      <p className="bo-muted" style={{ fontSize: 12, margin: 0 }}>
        El parte viajeros se envía a SES en background. Esta ventana se cierra automáticamente.
      </p>
    </div>
  );
}
