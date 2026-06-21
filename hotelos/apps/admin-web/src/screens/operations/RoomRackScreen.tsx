// RoomRackScreen — "el corazón visual" del PMS (directriz Nov 2026).
//
// Tablero por planta con habitaciones como tiles. Cada tile pinta:
//   - número grande
//   - color por estado (ocupada / lista / sucia / fuera-servicio / bloqueada)
//   - badges encima (⭐ VIP, € saldo, 💬 petición, 🛎 incidencia, ⏰ HK urgente,
//     ✈ llegada hoy, ↪ late checkout)
//   - huésped actual o próxima llegada en 1 línea
//
// Click → side panel con detalle + acciones rápidas (ver folio, hacer check-in,
// bloquear, marcar sucia, asignar HK).
//
// Reglas UX (directriz):
//   - "Estados visuales claros"
//   - "Cero información enterrada" — saldo/petición/llegada visibles sin click
//   - "Acción frecuente a ≤ 2 clics"
//   - Filtros por estado y planta

import { useEffect, useMemo, useState } from "react";
import { useApiData } from "../../hooks/useApiData";
import { LoadingBlock, ErrorState } from "../../components/States";
import { getActivePropertyId } from "../../services/activeProperty";
import { QuickCheckInDrawer } from "./QuickCheckInDrawer";
import { QuickCheckOutDrawer } from "./QuickCheckOutDrawer";

// ============================================================== types

type Badge = "vip" | "balance_due" | "special_request" | "hk_urgent" | "overbooking" | "incident" | "late_checkout" | "early_checkin" | "vacant_due_soon";

type Occupancy =
  | "vacant_clean"
  | "vacant_dirty"
  | "occupied_stay"
  | "occupied_departing_today"
  | "checked_out_today"
  | "out_of_order"
  | "blocked_maintenance";

type Reservation = {
  reservationId: string;
  guestName: string;
  guestId?: string;
  status: string;
  arrivalDate: string;
  departureDate: string;
  eta?: string;
  etd?: string;
  balanceDue: number;
  vip: boolean;
  loyaltyTier?: string;
  specialRequest?: string;
};

type Tile = {
  roomId: string;
  roomNumber: string;
  floor?: string;
  roomTypeId?: string;
  roomTypeName?: string;
  status: string;
  housekeepingStatus?: string;
  occupancy: Occupancy;
  badges: Badge[];
  currentReservation?: Reservation;
  nextArrival?: Reservation;
};

type Floor = { floor: string; rooms: Tile[] };

type RackData = {
  propertyId: string;
  generatedAt: string;
  floors: Floor[];
  totals: {
    rooms: number;
    occupied: number;
    vacantClean: number;
    vacantDirty: number;
    outOfOrder: number;
    arrivalsToday: number;
    departuresToday: number;
  };
};

// ============================================================== display

const OCCUPANCY_TONE: Record<Occupancy, { bg: string; border: string; ink: string; label: string }> = {
  vacant_clean: { bg: "rgba(31, 138, 76, 0.10)", border: "#1f8a4c", ink: "#1f8a4c", label: "Lista" },
  vacant_dirty: { bg: "rgba(210, 155, 0, 0.10)", border: "#d29b00", ink: "#a47600", label: "Sucia" },
  occupied_stay: { bg: "rgba(38, 99, 196, 0.10)", border: "#2663c4", ink: "#1d4ea0", label: "Ocupada" },
  occupied_departing_today: { bg: "rgba(143, 79, 191, 0.12)", border: "#8f4fbf", ink: "#6f3ad2", label: "Sale hoy" },
  checked_out_today: { bg: "rgba(120, 120, 120, 0.10)", border: "#888", ink: "#666", label: "Salida hecha" },
  out_of_order: { bg: "rgba(210, 59, 59, 0.10)", border: "#d23b3b", ink: "#a52828", label: "Fuera servicio" },
  blocked_maintenance: { bg: "rgba(210, 59, 59, 0.10)", border: "#d23b3b", ink: "#a52828", label: "Bloqueada" }
};

const BADGE_GLYPH: Record<Badge, string> = {
  vip: "⭐",
  balance_due: "€",
  special_request: "💬",
  hk_urgent: "⏰",
  overbooking: "⚠",
  incident: "🛎",
  late_checkout: "↪",
  early_checkin: "✈",
  vacant_due_soon: "↑"
};

