// GroupsPickupCard · Visualización del pickup de grupos en el dashboard.
//
// Patrón visual replicado de PickupLifecycleCard (AllotmentsScreen.tsx) pero
// adaptado a bookings de grupos: en lugar de pickup vs release de cupos TT.OO.,
// muestra pickup vs cut-off de bloques contratados a grupos (bodas, MICE,
// corporate events…).
//
// Endpoint: /properties/:propertyId/groups/pickup-summary?windowDays=90
//
// Las stats clave por grupo son:
//   - Bloqueado: habs comprometidas en el bloque
//   - Vendido: habs ya con reserva confirmada (picked-up)
//   - Disponible: habs aún por vender
//   - Pickup%: ratio sold/blocked (industria: <40% rojo, 40-79% ámbar, ≥80% verde)
//
// El componente alerta cuando el pickup actual está por debajo del attrition
// threshold (típicamente 80-90% pactado en el contrato) — en ese caso el
// hotel puede facturar penalización por habs no vendidas (attrition fee).
//
// Ciclo de vida: rolling cut-off — cada noche del bloque se libera "N días
// antes" de la llegada lo no vendido (vuelve al pool general). Se muestra el
// más próximo entre cut-off y llegada.

import { useApiData } from "../../hooks/useApiData";
import { LoadingBlock } from "../../components/States";

// ───────────────────────────────────────────────────────── Tipos del API

type GroupPickupSummary = {
  groupBookingId: string;
  code: string;
  name: string;
  groupType: string;
  status: string;
  arrivalDate: string;
  departureDate: string;
  cutOffDate: string | null;
  totalBlocked: number;
  totalPickedUp: number;
  totalRemaining: number;
  pickupPct: number;
  attritionThresholdPct: number;
  daysToCutOff: number | null;
  daysToArrival: number;
  belowAttritionThreshold: boolean;
  days: Array<{ date: string; blocked: number; pickedUp: number; remaining: number }>;
};

type Response = {
  generatedAt: string;
  window: { from: string; to: string };
  groups: GroupPickupSummary[];
};

// ───────────────────────────────────────────────────────── Helpers visuales

// Mapa de tipo de grupo a emoji (chip). El backend devuelve un enum tipo
// "wedding" | "corporate" | "leisure" | "mice" | "sports" | "other" — si llega
// un tipo desconocido, mostramos un emoji genérico.
const GROUP_TYPE_EMOJI: Record<string, string> = {
  wedding: "💒",
  corporate: "🏢",
  leisure: "🏖️",
  mice: "🎤",
  sports: "🏆",
  tour: "🚌",
  family: "👨‍👩‍👧",
  other: "👥"
};

function emojiFor(groupType: string): string {
  return GROUP_TYPE_EMOJI[groupType.toLowerCase()] ?? "👥";
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("es-ES", { day: "2-digit", month: "short" });
}

// ───────────────────────────────────────────────────────── Componente principal

export function GroupsPickupCard(props: { propertyId: string; onSelect?: (groupId: string) => void }) {
  const pickup = useApiData<Response>(
    `/properties/${props.propertyId}/groups/pickup-summary?windowDays=90`,
    { pollIntervalMs: 60000 }
  );

  if (pickup.loading && !pickup.data) {
    return (
      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head">
          <h3 style={{ color: "var(--ink)" }}>Pickup de grupos · próximos 90 días</h3>
        </div>
        <LoadingBlock label="Calculando pickup de grupos…" />
      </article>
    );
  }

  const groups = pickup.data?.groups ?? [];
  if (groups.length === 0) {
    return null;
  }

  return (
    <article className="bo-card" style={{ background: "var(--surface)" }}>
      <div className="bo-card-head">
        <div>
          <h3 style={{ color: "var(--ink)", margin: 0 }}>Pickup de grupos · próximos 90 días</h3>
          <p className="bo-muted" style={{ margin: "4px 0 0 0", fontSize: 12, textTransform: "none" }}>
            Estado actual del bloque día a día (bloqueado / vendido / disponible). Alerta de attrition
            cuando el pickup actual cae por debajo del umbral pactado en el contrato.
          </p>
        </div>
        <span className="bo-chip">{groups.length} grupos</span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 12 }}>
        {groups.map((g) => (
          <GroupPickupRow key={g.groupBookingId} group={g} onSelect={props.onSelect} />
        ))}
      </div>
    </article>
  );
}

// ───────────────────────────────────────────────────────── Fila de grupo

