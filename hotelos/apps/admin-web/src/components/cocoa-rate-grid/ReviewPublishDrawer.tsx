// ReviewPublishDrawer — review the draft and publish to channels.
//
// Diff grouped by room type › plan › consecutive date range (before → after,
// who), channel toggles with per-channel cell counts ("Booking.com · 270
// celdas", "Airbnb · sin mapping (0)" disabled, "modo de pruebas" labelled)
// and the primary button "Publicar en N canales". While/after publishing it
// shows per-channel progress and results from `publishState` and hides the
// form (a half-empty form under a progress bar read as "Publicar en 0
// canales").
//
// Send mode: with an EMPTY draft and `pendingPush` set (cells saved without
// sending, or a revert) the same drawer offers "Enviar N celdas a M canales"
// → `onPushPending` (POST /rate-grid/push over the saved range).
//
// Units: the copy counts CELLS of the draft; the per-channel «en cola» figure
// right after the publish is DELIVERIES (the API queues one per kind — rates,
// availability — and channel, `queued[channelId]`), and the figures while
// polling / when done are CELLS of the VISIBLE RANGE as sync-status reports
// them (its summary counts cell × channel states, and the route has no
// journalId filter, so earlier publications inside the window are counted
// too — labelled «en el rango visible»). There is no "Programar": the API has
// no `scheduleAt`, so the checkbox was removed rather than shipping a button
// that promised a schedule and pushed at once.
//
// Mode is resolved by `resolveReviewDrawerMode`: once a publish/send is in
// flight the drawer keeps the flow that started it (title, subtitle, callout)
// instead of flipping to «Enviar a canales» because the draft just emptied
// while a pendingPush from an earlier revert still exists
// (browser-ux-final#10).

import { useEffect, useMemo, useRef, useState } from "react";
import { CocoaButton } from "../cocoa/CocoaButton";
import { RESTRICTION_LABELS, channelModeLabel, formatDateRange, formatDateTime, formatMoney, markupLabel, pluralize } from "./helpers";
import { countDraftCellsByChannel, diffDraft, groupDiffByTypeAndPlan, resolveReviewDrawerMode, summarizeDraft } from "./rate-grid-utils";
import { RateGridSidePanel } from "./shared-ui";
import type { ChannelPublishProgress, ReviewPublishDrawerProps } from "./types";

function fieldLabel(field: string): string {
  if (field === "price") return "Precio";
  if (field === "available") return "Disponibles";
  if (field === "source") return "Origen";
  return (RESTRICTION_LABELS as Record<string, string>)[field] ?? field;
}

function valueLabel(field: string, v: unknown, currency: string): string {
  if (v === null || v === undefined) return field === "price" ? "sin tarifa" : "—";
  if (field === "price") return formatMoney(typeof v === "number" ? v : Number(v), currency);
  if (typeof v === "boolean") return v ? "sí" : "no";
  if (field === "source") return v === "manual" ? "manual" : "derivado";
  return String(v);
}

/**
 * Per-channel progress. «queued» counts DELIVERIES the API just queued for the
 * channel; «sending»/«done» count CELLS of the visible range from sync-status
 * (never draft cells, never scoped to this publish — see the header).
 */
export function progressLabel(p: ChannelPublishProgress): string {
  switch (p.status) {
    case "queued":
      return `Pendiente · ${pluralize(p.queued ?? 0, "entrega en cola", "entregas en cola")}`;
    case "sending":
      return p.message ? `Enviando… (${p.message})` : "Enviando…";
    case "done":
      return `${pluralize(p.confirmed ?? 0, "celda confirmada", "celdas confirmadas")}${p.rejected ? ` · ${pluralize(p.rejected, "rechazada", "rechazadas")}` : ""} en el rango visible${p.message ? ` · ${p.message}` : ""}`;
    case "error":
      return p.message ?? "Error";
    default:
      return "Sin enviar";
  }
}

