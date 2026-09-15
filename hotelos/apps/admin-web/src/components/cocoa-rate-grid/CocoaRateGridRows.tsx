// CocoaRateGridRows — one virtualised row of the rate grid (memoised).
//
// A row is absolutely positioned at `top` inside the body sizer and renders
// only the columns in [colStart, colEnd]. The sticky row label (left) is in
// flow so `position: sticky` works against the scroll container; cells are
// absolutely positioned at `labelWidth + col * cellWidth`.
//
// Row kinds: group (room type, collapsible, no cells) · availability
// ("Disponibles", editable count) · plan (BAR editable, derived greyed with
// formula chip + lock) · channel (channels view: effective price per channel).

import { memo, type MouseEvent as ReactMouseEvent } from "react";
import type { RateGridCell } from "@hotelos/shared";
import { CocoaRateGridCell, type CellCommitMode, type CellRowKind } from "./CocoaRateGridCell";
import { cellKey, channelModeLabel, derivationLabel, isWeekend, markupLabel, mealPlanLabel } from "./helpers";
import { rowCellKey } from "./rate-grid-utils";
import type { CellKey, DraftEntry, GridRow } from "./types";

export interface GridRowViewProps {
  row: GridRow;
  /** Index in the rows array (aria-rowindex = index + 2, header is 1). */
  rowIndex: number;
  top: number;
  totalWidth: number;
  dates: string[];
  colStart: number;
  colEnd: number;
  cellWidth: number;
  labelWidth: number;
  index: Map<CellKey, RateGridCell>;
  patches: Map<CellKey, DraftEntry>;
  rejected: Map<CellKey, string>;
  selection: Set<CellKey>;
  rowSelected: boolean;
  active: CellKey | null;
  editing: CellKey | null;
  editInitial: string;
  fillKeys: Set<CellKey> | null;
  today: string;
  currency: string;
  readOnly: boolean;
  canEditAvailability: boolean;
  showRecommendation: boolean;
  showSync: boolean;
  /** Restrictions view (see CocoaRateGridCell). */
  restrictionsView?: boolean;
  channelNames: Record<string, string>;
  /** Plan whose cells carry the room-type inventory (BAR or first plan). */
  inventoryPlanId: string | null;
  onCellMouseDown: (key: CellKey, event: ReactMouseEvent<HTMLDivElement>) => void;
  onCellMouseEnter: (key: CellKey, event: ReactMouseEvent<HTMLDivElement>) => void;
  onCellDoubleClick: (key: CellKey, event: ReactMouseEvent<HTMLDivElement>) => void;
  onCommitEdit: (key: CellKey, raw: string, mode: CellCommitMode) => void;
  onRecommendationClick: (key: CellKey, event: ReactMouseEvent<HTMLElement>) => void;
  onRowHeadMouseDown: (rowIndex: number, event: ReactMouseEvent<HTMLDivElement>) => void;
  onToggleGroup: (roomTypeId: string) => void;
}

function rowLabelOf(row: GridRow): string {
  switch (row.kind) {
    case "group":
      return row.roomType.name;
    case "availability":
      return `${row.roomType.name} · Disponibles`;
    case "plan":
      return `${row.roomType.name} · ${row.ratePlan.code}`;
    case "channel":
      return `${row.roomType.name} · ${row.ratePlan.code} · ${row.channel.name}`;
    default:
      return "";
  }
}

