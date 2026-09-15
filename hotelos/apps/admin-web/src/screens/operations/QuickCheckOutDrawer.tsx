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
//
// Cocoa 22 (ola 2 · lote 2-A): `CocoaDrawer` panel (portal, scrim, focus
// trap, Esc, bottom sheet on phones); steps as `CocoaSection` with a badge
// meta; folio lines in a `CocoaTable` + totals list; `CocoaSwitch` for the
// operator choices; 409 prompt as a `CocoaCallout` banner. Same endpoints.

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useToast } from "../../components/Toast";
import { apiRequest } from "../../services/api-client";
import { balanceDueConflict, type BalanceDueConflict } from "../../services/pmsCommerceApi";
import { logBreadcrumb } from "../../lib/breadcrumb";
import { reservationStatusLabel } from "./frontdesk-labels";
import { DEFAULT_CURRENCY, money, plural } from "../../lib/format";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { ClockIcon } from "../../components/cocoa-icons/StatusIcons";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDrawer,
  CocoaField,
  CocoaSection,
  CocoaSelect,
  CocoaState,
  CocoaSwitch,
  CocoaTable,
  toneInk,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

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

export type QuickCheckOutProps = {
  reservationId: string;
  onClose: () => void;
  onCompleted?: (info: { reservationId: string; elapsedSeconds: number }) => void;
};

// Payment method values match the API PaymentRecord.method union.
type PaymentMethod = "card" | "cash" | "bank_transfer";

const PAYMENT_METHOD_OPTIONS = [
  { value: "card", label: "Tarjeta" },
  { value: "cash", label: "Efectivo" },
  { value: "bank_transfer", label: "Transferencia" }
];

function fmtEur(value: number | undefined | null): string {
  return money(value);
}

function fmtName(g: Guest | null): string {
  if (!g) return "Huésped";
  return [g.firstName, g.surname1, g.surname2].filter(Boolean).join(" ").trim() || "Huésped";
}

function elapsedText(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const mutedStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--cocoa-fs-caption)",
  color: "var(--cocoa-label-secondary)"
};

const nameStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-headline)",
  fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"],
  color: "var(--cocoa-label)"
};

