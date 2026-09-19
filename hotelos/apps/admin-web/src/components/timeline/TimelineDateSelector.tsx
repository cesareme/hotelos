// Live Timeline · periodo y escala (Tanda TL · lote TL-2).
//
// Toolbar de contenido: Anterior · Hoy · Siguiente, la etiqueta del rango,
// un selector de fecha para saltar a un día, y a la derecha la escala
// Día/Semana/Mes (7/14/30 días) como CocoaSegmentedControl (≤ 4 opciones).
// Sin estilos inline.

import { CocoaBadge, CocoaButton, CocoaDatePicker, CocoaSegmentedControl, CocoaToolbar } from "../cocoa";
import { ACTIONS, TIME_LABELS } from "../../content/actions";
import { GRANULARITY_DAYS, type Granularity } from "../../screens/timeline/timeline-engine";

export type TimelineDateSelectorProps = {
  /** Texto del rango visible (lo formatea la pantalla con dateRange). */
  rangeLabel: string;
  granularity: Granularity;
  onGranularityChange(g: Granularity): void;
  onPrev(): void;
  onNext(): void;
  onToday(): void;
  /** Fecha de anclaje «YYYY-MM-DD» del CocoaDatePicker. */
  anchorIso: string;
  onPickDate(iso: string): void;
  loading?: boolean;
};

export const GRANULARITY_OPTIONS: ReadonlyArray<{ value: Granularity; label: string }> = [
  { value: "day", label: `Día · ${GRANULARITY_DAYS.day}` },
  { value: "week", label: `Semana · ${GRANULARITY_DAYS.week}` },
  { value: "month", label: `Mes · ${GRANULARITY_DAYS.month}` }
];

export const LOADING_PERIOD_LABEL = "Cargando periodo…";
/** aria-label de los botones de navegación (sustantivo + adjetivo, como en español). */
export const PREVIOUS_PERIOD_LABEL = "Periodo anterior";
export const NEXT_PERIOD_LABEL = "Periodo siguiente";

function isGranularity(value: string): value is Granularity {
  return value === "day" || value === "week" || value === "month";
}

export function TimelineDateSelector({
  rangeLabel,
  granularity,
  onGranularityChange,
  onPrev,
  onNext,
  onToday,
  anchorIso,
  onPickDate,
  loading = false
}: TimelineDateSelectorProps) {
  return (
    <CocoaToolbar
      variant="content"
      aria-label="Periodo y escala del Live Timeline"
      leftSlot={
        <>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={onPrev} aria-label={PREVIOUS_PERIOD_LABEL}>
            {ACTIONS.previous}
          </CocoaButton>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={onToday}>
            {TIME_LABELS.today}
          </CocoaButton>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={onNext} aria-label={NEXT_PERIOD_LABEL}>
            {ACTIONS.next}
          </CocoaButton>
          <strong className="cocoa-tabular">
            {rangeLabel}
          </strong>
          <CocoaDatePicker value={anchorIso} onChange={onPickDate} size="small" aria-label="Ir a la fecha" />
        </>
      }
      rightSlot={
        <>
          <CocoaSegmentedControl
            value={granularity}
            onChange={(value) => {
              if (isGranularity(value)) onGranularityChange(value);
            }}
            options={GRANULARITY_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
            size="small"
            aria-label="Escala"
          />
          {loading ? (
            <CocoaBadge tone="info" variant="dot">
              {LOADING_PERIOD_LABEL}
            </CocoaBadge>
          ) : null}
        </>
      }
    />
  );
}

export default TimelineDateSelector;
