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
//   - POST /folios/:id/payments (si saldo > 0 y no se eligió "Sin cobro")
//   - POST /reservations/:id/check-out (cierra folio + crea tarea HK + libera room)
//
// Tanda 2 · REC-08 / QC-06:
//   - El folio ya NO se traga a null: si no carga, error visible con reintento y
//     la opción explícita "Sin cobro" (el saldo se muestra como no disponible,
//     nunca como 0,00 € "Saldado").
//   - Si el API responde 409 BALANCE_DUE, el drawer muestra el saldo y ofrece
//     "Cobrar" o "Salir con saldo pendiente" (reintento con acknowledgeBalance).

import { useCallback, useEffect, useMemo, useState } from "react";
import { useToast } from "../../components/Toast";
import { LoadingBlock } from "../../components/States";
import { apiRequest } from "../../services/api-client";
import { balanceDueConflict, type BalanceDueConflict } from "../../services/pmsCommerceApi";
import { logBreadcrumb } from "../../lib/breadcrumb";
import { DEFAULT_CURRENCY, money } from "../../lib/format";

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

// Payment method values match the API PaymentRecord.method union.
type PaymentMethod = "card" | "cash" | "bank_transfer";

function fmtEur(value: number | undefined | null): string {
  return money(value);
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
  const [folioError, setFolioError] = useState<string | null>(null);
  const [folioLoading, setFolioLoading] = useState(false);
  const [room, setRoom] = useState<Room | null>(null);

  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("card");
  // Explicit operator choice to leave without collecting (required when the
  // folio could not be loaded; optional otherwise).
  const [skipPayment, setSkipPayment] = useState(false);
  const [issueInvoice, setIssueInvoice] = useState(true);
  const [notifyHousekeeping, setNotifyHousekeeping] = useState(true);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState<{ elapsedSeconds: number } | null>(null);
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
  const elapsedSeconds = completed ? completed.elapsedSeconds : Math.floor((Date.now() - startedAt) / 1000);
  const elapsedLabel = `${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, "0")}`;

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
      const [, rooms] = await Promise.all([
        loadFolio(),
        res.assignedRoomId
          ? // best-effort: rooms only feed the "Hab. 101" label in the header.
            apiRequest<Room[]>(`/properties/${res.propertyId}/rooms`).catch(() => [] as Room[])
          : Promise.resolve([] as Room[])
      ]);
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
  }, [reservationId, loadFolio]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // null = unknown (folio not loaded); never fall back to 0.
  const balanceDue: number | null = folio ? folio.balanceDue : null;
  const hasBalance = balanceDue !== null && balanceDue > 0.01;
  const willCollect = hasBalance && !skipPayment;
  const canSubmit = Boolean(reservation && reservation.status === "checked_in" && (folio || skipPayment));
  const blockingReason = !reservation
    ? ""
    : reservation.status !== "checked_in"
    ? `Reserva en estado "${reservation.status}". No procede check-out.`
    : !folio && !skipPayment
    ? "No se pudo cargar el folio: reintenta o elige «Sin cobro» de forma explícita."
    : "";

  // `collectAmount` overrides the derived decision (used by the 409 prompt so
  // the retry does not depend on state updates that have not rendered yet):
  // a positive number collects that amount first; null skips the payment.
  async function executeCheckOut(options: { acknowledgeBalance?: boolean; collectAmount?: number | null } = {}) {
    if (!reservation) return;
    if (!folio && !skipPayment) return;
    const amountToCollect =
      options.collectAmount !== undefined ? options.collectAmount : willCollect ? balanceDue : null;
    const collecting = Boolean(folio) && amountToCollect !== null && amountToCollect > 0.01 && !options.acknowledgeBalance;
    setBusy(true);
    setError(null);
    setBalancePrompt(null);
    logBreadcrumb("checkout.submitted", "mutation", {
      reservationId: reservation.id,
      balanceDue,
      skipPayment,
      acknowledgeBalance: Boolean(options.acknowledgeBalance),
      issueInvoice,
      paymentMethod: collecting ? paymentMethod : undefined
    });
    try {
      // 1) Cobrar saldo si > 0 y no se eligió "Sin cobro".
      // Auditoría 2026-07: antes `.catch(()=>undefined)` — si el cobro fallaba se
      // tragaba el error, el check-out CERRABA el folio igualmente y mostraba
      // "completado" con saldo sin cobrar. Un fallo de cobro ahora ABORTA el
      // check-out con error visible; el folio sigue abierto.
      if (folio && collecting) {
        try {
          await apiRequest(`/folios/${folio.folio.id}/payments`, {
            method: "POST",
            body: {
              amount: amountToCollect,
              currency: reservation.currency || DEFAULT_CURRENCY,
              method: paymentMethod,
              status: "captured"
            }
          });
        } catch (err) {
          throw new Error(
            `No se pudo registrar el cobro del saldo (${err instanceof Error ? err.message : "error"}). ` +
              `El check-out NO se ha realizado; el folio sigue abierto.`
          );
        }
      }
      // 2) Check-out (el endpoint cierra el folio + crea tarea departure HK).
      //    Con saldo pendiente responde 409 BALANCE_DUE salvo acknowledgeBalance.
      await apiRequest(`/reservations/${reservation.id}/check-out`, {
        method: "POST",
        body: { acknowledgeBalance: options.acknowledgeBalance }
      });
      // 3) Emitir factura (background). Ya no silencioso: si falla, se avisa
      // para que el operador la emita desde Facturación.
      if (issueInvoice) {
        if (folio) {
          void apiRequest(`/folios/${folio.folio.id}/invoice`, {
            method: "POST",
            body: { customerType: "guest" }
          })
            .then(() => showToast("Factura solicitada", { variant: "info" }))
            .catch(() => {
              showToast(
                "Check-out hecho, pero la factura NO se pudo emitir. Emítela desde Facturación.",
                { variant: "error" }
              );
            });
        } else {
          showToast("Check-out hecho sin folio cargado: emite la factura desde Facturación.", { variant: "info" });
        }
      }
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      setCompleted({ elapsedSeconds: elapsed });
      onCompleted?.({ reservationId: reservation.id, elapsedSeconds: elapsed });
      showToast(`Check-out completado en ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`, { variant: "success" });
      window.setTimeout(() => onClose(), 2500);
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

  const ctaLabel = busy
    ? "Procesando…"
    : !folio
    ? "Salir sin cobro →"
    : willCollect
    ? `Cobrar ${fmtEur(balanceDue)} y cerrar`
    : hasBalance
    ? "Salir sin cobrar →"
    : "Hacer check-out →";

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
          ) : !reservation ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <p className="bo-status error">{error ?? "No se encontró la reserva."}</p>
              <button type="button" onClick={() => void loadAll()} disabled={busy}>Reintentar</button>
            </div>
          ) : completed ? (
            <CompletedView elapsed={elapsedLabel} roomNumber={room?.number} />
          ) : (
            <>
              {error ? <p className="bo-status error">{error}</p> : null}

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
              <Section
                title="1 · Folio"
                badge={folio ? `${folio.lines.length} líneas` : folioLoading ? "Cargando…" : "No disponible"}
                badgeTone={folio ? "info" : folioLoading ? "info" : "danger"}
              >
                {folioLoading ? (
                  <LoadingBlock label="Cargando folio…" />
                ) : !folio ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <p className="bo-status error" style={{ margin: 0 }}>
                      No se pudo cargar el folio{folioError ? `: ${folioError}` : "."}
                    </p>
                    <p className="bo-muted" style={{ fontSize: 12, margin: 0 }}>
                      Sin folio no es posible cobrar ni saber el saldo real. Reintenta o elige «Sin cobro» para salir sin cobrar.
                    </p>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button type="button" onClick={() => void loadFolio()} disabled={busy}>Reintentar</button>
                      <button
                        type="button"
                        className={skipPayment ? "primary" : "ghost"}
                        onClick={() => setSkipPayment(true)}
                        disabled={busy}
                      >
                        Sin cobro
                      </button>
                    </div>
                  </div>
                ) : folio.lines.length > 0 ? (
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
                        <td style={{ padding: "6px 0", textAlign: "right", fontWeight: 700, color: hasBalance ? "var(--danger, #d23b3b)" : "var(--ok, #1f8a4c)" }}>
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
                badge={!folio ? "Saldo no disponible" : hasBalance ? (skipPayment ? "Sin cobro" : "Saldo abierto") : "Saldado"}
                badgeTone={!folio ? "danger" : hasBalance ? "warning" : "ok"}
              >
                {!folio ? (
                  <p style={{ fontSize: 13, margin: 0 }}>
                    {skipPayment
                      ? "Has elegido salir sin cobrar. El saldo real se comprobará en el servidor: si queda importe pendiente te lo mostraremos antes de cerrar."
                      : "El saldo no está disponible porque el folio no se ha cargado."}
                  </p>
                ) : hasBalance ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={{ fontSize: 13 }}>
                      Importe a cobrar: <strong>{fmtEur(balanceDue)}</strong>
                    </div>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                      <span className="bo-muted">Método:</span>
                      <select
                        value={paymentMethod}
                        onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
                        style={{ padding: 6 }}
                        disabled={skipPayment}
                      >
                        <option value="card">Tarjeta</option>
                        <option value="cash">Efectivo</option>
                        <option value="bank_transfer">Transferencia</option>
                      </select>
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                      <input type="checkbox" checked={skipPayment} onChange={(e) => setSkipPayment(e.target.checked)} />
                      Sin cobro ahora (el huésped saldrá con saldo pendiente)
                    </label>
                  </div>
                ) : (
                  <p style={{ fontSize: 13, margin: 0 }}>El folio está saldado. No hay nada que cobrar.</p>
                )}
              </Section>

              {/* 409 BALANCE_DUE: decide before retrying */}
              {balancePrompt ? (
                <Section title="Saldo pendiente detectado" badge="Confirmar" badgeTone="warning">
                  <p style={{ fontSize: 13, margin: 0 }}>
                    {balancePrompt.message}
                    {balancePrompt.balanceDue !== null ? ` Saldo: ${fmtEur(balancePrompt.balanceDue)}.` : ""}
                  </p>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {folio ? (
                      <button
                        type="button"
                        className="primary"
                        disabled={busy}
                        onClick={() => {
                          // The API-reported balance is authoritative; the folio one is the fallback.
                          setSkipPayment(false);
                          void executeCheckOut({ collectAmount: balancePrompt.balanceDue ?? balanceDue });
                        }}
                      >
                        Cobrar {fmtEur(balancePrompt.balanceDue ?? balanceDue)} y cerrar
                      </button>
                    ) : null}
                    <button type="button" disabled={busy} onClick={() => void executeCheckOut({ acknowledgeBalance: true })}>
                      Salir con saldo pendiente
                    </button>
                    <button type="button" className="ghost" disabled={busy} onClick={() => setBalancePrompt(null)}>
                      Cancelar
                    </button>
                  </div>
                </Section>
              ) : null}

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
              disabled={!canSubmit || busy || Boolean(balancePrompt)}
              onClick={() => void executeCheckOut()}
              title={blockingReason || "Pulsa para completar el check-out"}
            >
              {ctaLabel}
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
