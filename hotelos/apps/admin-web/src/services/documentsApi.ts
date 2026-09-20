// Documentos y digitalización (Tanda T9 · lote T9-10, diseño
// docs/design/DOCUMENTOS-DIGITALIZACION.md §9). Cliente tipado de
// apps/api/src/modules/documents/{documents,pipeline,…}.routes.ts sobre
// packages/shared/src/documents-types.ts: dinero como cadena, días AAAA-MM-DD,
// `details.code` ∈ DOCUMENT_ERROR_CODES en los 4xx/5xx (la frase en español la
// pone screens/documents/documents-helpers.ts · documentErrorMessage).
//
//   POST  /properties/:propertyId/documents                          capture            documents.capture
//   POST  /properties/:propertyId/documents/:id/files                addFile            documents.capture
//   GET   /properties/:propertyId/documents                          list (envelope)    authenticated (capture | review en el servicio)
//   GET   /properties/:propertyId/documents/:id                      get                idem
//   GET   /properties/:propertyId/documents/:id/file                 downloadFile       idem (binario, ?inline=1)
//   GET   /properties/:propertyId/documents/:id/pages/:n/image       pageImage          idem (binario)
//   POST  /properties/:propertyId/documents/:id/classify | extract   classify · extract capture | review
//   POST  /properties/:propertyId/documents/:id/send-to-office       sendToOffice       documents.capture
//   POST  /properties/:propertyId/documents/:id/recapture            recapture          documents.capture
//   POST  /properties/:propertyId/documents/:id/split | merge        split · merge      capture | review
//   POST  /properties/:propertyId/documents/dispatch-batches         dispatchBatches.create   documents.capture
//   POST  …/dispatch-batches/:batchId/receive                        dispatchBatches.receive  documents.review
//   GET   …/dispatch-batches/:batchId/sheet                          dispatchBatches.sheet    (hoja de remesa, binario)
//   POST  /properties/:propertyId/documents/:id/assign | review      assign · review    documents.review
//   POST  /properties/:propertyId/documents/:id/approve | reject     approve · reject   documents.review (+ clave de la acción)
//   POST  /properties/:propertyId/documents/:id/archive              archiveDocument    documents.review
//   POST  /properties/:propertyId/documents/:id/actions              actions.create     documents.review
//   PATCH /properties/:propertyId/documents/:id/actions/:actionId    actions.update     documents.review
//   GET   /organizations/:organizationId/documents/queue             queue (envelope)   documents.review + R11
//   GET   /organizations/:organizationId/documents/archive           archive.search     documents.archive.read + R11
//   GET   /organizations/:organizationId/documents/kpis              kpis               documents.review + R11
//   GET|PATCH /organizations/:organizationId/documents/settings      settings.get|patch documents.admin
//   POST  /organizations/:organizationId/documents/:id/block|unblock|purge   block · unblock · purge   documents.admin
//
// Estado del API (2026-09-20, tras T9-13): las 34 rutas existen — captura, bandeja,
// descargas, classify/extract, send-to-office, recapture y cola (documents.routes /
// pipeline.routes, T9-05a/T9-06a), el flujo assign/review/approve/reject/archive,
// split/merge, tareas y valija con su hoja de remesa (workflow.routes.ts) y el
// archivo (`archive.search`), KPIs (con `officeSlaBusinessDays`), ajustes y
// block/unblock/purge (archive.routes.ts, T9-13). Un 4xx llega con `details.code`
// del catálogo DOCUMENT_ERROR_CODES y la pantalla enseña la frase de
// DOCUMENT_ERROR_MESSAGES · documentErrorMessage.
//
// Listas: siempre `envelope=1` para recibir `{ items, nextCursor }`
// (lib/pagination.ts). `documentListPath` / `documentListQuery` (y los de la
// cola) existen para que las pantallas lean con `useApiData(path, { query })`
// y compartan la caché del hook. Defaults: el centro / la organización activos
// (services/activeProperty.ts), como payablesApi.ts.

