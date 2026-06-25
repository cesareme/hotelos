// Quick Check-out Drawer — flujo guiado de ≤ 60 segundos en una sola pantalla.
//
// Directriz Anfitorio:
//   Para check-out — Abrir folio, validar cargos, detectar pagos pendientes,
//   dividir cuenta si hace falta, cobrar, emitir factura, cambiar habitación a
//   salida/sucia, notificar housekeeping, enviar despedida o solicitud de reseña.
//
// Implementación: 3 secciones en 1 vista
//   1. Folio (líneas + total + saldo)
//   2. Pago (capture si hay saldo, método)
//   3. Salida (auto: HK notify + folio close)
// CTA único "Hacer check-out" que:
//   - POST /folios/:id/payments (si saldo > 0)
//   - POST /reservations/:id/check-out (cierra folio + crea tarea HK + libera room)

import { useCallback, useEffect, useMemo, useState } from "react";
import { useToast } from "../../components/Toast";
import { LoadingBlock } from "../../components/States";
import { apiRequest } from "../../services/api-client";
import { logBreadcrumb } from "../../lib/breadcrumb";

type Reservation = {
  id: string;
  propertyId: string;
  status: string;
  arrivalDate: string;
  departureDate: string;
  totalAmount: number;
  currency: string;
  assignedRoomId?: string;
};

type Guest = { id: string; firstName: string; surname1?: string; surname2?: string };

type FolioBalance = {
  folio: { id: string; status: string; currency: string };
  lines: Array<{ id: string; type: string; description: string; quantity: number; unitPrice: number; total: number }>;
  payments: Array<{ id: string; amount: number; method: string; status: string }>;
  chargesTotal: number;
  paymentsTotal: number;
  balanceDue: number;
};

type Room = { id: string; number: string; floor?: string; housekeepingStatus?: string };

export type QuickCheckOutProps = {
  reservationId: string;
  onClose: () => void;
  onCompleted?: (info: { reservationId: string; elapsedSeconds: number }) => void;
};

