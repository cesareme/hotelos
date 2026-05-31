import { ScrollView, StyleSheet, Text, View } from "react-native";
import {
  ForecastBoundaryMarker,
  ForecastConfidenceBadge,
  HistoryForecastChart,
  RevenueAlertCard,
  RevenueExportButton,
  RevenueFilterBar,
  RevenueGranularitySelector,
  RevenueKpiGrid,
  RevenuePeriodSelector,
  RevenueReportTable
} from "@hotelos/ui";
import type { ChartSeries } from "@hotelos/ui";
import { colors } from "../../theme/colors";

const chartSeries: ChartSeries[] = [
  {
    key: "occupancy",
    label: "Occupancy %",
    points: [
      { label: "01/05", value: 76, section: "history" },
      { label: "15/05", value: 88, section: "history" },
      { label: "16/05", value: 92, section: "forecast", confidenceLow: 86, confidenceHigh: 95 },
      { label: "29/05", value: 36, section: "forecast", confidenceLow: 29, confidenceHigh: 45 },
      { label: "31/05", value: 62, section: "forecast", confidenceLow: 55, confidenceHigh: 68 }
    ]
  }
];

const tableRows = [
  { rowType: "section" as const, label: "History" },
  { rowType: "data" as const, date: "2026-05-01", totalOcc: 38, arrivalRooms: 12, compRooms: 1, houseUseRooms: 1, deductIndividualRooms: 31, nonDeductIndividualRooms: 2, deductGroupRooms: 4, nonDeductGroupRooms: 1, occPercent: 76, totalRevenue: 6280, averageRate: 136, departureRooms: 10, dayUseRooms: 0, noShowRooms: 1, oooRooms: 2, adultsChildren: 72 },
  { rowType: "subtotal" as const, label: "History subtotal", totalOcc: 125, arrivalRooms: 46, compRooms: 1, houseUseRooms: 3, occPercent: 83.33, totalRevenue: 21220, averageRate: 140.18, departureRooms: 37, dayUseRooms: 2, noShowRooms: 2, oooRooms: 6, adultsChildren: 237 },
  { rowType: "section" as const, label: "Forecast" },
  { rowType: "data" as const, date: "2026-05-16", totalOcc: 46, arrivalRooms: 20, compRooms: 0, houseUseRooms: 1, deductIndividualRooms: 36, nonDeductIndividualRooms: 3, deductGroupRooms: 6, nonDeductGroupRooms: 1, occPercent: 92, totalRevenue: 8120, averageRate: 146, departureRooms: 11, dayUseRooms: 1, noShowRooms: 1, oooRooms: 2, adultsChildren: 89 },
  { rowType: "subtotal" as const, label: "Forecast subtotal", totalOcc: 95, arrivalRooms: 36, compRooms: 0, houseUseRooms: 3, occPercent: 63.33, totalRevenue: 15460, averageRate: 134.87, departureRooms: 32, dayUseRooms: 1, noShowRooms: 3, oooRooms: 9, adultsChildren: 182 },
  { rowType: "total" as const, label: "Total", totalOcc: 220, arrivalRooms: 82, compRooms: 1, houseUseRooms: 6, occPercent: 73.33, totalRevenue: 36680, averageRate: 137.52, departureRooms: 69, dayUseRooms: 3, noShowRooms: 5, oooRooms: 15, adultsChildren: 419 }
];

export function RevenueHistoryForecastScreen() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.hero}>
        <Text style={styles.eyebrow}>Revenue Visual Analytics</Text>
        <Text style={styles.title}>History & Forecast</Text>
        <Text style={styles.summary}>Visual-first revenue cockpit with the classic detailed table behind every KPI.</Text>
      </View>
      <View style={styles.selectorRow}>
        <RevenuePeriodSelector fromDate="2026-05-01" toDate="2026-05-31" />
        <RevenueGranularitySelector value="daily" />
        <RevenueExportButton format="PDF" />
      </View>
      <RevenueFilterBar
        filters={[
          { label: "Revenue", value: "net" },
          { label: "Group", value: "all" },
          { label: "OOO", value: "excluded" },
          { label: "Comparison", value: "last year" }
        ]}
      />
      <RevenueKpiGrid
        kpis={[
          { label: "Occupancy %", value: "73.33%", delta: "+6.0 pts", tone: "success" },
          { label: "Room revenue", value: "€28.3k", delta: "+€2.1k", tone: "info" },
          { label: "ADR", value: "€137.52", delta: "-€3.2", tone: "warning" },
          { label: "RevPAR", value: "€94.33", delta: "+€7.4", tone: "success" },
          { label: "GOPPAR", value: "€54.13", forecast: true, tone: "ai" },
          { label: "Forecast confidence", value: "76%", forecast: true, tone: "warning" }
        ]}
      />
      <ForecastBoundaryMarker businessDate="2026-05-15" />
      <HistoryForecastChart series={chartSeries} />
      <ForecastConfidenceBadge value={0.76} drivers={["Booking pace above normal", "Five OOO rooms affect 29/05"]} />
      <RevenueAlertCard severity="warning" title="Low demand date" message="Forecast occupancy for 29/05/2026 is 36%, below target." suggestedAction="Review rate, restrictions and marketing channels." />
      <View style={styles.tabs}>
        {["Overview", "Occupancy", "Revenue", "ADR", "RevPAR", "Arrivals", "Segments", "Channels", "Confidence"].map((tab) => (
          <Text key={tab} style={styles.tab}>{tab}</Text>
        ))}
      </View>
      <RevenueReportTable rows={tableRows} compact />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 18, gap: 16 },
  hero: { backgroundColor: colors.primaryDark, borderRadius: 24, padding: 20, gap: 8 },
  eyebrow: { color: "#c7d2fe", fontWeight: "900", fontSize: 12, letterSpacing: 0 },
  title: { color: "#ffffff", fontWeight: "900", fontSize: 31, letterSpacing: 0 },
  summary: { color: "#dbeafe", fontSize: 16, lineHeight: 23, letterSpacing: 0 },
  selectorRow: { flexDirection: "row", flexWrap: "wrap", gap: 10, alignItems: "center" },
  tabs: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  tab: { color: colors.primary, borderColor: colors.line, borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 7, fontWeight: "900", letterSpacing: 0 }
});