export function ReviewPublishDrawer(props: ReviewPublishDrawerProps) {
  const { open, response, draft, channels, channelMappings, initialChannelIds, publishState, currentUserLabel, onPublish, onSaveDraftOnly, onClose, pendingPush, onPushPending } = props;
  const items = useMemo(() => diffDraft(draft, currentUserLabel ?? null), [draft, currentUserLabel]);
  const groups = useMemo(() => groupDiffByTypeAndPlan(items, response.roomTypes, response.ratePlans), [items, response.roomTypes, response.ratePlans]);
  const summary = useMemo(() => summarizeDraft(draft), [draft]);
  const counts = useMemo(() => countDraftCellsByChannel(draft, { ...response, channels }, channelMappings), [draft, response, channels, channelMappings]);

  const publishing = publishState.phase === "saving" || publishState.phase === "publishing";
  const done = publishState.phase === "done";
  const idle = publishState.phase === "idle";
  // Send mode: nothing in the draft but persisted cells never sent to the channels.
  const dataPushMode = summary.cells === 0 && Boolean(pendingPush && pendingPush.count > 0 && onPushPending);

  const [selected, setSelected] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Remembers which flow launched the in-flight send: once it runs the draft
  // (or the pendingPush) is already flushed and the data alone would flip the
  // drawer to the other mode under the progress bar.
  const startedAsPushRef = useRef(false);
  useEffect(() => {
    if (idle) startedAsPushRef.current = dataPushMode;
  }, [idle, dataPushMode]);
  const pushMode =
    resolveReviewDrawerMode({ idle, draftCells: summary.cells, pendingPushCount: pendingPush?.count ?? 0, canPush: Boolean(onPushPending), startedAsPush: startedAsPushRef.current }) === "push";
  // Form of the flow that is now flushed (empty draft during/after a publish).
  const sendingFlushed = !idle && summary.cells === 0;

  // Defaults are (re)computed only while nothing is in flight: once the
  // bulk-update empties the draft the counts drop to 0 and would otherwise
  // reset the selection to [] under the progress bar.
  useEffect(() => {
    if (!open || !idle) return;
    const defaults =
      initialChannelIds ??
      (pushMode
        ? channels.filter((c) => c.readyToPush && c.mappedProducts > 0 && (!pendingPush?.channelIds?.length || pendingPush.channelIds.includes(c.id))).map((c) => c.id)
        : channels.filter((c) => c.readyToPush && (counts[c.id] ?? 0) > 0).map((c) => c.id));
    setSelected(defaults);
    setCollapsed(new Set());
  }, [open, idle, initialChannelIds, channels, counts, pushMode, pendingPush]);

  const canPublish = summary.cells > 0 && selected.length > 0 && !publishing;
  const canPush = pushMode && selected.length > 0 && !publishing;
  const sandboxSelected = channels.some((c) => selected.includes(c.id) && c.mode !== "real");

  const toggleChannel = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const toggleGroup = (id: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const subtitle = !idle
    ? publishState.cells
      ? pushMode
        ? `Envío de ${pluralize(publishState.cells, "celda guardada", "celdas guardadas")}`
        : `Publicación de ${pluralize(publishState.cells, "celda", "celdas")}`
      : pushMode
        ? "Envío a canales"
        : "Publicación"
    : pushMode && pendingPush
      ? `${pluralize(pendingPush.count, "celda guardada sin enviar", "celdas guardadas sin enviar")} · ${formatDateRange(pendingPush.from, pendingPush.to)}`
      : summary.cells > 0
        ? `${pluralize(summary.cells, "celda", "celdas")} · ${summary.roomTypes} ${summary.roomTypes === 1 ? "tipo" : "tipos"} · ${summary.ratePlans} ${summary.ratePlans === 1 ? "plan" : "planes"}${summary.from && summary.to ? ` · ${formatDateRange(summary.from, summary.to)}` : ""}`
        : "Sin cambios pendientes";

  const channelSelector = (
    <section className="crg-section">
      <h3 className="crg-section__title">Canales</h3>
      {channels.length === 0 ? <p className="crg-note">No hay canales configurados. Puedes guardar sin enviar a canales.</p> : null}
      <ul className="crg-list">
        {channels.map((c) => {
          const n = counts[c.id] ?? 0;
          const unmapped = c.mappedProducts === 0 || (!pushMode && n === 0);
          const disabled = unmapped || !c.readyToPush;
          const detail = c.mappedProducts === 0 ? "sin productos mapeados" : pushMode ? pluralize(c.mappedProducts, "producto mapeado", "productos mapeados") : pluralize(n, "celda", "celdas");
          return (
            <li key={c.id} className="crg-list__item">
              <label className={`crg-check crg-list__row${disabled ? " crg-check--disabled" : ""}`} style={{ width: "100%" }} title={c.readinessSummary ?? undefined}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <input type="checkbox" disabled={disabled} checked={selected.includes(c.id)} onChange={() => toggleChannel(c.id)} />
                  <span>
                    {c.name} · {detail}
                  </span>
                </span>
                <span style={{ display: "inline-flex", gap: 4 }}>
                  {c.mode !== "real" ? <span className="crg-badge crg-badge--warn">{channelModeLabel(c.mode)}</span> : null}
                  {!c.readyToPush && c.mappedProducts > 0 ? <span className="crg-badge crg-badge--danger">no listo</span> : null}
                  {c.markupPercent ? <span className="crg-badge">{markupLabel(c.markupPercent)}</span> : null}
                </span>
              </label>
              {!c.readyToPush && c.readinessSummary ? <p className="crg-note crg-note--warn">{c.readinessSummary}</p> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );

  return (
    <RateGridSidePanel
      open={open}
      title={pushMode ? "Enviar a canales" : "Revisar y publicar"}
      subtitle={subtitle}
      onClose={onClose}
      wide
      footer={
        !idle ? (
          <CocoaButton variant={done || publishState.phase === "error" ? "filled" : "plain"} size="small" tone={done || publishState.phase === "error" ? "accent" : "neutral"} onClick={onClose}>
            {publishing ? "Cerrar (el envío sigue en segundo plano)" : "Cerrar"}
          </CocoaButton>
        ) : pushMode ? (
          <>
            <CocoaButton variant="plain" size="small" tone="neutral" onClick={onClose} disabled={publishing}>
              Cancelar
            </CocoaButton>
            <CocoaButton variant="filled" size="small" tone="accent" loading={publishing} disabled={!canPush} onClick={() => onPushPending?.({ channelIds: selected })}>
              Enviar {pluralize(pendingPush?.count ?? 0, "celda", "celdas")} a {selected.length} {selected.length === 1 ? "canal" : "canales"}
            </CocoaButton>
          </>
        ) : (
          <>
            {onSaveDraftOnly ? (
              <span title="Guarda los cambios en Anfitorio (vigentes en el PMS al momento) sin enviarlos a los canales" style={{ display: "inline-flex" }}>
                <CocoaButton variant="plain" size="small" tone="neutral" onClick={onSaveDraftOnly} disabled={publishing || summary.cells === 0}>
                  Guardar sin enviar a canales
                </CocoaButton>
              </span>
            ) : null}
            <CocoaButton variant="plain" size="small" tone="neutral" onClick={onClose} disabled={publishing}>
              Cancelar
            </CocoaButton>
            <CocoaButton variant="filled" size="small" tone="accent" loading={publishing} disabled={!canPublish} onClick={() => onPublish({ channelIds: selected })}>
              Publicar en {selected.length} {selected.length === 1 ? "canal" : "canales"}
            </CocoaButton>
          </>
        )
      }
    >
      {!idle ? (
        <section className="crg-section" aria-live="polite">
          <h3 className="crg-section__title">
            {publishState.phase === "saving" ? "Guardando…" : publishState.phase === "publishing" ? "Publicando…" : publishState.phase === "done" ? "Publicación enviada" : "No se pudo publicar"}
            {publishState.cells ? <small>{pluralize(publishState.cells, "celda", "celdas")}</small> : null}
          </h3>
          {publishState.error ? <div className="crg-callout crg-callout--danger">{publishState.error}</div> : null}
          {publishState.journalId ? <p className="crg-note">Entrada del historial: {publishState.journalId}</p> : null}
          <ul className="crg-list">
            {publishState.byChannel.map((p) => {
              const ch = channels.find((c) => c.id === p.channelId);
              const total = counts[p.channelId] ?? p.queued ?? 0;
              const doneCount = (p.confirmed ?? 0) + (p.rejected ?? 0);
              const pct = p.status === "done" ? 100 : p.status === "sending" ? Math.min(95, total ? Math.round((doneCount / total) * 100) : 40) : p.status === "queued" ? 10 : 0;
              return (
                <li key={p.channelId} className="crg-list__item">
                  <div className="crg-list__row">
                    <span>
                      {ch?.name ?? p.channelId}
                      {ch && ch.mode !== "real" ? <span className="crg-badge" style={{ marginLeft: 6 }}>{channelModeLabel(ch.mode)}</span> : null}
                    </span>
                    <span className={`crg-badge${p.status === "done" && !p.rejected ? " crg-badge--ok" : p.status === "error" || p.rejected ? " crg-badge--danger" : p.status === "sending" ? " crg-badge--accent" : ""}`}>
                      {p.status === "done" ? "✓ " : p.status === "error" ? "✕ " : p.status === "sending" ? "… " : ""}
                      {progressLabel(p)}
                    </span>
                  </div>
                  <div className="crg-progress" aria-hidden="true">
                    <i style={{ width: `${pct}%`, background: p.status === "error" ? "var(--cocoa-danger)" : p.status === "done" ? "var(--cocoa-success)" : undefined }} />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {idle && pushMode && pendingPush ? (
        <section className="crg-section">
          <div className="crg-callout crg-callout--warn">
            {pendingPush.source === "revert" ? "Cambio revertido en Anfitorio" : "Guardado en Anfitorio"} {formatDateTime(pendingPush.at) ? `el ${formatDateTime(pendingPush.at)}` : ""}:{" "}
            {pluralize(pendingPush.count, "celda", "celdas")} del {formatDateRange(pendingPush.from, pendingPush.to)} ya {pendingPush.count === 1 ? "se vende" : "se venden"} con el valor nuevo en el PMS, pero los canales
            siguen con el valor anterior hasta que las envíes.
          </div>
          <p className="crg-note">Se reenvía el rango completo de los tipos y planes afectados (el envío es idempotente: los canales ya al día no reciben nada nuevo).</p>
        </section>
      ) : null}

      {!pushMode && !(sendingFlushed && items.length === 0) ? (
        <section className="crg-section">
          <h3 className="crg-section__title">
            Cambios <small>{pluralize(items.length, "campo", "campos")}</small>
          </h3>
          {groups.length === 0 ? <p className="crg-note">No hay cambios en el borrador.</p> : null}
          {groups.map((g) => (
            <div key={g.roomTypeId} className="crg-tree__type">
              <button type="button" className="crg-tree__type-head" style={{ all: "unset", cursor: "pointer", display: "flex", width: "100%", justifyContent: "space-between", fontWeight: 600, fontSize: "var(--cocoa-fs-subheadline)", padding: "4px 0" }} aria-expanded={!collapsed.has(g.roomTypeId)} onClick={() => toggleGroup(g.roomTypeId)}>
                <span>
                  {collapsed.has(g.roomTypeId) ? "▸" : "▾"} {g.roomTypeName}
                </span>
                <span className="crg-badge">{pluralize(g.cellCount, "celda", "celdas")}</span>
              </button>
              {collapsed.has(g.roomTypeId)
                ? null
                : g.plans.map((p) => (
                    <div key={p.ratePlanId} className="crg-tree__plan">
                      <div className="crg-tree__plan-head">
                        <span>
                          {p.ratePlanCode}
                          {p.ratePlanName ? ` · ${p.ratePlanName}` : ""}
                        </span>
                        <span>{pluralize(p.cellCount, "celda", "celdas")}</span>
                      </div>
                      {p.ranges.map((r, i) => (
                        <div key={`${r.field}-${r.from}-${i}`} className="crg-tree__range">
                          <span>
                            {formatDateRange(r.from, r.to)}
                            {r.count > 1 ? ` (${r.count})` : ""} · {fieldLabel(r.field)}
                          </span>
                          <span>
                            <span className="crg-before">{valueLabel(r.field, r.before, response.currency)}</span>
                            <span className="crg-arrow">→</span>
                            <span className="crg-after">{valueLabel(r.field, r.after, response.currency)}</span>
                            {r.who ? <span className="crg-note"> · {r.who}</span> : null}
                          </span>
                        </div>
                      ))}
                    </div>
                  ))}
            </div>
          ))}
        </section>
      ) : null}

      {idle ? (
        <>
          {channelSelector}
          {pushMode && selected.length > 0 ? (
            <div className="crg-callout">
              Vas a enviar {pluralize(pendingPush?.count ?? 0, "celda", "celdas")} a {selected.length} {selected.length === 1 ? "canal" : "canales"}.
              {sandboxSelected ? " Algunos canales están en modo de pruebas: nada llega al canal real." : ""}
            </div>
          ) : pushMode ? (
            <div className="crg-callout crg-callout--warn">Sin canales seleccionados: no se enviará nada.</div>
          ) : summary.cells > 0 && selected.length > 0 ? (
            <div className="crg-callout">
              Vas a publicar {pluralize(summary.cells, "celda", "celdas")} en {selected.length} {selected.length === 1 ? "canal" : "canales"}.
              {sandboxSelected ? " Algunos canales están en modo de pruebas: nada llega al canal real." : ""}
            </div>
          ) : summary.cells > 0 ? (
            <div className="crg-callout crg-callout--warn">Sin canales seleccionados: los cambios se guardan en Anfitorio pero no se envían a ningún canal.</div>
          ) : null}
        </>
      ) : null}
    </RateGridSidePanel>
  );
}

export default ReviewPublishDrawer;