import type {
  DocumentActionDto,
  DocumentActionPatchRequest,
  DocumentActionRequest,
  DocumentAddFileRequest,
  DocumentAdminActionRequest,
  DocumentApproveRequest,
  DocumentApproveResponse,
  DocumentArchiveFilters,
  DocumentArchiveRequest,
  DocumentAssignRequest,
  DocumentDispatchBatchDto,
  DocumentDispatchBatchRequest,
  DocumentDispatchReceiveRequest,
  DocumentExtractRequest,
  DocumentExtractResponse,
  DocumentFileDto,
  DocumentKpis,
  DocumentListPage,
  DocumentMergeRequest,
  DocumentQueueFilters,
  DocumentRejectRequest,
  DocumentReviewRequest,
  DocumentSettingsDto,
  DocumentSettingsPatchRequest,
  DocumentSplitRequest,
  DocumentUploadRequest,
  IncomingDocumentDetail,
  IncomingDocumentRecord,
  IsoDay
} from "@hotelos/shared";
import { apiRequest, apiRequestBlob, type BlobResponse } from "./api-client";
import { getActiveOrganizationId, getActivePropertyId } from "./activeProperty";
import { compactQuery, type FinanceQuery } from "./finance-contracts";

export type {
  DocumentActionDto,
  DocumentDispatchBatchDto,
  DocumentExtractResponse,
  DocumentFileDto,
  DocumentKpis,
  DocumentListPage,
  DocumentQueueFilters,
  DocumentSettingsDto,
  IncomingDocumentDetail,
  IncomingDocumentRecord
} from "@hotelos/shared";

const enc = encodeURIComponent;

/** Query de descarga binaria: `inline=1` → content-disposition inline (visor); sin él, attachment. */
export type DocumentDownloadOptions = { inline?: boolean };

/** Query de `GET …/documents/kpis`. */
export type DocumentKpisQuery = { from: IsoDay; to: IsoDay; propertyId?: string };

// ---- Rutas y queries de lectura (para useApiData) ---------------------------

export function documentListPath(propertyId = getActivePropertyId()): string {
  return `/properties/${enc(propertyId)}/documents`;
}

export function documentQueuePath(organizationId = getActiveOrganizationId()): string {
  return `/organizations/${enc(organizationId)}/documents/queue`;
}

export function documentArchivePath(organizationId = getActiveOrganizationId()): string {
  return `/organizations/${enc(organizationId)}/documents/archive`;
}

/** Filtros de bandeja / cola como query string; `status` admite lista (`a,b`); siempre `envelope=1`. */
export function documentListQuery(filters: DocumentQueueFilters = {}): FinanceQuery {
  return compactQuery({
    status: Array.isArray(filters.status) ? filters.status.join(",") : filters.status,
    kind: filters.kind,
    physicalStatus: filters.physicalStatus,
    propertyId: filters.propertyId,
    assignedTo: filters.assignedTo,
    slaBreachedOnly: filters.slaBreachedOnly,
    from: filters.from,
    to: filters.to,
    q: filters.q,
    cursor: filters.cursor,
    limit: filters.limit,
    envelope: "1"
  });
}

/** Filtros del archivo (§7.4) como query string; siempre `envelope=1`. */
export function documentArchiveQuery(filters: DocumentArchiveFilters = {}): FinanceQuery {
  return compactQuery({
    q: filters.q,
    kind: filters.kind,
    supplierId: filters.supplierId,
    propertyId: filters.propertyId,
    from: filters.from,
    to: filters.to,
    amountMin: filters.amountMin,
    amountMax: filters.amountMax,
    registryNumber: filters.registryNumber,
    includeBlocked: filters.includeBlocked,
    cursor: filters.cursor,
    limit: filters.limit,
    envelope: "1"
  });
}

// ---- Captura (centro) --------------------------------------------------------

/** 201: un `IncomingDocumentRecord` por fichero, ya con nº de registro; la extracción sigue en segundo plano (`extractionStatus pending`). */
export function capture(body: DocumentUploadRequest, propertyId = getActivePropertyId()): Promise<IncomingDocumentRecord[]> {
  return apiRequest<IncomingDocumentRecord[]>(documentListPath(propertyId), { method: "POST", body });
}

/** 201: reverso o anexo del documento (`role` original | derived). */
export function addFile(documentId: string, body: DocumentAddFileRequest, propertyId = getActivePropertyId()): Promise<DocumentFileDto> {
  return apiRequest<DocumentFileDto>(`${documentListPath(propertyId)}/${enc(documentId)}/files`, { method: "POST", body });
}

// ---- Bandeja y detalle -------------------------------------------------------

