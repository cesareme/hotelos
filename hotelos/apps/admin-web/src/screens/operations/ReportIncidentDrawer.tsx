// ReportIncidentDrawer — «Reportar» de Mi turno (Tanda UX-3 · P4 · docs/design/
// UX-PISOS-MANTENIMIENTO-FEEL.md §4.2, §4.6, §6; fricción F4). Sustituye al cajón
// de solo texto de HousekeepingMobileScreen: la camarera, con guantes y una mano,
// reporta una avería con foto en 3 toques y 0 tecleo (Reportar → chip de motivo →
// Foto → Enviar a mantenimiento; la cámara no cuenta como tecleo).
//
//   1 Motivo     chips «Fuga de agua» · «Bombilla» · «Aire acondicionado» ·
//                «TV/Wi-Fi» · «Cerradura» · «Otro» (report-incident.ts QUICK_REASONS)
//                → título «Hab. 203: <motivo>»; un solo chip activo (aria-pressed).
//   2 Foto       CocoaFileInput solo de imágenes (REPORT_PHOTO_ACCEPT) con
//                capture="environment" (cámara trasera en la tablet; en el
//                escritorio un selector de fichero, sin promesa falsa), ≤ 3
//                fotos, miniaturas con «Quitar». Cada
//                foto pasa por screens/documents/capture-compress.ts
//                (compressImageFile con `force`: ≤ 1.600 px, JPEG 0,82 SIEMPRE,
//                también las pequeñas de galería, para que los metadatos EXIF
//                —GPS, dispositivo, fecha— nunca lleguen al parte; corrector
//                UX-3-REV-L01) y se rechaza si sigue por encima de 1,5 MiB
//                (tope del API, WORK_ORDER_PHOTO_TOO_LARGE).
//   3 Detalle    CocoaInput opcional de una línea (Enter envía: `submitOnEnter`).
//   Pie          «Cancelar» · «Enviar a mantenimiento» (filled, size large: ≥ 44 px
//                con puntero grueso) → POST /work-orders con `photos[]`
//                (maintenanceApi.createWorkOrder, M1) → `onReported` (el padre
//                pinta el aviso «Avería de la 203 enviada a mantenimiento · 1 foto»).
//
// Cocoa 22: sin `style=` (miniaturas como en DocumentCaptureDrawer: img con
// atributo width), solo utilidades cocoa-stack / cocoa-row / cocoa-cluster; el
// único campo de fichero crudo lo encapsula CocoaFileInput (regla 4). Las object
// URLs de las miniaturas se revocan al quitar la foto y al cerrar.

import { useEffect, useRef, useState } from "react";
import { CocoaButton, CocoaCallout, CocoaDrawer, CocoaField, CocoaFileInput, CocoaInput } from "../../components/cocoa";
import { ACTIONS } from "../../content/actions";
import { PISOS_ACTIONS } from "../../content/pisos-actions";
import { plural } from "../../lib/format";
import { createWorkOrder, type CreatedWorkOrder } from "../../services/maintenanceApi";
import { compressImageFile, fileToBase64 } from "../documents/capture-compress";
import {
  QUICK_REASONS,
  REPORT_MAX_PHOTOS,
  REPORT_PHOTO_ACCEPT,
  REPORT_PHOTO_PICK_MAX_BYTES,
  admitPhotos,
  buildWorkOrderPayload,
  canSubmitReport,
  droppedPhotosMessage,
  formatMiB,
  type QuickReason
} from "./report-incident";

export type ReportIncidentRoom = { roomId: string; roomNumber: string };

export type ReportIncidentResult = {
  room: ReportIncidentRoom;
  workOrder: CreatedWorkOrder;
  /** Fotos que viajaron con el parte (0…3). */
  photos: number;
};

export interface ReportIncidentDrawerProps {
  /** Habitación que se reporta; null = cajón cerrado. */
  room: ReportIncidentRoom | null;
  onClose: () => void;
  /** El parte ya existe en el API: el padre avisa (toast con número y fotos) y cierra. */
  onReported: (result: ReportIncidentResult) => void;
}