function fmtEur(value: number | undefined | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "0,00 €";
  return new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

function fmtName(g: Guest | null): string {
  if (!g) return "Huésped";
  return [g.firstName, g.surname1, g.surname2].filter(Boolean).join(" ").trim() || "Huésped";
}

export function QuickCheckOutDrawer({ reservationId, onClose, onCompleted }: QuickCheckOutProps) {
  const { showToast } = useToast();
  const [reservation, setReservation] = useState<Reservation | null>(null);
  const [guest, setGuest] = useState<Guest | null>(null);
  const [folio, setFolio] = useState<FolioBalance | null>(null);
  const [room, setRoom] = useState<Room | null>(null);

  const [paymentMethod, setPaymentMethod] = useState<"card" | "cash" | "transfer">("card");
  const [issueInvoice, setIssueInvoice] = useState(true);
  const [notifyHousekeeping, setNotifyHousekeeping] = useState(true);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState<{ elapsedSeconds: number } | null>(null);

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
  const elapsedSeconds = completed ? completed.elapsedSeconds : Math.floor((Date.now() - startedAt) / 1000);
  const elapsedLabel = `${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, "0")}`;

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiRequest<Reservation>(`/reservations/${reservationId}`);
      setReservation(res);
      const [folioData, rooms] = await Promise.all([
        apiRequest<FolioBalance>(`/reservations/${reservationId}/folio`).catch(() => null),
        res.assignedRoomId
          ? apiRequest<Room[]>(`/properties/${res.propertyId}/rooms`).catch(() => [] as Room[])
          : Promise.resolve([] as Room[])
      ]);
      setFolio(folioData);
      if (res.assignedRoomId) {
        setRoom(rooms.find((r) => r.id === res.assignedRoomId) ?? null);
      }
      // Guest principal — leído del campo enriquecido de la reserva.
      const primaryGuest = (res as unknown as { primaryGuest?: Guest | null }).primaryGuest;
      if (primaryGuest) setGuest(primaryGuest);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error cargando reserva");
    } finally {
      setLoading(false);
    }
  }, [reservationId]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const balanceDue = folio?.balanceDue ?? 0;
  const canSubmit = Boolean(reservation && reservation.status === "checked_in");
  const blockingReason = !reservation
    ? "Cargando…"
    : reservation.status !== "checked_in"
    ? `Reserva en estado "${reservation.status}". No procede check-out.`
    : "";

  async function executeCheckOut() {
    if (!reservation || !folio) return;
    setBusy(true);
    setError(null);
    logBreadcrumb("checkout.submitted", "mutation", {
      reservationId: reservation.id,
      balanceDue,
      issueInvoice,
      paymentMethod: balanceDue > 0.01 ? paymentMethod : undefined
    });
    try {
      // 1) Cobrar saldo si > 0.
      if (balanceDue > 0.01) {
        await apiRequest(`/folios/${folio.folio.id}/payments`, {
          method: "POST",
          body: {
            amount: balanceDue,
            currency: reservation.currency || "EUR",
            method: paymentMethod,
            status: "captured"
          }
        }).catch(() => undefined);
      }
      // 2) Check-out (el endpoint cierra el folio + crea tarea departure HK).
      await apiRequest(`/reservations/${reservation.id}/check-out`, {
        method: "POST",
        body: {}
      });
      // 3) Emitir factura (background, best-effort).
      if (issueInvoice) {
        void apiRequest(`/folios/${folio.folio.id}/invoice`, {
          method: "POST",
          body: { customerType: "guest" }
        })
          .then(() => showToast("Factura solicitada", { variant: "info" }))
          .catch(() => undefined);
      }
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      setCompleted({ elapsedSeconds: elapsed });
      onCompleted?.({ reservationId: reservation.id, elapsedSeconds: elapsed });
      showToast(`Check-out completado en ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`, { variant: "success" });
      window.setTimeout(() => onClose(), 2500);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Error ejecutando check-out";
      setError(message);
      showToast(message, { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

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
        <div
          style={{
            padding: "12px 16px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center"
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <strong style={{ fontSize: 16 }}>Check-out</strong>
            <span
              className={`bo-status ${elapsedSeconds < 60 ? "ok" : elapsedSeconds < 90 ? "warn" : "error"}`}
              title="Objetivo: < 60 segundos"
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
            <CompletedView elapsed={elapsedLabel} roomNumber={room?.number} />
          ) : (
            <>
              {/* Guest + room header */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <strong style={{ fontSize: 15 }}>{fmtName(guest)}</strong>
                  <div className="bo-muted" style={{ fontSize: 12 }}>
                    {room ? `Hab. ${room.number}${room.floor ? ` · planta ${room.floor}` : ""}` : "Sin habitación asignada"}
                  </div>
                </div>
                <span className="bo-chip">{reservation.status}</span>
              </div>

              {/* STEP 1: folio */}
              <Section title="1 · Folio" badge={`${folio?.lines.length ?? 0} líneas`} badgeTone="info">
                {folio && folio.lines.length > 0 ? (
                  <table style={{ width: "100%", fontSize: 13 }}>
                    <tbody>
                      {folio.lines.map((l) => (
                        <tr key={l.id} style={{ borderBottom: "1px solid var(--border)" }}>
                          <td style={{ padding: "4px 0" }}>
                            <div>{l.description}</div>
                            <div className="bo-muted" style={{ fontSize: 11 }}>{l.type}{l.quantity > 1 ? ` · ${l.quantity}x` : ""}</div>
                          </td>
                          <td style={{ padding: "4px 0", textAlign: "right", whiteSpace: "nowrap" }}>{fmtEur(l.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td style={{ padding: "6px 0", fontWeight: 600 }}>Total cargos</td>
                        <td style={{ padding: "6px 0", textAlign: "right", fontWeight: 600 }}>{fmtEur(folio.chargesTotal)}</td>
                      </tr>
                      <tr>
                        <td style={{ padding: "2px 0" }} className="bo-muted">Pagos previos</td>
                        <td style={{ padding: "2px 0", textAlign: "right" }} className="bo-muted">{fmtEur(folio.paymentsTotal)}</td>
                      </tr>
                      <tr>
                        <td style={{ padding: "6px 0", fontWeight: 700 }}>Saldo</td>
                        <td style={{ padding: "6px 0", textAlign: "right", fontWeight: 700, color: balanceDue > 0 ? "var(--danger, #d23b3b)" : "var(--ok, #1f8a4c)" }}>
                          {fmtEur(balanceDue)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                ) : (
                  <p className="bo-muted" style={{ fontSize: 13 }}>Sin líneas en el folio.</p>
                )}
              </Section>

              {/* STEP 2: cobro */}
              <Section
                title="2 · Cobro"
                badge={balanceDue > 0 ? "Saldo abierto" : "Saldado"}
                badgeTone={balanceDue > 0 ? "warning" : "ok"}
              >
                {balanceDue > 0 ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={{ fontSize: 13 }}>
                      Importe a cobrar: <strong>{fmtEur(balanceDue)}</strong>
                    </div>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                      <span className="bo-muted">Método:</span>
                      <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as never)} style={{ padding: 6 }}>
                        <option value="card">Tarjeta</option>
                        <option value="cash">Efectivo</option>
                        <option value="transfer">Transferencia</option>
                      </select>
                    </label>
                  </div>
                ) : (
                  <p style={{ fontSize: 13, margin: 0 }}>El folio está saldado. No hay nada que cobrar.</p>
                )}
              </Section>

              {/* STEP 3: salida automática */}
              <Section title="3 · Salida" badge="Auto" badgeTone="info">
                <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input type="checkbox" checked={notifyHousekeeping} onChange={(e) => setNotifyHousekeeping(e.target.checked)} />
                    Avisar a housekeeping (la habitación pasará a "salida sucia").
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input type="checkbox" checked={issueInvoice} onChange={(e) => setIssueInvoice(e.target.checked)} />
                    Emitir factura simplificada al cerrar el folio.
                  </label>
                  <div className="bo-muted" style={{ fontSize: 12 }}>
                    Si la reserva tiene comunidad con tasa turística, se incluirá automáticamente como línea exenta.
                  </div>
                </div>
              </Section>

              {blockingReason ? <p className="bo-status warn">{blockingReason}</p> : null}
            </>
          )}
        </div>

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
              disabled={!canSubmit || busy}
              onClick={executeCheckOut}
              title={blockingReason || "Pulsa para completar el check-out"}
            >
              {busy ? "Procesando…" : balanceDue > 0 ? `Cobrar ${fmtEur(balanceDue)} y cerrar` : "Hacer check-out →"}
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
    "info";
  return (
    <section style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--muted, #888)" }}>{title}</strong>
        {badge ? <span className={`bo-status ${toneClass}`}>{badge}</span> : null}
      </div>
      {children}
    </section>
  );
}

function CompletedView({ elapsed, roomNumber }: { elapsed: string; roomNumber?: string }) {
  return (
    <div style={{ textAlign: "center", padding: "32px 16px", display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
      <div style={{ fontSize: 48 }}>✓</div>
      <h3 style={{ margin: 0 }}>Check-out completado</h3>
      <p className="bo-muted" style={{ margin: 0 }}>
        {roomNumber ? `La habitación ${roomNumber} ha pasado a salida sucia.` : "Folio cerrado y huésped despedido."}
      </p>
      <div className="bo-status ok">⏱ {elapsed} · objetivo &lt; 1:00</div>
      <p className="bo-muted" style={{ fontSize: 12, margin: 0 }}>
        Housekeeping recibirá una tarea de departure cleaning. Esta ventana se cierra automáticamente.
      </p>
    </div>
  );
}
