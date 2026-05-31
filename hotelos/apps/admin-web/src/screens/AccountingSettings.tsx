import { ScreenScaffold } from "./ScreenScaffold";

export function AccountingSettings() {
  return (
    <ScreenScaffold
      eyebrow="ERP"
      title="Accounting Settings"
      summary="Select chart template, fiscal year, revenue accounts, tax accounts, payment accounts, supplier accounts, cost centers and close support."
      cards={[
        {
          title: "Chart template",
          status: "ok",
          body: "Spanish PGC hospitality template is selected.",
          actions: [{ label: "Finance & compliance setup", screen: "FinanceComplianceSetupForm" }]
        },
        {
          title: "Cost allocation",
          status: "ok",
          body: "Rooms, maintenance, housekeeping, administration, sales, events and capex can be mapped as cost centers.",
          actions: [{ label: "Departments setup", screen: "DepartmentSetupForm" }]
        },
        {
          title: "AR · AP · Cash position",
          status: "ok",
          body: "Live read of receivables aging, payables aging, cash on hand and month collected.",
          actions: [{ label: "Open Finance position dashboard", screen: "FinancePositionDashboard" }]
        }
      ]}
    />
  );
}
