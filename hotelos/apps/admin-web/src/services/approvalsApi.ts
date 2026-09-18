// Bandeja de aprobaciones (Tanda 8a · L4, design §5.7): the /approvals routes
// consumed by Hoy › Pendientes de aprobación and by the «Pendientes de
// aprobación» card of Mi día. Every call goes through `apiRequest`; the DTO is
// `ApprovalRequestDto` of packages/shared/src/rbac-types.ts.
//
// Routes (apps/api/src/modules/rbac/rbac.routes.ts): GET /approvals
// (authenticated; the service lists what the caller may approve — the
// `*_approve` key of the kind in the property — plus the caller's own
// requests), POST /approvals/:id/approve · /reject (critical; the service
// checks the key, the tier and requester ≠ decider: 409 APPROVAL_SELF_DECISION).

import type { ApprovalKind, ApprovalRequestDto, ApprovalStatus } from "@hotelos/shared";
import { apiRequest } from "./api-client";
import { toArray } from "../utils/toArray";

export type ListApprovalsInput = {
  status?: ApprovalStatus;
  kind?: ApprovalKind;
  /** 1..500 (the API defaults to 200). */
  limit?: number;
};

export async function listApprovals(input: ListApprovalsInput = {}): Promise<ApprovalRequestDto[]> {
  const query: Record<string, string | number | undefined> = { status: input.status, kind: input.kind, limit: input.limit };
  const rows = await apiRequest<unknown>("/approvals", { query });
  return toArray<ApprovalRequestDto>(rows);
}

/**
 * Pending requests of the caller's scope. Who may DECIDE them is the screen's
 * business (`pendingForViewer` of screens/approvals/approvals-helpers.ts — the
 * approve key of the kind in the hotel of the request, never their own, never
 * expired): the badge of the inbox and the card of Mi día share that criterion
 * (corrector 8a · FX-09).
 */
export async function listPendingApprovals(): Promise<ApprovalRequestDto[]> {
  return listApprovals({ status: "pending" });
}

export function approveRequest(id: string, note?: string): Promise<ApprovalRequestDto> {
  return apiRequest<ApprovalRequestDto>(`/approvals/${encodeURIComponent(id)}/approve`, { method: "POST", body: note ? { note } : {} });
}

export function rejectRequest(id: string, note?: string): Promise<ApprovalRequestDto> {
  return apiRequest<ApprovalRequestDto>(`/approvals/${encodeURIComponent(id)}/reject`, { method: "POST", body: note ? { note } : {} });
}
