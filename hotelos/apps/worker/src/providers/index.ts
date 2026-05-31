// Provider registry (worker copy). Mirrors
// apps/api/src/modules/notifications/providers/index.ts.

import * as emailProvider from "./email.provider.js";
import * as smsProvider from "./sms.provider.js";
import * as whatsappProvider from "./whatsapp.provider.js";
import type { NotificationChannel, ProviderSendInput, ProviderSendResult } from "./types.js";

export type ProviderAdapter = {
  send: (input: ProviderSendInput) => Promise<ProviderSendResult>;
};

const REGISTRY: Record<NotificationChannel, ProviderAdapter> = {
  email: emailProvider,
  sms: smsProvider,
  whatsapp: whatsappProvider
};

export function resolveProvider(channel: string): ProviderAdapter {
  const adapter = REGISTRY[channel as NotificationChannel];
  if (!adapter) {
    throw new Error(`Unknown notification channel: ${channel}`);
  }
  return adapter;
}

export type { NotificationChannel, ProviderSendInput, ProviderSendResult } from "./types.js";
