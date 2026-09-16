// Factura rectificativa — drawer Cocoa 22 (Finanzas · lote 6-A; opened by
// InvoiceRectificationsScreen and BillingCenterScreen).
//
// POST /invoices/:id/rectify (RectifyInvoiceSchema, strict):
//   · «I» por diferencias con anulación completa → { rectificationType: "I", fullReversal: true }
//   · «I» por diferencias ajustando líneas → { rectificationType: "I", lineAdjustments: [{ lineId, quantity?, unitPrice? }] }
//   · «S» por sustitución → { rectificationType: "S", substituteLines: [{ description, quantity, unitPrice, taxCategory? }] }
// always with the AEAT reason code R1–R5. Only issued invoices can be
// rectified; the original is loaded with GET /invoices/:id (its `snapshot`
// freezes the lines the rectificativa refers to). Issuing is a high-risk
// action: a CocoaDialog confirms before the request. The answer (the new
// invoice, its VeriFactu hash and QR) is shown with «Descargar PDF»
// (GET /invoices/:id/pdf as a Blob).

import { useEffect, useMemo, useState } from "react";
import { fetchInvoice, getInvoicePdf, rectifyInvoice, type InvoiceDraft, type InvoiceFull, type RectifyInvoicePayload, type RectifyingReasonCode } from "../../services/pmsCommerceApi";
import { financeErrorMessage } from "../../services/finance-contracts";
import { TAX_CATEGORY_OPTIONS, type TaxCategory } from "../../services/taxesApi";
import { useToast } from "../../components/Toast";
import { saveBlob } from "../../components/billing/download";
import { amountToInput, parseAmount } from "../../components/billing/payment-flow";
import { money, plural } from "../../lib/format";
import { ACTIONS } from "../../content/actions";
import { customerTypeLabel, invoiceTypeLabel } from "../billing/invoiceStatus";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDialog,
  CocoaDrawer,
  CocoaField,
  CocoaFormRow,
  CocoaFormSection,
  CocoaInput,
  CocoaSelect,
  CocoaStat,
  CocoaState
} from "../../components/cocoa";

export const RECTIFYING_REASON_LABELS: Record<RectifyingReasonCode, string> = {
  R1: "R1 · Error fundado en derecho (art. 80.1 y 80.2 LIVA)",
  R2: "R2 · Concurso de acreedores (art. 80.3 LIVA)",
  R3: "R3 · Créditos incobrables (art. 80.4 LIVA)",
  R4: "R4 · Otras causas",
  R5: "R5 · Rectificativa de facturas simplificadas"
};

const REASON_OPTIONS = (Object.keys(RECTIFYING_REASON_LABELS) as RectifyingReasonCode[]).map((code) => ({ value: code, label: RECTIFYING_REASON_LABELS[code] }));

type Mode = "full" | "adjust" | "substitute";

const MODE_OPTIONS: Array<{ value: Mode; label: string }> = [
  { value: "full", label: "Anulación completa por diferencias (I)" },
  { value: "adjust", label: "Ajuste de líneas por diferencias (I)" },
  { value: "substitute", label: "Sustitución de la factura (S)" }
];

type LineEdit = { lineId: string | null; description: string; taxRate: number; origQuantity: number; origUnitPrice: number; quantity: string; unitPrice: string };
type SubstituteEdit = { key: string; description: string; quantity: string; unitPrice: string; taxCategory: TaxCategory };