const bodyTextStyle: CSSProperties = { margin: 0, fontSize: "var(--cocoa-fs-body)", color: "var(--cocoa-label)" };

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
        <span style={mutedStyle}>
          {line.type}
          {line.quantity > 1 ? ` · ${line.quantity}x` : ""}
        </span>
      </div>
    )
  },
  { key: "total", label: "Importe", align: "right", width: "12ch", render: (line) => fmtEur(line.total) }
];

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
  void tick;
  const elapsedSeconds = completed ? completed.elapsedSeconds : Math.floor((Date.now() - startedAt) / 1000);
  const elapsedLabel = elapsedText(elapsedSeconds);
  const timerTone: CocoaTone = elapsedSeconds < 60 ? "success" : elapsedSeconds < 90 ? "warning" : "danger";

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
    ? `Reserva en estado «${reservationStatusLabel(reservation.status)}»: el check-out solo procede con la reserva en casa.`
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
      showToast(`Check-out completado en ${elapsedText(elapsed)}`, { variant: "success" });
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

  const ctaLabel = !folio
    ? "Salir sin cobro"
    : willCollect
    ? `Cobrar ${fmtEur(balanceDue)} y cerrar`
    : hasBalance
    ? "Salir sin cobrar"
    : "Hacer check-out";

  let body: ReactNode;
  if (loading) {
    body = <CocoaState kind="loading" title="Cargando reserva…" />;
  } else if (!reservation) {
    body = <CocoaState kind="error" title={STATUS_LABELS.loadError} message={error ?? "No se encontró la reserva."} onRetry={() => void loadAll()} />;
  } else if (completed) {
    body = <CompletedView elapsed={elapsedLabel} roomNumber={room?.number} />;
  } else {
    body = (
      <>
        {error ? <CocoaCallout tone="danger" role="alert">{error}</CocoaCallout> : null}

        {/* Guest + room header */}
        <div className="cocoa-row" data-gap="2" data-justify="between">
          <div className="cocoa-stack" data-gap="1">
            <strong style={nameStyle}>{fmtName(guest)}</strong>
            <span style={mutedStyle}>{room ? `Hab. ${room.number}${room.floor ? ` · planta ${room.floor}` : ""}` : "Sin habitación asignada"}</span>
          </div>
          <CocoaBadge tone="neutral" size="small">
            {reservation.status}
          </CocoaBadge>
        </div>

        {/* STEP 1: folio */}
        <Step
          title="1 · Folio"
          badge={folio ? plural(folio.lines.length, "línea", "líneas") : folioLoading ? STATUS_LABELS.loading : "No disponible"}
          badgeTone={folio ? "info" : folioLoading ? "info" : "danger"}
        >
          {folioLoading ? (
            <CocoaState kind="loading" title="Cargando folio…" />
          ) : !folio ? (
            <CocoaCallout
              tone="danger"
              title={`No se pudo cargar el folio${folioError ? `: ${folioError}` : "."}`}
              actions={
                <>
                  <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void loadFolio()} disabled={busy}>
                    {ACTIONS.retry}
                  </CocoaButton>
                  <CocoaButton variant={skipPayment ? "filled" : "tinted"} tone="accent" size="small" onClick={() => setSkipPayment(true)} disabled={busy} aria-pressed={skipPayment}>
                    Sin cobro
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
                  <span style={mutedStyle}>Pagos previos</span>
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
        <Step
          title="2 · Cobro"
          badge={!folio ? "Saldo no disponible" : hasBalance ? (skipPayment ? "Sin cobro" : "Saldo abierto") : "Saldado"}
          badgeTone={!folio ? "danger" : hasBalance ? "warning" : "success"}
        >
          {!folio ? (
            <p style={bodyTextStyle}>
              {skipPayment
                ? "Has elegido salir sin cobrar. El saldo real se comprobará en el servidor: si queda importe pendiente te lo mostraremos antes de cerrar."
                : "El saldo no está disponible porque el folio no se ha cargado."}
            </p>
          ) : hasBalance ? (
            <div className="cocoa-stack" data-gap="2">
              <p style={bodyTextStyle}>
                Importe a cobrar: <strong>{fmtEur(balanceDue)}</strong>
              </p>
              <CocoaField label="Método">
                <CocoaSelect value={paymentMethod} onChange={(value) => setPaymentMethod(value as PaymentMethod)} options={PAYMENT_METHOD_OPTIONS} disabled={skipPayment} />
              </CocoaField>
              <CocoaSwitch checked={skipPayment} onChange={setSkipPayment} label="Sin cobro ahora (el huésped saldrá con saldo pendiente)" />
            </div>
          ) : (
            <p style={bodyTextStyle}>El folio está saldado. No hay nada que cobrar.</p>
          )}
        </Step>

        {/* 409 BALANCE_DUE: decide before retrying */}
        {balancePrompt ? (
          <CocoaCallout tone="warning" variant="banner" title="Saldo pendiente detectado" role="alert">
            <div className="cocoa-stack" data-gap="2">
              <p style={bodyTextStyle}>
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
                    Cobrar {fmtEur(balancePrompt.balanceDue ?? balanceDue)} y cerrar
                  </CocoaButton>
                ) : null}
                <CocoaButton variant="bordered" tone="neutral" size="small" disabled={busy} onClick={() => void executeCheckOut({ acknowledgeBalance: true })}>
                  Salir con saldo pendiente
                </CocoaButton>
                <CocoaButton variant="plain" tone="neutral" size="small" disabled={busy} onClick={() => setBalancePrompt(null)}>
                  {ACTIONS.cancel}
                </CocoaButton>
              </div>
            </div>
          </CocoaCallout>
        ) : null}

        {/* STEP 3: salida automática */}
        <Step title="3 · Salida" badge="Automática" badgeTone="info">
          <div className="cocoa-stack" data-gap="2">
            <CocoaSwitch checked={notifyHousekeeping} onChange={setNotifyHousekeeping} label="Avisar a housekeeping (la habitación pasará a «salida sucia»)." />
            <CocoaSwitch checked={issueInvoice} onChange={setIssueInvoice} label="Emitir factura simplificada al cerrar el folio." />
            <p style={mutedStyle}>Si la reserva tiene comunidad con tasa turística, se incluirá automáticamente como línea exenta.</p>
          </div>
        </Step>

        {blockingReason ? (
          <CocoaCallout tone="warning" role="status">
            {blockingReason}
          </CocoaCallout>
        ) : null}
      </>
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
            <CocoaButton
              variant="filled"
              tone="accent"
              disabled={!canSubmit || busy || Boolean(balancePrompt)}
              loading={busy}
              onClick={() => void executeCheckOut()}
              title={blockingReason || "Pulsa para completar el check-out"}
            >
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

function CompletedView({ elapsed, roomNumber }: { elapsed: string; roomNumber?: string }) {
  return (
    <div className="cocoa-stack" data-gap="3">
      <CocoaState
        kind="empty"
        illustration="success"
        title="Check-out completado"
        message={roomNumber ? `La habitación ${roomNumber} ha pasado a salida sucia.` : "Folio cerrado y huésped despedido."}
        role="status"
      />
      <div className="cocoa-row" data-gap="2" data-justify="center">
        <CocoaBadge tone="success" icon={<ClockIcon size={12} />}>
          {elapsed} · objetivo &lt; 1:00
        </CocoaBadge>
      </div>
      <p style={mutedStyle}>Housekeeping recibirá una tarea de limpieza de salida. Esta ventana se cierra automáticamente.</p>
    </div>
  );
}
