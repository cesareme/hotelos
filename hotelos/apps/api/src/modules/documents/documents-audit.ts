// Documentos · auditoría (Tanda T9 · lote T9-05a, diseño §9 «Auditoría»).
//
// Envoltorio de recordAuditEvent (modules/audit/audit.service.ts) con las
// acciones del módulo y una forma fija del afterJson: nunca bytes, nunca la
// clave del almacén, nunca el texto extraído ni la nota de captura ni, en el
// correo, el remitente, el asunto o el nombre del adjunto (pueden llevar datos
// personales y la auditoría es inmutable: ni la purga ni executeErasure la
// tocan; SEC-02); solo identificadores (documento, mensaje, adjunto, conexión),
// número de registro, estado, hash y tamaño.

import type { ActorType } from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { recordAuditEvent } from "../audit/audit.service.js";

export const DOCUMENT_AUDIT_ENTITY = "incoming_document";

export const DOCUMENT_AUDIT_ACTIONS = Object.freeze({
  captured: "DOCUMENT_CAPTURED",
  fileAdded: "DOCUMENT_FILE_ADDED",
  sent: "DOCUMENT_SENT",
  downloaded: "DOCUMENT_DOWNLOADED",
  recaptured: "DOCUMENT_RECAPTURED"
} as const);

export type DocumentAuditAction = (typeof DOCUMENT_AUDIT_ACTIONS)[keyof typeof DOCUMENT_AUDIT_ACTIONS];

/** Resumen auditable de un documento (sin texto ni claves). */
export type DocumentAuditSummary = {
  registryNumber: string;
  status: string;
  kind: string;
  sha256: string;
  sizeBytes: number;
  pageCount?: number;
  physicalStatus?: string;
  source?: string;
};

export function documentAuditSummary(row: {
  registryNumber: string;
  status: string;
  kind: string;
  sha256: string;
  sizeBytes: number;
  pageCount?: number;
  physicalStatus?: string;
  source?: string;
}): DocumentAuditSummary {
  return {
    registryNumber: row.registryNumber,
    status: row.status,
    kind: row.kind,
    sha256: row.sha256,
    sizeBytes: row.sizeBytes,
    ...(row.pageCount !== undefined ? { pageCount: row.pageCount } : {}),
    ...(row.physicalStatus !== undefined ? { physicalStatus: row.physicalStatus } : {}),
    ...(row.source !== undefined ? { source: row.source } : {})
  };
}

export type DocumentAuditInput = {
  action: DocumentAuditAction;
  context: Pick<UserContext, "userId" | "deviceId">;
  organizationId: string;
  propertyId: string;
  documentId: string;
  correlationId?: string;
  ipAddress?: string;
  actorType?: ActorType;
  beforeJson?: Record<string, unknown>;
  afterJson?: Record<string, unknown>;
};

/** Una fila de auditoría por acción del módulo; devuelve el id del evento. */
export function auditDocumentEvent(input: DocumentAuditInput): string {
  const event = recordAuditEvent({
    organizationId: input.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: input.actorType ?? "user",
    action: input.action,
    entityType: DOCUMENT_AUDIT_ENTITY,
    entityId: input.documentId,
    ...(input.beforeJson ? { beforeJson: input.beforeJson } : {}),
    ...(input.afterJson ? { afterJson: input.afterJson } : {}),
    ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}),
    ...(input.context.deviceId ? { deviceId: input.context.deviceId } : {}),
    ...(input.correlationId ? { correlationId: input.correlationId } : {})
  });
  return event.id;
}
