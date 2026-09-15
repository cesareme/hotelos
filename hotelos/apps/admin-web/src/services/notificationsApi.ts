// Frontend client for the per-user notification feed (Tanda 5 · chrome).
//
//   GET  /notifications          → NotificationRecord[] (owned by the session user)
//   POST /notifications/:id/read → NotificationRecord (status flipped to "read")
//
// Both routes are session-scoped (no extra permission), so the toolbar bell can
// poll them for every role. The API keeps the record shape of
// apps/api/src/lib/demo-store.ts (`NotificationRecord`); we mirror it here and
// map it to the Cocoa notification center in the shell.
import { apiRequest } from "./api-client";

export type NotificationType = "compliance" | "maintenance" | "guest_message" | "payment" | "system";

export type NotificationRecord = {
  id: string;
  propertyId: string;
  userId: string;
  type: NotificationType | string;
  title: string;
  body: string;
  status: "unread" | "read";
  createdAt: string;
};

export function listNotifications(options: { signal?: AbortSignal } = {}): Promise<NotificationRecord[]> {
  return apiRequest<NotificationRecord[]>("/notifications", { signal: options.signal });
}

export function markNotificationRead(id: string): Promise<NotificationRecord> {
  return apiRequest<NotificationRecord>(`/notifications/${encodeURIComponent(id)}/read`, { method: "POST", body: {} });
}

/** Unread count of a feed (defensive: unknown statuses count as unread). */
export function countUnread(items: readonly Pick<NotificationRecord, "status">[]): number {
  return items.reduce((total, item) => (item.status === "read" ? total : total + 1), 0);
}