function newSubstitute(seed?: Partial<SubstituteEdit>): SubstituteEdit {
  return { key: `sub-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, description: "", quantity: "1", unitPrice: "", taxCategory: "general_services", ...seed };
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Gross delta (total, tax) of the adjusted lines against the original ones. Pure. */
export function adjustmentDelta(lines: readonly LineEdit[]): { total: number; taxTotal: number; changed: number } {
  let total = 0;
  let taxTotal = 0;
  let changed = 0;
  for (const edit of lines) {
    const quantity = parseAmount(edit.quantity);
    const unitPrice = parseAmount(edit.unitPrice);
    if (quantity === null || unitPrice === null) continue;
    if (quantity === edit.origQuantity && unitPrice === edit.origUnitPrice) continue;
    changed += 1;
    const rate = edit.taxRate / 100;
    const delta = quantity * unitPrice - edit.origQuantity * edit.origUnitPrice;
    total += delta;
    taxTotal += rate > 0 ? delta - delta / (1 + rate) : 0;
  }
  return { total: round2(total), taxTotal: round2(taxTotal), changed };
}

export type InvoiceRectifyDialogProps = {
  open: boolean;
  onClose: () => void;
  /** Invoices offered as the original (the caller passes the issued, non-rectifying ones). */
  candidates: readonly InvoiceDraft[];
  /** Original preselected (a row action «Rectificar»). */
  initialInvoiceId?: string;
  onRectified?: (rectifying: InvoiceFull) => void;
};

export function InvoiceRectifyDialog({ open, onClose, candidates, initialInvoiceId, onRectified }: InvoiceRectifyDialogProps) {
  const { showToast } = useToast();
  const [selectedId, setSelectedId] = useState("");
  const [manualId, setManualId] = useState("");
  const [original, setOriginal] = useState<InvoiceFull | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reasonCode, setReasonCode] = useState<RectifyingReasonCode>("R1");
  const [mode, setMode] = useState<Mode>("full");
  const [lines, setLines] = useState<LineEdit[]>([]);
  const [substitutes, setSubstitutes] = useState<SubstituteEdit[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [issued, setIssued] = useState<InvoiceFull | null>(null);
  const [downloading, setDownloading] = useState(false);

  const candidateOptions = useMemo(
    () => candidates.map((invoice) => ({ value: invoice.id, label: `${invoice.invoiceNumber ?? invoice.id} · ${money(invoice.total, invoice.currencyCode)}${invoice.customerName ? ` · ${invoice.customerName}` : ""}` })),
    [candidates]
  );

  async function loadOriginal(id: string) {
    const trimmed = id.trim();
    if (!trimmed) return;
    setLoading(true);
    setLoadError(null);
    setIssued(null);
    setIssueError(null);
    try {
      const invoice = await fetchInvoice(trimmed);
      setOriginal(invoice);
      const sourceLines = invoice.snapshot?.lines ?? invoice.lines ?? [];
      setLines(
        sourceLines.map((line, index) => {
          const lineId = "id" in line && typeof (line as { id?: unknown }).id === "string" ? (line as { id: string }).id : "folioLineId" in line ? ((line as { folioLineId?: string | null }).folioLineId ?? null) : null;
          return {
            lineId: lineId ?? (invoice.lines?.[index] as { id?: string } | undefined)?.id ?? null,
            description: line.description,
            taxRate: line.taxRate,
            origQuantity: line.quantity,
            origUnitPrice: line.unitPrice,
            quantity: amountToInput(line.quantity),
            unitPrice: amountToInput(line.unitPrice)
          };
        })
      );
      setSubstitutes(
        sourceLines.length > 0
          ? sourceLines.map((line) => newSubstitute({ description: line.description, quantity: amountToInput(line.quantity), unitPrice: amountToInput(line.unitPrice), taxCategory: ((line as { taxCategory?: string | null }).taxCategory as TaxCategory | null) ?? "general_services" }))
          : [newSubstitute()]
      );
    } catch (err) {
      setOriginal(null);
      setLines([]);
      setLoadError(financeErrorMessage(err, "No se ha encontrado la factura."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    setReasonCode("R1");
    setMode("full");
    setIssued(null);
    setIssueError(null);
    setConfirmOpen(false);
    setManualId("");
    const preset = initialInvoiceId ?? "";
    setSelectedId(preset);
    if (preset) void loadOriginal(preset);
    else {
      setOriginal(null);
      setLines([]);
      setLoadError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialInvoiceId]);

  const canRectify = original !== null && original.status === "issued";
  const linesAdjustable = lines.length > 0 && lines.every((line) => line.lineId !== null);
  const delta = useMemo(() => adjustmentDelta(lines), [lines]);
  const substituteTotal = useMemo(
    () => round2(substitutes.reduce((sum, line) => sum + (parseAmount(line.quantity) ?? 0) * (parseAmount(line.unitPrice) ?? 0), 0)),
    [substitutes]
  );
  const substitutesValid = substitutes.length > 0 && substitutes.every((line) => line.description.trim() && (parseAmount(line.quantity) ?? 0) > 0 && parseAmount(line.unitPrice) !== null);

  const validation: string | null = !canRectify
    ? original
      ? "Solo se rectifica una factura emitida."
      : null
    : mode === "adjust" && !linesAdjustable
      ? "Esta factura no conserva el identificador de sus líneas: usa la anulación completa o la sustitución."
      : mode === "adjust" && delta.changed === 0
        ? "Modifica la cantidad o el precio de al menos una línea."
        : mode === "substitute" && !substitutesValid
          ? "Completa la descripción, la cantidad y el precio de cada línea sustitutiva."
          : null;

  function buildPayload(): RectifyInvoicePayload {
    if (mode === "full") return { reasonCode, rectificationType: "I", fullReversal: true };
    if (mode === "adjust") {
      return {
        reasonCode,
        rectificationType: "I",
        fullReversal: false,
        lineAdjustments: lines
          .filter((line) => line.lineId !== null)
          .filter((line) => {
            const quantity = parseAmount(line.quantity);
            const unitPrice = parseAmount(line.unitPrice);
            return quantity !== null && unitPrice !== null && (quantity !== line.origQuantity || unitPrice !== line.origUnitPrice);
          })
          .map((line) => ({ lineId: line.lineId as string, quantity: parseAmount(line.quantity) ?? undefined, unitPrice: parseAmount(line.unitPrice) ?? undefined }))
      };
    }
    return {
      reasonCode,
      rectificationType: "S",
      substituteLines: substitutes.map((line) => ({ description: line.description.trim(), quantity: parseAmount(line.quantity) ?? 1, unitPrice: parseAmount(line.unitPrice) ?? 0, taxCategory: line.taxCategory }))
    };
  }

  async function issue() {
    if (!original || validation) return;
    setBusy(true);
    setIssueError(null);
    try {
      const rectifying = await rectifyInvoice(original.id, buildPayload());
      setIssued(rectifying);
      setConfirmOpen(false);
      showToast(`Rectificativa ${rectifying.invoiceNumber ?? rectifying.id} emitida.`, { variant: "success" });
      onRectified?.(rectifying);
    } catch (err) {
      setConfirmOpen(false);
      setIssueError(financeErrorMessage(err, "No se ha podido emitir la factura rectificativa."));
    } finally {
      setBusy(false);
    }
  }

  async function download(invoice: InvoiceFull) {
    setDownloading(true);
    try {
      const pdf = await getInvoicePdf(invoice.id, { download: true });
      saveBlob(pdf.blob, pdf.filename);
    } catch (err) {
      showToast(financeErrorMessage(err, "No se pudo descargar el PDF."), { variant: "error" });
    } finally {
      setDownloading(false);
    }
  }

  const previewLabel =
    mode === "full" && original
      ? `Total ${money(-original.total, original.currencyCode)} · impuestos ${money(-original.taxTotal, original.currencyCode)}`
      : mode === "adjust"
        ? `Diferencia: total ${money(delta.total, original?.currencyCode)} · impuestos ${money(delta.taxTotal, original?.currencyCode)} · ${plural(delta.changed, "línea modificada", "líneas modificadas")}`
        : `Nuevo total ${money(substituteTotal, original?.currencyCode)} frente a ${money(original?.total, original?.currencyCode)} de la original`;

  return (
    <CocoaDrawer
      open={open}
      onClose={onClose}
      title="Factura rectificativa"
      subtitle="Motivo AEAT R1–R5, por diferencias (I) o por sustitución (S). La original nunca se edita."
      side="right"
      size="lg"
      focusKey={original?.id ?? ""}
      footer={
        issued ? (
          <>
            <CocoaButton variant="bordered" tone="neutral" loading={downloading} onClick={() => void download(issued)}>
              Descargar PDF
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" onClick={onClose}>
              {ACTIONS.close}
            </CocoaButton>
          </>
        ) : (
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={onClose} disabled={busy}>
              {ACTIONS.cancel}
            </CocoaButton>
            <CocoaButton variant="filled" tone="destructive" disabled={busy || !canRectify || validation !== null} onClick={() => setConfirmOpen(true)}>
              Emitir rectificativa
            </CocoaButton>
          </>
        )
      }
    >
      <div className="cocoa-stack" data-gap="4">
        {issued ? (
          <>
            <CocoaCallout tone="success" title={`Rectificativa ${issued.invoiceNumber ?? issued.id} emitida`} role="status">
              {invoiceTypeLabel(issued.invoiceType)} · total {money(issued.total, issued.currencyCode)} · impuestos {money(issued.taxTotal, issued.currencyCode)}.
            </CocoaCallout>
            <CocoaFormSection title="Huella VeriFactu" description="La rectificativa entra en la cadena con su propia huella; la original queda marcada como rectificada.">
              <p className="cocoa-sr-only">Huella</p>
              <CocoaStat label="Huella" value={issued.verifactuHash ?? "—"} tabular={false} />
              {issued.qrPayload ? (
                <div className="cocoa-row" data-gap="2">
                  <CocoaButton variant="plain" size="small" onClick={() => window.open(issued.qrPayload, "_blank", "noopener,noreferrer")}>
                    Ver la URL de validación del QR
                  </CocoaButton>
                </div>
              ) : null}
            </CocoaFormSection>
          </>
        ) : (
          <>
            <CocoaFormSection title="Factura original" description="Elige una factura emitida o indica su identificador.">
              <CocoaFormRow columns={2}>
                <CocoaField label="Factura emitida">
                  <CocoaSelect
                    value={selectedId}
                    onChange={(value) => {
                      setSelectedId(value);
                      setManualId("");
                      if (value) void loadOriginal(value);
                    }}
                    options={candidateOptions}
                    placeholder={candidateOptions.length === 0 ? "Sin facturas emitidas" : "Elige una factura"}
                    disabled={loading || candidateOptions.length === 0}
                  />
                </CocoaField>
                <CocoaField label="Identificador" hint="opcional">
                  <CocoaInput value={manualId} onChange={setManualId} placeholder="cmu1j8csw00awfywhk2t9wyw2" autoComplete="off" disabled={loading} onKeyDown={(event) => { if (event.key === "Enter") void loadOriginal(manualId); }} />
                </CocoaField>
              </CocoaFormRow>
              <div className="cocoa-row" data-gap="2" data-justify="end">
                <CocoaButton variant="bordered" tone="neutral" size="small" loading={loading} disabled={!manualId.trim()} onClick={() => void loadOriginal(manualId)}>
                  Cargar
                </CocoaButton>
              </div>
              {loadError ? <CocoaState kind="error" inline title={loadError} /> : null}
            </CocoaFormSection>

            {original ? (
              <>
                <CocoaFormSection title={`${original.invoiceNumber ?? original.id}`} description={`${invoiceTypeLabel(original.invoiceType)} · ${customerTypeLabel(original.customerType)}${original.customerName ? ` · ${original.customerName}` : ""}`}>
                  <div className="cocoa-row" data-gap="4" data-align="start">
                    <CocoaStat label="Total" value={money(original.total, original.currencyCode)} />
                    <CocoaStat label="Impuestos" value={money(original.taxTotal, original.currencyCode)} />
                    <CocoaBadge tone={original.status === "issued" ? "info" : "danger"}>{original.status === "issued" ? "Emitida" : original.status === "cancelled" ? "Anulada" : original.status === "rectified" ? "Ya rectificada" : "Borrador"}</CocoaBadge>
                    {original.snapshot ? <CocoaBadge tone="success">Líneas congeladas al emitir</CocoaBadge> : null}
                  </div>
                  {!canRectify ? (
                    <CocoaCallout tone="danger" title="Solo se rectifica una factura emitida">
                      {original.status === "rectified" ? "Esta factura ya fue sustituida por una rectificativa." : original.status === "cancelled" ? "Una factura anulada no se rectifica." : "Emite la factura antes de rectificarla."}
                    </CocoaCallout>
                  ) : null}
                </CocoaFormSection>

                {canRectify ? (
                  <>
                    <CocoaFormSection title="Motivo y modalidad">
                      <CocoaFormRow columns={2}>
                        <CocoaField label="Motivo AEAT" required>
                          <CocoaSelect value={reasonCode} onChange={(value) => setReasonCode(value as RectifyingReasonCode)} options={REASON_OPTIONS} disabled={busy} />
                        </CocoaField>
                        <CocoaField label="Modalidad" required help={mode === "substitute" ? "La rectificativa recoge las líneas correctas completas; la diferencia con la original se calcula en los libros." : "Por diferencias: la rectificativa solo recoge la variación."}>
                          <CocoaSelect value={mode} onChange={(value) => setMode(value as Mode)} options={MODE_OPTIONS} disabled={busy} />
                        </CocoaField>
                      </CocoaFormRow>
                    </CocoaFormSection>

                    {mode === "adjust" ? (
                      <CocoaFormSection title="Líneas" description="Cambia la cantidad o el precio unitario (bruto, con impuestos) de las líneas erróneas; las demás quedan igual.">
                        {lines.length === 0 ? (
                          <CocoaState kind="empty" inline title="La factura original no tiene líneas." />
                        ) : (
                          <div className="cocoa-stack" data-gap="3">
                            {lines.map((line, index) => (
                              <CocoaFormRow key={line.lineId ?? `idx-${index}`} columns={3} min={160}>
                                <CocoaStat label={line.description} value={`${line.origQuantity} × ${money(line.origUnitPrice, original.currencyCode)}`} hint={line.lineId ? `Impuesto ${line.taxRate} %` : "Línea sin identificador: no se puede ajustar"} tabular={false} />
                                <CocoaField label="Cantidad">
                                  <CocoaInput value={line.quantity} onChange={(value) => setLines((current) => current.map((row, i) => (i === index ? { ...row, quantity: value } : row)))} inputMode="decimal" disabled={busy || line.lineId === null} />
                                </CocoaField>
                                <CocoaField label="Precio unitario">
                                  <CocoaInput value={line.unitPrice} onChange={(value) => setLines((current) => current.map((row, i) => (i === index ? { ...row, unitPrice: value } : row)))} inputMode="decimal" disabled={busy || line.lineId === null} />
                                </CocoaField>
                              </CocoaFormRow>
                            ))}
                          </div>
                        )}
                      </CocoaFormSection>
                    ) : null}

                    {mode === "substitute" ? (
                      <CocoaFormSection
                        title="Líneas sustitutivas"
                        description="Las líneas correctas completas; el tipo de impuesto sale de la categoría fiscal de la propiedad."
                        actions={
                          <CocoaButton variant="plain" size="small" disabled={busy} onClick={() => setSubstitutes((current) => [...current, newSubstitute()])}>
                            Añadir línea
                          </CocoaButton>
                        }
                      >
                        <div className="cocoa-stack" data-gap="3">
                          {substitutes.map((line, index) => (
                            <CocoaFormRow key={line.key} columns={4} min={140}>
                              <CocoaField label="Concepto" required>
                                <CocoaInput value={line.description} onChange={(value) => setSubstitutes((current) => current.map((row, i) => (i === index ? { ...row, description: value } : row)))} placeholder="Alojamiento 2 noches" maxLength={500} disabled={busy} />
                              </CocoaField>
                              <CocoaField label="Cantidad" required>
                                <CocoaInput value={line.quantity} onChange={(value) => setSubstitutes((current) => current.map((row, i) => (i === index ? { ...row, quantity: value } : row)))} inputMode="decimal" disabled={busy} />
                              </CocoaField>
                              <CocoaField label="Precio unitario" required>
                                <CocoaInput value={line.unitPrice} onChange={(value) => setSubstitutes((current) => current.map((row, i) => (i === index ? { ...row, unitPrice: value } : row)))} inputMode="decimal" disabled={busy} />
                              </CocoaField>
                              <CocoaField label="Categoría fiscal" hint={substitutes.length > 1 ? <CocoaButton variant="plain" tone="destructive" size="small" disabled={busy} onClick={() => setSubstitutes((current) => current.filter((_, i) => i !== index))}>{ACTIONS.remove}</CocoaButton> : undefined}>
                                <CocoaSelect value={line.taxCategory} onChange={(value) => setSubstitutes((current) => current.map((row, i) => (i === index ? { ...row, taxCategory: value as TaxCategory } : row)))} options={TAX_CATEGORY_OPTIONS.map((option) => ({ value: option.value, label: option.label }))} disabled={busy} />
                              </CocoaField>
                            </CocoaFormRow>
                          ))}
                        </div>
                      </CocoaFormSection>
                    ) : null}

                    <CocoaCallout tone={validation ? "warning" : "info"} title="Vista previa">
                      {validation ?? previewLabel}
                    </CocoaCallout>
                    {issueError ? (
                      <CocoaCallout tone="danger" title={issueError} role="alert">
                        {null}
                      </CocoaCallout>
                    ) : null}
                  </>
                ) : null}
              </>
            ) : null}
          </>
        )}
      </div>

      {original ? (
        <CocoaDialog
          open={confirmOpen}
          onClose={() => setConfirmOpen(false)}
          tone="destructive"
          title={`¿Emitir la rectificativa de ${original.invoiceNumber ?? original.id}?`}
          description={`${RECTIFYING_REASON_LABELS[reasonCode]}. ${previewLabel}. La rectificativa entra en la cadena VeriFactu y no se puede deshacer.`}
          confirmLabel={busy ? "Emitiendo…" : "Emitir rectificativa"}
          cancelLabel={ACTIONS.cancel}
          busy={busy}
          onConfirm={issue}
        />
      ) : null}
    </CocoaDrawer>
  );
}

export default InvoiceRectifyDialog;
