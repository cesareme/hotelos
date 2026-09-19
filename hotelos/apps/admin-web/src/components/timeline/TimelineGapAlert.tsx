// Live Timeline · alerta de overbooking (Tanda TL · lote TL-2).
//
// Callout de peligro con la lista de días por tipo (confirmadas + en casa >
// vendibles, overbookingDays del motor) y «Ir al día» por fila; si además hay
// reservas solapadas en la misma habitación (roomOverlapCount), un badge con
// el recuento. Devuelve null cuando no hay nada que avisar. Sin estilos inline.

import { CocoaBadge, CocoaButton, CocoaCallout } from "../cocoa";
import { date, plural } from "../../lib/format";
import { overbookingSummary, type OverbookingDay } from "../../screens/timeline/timeline-engine";

export type TimelineGapAlertProps = {
  days: OverbookingDay[];
  roomOverlaps: number;
  onGoToDay(dayKey: string): void;
};

export const ROOM_OVERLAPS_TITLE = "Solapes en la misma habitación";
export const GO_TO_DAY_LABEL = "Ir al día";

/** Título del callout: «3 días con overbooking» o el aviso de solapes. */
export function gapAlertTitle(days: ReadonlyArray<OverbookingDay>): string {
  if (days.length === 0) return ROOM_OVERLAPS_TITLE;
  return plural(overbookingSummary(days).count, "día con overbooking", "días con overbooking");
}

export function TimelineGapAlert({ days, roomOverlaps, onGoToDay }: TimelineGapAlertProps) {
  if (days.length === 0 && roomOverlaps === 0) return null;
  return (
    <CocoaCallout tone="danger" role="alert" title={gapAlertTitle(days)}>
      {days.length > 0 ? (
        <ul className="c22-section__list">
          {days.map((day) => (
            <li key={`${day.dayKey}:${day.roomTypeId}`}>
              <span>
                {date(day.dayKey, "weekdayShort")} · {day.roomTypeName}: {plural(day.booked, "reserva", "reservas")} /{" "}
                {plural(day.sellable, "vendible", "vendibles")}
              </span>
              <CocoaButton variant="plain" size="small" onClick={() => onGoToDay(day.dayKey)} aria-label={`${GO_TO_DAY_LABEL} ${date(day.dayKey, "weekdayShort")}`}>
                {GO_TO_DAY_LABEL}
              </CocoaButton>
            </li>
          ))}
        </ul>
      ) : null}
      {roomOverlaps > 0 ? (
        <CocoaBadge tone="danger">{plural(roomOverlaps, "solape en la misma habitación", "solapes en la misma habitación")}</CocoaBadge>
      ) : null}
    </CocoaCallout>
  );
}

export default TimelineGapAlert;
