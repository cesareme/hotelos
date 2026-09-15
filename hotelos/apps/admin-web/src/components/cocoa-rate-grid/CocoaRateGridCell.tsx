// CocoaRateGridCell — one memoised cell of the rate grid.
//
// Everything visible in a cell is derived from stable props (the persisted
// `cell` object from the response index, the `entry` from the draft Map and
// a handful of booleans) so `React.memo` skips re-renders for the thousands
// of cells that did not change. Callbacks are keyed by cell key and must be
// referentially stable (the grid wraps them with refs).
//
// Visual states (class toggles, see rate-grid.css):
//   price (es-ES, "sin tarifa" when null) · restriction chips · amber
//   "modificado sin publicar" triangle with before→after tooltip · violet
//   dashed border + "→ 132 €" for a recommendation · sync dot (status is also
//   in the aria-label and tooltip, never colour-only) · derived lock + grey
//   background · today marker · weekend tint · inline expression input ·
//   restrictions view (price dimmed, every restriction spelled out, "—" when
//   none) · "hold" recommendations get a muted «=» button so the factors can
//   still be inspected · channel rows are read-only for the price (base ×
//   markup) and say so in the tooltip before any edit attempt.

import { memo, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import type { CellSyncState, RateGridCell } from "@hotelos/shared";
import {
  SYNC_STATUS_META,
  aggregateSyncStatus,
  describeRestrictions,
  describeSync,
  effectivePriceForChannel,
  formatDateLong,
  formatMoney,
  formatPercent,
  resolveViewCell,
  restrictionChips
} from "./helpers";
import { parseExpression } from "./expressions";
import type { CellKey, DraftEntry } from "./types";

export type CellRowKind = "plan" | "availability" | "channel";

export type CellCommitMode = "enter" | "tab" | "blur" | "escape" | "shift-enter" | "shift-tab";

export interface CocoaRateGridCellProps {
  cellKey: CellKey;
  rowIndex: number;
  colIndex: number;
  left: number;
  kind: CellRowKind;
  cell: RateGridCell | null;
  entry: DraftEntry | null;
  currency: string;
  /** "Doble · BAR" — row-level label used in aria-label. */
  rowLabel: string;
  date: string;
  selected: boolean;
  active: boolean;
  editing: boolean;
  /** Initial text of the inline editor (typed char or current price). */
  editInitial: string;
  fillPreview: boolean;
  weekend: boolean;
  today: boolean;
  readOnly: boolean;
  derivedRow: boolean;
  showRecommendation: boolean;
  recommendationRejected: boolean;
  showSync: boolean;
  /** Restrictions view: dim the price and list every restriction (or "—"). */
  restrictionsView?: boolean;
  channelNames: Record<string, string>;
  /** Channel rows: channel id + markup; the price shown is the channel's effective price. */
  channelId?: string;
  channelMarkup?: number;
  onMouseDown: (key: CellKey, event: ReactMouseEvent<HTMLDivElement>) => void;
  onMouseEnter: (key: CellKey, event: ReactMouseEvent<HTMLDivElement>) => void;
  onDoubleClick: (key: CellKey, event: ReactMouseEvent<HTMLDivElement>) => void;
  onCommitEdit: (key: CellKey, raw: string, mode: CellCommitMode) => void;
  onRecommendationClick: (key: CellKey, event: ReactMouseEvent<HTMLElement>) => void;
}

function syncTooltip(sync: Record<string, CellSyncState> | undefined, channelNames: Record<string, string>, channelId?: string): string {
  if (!sync) return "Sin enviar";
  const entries = channelId ? [[channelId, sync[channelId]] as const] : Object.entries(sync);
  const lines = entries.filter(([, s]) => s).map(([id, s]) => describeSync(channelNames[id] ?? id, s));
  return lines.length ? lines.join("\n") : "Sin enviar";
}

function CocoaRateGridCellImpl(props: CocoaRateGridCellProps) {
  const {
    cellKey,
    rowIndex,
    colIndex,
    left,
    kind,
    cell,
    entry,
    currency,
    rowLabel,
    date,
    selected,
    active,
    editing,
    editInitial,
    fillPreview,
    weekend,
    today,
    readOnly,
    derivedRow,
    showRecommendation,
    recommendationRejected,
    showSync,
    restrictionsView = false,
    channelNames,
    channelId,
    channelMarkup,
    onMouseDown,
    onMouseEnter,
    onDoubleClick,
    onCommitEdit,
    onRecommendationClick
  } = props;

  const view = resolveViewCell(cellKey, cell, entry);
  const isAvail = kind === "availability";
  const isChannel = kind === "channel";

  // Price to display: availability count, channel effective price, or base.
  let displayPrice: number | null = view.basePrice;
  if (isChannel) {
    displayPrice = cell?.channelId === channelId && !entry ? (cell?.effectivePrice ?? null) : effectivePriceForChannel(view.basePrice, channelMarkup ?? 0);
  }
  const availValue = view.available;

  const chips = isAvail ? [] : restrictionChips(view.restrictions);
  const closed = Boolean(view.restrictions.closed);
  const stop = Boolean(view.restrictions.stopSell) || Boolean(cell?.inventory?.stopSell);
  const anyRec = showRecommendation && !recommendationRejected && cell?.recommendation && cell.recommendation.action !== "no_data" ? cell.recommendation : null;
  // Actionable (raise / lower with a price) → violet arrow; "hold" → muted «=»
  // so the hotelier can still open the factors and see WHY nothing is suggested.
  const rec = anyRec && anyRec.action !== "hold" && anyRec.suggestedPrice !== null ? anyRec : null;
  const holdRec = anyRec && !rec ? anyRec : null;
  const syncStatus = showSync && !isAvail ? (isChannel && channelId ? (cell?.sync?.[channelId]?.status ?? "never") : aggregateSyncStatus(cell?.sync)) : null;
  const syncMeta = syncStatus ? SYNC_STATUS_META[syncStatus] : null;
  const locked = derivedRow && view.derivedLocked && !isAvail && !isChannel;

  const classes = ["crg__cell"];
  if (selected) classes.push("crg__cell--selected");
  if (active) classes.push("crg__cell--active");
  if (editing) classes.push("crg__cell--editing");
  if (weekend) classes.push("crg__cell--weekend");
  if (today) classes.push("crg__cell--today");
  if (locked) classes.push("crg__cell--derived");
  if (readOnly || (locked && !editing)) classes.push("crg__cell--readonly");
  if (!isAvail && closed) classes.push("crg__cell--closed");
  if (!isAvail && stop) classes.push("crg__cell--stop");
  if (rec) classes.push("crg__cell--rec");
  if (fillPreview) classes.push("crg__cell--fill");
  if (isChannel) classes.push("crg__cell--channel");
  if (restrictionsView && !isAvail) classes.push("crg__cell--restr");

  // Tooltip: before → after for modified cells, restrictions otherwise.
  const titleParts: string[] = [];
  if (view.modified && entry) {
    if (isAvail) titleParts.push(`Disponibles: ${entry.before.available ?? "—"} → ${availValue ?? "—"}`);
    else if (entry.patch.price !== undefined) titleParts.push(`${formatMoney(entry.before.basePrice, currency)} → ${formatMoney(entry.patch.price, currency)} · sin publicar`);
    else titleParts.push("Modificado sin publicar");
    if (entry.patch.convertToManual) titleParts.push("Convertido en manual");
    if (entry.patch.revertToDerived) titleParts.push("Vuelve a derivado");
  }
  const restrText = describeRestrictions(view.restrictions);
  if (restrText && !isAvail) titleParts.push(restrText);
  if (locked && cell?.derivedFrom) titleParts.push(`Derivado de ${cell.derivedFrom.ratePlanCode}`);
  if (view.manualOverride && derivedRow) titleParts.push("Override manual (doble clic para volver a derivado con Supr)");
  if (isChannel) titleParts.push("Precio calculado con el recargo del canal (solo lectura): edita el precio en la fila del plan. Las restricciones se cambian con la edición rápida o masiva.");
  if (holdRec) titleParts.push(`Recomendación: mantener (confianza ${Math.round(holdRec.confidence)} %). Clic en «=» para ver los factores.`);
  if (syncMeta) titleParts.push(syncTooltip(cell?.sync, channelNames, channelId));

  const ariaParts = [rowLabel, formatDateLong(date)];
  if (isAvail) ariaParts.push(availValue === null ? "disponibilidad no gestionada" : `${availValue} disponibles`);
  else ariaParts.push(formatMoney(displayPrice, currency));
  if (restrText && !isAvail) ariaParts.push(restrText);
  if (view.modified) ariaParts.push("modificado sin publicar");
  if (locked) ariaParts.push("derivado, solo lectura");
  if (isChannel) ariaParts.push("precio de canal, solo lectura");
  if (rec) ariaParts.push(`sugerido ${formatMoney(rec.suggestedPrice, currency)}`);
  if (holdRec) ariaParts.push("recomendación: mantener");
  if (restrictionsView && !isAvail && chips.length === 0) ariaParts.push("sin restricciones");
  if (syncMeta) ariaParts.push(syncMeta.label);

  return (
    <div
      role="gridcell"
      aria-rowindex={rowIndex}
      aria-colindex={colIndex}
      aria-selected={selected}
      aria-readonly={readOnly || locked || isChannel || undefined}
      aria-label={ariaParts.join(", ")}
      data-key={cellKey}
      tabIndex={active ? 0 : -1}
      className={classes.join(" ")}
      style={{ left }}
      title={titleParts.length ? titleParts.join("\n") : undefined}
      onMouseDown={(e) => onMouseDown(cellKey, e)}
      onMouseEnter={(e) => onMouseEnter(cellKey, e)}
      onDoubleClick={(e) => onDoubleClick(cellKey, e)}
    >
      {editing ? (
        <CellEditor cellKey={cellKey} initial={editInitial} isAvail={isAvail} onCommit={onCommitEdit} />
      ) : (
        <>
          {syncMeta ? <span className={`crg__sync crg__sync--${syncMeta.tone}`} aria-hidden="true" /> : null}
          {locked ? (
            <span className="crg__lock" aria-hidden="true" title="Derivado (bloqueado)">
              🔒
            </span>
          ) : null}
          {view.modified ? <span className="crg__tri" aria-hidden="true" /> : null}
          {isAvail ? (
            <span className={`crg__price crg__price--avail${availValue === 0 ? " crg__price--zero" : availValue !== null && availValue <= 2 ? " crg__price--low" : ""}`}>
              {availValue === null ? "—" : availValue}
            </span>
          ) : displayPrice === null ? (
            <span className="crg__price crg__price--empty">sin tarifa</span>
          ) : (
            <span className="crg__price">{formatMoney(displayPrice, currency)}</span>
          )}
          {rec ? (
            <button
              type="button"
              className="crg__rec-arrow"
              style={{ background: "none", border: 0, padding: 0, cursor: "pointer" }}
              title={`Sugerido ${formatMoney(rec.suggestedPrice, currency)} (${formatPercent(rec.deltaPct ?? 0)})`}
              aria-label={`Ver recomendación: sugerido ${formatMoney(rec.suggestedPrice, currency)}`}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => onRecommendationClick(cellKey, e)}
            >
              → {formatMoney(rec.suggestedPrice, currency)}
            </button>
          ) : holdRec ? (
            <button
              type="button"
              className="crg__rec-hold"
              title={`Mantener · confianza ${Math.round(holdRec.confidence)} %`}
              aria-label={`Ver recomendación: mantener el precio (confianza ${Math.round(holdRec.confidence)} %)`}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => onRecommendationClick(cellKey, e)}
            >
              = mantener
            </button>
          ) : null}
          {restrictionsView && !isAvail ? (
            <span className="crg__restr" aria-hidden="true">
              {chips.length === 0 ? (
                <span className="crg__restr-none">—</span>
              ) : (
                <>
                  {chips.slice(0, 4).map((c) => (
                    <span key={c.key} className={`crg__chip crg__chip--${c.tone}`} title={c.label}>
                      {c.text}
                    </span>
                  ))}
                  {chips.length > 4 ? <span className="crg__chip crg__chip--muted">+{chips.length - 4}</span> : null}
                </>
              )}
            </span>
          ) : chips.length ? (
            <span className="crg__chips" aria-hidden="true">
              {chips.slice(0, 3).map((c) => (
                <span key={c.key} className={`crg__chip crg__chip--${c.tone}`} title={c.label}>
                  {c.text}
                </span>
              ))}
              {chips.length > 3 ? <span className="crg__chip crg__chip--muted">+{chips.length - 3}</span> : null}
            </span>
          ) : null}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Inline editor                                                      */
/* ------------------------------------------------------------------ */

function CellEditor({ cellKey, initial, isAvail, onCommit }: { cellKey: CellKey; initial: string; isAvail: boolean; onCommit: (key: CellKey, raw: string, mode: CellCommitMode) => void }) {
  const ref = useRef<HTMLInputElement | null>(null);
  const [value, setValue] = useState(initial);
  const committed = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // When the editor opens with the current price, select it so typing replaces it.
    if (initial && /^\d/.test(initial)) el.select();
    else el.setSelectionRange(el.value.length, el.value.length);
  }, [initial]);

  const invalid = value.trim() !== "" && (isAvail ? !/^\d{1,3}$/.test(value.trim()) : !parseExpression(value).ok);

  const commit = (mode: CellCommitMode) => {
    if (committed.current) return;
    committed.current = true;
    onCommit(cellKey, value, mode);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    // The grid container also listens; stop propagation so arrows edit text.
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commit(e.shiftKey ? "shift-enter" : "enter");
    } else if (e.key === "Tab") {
      e.preventDefault();
      commit(e.shiftKey ? "shift-tab" : "tab");
    } else if (e.key === "Escape") {
      e.preventDefault();
      commit("escape");
    }
  };

  return (
    <input
      ref={ref}
      className={`crg__input${invalid ? " crg__input--invalid" : ""}`}
      value={value}
      inputMode="decimal"
      aria-label={isAvail ? "Editar disponibles" : "Precio. Escribe 132, +10 % o −5 €"}
      aria-invalid={invalid || undefined}
      placeholder={isAvail ? "0" : "132 · +10% · −5"}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => commit("blur")}
      onMouseDown={(e) => e.stopPropagation()}
    />
  );
}

export const CocoaRateGridCell = memo(CocoaRateGridCellImpl);
export default CocoaRateGridCell;
