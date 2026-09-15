// BulkEditSheet — 420 px side sheet for bulk edits (independent of the selection).
//
// Ámbito (several date ranges, weekdays, room types, rate plans — derived
// plans warn that they are recalculated —, channels) › tabs Precio (Valor
// fijo · Subir/bajar % · Subir/bajar € · Copiar de otra fecha · Suelo ·
// Techo) / Restricciones (tri-state per contract key, incl. min stay through
// and advance days) / Disponibilidad › Motivo obligatorio (preset + text) ›
// Vista previa del impacto (counts, headline, 5-row sample, conflicts with
// "¿Sobrescribir?") › "Aplicar al borrador".
//
// Output: one `RateGridBulkOp` per date range (contract) plus the client
// preview patches so the draft can show the change before the backend
// expands it for real on save.

import { useEffect, useMemo, useState } from "react";
import type { RateGridBulkOp, RateGridPriceOp, RateRestrictionsPatch } from "@hotelos/shared";
import { CocoaButton } from "../cocoa/CocoaButton";
import { RESTRICTION_LABELS, eachDay, formatDateRange, formatDateShort, formatMoney, isIsoDate, pluralize } from "./helpers";
import { buildBulkPreview, expandBulkOp, isDerivedPlan, sortRatePlans, sortRoomTypes, type ExpandBulkOpResult } from "./rate-grid-utils";
import { Field, NumericTriChip, RateGridSidePanel, Tabs, TriStateChip, WeekdayPicker } from "./shared-ui";
import type { BulkEditSheetProps, DateRange, TriState } from "./types";

type PriceMode = "none" | "set" | "percent" | "amount" | "copyFrom" | "floor" | "ceiling";
type Tab = "price" | "restrictions" | "availability";
type FlagKey = "cta" | "ctd" | "closed" | "stopSell";
type NumKey = "minLos" | "minLosThrough" | "maxLos" | "minAdvanceDays" | "maxAdvanceDays";

const PRICE_MODES: Array<{ value: PriceMode; label: string }> = [
  { value: "set", label: "Valor fijo" },
  { value: "percent", label: "Subir/bajar %" },
  { value: "amount", label: "Subir/bajar €" },
  { value: "copyFrom", label: "Copiar de otra fecha" },
  { value: "floor", label: "Precio mínimo (suelo)" },
  { value: "ceiling", label: "Precio máximo (techo)" }
];

const DEFAULT_REASONS = ["Evento", "Compset", "Pickup lento", "Pickup fuerte", "Corrección", "Estrategia comercial", "Otro"];

