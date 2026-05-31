// Public entry for omnichannel messaging adapters.
//
// Usage:
//   import { messagingAdapterFor, sendOmnichannel } from "@hotelos/integrations/messaging";
//   const result = await sendOmnichannel(intent, { whatsapp: cfg1, sms: cfg2, email: cfg3 });
//
// `sendOmnichannel` applies the cascade: try the preferred channel first,
// fall back to the next on transient failures. Permanent failures (e.g. invalid
// number) are reported immediately.

import { whatsapp } from "./whatsapp.adapter.js";
import { twilioSms } from "./twilio-sms.adapter.js";
import { sendgridEmail } from "./sendgrid-email.adapter.js";
import type {
  MessagingAdapter,
  MessageChannel,
  SendMessageIntent,
  SendMessageResult
} from "./types.js";

export type {
  MessagingAdapter,
  MessageChannel,
  MessageRecipient,
  MessageTemplate,
  SendMessageIntent,
  SendMessageResult
} from "./types.js";
export type { WhatsAppConfig } from "./whatsapp.adapter.js";
export type { TwilioConfig } from "./twilio-sms.adapter.js";
export type { SendGridConfig } from "./sendgrid-email.adapter.js";

const ADAPTERS: Record<MessageChannel, MessagingAdapter> = {
  whatsapp,
  sms: twilioSms,
  email: sendgridEmail
};

export function messagingAdapterFor(channel: MessageChannel): MessagingAdapter {
  return ADAPTERS[channel];
}

export type ChannelConfig = Partial<Record<MessageChannel, unknown>>;

/**
 * Send a message using the cascade defined by `cascade` (default:
 * [whatsapp, sms, email] for marketing, [email, sms, whatsapp] for invoices).
 * Stops at the first adapter that returns `sent` or `queued`.
 */
export async function sendOmnichannel(
  intent: SendMessageIntent,
  configs: ChannelConfig,
  cascade: MessageChannel[] = [intent.channel, "whatsapp", "sms", "email"]
): Promise<SendMessageResult & { channelUsed: MessageChannel }> {
  // Dedupe channel order (preferred first, then unique fallbacks).
  const seen = new Set<MessageChannel>();
  const ordered: MessageChannel[] = [];
  for (const c of cascade) {
    if (!seen.has(c)) {
      ordered.push(c);
      seen.add(c);
    }
  }
  let lastFailure: SendMessageResult | null = null;
  for (const channel of ordered) {
    const cfg = configs[channel];
    if (!cfg) continue;
    const adapter = ADAPTERS[channel];
    const channelIntent = { ...intent, channel };
    try {
      const r = await adapter.send(cfg, channelIntent);
      if (r.status === "sent" || r.status === "queued") {
        return { ...r, channelUsed: channel };
      }
      lastFailure = r;
      if (r.status === "failed" && r.permanent) {
        // Permanent failure on a channel that's specifically required is a hard stop.
        if (channel === intent.channel) {
          return { ...r, channelUsed: channel };
        }
      }
    } catch (e) {
      lastFailure = {
        status: "failed",
        reason: e instanceof Error ? e.message : "unknown",
        permanent: false
      };
    }
  }
  return {
    ...(lastFailure ?? { status: "failed" as const, reason: "no adapter configured", permanent: true }),
    channelUsed: intent.channel
  };
}
