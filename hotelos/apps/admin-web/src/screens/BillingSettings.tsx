import { ScreenScaffold } from "./ScreenScaffold";

export function BillingSettings() {
  return (
    <ScreenScaffold
      eyebrow="Invoices"
      title="Billing Settings"
      summary="Configure invoice sequences, simplified and full invoices, rectifying invoices, credit notes, QR payloads, Veri*FACTU mode and B2B formats."
      cards={[
        {
          title: "Billing Center",
          status: "ok",
          body: "Open folios, invoice drafts, issue workflow and reservation balances from one route.",
          actions: [{ label: "Open Billing Center", screen: "BillingCenter" }]
        },
        {
          title: "Invoice sequence",
          status: "error",
          body: "No active sequence is configured. Changing next number requires manager or accountant permission.",
          actions: [{ label: "Configure finance & compliance", screen: "FinanceComplianceSetupForm" }]
        },
        {
          title: "Immutability",
          status: "ok",
          body: "Issued invoices cannot be silently edited; corrections use cancellation, credit note or rectifying invoice.",
          actions: [{ label: "Open billing reports", screen: "ReportingCenter" }]
        }
      ]}
    />
  );
}
