// «Imprimir etiqueta» — el diálogo de la pantalla de captura (Tanda T9 · lote
// T9-10, diseño docs/design/DOCUMENTOS-DIGITALIZACION.md §6.4 «El papel:
// registro y valija» y §10 «Captura»). Una etiqueta por documento con el nº de
// registro en grande, el centro, la fecha, el tipo y el aviso legal de la copia
// digital; se imprime con `window.print()` sobre un documento propio (una
// ventana emergente con el HTML de `labelSheetHtml`), sin PDF ni pdf-writer:
// el mismo patrón que las fichas de registro de Mi día
// (operations/FrontDeskDashboard.tsx · registrationCardsHtml). Si el navegador
// bloquea la ventana, el diálogo lo dice y ofrece reintentar.
//
// Este fichero es el ÚNICO del lote que no llega a services/api-client.ts
// (import.meta.env), así que node --test puede importarlo: por eso aloja
// también los helpers PUROS de la pantalla de captura (los KPI de la tira y los
// rangos de «Dividir»), probados en __tests__/documents-screen-contract.test.mts.
// Su casa natural es documents-helpers.ts (lote T9-04): moverlos allí cuando el
// integrador cierre la tanda.

import { useEffect, useState } from "react";
import type { IncomingDocumentRecord } from "@hotelos/shared";
import { CocoaCallout, CocoaDialog } from "../../components/cocoa";
import { ACTIONS } from "../../content/actions";
import { date, isoDate, plural } from "../../lib/format";
import { DOCUMENT_KIND_LABELS, formatRegistry } from "./documents-helpers";

/** Texto legal de la ficha, la etiqueta y la hoja de remesa (§6.4). */
export const DIGITAL_COPY_NOTICE = "Copia digital no certificada (Orden EHA/962/2007 art. 7): conserva el original 6 años (art. 30 del Código de Comercio).";

// ---------------------------------------------------------------------------
// Helpers puros de la pantalla de captura
// ---------------------------------------------------------------------------

export type CaptureKpiRow = Pick<IncomingDocumentRecord, "status" | "physicalStatus" | "capturedAt">;

/** La tira de la pantalla (§10): capturados hoy · pendientes de enviar · en valija · devueltos. */
export type CaptureKpis = {
  /** `capturedAt` cae en el día `today` (calendario de Madrid, lib/format · isoDate). */
  capturedToday: number;
  /** Estado `captured`: digitalizados y aún no enviados a la oficina. */
  pendingToSend: number;
  /** Papel `in_transit`: dentro de una valija cerrada que la oficina no ha recibido. */
  inTransit: number;
  /** Estado `returned_to_centre`: la oficina los devolvió (ilegible, faltan páginas…). */
  returned: number;
};

/** Cuenta los cuatro indicadores sobre la bandeja del centro; `today` como AAAA-MM-DD. */
export function captureKpis(rows: readonly CaptureKpiRow[], today: string): CaptureKpis {
  const kpis: CaptureKpis = { capturedToday: 0, pendingToSend: 0, inTransit: 0, returned: 0 };
  for (const row of rows) {
    if (isoDate(row.capturedAt) === today) kpis.capturedToday += 1;
    if (row.status === "captured") kpis.pendingToSend += 1;
    if (row.physicalStatus === "in_transit") kpis.inTransit += 1;
    if (row.status === "returned_to_centre") kpis.returned += 1;
  }
  return kpis;
}

export type PageRangesResult = {
  /** Rangos 1-based e inclusivos, en el orden escrito (`DocumentSplitRequest.ranges`). */
  ranges: Array<[number, number]>;
  /** Frase en español del primer problema; null cuando los rangos valen. */
  error: string | null;
};

/**
 * «1-2, 3-4» · «1, 2-3» · «1-3;4» → rangos de `POST …/split`: enteros ≥ 1 dentro
 * de `pageCount`, sin solapes ni orden invertido, al menos dos trozos o un
 * trozo que no sea el documento entero.
 */
export function parsePageRanges(text: string, pageCount: number): PageRangesResult {
  const pieces = text
    .split(/[,;]/)
    .map((piece) => piece.trim())
    .filter(Boolean);
  if (pieces.length === 0) return { ranges: [], error: "Indica al menos un rango de páginas (ej.: 1-2, 3-4)." };
  const ranges: Array<[number, number]> = [];
  for (const piece of pieces) {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(piece);
    if (!match) return { ranges: [], error: `«${piece}» no es un rango válido: usa números o «desde-hasta».` };
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    if (from < 1 || to < 1) return { ranges: [], error: "Las páginas empiezan en 1." };
    if (to < from) return { ranges: [], error: `El rango «${piece}» está invertido.` };
    if (to > pageCount) return { ranges: [], error: `El documento tiene ${plural(pageCount, "página", "páginas")}: «${piece}» se sale.` };
    for (const [a, b] of ranges) {
      if (from <= b && to >= a) return { ranges: [], error: `El rango «${piece}» se solapa con otro.` };
    }
    ranges.push([from, to]);
  }
  if (ranges.length === 1 && ranges[0][0] === 1 && ranges[0][1] === pageCount) return { ranges: [], error: "Ese rango es el documento entero: indica al menos dos trozos." };
  return { ranges, error: null };
}

