// Visor del original de un documento digitalizado (Tanda T9 · lote T9-12,
// diseño docs/design/DOCUMENTOS-DIGITALIZACION.md §10 «Bandeja y revisión»):
// la columna `content` del CocoaSplitView de Documentos y el cuerpo del cajón
// de detalle del Archivo. Descarga el fichero original por
// documentsApi.downloadFile (apiRequestBlob, auditado en el servidor) y lo
// pinta desde un `blob:` propio: PDF en un <iframe> (fragmento `#page=N&zoom=Z`
// del visor del navegador; el iframe se remonta al cambiar de página o zoom
// para que el visor lo aplique), imagen en un <img> (zoom por el atributo
// `width` sobre el ancho medido del contenedor) y XML / otros con la nota y la
// descarga. Miniaturas por página (los botones «Pág. N»; con
// `DocumentPageDto.imageFileId` se intenta la imagen rasterizada por
// documentsApi.pageImage, si no el número) y «Cortar aquí» sobre la página
// activa → `onSplitAt` (POST …/split desde la pantalla). Se pinta dentro del
// <CocoaPage> de IncomingDocumentsScreen (o del cajón del Archivo), sin
// cabecera propia y sin estilos inline (Cocoa 22): la geometría va por
// atributos HTML (width / height) y por las clases de cocoa-22-layout.css.

import { useEffect, useMemo, useRef, useState } from "react";
import type { IncomingDocumentDetail } from "@hotelos/shared";
import { CocoaBadge, CocoaButton, CocoaCallout, CocoaSegmentedControl, CocoaState, useElementWidth } from "../../components/cocoa";
import { openBlob, saveBlob } from "../../components/billing/download";
import { ACTIONS } from "../../content/actions";
import { plural } from "../../lib/format";
import { documentsApi } from "../../services/documentsApi";
import { documentErrorMessage, formatBytes, formatRegistry } from "./documents-helpers";

export type ViewerZoom = "75" | "100" | "150";

const ZOOM_OPTIONS: Array<{ value: ViewerZoom; label: string }> = [
  { value: "75", label: "75 %" },
  { value: "100", label: "100 %" },
  { value: "150", label: "150 %" }
];

export const POPUP_BLOCKED = "El navegador bloqueó la ventana: permite las ventanas emergentes para esta página.";

export type ViewerKind = "pdf" | "image" | "other";

/** Cómo se pinta el original según su MIME: PDF en iframe, imagen en img, el resto (XML de e-factura, TIFF) solo se descarga. */
export function viewerKindOf(mimeType: string | null | undefined): ViewerKind {
  const mime = (mimeType ?? "").toLowerCase();
  if (mime === "application/pdf") return "pdf";
  if (mime === "image/jpeg" || mime === "image/png" || mime === "image/webp" || mime === "image/gif") return "image";
  return "other";
}

/** Fragmento del visor de PDF del navegador: página 1-based y zoom en %. */
export function pdfFragment(page: number, zoom: ViewerZoom): string {
  return `#page=${Math.max(1, Math.floor(page))}&zoom=${zoom}`;
}

/** Nombre de fichero de una cabecera `Content-Disposition` (`attachment; filename="x.pdf"` o `filename*=UTF-8''x.pdf`); null si no lo lleva. */
export function fileNameFromDisposition(header: string | null | undefined): string | null {
  if (!header) return null;
  const star = /filename\*=(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      return star[1].trim();
    }
  }
  const plain = /filename="?([^";]+)"?/.exec(header);
  return plain ? plain[1].trim() : null;
}

/** Rangos de «Cortar aquí» en la página `page`: [1, page − 1] y [page, pageCount]; null cuando no hay corte posible. */
export function splitRangesAt(page: number, pageCount: number): Array<[number, number]> | null {
  if (pageCount < 2 || page < 2 || page > pageCount) return null;
  return [
    [1, page - 1],
    [page, pageCount]
  ];
}

export interface DocumentViewerProps {
  document: IncomingDocumentDetail;
  propertyId: string;
  /** Página activa (1-based): la resalta en las miniaturas y la abre en el PDF. */
  activePage: number;
  onPageChange: (page: number) => void;
  /** «Cortar aquí» (página activa ≥ 2): la pantalla llama a documentsApi.split. */
  onSplitAt?: (page: number) => void;
  canSplit?: boolean;
  busy?: boolean;
  /** Alto del visor en px (720 en escritorio, 420 en el móvil). */
  height?: number;
}

type LoadedFile = { url: string; blob: Blob; kind: ViewerKind; fileName: string | null };

