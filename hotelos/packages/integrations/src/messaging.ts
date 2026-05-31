export type MessageChannel = "whatsapp" | "email" | "sms" | "webchat" | "app";

export type GuestMessageDeliveryRequest = {
  messageId: string;
  channel: MessageChannel;
  to: string;
  body: string;
  aiDisclosureIncluded?: boolean;
};

export type GuestMessageDeliveryResult = {
  status: "sent" | "queued" | "failed";
  providerReference?: string;
  errorMessage?: string;
};

export async function sendGuestMessageViaAdapter(
  request: GuestMessageDeliveryRequest
): Promise<GuestMessageDeliveryResult> {
  if (!request.to || !request.body) {
    return { status: "failed", errorMessage: "Recipient and body are required." };
  }

  if (request.channel === "webchat" || request.channel === "app") {
    return { status: "queued", providerReference: `${request.channel}_${request.messageId}` };
  }

  return { status: "sent", providerReference: `${request.channel}_${request.messageId}` };
}