function GridRowViewImpl(props: GridRowViewProps) {
  const {
    row,
    rowIndex,
    top,
    totalWidth,
    dates,
    colStart,
    colEnd,
    cellWidth,
    labelWidth,
    index,
    patches,
    rejected,
    selection,
    rowSelected,
    active,
    editing,
    editInitial,
    fillKeys,
    today,
    currency,
    readOnly,
    canEditAvailability,
    showRecommendation,
    showSync,
    restrictionsView = false,
    channelNames,
    inventoryPlanId,
    onCellMouseDown,
    onCellMouseEnter,
    onCellDoubleClick,
    onCommitEdit,
    onRecommendationClick,
    onRowHeadMouseDown,
    onToggleGroup
  } = props;

  const ariaRowIndex = rowIndex + 2;
  const label = rowLabelOf(row);

  if (row.kind === "group") {
    const rt = row.roomType;
    return (
      <div role="row" aria-rowindex={ariaRowIndex} className="crg__row crg__row--group" style={{ top, width: totalWidth }}>
        <div className="crg__groupfill" aria-hidden="true" />
        <div
          role="rowheader"
          aria-colindex={1}
          aria-expanded={!row.collapsed}
          className="crg__rowhead crg__rowhead--group"
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            onToggleGroup(rt.id);
          }}
          title={row.collapsed ? "Mostrar planes" : "Ocultar planes"}
        >
          <span className={`crg__collapse${row.collapsed ? "" : " crg__collapse--open"}`} aria-hidden="true">
            ▸
          </span>
          <span className="crg__rowhead-title">{rt.name}</span>
          <span className="crg__rowhead-sub">
            {rt.rooms} hab.{rt.code ? ` · ${rt.code}` : ""}
          </span>
        </div>
      </div>
    );
  }

  const kind: CellRowKind = row.kind;
  const derivedRow = row.kind === "plan" && row.derived;
  const cellReadOnly = readOnly || (row.kind === "availability" && !canEditAvailability);
  const cells = [];
  for (let c = colStart; c <= colEnd && c < dates.length; c++) {
    const date = dates[c];
    const key = rowCellKey(row, date);
    if (!key) continue;
    const sourceKey = row.kind === "availability" ? (inventoryPlanId ? cellKey(inventoryPlanId, row.roomType.id, date) : null) : cellKey(row.ratePlan.id, row.roomType.id, date);
    const cell = sourceKey ? (index.get(sourceKey) ?? null) : null;
    cells.push(
      <CocoaRateGridCell
        key={key}
        cellKey={key}
        rowIndex={ariaRowIndex}
        colIndex={c + 2}
        left={labelWidth + c * cellWidth}
        kind={kind}
        cell={cell}
        entry={patches.get(key) ?? null}
        currency={currency}
        rowLabel={label}
        date={date}
        selected={selection.has(key)}
        active={active === key}
        editing={editing === key}
        editInitial={editing === key ? editInitial : ""}
        fillPreview={fillKeys ? fillKeys.has(key) : false}
        weekend={isWeekend(date)}
        today={date === today}
        readOnly={cellReadOnly}
        derivedRow={derivedRow}
        showRecommendation={showRecommendation && row.kind === "plan"}
        recommendationRejected={rejected.has(key)}
        showSync={showSync}
        restrictionsView={restrictionsView}
        channelNames={channelNames}
        channelId={row.kind === "channel" ? row.channel.id : undefined}
        channelMarkup={row.kind === "channel" ? row.channel.markupPercent : undefined}
        onMouseDown={onCellMouseDown}
        onMouseEnter={onCellMouseEnter}
        onDoubleClick={onCellDoubleClick}
        onCommitEdit={onCommitEdit}
        onRecommendationClick={onRecommendationClick}
      />
    );
  }

  const headClasses = ["crg__rowhead", `crg__rowhead--${row.kind}`];
  if (rowSelected) headClasses.push("crg__rowhead--selected");

  return (
    <div role="row" aria-rowindex={ariaRowIndex} className="crg__row" style={{ top, width: totalWidth }}>
      <div
        role="rowheader"
        aria-colindex={1}
        className={headClasses.join(" ")}
        title={`${label}. Clic para seleccionar la fila`}
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          onRowHeadMouseDown(rowIndex, e);
        }}
      >
        {row.kind === "availability" ? (
          <>
            <span className="crg__rowhead-title">Disponibles</span>
            <span className="crg__rowhead-sub">{canEditAvailability && !readOnly ? "editable" : "solo lectura"}</span>
          </>
        ) : row.kind === "plan" ? (
          <>
            <span className="crg__rowhead-title" title={row.ratePlan.name}>
              {row.ratePlan.code}
            </span>
            {row.derived ? (
              <span className="crg__rowhead-formula" title={`Derivado de ${parentCode(row, index, dates)}`}>
                <span aria-hidden="true">🔒</span>
                {derivationLabel(parentCode(row, index, dates), row.ratePlan.derivation, currency)}
              </span>
            ) : row.ratePlan.mealPlan ? (
              <span className="crg__rowhead-sub" title={row.ratePlan.mealPlan}>
                {mealPlanLabel(row.ratePlan.mealPlan)}
              </span>
            ) : null}
          </>
        ) : (
          <>
            <span className="crg__rowhead-title" title={row.channel.name}>
              {row.channel.name}
            </span>
            <span className="crg__rowhead-sub" title="El precio de la fila es el precio base con el recargo del canal; solo se editan sus restricciones">
              {markupLabel(row.channel.markupPercent)}
              {row.channel.mode !== "real" ? ` · ${channelModeLabel(row.channel.mode)}` : ""}
            </span>
          </>
        )}
      </div>
      {cells}
    </div>
  );
}

function parentCode(row: Extract<GridRow, { kind: "plan" }>, index: Map<CellKey, RateGridCell>, dates: string[]): string {
  // The parent code travels with the cells (`derivedFrom.ratePlanCode`); fall back to "BAR".
  for (const d of dates) {
    const c = index.get(cellKey(row.ratePlan.id, row.roomType.id, d));
    if (c?.derivedFrom) return c.derivedFrom.ratePlanCode;
    if (c) break;
  }
  return "BAR";
}

export const GridRowView = memo(GridRowViewImpl);
export default GridRowView;