export function DocumentViewer({ document: doc, propertyId, activePage, onPageChange, onSplitAt, canSplit = false, busy = false, height = 720 }: DocumentViewerProps) {
  const [file, setFile] = useState<LoadedFile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<ViewerZoom>("100");
  const [thumbs, setThumbs] = useState<Record<number, string>>({});
  const frameRef = useRef<HTMLDivElement | null>(null);
  const frameWidth = useElementWidth(frameRef);
  const original = useMemo(() => doc.files.find((f) => f.role === "original") ?? doc.files[0] ?? null, [doc.files]);
  const pageCount = Math.max(doc.pageCount, doc.pages.length, 1);

  // El original como blob: propio de este documento; se revoca al cambiar o desmontar.
  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    setLoading(true);
    setError(null);
    setFile(null);
    documentsApi
      .downloadFile(doc.id, { inline: true }, propertyId)
      .then((response) => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(response.blob);
        setFile({ url: objectUrl, blob: response.blob, kind: viewerKindOf(response.blob.type || original?.mimeType || doc.originalFormat), fileName: fileNameFromDisposition(response.contentDisposition) ?? original?.fileName ?? null });
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(documentErrorMessage(err, "No se pudo abrir el original."));
        setLoading(false);
      });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [doc.id, propertyId, original?.mimeType, original?.fileName, doc.originalFormat]);

  // Miniaturas rasterizadas solo para las páginas que ya tienen imagen (imageFileId); el resto pinta el número.
  useEffect(() => {
    let alive = true;
    const urls: string[] = [];
    const withImage = doc.pages.filter((page) => page.imageFileId);
    setThumbs({});
    for (const page of withImage) {
      documentsApi
        .pageImage(doc.id, page.pageNo, { inline: true }, propertyId)
        .then((response) => {
          if (!alive) return;
          const url = URL.createObjectURL(response.blob);
          urls.push(url);
          setThumbs((prev) => ({ ...prev, [page.pageNo]: url }));
        })
        .catch(() => {
          /* sin imagen rasterizada todavía: queda el número de página */
        });
    }
    return () => {
      alive = false;
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [doc.id, doc.pages, propertyId]);

  const imageWidth = frameWidth !== null ? Math.max(120, Math.round((frameWidth * Number(zoom)) / 100)) : undefined;
  const splitRanges = splitRangesAt(activePage, pageCount);
  const fileName = file?.fileName ?? original?.fileName ?? `${formatRegistry(doc.registryNumber)}.bin`;

  function download() {
    if (file) saveBlob(file.blob, fileName);
  }

  function openTab() {
    if (!file) return;
    if (!openBlob(file.blob)) setError(POPUP_BLOCKED);
  }

  return (
    <div className="cocoa-stack" data-gap="3" aria-label="Visor del documento">
      <div className="cocoa-row" data-gap="2" data-justify="between">
        <div className="cocoa-cluster">
          <CocoaBadge tone="neutral" variant="outline" uppercase={false}>
            {plural(pageCount, "página", "páginas")}
          </CocoaBadge>
          <CocoaBadge tone="neutral" variant="outline" uppercase={false}>
            {original ? `${original.mimeType} · ${formatBytes(original.sizeBytes)}` : formatBytes(doc.sizeBytes)}
          </CocoaBadge>
          {file?.kind !== "other" ? <CocoaSegmentedControl value={zoom} onChange={(v) => setZoom(v as ViewerZoom)} options={ZOOM_OPTIONS} size="small" aria-label="Zoom del visor" /> : null}
        </div>
        <div className="cocoa-row" data-gap="2">
          <CocoaButton variant="plain" tone="neutral" size="small" onClick={openTab} disabled={!file}>
            Abrir en pestaña
          </CocoaButton>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={download} disabled={!file}>
            {ACTIONS.download}
          </CocoaButton>
        </div>
      </div>

      {pageCount > 1 ? (
        <div className="cocoa-cluster" role="list" aria-label="Páginas del documento">
          {Array.from({ length: pageCount }, (_, index) => index + 1).map((pageNo) => (
            <div key={pageNo} role="listitem">
              <CocoaButton variant={pageNo === activePage ? "tinted" : "bordered"} tone={pageNo === activePage ? "accent" : "neutral"} size="small" onClick={() => onPageChange(pageNo)} aria-pressed={pageNo === activePage} aria-label={`Página ${pageNo}`}>
                {thumbs[pageNo] ? <img src={thumbs[pageNo]} alt="" width={48} /> : null}
                {`Pág. ${pageNo}`}
              </CocoaButton>
            </div>
          ))}
          {onSplitAt && splitRanges ? (
            <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => onSplitAt(activePage)} disabled={!canSplit || busy} title={canSplit ? `Dividir en páginas 1-${activePage - 1} y ${activePage}-${pageCount}` : "Solo se divide un documento capturado o en revisión con permiso de captura o revisión"}>
                {`Cortar aquí (${activePage}-${pageCount})`}
            </CocoaButton>
          ) : null}
        </div>
      ) : null}

      <div ref={frameRef} className="cocoa-stack" data-gap="2">
        {loading ? <CocoaState kind="loading" inline title="Abriendo el original" /> : null}
        {error ? <CocoaState kind="error" inline title="No se pudo abrir el original" message={error} /> : null}
        {file && file.kind === "pdf" ? <iframe key={`${activePage}-${zoom}`} src={`${file.url}${pdfFragment(activePage, zoom)}`} title={`Original ${formatRegistry(doc.registryNumber)}`} width="100%" height={height} /> : null}
        {file && file.kind === "image" ? (
          <div className="cocoa-scroll-x">
            <img src={file.url} alt={`Original ${formatRegistry(doc.registryNumber)}`} width={imageWidth} />
          </div>
        ) : null}
        {file && file.kind === "other" ? (
          <CocoaCallout tone="info" title="Este formato no se previsualiza">
            {`El original es ${original?.mimeType ?? doc.originalFormat ?? "un fichero"} (${formatBytes(original?.sizeBytes ?? doc.sizeBytes)}): descárgalo para consultarlo. Los campos extraídos de una factura electrónica ya están en el panel de revisión.`}
          </CocoaCallout>
        ) : null}
      </div>
    </div>
  );
}

export default DocumentViewer;
