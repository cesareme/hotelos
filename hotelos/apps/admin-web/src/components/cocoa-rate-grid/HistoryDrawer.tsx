// HistoryList / HistoryDrawer — rate change journal (list + per-cell diff).
//
// ONE implementation of the journal list (Cocoa 22 · ola 5 · lote 5-A):
//   · `HistoryList` is the body — entries with who, when, reason, N changes,
//     publish status per channel (CocoaBadge) and draft/published/reverted
//     state; «Ver cambios» loads the items on demand (`onShowDiff`) and
//     renders them grouped by room type › plan › consecutive date range with
//     before → after; «Revertir» delegates to the screen (which confirms and
//     calls the API); «Cargar más» pages the journal.
//   · `HistoryDrawer` mounts that list in the editor's side panel (not modal:
//     the grid stays usable while the history is open).
//   · The «Historial» tab of Parrilla de tarifas (RateJournalScreen) paints
//     the same list inline, inside a CocoaSection — the drawer and the tab
//     read the same.

import { useMemo } from "react";
import type { RateChangeJournalEntry } from "@hotelos/shared";
import { CocoaBadge, CocoaButton, CocoaSkeleton, CocoaState, type CocoaTone } from "../cocoa";
import { formatDateRange, formatDateTime, journalFieldLabel, journalStatusLabel, journalValueLabel, pluralize, type JournalStatusTone } from "./helpers";
import { groupDiffByTypeAndPlan } from "./rate-grid-utils";
import { RateGridSidePanel } from "./shared-ui";
import type { DiffItem, HistoryDrawerProps, HistoryListProps } from "./types";

// Field / value labels live in helpers.ts (journalFieldLabel / journalValueLabel)
// so «Origen» (source manual/derivado/importado/RMS) and «Precio derivado
// (automático)» are unit-tested and shared with the standalone journal screen.
const fieldLabel = journalFieldLabel;
const valueLabel = journalValueLabel;

const BADGE_TONE: Record<JournalStatusTone, CocoaTone> = { muted: "neutral", ok: "success", warn: "warning", danger: "danger", accent: "accent" };

/** Badge text of a journal status (pure): the tone carries the meaning, so the leading glyph of the label is dropped. */
export function journalBadgeText(label: string): string {
  return label.replace(/^(?:✓|✕|…)\s*/u, "");
}

function statusBadge(e: RateChangeJournalEntry) {
  // A save without publish and a revert both leave the PMS updated: they read
  // "guardado sin enviar a canales", never "borrador" (see journalStatusLabel).
  const { label, tone } = journalStatusLabel(e);
  return (
    <CocoaBadge tone={BADGE_TONE[tone]} variant="tinted" uppercase={false}>
      {journalBadgeText(label)}
    </CocoaBadge>
  );
}

/** «3 entradas · hay más» / «Cargando…» / «Sin cambios registrados» (pure). */
export function historySummary(input: { count: number; hasMore: boolean; loading: boolean }): string {
  if (input.count > 0) return `${pluralize(input.count, "entrada", "entradas")}${input.hasMore ? " · hay más" : ""}`;
  return input.loading ? "Cargando…" : "Sin cambios registrados";
}

