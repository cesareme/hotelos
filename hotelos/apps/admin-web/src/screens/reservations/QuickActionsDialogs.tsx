// QuickActionsDialogs — 3 dialogs operativos para gestión rápida de reservas.
//
// 1. ModifyDatesDialog     — cambia llegada / salida con quote de disponibilidad
//                            previa antes de hacer el PATCH.
// 2. TransferToGroupDialog — mueve la reserva a otro grupo (groupBookingId) o la
//                            saca del grupo actual (sin grupo).
// 3. ChangeRoomDialog      — reasigna a otra habitación libre del mismo tipo.
//
// Mismo patrón de modal (full-screen overlay + form card) y mismos helpers
// inline (Field / inputStyle / fieldsetStyle / legendStyle) que NewGroupDialog,
// replicados para no acoplar archivos de pantallas distintas.
import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode
} from "react";
import { useToast } from "../../components/Toast";
import { apiRequest } from "../../services/api-client";
import { getActivePropertyId } from "../../services/activeProperty";
import {
  fetchRooms,
  quoteAvailability,
  updateReservation,
  type AdminReservation,
  type AdminRoom,
  type AvailabilityQuote
} from "../../services/pmsCommerceApi";
import type { GroupBooking } from "../../services/groupsApi";

// ─── Helpers locales (replicados, mismo patrón que NewGroupDialog) ───────

const fieldsetStyle: CSSProperties = {
  border: "1px solid var(--border, #e5e7eb)",
  borderRadius: "var(--radius-sm, 6px)",
  padding: 12,
  margin: 0
};

const legendStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--ink-soft, #555)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  padding: "0 6px"
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  border: "1px solid var(--border, #d1d5db)",
  borderRadius: "var(--radius-sm, 6px)",
  background: "var(--surface, white)",
  color: "var(--ink, #1a1a1a)",
  fontSize: 14,
  fontFamily: "inherit"
};

function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: "var(--ink)" }}>
      <span style={{ fontWeight: 500 }}>{props.label}</span>
      {props.children}
      {props.hint ? <span className="bo-muted" style={{ fontSize: 11 }}>{props.hint}</span> : null}
    </label>
  );
}

function modalOverlayStyle(): CSSProperties {
  return {
    position: "fixed",
    inset: 0,
    background: "rgba(15, 23, 42, 0.55)",
    backdropFilter: "blur(2px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
    padding: 16
  };
}

function modalCardStyle(maxWidth = 520): CSSProperties {
  return {
    width: "100%",
    maxWidth,
    maxHeight: "92vh",
    overflow: "auto",
    background: "var(--surface-1, var(--surface))",
    padding: "var(--space-5, 20px)",
    borderRadius: "var(--radius-md, 12px)",
    display: "flex",
    flexDirection: "column",
    gap: 12
  };
}

// Cálculo de noches inclusivo de llegada / exclusivo de salida (estándar PMS).
function nightsBetween(arrival: string, departure: string): number | null {
  if (!arrival || !departure) return null;
  const a = new Date(arrival);
  const d = new Date(departure);
  if (Number.isNaN(a.getTime()) || Number.isNaN(d.getTime())) return null;
  const diff = Math.round((d.getTime() - a.getTime()) / 86400000);
  return diff > 0 ? diff : null;
}

// ════════════════════════════════════════════════════════════════════════
// 1. ModifyDatesDialog
// ════════════════════════════════════════════════════════════════════════

export type ModifyDatesDialogProps = {
  reservationId: string;
  currentArrival: string;
  currentDeparture: string;
  /** roomTypeId of the reservation — used to consult availability for the dates. */
  roomTypeId?: string;
  /** Adults headcount — needed for the availability quote payload. */
  adults?: number;
  /** Children headcount — needed for the availability quote payload. */
  children?: number;
  onClose: () => void;
  onSaved: (reservation: AdminReservation) => void;
};

type AvailState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ok"; quote: AvailabilityQuote | null }
  | { status: "unavailable" }
  | { status: "error"; message: string };

