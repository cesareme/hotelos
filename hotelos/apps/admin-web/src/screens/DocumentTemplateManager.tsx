import { ScreenScaffold } from "./ScreenScaffold";

export function DocumentTemplateManager() {
  return (
    <ScreenScaffold
      eyebrow="Templates"
      title="Document Template Manager"
      summary="Edit booking confirmations, pre-arrival emails, welcome messages, payment requests, invoice emails, check-in forms and owner briefings."
      cards={[
        { title: "Welcome message", status: "ok", body: "Spanish welcome message is active for guest messaging." },
        { title: "Signature form", status: "error", body: "Guest register signature form must be configured for AI Check-in readiness." }
      ]}
    />
  );
}
