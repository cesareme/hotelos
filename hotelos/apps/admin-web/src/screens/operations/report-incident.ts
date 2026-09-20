// «Reportar» desde Mi turno (Tanda UX-3 · P4 · docs/design/UX-PISOS-MANTENIMIENTO-FEEL.md
// §4.2, §4.6, §6; fricción F4): la parte PURA del cajón ReportIncidentDrawer.tsx.
// Sin React ni import.meta.env para que `node --test` la importe tal cual.
//
//   · Motivos rápidos (chips): un toque elige el motivo y el título del parte
//     sale solo («Hab. 203: Fuga de agua»), sin teclear nada (regla de pasillo:
//     guantes y una mano). «Otro» admite el detalle libre como título.
//   · Fotos: ≤ 3 por parte (WORK_ORDER_PHOTOS_TOO_MANY en el API) y ≤ 1,5 MiB
//     decodificadas cada una (WORK_ORDER_PHOTO_TOO_LARGE); jpeg | png | webp.
//     La compresión previa la hace screens/documents/capture-compress.ts
//     (≤ 1.600 px, JPEG 0,82) en el cajón; aquí solo se decide.
//   · `buildWorkOrderPayload` construye el cuerpo de POST /work-orders (M1):
//     `photos[]` solo cuando hay alguna (sin fotos el cuerpo clásico responde
//     200; con `photos` el API responde 201).

import type { CreateWorkOrderPayload, WorkOrderPhotoInput } from "../../services/maintenanceApi";

/** Motivos rápidos en el orden de los chips (diseño §4.2); «Otro» siempre el último. */
export const QUICK_REASONS = ["Fuga de agua", "Bombilla", "Aire acondicionado", "TV/Wi-Fi", "Cerradura", "Otro"] as const;
export type QuickReason = (typeof QUICK_REASONS)[number];
export const OTHER_REASON: QuickReason = "Otro";

/** Fotos por parte (mismo tope que el API: WORK_ORDER_PHOTOS_TOO_MANY a la cuarta). */
export const REPORT_MAX_PHOTOS = 3;
/** Bytes decodificados por foto que admite el API (1,5 MiB, WORK_ORDER_PHOTO_TOO_LARGE); se comprueba tras comprimir. */
export const REPORT_PHOTO_MAX_BYTES = Math.round(1.5 * 1024 * 1024);
/** Lo que admite el selector: solo imágenes (la cámara trasera en la tablet con capture="environment"). */
export const REPORT_PHOTO_ACCEPT = "image/*";
/** Tope del fichero ANTES de comprimir (una foto de móvil de 12 MP): el canvas la reduce; por encima se rechaza sin decodificar. */
export const REPORT_PHOTO_PICK_MAX_BYTES = 25 * 1024 * 1024;
/** Tipos que el API comprueba por magic bytes; el resto se rechaza antes de enviar. */
export const REPORT_PHOTO_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
/** Longitud máxima del título del parte (como el cajón anterior: `description.slice(0, 80)`). */
export const REPORT_TITLE_MAX_LENGTH = 80;

export type ReportIncidentInput = {
  roomNumber: string;
  /** Chip elegido; null si la persona solo ha escrito. */
  reason: QuickReason | null;
  /** Texto opcional del CocoaInput. */
  details: string;
  photos: readonly WorkOrderPhotoInput[];
};

/** ¿Se puede enviar? Hace falta un motivo o un detalle escrito (las fotos solas no dicen qué pasa). */
export function canSubmitReport(input: Pick<ReportIncidentInput, "reason" | "details">): boolean {
  return input.reason !== null || input.details.trim().length > 0;
}

/**
 * Título del parte (pure): «Hab. NNN: <motivo>»; con «Otro» (o sin chip) el
 * detalle escrito hace de motivo, recortado a 80 caracteres como antes; sin
 * nada que decir, «Hab. NNN: Otro».
 */
export function reportTitle(roomNumber: string, reason: QuickReason | null, details: string): string {
  const text = details.trim();
  const motive = reason && reason !== OTHER_REASON ? reason : text || reason || "";
  return `Hab. ${roomNumber}: ${motive.slice(0, REPORT_TITLE_MAX_LENGTH)}`;
}

/**
 * Cuerpo de POST /work-orders (pure): prioridad normal (como el cajón anterior),
 * `description` solo si hay detalle (con un chip el título ya lo dice) y
 * `photos` solo si hay alguna (≤ 3: el resto se descarta aquí, nunca llega a
 * un 400). La propiedad la fija el API por la cabecera de propiedad activa.
 */
export function buildWorkOrderPayload(input: ReportIncidentInput): CreateWorkOrderPayload {
  const details = input.details.trim();
  // Sin chip (o con «Otro») el detalle ya es el título: solo se repite como descripción si el título lo recortó.
  const detailsAreTitle = !input.reason || input.reason === OTHER_REASON;
  const description = details && (!detailsAreTitle || details.length > REPORT_TITLE_MAX_LENGTH) ? details : undefined;
  const photos = input.photos.slice(0, REPORT_MAX_PHOTOS).map((photo) => ({ contentBase64: photo.contentBase64, mimeType: photo.mimeType }));
  return {
    roomNumber: input.roomNumber,
    title: reportTitle(input.roomNumber, input.reason, input.details),
    ...(description ? { description } : {}),
    priority: "normal",
    ...(photos.length > 0 ? { photos } : {})
  };
}

export type PhotoAdmission<T> = {
  /** Las que caben (en orden) hasta completar REPORT_MAX_PHOTOS. */
  accepted: T[];
  /** Cuántas se han descartado por el tope. */
  droppedByLimit: number;
  /** Mensajes en español de las rechazadas por tipo o peso (tras comprimir). */
  rejected: string[];
};

/** Decide qué fotos nuevas entran (pure): tipo admitido, peso ≤ 1,5 MiB y hueco hasta 3 contando las ya elegidas. */
export function admitPhotos<T extends { name: string; size: number; type: string }>(current: number, incoming: readonly T[], limits: { max?: number; maxBytes?: number } = {}): PhotoAdmission<T> {
  const max = limits.max ?? REPORT_MAX_PHOTOS;
  const maxBytes = limits.maxBytes ?? REPORT_PHOTO_MAX_BYTES;
  const admission: PhotoAdmission<T> = { accepted: [], droppedByLimit: 0, rejected: [] };
  let room = Math.max(0, max - current);
  for (const file of incoming) {
    const mime = (file.type || "").toLowerCase();
    if (!(REPORT_PHOTO_MIME_TYPES as readonly string[]).includes(mime)) {
      admission.rejected.push(`«${file.name}» no es una foto JPEG, PNG o WebP.`);
      continue;
    }
    if (file.size > maxBytes) {
      admission.rejected.push(`«${file.name}» pesa ${formatMiB(file.size)} MB tras comprimirla; el máximo es ${formatMiB(maxBytes)} MB.`);
      continue;
    }
    if (room === 0) {
      admission.droppedByLimit += 1;
      continue;
    }
    room -= 1;
    admission.accepted.push(file);
  }
  return admission;
}

/** «1,5» · «2,3» (MiB con una decimal, coma española; pure). */
export function formatMiB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1).replace(".", ",");
}

/** Aviso por fotos que no caben: «Máximo 3 fotos por parte: 1 foto descartada.» (pure). */
export function droppedPhotosMessage(dropped: number, max = REPORT_MAX_PHOTOS): string | null {
  if (dropped <= 0) return null;
  return `Máximo ${max} fotos por parte: ${dropped === 1 ? "1 foto descartada" : `${dropped} fotos descartadas`}.`;
}