export function list(filters: DocumentQueueFilters = {}, propertyId = getActivePropertyId()): Promise<DocumentListPage> {
  return apiRequest<DocumentListPage>(documentListPath(propertyId), { query: documentListQuery(filters) });
}

export function get(documentId: string, propertyId = getActivePropertyId()): Promise<IncomingDocumentDetail> {
  return apiRequest<IncomingDocumentDetail>(`${documentListPath(propertyId)}/${enc(documentId)}`);
}

/** Fichero original como Blob (auditado en el servidor); `inline` para abrirlo en el visor. */
export function downloadFile(documentId: string, options: DocumentDownloadOptions = {}, propertyId = getActivePropertyId()): Promise<BlobResponse> {
  return apiRequestBlob(`${documentListPath(propertyId)}/${enc(documentId)}/file`, { query: compactQuery({ inline: options.inline }) });
}

/** Imagen rasterizada de la página `pageNo` (1-based) como Blob; 404 opaco mientras el pipeline no la haya generado. */
export function pageImage(documentId: string, pageNo: number, options: DocumentDownloadOptions = {}, propertyId = getActivePropertyId()): Promise<BlobResponse> {
  return apiRequestBlob(`${documentListPath(propertyId)}/${enc(documentId)}/pages/${enc(String(pageNo))}/image`, { query: compactQuery({ inline: options.inline }) });
}

// ---- Pipeline (clasificación y extracción) -----------------------------------

/** Sin proveedor de IA: `configured:false` y clasificación por reglas; `force` exige proveedor (503 AI_PROVIDER_UNAVAILABLE). */
export function classify(documentId: string, body: DocumentExtractRequest = {}, propertyId = getActivePropertyId()): Promise<DocumentExtractResponse> {
  return apiRequest<DocumentExtractResponse>(`${documentListPath(propertyId)}/${enc(documentId)}/classify`, { method: "POST", body });
}

export function extract(documentId: string, body: DocumentExtractRequest = {}, propertyId = getActivePropertyId()): Promise<DocumentExtractResponse> {
  return apiRequest<DocumentExtractResponse>(`${documentListPath(propertyId)}/${enc(documentId)}/extract`, { method: "POST", body });
}

// ---- Transiciones del centro -------------------------------------------------

/** captured → sent_to_office (409 DOCUMENT_STATUS_TRANSITION en cualquier otro estado). */
export function sendToOffice(documentId: string, propertyId = getActivePropertyId()): Promise<IncomingDocumentRecord> {
  return apiRequest<IncomingDocumentRecord>(`${documentListPath(propertyId)}/${enc(documentId)}/send-to-office`, { method: "POST", body: {} });
}

/** returned_to_centre → captured con un fichero nuevo y el MISMO nº de registro. */
export function recapture(documentId: string, body: DocumentAddFileRequest, propertyId = getActivePropertyId()): Promise<IncomingDocumentRecord> {
  return apiRequest<IncomingDocumentRecord>(`${documentListPath(propertyId)}/${enc(documentId)}/recapture`, { method: "POST", body });
}

/** `POST …/split` (workflow.routes · split-merge.service): el origen (archivado con `mergedIntoId` null) y un trozo por rango, cada uno con registro nuevo. */
export type DocumentSplitResponse = { document: IncomingDocumentRecord; pieces: IncomingDocumentRecord[] };

/** `POST …/merge`: el documento que absorbe y los absorbidos (archived con `mergedIntoId`). */
export type DocumentMergeResponse = { document: IncomingDocumentRecord; absorbed: IncomingDocumentRecord[] };

/** Rangos de páginas 1-based e inclusivos → un documento (registro nuevo) por trozo. */
export function split(documentId: string, body: DocumentSplitRequest, propertyId = getActivePropertyId()): Promise<DocumentSplitResponse> {
  return apiRequest<DocumentSplitResponse>(`${documentListPath(propertyId)}/${enc(documentId)}/split`, { method: "POST", body });
}

/** Absorbe `withIds` en el documento (los absorbidos pasan a archived con `mergedIntoId`). */
export function merge(documentId: string, body: DocumentMergeRequest, propertyId = getActivePropertyId()): Promise<DocumentMergeResponse> {
  return apiRequest<DocumentMergeResponse>(`${documentListPath(propertyId)}/${enc(documentId)}/merge`, { method: "POST", body });
}

// ---- Valija (hoja de remesa) -------------------------------------------------