function parseNum(v: string): number | null {
  if (v.trim() === "") return null;
  const n = Number(v.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

export function BulkEditSheet(props: BulkEditSheetProps) {
  const { open, response, draft, prefill, defaultRange, reasonPresets, onApply, onClose } = props;
  const roomTypes = useMemo(() => sortRoomTypes(response.roomTypes), [response.roomTypes]);
  const ratePlans = useMemo(() => sortRatePlans(response.ratePlans), [response.ratePlans]);
  const presets = reasonPresets && reasonPresets.length ? reasonPresets : DEFAULT_REASONS;

  const [ranges, setRanges] = useState<DateRange[]>([defaultRange]);
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [roomTypeIds, setRoomTypeIds] = useState<string[]>([]);
  const [ratePlanIds, setRatePlanIds] = useState<string[]>([]);
  const [channelIds, setChannelIds] = useState<string[]>([]);
  const [tab, setTab] = useState<Tab>("price");
  const [priceMode, setPriceMode] = useState<PriceMode>("none");
  const [priceValue, setPriceValue] = useState("");
  const [copyFromDate, setCopyFromDate] = useState(defaultRange.from);
  const [flags, setFlags] = useState<Record<FlagKey, TriState>>({ cta: "unchanged", ctd: "unchanged", closed: "unchanged", stopSell: "unchanged" });
  const [nums, setNums] = useState<Record<NumKey, { state: TriState; value: string }>>({
    minLos: { state: "unchanged", value: "2" },
    minLosThrough: { state: "unchanged", value: "2" },
    maxLos: { state: "unchanged", value: "7" },
    minAdvanceDays: { state: "unchanged", value: "1" },
    maxAdvanceDays: { state: "unchanged", value: "365" }
  });
  const [availability, setAvailability] = useState("");
  const [reasonPreset, setReasonPreset] = useState(presets[0]);
  const [reasonText, setReasonText] = useState("");
  const [overwriteManual, setOverwriteManual] = useState(false);

  // Reset from prefill each time the sheet opens. Deps are primitives on
  // purpose: the screen passes `defaultRange={{ from, to }}` (a new object per
  // render), and keying on its identity wiped the form (tab, value, scope)
  // on every parent re-render — autosave tick, toast, polling — while the
  // user was still filling it in.
  const defaultFrom = defaultRange.from;
  const defaultTo = defaultRange.to;
  useEffect(() => {
    if (!open) return;
    const defaultRange = { from: defaultFrom, to: defaultTo };
    setRanges(prefill?.ranges && prefill.ranges.length ? prefill.ranges : [defaultRange]);
    setWeekdays(prefill?.weekdays ?? []);
    setRoomTypeIds(prefill?.roomTypeIds ?? []);
    setRatePlanIds(prefill?.ratePlanIds ?? []);
    setChannelIds(prefill?.channelIds ?? []);
    setTab("price");
    setPriceMode("none");
    setPriceValue("");
    setCopyFromDate(defaultRange.from);
    setFlags({ cta: "unchanged", ctd: "unchanged", closed: "unchanged", stopSell: "unchanged" });
    setNums({
      minLos: { state: "unchanged", value: "2" },
      minLosThrough: { state: "unchanged", value: "2" },
      maxLos: { state: "unchanged", value: "7" },
      minAdvanceDays: { state: "unchanged", value: "1" },
      maxAdvanceDays: { state: "unchanged", value: "365" }
    });
    setAvailability("");
    setReasonPreset(presets[0]);
    setReasonText("");
    setOverwriteManual(false);
  }, [open, prefill, defaultFrom, defaultTo, presets]);

  /* ---------- derived op ---------- */

  const priceOp = useMemo<RateGridPriceOp | undefined>(() => {
    if (priceMode === "none") return undefined;
    if (priceMode === "copyFrom") return isIsoDate(copyFromDate) ? { mode: "copyFrom", fromDate: copyFromDate } : undefined;
    const v = parseNum(priceValue);
    if (v === null) return undefined;
    if ((priceMode === "set" || priceMode === "floor" || priceMode === "ceiling") && v < 0) return undefined;
    return { mode: priceMode, value: v };
  }, [priceMode, priceValue, copyFromDate]);

  const restrictions = useMemo<RateRestrictionsPatch | undefined>(() => {
    const p: RateRestrictionsPatch = {};
    for (const k of Object.keys(flags) as FlagKey[]) {
      if (flags[k] === "on") p[k] = true;
      else if (flags[k] === "off") p[k] = null;
    }
    for (const k of Object.keys(nums) as NumKey[]) {
      const n = nums[k];
      if (n.state === "on") {
        const v = Number.parseInt(n.value, 10);
        if (Number.isFinite(v) && v >= 0) p[k] = v;
      } else if (n.state === "off") p[k] = null;
    }
    return Object.keys(p).length ? p : undefined;
  }, [flags, nums]);

  const availableValue = useMemo(() => {
    const n = Number.parseInt(availability, 10);
    return Number.isFinite(n) && n >= 0 && availability.trim() !== "" ? n : undefined;
  }, [availability]);

  const validRanges = ranges.filter((r) => isIsoDate(r.from) && isIsoDate(r.to) && r.from <= r.to);
  // The API has no per-channel price (a channel price is base × markup) and
  // answers 400 when an op carries scope.channelIds together with `price`:
  // with channels selected only restrictions (and availability) apply.
  const channelPriceBlocked = channelIds.length > 0 && priceOp !== undefined;
  const effectivePriceOp = channelIds.length > 0 ? undefined : priceOp;
  const ops = useMemo<RateGridBulkOp[]>(
    () =>
      validRanges.map((r) => ({
        scope: {
          from: r.from,
          to: r.to,
          weekdays: weekdays.length ? weekdays : undefined,
          roomTypeIds: roomTypeIds.length ? roomTypeIds : undefined,
          ratePlanIds: ratePlanIds.length ? ratePlanIds : undefined,
          channelIds: channelIds.length ? channelIds : undefined
        },
        price: effectivePriceOp,
        restrictions,
        available: availableValue,
        respectManualOverrides: !overwriteManual
      })),
    [validRanges, weekdays, roomTypeIds, ratePlanIds, channelIds, effectivePriceOp, restrictions, availableValue, overwriteManual]
  );
  const hasOperation = Boolean(effectivePriceOp || restrictions || availableValue !== undefined);

  const expanded = useMemo<ExpandBulkOpResult | null>(() => {
    if (!hasOperation || ops.length === 0) return null;
    const merged: ExpandBulkOpResult = { patches: [], conflicts: [], affectedRoomTypes: new Set(), affectedPlans: new Set(), affectedDays: new Set(), derivedRecalculated: 0 };
    const seen = new Set<string>();
    for (const op of ops) {
      const r = expandBulkOp(op, response, draft, overwriteManual);
      for (const p of r.patches) {
        const k = `${p.patch.ratePlanId}|${p.patch.roomTypeId}|${p.patch.date}`;
        if (seen.has(k)) continue;
        seen.add(k);
        merged.patches.push(p);
      }
      for (const c of r.conflicts) if (!merged.conflicts.includes(c)) merged.conflicts.push(c);
      r.affectedRoomTypes.forEach((x) => merged.affectedRoomTypes.add(x));
      r.affectedPlans.forEach((x) => merged.affectedPlans.add(x));
      r.affectedDays.forEach((x) => merged.affectedDays.add(x));
      merged.derivedRecalculated += r.derivedRecalculated;
    }
    return merged;
  }, [hasOperation, ops, response, draft, overwriteManual]);
  const preview = useMemo(() => (expanded ? buildBulkPreview(expanded, response, 5) : null), [expanded, response]);

  const reason = reasonPreset === "Otro" ? reasonText.trim() : reasonText.trim() ? `${reasonPreset} · ${reasonText.trim()}` : reasonPreset;
  const canApply = hasOperation && validRanges.length > 0 && reason.trim() !== "" && (expanded?.patches.length ?? 0) > 0;
  const derivedInScope = ratePlans.filter((p) => isDerivedPlan(p) && (ratePlanIds.length === 0 || ratePlanIds.includes(p.parentRatePlanId ?? "") || ratePlanIds.includes(p.id)));
  const totalDays = validRanges.reduce((n, r) => n + eachDay(r.from, r.to).length, 0);
  // The preview (and therefore the draft) can only price cells the grid has
  // loaded: days outside `response.from..to` are invisible here. Say so
  // instead of "ninguna celda cambia", which reads as "the op is a no-op".
  const daysOutsideWindow = validRanges.reduce((n, r) => n + eachDay(r.from, r.to).filter((d) => d < response.from || d > response.to).length, 0);

  const toggle = (list: string[], id: string, set: (v: string[]) => void) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const apply = () => {
    if (!canApply || !expanded) return;
    onApply({
      ops,
      reason,
      patches: expanded.patches.map((p) => ({ patch: p.patch, before: p.before })),
      overwriteManual
    });
  };

  return (
    <RateGridSidePanel
      open={open}
      title="Edición masiva"
      subtitle={`${validRanges.map((r) => formatDateRange(r.from, r.to)).join(", ") || "sin fechas"} · ${totalDays} ${totalDays === 1 ? "día" : "días"}`}
      onClose={onClose}
      footer={
        <>
          <CocoaButton variant="plain" size="small" tone="neutral" onClick={onClose}>
            Cancelar
          </CocoaButton>
          <CocoaButton variant="filled" size="small" tone="accent" onClick={apply} disabled={!canApply}>
            Aplicar al borrador
          </CocoaButton>
        </>
      }
    >
      {/* ---------- Ámbito ---------- */}
      <section className="crg-section" aria-labelledby="crg-bulk-scope">
        <h3 id="crg-bulk-scope" className="crg-section__title">
          Ámbito
        </h3>
        <span className="crg-field__label">Fechas</span>
        {ranges.map((r, i) => (
          <div key={i} className="crg-pop__row" style={{ margin: "4px 0" }}>
            <input className="crg-input" style={{ width: 140 }} type="date" value={r.from} aria-label={`Desde, rango ${i + 1}`} onChange={(e) => setRanges((rs) => rs.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))} />
            <span className="crg-arrow">→</span>
            <input className="crg-input" style={{ width: 140 }} type="date" value={r.to} min={r.from} aria-label={`Hasta, rango ${i + 1}`} onChange={(e) => setRanges((rs) => rs.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))} />
            {ranges.length > 1 ? (
              <button type="button" className="crg-sheet__close" aria-label={`Quitar rango ${i + 1}`} onClick={() => setRanges((rs) => rs.filter((_, j) => j !== i))}>
                ✕
              </button>
            ) : null}
          </div>
        ))}
        <button type="button" className="crg-pop__link" onClick={() => setRanges((rs) => [...rs, { ...rs[rs.length - 1] }])}>
          + Añadir otro rango
        </button>
        <div style={{ marginTop: 10 }}>
          <span className="crg-field__label">Días de la semana</span>
          <div style={{ marginTop: 4 }}>
            <WeekdayPicker value={weekdays} onChange={setWeekdays} />
          </div>
          <p className="crg-note">{weekdays.length === 0 ? "Todos los días" : `Solo ${weekdays.length} ${weekdays.length === 1 ? "día" : "días"} por semana`}</p>
        </div>
        <div style={{ marginTop: 10 }}>
          <span className="crg-field__label">Tipos de habitación</span>
          <div className="crg-pop__row" style={{ marginTop: 4 }}>
            {roomTypes.map((rt) => (
              <label key={rt.id} className="crg-check">
                <input type="checkbox" checked={roomTypeIds.length === 0 || roomTypeIds.includes(rt.id)} onChange={() => (roomTypeIds.length === 0 ? setRoomTypeIds(roomTypes.filter((x) => x.id !== rt.id).map((x) => x.id)) : toggle(roomTypeIds, rt.id, setRoomTypeIds))} />
                {rt.name}
              </label>
            ))}
          </div>
          <p className="crg-note">{roomTypeIds.length === 0 ? "Todos los tipos" : `${roomTypeIds.length} de ${roomTypes.length}`}</p>
        </div>
        <div style={{ marginTop: 10 }}>
          <span className="crg-field__label">Planes de tarifa</span>
          <div className="crg-pop__row" style={{ marginTop: 4 }}>
            {ratePlans.map((p) => {
              const derived = isDerivedPlan(p);
              return (
                <label key={p.id} className={`crg-check${derived ? " crg-check--disabled" : ""}`} title={derived ? "Derivado: se recalcula desde su plan padre" : p.name}>
                  <input type="checkbox" disabled={derived} checked={!derived && (ratePlanIds.length === 0 || ratePlanIds.includes(p.id))} onChange={() => (ratePlanIds.length === 0 ? setRatePlanIds(ratePlans.filter((x) => !isDerivedPlan(x) && x.id !== p.id).map((x) => x.id)) : toggle(ratePlanIds, p.id, setRatePlanIds))} />
                  {p.code}
                  {derived ? " 🔒" : ""}
                </label>
              );
            })}
          </div>
          {derivedInScope.length ? <p className="crg-note crg-note--warn">Los derivados ({derivedInScope.map((p) => p.code).join(", ")}) se recalculan desde su plan padre.</p> : null}
        </div>
        {response.channels.length ? (
          <div style={{ marginTop: 10 }}>
            <span className="crg-field__label">Canales</span>
            <div className="crg-pop__row" style={{ marginTop: 4 }}>
              {response.channels.map((c) => (
                <label key={c.id} className={`crg-check${c.mappedProducts === 0 ? " crg-check--disabled" : ""}`} title={c.mappedProducts === 0 ? "Sin mapping" : c.name}>
                  <input type="checkbox" disabled={c.mappedProducts === 0} checked={channelIds.includes(c.id)} onChange={() => toggle(channelIds, c.id, setChannelIds)} />
                  {c.name}
                </label>
              ))}
            </div>
            <p className="crg-note">{channelIds.length === 0 ? "Precio base (sin override por canal)" : "Restricciones solo para los canales marcados"}</p>
            {channelIds.length > 0 ? (
              <p className={`crg-note${channelPriceBlocked ? " crg-note--warn" : ""}`}>
                Con canales marcados no se cambian precios: los precios por canal se calculan con el recargo del canal (
                {response.channels
                  .filter((c) => channelIds.includes(c.id))
                  .map((c) => `${c.name} ${c.markupPercent >= 0 ? "+" : ""}${c.markupPercent} %`)
                  .join(", ")}
                ). Quita los canales para editar el precio base.
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* ---------- Operación ---------- */}
      <section className="crg-section">
        <Tabs
          value={tab}
          onChange={setTab}
          ariaLabel="Tipo de cambio"
          options={[
            { value: "price", label: "Precio" },
            { value: "restrictions", label: "Restricciones" },
            { value: "availability", label: "Disponibilidad" }
          ]}
        />
        {tab === "price" ? (
          <div>
            {channelIds.length > 0 ? (
              <p className="crg-note crg-note--warn" role="status">
                Precio no disponible con canales marcados: se calcula con el recargo del canal. Quita los canales del ámbito para cambiar el precio base.
              </p>
            ) : null}
            <div className="crg-pop__row">
              {PRICE_MODES.map((m) => (
                <button key={m.value} type="button" className={`crg-tri${priceMode === m.value ? " crg-tri--on" : ""}`} aria-pressed={priceMode === m.value} onClick={() => setPriceMode((cur) => (cur === m.value ? "none" : m.value))}>
                  {m.label}
                </button>
              ))}
            </div>
            {priceMode === "copyFrom" ? (
              <Field label="Copiar de otra fecha" hint="Cada celda toma el precio de ese día para su mismo tipo y plan.">
                <input className="crg-input" type="date" value={copyFromDate} onChange={(e) => setCopyFromDate(e.target.value)} />
              </Field>
            ) : priceMode !== "none" ? (
              <Field
                label={priceMode === "set" ? "Valor fijo" : priceMode === "percent" ? "Subir/bajar %" : priceMode === "amount" ? "Subir/bajar €" : priceMode === "floor" ? "Precio mínimo (suelo)" : "Precio máximo (techo)"}
                hint={priceMode === "percent" ? "Positivo sube, negativo baja (p. ej. −10)" : priceMode === "amount" ? "Positivo sube, negativo baja (p. ej. −5)" : priceMode === "floor" ? "Las celdas por debajo suben hasta este precio" : priceMode === "ceiling" ? "Las celdas por encima bajan hasta este precio" : undefined}
              >
                <input className="crg-input crg-input--big" inputMode="decimal" value={priceValue} placeholder={priceMode === "percent" ? "10" : "132"} onChange={(e) => setPriceValue(e.target.value)} />
              </Field>
            ) : (
              <p className="crg-note" style={{ marginTop: 6 }}>
                Elige cómo cambiar el precio o pasa a Restricciones / Disponibilidad.
              </p>
            )}
          </div>
        ) : tab === "restrictions" ? (
          <div>
            <span className="crg-field__label">Sin cambio · activar · desactivar</span>
            <div className="crg-pop__row" style={{ marginTop: 6 }}>
              {(["cta", "ctd", "closed", "stopSell"] as FlagKey[]).map((k) => (
                <TriStateChip key={k} label={RESTRICTION_LABELS[k]} state={flags[k]} onChange={(s) => setFlags((f) => ({ ...f, [k]: s }))} />
              ))}
            </div>
            <div className="crg-pop__row" style={{ marginTop: 6 }}>
              {(["minLos", "minLosThrough", "maxLos"] as NumKey[]).map((k) => (
                <NumericTriChip key={k} label={RESTRICTION_LABELS[k]} state={nums[k].state} value={nums[k].value} onChange={(state, value) => setNums((n) => ({ ...n, [k]: { state, value } }))} />
              ))}
            </div>
            <div className="crg-pop__row" style={{ marginTop: 6 }}>
              {(["minAdvanceDays", "maxAdvanceDays"] as NumKey[]).map((k) => (
                <NumericTriChip key={k} label={RESTRICTION_LABELS[k]} state={nums[k].state} value={nums[k].value} onChange={(state, value) => setNums((n) => ({ ...n, [k]: { state, value } }))} />
              ))}
            </div>
            <p className="crg-note">«Cerrado» bloquea el plan esa noche; «Cierre de venta» retira el tipo de habitación de la venta.</p>
          </div>
        ) : (
          <Field label="Disponibles (habitaciones a la venta)" hint="Se aplica a los tipos del ámbito en todas las fechas seleccionadas.">
            <input className="crg-input crg-input--big" type="number" min={0} value={availability} placeholder="p. ej. 5" onChange={(e) => setAvailability(e.target.value)} />
          </Field>
        )}
      </section>

      {/* ---------- Motivo ---------- */}
      <section className="crg-section">
        <h3 className="crg-section__title">
          Motivo del cambio <small>obligatorio</small>
        </h3>
        <div className="crg-pop__row">
          <select className="crg-input" style={{ width: 200 }} value={reasonPreset} aria-label="Motivo" onChange={(e) => setReasonPreset(e.target.value)}>
            {presets.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <input className="crg-input" style={{ flex: 1, minWidth: 140 }} value={reasonText} placeholder={reasonPreset === "Otro" ? "Describe el motivo" : "Detalle (opcional)"} aria-label="Detalle del motivo" onChange={(e) => setReasonText(e.target.value)} />
        </div>
        {reasonPreset === "Otro" && reasonText.trim() === "" ? <p className="crg-note crg-note--warn">Escribe el motivo para poder aplicar.</p> : null}
      </section>

      {/* ---------- Vista previa ---------- */}
      <section className="crg-section" aria-live="polite">
        <h3 className="crg-section__title">Vista previa del impacto</h3>
        {!hasOperation ? (
          <p className="crg-note">Define un cambio para ver el impacto.</p>
        ) : !preview || preview.affectedCells === 0 ? (
          <>
            <p className="crg-note">
              {daysOutsideWindow >= totalDays && totalDays > 0
                ? "Ninguna celda del ámbito está cargada en el grid."
                : "Ninguna celda cambia con este ámbito (mismos valores o sin tarifa)."}
            </p>
            {daysOutsideWindow > 0 ? (
              <p className="crg-note crg-note--warn">
                {pluralize(daysOutsideWindow, "día del ámbito está", "días del ámbito están")} fuera del rango cargado ({formatDateRange(response.from, response.to)}): amplía el rango del grid para previsualizarlos y añadirlos al borrador.
              </p>
            ) : null}
          </>
        ) : (
          <>
            <div className="crg-callout">
              Afecta a {pluralize(preview.affectedCells, "celda", "celdas")} · {preview.roomTypes} {preview.roomTypes === 1 ? "tipo" : "tipos"} × {preview.days} {preview.days === 1 ? "día" : "días"}
              {preview.headline ? ` · ${preview.headline}` : ""}
              {preview.derivedRecalculated ? ` · ${preview.derivedRecalculated} derivados recalculados` : ""}
            </div>
            {daysOutsideWindow > 0 ? (
              <p className="crg-note crg-note--warn">
                {pluralize(daysOutsideWindow, "día del ámbito queda", "días del ámbito quedan")} fuera del rango cargado ({formatDateRange(response.from, response.to)}) y no entran en el borrador: amplía el rango del grid para incluirlos.
              </p>
            ) : null}
            <table className="crg-table">
              <thead>
                <tr>
                  <th>Tipo</th>
                  <th>Plan</th>
                  <th>Fecha</th>
                  <th className="num">Antes</th>
                  <th className="num">Después</th>
                </tr>
              </thead>
              <tbody>
                {preview.sample.map((r) => (
                  <tr key={r.key} className={r.conflict ? "conflict" : undefined}>
                    <td>{r.roomTypeName}</td>
                    <td>
                      {r.ratePlanCode}
                      {r.derived ? " 🔒" : ""}
                    </td>
                    <td>{formatDateShort(r.date)}</td>
                    <td className="num crg-before">{formatMoney(r.beforePrice, response.currency)}</td>
                    <td className="num crg-after">
                      {formatMoney(r.afterPrice, response.currency)}
                      {r.restrictionsSummary ? <span className="crg-note"> · {r.restrictionsSummary}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {preview.conflicts.length ? (
              <div className="crg-callout crg-callout--warn" style={{ marginTop: 10 }}>
                {pluralize(preview.conflicts.length, "celda derivada tiene", "celdas derivadas tienen")} un override manual y no se tocarán.{" "}
                <label className="crg-check" style={{ marginLeft: 6 }}>
                  <input type="checkbox" checked={overwriteManual} onChange={(e) => setOverwriteManual(e.target.checked)} />
                  ¿Sobrescribir?
                </label>
              </div>
            ) : null}
          </>
        )}
      </section>
    </RateGridSidePanel>
  );
}

export default BulkEditSheet;
