// Omnichannel messaging adapter contract.
//
// Soporta los 3 canales que un hotel necesita en 2026:
//   - WhatsApp Business Cloud API (Meta)
//   - SMS (Twilio o cualquier proveedor compatible)
//   - Email (SMTP, SendGrid, AWS SES)
//
// La capa superior decide qué canal usar según GuestPreference.channelPreferred,
// con fallback en cascada si el primario falla (typing rate-limit o número
// no válido). Cada adapter implementa un contrato común para que el routing
// no se ate a un proveedor.

export type MessageChannel = "whatsapp" | "sms" | "email";

export type MessageRecipient = {
  /** Destination identifier — phone (E.164) for whatsapp/sms, email for email. */
  to: string;
  /** Optional friendly name. */
  name?: string;
  /** ISO 639-1 language hint, e.g. "es", "en". */
  language?: string;
};

export type MessageTemplate = {
  /** Template name registered with the provider (WhatsApp/Meta uses these). */
  templateName: string;
  /** Variables that fill the template placeholders, in order. */
  variables: string[];
};

export type SendMessageIntent = {
  idempotencyKey: string;
  channel: MessageChannel;
  recipient: MessageRecipient;
  /** Plain text body (used for SMS always, fallback for WhatsApp/Email). */
  body: string;
  /** Optional template (mandatory for WhatsApp outside the 24-hour service window). */
  template?: MessageTemplate;
  /** Email-only: subject + optional HTML body. */
  subject?: string;
  htmlBody?: string;
  /** Optional file URLs to attach (email + WhatsApp media). */
  attachmentUrls?: string[];
};

export type SendMessageResult =
  | { status: "sent"; providerMessageId: string; sentAt: string }
  | { status: "queued"; providerMessageId: string; scheduledFor: string }
  | { status: "failed"; reason: string; permanent: boolean };

export interface MessagingAdapter {
  channel: MessageChannel;
  providerCode: string;
  validateConfig(config: unknown): { ok: true } | { ok: false; reason: string };
  send(config: unknown, intent: SendMessageIntent): Promise<SendMessageResult>;
  verifyWebhook(payload: string, headers: Record<string, string>, secret: string): boolean;
}