function dispatchBatchesPath(propertyId: string): string {
  return `${documentListPath(propertyId)}/dispatch-batches`;
}

/** Respuesta de cerrar / recibir la valija (dispatch.service · DispatchBatchResult): el DTO más los números y la ruta de la hoja. */
export type DocumentDispatchBatchResponse = DocumentDispatchBatchDto & {
  registryNumbers: string[];
  /** `GET …/dispatch-batches/:batchId/sheet` (PDF); `dispatchBatches.sheet` la descarga como Blob. */
  sheetDownloadPath: string;
  sheetFileName: string | null;
};

export const dispatchBatches = {
  /** 201: cierra la valija (todos a `in_transit`) y genera la hoja de remesa (`sheetFileId`). */
  create(body: DocumentDispatchBatchRequest, propertyId = getActivePropertyId()): Promise<DocumentDispatchBatchResponse> {
    return apiRequest<DocumentDispatchBatchResponse>(dispatchBatchesPath(propertyId), { method: "POST", body });
  },
  /** La oficina marca lo que llegó (`at_office`); lo que falta sigue `in_transit`. */
  receive(batchId: string, body: DocumentDispatchReceiveRequest, propertyId = getActivePropertyId()): Promise<DocumentDispatchBatchResponse> {
    return apiRequest<DocumentDispatchBatchResponse>(`${dispatchBatchesPath(propertyId)}/${enc(batchId)}/receive`, { method: "POST", body });
  },
  /** PDF de la hoja de remesa como Blob (la pantalla lo abre con openBlob). */
  sheet(batchId: string, options: DocumentDownloadOptions = {}, propertyId = getActivePropertyId()): Promise<BlobResponse> {
    return apiRequestBlob(`${dispatchBatchesPath(propertyId)}/${enc(batchId)}/sheet`, { query: compactQuery({ inline: options.inline }) });
  }
};

// ---- Revisión (oficina) ------------------------------------------------------

/** `assignedTo: null` desasigna. */
export function assign(documentId: string, body: DocumentAssignRequest, propertyId = getActivePropertyId()): Promise<IncomingDocumentRecord> {
  return apiRequest<IncomingDocumentRecord>(`${documentListPath(propertyId)}/${enc(documentId)}/assign`, { method: "POST", body });
}

/** Guarda los campos revisados y el tipo corregido; no ejecuta nada (la ficha completa se relee con `get`). */
export function review(documentId: string, body: DocumentReviewRequest, propertyId = getActivePropertyId()): Promise<IncomingDocumentRecord> {
  return apiRequest<IncomingDocumentRecord>(`${documentListPath(propertyId)}/${enc(documentId)}/review`, { method: "POST", body });
}

/** `POST …/reject` (actions.service): el documento y, si se devolvió al centro, a quién se avisó. */
export type DocumentRejectResponse = { document: IncomingDocumentRecord; notifiedUserId: string | null };

/** `POST …/archive`: el documento archivado con su retención. */
export type DocumentArchiveResponse = { document: IncomingDocumentRecord };

/** Ejecuta la acción propuesta en una transacción (409 SUPPLIER_BILL_DUPLICATE · GOODS_RECEIPT_DUPLICATE · SUPPLIER_BILL_MATCH_REQUIRED; 400 DOCUMENT_CHECKS_FAILED sin `override`). */
export function approve(documentId: string, body: DocumentApproveRequest, propertyId = getActivePropertyId()): Promise<DocumentApproveResponse> {
  return apiRequest<DocumentApproveResponse>(`${documentListPath(propertyId)}/${enc(documentId)}/approve`, { method: "POST", body });
}

/** `returnToCentre` con illegible | missing_pages | other → returned_to_centre; el resto cierra en rejected. */
export function reject(documentId: string, body: DocumentRejectRequest, propertyId = getActivePropertyId()): Promise<DocumentRejectResponse> {
  return apiRequest<DocumentRejectResponse>(`${documentListPath(propertyId)}/${enc(documentId)}/reject`, { method: "POST", body });
}

/** Archiva con retención (por tipo salvo `retentionUntil`), retención ampliada o bloqueo legal. */
export function archiveDocument(documentId: string, body: DocumentArchiveRequest = {}, propertyId = getActivePropertyId()): Promise<DocumentArchiveResponse> {
  return apiRequest<DocumentArchiveResponse>(`${documentListPath(propertyId)}/${enc(documentId)}/archive`, { method: "POST", body });
}