function GroupPickupRow({ group, onSelect }: { group: GroupPickupSummary; onSelect?: (groupId: string) => void }) {
  // Color por nivel de pickup: ≥80% verde, 40-79% ámbar, <40% rojo
  const pickupColor = group.pickupPct >= 80 ? "var(--ok, #0d8a5f)"
    : group.pickupPct >= 40 ? "var(--warn, #d97706)"
    : "var(--danger, #dc2626)";
  const pickupLabel = group.pickupPct >= 80 ? "Saludable"
    : group.pickupPct >= 40 ? "Medio"
    : group.pickupPct >= 1 ? "Bajo"
    : "Sin pickup";

  // Texto de proximidad: cut-off vs llegada, el más próximo.
  // Si no hay cutOffDate (eventos sin cut-off pactado), siempre llegada.
  let proximityText: string;
  if (group.daysToCutOff != null && group.daysToCutOff <= group.daysToArrival) {
    proximityText = group.daysToCutOff <= 0
      ? "Cut-off vencido"
      : `Cut-off en ${group.daysToCutOff} día${group.daysToCutOff === 1 ? "" : "s"}`;
  } else {
    proximityText = group.daysToArrival <= 0
      ? "Llegada hoy"
      : `Llegada en ${group.daysToArrival} día${group.daysToArrival === 1 ? "" : "s"}`;
  }

  const clickable = typeof onSelect === "function";

  return (
    <div
      onClick={clickable ? () => onSelect!(group.groupBookingId) : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect!(group.groupBookingId); } } : undefined}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      style={{
        padding: 12,
        borderRadius: "var(--radius-sm, 6px)",
        background: "var(--surface-1, var(--surface))",
        border: "1px solid var(--border, rgba(0,0,0,0.06))",
        cursor: clickable ? "pointer" : "default"
      }}
    >
      {/* Header: code · name · groupType chip · status badge · pickup% badge · proximity */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 auto" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <strong style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 13 }}>{group.code}</strong>
            <span style={{ color: "var(--ink)", fontSize: 14 }}>{group.name}</span>
            <span className="bo-chip" style={{ fontSize: 11 }}>
              {emojiFor(group.groupType)} {group.groupType}
            </span>
            <span className={`bo-status ${group.status === "confirmed" ? "ok" : group.status === "cancelled" ? "error" : "info"}`} style={{ fontSize: 10 }}>
              {group.status}
            </span>
          </div>
          <p className="bo-muted" style={{ margin: "2px 0 0 0", fontSize: 12 }}>
            {fmtDate(group.arrivalDate)} → {fmtDate(group.departureDate)} · {group.totalBlocked} hab bloqueadas
            {group.cutOffDate ? ` · cut-off ${fmtDate(group.cutOffDate)}` : ""}
          </p>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
          <span style={{
            display: "inline-block",
            padding: "3px 8px",
            borderRadius: 999,
            background: pickupColor,
            color: "white",
            fontSize: 12,
            fontWeight: 600
          }}>
            {group.pickupPct}% pickup · {pickupLabel}
          </span>
          <span className="bo-muted" style={{ fontSize: 11 }}>{proximityText}</span>
        </div>
      </div>

      {/* Stats compactas (4 cuadros) */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 8 }}>
        <Stat label="Bloqueado" value={group.totalBlocked} color="var(--ink, #1a1a1a)" />
        <Stat label="Vendido" value={group.totalPickedUp} color="var(--ok, #0d8a5f)" />
        <Stat label="Disponible" value={group.totalRemaining} color="var(--accent, #0d8a5f)" />
        <Stat label="% Pickup" value={group.pickupPct} color={pickupColor} suffix="%" />
      </div>

      {/* Alerta de attrition: pickup actual por debajo del umbral contractual */}
      {group.belowAttritionThreshold ? (
        <p className="bo-status warn" style={{ textTransform: "none", margin: "0 0 8px 0", fontSize: 12 }}>
          ⚠️ Pickup {group.pickupPct}% &lt; threshold {group.attritionThresholdPct}%. Riesgo de penalización por attrition.
        </p>
      ) : null}

      {/* Mini barras por día (patrón AllotmentLifecycleRow) */}
      {group.days.length > 0 ? (
        <div>
          <p className="bo-muted" style={{ fontSize: 11, margin: "0 0 4px 0", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Día a día · {group.days.length} noches
          </p>
          <div style={{
            display: "flex",
            gap: 1,
            alignItems: "flex-end",
            height: 60,
            background: "var(--surface-2, rgba(0,0,0,0.03))",
            padding: 4,
            borderRadius: 4,
            overflow: "auto"
          }}>
            {group.days.map((d) => {
              const total = Math.max(1, d.blocked);
              const pkH = Math.round((d.pickedUp / total) * 52);
              const rmH = Math.round((d.remaining / total) * 52);
              const dayPickupPct = d.blocked > 0 ? Math.round((d.pickedUp / d.blocked) * 100) : 0;
              return (
                <div
                  key={d.date}
                  title={`${new Date(d.date).toLocaleDateString("es-ES")}\nBloqueado: ${d.blocked}\nVendido: ${d.pickedUp} (${dayPickupPct}%)\nDisponible: ${d.remaining}`}
                  style={{
                    minWidth: 6,
                    flex: "1 1 auto",
                    height: "100%",
                    display: "flex",
                    flexDirection: "column-reverse",
                    cursor: "help"
                  }}
                >
                  <div style={{ height: pkH, background: "var(--ok, #0d8a5f)" }} />
                  <div style={{ height: rmH, background: "var(--accent, #0d8a5f)", opacity: 0.25 }} />
                </div>
              );
            })}
          </div>
          <div className="bo-row" style={{ gap: 12, marginTop: 6, fontSize: 11 }}>
            <Legend color="var(--ok, #0d8a5f)" label="Vendido" />
            <Legend color="rgba(13, 138, 95, 0.25)" label="Disponible" />
            <span className="bo-muted" style={{ marginLeft: "auto" }}>Hover para ver el detalle del día</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ───────────────────────────────────────────────────────── Helpers de presentación

function Stat({ label, value, color, suffix }: { label: string; value: number; color: string; suffix?: string }) {
  return (
    <div style={{
      padding: "6px 10px",
      borderRadius: 4,
      background: "var(--surface-2, rgba(0,0,0,0.03))",
      display: "flex",
      flexDirection: "column",
      gap: 2
    }}>
      <span className="bo-muted" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</span>
      <span style={{ fontSize: 16, fontWeight: 600, color, fontFeatureSettings: '"tnum"' }}>
        {value}{suffix ?? ""}
      </span>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <span style={{ width: 10, height: 10, background: color, borderRadius: 2, display: "inline-block" }} />
      <span className="bo-muted">{label}</span>
    </span>
  );
}
