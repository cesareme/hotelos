// Frontend client for the interactive maintenance board (real work-order CRUD).
//
// Tanda UX-3 · P3 (aditivo): `assignedTo: null` en el PATCH vacía la asignación
// (deshacer «Tomar»: `{ status: "open", assignedTo: null }`, diseño §4.4/D7; el
// API acepta null en maintenance.service.ts assertOptionalString) y
// `resolveWorkOrder` admite `keepalive` para que el POST diferido viaje en
// `pagehide` (diseño §5, escritura diferida de «Resuelta»/«Resolver»).
//
// Tanda UX-3 · P4 (fotos del parte, diseño §4.2/§4.4/§4.6; API de M1):
// `createWorkOrder` admite `photos?: [{ contentBase64, mimeType }]` (≤ 3, ≤ 1,5
// MiB decodificada, jpeg|png|webp; el API responde 201 y devuelve `media[]` con
// los metadatos), `listWorkOrderMedia(id)` lee GET /work-orders/:id/media
// (metadatos, sin bytes; maintenance.read) y `fetchWorkOrderMediaBlob(mediaId)`
// descarga los bytes de GET /work-orders/media/:mediaId con la cabecera
// Authorization por `apiRequestBlob`, como documentsApi.downloadFile (nunca un
// <img src="http://api/…"> sin sesión).
import { apiRequest, apiRequestBlob, type BlobResponse } from "./api-client";
import { getActivePropertyId } from "./activeProperty";

export type WoPriority = "emergency" | "urgent" | "normal" | "preventive";
export type WoStatus = "open" | "assigned" | "in_progress" | "waiting_vendor" | "resolved" | "closed";

export type WorkOrder = {
  id: string;
  propertyId: string;
  roomId?: string;
  assetId?: string;
  title: string;
  description?: string;
  priority: WoPriority;
  status: WoStatus;
  blocksRoom: boolean;
  assignedTo?: string;
  createdAt: string;
  resolvedAt?: string;
};

/** PATCH /work-orders/:id — `assignedTo: null` deja el parte sin asignar (inversa de «Tomar»). */
export type WorkOrderPatch = { status?: WoStatus; priority?: WoPriority; assignedTo?: string | null; title?: string; description?: string };

/** POST /work-orders/:id/resolve — `releaseRoom` libera la habitación bloqueada por el parte. */
export type ResolveWorkOrderBody = { resolutionNote?: string; releaseRoom?: boolean };

/** Opciones de red de las escrituras diferidas: `keepalive` cuando el POST viaja en `pagehide`. */
export type WorkOrderRequestOptions = { keepalive?: boolean };

/** Foto en línea que viaja en `POST /work-orders` (`photos[]`) o en `POST /work-orders/:id/media`: base64 sin prefijo `data:` y su MIME (jpeg | png | webp). */
export type WorkOrderPhotoInput = { contentBase64: string; mimeType: string };

/** Metadatos de un medio del parte (GET /work-orders/:id/media y `media[]` de la creación): nunca los bytes. */
export type WorkOrderMediaMeta = {
  id: string;
  workOrderId: string;
  objectKey: string;
  mediaType: "photo" | "video" | "document" | string;
  mimeType: string | null;
  sizeBytes: number | null;
  createdAt: string;
  createdBy: string | null;
  /** true cuando los bytes viven en la fila (GET /work-orders/media/:mediaId los sirve); false en las filas legacy con solo objectKey. */
  inline: boolean;
};

/** Cuerpo de `POST /work-orders`; con `photos` el API responde 201 y añade `media[]`. */
export type CreateWorkOrderPayload = {
  roomNumber?: string;
  title: string;
  description?: string;
  priority?: WoPriority;
  blocksRoom?: boolean;
  photos?: WorkOrderPhotoInput[];
};

export type CreatedWorkOrder = WorkOrder & { media?: WorkOrderMediaMeta[] };

const enc = encodeURIComponent;

export function fetchWorkOrders(propertyId = getActivePropertyId()) {
  return apiRequest<WorkOrder[]>(`/properties/${propertyId}/work-orders`);
}
export function createWorkOrder(payload: CreateWorkOrderPayload) {
  return apiRequest<CreatedWorkOrder>(`/work-orders`, { method: "POST", body: payload });
}
/** Metadatos de las fotos del parte en orden de alta (maintenance.read; 404 opaco fuera de la organización). */
export function listWorkOrderMedia(id: string) {
  return apiRequest<WorkOrderMediaMeta[]>(`/work-orders/${enc(id)}/media`);
}
/** Bytes de una foto en línea con la sesión (Authorization); 404 `WORK_ORDER_MEDIA_NOT_INLINE` en una fila legacy sin bytes. */
export function fetchWorkOrderMediaBlob(mediaId: string, options: { signal?: AbortSignal } = {}): Promise<BlobResponse> {
  return apiRequestBlob(`/work-orders/media/${enc(mediaId)}`, { signal: options.signal });
}
export function updateWorkOrder(id: string, patch: WorkOrderPatch) {
  return apiRequest<WorkOrder>(`/work-orders/${id}`, { method: "PATCH", body: patch });
}
export function resolveWorkOrder(id: string, body: ResolveWorkOrderBody = {}, options: WorkOrderRequestOptions = {}) {
  return apiRequest<WorkOrder>(`/work-orders/${id}/resolve`, { method: "POST", body, ...(options.keepalive ? { keepalive: true } : {}) });
}
export function blockRoomForWorkOrder(id: string) {
  return apiRequest<WorkOrder>(`/work-orders/${id}/block-room`, { method: "POST" });
}