const BADGE_TITLE: Record<Badge, string> = {
  vip: "Huésped VIP",
  balance_due: "Saldo pendiente",
  special_request: "Petición especial",
  hk_urgent: "Limpieza urgente (llega < 2h)",
  overbooking: "Conflicto de reserva",
  incident: "Incidencia abierta",
  late_checkout: "Late check-out",
  early_checkin: "Early check-in",
  vacant_due_soon: "Llegada hoy"
};

// ============================================================== helpers

function fmtEur(value: number | undefined | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "0,00 €";
  return new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

async function postAction(url: string, body?: unknown): Promise<{ ok: boolean; message?: string }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) return { ok: false, message: `${res.status} ${await res.text().catch(() => "")}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Error" };
  }
}

// ============================================================== component

export function RoomRackScreen() {
  const propertyId = getActivePropertyId();
  const { data, loading, error, refresh } = useApiData<RackData>(`/dashboards/room-rack?propertyId=${propertyId}`, { pollIntervalMs: 30000 });

  const [filterOcc, setFilterOcc] = useState<Set<Occupancy>>(new Set());
  const [filterFloor, setFilterFloor] = useState<string | "all">("all");
  const [query, setQuery] = useState("");
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [checkInResId, setCheckInResId] = useState<string | null>(null);
  const [checkOutResId, setCheckOutResId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "warn" | "error"; text: string } | null>(null);

  const totals = data?.totals ?? { rooms: 0, occupied: 0, vacantClean: 0, vacantDirty: 0, outOfOrder: 0, arrivalsToday: 0, departuresToday: 0 };
  const floors = data?.floors ?? [];

  // Floor con tiles filtrados
  const filteredFloors = useMemo(() => {
    const q = query.trim().toLowerCase();
    return floors
      .filter((f) => filterFloor === "all" || f.floor === filterFloor)
      .map((f) => ({
        floor: f.floor,
        rooms: f.rooms.filter((r) => {
          if (filterOcc.size > 0 && !filterOcc.has(r.occupancy)) return false;
          if (q) {
            const guestName = (r.currentReservation?.guestName || r.nextArrival?.guestName || "").toLowerCase();
            return r.roomNumber.toLowerCase().includes(q) || guestName.includes(q);
          }
          return true;
        })
      }))
      .filter((f) => f.rooms.length > 0);
  }, [floors, filterOcc, filterFloor, query]);

  const selectedTile = useMemo(() => {
    if (!selectedRoomId) return null;
    for (const f of floors) {
      const t = f.rooms.find((r) => r.roomId === selectedRoomId);
      if (t) return t;
    }
    return null;
  }, [floors, selectedRoomId]);

  function toggleFilter(o: Occupancy) {
    setFilterOcc((prev) => {
      const next = new Set(prev);
      if (next.has(o)) next.delete(o);
      else next.add(o);
      return next;
    });
  }

  async function handleBlockRoom(roomId: string, sellable: boolean) {
    setBusy(true);
    const result = await postAction(`${API_BASE}/rooms/${roomId}/sellable`, { sellable });
    setBusy(false);
    setToast({ kind: result.ok ? "ok" : "warn", text: result.ok ? (sellable ? "Habitación desbloqueada" : "Habitación bloqueada") : (result.message || "Error") });
    setTimeout(() => setToast(null), 3500);
    if (result.ok) refresh();
  }

  async function handleHkStatus(roomId: string, status: string) {
    setBusy(true);
    const result = await postAction(`${API_BASE}/rooms/${roomId}/housekeeping-status`, { status });
    setBusy(false);
    setToast({ kind: result.ok ? "ok" : "warn", text: result.ok ? `Estado HK → ${status}` : (result.message || "Error") });
    setTimeout(() => setToast(null), 3500);
    if (result.ok) refresh();
  }

  // Audit 2026-06 · #10: first-load guard. Before any data arrives the derived
  // totals/floors are all zero, so the board rendered as a misleading "empty
  // hotel". Show a real loading/error state instead (all hooks run above this).
  if (!data) {
    return (
      <>
        <div className="bo-page-head">
          <div className="bo-page-head-text">
            <div className="bo-page-eyebrow">Recepción · Tablero</div>
            <h1 className="bo-page-title">Habitaciones</h1>
          </div>
          <div className="bo-page-head-actions">
            <button type="button" className="ghost" onClick={refresh}>↻ Actualizar</button>
          </div>
        </div>
        {error ? (
          <ErrorState title="No se pudo cargar el tablero de habitaciones" message={error} onRetry={refresh} />
        ) : (
          <LoadingBlock label="Cargando el tablero de habitaciones…" />
        )}
      </>
    );
  }

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Recepción · Tablero</div>
          <h1 className="bo-page-title">Habitaciones</h1>
          <p className="bo-page-subtitle">
            Vista en tiempo real de las {totals.rooms} habitaciones. Click en una tile para ver detalles y actuar.
          </p>
        </div>
        <div className="bo-page-head-actions">
          {loading ? <span className="bo-status info">cargando</span> : null}
          {error ? <span className="bo-status error">{error}</span> : null}
          <button type="button" className="ghost" onClick={refresh}>↻ Actualizar</button>
        </div>
      </div>

      {/* KPI strip */}
      <div className="rev-kpi-grid">
        <KpiCard label="Ocupadas" value={totals.occupied} tone="info" />
        <KpiCard label="Listas" value={totals.vacantClean} tone="ok" />
        <KpiCard label="Sucias" value={totals.vacantDirty} tone="warn" />
        <KpiCard label="Fuera de servicio" value={totals.outOfOrder} tone={totals.outOfOrder > 0 ? "error" : "ok"} />
        <KpiCard label="Llegadas hoy" value={totals.arrivalsToday} tone="info" />
        <KpiCard label="Salidas hoy" value={totals.departuresToday} tone="info" />
      </div>

      {/* Filtros */}
      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head">
          <h3 style={{ color: "var(--ink)" }}>Filtros</h3>
          <span className="bo-muted" style={{ fontSize: 12 }}>{filteredFloors.reduce((s, f) => s + f.rooms.length, 0)} habitaciones visibles</span>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            type="search"
            placeholder="Buscar por nº o huésped"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ padding: "6px 10px", flex: "0 0 220px", border: "1px solid var(--border)", borderRadius: 6 }}
          />
          <select value={filterFloor} onChange={(e) => setFilterFloor(e.target.value)} style={{ padding: 6 }}>
            <option value="all">Todas las plantas</option>
            {floors.map((f) => (
              <option key={f.floor} value={f.floor}>Planta {f.floor} ({f.rooms.length})</option>
            ))}
          </select>
          {(Object.keys(OCCUPANCY_TONE) as Occupancy[]).map((o) => (
            <button
              key={o}
              type="button"
              className={filterOcc.has(o) ? "primary" : "ghost"}
              onClick={() => toggleFilter(o)}
              style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: OCCUPANCY_TONE[o].border }} />
              {OCCUPANCY_TONE[o].label}
            </button>
          ))}
          {filterOcc.size > 0 || filterFloor !== "all" || query ? (
            <button type="button" className="ghost" onClick={() => { setFilterOcc(new Set()); setFilterFloor("all"); setQuery(""); }}>
              Limpiar filtros
            </button>
          ) : null}
        </div>
      </article>

      {/* Floors */}
      {filteredFloors.map((floor) => (
        <article key={floor.floor} className="bo-card" style={{ background: "var(--surface)" }}>
          <div className="bo-card-head">
            <h3 style={{ color: "var(--ink)" }}>Planta {floor.floor}</h3>
            <span className="bo-chip">{floor.rooms.length} habitaciones</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 8 }}>
            {floor.rooms.map((tile) => (
              <RoomTile key={tile.roomId} tile={tile} selected={tile.roomId === selectedRoomId} onClick={() => setSelectedRoomId(tile.roomId)} />
            ))}
          </div>
        </article>
      ))}

      {/* Side panel */}
      {selectedTile ? (
        <RoomDetailPanel
          tile={selectedTile}
          onClose={() => setSelectedRoomId(null)}
          onCheckIn={(resId) => setCheckInResId(resId)}
          onCheckOut={(resId) => setCheckOutResId(resId)}
          onBlock={(roomId, sellable) => handleBlockRoom(roomId, sellable)}
          onHkStatus={(roomId, status) => handleHkStatus(roomId, status)}
          busy={busy}
        />
      ) : null}

      {/* Drawers */}
      {checkInResId ? (
        <QuickCheckInDrawer
          reservationId={checkInResId}
          onClose={() => setCheckInResId(null)}
          onCompleted={({ elapsedSeconds }) => {
            setToast({ kind: "ok", text: `Check-in en ${elapsedSeconds}s` });
            setTimeout(() => setToast(null), 4000);
            refresh();
          }}
        />
      ) : null}
      {checkOutResId ? (
        <QuickCheckOutDrawer
          reservationId={checkOutResId}
          onClose={() => setCheckOutResId(null)}
          onCompleted={({ elapsedSeconds }) => {
            setToast({ kind: "ok", text: `Check-out en ${elapsedSeconds}s` });
            setTimeout(() => setToast(null), 4000);
            refresh();
          }}
        />
      ) : null}

      {toast ? (
        <div style={{ position: "fixed", bottom: 20, right: 20, zIndex: 70 }}>
          <span className={`bo-status ${toast.kind === "ok" ? "ok" : toast.kind === "warn" ? "warn" : "error"}`}>{toast.text}</span>
        </div>
      ) : null}
    </>
  );
}

// ============================================================== sub-components

function KpiCard({ label, value, tone }: { label: string; value: number; tone: "ok" | "warn" | "error" | "info" }) {
  const klass = tone === "ok" ? "rev-kpi-ok" : tone === "warn" ? "rev-kpi-warn" : tone === "error" ? "rev-kpi-error" : "rev-kpi-ok";
  return (
    <article className={`rev-kpi ${klass}`}>
      <div className="rev-kpi-head">
        <span className="rev-kpi-label">{label}</span>
      </div>
      <div className="rev-kpi-value">{value}</div>
    </article>
  );
}

function RoomTile({ tile, selected, onClick }: { tile: Tile; selected: boolean; onClick: () => void }) {
  const tone = OCCUPANCY_TONE[tile.occupancy];
  const focus = tile.currentReservation ?? tile.nextArrival;
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: 10,
        background: tone.bg,
        border: `${selected ? 3 : 1}px solid ${tone.border}`,
        borderRadius: 8,
        cursor: "pointer",
        textAlign: "left",
        minHeight: 86,
        position: "relative"
      }}
      title={`${tile.roomNumber} · ${tone.label}${tile.roomTypeName ? ` · ${tile.roomTypeName}` : ""}`}
    >
      {/* badges row */}
      {tile.badges.length > 0 ? (
        <div style={{ position: "absolute", top: 4, right: 6, display: "flex", gap: 3, fontSize: 11 }}>
          {tile.badges.slice(0, 4).map((b) => (
            <span key={b} title={BADGE_TITLE[b]} style={{ background: "white", borderRadius: 4, padding: "0 4px", fontWeight: 600, color: tone.ink }}>
              {BADGE_GLYPH[b]}
            </span>
          ))}
        </div>
      ) : null}

      <strong style={{ fontSize: 18, color: tone.ink, lineHeight: 1 }}>{tile.roomNumber}</strong>
      <span style={{ fontSize: 11, color: tone.ink, fontWeight: 500 }}>{tone.label}</span>
      {focus ? (
        <span style={{ fontSize: 11, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {tile.currentReservation ? "" : "→ "}{focus.guestName}
        </span>
      ) : (
        tile.roomTypeName ? <span style={{ fontSize: 11, color: "var(--muted, #888)" }}>{tile.roomTypeName}</span> : null
      )}
    </button>
  );
}

function RoomDetailPanel({
  tile,
  onClose,
  onCheckIn,
  onCheckOut,
  onBlock,
  onHkStatus,
  busy
}: {
  tile: Tile;
  onClose: () => void;
  onCheckIn: (reservationId: string) => void;
  onCheckOut: (reservationId: string) => void;
  onBlock: (roomId: string, sellable: boolean) => void;
  onHkStatus: (roomId: string, status: string) => void;
  busy: boolean;
}) {
  const tone = OCCUPANCY_TONE[tile.occupancy];
  const current = tile.currentReservation;
  const next = tile.nextArrival;
  const isBlocked = tile.occupancy === "blocked_maintenance" || tile.occupancy === "out_of_order";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        justifyContent: "flex-end",
        zIndex: 50
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: "min(420px, 100vw)",
          height: "100%",
          background: "var(--surface)",
          color: "var(--ink)",
          padding: 16,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          boxShadow: "-8px 0 24px rgba(0,0,0,0.2)"
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 24, color: tone.ink }}>Habitación {tile.roomNumber}</h2>
            <div className="bo-muted" style={{ fontSize: 13 }}>
              {tile.roomTypeName ? `${tile.roomTypeName} · ` : ""}Planta {tile.floor ?? "—"}
            </div>
            <div style={{ marginTop: 6 }}>
              <span className="bo-chip" style={{ background: tone.bg, color: tone.ink, border: `1px solid ${tone.border}` }}>
                {tone.label}
              </span>
              {tile.housekeepingStatus ? (
                <span className="bo-chip" style={{ marginLeft: 4 }}>HK: {tile.housekeepingStatus}</span>
              ) : null}
            </div>
          </div>
          <button type="button" className="ghost" onClick={onClose}>✕</button>
        </div>

        {/* Badges expandidos */}
        {tile.badges.length > 0 ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {tile.badges.map((b) => (
              <span key={b} className="bo-status info" title={BADGE_TITLE[b]}>
                {BADGE_GLYPH[b]} {BADGE_TITLE[b]}
              </span>
            ))}
          </div>
        ) : null}

        {/* Reserva actual */}
        {current ? (
          <Section title="Huésped actual">
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <strong>{current.guestName}</strong>
              <div className="bo-muted" style={{ fontSize: 13 }}>
                Salida: {current.departureDate}{current.etd ? ` · ETD ${current.etd}` : ""}
              </div>
              {current.vip ? <div className="bo-status accent">⭐ VIP {current.loyaltyTier ?? ""}</div> : null}
              {current.balanceDue > 0 ? <div className="bo-status warn">Saldo pendiente: {fmtEur(current.balanceDue)}</div> : null}
              {current.specialRequest ? (
                <div style={{ padding: "6px 8px", background: "var(--surface-elevated, rgba(0,0,0,0.04))", borderRadius: 6, fontSize: 13 }}>
                  💬 {current.specialRequest}
                </div>
              ) : null}
            </div>
          </Section>
        ) : null}

        {/* Próxima llegada */}
        {next ? (
          <Section title="Próxima llegada">
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <strong>{next.guestName}</strong>
              <div className="bo-muted" style={{ fontSize: 13 }}>
                Llega: {next.arrivalDate}{next.eta ? ` · ETA ${next.eta}` : ""}
              </div>
              {next.vip ? <div className="bo-status accent">⭐ VIP {next.loyaltyTier ?? ""}</div> : null}
              {next.specialRequest ? (
                <div style={{ padding: "6px 8px", background: "var(--surface-elevated, rgba(0,0,0,0.04))", borderRadius: 6, fontSize: 13 }}>
                  💬 {next.specialRequest}
                </div>
              ) : null}
            </div>
          </Section>
        ) : null}

        {/* Acciones */}
        <Section title="Acciones rápidas">
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {current && current.status === "checked_in" ? (
              <button type="button" className="primary" disabled={busy} onClick={() => onCheckOut(current.reservationId)}>
                Hacer check-out →
              </button>
            ) : null}
            {next && (next.status === "confirmed" || next.status === "checked_in") ? (
              <button type="button" className="primary" disabled={busy} onClick={() => onCheckIn(next.reservationId)}>
                Hacer check-in del próximo huésped →
              </button>
            ) : null}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button type="button" className="ghost" disabled={busy} onClick={() => onHkStatus(tile.roomId, "clean")}>
                Marcar limpia
              </button>
              <button type="button" className="ghost" disabled={busy} onClick={() => onHkStatus(tile.roomId, "dirty")}>
                Marcar sucia
              </button>
              <button type="button" className="ghost" disabled={busy} onClick={() => onHkStatus(tile.roomId, "inspected")}>
                Inspeccionada
              </button>
            </div>
            <button type="button" className="ghost" disabled={busy} onClick={() => onBlock(tile.roomId, isBlocked)}>
              {isBlocked ? "Desbloquear habitación" : "Bloquear habitación"}
            </button>
          </div>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      <strong style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--muted, #888)" }}>{title}</strong>
      {children}
    </section>
  );
}
