import { ScreenScaffold } from "../ScreenScaffold";

export function RevenueHistoryForecastReport() {
  return (
    <ScreenScaffold
      eyebrow="Detailed report"
      title="History & Forecast Report"
      summary="Classic report table with History, History subtotal, Forecast, Forecast subtotal and Total rows."
      cards={[
        { title: "Columns", metric: "17", status: "matched", body: "Date, Total Occ., Arr. Rooms, Comp Rooms, House Use, Deduct/Non-Deduct Individual and Group, Occ %, Total Revenue, Average Rate, Departures, Day Use, No Show, OOO and Adults/Children." },
        { title: "Aggregation", status: "weighted", body: "Daily, weekly and monthly totals recalculate ADR, occupancy, RevPAR, TRevPAR and GOPPAR from summed base values." },
        { title: "Table controls", status: "planned", body: "Horizontal scroll, compact mode, column picker and export actions are first-class controls." }
      ]}
    />
  );
}
