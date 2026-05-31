// Provider contract for the worker-side notification dispatcher (Sprint 30).
//
// This mirrors apps/api/src/modules/notifications/providers/types.ts. The
// worker cannot import directly from the API service (it is an application,
// not a publishable package), so we duplicate the small adapter surface here.
// If the contract changes in apps/api it must change here too.

export type ProviderSendInput = {
  recipient: string;
  subject?: string;
  body: string;
};

export type ProviderSendResult = {
  status: "sent" | "failed";
  providerMessageId?: string;
  error?: string;
};

export type NotificationChannel = "email" | "sms" | "whatsapp";
