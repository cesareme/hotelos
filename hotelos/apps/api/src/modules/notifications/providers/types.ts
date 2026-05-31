// Shared provider contract for notification dispatch (Sprint 26).
//
// Every channel adapter (email, sms, whatsapp) exposes a single async `send`
// function that conforms to this signature. The dispatcher does not care
// which channel it is talking to — it just resolves the right module and
// calls send().

export type ProviderSendInput = {
  recipient: string;
  subject?: string;
  body: string;
};

export type ProviderSendResult = {
  status: "sent" | "failed";
  providerMessageId?: string;
  error?: string;
  /**
   * True when no real provider was configured and the send was a dev no-op.
   * The dispatcher records a note so "sent" is never mistaken for real delivery.
   */
  simulated?: boolean;
};

export type NotificationChannel = "email" | "sms" | "whatsapp";
