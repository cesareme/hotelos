// «Digitalizar» — el cajón de captura del centro (Tanda T9 · lote T9-10,
// diseño docs/design/DOCUMENTOS-DIGITALIZACION.md §4.1 «Back office» y «Foto
// desde el móvil», §10 «Captura»). Un CocoaDrawer sin estilos inline con:
//
//   1 Zona de captura   CocoaCard con arrastrar y soltar + dos CocoaFileInput:
//                       «Hacer foto» (accept image/*, capture="environment": en la
//                       PWA del móvil abre la cámara trasera; el escritorio lo
//                       ignora) y «Elegir ficheros» (PDF, imágenes, XML; multiple).
//                       A 400 px (`phone`) los botones son grandes y en una columna.
//   2 Ficheros          una tarjeta por fichero: miniatura (imágenes) o insignia
//                       del formato, nombre, tamaño (y el tamaño original si se
//                       comprimió), tipo sugerido en un CocoaSelect (kindHint) y
//                       «Quitar». Las fotos pasan por capture-compress.ts
//                       (≤ 1.600 px, JPEG 0,82) ANTES de codificarse en base64.
//   3 Nota y opciones   nota para la oficina y el interruptor «Admitir una copia
//                       ya capturada» (allowDuplicate → salta el 409
//                       DOCUMENT_DUPLICATE_FILE por sha256).
//
// «Capturar» envía POST /properties/:propertyId/documents por documentsApi.capture:
// un envío por tipo sugerido (kindHint es por petición), cada fichero vuelve
// como IncomingDocumentRecord con su nº de registro; los creados se comunican
// al padre aunque un envío posterior falle (el error se pinta con la frase de
// DOCUMENT_ERROR_MESSAGES · documentErrorMessage). `source` es `mobile` desde
// el móvil y `upload` en el escritorio. Cada apertura empieza limpia y las
// object URLs de las miniaturas se revocan al quitar el fichero o cerrar.

import { useEffect, useRef, useState } from "react";
import { DOCUMENT_FILE_NAME_MAX_LENGTH, DOCUMENT_UPLOAD_MAX_FILES, INCOMING_DOCUMENT_KINDS, type DocumentUploadFile, type IncomingDocumentKind, type IncomingDocumentRecord, type IncomingDocumentSource } from "@hotelos/shared";
import { CocoaBadge, CocoaButton, CocoaCallout, CocoaCard, CocoaDrawer, CocoaField, CocoaFileInput, CocoaInput, CocoaSelect, CocoaSwitch, selectAcceptedFiles } from "../../components/cocoa";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { plural } from "../../lib/format";
import { documentsApi } from "../../services/documentsApi";
import { compressImageFile, fileToBase64 } from "./capture-compress";
import { DOCUMENT_KIND_LABELS, documentErrorMessage, formatBytes } from "./documents-helpers";

/** Lo que admite el selector de ficheros (la lista blanca DOCUMENT_MIME_TYPES + las imágenes que capture-compress convierte a JPEG). */
export const CAPTURE_ACCEPT = "application/pdf,image/jpeg,image/png,image/tiff,image/webp,image/heic,application/xml,text/xml,.pdf,.jpg,.jpeg,.png,.tif,.tiff,.webp,.heic,.xml";
/** El botón «Hacer foto»: solo imágenes, cámara trasera en el móvil. */
export const PHOTO_ACCEPT = "image/*";
/** Tope por fichero antes de codificar (DOCUMENT_MAX_BYTES por defecto, 25 MB); el servidor responde 413 DOCUMENT_TOO_LARGE por encima de su límite. */
export const CAPTURE_MAX_BYTES = 25 * 1024 * 1024;

const KIND_OPTIONS = INCOMING_DOCUMENT_KINDS.map((kind) => ({ value: kind, label: DOCUMENT_KIND_LABELS[kind] }));

type PendingFile = {
  id: string;
  file: File;
  /** Object URL de la miniatura (imágenes); null para PDF / XML. */
  previewUrl: string | null;
  kind: IncomingDocumentKind;
  compressed: boolean;
  originalBytes: number;
};

type KindGroup = { kind: IncomingDocumentKind; files: PendingFile[] };

/** Un envío por tipo sugerido, en el orden de aparición del primer fichero de cada tipo. */
function groupByKind(pending: readonly PendingFile[]): KindGroup[] {
  const groups = new Map<IncomingDocumentKind, KindGroup>();
  for (const item of pending) {
    let group = groups.get(item.kind);
    if (!group) {
      group = { kind: item.kind, files: [] };
      groups.set(item.kind, group);
    }
    group.files.push(item);
  }
  return [...groups.values()];
}

function formatBadge(file: File): string {
  const dot = file.name.lastIndexOf(".");
  const extension = dot > 0 ? file.name.slice(dot + 1).toUpperCase() : "";
  if (extension) return extension;
  if (file.type === "application/pdf") return "PDF";
  if (file.type.includes("xml")) return "XML";
  return "Fichero";
}

