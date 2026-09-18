// Pure helpers of Hoy › Pendientes de aprobación (Tanda 8a · L4, design §4.7
// / §5.7). No React, no window: covered by __tests__/approvals-helpers.test.mts.
//
//   - Spanish labels of the kinds, statuses and tiers of ApprovalRequestDto;
//   - `decisionFor`: what the signed-in user may do with a request — approve /
//     reject when they hold the `*_approve` key of the kind (APPROVAL_KIND_PERMISSION)
//     and did not request it themselves (dynamic SoD: the API answers 409
//     APPROVAL_SELF_DECISION, the screen explains it before);
//   - `hasApprovalKeys`: whether a profile approves anything at all (the
//     «Pendientes de aprobación» card of Mi día, design §4.9);
//   - `secondApproverNote`: the second signature above T4 (§4.7);
//   - `approvalErrorMessage`: Spanish message of a failed decision.

import {
  APPROVAL_KIND_PERMISSION,
  APPROVAL_KINDS,
  APPROVAL_STATUSES,
  RBAC_ERROR_MESSAGES_ES,
  type ApprovalKind,
  type ApprovalRequestDto,
  type ApprovalStatus,
  type ThresholdTier
} from "@hotelos/shared";

/** Shape of the error `apiRequest` throws (services/api-client.ts ApiError), read structurally so this pure module never loads the client. */
export type ApiErrorLike = { status: number; message?: string; details?: unknown };

export function isApiErrorLike(error: unknown): error is ApiErrorLike {
  return typeof error === "object" && error !== null && typeof (error as { status?: unknown }).status === "number";
}

export const APPROVAL_KIND_LABELS_ES: Record<ApprovalKind, string> = {
  refund: "Reembolso",
  folio_adjust: "Ajuste de folio",
  discount: "Descuento en reserva",
  rate_change: "Cambio de tarifa",
  supplier_bill: "Factura de proveedor",
  purchase_order: "Pedido de compra",
  payroll: "Nómina",
  capex: "CAPEX",
  invoice_cancel: "Anulación de factura",
  day_reopen: "Reapertura del día"
};

export const APPROVAL_STATUS_LABELS_ES: Record<ApprovalStatus, string> = {
  pending: "Pendiente",
  approved: "Aprobada",
  rejected: "Rechazada",
  expired: "Caducada"
};

export const THRESHOLD_TIER_LABELS_ES: Record<ThresholdTier, string> = {
  T1: "T1 · operativo (con motivo)",
  T2: "T2 · supervisión",
  T3: "T3 · dirección de hotel",
  T4: "T4 · dirección financiera / operaciones",
  ABOVE_T4: "Más de T4 · dirección general y propiedad"
};

/** Options of the kind filter (every kind, in catalogue order). */
export const KIND_FILTER_OPTIONS: ReadonlyArray<{ value: ApprovalKind; label: string }> = APPROVAL_KINDS.map((kind) => ({ value: kind, label: APPROVAL_KIND_LABELS_ES[kind] }));

/** Options of the status filter (every status, in lifecycle order). */
export const STATUS_FILTER_OPTIONS: ReadonlyArray<{ value: ApprovalStatus; label: string }> = APPROVAL_STATUSES.map((status) => ({ value: status, label: APPROVAL_STATUS_LABELS_ES[status] }));

export function isApprovalKind(value: unknown): value is ApprovalKind {
  return typeof value === "string" && (APPROVAL_KINDS as readonly string[]).includes(value);
}

export function isApprovalStatus(value: unknown): value is ApprovalStatus {
  return typeof value === "string" && (APPROVAL_STATUSES as readonly string[]).includes(value);
}

/** The key that approves a kind (checker). */
export function approvingKeyOf(kind: ApprovalKind): string {
  return APPROVAL_KIND_PERMISSION[kind];
}

/** True when the profile holds at least one approval key (`*.approve` or `*_approve`): Mi día paints the card (§4.9). */
export function hasApprovalKeys(grantedPermissions: readonly string[] | null | undefined): boolean {
  return (grantedPermissions ?? []).some((key) => /(\.approve|_approve)$/.test(key));
}

export type ApprovalDecisionAbility = {
  /** The user may approve (holds the key of the kind, is not the requester, the request is pending). */
  canApprove: boolean;
  /** The user may reject (same conditions: rejecting is a decision too). */
  canReject: boolean;
  /** The user requested it: no decision buttons, and the reason is explained. */
  own: boolean;
  /** Spanish reason when neither button is offered (null when they are). */
  reason: string | null;
};

export type ApprovalViewer = {
  userId: string | null;
  /** Grants of the ACTIVE property (fallback when the request's hotel is unknown or not in `permissionsByProperty`). */
  grantedPermissions: readonly string[] | null | undefined;
  isPlatformAdmin: boolean;
  /**
   * Corrector 8a (FX-09): grants per property (`GET /users/me` →
   * `properties[].grantedPermissions`). A request of hotel B is decided with
   * the keys held in B, not with the keys of the hotel active in the shell.
   */
  permissionsByProperty?: Readonly<Record<string, readonly string[]>>;
};

