import { ScreenScaffold } from "../ScreenScaffold";

export function GuestRegisterFieldMappingScreen() {
  return (
    <ScreenScaffold
      eyebrow="Legal schema mapping"
      title="Guest Register Field Mapping"
      summary="Map PMS, guest, reservation, payment and legal-profile fields to the configured authority schema without inventing missing data."
      cards={[
        { title: "Required fields", status: "ok", body: "Name, surname, document, nationality, birth date, residence, contact, traveller count, contract reference and check-in time are validated before submission." },
        { title: "Conditional fields", status: "warn", body: "Support number, second surname, phone/email and payment fields depend on document type, nationality and official schema configuration." },
        { title: "Payment minimisation", status: "ok", body: "The mapping stores PSP token/reference, holder, payment type and last safe identifiers, never CVV or full PAN." }
      ]}
    />
  );
}
