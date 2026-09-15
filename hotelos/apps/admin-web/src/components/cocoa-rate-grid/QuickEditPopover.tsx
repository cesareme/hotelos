// QuickEditPopover — fast edit of a multi-cell selection.
//
// Opens when a drag-selection of ≥ 2 cells is released (or Ctrl/Cmd+Enter):
// one price field that accepts expressions ("132", "+10 %", "−5 €",
// "=BAR−10 %" when a BAR plan exists), tri-state restriction chips, "Aplicar
// a N celdas" and "Más opciones…" → bulk edit sheet. The popover returns the
// raw expression + a tri-state restrictions patch; the screen evaluates the
// expression per cell (relative ops depend on each cell's current price).

import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { RateRestrictions, RateRestrictionsPatch } from "@hotelos/shared";
import { CocoaButton } from "../cocoa/CocoaButton";
import { describeExpression, parseExpression } from "./expressions";
import { NumericTriChip, RateGridPopover, TriStateChip } from "./shared-ui";
import type { QuickEditPopoverProps, TriState } from "./types";

type Flags = Record<"cta" | "ctd" | "closed" | "stopSell", TriState>;
type Nums = Record<"minLos" | "minLosThrough" | "maxLos", { state: TriState; value: string }>;

const FLAG_LABELS: Array<{ key: keyof Flags; label: string }> = [
  { key: "cta", label: "Cerrado a llegada" },
  { key: "ctd", label: "Cerrado a salida" },
  { key: "closed", label: "Cerrado" },
  { key: "stopSell", label: "Cierre de venta" }
];

function initialFlags(): Flags {
  return { cta: "unchanged", ctd: "unchanged", closed: "unchanged", stopSell: "unchanged" };
}
function initialNums(r: RateRestrictions | null | undefined): Nums {
  return {
    minLos: { state: "unchanged", value: r?.minLos ? String(r.minLos) : "2" },
    minLosThrough: { state: "unchanged", value: r?.minLosThrough ? String(r.minLosThrough) : "2" },
    maxLos: { state: "unchanged", value: r?.maxLos ? String(r.maxLos) : "7" }
  };
}

export function buildRestrictionsPatch(flags: Flags, nums: Nums): RateRestrictionsPatch {
  const patch: RateRestrictionsPatch = {};
  for (const { key } of FLAG_LABELS) {
    if (flags[key] === "on") patch[key] = true;
    else if (flags[key] === "off") patch[key] = null;
  }
  for (const key of Object.keys(nums) as Array<keyof Nums>) {
    const n = nums[key];
    if (n.state === "on") {
      const v = Number.parseInt(n.value, 10);
      if (Number.isFinite(v) && v > 0) patch[key] = v;
    } else if (n.state === "off") patch[key] = null;
  }
  return patch;
}

export function QuickEditPopover(props: QuickEditPopoverProps) {
  const { open, anchorRect, cellCount, hasBar, initialRestrictions, onApply, onMoreOptions, onClose } = props;
  const [expr, setExpr] = useState("");
  const [flags, setFlags] = useState<Flags>(initialFlags);
  const [nums, setNums] = useState<Nums>(() => initialNums(initialRestrictions));

  useEffect(() => {
    if (!open) return;
    setExpr("");
    setFlags(initialFlags());
    setNums(initialNums(initialRestrictions));
  }, [open, initialRestrictions]);

  const parsed = useMemo(() => (expr.trim() === "" ? null : parseExpression(expr)), [expr]);
  const barError = parsed?.ok && parsed.expression.kind === "bar" && !hasBar ? "No hay un plan BAR en esta propiedad" : null;
  const error = parsed && !parsed.ok ? parsed.error : barError;
  const restrictions = useMemo(() => buildRestrictionsPatch(flags, nums), [flags, nums]);
  const hasChange = (parsed?.ok && !barError) || Object.keys(restrictions).length > 0;

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!hasChange || error) return;
    onApply({ priceExpression: parsed?.ok ? expr.trim() : "", restrictions });
  };

  return (
    <RateGridPopover open={open} anchorRect={anchorRect} onClose={onClose} ariaLabel={`Edición rápida de ${cellCount} celdas`} wide>
      <form onSubmit={submit}>
        <p className="crg-pop__title">
          Edición rápida · {cellCount} {cellCount === 1 ? "celda" : "celdas"}
        </p>
        <label className="crg-field">
          <span className="crg-field__label">Precio</span>
          <input
            className={`crg-input crg-input--big${error ? " crg-input--invalid" : ""}`}
            value={expr}
            placeholder="Escribe 132, +10 % o −5 €"
            inputMode="decimal"
            aria-invalid={Boolean(error) || undefined}
            aria-describedby="crg-quick-hint"
            onChange={(e) => setExpr(e.target.value)}
          />
        </label>
        {error ? (
          <p className="crg-pop__error" role="alert">
            {error}
          </p>
        ) : parsed?.ok ? (
          <p className="crg-pop__hint" id="crg-quick-hint">
            {describeExpression(parsed.expression)}
            {parsed.expression.kind !== "set" ? " sobre el precio actual de cada celda" : ""}
          </p>
        ) : (
          <p className="crg-pop__hint" id="crg-quick-hint">
            Escribe 132, +10 % o −5 €{hasBar ? " · =BAR−10 % para calcularlo a partir del precio BAR" : ""}
          </p>
        )}
        <div className="crg-hr" />
        <span className="crg-field__label">Restricciones (sin cambio · activar · desactivar)</span>
        <div className="crg-pop__row" style={{ marginTop: 6 }}>
          {FLAG_LABELS.map(({ key, label }) => (
            <TriStateChip key={key} label={label} state={flags[key]} onChange={(s) => setFlags((f) => ({ ...f, [key]: s }))} />
          ))}
        </div>
        <div className="crg-pop__row" style={{ marginTop: 6 }}>
          <NumericTriChip label="Estancia mínima" state={nums.minLos.state} value={nums.minLos.value} onChange={(state, value) => setNums((n) => ({ ...n, minLos: { state, value } }))} />
          <NumericTriChip label="Mín. (estancia completa)" state={nums.minLosThrough.state} value={nums.minLosThrough.value} onChange={(state, value) => setNums((n) => ({ ...n, minLosThrough: { state, value } }))} />
          <NumericTriChip label="Estancia máxima" state={nums.maxLos.state} value={nums.maxLos.value} onChange={(state, value) => setNums((n) => ({ ...n, maxLos: { state, value } }))} />
        </div>
        <div className="crg-pop__actions">
          <button type="button" className="crg-pop__link" onClick={onMoreOptions}>
            Más opciones…
          </button>
          <div style={{ display: "flex", gap: 6 }}>
            <CocoaButton variant="plain" size="small" tone="neutral" onClick={onClose}>
              Cancelar
            </CocoaButton>
            <CocoaButton variant="filled" size="small" tone="accent" type="submit" disabled={!hasChange || Boolean(error)}>
              Aplicar a {cellCount} {cellCount === 1 ? "celda" : "celdas"}
            </CocoaButton>
          </div>
        </div>
      </form>
    </RateGridPopover>
  );
}

export default QuickEditPopover;
