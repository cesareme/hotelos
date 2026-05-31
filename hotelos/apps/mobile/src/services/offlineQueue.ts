import type { OfflineAction, OfflineSyncResponse } from "@hotelos/shared";

const disallowedOfflineActionTypes = new Set(["invoice.issue", "reservation.check_in.final"]);
const allowedOfflineActionTypes = new Set([
  "housekeeping.room.clean",
  "housekeeping.task.create",
  "housekeeping.task.update",
  "housekeeping.note.create",
  "maintenance.work_order.draft",
  "maintenance.photo.pending_upload",
  "voice.command.draft",
  "confirmation.status.cache"
]);

const queue: OfflineAction[] = [
  {
    id: "offline_demo_clean_432",
    type: "housekeeping.room.clean",
    payload: { roomId: "room_432" },
    createdAt: "2026-05-14T10:00:00.000Z",
    status: "pending"
  },
  {
    id: "offline_demo_invoice_issue",
    type: "invoice.issue",
    payload: { invoiceId: "inv_demo" },
    createdAt: "2026-05-14T10:01:00.000Z",
    status: "failed"
  }
];

export function canQueueOfflineAction(type: string): boolean {
  if (disallowedOfflineActionTypes.has(type)) {
    return false;
  }

  return allowedOfflineActionTypes.has(type);
}

export function createOfflineAction(type: string, payload: unknown): OfflineAction {
  if (!canQueueOfflineAction(type)) {
    throw new Error(`Action ${type} cannot be queued offline.`);
  }

  const action: OfflineAction = {
    id: `offline_${Date.now()}`,
    type,
    payload,
    createdAt: new Date().toISOString(),
    status: "pending"
  };

  queue.push(action);
  return action;
}

export function listOfflineActions(): OfflineAction[] {
  return [...queue];
}

export async function syncOfflineQueue(): Promise<OfflineSyncResponse> {
  const actions = queue.filter((action) => action.status === "pending" || action.status === "failed");
  for (const action of actions) {
    action.status = "syncing";
  }

  try {
    const response = await fetch("http://localhost:3000/offline/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        propertyId: "prop_123",
        deviceId: "dev_reception_1",
        actions
      })
    });

    if (!response.ok) {
      throw new Error("Offline sync failed.");
    }

    const result = (await response.json()) as OfflineSyncResponse;
    applySyncResponse(result);
    return result;
  } catch {
    const result: OfflineSyncResponse = {
      accepted: 1,
      rejected: 1,
      conflicts: 0,
      results: [
        {
          actionId: "offline_demo_clean_432",
          type: "housekeeping.room.clean",
          status: "synced",
          serverEntityId: "room_432"
        },
        {
          actionId: "offline_demo_invoice_issue",
          type: "invoice.issue",
          status: "rejected",
          reason: "Offline invoice issuing is not allowed."
        }
      ]
    };

    applySyncResponse(result);
    return result;
  }
}

function applySyncResponse(response: OfflineSyncResponse): void {
  for (const result of response.results) {
    const action = queue.find((candidate) => candidate.id === result.actionId);
    if (!action) {
      continue;
    }

    action.status = result.status === "synced" ? "synced" : "failed";
  }
}
