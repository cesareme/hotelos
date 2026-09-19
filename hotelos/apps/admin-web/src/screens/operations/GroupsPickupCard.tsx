// GroupsPickupCard · pickup of the group blocks on the Grupos y eventos board.
//
// Cocoa 22 (ola 3 · lote 3-B, archetype «otro», template PlantillaBase): a
// CocoaSection with one CocoaCard per group (interactive when `onSelect` is
// given: role=button, Enter/Space). Each card shows code · name · type and
// status badges, the pickup badge and the closest deadline (cut-off or
// arrival), four CocoaStat (blocked · sold · available · pickup), an
// attrition callout when the pickup sits below the contracted threshold and
// the day-by-day pickup as CocoaChart.Bars (tooltip with the counts).
//
// Endpoint: GET /properties/:propertyId/groups/pickup-summary?windowDays=90
// (polled every minute). Pickup tone: < 40 % danger · 40–79 % warning ·
// ≥ 80 % success (industry thresholds).

import type { CSSProperties } from "react";
import { useApiData } from "../../hooks/useApiData";
import { toArray } from "../../utils/toArray";
import { date, dateRange, number, percent, plural } from "../../lib/format";
import {
  CocoaBadge,
  CocoaStatusBadge,
  CocoaCallout,
  CocoaCard,
  CocoaChart,
  CocoaSection,
  CocoaSkeleton,
  CocoaStat,
  CocoaState,
  type CocoaBarsDatum,
  type CocoaTone
} from "../../components/cocoa";
import { BAR_KIND, RESERVATION_STATUS, UNKNOWN_STATUS, type StatusEntry } from "../../content/status-dictionary";

// ───────────────────────────────────────────────────────── API types

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

// ───────────────────────────────────────────────────────── Labels and tones

const GROUP_TYPE_LABEL: Record<string, string> = {
  wedding: "Boda",
  corporate: "Corporativo",
  leisure: "Ocio",
  mice: "MICE",
  smerf: "SMERF",
  sports: "Deportivo",
  wholesale: "Mayorista",
  tour: "Circuito",
  family: "Familiar",
  other: "Otro"
};

// Estado del grupo: las fases propias de grupos (consulta, provisional) más
// las que comparte con la reserva, tomadas del diccionario común (UX-1 · U2, D5).
const STATUS_META: Record<string, StatusEntry> = {
  inquiry: { label: "Consulta", short: "Consulta", tone: "neutral", icon: "info-circle" },
  tentative: { label: "Provisional", short: "Prov.", tone: "warning", icon: "clock" },
  definite: RESERVATION_STATUS.confirmed,
  confirmed: RESERVATION_STATUS.confirmed,
  in_house: BAR_KIND.in_house,
  cancelled: RESERVATION_STATUS.cancelled
};

function pickupTone(pct: number): CocoaTone {
  return pct >= 80 ? "success" : pct >= 40 ? "warning" : "danger";
}

function pickupLabel(pct: number): string {
  return pct >= 80 ? "saludable" : pct >= 40 ? "medio" : pct >= 1 ? "bajo" : "sin pickup";
}

const NOTE_STYLE: CSSProperties = {
  margin: 0,
  color: "var(--cocoa-label-secondary)",
  fontSize: "var(--cocoa-fs-callout)"
};

// ───────────────────────────────────────────────────────── Component

export function GroupsPickupCard(props: { propertyId: string; onSelect?: (groupId: string) => void }) {
  const pickup = useApiData<Response>(`/properties/${props.propertyId}/groups/pickup-summary?windowDays=90`, { pollIntervalMs: 60000 });
  const groups = toArray<GroupPickupSummary>(pickup.data?.groups);

  if (pickup.loading && !pickup.data) {
    return (
      <CocoaSection title="Pickup de grupos" meta="próximos 90 días">
        <CocoaSkeleton variant="card" height={160} />
      </CocoaSection>
    );
  }

  return (
    <CocoaSection title="Pickup de grupos" meta={`próximos 90 días · ${plural(groups.length, "grupo", "grupos")}`}>
      <p style={NOTE_STYLE}>
        Estado del bloque día a día (bloqueadas, vendidas, disponibles). Aviso de penalización cuando el pickup actual queda por debajo del umbral pactado en
        el contrato.
      </p>
      {pickup.error && !pickup.data ? (
        <CocoaState kind="error" inline title={pickup.error} onRetry={() => pickup.refresh()} />
      ) : groups.length === 0 ? (
        <CocoaState kind="empty" inline title="Sin grupos con bloqueo en los próximos 90 días." />
      ) : (
        <div className="cocoa-stack" data-gap="3">
          {groups.map((g) => (
            <GroupPickupRow key={g.groupBookingId} group={g} onSelect={props.onSelect} />
          ))}
        </div>
      )}
    </CocoaSection>
  );
}

