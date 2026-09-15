// HistoryDrawer — rate change journal (list + per-cell diff).
//
// Each entry: who, when, reason, N changes, publish status per channel and
// draft/published/reverted state. "Ver cambios" loads the items on demand
// (`onShowDiff`) and renders them grouped by room type › plan › consecutive
// date range with before → after. "Revertir" delegates to the screen (which
// confirms and calls the API); "Cargar más" pages the journal.

import { useMemo } from "react";
import type { RateChangeJournalEntry } from "@hotelos/shared";
import { CocoaButton } from "../cocoa/CocoaButton";
import { formatDateRange, formatDateTime, journalFieldLabel, journalStatusLabel, journalValueLabel, pluralize } from "./helpers";
import { groupDiffByTypeAndPlan } from "./rate-grid-utils";
import { RateGridSidePanel } from "./shared-ui";
import type { DiffItem, HistoryDrawerProps } from "./types";

// Field / value labels live in helpers.ts (journalFieldLabel / journalValueLabel)
// so «Origen» (source manual/derivado/importado/RMS) and «Precio derivado
// (automático)» are unit-tested and shared with the standalone journal screen.
const fieldLabel = journalFieldLabel;
const valueLabel = journalValueLabel;

function statusBadge(e: RateChangeJournalEntry) {
  // A save without publish and a revert both leave the PMS updated: they read
  // "guardado sin enviar a canales", never "borrador" (see journalStatusLabel).
  const { label, tone } = journalStatusLabel(e);
  const cls = tone === "muted" ? "" : ` crg-badge--${tone}`;
  return <span className={`crg-badge${cls}`}>{label}</span>;
}

export function HistoryDrawer(props: HistoryDrawerProps) {
  const { open, items, hasMore, loading = false, roomTypes, ratePlans, channels, expandedId, expandedItems, onLoadMore, onRevert, onShowDiff, onClose } = props;
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

  return (
    <RateGridSidePanel open={open} title="Historial de cambios" subtitle={items.length ? `${items.length} ${items.length === 1 ? "entrada" : "entradas"}${hasMore ? " · hay más" : ""}` : loading ? "Cargando…" : "Sin cambios registrados"} onClose={onClose} wide>
      <ul className="crg-list">
        {items.map((e) => {
          const isOpen = expandedId === e.id;
          return (
            <li key={e.id} className="crg-list__item">
              <div className="crg-list__row">
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: "var(--cocoa-fs-subheadline)", fontWeight: 600 }}>
                    {e.reason || "Sin motivo"} <span className="crg-note">· {pluralize(e.changesCount, "cambio", "cambios")}</span>
                  </div>
                  <div className="crg-note">
                    {e.userEmail ?? e.userId} · {formatDateTime(e.timestamp) ?? e.timestamp}
                    {e.pushedTo.length ? ` · ${e.pushedTo.map((id) => channelName.get(id) ?? id).join(", ")}` : ""}
                    {e.revertedByJournalId ? (
                      <span title={`Entrada de reversión: ${e.revertedByJournalId}`}> · revertido más tarde</span>
                    ) : null}
                    {e.revertsJournalId ? (
                      <span title={`Revierte la entrada ${e.revertsJournalId}`}> · revierte la entrada …{e.revertsJournalId.slice(-6)}</span>
                    ) : null}
                  </div>
                </div>
                <div style={{ display: "inline-flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
                  {statusBadge(e)}
                  <CocoaButton variant="plain" size="small" tone="neutral" onClick={() => onShowDiff(e.id)} aria-expanded={isOpen}>
                    {isOpen ? "Ocultar" : "Ver cambios"}
                  </CocoaButton>
                  <span title={e.changesCount === 0 ? "Esta entrada no cambió ninguna celda: no hay nada que revertir" : undefined} style={{ display: "inline-flex" }}>
                    <CocoaButton variant="bordered" size="small" tone="destructive" onClick={() => onRevert(e.id)} disabled={e.status === "reverted" || loading || e.changesCount === 0}>
                      Revertir
                    </CocoaButton>
                  </span>
                </div>
              </div>
              {isOpen ? (
                <div style={{ marginTop: 8 }}>
                  {!expandedItems ? (
                    <p className="crg-note">Cargando cambios…</p>
                  ) : expandedGroups && expandedGroups.length ? (
                    expandedGroups.map((g) => (
                      <div key={g.roomTypeId} className="crg-tree__type">
                        <div className="crg-tree__type-head">
                          <span>{g.roomTypeName}</span>
                          <span className="crg-badge">{pluralize(g.cellCount, "celda", "celdas")}</span>
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
        <div style={{ marginTop: 12, textAlign: "center" }}>
          <CocoaButton variant="bordered" size="small" tone="neutral" onClick={onLoadMore} loading={loading} disabled={loading}>
            Cargar más
          </CocoaButton>
        </div>
      ) : null}
    </RateGridSidePanel>
  );
}

export default HistoryDrawer;
