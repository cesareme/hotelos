// Provider registry. Resolves a channel name to its adapter module.
//
// The dispatcher uses `resolveProvider(channel).send(…)`; this indirection
// keeps the channel→adapter mapping in one place and makes it easy to swap a
// real implementation (Postmark / Twilio / Meta) in for the stubs.

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
