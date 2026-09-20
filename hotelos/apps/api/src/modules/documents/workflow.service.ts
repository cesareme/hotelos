// Documentos · máquina de estados del flujo centro → oficina (Tanda T9 · lote
// T9-08; diseño docs/design/DOCUMENTOS-DIGITALIZACION.md §6.1, tabla de
// transiciones completa).
//
// `TRANSITIONS` codifica la tabla §6.1 celda a celda: estado → acción →
// estado siguiente. Cualquier par (estado, acción) que no esté en la tabla es
// 409 DOCUMENT_STATUS_TRANSITION { from, action } (assertTransition). Las
// acciones con variante llevan la variante en la clave («approve:create_expense»,
// «reject:return_to_centre») porque el estado siguiente depende de ella.
//
// Ejes ortogonales que NO viven aquí (§6.1): extractionStatus, physicalStatus
// (valija, dispatch.service.ts) y las banderas blockedAt / deletedAt (§7.5):
//   · documento bloqueado (blockedAt) → 409 DOCUMENT_BLOCKED para cualquier
//     acción salvo unblock / purge (assertWorkflowAllowed);
//   · purge exige blockedAt y sin legalHold → 409 DOCUMENT_LEGAL_HOLD
//     (assertPurgeAllowed); block / unblock / purge no cambian el status
//     (los ejecuta el lote T9-13).
//
// Adición documentada [S]: `assign` también en `in_review` (reasignar a otra
// persona de la oficina sin salir del estado); la tabla §6.1 lo lista solo
// desde sent_to_office. El resto de celdas es la tabla exacta.
//
// `transitionDocument(tx, id, action, data)` combina assertTransition con
// applyDocumentStatus (UPDATE condicional de documents.service.ts, T9-05a):
// la comprobación en memoria evita la escritura y el UPDATE … WHERE status =
// from protege contra carreras.

import type { IncomingDocument, Prisma } from "@prisma/client";
import type { DocumentProposedAction, IncomingDocumentStatus } from "@hotelos/shared";
import { HttpError } from "../../lib/http-error.js";
import { applyDocumentStatus } from "./documents.service.js";

type Tx = Prisma.TransactionClient;

/** Acciones de la tabla §6.1 (las variantes de approve / reject forman parte de la clave). */
export const DOCUMENT_WORKFLOW_ACTIONS = [
  "send_to_office",
  "archive",
  "split",
  "merge",
  "assign",
  "review",
  "approve:create_supplier_bill",
  "approve:create_expense",
  "approve:create_goods_receipt",
  "approve:create_task",
  "approve:archive",
  "reject:return_to_centre",
  "reject",
  "bill_posted",
  "bill_cancelled",
  "recapture",
  "block",
  "unblock",
  "purge"
] as const;
export type DocumentWorkflowAction = (typeof DOCUMENT_WORKFLOW_ACTIONS)[number];

export type TransitionTable = Readonly<Record<IncomingDocumentStatus, Readonly<Partial<Record<DocumentWorkflowAction, IncomingDocumentStatus>>>>>;

/** Tabla §6.1. Cada celda es un par permitido; todo lo demás es 409 DOCUMENT_STATUS_TRANSITION. */
export const TRANSITIONS: TransitionTable = Object.freeze({
  captured: Object.freeze({
    send_to_office: "sent_to_office",
    // Solo kind letter | contract | other y con documents.review (lo comprueba archiveDocument).
    archive: "archived",
    split: "captured",
    merge: "captured"
  }),
  sent_to_office: Object.freeze({
    assign: "in_review",
    review: "in_review"
  }),
  in_review: Object.freeze({
    assign: "in_review",
    review: "in_review",
    "approve:create_supplier_bill": "approved",
    "approve:create_expense": "posted",
    "approve:create_goods_receipt": "posted",
    "approve:create_task": "archived",
    "approve:archive": "archived",
    "reject:return_to_centre": "returned_to_centre",
    reject: "rejected",
    split: "in_review",
    merge: "in_review"
  }),
  approved: Object.freeze({
    bill_posted: "posted",
    bill_cancelled: "in_review"
  }),
  returned_to_centre: Object.freeze({
    recapture: "captured",
    archive: "rejected"
  }),
  posted: Object.freeze({
    block: "posted",
    unblock: "posted",
    purge: "posted"
  }),
  archived: Object.freeze({
    block: "archived",
    unblock: "archived",
    purge: "archived"
  }),
  rejected: Object.freeze({
    block: "rejected",
    unblock: "rejected",
    purge: "rejected"
  })
});