export function HistoryList(props: HistoryListProps) {
  const { items, hasMore, loading = false, roomTypes, ratePlans, channels, expandedId, expandedItems, onLoadMore, onRevert, onShowDiff } = props;
  const channelName = useMemo(() => new Map((channels ?? []).map((c) => [c.id, c.name] as const)), [channels]);

  const expandedGroups = useMemo(() => {
    if (!expandedId || !expandedItems) return null;
    const diff: DiffItem[] = expandedItems.map((it) => ({
      key: `${it.ratePlanId}|${it.roomTypeId}|${it.date}${it.channelId ? `|${it.channelId}` : ""}`,
      ratePlanId: it.ratePlanId,
      roomTypeId: it.roomTypeId,
      date: it.date,
      channelId: it.channelId ?? null,
      field: it.field,
      before: it.before,
      after: it.after
    }));
    return groupDiffByTypeAndPlan(diff, roomTypes, ratePlans);
  }, [expandedId, expandedItems, roomTypes, ratePlans]);

  if (items.length === 0) {
    if (loading) {
      return (
        <div className="crg-list__skeleton" aria-busy="true" aria-label="Cargando el historial">
          <CocoaSkeleton variant="row" />
          <CocoaSkeleton variant="row" />
          <CocoaSkeleton variant="row" />
        </div>
      );
    }
    return <CocoaState kind="empty" inline title="Sin cambios registrados" message="Cada guardado o publicación del editor crea una entrada con el detalle de cada celda modificada." />;
  }

  return (
    <>
      <ul className="crg-list">
        {items.map((e) => {
          const isOpen = expandedId === e.id;
          return (
            <li key={e.id} className="crg-list__item">
              <div className="crg-list__row">
                <div className="crg-list__main">
                  <div className="crg-list__title">
                    {e.reason || "Sin motivo"} <span className="crg-note">· {pluralize(e.changesCount, "cambio", "cambios")}</span>
                  </div>
                  <div className="crg-note">
                    {e.userEmail ?? e.userId} · {formatDateTime(e.timestamp) ?? e.timestamp}
                    {e.pushedTo.length ? ` · ${e.pushedTo.map((id) => channelName.get(id) ?? id).join(", ")}` : ""}
                    {e.revertedByJournalId ? <span title={`Entrada de reversión: ${e.revertedByJournalId}`}> · revertido más tarde</span> : null}
                    {e.revertsJournalId ? <span title={`Revierte la entrada ${e.revertsJournalId}`}> · revierte la entrada …{e.revertsJournalId.slice(-6)}</span> : null}
                  </div>
                </div>
                <div className="crg-list__actions">
                  {statusBadge(e)}
                  <CocoaButton variant="plain" size="small" tone="neutral" onClick={() => onShowDiff(e.id)} aria-expanded={isOpen}>
                    {isOpen ? "Ocultar" : "Ver cambios"}
                  </CocoaButton>
                  <CocoaButton
                    variant="bordered"
                    size="small"
                    tone="destructive"
                    onClick={() => onRevert(e.id)}
                    disabled={e.status === "reverted" || loading || e.changesCount === 0}
                    title={e.changesCount === 0 ? "Esta entrada no cambió ninguna celda: no hay nada que revertir" : undefined}
                  >
                    Revertir
                  </CocoaButton>
                </div>
              </div>
              {isOpen ? (
                <div className="crg-list__detail">
                  {!expandedItems ? (
                    <p className="crg-note">Cargando cambios…</p>
                  ) : expandedGroups && expandedGroups.length ? (
                    expandedGroups.map((g) => (
                      <div key={g.roomTypeId} className="crg-tree__type">
                        <div className="crg-tree__type-head">
                          <span>{g.roomTypeName}</span>
                          <CocoaBadge tone="neutral" uppercase={false}>
                            {pluralize(g.cellCount, "celda", "celdas")}
                          </CocoaBadge>
                        </div>
                        {g.plans.map((p) => (
                          <div key={p.ratePlanId} className="crg-tree__plan">
                            <div className="crg-tree__plan-head">
                              <span>{p.ratePlanCode}</span>
                              <span>{pluralize(p.cellCount, "celda", "celdas")}</span>
                            </div>
                            {p.ranges.map((r, i) => (
                              <div key={`${r.field}-${r.from}-${i}`} className="crg-tree__range">
                                <span>
                                  {formatDateRange(r.from, r.to)}
                                  {r.count > 1 ? ` (${r.count})` : ""} · {fieldLabel(r.field)}
                                </span>
                                <span>
                                  <span className="crg-before">{valueLabel(r.field, r.before)}</span>
                                  <span className="crg-arrow">→</span>
                                  <span className="crg-after">{valueLabel(r.field, r.after)}</span>
                                </span>
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    ))
                  ) : (
                    <p className="crg-note">Esta entrada no tiene detalle por celda.</p>
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {hasMore ? (
        <div className="crg-list__more">
          <CocoaButton variant="bordered" size="small" tone="neutral" onClick={onLoadMore} loading={loading} disabled={loading}>
            Cargar más
          </CocoaButton>
        </div>
      ) : null}
    </>
  );
}

export function HistoryDrawer(props: HistoryDrawerProps) {
  const { open, onClose, ...list } = props;
  return (
    <RateGridSidePanel open={open} title="Historial de cambios" subtitle={historySummary({ count: list.items.length, hasMore: list.hasMore, loading: list.loading ?? false })} onClose={onClose} wide>
      <HistoryList {...list} />
    </RateGridSidePanel>
  );
}

export default HistoryDrawer;
