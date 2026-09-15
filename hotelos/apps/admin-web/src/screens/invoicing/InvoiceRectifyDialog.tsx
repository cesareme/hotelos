import { useEffect, useMemo, useState } from "react";
import {
  fetchInvoice,
  rectifyInvoice,
  type InvoiceFull,
  type RectifyingReasonCode
} from "../../services/pmsCommerceApi";
import { money } from "../../lib/format";

const REASON_CODE_LABELS: Record<RectifyingReasonCode, string> = {
  R1: "R1 — Error fundado en derecho (art. 80.1, 80.2 LIVA)",
  R2: "R2 — Concurso de acreedores (art. 80.3 LIVA)",
  R3: "R3 — Créditos incobrables (art. 80.4 LIVA)",
  R4: "R4 — Otras causas",
  R5: "R5 — Rectificativa de facturas simplificadas"
};

type LineEdit = {
  lineId: string;
  description: string;
  origQuantity: number;
  origUnitPrice: number;
  quantity: string;
  unitPrice: string;
};

type Props = {
  initialInvoiceId?: string;
  onClose?: () => void;
  onRectified?: (rectifying: InvoiceFull) => void;
};

export function InvoiceRectifyDialog({ initialInvoiceId, onClose, onRectified }: Props) {
  const [lookup, setLookup] = useState(initialInvoiceId ?? "");
  const [original, setOriginal] = useState<InvoiceFull | null>(null);
  const [lines, setLines] = useState<LineEdit[]>([]);
  const [reasonCode, setReasonCode] = useState<RectifyingReasonCode>("R1");
  const [mode, setMode] = useState<"full" | "adjust">("full");
  const [issuedRectifying, setIssuedRectifying] = useState<InvoiceFull | null>(null);
  const [status, setStatus] = useState<string>("Busca una factura emitida para rectificarla.");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (initialInvoiceId) {
      void handleLookup(initialInvoiceId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialInvoiceId]);

  async function handleLookup(idOrNumber: string) {
    setBusy(true);
    setIssuedRectifying(null);
    setStatus(`Loading invoice ${idOrNumber}…`);
    try {
      // The API supports lookup by id; an invoice-number lookup would require a
      // separate endpoint, so we ask for the id field here.
      const invoice = await fetchInvoice(idOrNumber.trim());
      setOriginal(invoice);
      setLines(
        (invoice.lines ?? []).map((line, index) => ({
          lineId: (line as { id?: string }).id ?? `idx-${index}`,
          description: line.description,
          origQuantity: line.quantity,
          origUnitPrice: line.unitPrice,
          quantity: String(line.quantity),
          unitPrice: String(line.unitPrice)
        }))
      );
      if (invoice.status !== "issued") {
        setStatus(`Invoice ${invoice.invoiceNumber ?? invoice.id} is ${invoice.status}; only issued invoices can be rectified.`);
      } else {
        setStatus(`Loaded ${invoice.invoiceNumber ?? invoice.id}. Pick reason and confirm.`);
      }
    } catch (error) {
      setOriginal(null);
      setLines([]);
      setStatus(error instanceof Error ? error.message : "No se ha encontrado la factura.");
    } finally {
      setBusy(false);
    }
  }

  const deltaPreview = useMemo(() => {
    if (!original) return { total: 0, taxTotal: 0 };
    if (mode === "full") {
      return { total: -original.total, taxTotal: -original.taxTotal };
    }
    let total = 0;
    let taxTotal = 0;
    const origMap = new Map((original.lines ?? []).map((l, i) => [(l as { id?: string }).id ?? `idx-${i}`, l]));
    for (const edit of lines) {
      const orig = origMap.get(edit.lineId);
      if (!orig) continue;
      const newQty = Number(edit.quantity);
      const newPrice = Number(edit.unitPrice);
      if (!Number.isFinite(newQty) || !Number.isFinite(newPrice)) continue;
      const rate = orig.taxRate / 100;
      const origGross = orig.quantity * orig.unitPrice * (1 + rate);
      const newGross = newQty * newPrice * (1 + rate);
      const delta = newGross - origGross;
      total += delta;
      taxTotal += delta - delta / (1 + rate);
    }
    return { total: Math.round(total * 100) / 100, taxTotal: Math.round(taxTotal * 100) / 100 };
  }, [original, lines, mode]);

  async function handleIssue() {
    if (!original) return;
    setBusy(true);
    setStatus("Emitiendo la factura rectificativa…");
    try {
      const payload =
        mode === "full"
          ? { reasonCode, fullReversal: true }
          : {
              reasonCode,
              fullReversal: false,
              lineAdjustments: lines
                .filter((line) => {
                  const q = Number(line.quantity);
                  const p = Number(line.unitPrice);
                  return (
                    Number.isFinite(q) &&
                    Number.isFinite(p) &&
                    (q !== line.origQuantity || p !== line.origUnitPrice)
                  );
                })
                .map((line) => ({
                  lineId: line.lineId,
                  quantity: Number(line.quantity),
                  unitPrice: Number(line.unitPrice)
                }))
            };
      const rectifying = await rectifyInvoice(original.id, payload);
      setIssuedRectifying(rectifying);
      setStatus(
        `Rectifying invoice ${rectifying.invoiceNumber ?? rectifying.id} issued. Total ${rectifying.total} ${rectifying.invoiceType ?? ""}.`
      );
      onRectified?.(rectifying);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "No se ha podido emitir la factura rectificativa.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bo-card">
      <div className="bo-card-head">
        <div>
          <p className="bo-muted">Finanzas y cumplimiento</p>
          <h2>Factura rectificativa</h2>
        </div>
        <span className="bo-chip">RD 1496/2003 · RD 87/2005</span>
      </div>

      <div className="bo-row" style={{ gap: "0.5rem", alignItems: "end" }}>
        <label className="bo-form-field" style={{ flex: 1 }}>
          <span>Factura original (identificador)</span>
          <input
            value={lookup}
            onChange={(event) => setLookup(event.target.value)}
            placeholder="inv_…"
          />
        </label>
        <button type="button" onClick={() => void handleLookup(lookup)} disabled={!lookup.trim() || busy}>
          Buscar
        </button>
        {onClose ? (
          <button type="button" onClick={onClose} disabled={busy}>
            Cerrar
          </button>
        ) : null}
      </div>

      {original ? (
        <article className="bo-card" style={{ marginTop: "1rem" }}>
          <div className="bo-card-head">
            <h3>
              {original.invoiceNumber ?? original.id} · {original.invoiceType} · {original.status}
            </h3>
            <span className="bo-chip">{money(original.total)} · IVA {money(original.taxTotal)}</span>
          </div>

          <div className="bo-grid two">
            <label className="bo-form-field">
              <span>Motivo de la rectificación</span>
              <select
                value={reasonCode}
                onChange={(event) => setReasonCode(event.target.value as RectifyingReasonCode)}
              >
                {Object.entries(REASON_CODE_LABELS).map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="bo-form-field">
              <span>Modo</span>
              <select value={mode} onChange={(event) => setMode(event.target.value as "full" | "adjust")}>
                <option value="full">Anulación completa (niega todas las líneas)</option>
                <option value="adjust">Ajustar líneas (solo la diferencia)</option>
              </select>
            </label>
          </div>

          <h4>Líneas</h4>
          {lines.length === 0 ? (
            <p className="bo-muted">La factura original no tiene líneas.</p>
          ) : (
            lines.map((line, index) => (
              <div className="bo-row" key={line.lineId} style={{ gap: "0.5rem", alignItems: "end" }}>
                <span style={{ flex: 2 }}>{line.description}</span>
                <label className="bo-form-field" style={{ flex: 1 }}>
                  <span>Cantidad</span>
                  <input
                    type="number"
                    step="any"
                    value={line.quantity}
                    disabled={mode === "full"}
                    onChange={(event) =>
                      setLines((current) => {
                        const next = [...current];
                        next[index] = { ...next[index], quantity: event.target.value };
                        return next;
                      })
                    }
                  />
                </label>
                <label className="bo-form-field" style={{ flex: 1 }}>
                  <span>Precio unitario</span>
                  <input
                    type="number"
                    step="any"
                    value={line.unitPrice}
                    disabled={mode === "full"}
                    onChange={(event) =>
                      setLines((current) => {
                        const next = [...current];
                        next[index] = { ...next[index], unitPrice: event.target.value };
                        return next;
                      })
                    }
                  />
                </label>
                <span className="bo-muted" style={{ minWidth: "5rem", textAlign: "right" }}>
                  orig: {line.origQuantity} × {line.origUnitPrice}
                </span>
              </div>
            ))
          )}

          <div className="bo-row" style={{ marginTop: "0.5rem" }}>
            <span className="bo-muted">Vista previa de la diferencia</span>
            <strong>
              Total {money(deltaPreview.total)} · IVA {money(deltaPreview.taxTotal)}
            </strong>
          </div>

          <div className="bo-actions">
            <button
              type="button"
              className="primary"
              onClick={() => void handleIssue()}
              disabled={busy || original.status !== "issued"}
            >
              Emitir factura rectificativa
            </button>
          </div>
        </article>
      ) : null}

      {issuedRectifying ? (
        <article className="bo-card" style={{ marginTop: "1rem", borderColor: "var(--bo-ok)" }}>
          <div className="bo-card-head">
            <h3>Factura rectificativa emitida</h3>
            <span className="bo-chip">{issuedRectifying.invoiceType}</span>
          </div>
          <p>
            <strong>{issuedRectifying.invoiceNumber ?? issuedRectifying.id}</strong> · total {money(issuedRectifying.total)} · IVA{" "}
            {money(issuedRectifying.taxTotal)}
          </p>
          <p>
            Huella VeriFactu: <code>{issuedRectifying.verifactuHash ?? "—"}</code>
          </p>
          {issuedRectifying.qrPayload ? (
            <a className="bo-link" href={issuedRectifying.qrPayload} target="_blank" rel="noreferrer noopener">
              Ver la URL de validación del QR VeriFactu
            </a>
          ) : null}
        </article>
      ) : null}

      <p className="bo-muted">{status}</p>
    </section>
  );
}

export default InvoiceRectifyDialog;
