// JournalStaleDialog — «La parrilla cambió después de este asiento».
//
// Shown when POST …/rate-journal/:id/revert answers 409 JOURNAL_STALE: a
// later edit changed some cell the entry had written, so a plain revert
// would silently undo that later edit. The dialog lists the cells (what the
// entry expected vs what the grid holds now) and offers «Forzar reversión»,
// which re-sends the revert with `{ force: true }` (RateJournalRevertRequest).
// Cancelling leaves everything as it is. The safe action (Cancelar) keeps the
// initial focus: ConfirmDialog does that for variant "danger".

import { useMemo } from "react";
import { ConfirmDialog } from "../ConfirmDialog";
import { formatDateShort, journalFieldLabel, journalValueLabel, pluralize } from "./helpers";
import type { JournalStaleDialogProps } from "./types";

const MAX_ROWS = 12;

export function JournalStaleDialog(props: JournalStaleDialogProps) {
  const { open, cells, message, roomTypes, ratePlans, channels, reverting = false, onForce, onCancel } = props;
  const rtName = useMemo(() => new Map(roomTypes.map((r) => [r.id, r.name])), [roomTypes]);
  const planCode = useMemo(() => new Map(ratePlans.map((p) => [p.id, p.code])), [ratePlans]);
  const channelName = useMemo(() => new Map((channels ?? []).map((c) => [c.id, c.name])), [channels]);

  return (
    <ConfirmDialog
      open={open}
      title="La parrilla cambió después de este asiento"
      description={
        message ||
        "Alguien editó estas celdas después de este cambio. Revertirlo pisaría esas ediciones posteriores: revierte primero los asientos más recientes o fuerza la reversión."
      }
      confirmLabel={reverting ? "Revirtiendo…" : "Forzar reversión"}
      cancelLabel="Cancelar"
      variant="danger"
      onConfirm={onForce}
      onCancel={onCancel}
    >
      <ul className="crg-list" aria-label={`${pluralize(cells.length, "celda cambiada", "celdas cambiadas")} después del asiento`} style={{ margin: 0, paddingLeft: 0, listStyle: "none", maxHeight: 220, overflow: "auto", fontSize: 13 }}>
        {cells.slice(0, MAX_ROWS).map((c, i) => (
          <li key={`${c.ratePlanId}|${c.roomTypeId}|${c.date}|${c.channelId ?? ""}|${i}`} className="crg-list__item" style={{ padding: "4px 0" }}>
            <strong>
              {rtName.get(c.roomTypeId) ?? c.roomTypeId} · {planCode.get(c.ratePlanId) ?? c.ratePlanId} · {formatDateShort(c.date)}
              {c.channelId ? ` · ${channelName.get(c.channelId) ?? c.channelId}` : ""}
            </strong>
            <div className="crg-note">
              {c.fields
                .map((f) => `${journalFieldLabel(f.field)}: el asiento dejó ${journalValueLabel(f.field, f.expected)}, ahora hay ${journalValueLabel(f.field, f.actual)}`)
                .join(" · ")}
            </div>
          </li>
        ))}
        {cells.length > MAX_ROWS ? <li className="crg-note">… y {cells.length - MAX_ROWS} más</li> : null}
      </ul>
      <p className="crg-note" style={{ margin: "8px 0 0" }}>
        «Forzar reversión» restaura los valores del asiento en todas sus celdas y sobrescribe esas ediciones posteriores (quedan registradas en el historial como parte de la reversión).
      </p>
    </ConfirmDialog>
  );
}

export default JournalStaleDialog;