let pendingSeq = 0;

export type DocumentCaptureDrawerProps = {
  open: boolean;
  onClose: () => void;
  propertyId: string;
  /** `documents.capture` concedido (canDo sobre useNavGate en la pantalla). */
  canCapture: boolean;
  /** Viewport de teléfono: botones grandes en una columna y `source: mobile`. */
  phone: boolean;
  /** Documentos creados (con nº de registro); también con éxito parcial. */
  onCaptured: (records: IncomingDocumentRecord[]) => void;
};

export function DocumentCaptureDrawer({ open, onClose, propertyId, canCapture, phone, onCaptured }: DocumentCaptureDrawerProps) {
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [note, setNote] = useState("");
  const [allowDuplicate, setAllowDuplicate] = useState(false);
  const [rejections, setRejections] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef<PendingFile[]>([]);
  pendingRef.current = pending;

  function revokeAll(items: readonly PendingFile[]) {
    for (const item of items) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  }

  // Cada apertura empieza limpia; al cerrar se liberan las miniaturas.
  useEffect(() => {
    if (open) {
      setPending([]);
      setNote("");
      setAllowDuplicate(false);
      setRejections([]);
      setError(null);
      setDragging(false);
      return undefined;
    }
    return () => revokeAll(pendingRef.current);
  }, [open]);

  async function addFiles(incoming: readonly File[]) {
    const { accepted, rejected } = selectAcceptedFiles(incoming, { accept: CAPTURE_ACCEPT, maxBytes: CAPTURE_MAX_BYTES });
    const messages = rejected.map((item) => item.reason);
    const room = Math.max(0, DOCUMENT_UPLOAD_MAX_FILES - pendingRef.current.length);
    if (accepted.length > room) messages.push(`Máximo ${DOCUMENT_UPLOAD_MAX_FILES} ficheros por envío: ${plural(accepted.length - room, "fichero descartado", "ficheros descartados")}.`);
    setRejections(messages);
    setError(null);
    const admitted = accepted.slice(0, room);
    if (admitted.length === 0) return;
    setPreparing(true);
    try {
      const prepared = await Promise.all(
        admitted.map(async (file): Promise<PendingFile> => {
          const result = await compressImageFile(file);
          pendingSeq += 1;
          return {
            id: `pending-${pendingSeq}`,
            file: result.file,
            previewUrl: result.file.type.startsWith("image/") ? URL.createObjectURL(result.file) : null,
            kind: "unknown",
            compressed: result.compressed,
            originalBytes: result.originalBytes
          };
        })
      );
      setPending((current) => [...current, ...prepared]);
    } finally {
      setPreparing(false);
    }
  }

  function removeFile(id: string) {
    setPending((current) => {
      const item = current.find((entry) => entry.id === id);
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
      return current.filter((entry) => entry.id !== id);
    });
  }

  function changeKind(id: string, kind: string) {
    setPending((current) => current.map((entry) => (entry.id === id ? { ...entry, kind: kind as IncomingDocumentKind } : entry)));
  }

  const canSubmit = canCapture && pending.length > 0 && !submitting && !preparing;
  const source: IncomingDocumentSource = phone ? "mobile" : "upload";

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const created: IncomingDocumentRecord[] = [];
    try {
      for (const group of groupByKind(pending)) {
        const files: DocumentUploadFile[] = await Promise.all(
          group.files.map(async (item) => ({
            fileName: item.file.name.slice(0, DOCUMENT_FILE_NAME_MAX_LENGTH),
            mimeType: item.file.type || "application/octet-stream",
            base64: await fileToBase64(item.file)
          }))
        );
        const records = await documentsApi.capture(
          {
            files,
            source,
            ...(group.kind !== "unknown" ? { kindHint: group.kind } : {}),
            ...(note.trim() ? { note: note.trim() } : {}),
            ...(allowDuplicate ? { allowDuplicate: true } : {})
          },
          propertyId
        );
        created.push(...records);
        const sent = new Set(group.files.map((item) => item.id));
        setPending((current) => {
          revokeAll(current.filter((entry) => sent.has(entry.id)));
          return current.filter((entry) => !sent.has(entry.id));
        });
      }
      onCaptured(created);
      onClose();
    } catch (err) {
      if (created.length > 0) onCaptured(created);
      setError(documentErrorMessage(err, "No se pudo capturar el documento. Inténtalo de nuevo."));
    } finally {
      setSubmitting(false);
    }
  }

  function close() {
    if (submitting) return;
    onClose();
  }

  const pickerSize = phone ? "large" : "small";
  const pickersDisabled = !canCapture || submitting || preparing;

  return (
    <CocoaDrawer
      open={open}
      onClose={close}
      title="Digitalizar documentos"
      subtitle="Factura, albarán, tique, carta o notificación: sube el PDF o haz una foto. Cada fichero recibe su número de registro y la oficina lo revisa."
      side={phone ? "bottom" : "right"}
      size="lg"
      footer={
        <>
          <CocoaButton variant="bordered" tone="neutral" onClick={close} disabled={submitting}>
            {ACTIONS.cancel}
          </CocoaButton>
          <CocoaButton variant="filled" tone="accent" onClick={() => void submit()} loading={submitting} disabled={!canSubmit} title={canCapture ? undefined : "Necesitas el permiso de captura de documentos"}>
            {submitting ? STATUS_LABELS.sending : pending.length > 0 ? `Capturar ${plural(pending.length, "fichero", "ficheros")}` : "Capturar"}
          </CocoaButton>
        </>
      }
    >
      <div className="cocoa-stack" data-gap="4">
        {!canCapture ? <p className="cocoa-note">Necesitas el permiso de captura de documentos («documents.capture») para digitalizar en este centro: pide a dirección que lo añada a tu perfil.</p> : null}

        <div
          onDragOver={(event) => {
            event.preventDefault();
            if (!dragging) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            if (pickersDisabled) return;
            void addFiles(Array.from(event.dataTransfer.files ?? []));
          }}
        >
          <CocoaCard variant={dragging ? "elevated" : "bordered"} padding="lg" role="group" aria-label="Zona de captura">
            <div className="cocoa-stack" data-gap="3">
              <strong>{phone ? "Haz una foto del papel o elige un fichero" : "Arrastra aquí los ficheros o elígelos"}</strong>
              <span className="cocoa-note">PDF, JPEG, PNG, TIFF o factura electrónica XML · hasta {DOCUMENT_UPLOAD_MAX_FILES} ficheros y {formatBytes(CAPTURE_MAX_BYTES)} por fichero · las fotos se comprimen en el dispositivo antes de enviarse.</span>
              <div className={phone ? "cocoa-stack" : "cocoa-row"} data-gap="2">
                <CocoaFileInput accept={PHOTO_ACCEPT} capture="environment" multiple maxBytes={CAPTURE_MAX_BYTES} onPickMany={(files) => void addFiles(files)} onReject={(message) => setRejections((current) => [...current, message])} label="Hacer foto" size={pickerSize} disabled={pickersDisabled} />
                <CocoaFileInput accept={CAPTURE_ACCEPT} multiple maxBytes={CAPTURE_MAX_BYTES} onPickMany={(files) => void addFiles(files)} onReject={(message) => setRejections((current) => [...current, message])} label="Elegir ficheros" size={pickerSize} disabled={pickersDisabled} />
                {preparing ? <span className="cocoa-caption">Preparando las imágenes…</span> : null}
              </div>
            </div>
          </CocoaCard>
        </div>

        {rejections.length > 0 ? (
          <CocoaCallout tone="warning" title="Ficheros no admitidos" role="alert" actions={<CocoaButton variant="plain" tone="neutral" size="small" onClick={() => setRejections([])}>{ACTIONS.close}</CocoaButton>}>
            <ul className="c22-section__list">
              {rejections.map((message, index) => (
                <li key={index}>
                  <span>{message}</span>
                </li>
              ))}
            </ul>
          </CocoaCallout>
        ) : null}

        {pending.length > 0 ? (
          <div className="cocoa-stack" data-gap="2" role="list" aria-label="Ficheros preparados">
            {pending.map((item) => (
              <CocoaCard key={item.id} variant="plain" padding="sm" role="listitem">
                <div className="cocoa-row" data-gap="2" data-align="start">
                  {item.previewUrl ? <img src={item.previewUrl} alt="" width={72} /> : <CocoaBadge tone="neutral">{formatBadge(item.file)}</CocoaBadge>}
                  <div className="cocoa-stack" data-gap="1">
                    <strong>{item.file.name}</strong>
                    <span className="cocoa-caption">
                      {formatBytes(item.file.size)}
                      {item.compressed ? ` · comprimida desde ${formatBytes(item.originalBytes)}` : ""}
                    </span>
                  </div>
                  <CocoaSelect size="small" inline value={item.kind} onChange={(value) => changeKind(item.id, value)} options={KIND_OPTIONS} aria-label={`Tipo sugerido de ${item.file.name}`} disabled={submitting} />
                  <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => removeFile(item.id)} disabled={submitting}>
                    {ACTIONS.remove}
                  </CocoaButton>
                </div>
              </CocoaCard>
            ))}
          </div>
        ) : null}

        <CocoaField label="Nota para la oficina" hint="opcional" help="Se guarda con el documento y ayuda a la revisión (ej.: «llegó con el pedido del martes»).">
          <CocoaInput value={note} onChange={setNote} multiline rows={2} maxLength={2000} disabled={submitting} />
        </CocoaField>

        <CocoaSwitch checked={allowDuplicate} onChange={setAllowDuplicate} label="Admitir una copia ya capturada (factura reenviada)" size="small" disabled={submitting} />

        {error ? (
          <CocoaCallout tone="danger" title="No se pudo capturar" role="alert">
            {error}
          </CocoaCallout>
        ) : null}
      </div>
    </CocoaDrawer>
  );
}

export default DocumentCaptureDrawer;
