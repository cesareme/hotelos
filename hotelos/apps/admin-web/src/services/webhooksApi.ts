// Frontend client for the real /webhooks/* endpoints (shipped in P0-1).
import { apiRequest } from "./api-client";

export type WebhookSubscription = {
  id: string;
  developerAppId: string;
  propertyId: string | null;
  eventTypes: string[];
  targetUrl: string;
  active: boolean;
  createdAt: string;
  secretMasked: string | null;
};

export type WebhookDelivery = {
  id: string;
  webhookSubscriptionId: string;
  eventType: string;
  payloadJson: unknown;
  status: string;
  responseStatus: number | null;
  errorMessage: string | null;
  attemptedAt: string;
};

export type WebhookTestResult = {
  delivered: boolean;
  responseStatus: number | null;
  errorMessage: string | null;
};

export async function fetchEventTypes(): Promise<string[]> {
  const r = await apiRequest<{ items: string[] }>("/webhooks/event-types");
  return r.items;
}

export async function listSubscriptions(propertyId?: string): Promise<WebhookSubscription[]> {
  const qs = propertyId ? `?propertyId=${encodeURIComponent(propertyId)}` : "";
  const r = await apiRequest<{ items: WebhookSubscription[] }>(`/webhooks/subscriptions${qs}`);
  return r.items;
}

export function createSubscription(payload: {
  propertyId?: string | null;
  eventTypes: string[];
  targetUrl: string;
}): Promise<WebhookSubscription & { secret: string }> {
  return apiRequest("/webhooks/subscriptions", { method: "POST", body: payload });
}

export function updateSubscription(id: string, payload: Partial<{ eventTypes: string[]; targetUrl: string; active: boolean }>) {
  return apiRequest<WebhookSubscription>(`/webhooks/subscriptions/${id}`, { method: "PATCH", body: payload });
}

export function deleteSubscription(id: string) {
  return apiRequest<{ ok: boolean; id: string }>(`/webhooks/subscriptions/${id}`, { method: "DELETE" });
}

export async function fetchDeliveries(id: string, limit = 50): Promise<WebhookDelivery[]> {
  const r = await apiRequest<{ items: WebhookDelivery[] }>(`/webhooks/subscriptions/${id}/deliveries?limit=${limit}`);
  return r.items;
}

export function testSubscription(id: string): Promise<WebhookTestResult> {
  return apiRequest(`/webhooks/subscriptions/${id}/test`, { method: "POST" });
}
