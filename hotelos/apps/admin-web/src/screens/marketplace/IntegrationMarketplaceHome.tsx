import { ScreenScaffold } from "../ScreenScaffold";

export function IntegrationMarketplaceHome() {
  return (
    <ScreenScaffold
      eyebrow="Marketplace"
      title="Marketplace de integraciones"
      summary="Marketplace-first integration surface for channels, OTAs, payments, locks, guest journey, CRM, revenue, housekeeping, accounting, POS, BI, government compliance and AI."
      cards={[
        { title: "Channel Managers", status: "ok", body: "Pooled inventory, ARI sync, reservations import and mapping setup." },
        { title: "OTAs", status: "warn", body: "Booking.com mock connected, Expedia mock needs credential repair, Google Hotels mock is available." },
        { title: "Payments", status: "ok", body: "Demo PSP connected with tokenized payment references." },
        { title: "Government Compliance", status: "warn", body: "SES.HOSPEDAJES file export and service-web placeholder need official schema settings." },
        { title: "AI", status: "warn", body: "OCR provider, tool governance, evaluations and guest-facing disclosure." },
        { title: "Provider card states", status: "ok", body: "Connected, available, needs setup and error states show last sync, capabilities and setup CTA." }
      ]}
    />
  );
}