export function ModifyDatesDialog(props: ModifyDatesDialogProps) {
  const { showToast } = useToast();
  const [arrival, setArrival] = useState<string>(props.currentArrival);
  const [departure, setDeparture] = useState<string>(props.currentDeparture);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [avail, setAvail] = useState<AvailState>({ status: "idle" });

  const nights = nightsBetween(arrival, departure);
  const datesChanged = arrival !== props.currentArrival || departure !== props.currentDeparture;

  // Validación previa para habilitar el botón de "Comprobar disponibilidad".
  const datesValid = nights !== null && nights > 0;

  async function checkAvailability() {
    if (!datesValid) {
      setAvail({ status: "error", message: "Las fechas no son válidas." });
      return;
    }
    setAvail({ status: "checking" });
    try {
      // Si no tenemos roomTypeId no hacemos el quote — sólo dejamos pasar el cambio.
      if (!props.roomTypeId) {
        setAvail({ status: "ok", quote: null });
        return;
      }
      const propertyId = getActivePropertyId();
      const quotes = await quoteAvailability(propertyId, {
        arrivalDate: arrival,
        departureDate: departure,
        adults: props.adults ?? 1,
        children: props.children ?? 0,
        roomTypeId: props.roomTypeId
      });
      const match = quotes.find((q) => q.roomTypeId === props.roomTypeId) ?? null;
      if (!match || match.availableRooms <= 0) {
        setAvail({ status: "unavailable" });
        return;
      }
      setAvail({ status: "ok", quote: match });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setAvail({ status: "error", message: msg });
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!datesValid) {
      setError("Las fechas no son válidas. Revisa llegada y salida.");
      return;
    }
    if (!datesChanged) {
      setError("Las fechas no han cambiado. Modifica al menos una.");
      return;
    }
    setSubmitting(true);
    try {
      const updated = await updateReservation(props.reservationId, {
        arrivalDate: arrival,
        departureDate: departure
      });
      showToast("Fechas modificadas", { variant: "success" });
      props.onSaved(updated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      showToast(`Error: ${msg}`, { variant: "error" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="modify-dates-title"
      style={modalOverlayStyle()}
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") props.onClose();
      }}
    >
      <form onSubmit={submit} className="bo-card" style={modalCardStyle(520)}>
        <div className="bo-card-head" style={{ marginBottom: 4 }}>
          <div>
            <p
              className="bo-muted"
              style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 11, margin: 0 }}
            >
              Reserva · Acción rápida
            </p>
            <h3 id="modify-dates-title" style={{ margin: "2px 0 0 0" }}>
              Modificar fechas
            </h3>
          </div>
          <button
            type="button"
            onClick={props.onClose}
            aria-label="Cerrar"
            style={{ background: "transparent", border: "none", fontSize: 20, cursor: "pointer", color: "var(--ink)" }}
          >
            ×
          </button>
        </div>

        <p className="bo-muted" style={{ margin: 0, fontSize: 13 }}>
          Cambia las fechas de la estancia. Recomendado: comprueba disponibilidad antes de guardar
          para evitar overbooking del mismo room type.
        </p>

        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>Fechas</legend>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Llegada *">
              <input
                type="date"
                required
                value={arrival}
                onChange={(e) => {
                  setArrival(e.target.value);
                  setAvail({ status: "idle" });
                }}
                style={inputStyle}
                autoFocus
              />
            </Field>
            <Field label="Salida *">
              <input
                type="date"
                required
                value={departure}
                min={arrival}
                onChange={(e) => {
                  setDeparture(e.target.value);
                  setAvail({ status: "idle" });
                }}
                style={inputStyle}
              />
            </Field>
          </div>
          <p className="bo-muted" style={{ fontSize: 12, margin: "8px 0 0 0" }}>
            {nights !== null
              ? `${nights} ${nights === 1 ? "noche" : "noches"} de estancia.`
              : "Indica fechas válidas (salida posterior a llegada)."}
          </p>
        </fieldset>

        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>Disponibilidad</legend>
          <div className="bo-row" style={{ gap: 8, alignItems: "center" }}>
            <button
              type="button"
              onClick={checkAvailability}
              disabled={!datesValid || avail.status === "checking" || !datesChanged}
            >
              {avail.status === "checking" ? "Comprobando…" : "Comprobar disponibilidad"}
            </button>
            <span style={{ fontSize: 13 }}>
              {avail.status === "idle" && (datesChanged ? "Pendiente de comprobar." : "Sin cambios todavía.")}
              {avail.status === "checking" && "Consultando rate plans y stock…"}
              {avail.status === "ok" && avail.quote && (
                <span style={{ color: "var(--ok-ink, #0a6b46)" }}>
                  ✓ {avail.quote.availableRooms} habs disponibles · {avail.quote.totalAmount}{" "}
                  {avail.quote.currency}
                </span>
              )}
              {avail.status === "ok" && !avail.quote && (
                <span className="bo-muted">Sin room type — disponibilidad no verificada.</span>
              )}
              {avail.status === "unavailable" && (
                <span style={{ color: "var(--danger-ink, #8d1b1b)" }}>
                  ✗ No queda stock del mismo tipo para esas fechas.
                </span>
              )}
              {avail.status === "error" && (
                <span style={{ color: "var(--danger-ink, #8d1b1b)" }}>Error: {avail.message}</span>
              )}
            </span>
          </div>
        </fieldset>

        {error ? (
          <p className="bo-status error" style={{ textTransform: "none", margin: 0 }}>
            {error}
          </p>
        ) : null}

        <div className="bo-row" style={{ gap: 8, justifyContent: "space-between", marginTop: 4 }}>
          <p className="bo-muted" style={{ fontSize: 12, margin: 0 }}>
            * Campos obligatorios
          </p>
          <div className="bo-row" style={{ gap: 8 }}>
            <button type="button" onClick={props.onClose} disabled={submitting}>
              Cancelar
            </button>
            <button
              type="submit"
              className="primary"
              disabled={submitting || !datesValid || !datesChanged || avail.status === "unavailable"}
            >
              {submitting ? "Guardando…" : "Guardar fechas"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// 2. TransferToGroupDialog
// ════════════════════════════════════════════════════════════════════════

export type TransferToGroupDialogProps = {
  reservationId: string;
  currentGroupId?: string | null;
  onClose: () => void;
  onSaved: (reservation: AdminReservation) => void;
};

export function TransferToGroupDialog(props: TransferToGroupDialogProps) {
  const { showToast } = useToast();
  const [groups, setGroups] = useState<GroupBooking[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string>(props.currentGroupId ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const propertyId = getActivePropertyId();
    setLoading(true);
    setLoadError(null);
    apiRequest<GroupBooking[]>(`/groups/properties/${propertyId}`)
      .then((data) => {
        setGroups(data);
        setLoading(false);
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        setLoadError(msg);
        setLoading(false);
      });
  }, []);

  const hasChange = (selectedGroupId || "") !== (props.currentGroupId ?? "");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!hasChange) {
      setError("Selecciona un grupo distinto (o 'Sin grupo' para quitarlo del actual).");
      return;
    }
    setSubmitting(true);
    try {
      // PATCH /reservations/:id — el endpoint admite campos arbitrarios; enviamos
      // groupBookingId. Se permite null/cadena vacía para des-vincular del grupo.
      const updated = await apiRequest<AdminReservation>(`/reservations/${props.reservationId}`, {
        method: "PATCH",
        body: { groupBookingId: selectedGroupId || null }
      });
      const msg = selectedGroupId ? "Reserva transferida al grupo" : "Reserva separada del grupo";
      showToast(msg, { variant: "success" });
      props.onSaved(updated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      showToast(`Error: ${msg}`, { variant: "error" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="transfer-group-title"
      style={modalOverlayStyle()}
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") props.onClose();
      }}
    >
      <form onSubmit={submit} className="bo-card" style={modalCardStyle(520)}>
        <div className="bo-card-head" style={{ marginBottom: 4 }}>
          <div>
            <p
              className="bo-muted"
              style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 11, margin: 0 }}
            >
              Reserva · Acción rápida
            </p>
            <h3 id="transfer-group-title" style={{ margin: "2px 0 0 0" }}>
              Transferir a grupo
            </h3>
          </div>
          <button
            type="button"
            onClick={props.onClose}
            aria-label="Cerrar"
            style={{ background: "transparent", border: "none", fontSize: 20, cursor: "pointer", color: "var(--ink)" }}
          >
            ×
          </button>
        </div>

        <p className="bo-muted" style={{ margin: 0, fontSize: 13 }}>
          Asocia esta reserva a un GroupBooking (master folio, attrition, tarifa contratada…)
          o desligala seleccionando "Sin grupo".
        </p>

        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>Grupo destino</legend>
          {loading ? (
            <p className="bo-muted" style={{ fontSize: 13, margin: 0 }}>
              Cargando grupos activos del establecimiento…
            </p>
          ) : loadError ? (
            <p className="bo-status error" style={{ textTransform: "none", margin: 0 }}>
              No se pudieron cargar los grupos: {loadError}
            </p>
          ) : (
            <Field
              label="Grupo *"
              hint={
                props.currentGroupId
                  ? `Grupo actual: ${props.currentGroupId}. Selecciona otro o "Sin grupo".`
                  : "Esta reserva no está asociada a ningún grupo todavía."
              }
            >
              <select
                value={selectedGroupId}
                onChange={(e) => setSelectedGroupId(e.target.value)}
                style={inputStyle}
                autoFocus
              >
                <option value="">— Sin grupo —</option>
                {(groups ?? []).map((g) => {
                  const label = `${g.code ?? g.id} · ${g.name ?? "(sin nombre)"}${
                    g.arrivalDate ? ` · ${g.arrivalDate} → ${g.departureDate ?? "?"}` : ""
                  }`;
                  return (
                    <option key={g.id} value={g.id}>
                      {label}
                    </option>
                  );
                })}
              </select>
            </Field>
          )}
          {!loading && !loadError && (groups?.length ?? 0) === 0 ? (
            <p className="bo-muted" style={{ fontSize: 12, margin: "8px 0 0 0" }}>
              No hay grupos creados en este establecimiento. Crea uno desde Operaciones · Grupos.
            </p>
          ) : null}
        </fieldset>

        {error ? (
          <p className="bo-status error" style={{ textTransform: "none", margin: 0 }}>
            {error}
          </p>
        ) : null}

        <div className="bo-row" style={{ gap: 8, justifyContent: "space-between", marginTop: 4 }}>
          <p className="bo-muted" style={{ fontSize: 12, margin: 0 }}>
            * Campos obligatorios
          </p>
          <div className="bo-row" style={{ gap: 8 }}>
            <button type="button" onClick={props.onClose} disabled={submitting}>
              Cancelar
            </button>
            <button
              type="submit"
              className="primary"
              disabled={submitting || loading || !!loadError || !hasChange}
            >
              {submitting ? "Guardando…" : "Transferir"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// 3. ChangeRoomDialog
// ════════════════════════════════════════════════════════════════════════

export type ChangeRoomDialogProps = {
  reservationId: string;
  currentRoomId?: string | null;
  /** roomTypeId of the reservation — filters the selector to "same type" rooms. */
  roomTypeId?: string;
  onClose: () => void;
  onSaved: (reservation: AdminReservation) => void;
};

export function ChangeRoomDialog(props: ChangeRoomDialogProps) {
  const { showToast } = useToast();
  const [rooms, setRooms] = useState<AdminRoom[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedRoomId, setSelectedRoomId] = useState<string>(props.currentRoomId ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const propertyId = getActivePropertyId();
    setLoading(true);
    setLoadError(null);
    // Reusamos fetchRooms para mantener una sola ruta canónica de habitaciones
    // (el spec menciona /rooms/properties/:propertyId pero la API real expone
    // /properties/:propertyId/rooms).
    fetchRooms(propertyId)
      .then((data) => {
        setRooms(data);
        setLoading(false);
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        setLoadError(msg);
        setLoading(false);
      });
  }, []);

  // Habitaciones candidatas: del mismo tipo, vendibles, y que no sean la actual.
  // Si no nos llega `roomTypeId` no filtramos por tipo (degradación amable).
  const candidates = useMemo<AdminRoom[]>(() => {
    if (!rooms) return [];
    return rooms.filter((r) => {
      if (props.roomTypeId && r.roomTypeId !== props.roomTypeId) return false;
      if (r.sellable === false) return false;
      return true;
    });
  }, [rooms, props.roomTypeId]);

  const hasChange = (selectedRoomId || "") !== (props.currentRoomId ?? "");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!selectedRoomId) {
      setError("Selecciona la habitación destino.");
      return;
    }
    if (!hasChange) {
      setError("La habitación seleccionada coincide con la actual.");
      return;
    }
    setSubmitting(true);
    try {
      // PATCH /reservations/:id con roomId (el campo persistido en la entidad
      // es `assignedRoomId`; enviamos ambos por compatibilidad con back ends que
      // acepten cualquiera de los dos).
      const updated = await apiRequest<AdminReservation>(`/reservations/${props.reservationId}`, {
        method: "PATCH",
        body: { roomId: selectedRoomId, assignedRoomId: selectedRoomId }
      });
      showToast("Habitación reasignada", { variant: "success" });
      props.onSaved(updated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      showToast(`Error: ${msg}`, { variant: "error" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="change-room-title"
      style={modalOverlayStyle()}
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") props.onClose();
      }}
    >
      <form onSubmit={submit} className="bo-card" style={modalCardStyle(520)}>
        <div className="bo-card-head" style={{ marginBottom: 4 }}>
          <div>
            <p
              className="bo-muted"
              style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 11, margin: 0 }}
            >
              Reserva · Acción rápida
            </p>
            <h3 id="change-room-title" style={{ margin: "2px 0 0 0" }}>
              Cambiar de habitación
            </h3>
          </div>
          <button
            type="button"
            onClick={props.onClose}
            aria-label="Cerrar"
            style={{ background: "transparent", border: "none", fontSize: 20, cursor: "pointer", color: "var(--ink)" }}
          >
            ×
          </button>
        </div>

        <p className="bo-muted" style={{ margin: 0, fontSize: 13 }}>
          Reasigna esta reserva a otra habitación del mismo tipo. Si el huésped ya está
          alojado, recuerda gestionar el housekeeping y el traslado de equipaje.
        </p>

        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>Habitación destino</legend>
          {loading ? (
            <p className="bo-muted" style={{ fontSize: 13, margin: 0 }}>
              Cargando inventario de habitaciones…
            </p>
          ) : loadError ? (
            <p className="bo-status error" style={{ textTransform: "none", margin: 0 }}>
              No se pudieron cargar las habitaciones: {loadError}
            </p>
          ) : (
            <Field
              label="Habitación *"
              hint={
                props.roomTypeId
                  ? `Filtradas por el mismo room type (${candidates.length} disponibles).`
                  : "Sin filtro de tipo — muestra todas las habitaciones vendibles."
              }
            >
              <select
                value={selectedRoomId}
                onChange={(e) => setSelectedRoomId(e.target.value)}
                style={inputStyle}
                required
                autoFocus
              >
                <option value="">— Selecciona habitación —</option>
                {candidates.map((r) => {
                  const isCurrent = r.id === props.currentRoomId;
                  const label = `Hab. ${r.number}${r.floor ? ` (piso ${r.floor})` : ""} · ${r.status}${
                    r.housekeepingStatus ? ` · hk:${r.housekeepingStatus}` : ""
                  }${isCurrent ? " · ACTUAL" : ""}`;
                  return (
                    <option key={r.id} value={r.id} disabled={isCurrent}>
                      {label}
                    </option>
                  );
                })}
              </select>
            </Field>
          )}
          {!loading && !loadError && candidates.length === 0 ? (
            <p className="bo-muted" style={{ fontSize: 12, margin: "8px 0 0 0" }}>
              No hay habitaciones candidatas del mismo tipo.
            </p>
          ) : null}
        </fieldset>

        {error ? (
          <p className="bo-status error" style={{ textTransform: "none", margin: 0 }}>
            {error}
          </p>
        ) : null}

        <div className="bo-row" style={{ gap: 8, justifyContent: "space-between", marginTop: 4 }}>
          <p className="bo-muted" style={{ fontSize: 12, margin: 0 }}>
            * Campos obligatorios
          </p>
          <div className="bo-row" style={{ gap: 8 }}>
            <button type="button" onClick={props.onClose} disabled={submitting}>
              Cancelar
            </button>
            <button
              type="submit"
              className="primary"
              disabled={submitting || loading || !!loadError || !hasChange || !selectedRoomId}
            >
              {submitting ? "Guardando…" : "Reasignar"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