/** Keys the viewer holds in the hotel of the request (the active property's when the hotel is unknown). */
export function permissionsForRequest(request: Pick<ApprovalRequestDto, "propertyId">, viewer: ApprovalViewer): readonly string[] {
  if (request.propertyId && viewer.permissionsByProperty && request.propertyId in viewer.permissionsByProperty) return viewer.permissionsByProperty[request.propertyId] ?? [];
  return viewer.grantedPermissions ?? [];
}

/** What the viewer may do with a request (the API repeats every check: this only decides what to paint). */
export function decisionFor(request: ApprovalRequestDto, viewer: ApprovalViewer): ApprovalDecisionAbility {
  const own = viewer.userId !== null && request.requestedByUserId === viewer.userId;
  if (own) return { canApprove: false, canReject: false, own: true, reason: `${RBAC_ERROR_MESSAGES_ES.APPROVAL_SELF_DECISION} Otra persona con la clave «${approvingKeyOf(request.kind)}» debe decidirla.` };
  if (request.status !== "pending") return { canApprove: false, canReject: false, own: false, reason: `Solicitud ${APPROVAL_STATUS_LABELS_ES[request.status].toLowerCase()}: ya no admite decisión.` };
  const key = approvingKeyOf(request.kind);
  const holds = viewer.isPlatformAdmin || permissionsForRequest(request, viewer).includes(key);
  if (!holds) return { canApprove: false, canReject: false, own: false, reason: `Decidirla exige la clave «${key}» en el hotel de la solicitud.` };
  if (request.requiresSecondApproval && request.decidedByUserId !== null && request.decidedByUserId === viewer.userId) {
    return { canApprove: false, canReject: false, own: false, reason: "Ya diste la primera aprobación: la segunda debe darla otra persona (dirección general o propiedad)." };
  }
  return { canApprove: true, canReject: true, own: false, reason: null };
}

/** Second signature above T4 (§4.7): who gave the first one and who must give the second. */
export function secondApproverNote(request: ApprovalRequestDto): string | null {
  if (!request.requiresSecondApproval) return null;
  if (request.secondApproverUserId) return "Segunda aprobación registrada.";
  if (request.decidedByUserId && request.status === "pending") return "Primera aprobación dada; falta la segunda de dirección general o propiedad.";
  return "Importe por encima de T4: exige dos aprobaciones (dirección general y dirección financiera o propiedad).";
}

/** True when the request already passed its expiry instant (the API expires them lazily). */
export function isExpired(request: Pick<ApprovalRequestDto, "expiresAt" | "status">, now: Date = new Date()): boolean {
  if (request.status !== "pending") return request.status === "expired";
  const at = Date.parse(request.expiresAt);
  return Number.isFinite(at) && at < now.getTime();
}

export type ApprovalFilters = { status: ApprovalStatus | ""; kind: ApprovalKind | "" };

/** Client-side filter over the loaded list (the API also filters by status and kind on request). */
export function filterApprovals(rows: readonly ApprovalRequestDto[], filters: ApprovalFilters): ApprovalRequestDto[] {
  return rows.filter((row) => (filters.status === "" || row.status === filters.status) && (filters.kind === "" || row.kind === filters.kind));
}

/** Pending requests the viewer may decide (the badge of the page and the card of Mi día share this criterion). */
export function pendingForViewer(rows: readonly ApprovalRequestDto[], viewer: ApprovalViewer): ApprovalRequestDto[] {
  return rows.filter((row) => row.status === "pending" && !isExpired(row) && decisionFor(row, viewer).canApprove);
}

/** Viewer of a session profile: the grants of every property plus the active one (pure; used by the inbox and Mi día). */
export function viewerFromProfile(input: { userId: string | null; isPlatformAdmin: boolean; grantedPermissions: readonly string[] | null | undefined; properties?: ReadonlyArray<{ id: string; grantedPermissions?: readonly string[] | null }> | null }): ApprovalViewer {
  const permissionsByProperty: Record<string, readonly string[]> = {};
  for (const property of input.properties ?? []) {
    if (Array.isArray(property.grantedPermissions)) permissionsByProperty[property.id] = property.grantedPermissions;
  }
  return { userId: input.userId, isPlatformAdmin: input.isPlatformAdmin, grantedPermissions: input.grantedPermissions, permissionsByProperty };
}

/** Spanish message of a failed approve / reject: the catalogue message of `details.code`, then the API message. */
export function approvalErrorMessage(error: unknown, fallback = "No se ha podido registrar la decisión."): string {
  if (isApiErrorLike(error)) {
    const details = error.details;
    const code = typeof details === "object" && details !== null ? (details as { code?: unknown }).code : null;
    if (typeof code === "string" && code in RBAC_ERROR_MESSAGES_ES) return RBAC_ERROR_MESSAGES_ES[code as keyof typeof RBAC_ERROR_MESSAGES_ES];
    if (code === "APPROVAL_ALREADY_DECIDED") return "La solicitud ya está decidida.";
    if (error.status === 403) return "No tienes permiso para decidir esta solicitud.";
    return error.message || fallback;
  }
  return error instanceof Error && error.message ? error.message : fallback;
}