export function escapeHtml(value: string | number | null | undefined): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

export type LabelRecord = Pick<IncomingDocumentRecord, "registryNumber" | "kind" | "capturedAt" | "pageCount">;

/** Documento imprimible: una etiqueta por registro (nº, centro, fecha, tipo, páginas y aviso legal). Sin nombres de personas. */
export function labelSheetHtml(records: readonly LabelRecord[], propertyName: string): string {
  const labels = records
    .map(
      (record) => `<section class="label">
  <p class="registry">${escapeHtml(formatRegistry(record.registryNumber))}</p>
  <dl>
    <dt>Centro</dt><dd>${escapeHtml(propertyName)}</dd>
    <dt>Fecha</dt><dd>${escapeHtml(date(record.capturedAt))}</dd>
    <dt>Tipo</dt><dd>${escapeHtml(DOCUMENT_KIND_LABELS[record.kind] ?? record.kind)}</dd>
    <dt>Páginas</dt><dd>${escapeHtml(record.pageCount)}</dd>
  </dl>
  <p class="notice">${escapeHtml(DIGITAL_COPY_NOTICE)}</p>
</section>`
    )
    .join("\n");
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Etiquetas de registro</title>
<style>body{font-family:system-ui,sans-serif;margin:16px}.label{border:1px solid;padding:12px 16px;margin:0 0 12px;width:300px;page-break-inside:avoid}.registry{font-family:ui-monospace,Menlo,monospace;font-size:22px;font-weight:700;letter-spacing:1px;margin:0 0 8px}dl{display:grid;grid-template-columns:72px 1fr;gap:4px 8px;margin:0;font-size:12px}dt{font-weight:600}dd{margin:0}.notice{margin:8px 0 0;font-size:10px}</style>
</head><body>${labels}</body></html>`;
}

/** Abre la ventana de impresión con las etiquetas; false cuando el navegador la bloquea (o fuera del navegador). */
export function printLabels(records: readonly LabelRecord[], propertyName: string): boolean {
  if (typeof window === "undefined" || records.length === 0) return false;
  const popup = window.open("", "_blank", "noopener,width=520,height=680");
  if (!popup) return false;
  popup.document.write(labelSheetHtml(records, propertyName));
  popup.document.close();
  popup.focus();
  popup.print();
  return true;
}

// ---------------------------------------------------------------------------
// Diálogo
// ---------------------------------------------------------------------------

export type DocumentLabelDialogProps = {
  open: boolean;
  onClose: () => void;
  /** Documentos a etiquetar (los recién capturados o una selección). */
  records: readonly LabelRecord[];
  propertyName: string;
};

export function DocumentLabelDialog({ open, onClose, records, propertyName }: DocumentLabelDialogProps) {
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    if (open) setBlocked(false);
  }, [open]);
  const count = records.length;

  function confirm() {
    const printed = printLabels(records, propertyName);
    setBlocked(!printed);
    if (printed) onClose();
  }

  return (
    <CocoaDialog
      open={open}
      onClose={onClose}
      title={count === 1 ? "Imprimir etiqueta" : `Imprimir ${plural(count, "etiqueta", "etiquetas")}`}
      description="Se abre la ventana de impresión con una etiqueta por documento: pégala en el papel o escribe el número a mano antes de meterlo en la valija."
      confirmLabel={ACTIONS.print}
      cancelLabel={ACTIONS.close}
      onConfirm={confirm}
      confirmDisabled={count === 0}
    >
      <div className="cocoa-stack" data-gap="2">
        <ul className="c22-section__list">
          {records.map((record) => (
            <li key={record.registryNumber}>
              <strong className="cocoa-mono">{formatRegistry(record.registryNumber)}</strong>
              <span>
                {DOCUMENT_KIND_LABELS[record.kind] ?? record.kind} · {date(record.capturedAt)} · {plural(record.pageCount, "página", "páginas")}
              </span>
            </li>
          ))}
        </ul>
        <p className="cocoa-note">{DIGITAL_COPY_NOTICE}</p>
        {blocked ? (
          <CocoaCallout tone="warning" role="alert">
            El navegador bloqueó la ventana de impresión: permite las ventanas emergentes para esta página y vuelve a pulsar «Imprimir».
          </CocoaCallout>
        ) : null}
      </div>
    </CocoaDialog>
  );
}

export default DocumentLabelDialog;
