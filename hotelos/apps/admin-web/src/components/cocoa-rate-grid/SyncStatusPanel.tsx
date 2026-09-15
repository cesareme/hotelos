// SyncStatusPanel — cell × channel delivery matrix.
//
// Legend (status is icon + text, never colour alone), "Solo errores" filter,
// per-channel summary, a matrix grouped by room type › plan with one dot per
// (date, channel), and an incident detail with "Reintentar" (callback with
// the channel + keys) and "Ver en historial".

import { useMemo, useState } from "react";
import type { CellSyncStatus } from "@hotelos/shared";
import { CocoaButton } from "../cocoa/CocoaButton";
import { SYNC_STATUS_META, channelModeLabel, describeSync, formatDateRange, formatDateShort, parseCellKey, pluralize } from "./helpers";
import { RateGridSidePanel } from "./shared-ui";
import type { SyncMatrixCell, SyncStatusPanelProps } from "./types";

const ERROR_STATUSES: CellSyncStatus[] = ["rejected", "timeout"];
// «stale» = the channel still sells a previous value (revert not sent): it
// needs the hotelier's action, so it sits next to the incidents in the legend.
const LEGEND: CellSyncStatus[] = ["never", "queued", "sending", "confirmed", "stale", "rejected", "timeout"];

export function SyncStatusPanel(props: SyncStatusPanelProps) {
  const { open, channels, cells, roomTypes, ratePlans, summary, onRetry, onShowInHistory, onClose, loading = false, pendingPush, onSendPending, degraded = false } = props;
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [detail, setDetail] = useState<{ cell: SyncMatrixCell; channelId: string } | null>(null);

  const rtName = useMemo(() => new Map(roomTypes.map((r) => [r.id, r.name])), [roomTypes]);
  const planCode = useMemo(() => new Map(ratePlans.map((p) => [p.id, p.code])), [ratePlans]);
  const channelName = useMemo(() => new Map(channels.map((c) => [c.id, c.name])), [channels]);

  const filtered = useMemo(() => {
    if (!onlyErrors) return cells;
    return cells.filter((c) => Object.values(c.byChannel).some((s) => ERROR_STATUSES.includes(s.status)));
  }, [cells, onlyErrors]);

  const groups = useMemo(() => {
    const map = new Map<string, { roomTypeId: string; ratePlanId: string; cells: SyncMatrixCell[] }>();
    for (const c of filtered) {
      const k = `${c.roomTypeId}|${c.ratePlanId}`;
      const g = map.get(k) ?? { roomTypeId: c.roomTypeId, ratePlanId: c.ratePlanId, cells: [] };
      g.cells.push(c);
      map.set(k, g);
    }
    for (const g of map.values()) g.cells.sort((a, b) => a.date.localeCompare(b.date));
    return [...map.values()];
  }, [filtered]);

  const errorCells = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const c of cells) for (const [chId, s] of Object.entries(c.byChannel)) if (ERROR_STATUSES.includes(s.status)) (out[chId] ??= []).push(c.key);
    return out;
  }, [cells]);
  const totalErrors = Object.values(errorCells).reduce((n, l) => n + l.length, 0);

  return (
    <RateGridSidePanel open={open} title="Estado de sincronización" subtitle={loading ? "Actualizando…" : degraded ? "Estado de sincronización no disponible" : `${pluralize(cells.length, "celda", "celdas")} · ${pluralize(channels.length, "canal", "canales")}${totalErrors ? ` · ${pluralize(totalErrors, "incidencia", "incidencias")}` : ""}`} onClose={onClose} wide>
      {degraded ? (
        <div className="crg-callout crg-callout--warn" role="alert" style={{ marginBottom: 10 }}>
          <strong>Estado de sincronización no disponible</strong>
          <p className="crg-note" style={{ marginTop: 4 }}>
            El servidor no pudo leer el estado de las entregas por celda (respuesta degradada). Las celdas NO están «sin enviar»: simplemente no se sabe. Pulsa «Recargar» en el editor o consulta el log de entregas del Channel Manager.
          </p>
        </div>
      ) : null}
      <div className="crg-legend" role="list" aria-label="Leyenda">
        {LEGEND.map((s) => (
          <span key={s} role="listitem">
            <span className={`crg-dot crg-dot--${SYNC_STATUS_META[s].tone}`} aria-hidden="true" />
            {SYNC_STATUS_META[s].icon} {SYNC_STATUS_META[s].label}
          </span>
        ))}
      </div>

      {pendingPush && pendingPush.count > 0 ? (
        <div className="crg-callout crg-callout--warn" style={{ marginBottom: 10 }}>
          <div className="crg-list__row">
            <span>
              {pluralize(pendingPush.count, "celda guardada sin enviar", "celdas guardadas sin enviar")} · {formatDateRange(pendingPush.from, pendingPush.to)}
              {pendingPush.source === "revert" ? " · tras revertir un cambio" : ""}
            </span>
            {onSendPending ? (
              <CocoaButton variant="filled" size="small" tone="accent" onClick={onSendPending} disabled={loading}>
                Enviar pendientes
              </CocoaButton>
            ) : null}
          </div>
          <p className="crg-note" style={{ marginTop: 4 }}>El PMS ya vende los valores nuevos; los canales conservan los anteriores hasta el envío.</p>
        </div>
      ) : null}

      <div className="crg-pop__row" style={{ marginBottom: 10 }}>
        <label className="crg-check">
          <input type="checkbox" checked={onlyErrors} onChange={(e) => setOnlyErrors(e.target.checked)} />
          Solo errores
        </label>
        {totalErrors ? (
          <CocoaButton
            variant="bordered"
            size="small"
            tone="accent"
            onClick={() => {
              for (const [chId, keys] of Object.entries(errorCells)) onRetry({ channelId: chId, keys });
            }}
          >
            Reintentar todas las incidencias ({totalErrors})
          </CocoaButton>
        ) : null}
      </div>

      {summary ? (
        <section className="crg-section">
          <h3 className="crg-section__title">Resumen por canal</h3>
          <ul className="crg-list">
            {channels.map((c) => {
              const s: Partial<Record<string, number>> = summary[c.id] ?? {};
              const parts = LEGEND.filter((k) => s[k]).map((k) => `${SYNC_STATUS_META[k].icon} ${s[k]} ${SYNC_STATUS_META[k].label.toLowerCase()}`);
              return (
                <li key={c.id} className="crg-list__item crg-list__row">
                  <span>
                    {c.name}
                    {c.mode !== "real" ? <span className="crg-badge crg-badge--warn" style={{ marginLeft: 6 }}>{channelModeLabel(c.mode)}</span> : null}
                  </span>
                  <span className="crg-note">{parts.length ? parts.join(" · ") : "sin envíos"}</span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {detail ? (
        <section className="crg-section">
          <div className={`crg-callout${ERROR_STATUSES.includes(detail.cell.byChannel[detail.channelId]?.status) ? " crg-callout--danger" : ""}`}>
            <strong>
              {rtName.get(detail.cell.roomTypeId) ?? detail.cell.roomTypeId} · {planCode.get(detail.cell.ratePlanId) ?? detail.cell.ratePlanId} · {formatDateShort(detail.cell.date)}
            </strong>
            <p style={{ margin: "4px 0" }}>{describeSync(channelName.get(detail.channelId) ?? detail.channelId, detail.cell.byChannel[detail.channelId])}</p>
            {detail.cell.byChannel[detail.channelId]?.deliveryId ? <p className="crg-note">Entrega {detail.cell.byChannel[detail.channelId]?.deliveryId}</p> : null}
            <div className="crg-pop__row" style={{ marginTop: 6 }}>
              <CocoaButton variant="filled" size="small" tone="accent" onClick={() => onRetry({ channelId: detail.channelId, keys: [detail.cell.key] })} disabled={loading}>
                Reintentar
              </CocoaButton>
              <CocoaButton variant="plain" size="small" tone="neutral" onClick={() => onShowInHistory(detail.cell.byChannel[detail.channelId]?.deliveryId ?? null, detail.cell.key)}>
                Ver en historial
              </CocoaButton>
              <CocoaButton variant="plain" size="small" tone="neutral" onClick={() => setDetail(null)}>
                Cerrar detalle
              </CocoaButton>
            </div>
          </div>
        </section>
      ) : null}

      <section className="crg-section">
        {groups.length === 0 ? <p className="crg-note">{onlyErrors ? "Sin incidencias en el rango." : "Sin envíos registrados en el rango."}</p> : null}
        {groups.map((g) => (
          <div key={`${g.roomTypeId}|${g.ratePlanId}`} className="crg-tree__type">
            <div className="crg-tree__type-head">
              <span>
                {rtName.get(g.roomTypeId) ?? g.roomTypeId} · {planCode.get(g.ratePlanId) ?? g.ratePlanId}
              </span>
              <span className="crg-badge">{pluralize(g.cells.length, "día", "días")}</span>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table className="crg-table">
                <thead>
                  <tr>
                    <th>Fecha</th>
                    {channels.map((c) => (
                      <th key={c.id}>{c.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {g.cells.map((cell) => (
                    <tr key={cell.key}>
                      <td>{formatDateShort(cell.date)}</td>
                      {channels.map((c) => {
                        const s = cell.byChannel[c.id];
                        const meta = SYNC_STATUS_META[s?.status ?? "never"];
                        const isSel = detail?.cell.key === cell.key && detail.channelId === c.id;
                        return (
                          <td key={c.id}>
                            <button type="button" className={`crg-sync-matrix__cell${isSel ? " crg-sync-matrix__cell--selected" : ""}`} title={describeSync(c.name, s)} aria-label={`${formatDateShort(cell.date)}, ${c.name}: ${meta.label}`} onClick={() => setDetail({ cell, channelId: c.id })}>
                              <span className={`crg-dot crg-dot--${meta.tone}`} aria-hidden="true" />
                              <span>{meta.icon}</span>
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </section>
    </RateGridSidePanel>
  );
}

/** Helper for the screen: turn RateGridSyncStatusResponse cells into matrix cells with keys. */
export function toSyncMatrixCells(cells: Array<{ ratePlanId: string; roomTypeId: string; date: string; byChannel: SyncMatrixCell["byChannel"] }>): SyncMatrixCell[] {
  return cells.map((c) => ({ key: `${c.ratePlanId}|${c.roomTypeId}|${c.date}`, ratePlanId: c.ratePlanId, roomTypeId: c.roomTypeId, date: c.date, byChannel: c.byChannel }));
}

export function keyToLabel(key: string, roomTypes: Map<string, string>, plans: Map<string, string>): string {
  const k = parseCellKey(key);
  return `${roomTypes.get(k.roomTypeId) ?? k.roomTypeId} · ${plans.get(k.ratePlanId) ?? k.ratePlanId} · ${formatDateShort(k.date)}`;
}

export default SyncStatusPanel;
