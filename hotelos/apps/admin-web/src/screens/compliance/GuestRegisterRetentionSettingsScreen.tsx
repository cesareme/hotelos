import { ScreenScaffold } from "../ScreenScaffold";

export function GuestRegisterRetentionSettingsScreen() {
  return (
    <ScreenScaffold
      eyebrow="Privacy and retention"
      title="Guest Register Retention Settings"
      summary="Apply data minimisation, field-level sensitivity, three-year retention from end of service, deletion jobs and audit reports for every sensitive view or export."
      cards={[
        { title: "Three-year retention", status: "ok", body: "Guest register records and authority receipts are retained for 36 months, then deleted or anonymized unless a legal hold applies." },
        { title: "Document images", status: "ok", body: "DNI, passport and TIE images are temporary-only artifacts with zero-day retention and no default storage." },
        { title: "Sensitive access", status: "warn", body: "Document numbers, support numbers, phone, email and payment identifiers require guest_register.view_sensitive and create audit events." }
      ]}
    />
  );
}