export const actions = {
  /** 201: tarea con plazo sobre el documento (§7.3). */
  create(documentId: string, body: DocumentActionRequest, propertyId = getActivePropertyId()): Promise<DocumentActionDto> {
    return apiRequest<DocumentActionDto>(`${documentListPath(propertyId)}/${enc(documentId)}/actions`, { method: "POST", body });
  },
  update(documentId: string, actionId: string, body: DocumentActionPatchRequest, propertyId = getActivePropertyId()): Promise<DocumentActionDto> {
    return apiRequest<DocumentActionDto>(`${documentListPath(propertyId)}/${enc(documentId)}/actions/${enc(actionId)}`, { method: "PATCH", body });
  }
};

// ---- Organización: cola, archivo, KPIs, ajustes, administración ----------------

/** Cola de la oficina (todos los centros del ámbito R11; `slaBreached` y `dueAt` calculados). */
export function queue(filters: DocumentQueueFilters = {}, organizationId = getActiveOrganizationId()): Promise<DocumentListPage> {
  return apiRequest<DocumentListPage>(documentQueuePath(organizationId), { query: documentListQuery(filters) });
}

export const archive = {
  /** Búsqueda del archivo por texto extraído, tipo, centro, proveedor, fechas, importe o nº de registro. */
  search(filters: DocumentArchiveFilters = {}, organizationId = getActiveOrganizationId()): Promise<DocumentListPage> {
    return apiRequest<DocumentListPage>(documentArchivePath(organizationId), { query: documentArchiveQuery(filters) });
  }
};

export function kpis(query: DocumentKpisQuery, organizationId = getActiveOrganizationId()): Promise<DocumentKpis> {
  return apiRequest<DocumentKpis>(`/organizations/${enc(organizationId)}/documents/kpis`, { query: compactQuery({ from: query.from, to: query.to, propertyId: query.propertyId }) });
}

export const settings = {
  get(organizationId = getActiveOrganizationId()): Promise<DocumentSettingsDto> {
    return apiRequest<DocumentSettingsDto>(`/organizations/${enc(organizationId)}/documents/settings`);
  },
  patch(body: DocumentSettingsPatchRequest, organizationId = getActiveOrganizationId()): Promise<DocumentSettingsDto> {
    return apiRequest<DocumentSettingsDto>(`/organizations/${enc(organizationId)}/documents/settings`, { method: "PATCH", body });
  }
};

function adminActionPath(organizationId: string, documentId: string, action: "block" | "unblock" | "purge"): string {
  return `/organizations/${enc(organizationId)}/documents/${enc(documentId)}/${action}`;
}

/** Retención vencida: invisible salvo `documents.admin` (crítico, auditado). */
export function block(documentId: string, body: DocumentAdminActionRequest, organizationId = getActiveOrganizationId()): Promise<IncomingDocumentRecord> {
  return apiRequest<IncomingDocumentRecord>(adminActionPath(organizationId, documentId, "block"), { method: "POST", body });
}

export function unblock(documentId: string, body: DocumentAdminActionRequest, organizationId = getActiveOrganizationId()): Promise<IncomingDocumentRecord> {
  return apiRequest<IncomingDocumentRecord>(adminActionPath(organizationId, documentId, "unblock"), { method: "POST", body });
}

/** Solo tras `blockedAt` y sin `legalHold` (409 DOCUMENT_LEGAL_HOLD): borra el fichero del almacén, la fila queda con `deletedAt`. */
export function purge(documentId: string, body: DocumentAdminActionRequest, organizationId = getActiveOrganizationId()): Promise<IncomingDocumentRecord> {
  return apiRequest<IncomingDocumentRecord>(adminActionPath(organizationId, documentId, "purge"), { method: "POST", body });
}

/** Superficie agrupada (`documentsApi.capture(…)`), para las pantallas que prefieren el espacio de nombres. */
export const documentsApi = {
  capture,
  addFile,
  list,
  get,
  downloadFile,
  pageImage,
  classify,
  extract,
  sendToOffice,
  recapture,
  split,
  merge,
  dispatchBatches,
  assign,
  review,
  approve,
  reject,
  archiveDocument,
  actions,
  queue,
  archive,
  kpis,
  settings,
  block,
  unblock,
  purge
} as const;