// ───────────────────────────────────────────────────────── Group row

function GroupPickupRow({ group, onSelect }: { group: GroupPickupSummary; onSelect?: (groupId: string) => void }) {
  const tone = pickupTone(group.pickupPct);
  const status = STATUS_META[group.status.toLowerCase()] ?? UNKNOWN_STATUS;

  // Closest deadline: cut-off when it exists and comes first, else arrival.
  let proximityText: string;
  if (group.daysToCutOff != null && group.daysToCutOff <= group.daysToArrival) {
    proximityText = group.daysToCutOff <= 0 ? "Fecha límite vencida" : `Fecha límite en ${plural(group.daysToCutOff, "día", "días")}`;
  } else {
    proximityText = group.daysToArrival <= 0 ? "Llegada hoy" : `Llegada en ${plural(group.daysToArrival, "día", "días")}`;
  }

  const clickable = typeof onSelect === "function";

  const bars: CocoaBarsDatum[] = group.days.map((d) => {
    const dayPickupPct = d.blocked > 0 ? Math.round((d.pickedUp / d.blocked) * 100) : 0;
    return {
      label: date(d.date, "dayMonth"),
      value: dayPickupPct,
      tone: pickupTone(dayPickupPct),
      hint: `Bloqueadas ${number(d.blocked)} · Vendidas ${number(d.pickedUp)} · Disponibles ${number(d.remaining)}`
    };
  });

  return (
    <CocoaCard
      variant="bordered"
      padding="sm"
      onClick={clickable ? () => onSelect(group.groupBookingId) : undefined}
      aria-label={clickable ? `Abrir el grupo ${group.name}` : undefined}
    >
      <div className="cocoa-stack" data-gap="3">
        <div className="cocoa-row" data-gap="3" data-justify="between" data-align="start">
          <div className="cocoa-stack" data-gap="1">
            <div className="cocoa-cluster">
              <strong className="cocoa-mono">{group.code}</strong>
              <span>{group.name}</span>
              <CocoaBadge tone="neutral">{GROUP_TYPE_LABEL[group.groupType.toLowerCase()] ?? group.groupType}</CocoaBadge>
              <CocoaStatusBadge entry={status} />
            </div>
            <span style={NOTE_STYLE}>
              {dateRange(group.arrivalDate, group.departureDate)} · {plural(group.totalBlocked, "habitación bloqueada", "habitaciones bloqueadas")}
              {group.cutOffDate ? ` · fecha límite ${date(group.cutOffDate, "dayMonth")}` : ""}
            </span>
          </div>
          <div className="cocoa-stack" data-gap="1" style={{ alignItems: "flex-end" }}>
            <CocoaBadge tone={tone} variant="tinted">
              {percent(group.pickupPct)} pickup · {pickupLabel(group.pickupPct)}
            </CocoaBadge>
            <span style={NOTE_STYLE}>{proximityText}</span>
          </div>
        </div>

        <div className="cocoa-row" data-gap="4" data-align="start">
          <CocoaStat label="Bloqueadas" value={number(group.totalBlocked)} />
          <CocoaStat label="Vendidas" value={number(group.totalPickedUp)} tone="success" />
          <CocoaStat label="Disponibles" value={number(group.totalRemaining)} tone="accent" />
          <CocoaStat label="Pickup" value={percent(group.pickupPct)} tone={tone} />
        </div>

        {group.belowAttritionThreshold ? (
          <CocoaCallout tone="warning" title={`Pickup ${percent(group.pickupPct)} por debajo del umbral ${percent(group.attritionThresholdPct)}`}>
            Riesgo de penalización por no ocupación (attrition).
          </CocoaCallout>
        ) : null}

        {group.days.length > 0 ? (
          <div className="cocoa-stack" data-gap="1">
            <span className="cocoa-caption">Día a día · {plural(group.days.length, "noche", "noches")}</span>
            <CocoaChart.Bars
              data={bars}
              height={72}
              valueFormat={(value) => percent(value, { maximumFractionDigits: 0 })}
              aria-label={`Pickup día a día del grupo ${group.name}`}
            />
          </div>
        ) : null}
      </div>
    </CocoaCard>
  );
}
