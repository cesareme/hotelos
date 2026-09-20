// Shared provider contract for notification dispatch (Sprint 26).
//
// Every channel adapter (email, sms, whatsapp) exposes a single async `send`
// function that conforms to this signature. The dispatcher does not care
// which channel it is talking to — it just resolves the right module and
// calls send().

/**
 * Plantilla aprobada por el proveedor (Tanda CHK · W2-D, diseño §2.6). Meta solo
 * admite mensajes libres dentro de la ventana de 24 h abierta por el huésped;
 * fuera de ella (invitación J-3, recordatorio J-1) hay que enviar una plantilla
 * «utility» registrada y aprobada en el WABA del hotel. `name` y `language`
 * son los de Meta; `components` son los parámetros (header/body/buttons) tal
 * cual los espera la Cloud API.
 */
export type ProviderTemplateRef = {
  name: string;
  language: string;
  components?: unknown[];
};

/** Adjunto en base64 (factura, parte de viajeros firmado). */
export type ProviderAttachment = {
  fileName: string;
  mimeType: string;
  base64: string;
};

export type ProviderSendInput = {
  recipient: string;
  subject?: string;
  body: string;
  /**
   * Opcional. Solo el proveedor de WhatsApp lo usa (envía `type: "template"` en
   * lugar de `text`); email y sms lo ignoran.
   */
  template?: ProviderTemplateRef;
  /**
   * Opcional. Hoy ningún proveedor los envía (email/sms/whatsapp los ignoran);
   * el contrato existe para que invoice-email y el parte firmado (Tanda CHK)
   * no tengan que cambiar la firma cuando el proveedor de email los soporte.
   */
  attachments?: ProviderAttachment[];
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