type PendingPhoto = {
  id: string;
  file: File;
  previewUrl: string;
  compressed: boolean;
  originalBytes: number;
};

/** Miniatura de la lista de fotos (72 px de ancho, como el cajón de captura de documentos). */
const THUMB_WIDTH = 72;
const REASON_ID_PREFIX = "housekeeping-report-reason-";
export const REPORT_DETAILS_INPUT_ID = "housekeeping-report";

let photoSeq = 0;

function revokeAll(items: readonly PendingPhoto[]): void {
  for (const item of items) URL.revokeObjectURL(item.previewUrl);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function ReportIncidentDrawer({ room, onClose, onReported }: ReportIncidentDrawerProps) {
  const open = room !== null;
  const [reason, setReason] = useState<QuickReason | null>(null);
  const [details, setDetails] = useState("");
  const [photos, setPhotos] = useState<PendingPhoto[]>([]);
  const [notices, setNotices] = useState<string[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const photosRef = useRef<PendingPhoto[]>([]);
  photosRef.current = photos;

  // Cada apertura empieza limpia; al cerrar se liberan las miniaturas.
  useEffect(() => {
    if (open) {
      setReason(null);
      setDetails("");
      setPhotos([]);
      setNotices([]);
      setError(null);
      setPreparing(false);
      setSubmitting(false);
      return undefined;
    }
    return () => {
      revokeAll(photosRef.current);
      photosRef.current = [];
    };
  }, [open]);

  async function addPhotos(incoming: readonly File[]) {
    setError(null);
    setPreparing(true);
    try {
      // Comprimir ANTES de decidir: una foto de 4 MB del móvil cabe tras pasar a ≤ 1.600 px JPEG. `force`: también las
      // pequeñas se recodifican, así el JPEG del canvas (sin EXIF: GPS, dispositivo, fecha) es lo único que se guarda (REV-L01).
      const compressed = await Promise.all(incoming.map((file) => compressImageFile(file, { force: true })));
      const admission = admitPhotos(
        photosRef.current.length,
        compressed.map((result) => result.file)
      );
      const messages = [...admission.rejected];
      const dropped = droppedPhotosMessage(admission.droppedByLimit);
      if (dropped) messages.push(dropped);
      setNotices(messages);
      if (admission.accepted.length === 0) return;
      const prepared = admission.accepted.map((file): PendingPhoto => {
        const result = compressed.find((entry) => entry.file === file);
        photoSeq += 1;
        return {
          id: `photo-${photoSeq}`,
          file,
          previewUrl: URL.createObjectURL(file),
          compressed: result?.compressed ?? false,
          originalBytes: result?.originalBytes ?? file.size
        };
      });
      setPhotos((current) => [...current, ...prepared]);
    } finally {
      setPreparing(false);
    }
  }

  function removePhoto(id: string) {
    setPhotos((current) => {
      const item = current.find((entry) => entry.id === id);
      if (item) URL.revokeObjectURL(item.previewUrl);
      return current.filter((entry) => entry.id !== id);
    });
  }

  const canSubmit = open && !submitting && !preparing && canSubmitReport({ reason, details });

  async function submit() {
    if (!room || !canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const encoded = await Promise.all(photos.map(async (item) => ({ contentBase64: await fileToBase64(item.file), mimeType: item.file.type })));
      const payload = buildWorkOrderPayload({ roomNumber: room.roomNumber, reason, details, photos: encoded });
      const workOrder = await createWorkOrder(payload);
      onReported({ room, workOrder, photos: payload.photos?.length ?? 0 });
    } catch (err) {
      setError(errorMessage(err, "No se pudo reportar la incidencia."));
    } finally {
      setSubmitting(false);
    }
  }

  const photoHint = photos.length === 0 ? `opcional · hasta ${REPORT_MAX_PHOTOS}` : `${plural(photos.length, "foto", "fotos")} de ${REPORT_MAX_PHOTOS}`;

  return (
    <CocoaDrawer
      open={open}
      onClose={onClose}
      title="Reportar incidencia"
      subtitle={room ? `Habitación ${room.roomNumber}` : undefined}
      side="right"
      size="sm"
      submitOnEnter
      initialFocus={() => document.getElementById(`${REASON_ID_PREFIX}0`)}
      footer={
        <>
          <CocoaButton variant="bordered" tone="neutral" size="large" onClick={onClose} disabled={submitting}>
            {ACTIONS.cancel}
          </CocoaButton>
          <CocoaButton size="large" onClick={() => void submit()} loading={submitting} disabled={!canSubmit}>
            {PISOS_ACTIONS.sendToMaintenance}
          </CocoaButton>
        </>
      }
    >
      <div className="cocoa-stack" data-gap="4">
        <CocoaField label="Motivo" help="Un toque basta: el título del parte sale solo («Hab. 203: Fuga de agua»).">
          <div className="cocoa-cluster" role="group" aria-label="Motivo">
            {QUICK_REASONS.map((candidate, index) => {
              const active = reason === candidate;
              return (
                <CocoaButton
                  key={candidate}
                  id={`${REASON_ID_PREFIX}${index}`}
                  size="large"
                  variant={active ? "tinted" : "bordered"}
                  tone={active ? "accent" : "neutral"}
                  aria-pressed={active}
                  disabled={submitting}
                  onClick={() => setReason(active ? null : candidate)}
                >
                  {candidate}
                </CocoaButton>
              );
            })}
          </div>
        </CocoaField>

        <CocoaField label={PISOS_ACTIONS.photo} hint={photoHint} help="En la tablet abre la cámara trasera; en el ordenador, un selector de imágenes. Se reducen antes de enviarse.">
          <div className="cocoa-stack" data-gap="2">
            <CocoaFileInput
              accept={REPORT_PHOTO_ACCEPT}
              capture="environment"
              multiple
              maxBytes={REPORT_PHOTO_PICK_MAX_BYTES}
              label={PISOS_ACTIONS.photo}
              size="large"
              disabled={submitting || preparing || photos.length >= REPORT_MAX_PHOTOS}
              onPickMany={(files) => void addPhotos(files)}
              onReject={(message) => setNotices((current) => [...current, message])}
            />
            {preparing ? <span className="cocoa-caption">Preparando la foto…</span> : null}
            {photos.length > 0 ? (
              <div className="cocoa-cluster" role="list" aria-label="Fotos elegidas">
                {photos.map((item, index) => (
                  <span key={item.id} role="listitem" className="cocoa-row" data-gap="1" data-align="center">
                    <img src={item.previewUrl} alt={`Foto ${index + 1}`} width={THUMB_WIDTH} />
                    <span className="cocoa-stack" data-gap="0">
                      <span className="cocoa-caption">
                        {formatMiB(item.file.size)} MB{item.compressed ? ` · reducida desde ${formatMiB(item.originalBytes)} MB` : ""}
                      </span>
                      <CocoaButton variant="plain" tone="neutral" size="small" aria-label={`Quitar foto ${index + 1}`} disabled={submitting} onClick={() => removePhoto(item.id)}>
                        {ACTIONS.remove}
                      </CocoaButton>
                    </span>
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </CocoaField>

        <CocoaField label="Detalle" hint="opcional" help="Qué has visto. Con «Otro» (o sin motivo) este texto es el título del parte. Intro envía.">
          <CocoaInput id={REPORT_DETAILS_INPUT_ID} value={details} onChange={setDetails} placeholder="Ej.: gotea el grifo del lavabo" maxLength={500} disabled={submitting} />
        </CocoaField>

        {notices.length > 0 ? (
          <CocoaCallout tone="warning" title="Fotos no admitidas" role="alert" actions={<CocoaButton variant="plain" tone="neutral" size="small" onClick={() => setNotices([])}>{ACTIONS.close}</CocoaButton>}>
            <ul className="c22-section__list">
              {notices.map((message, index) => (
                <li key={index}>
                  <span>{message}</span>
                </li>
              ))}
            </ul>
          </CocoaCallout>
        ) : null}

        {error ? (
          <CocoaCallout tone="danger" title="No se pudo enviar" role="alert">
            {error}
          </CocoaCallout>
        ) : null}
      </div>
    </CocoaDrawer>
  );
}

export default ReportIncidentDrawer;
