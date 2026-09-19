// Live Timeline · filtros (Tanda TL · lote TL-2).
//
// Búsqueda (código, huésped o habitación, con debounce) + chips por estado,
// canal y tipo de habitación (patrón de la pantalla Cronograma actual) +
// «Limpiar filtros» solo cuando hay algo que limpiar. Los recuentos vienen
// ya calculados por la pantalla; el estado efectivo (`effective`) resuelve
// los `null` de TimelineFilters con effectiveFilters del motor. Los chips no
// llevan `title`: el id técnico del canal o del tipo no es copy. Sin estilos inline.

import { CocoaButton, CocoaSearchInput } from "../cocoa";
import { ACTIONS } from "../../content/actions";
import type { TimelineFilters } from "../../screens/timeline/timeline-engine";

export type TimelineFilterGroup = "status" | "channel" | "roomType";

export type TimelineFilterOption = { id: string; label: string; count: number };

export type TimelineFilterBarProps = {
  statuses: TimelineFilterOption[];
  channels: TimelineFilterOption[];
  roomTypes: TimelineFilterOption[];
  filters: TimelineFilters;
  effective: { status: string[]; channel: string[]; roomType: string[] };
  onToggle(group: TimelineFilterGroup, id: string): void;
  onQuery(q: string): void;
  onClear(): void;
  touched: boolean;
};

export const FILTER_GROUP_LABEL: Record<TimelineFilterGroup, string> = {
  status: "Estado",
  channel: "Canal",
  roomType: "Tipo"
};

export const SEARCH_PLACEHOLDER = "Código, huésped o habitación";

const GROUPS: readonly TimelineFilterGroup[] = ["status", "channel", "roomType"];

function ChipGroup({
  group,
  options,
  active,
  onToggle
}: {
  group: TimelineFilterGroup;
  options: TimelineFilterOption[];
  active: string[];
  onToggle(group: TimelineFilterGroup, id: string): void;
}) {
  if (options.length === 0) return null;
  return (
    <>
      <span className="cocoa-caption">{FILTER_GROUP_LABEL[group]}</span>
      {options.map((option) => {
        const isActive = active.includes(option.id);
        return (
          <CocoaButton
            key={option.id}
            variant={isActive ? "tinted" : "bordered"}
            tone={isActive ? "accent" : "neutral"}
            size="small"
            aria-pressed={isActive}
            onClick={() => onToggle(group, option.id)}
          >
            {option.label} · {option.count}
          </CocoaButton>
        );
      })}
    </>
  );
}

export function TimelineFilterBar({ statuses, channels, roomTypes, filters, effective, onToggle, onQuery, onClear, touched }: TimelineFilterBarProps) {
  const optionsByGroup: Record<TimelineFilterGroup, TimelineFilterOption[]> = { status: statuses, channel: channels, roomType: roomTypes };
  return (
    <div className="cocoa-row" data-gap="2" data-wrap="true" role="group" aria-label="Filtros del Live Timeline">
      <CocoaSearchInput
        value={filters.query}
        onChange={onQuery}
        placeholder={SEARCH_PLACEHOLDER}
        debounceMs={250}
        aria-label="Buscar en el timeline"
      />
      {GROUPS.map((group) => (
        <ChipGroup key={group} group={group} options={optionsByGroup[group]} active={effective[group]} onToggle={onToggle} />
      ))}
      {touched ? (
        <CocoaButton variant="plain" tone="neutral" size="small" onClick={onClear}>
          {ACTIONS.clearFilters}
        </CocoaButton>
      ) : null}
    </div>
  );
}

export default TimelineFilterBar;