/** Acciones que no cambian el status (banderas §7.5, lote T9-13). */
export const ADMIN_FLAG_ACTIONS: ReadonlySet<DocumentWorkflowAction> = new Set<DocumentWorkflowAction>(["block", "unblock", "purge"]);

function typed(statusCode: number, code: string, message: string, extra: Record<string, unknown> = {}): HttpError {
  return new HttpError(statusCode, message, true, { code, ...extra });
}

/** Estado siguiente o null cuando el par no está en la tabla. */
export function transitionFor(from: IncomingDocumentStatus, action: DocumentWorkflowAction): IncomingDocumentStatus | null {
  const row = TRANSITIONS[from];
  if (!row) return null;
  const to = row[action];
  return to ?? null;
}

/** Estado siguiente; 409 DOCUMENT_STATUS_TRANSITION { from, action } si el par no está en la tabla. */
export function assertTransition(from: IncomingDocumentStatus, action: DocumentWorkflowAction): IncomingDocumentStatus {
  const to = transitionFor(from, action);
  if (!to) {
    throw typed(409, "DOCUMENT_STATUS_TRANSITION", `La acción «${action}» no es válida en el estado «${from}».`, { from, action });
  }
  return to;
}

/** Clave de la tabla para `approve { action }`. */
export function approveActionOf(action: DocumentProposedAction): DocumentWorkflowAction {
  return `approve:${action}` as DocumentWorkflowAction;
}

/** Clave de la tabla para `reject { returnToCentre }`. */
export function rejectActionOf(returnToCentre: boolean): DocumentWorkflowAction {
  return returnToCentre ? "reject:return_to_centre" : "reject";
}

export type WorkflowRowFlags = Pick<IncomingDocument, "status" | "blockedAt" | "deletedAt" | "legalHold">;

/**
 * Banderas §7.5 antes de cualquier acción: purgado → 404 opaco (la fila ya no
 * tiene fichero); bloqueado → 409 DOCUMENT_BLOCKED salvo unblock / purge.
 */
export function assertWorkflowAllowed(row: WorkflowRowFlags, action: DocumentWorkflowAction): void {
  if (row.deletedAt) throw typed(404, "DOCUMENT_NOT_FOUND", "Documento no encontrado.");
  if (row.blockedAt && action !== "unblock" && action !== "purge") {
    throw typed(409, "DOCUMENT_BLOCKED", "El documento está bloqueado por retención vencida: desbloquéalo antes de actuar sobre él.", { blockedAt: row.blockedAt.toISOString(), action });
  }
}

/** purge solo con blockedAt y sin legalHold (§7.5). */
export function assertPurgeAllowed(row: WorkflowRowFlags): void {
  if (row.deletedAt) throw typed(404, "DOCUMENT_NOT_FOUND", "Documento no encontrado.");
  if (row.legalHold) throw typed(409, "DOCUMENT_LEGAL_HOLD", "El documento está bajo retención legal (legalHold): no se puede purgar.", { action: "purge" });
  if (!row.blockedAt) throw typed(409, "DOCUMENT_STATUS_TRANSITION", "Solo se purga un documento bloqueado por retención vencida.", { from: row.status, action: "purge", reason: "not_blocked" });
  assertTransition(row.status, "purge");
}

/**
 * Transición completa dentro de la transacción del llamante: tabla en memoria
 * (409 con el estado leído) + UPDATE condicional (409 con el estado real si
 * otra petición se adelantó). Devuelve la fila actualizada.
 */
export async function transitionDocument(tx: Tx, row: WorkflowRowFlags & { id: string }, action: DocumentWorkflowAction, data?: Prisma.IncomingDocumentUpdateManyMutationInput): Promise<IncomingDocument> {
  assertWorkflowAllowed(row, action);
  const to = assertTransition(row.status, action);
  return applyDocumentStatus(tx, row.id, { from: row.status, action, to, ...(data ? { data } : {}) });
}

/** Pares permitidos como lista plana (tests y documentación). */
export function listTransitions(): Array<{ from: IncomingDocumentStatus; action: DocumentWorkflowAction; to: IncomingDocumentStatus }> {
  const out: Array<{ from: IncomingDocumentStatus; action: DocumentWorkflowAction; to: IncomingDocumentStatus }> = [];
  for (const from of Object.keys(TRANSITIONS) as IncomingDocumentStatus[]) {
    for (const [action, to] of Object.entries(TRANSITIONS[from]) as Array<[DocumentWorkflowAction, IncomingDocumentStatus]>) {
      out.push({ from, action, to });
    }
  }
  return out;
}
