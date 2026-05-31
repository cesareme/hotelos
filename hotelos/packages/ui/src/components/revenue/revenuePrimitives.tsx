import type { ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { hotelOSTokens } from "../../tokens/index.js";
import { ChartPrimitive, type ChartSeries } from "../../charts/chartPrimitive.js";

export type RevenueTone = "neutral" | "success" | "warning" | "danger" | "ai" | "info";
export type RevenueKpi = {
  label: string;
  value: string | number;
  delta?: string;
  trend?: "up" | "down" | "flat";
  forecast?: boolean;
  tone?: RevenueTone;
};

export type RevenueAlert = {
  severity: "info" | "warning" | "critical" | "blocking";
  title: string;
  message: string;
  suggestedAction: string;
  date?: string;
};

export type RevenueReportRow = {
  rowType: "section" | "data" | "subtotal" | "total";
  label?: string;
  date?: string;
  totalOcc?: number;
  arrivalRooms?: number;
  compRooms?: number;
  houseUseRooms?: number;
  deductIndividualRooms?: number;
  nonDeductIndividualRooms?: number;
  deductGroupRooms?: number;
  nonDeductGroupRooms?: number;
  occPercent?: number;
  totalRevenue?: number;
  averageRate?: number;
  departureRooms?: number;
  dayUseRooms?: number;
  noShowRooms?: number;
  oooRooms?: number;
  adultsChildren?: number;
};

const tokens = hotelOSTokens;

function toneColor(tone?: RevenueTone) {
  if (tone === "success") return tokens.color.semantic.success;
  if (tone === "warning") return tokens.color.semantic.warning;
  if (tone === "danger") return tokens.color.semantic.danger;
  if (tone === "ai") return tokens.color.brand.violet;
  if (tone === "info") return tokens.color.brand.electricBlue;
  return tokens.color.brand.deepIndigo;
}

export function RevenuePanel(props: { title?: string; subtitle?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <View style={styles.panel}>
      {props.title ? (
        <View style={styles.panelHeader}>
          <View style={styles.titleStack}>
            <Text style={styles.title}>{props.title}</Text>
            {props.subtitle ? <Text style={styles.muted}>{props.subtitle}</Text> : null}
          </View>
          {props.action}
        </View>
      ) : null}
      {props.children}
    </View>
  );
}

export function RevenueKpiCardPrimitive(props: RevenueKpi) {
  const color = toneColor(props.tone);
  return (
    <View style={[styles.kpiCard, { borderLeftColor: color }]} accessible accessibilityLabel={`${props.label}: ${props.value}`}>
      <Text style={styles.kpiLabel}>{props.label}</Text>
      <Text style={styles.kpiValue}>{props.value}</Text>
      <View style={styles.row}>
        {props.delta ? <Text style={[styles.delta, { color }]}>{props.delta}</Text> : null}
        {props.forecast ? <Text style={styles.forecastMarker}>forecast</Text> : null}
      </View>
    </View>
  );
}

export function RevenueKpiGridPrimitive(props: { kpis: RevenueKpi[] }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.kpiGrid}>
      {props.kpis.map((kpi) => (
        <RevenueKpiCardPrimitive key={kpi.label} {...kpi} />
      ))}
    </ScrollView>
  );
}

export function RevenueChartPanel(props: { title: string; series: ChartSeries[]; type: "line" | "area" | "bar" | "composed" | "band" | "mix" | "heatmap" }) {
  return <ChartPrimitive title={props.title} series={props.series} type={props.type} />;
}

export function ForecastConfidenceBadgePrimitive(props: { value: number; drivers?: string[] }) {
  const pct = Math.round(props.value * 100);
  const tone: RevenueTone = pct >= 80 ? "success" : pct >= 70 ? "warning" : "danger";
  return (
    <View style={[styles.badge, { borderColor: toneColor(tone) }]} accessible accessibilityLabel={`Forecast confidence ${pct}%`}>
      <Text style={[styles.badgeText, { color: toneColor(tone) }]}>{pct}% confidence</Text>
      {props.drivers?.slice(0, 2).map((driver) => (
        <Text key={driver} style={styles.badgeDetail}>{driver}</Text>
      ))}
    </View>
  );
}

export function ForecastBoundaryMarkerPrimitive(props: { businessDate: string; historyLabel?: string; forecastLabel?: string }) {
  return (
    <View style={styles.boundary} accessible accessibilityLabel={`History forecast boundary at business date ${props.businessDate}`}>
      <Text style={styles.boundaryText}>{props.historyLabel ?? "History"} &le; {props.businessDate}</Text>
      <View style={styles.boundaryLine} />
      <Text style={styles.boundaryText}>{props.forecastLabel ?? "Forecast"} &gt; {props.businessDate}</Text>
    </View>
  );
}

export function RevenueAlertCardPrimitive(props: RevenueAlert) {
  const tone: RevenueTone = props.severity === "critical" || props.severity === "blocking" ? "danger" : props.severity === "warning" ? "warning" : "info";
  return (
    <View style={[styles.alert, { borderLeftColor: toneColor(tone) }]}>
      <View style={styles.row}>
        <Text style={styles.alertTitle}>{props.title}</Text>
        <Text style={[styles.alertSeverity, { color: toneColor(tone) }]}>{props.severity}</Text>
      </View>
      <Text style={styles.body}>{props.message}</Text>
      <Text style={styles.nextAction}>{props.suggestedAction}</Text>
    </View>
  );
}

export function RevenueReportTablePrimitive(props: { rows: RevenueReportRow[]; compact?: boolean }) {
  const columns = [
    "Date",
    "Total Occ.",
    "Arr. Rooms",
    "Comp. Rooms",
    "House Use",
    "Deduct Indiv.",
    "Non-Ded. Indiv.",
    "Deduct Group",
    "Non-Ded. Group",
    "Occ. %",
    "Total Revenue",
    "Average Rate",
    "Dep. Rooms",
    "Day Use Rooms",
    "No Show Rooms",
    "OOO Rooms",
    "Adl. & Chl."
  ];
  return (
    <ScrollView horizontal>
      <View style={styles.table} accessible accessibilityLabel="Revenue History and Forecast detailed report table">
        <View style={styles.tableRow}>
          {columns.map((column) => (
            <Text key={column} style={styles.tableHead}>{column}</Text>
          ))}
        </View>
        {props.rows.map((row, index) => (
          <View key={`${row.rowType}-${row.date ?? row.label}-${index}`} style={[styles.tableRow, row.rowType !== "data" && styles.tableSummaryRow]}>
            <Text style={styles.tableCell}>{row.label ?? row.date}</Text>
            <Text style={styles.tableCell}>{row.totalOcc ?? ""}</Text>
            <Text style={styles.tableCell}>{row.arrivalRooms ?? ""}</Text>
            <Text style={styles.tableCell}>{row.compRooms ?? ""}</Text>
            <Text style={styles.tableCell}>{row.houseUseRooms ?? ""}</Text>
            <Text style={styles.tableCell}>{row.deductIndividualRooms ?? ""}</Text>
            <Text style={styles.tableCell}>{row.nonDeductIndividualRooms ?? ""}</Text>
            <Text style={styles.tableCell}>{row.deductGroupRooms ?? ""}</Text>
            <Text style={styles.tableCell}>{row.nonDeductGroupRooms ?? ""}</Text>
            <Text style={styles.tableCell}>{row.occPercent?.toFixed?.(2) ?? ""}</Text>
            <Text style={styles.tableCell}>{row.totalRevenue ?? ""}</Text>
            <Text style={styles.tableCell}>{row.averageRate?.toFixed?.(2) ?? ""}</Text>
            <Text style={styles.tableCell}>{row.departureRooms ?? ""}</Text>
            <Text style={styles.tableCell}>{row.dayUseRooms ?? ""}</Text>
            <Text style={styles.tableCell}>{row.noShowRooms ?? ""}</Text>
            <Text style={styles.tableCell}>{row.oooRooms ?? ""}</Text>
            <Text style={styles.tableCell}>{row.adultsChildren ?? ""}</Text>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

export function RevenueSelectorPrimitive(props: { label: string; value: string; options?: string[] }) {
  return (
    <View style={styles.selector}>
      <Text style={styles.kpiLabel}>{props.label}</Text>
      <Text style={styles.selectorValue}>{props.value}</Text>
      {props.options?.length ? <Text style={styles.muted}>{props.options.join(" / ")}</Text> : null}
    </View>
  );
}

export function RevenueFilterBarPrimitive(props: { filters: Array<{ label: string; value: string }> }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterBar}>
      {props.filters.map((filter) => (
        <View key={filter.label} style={styles.filterChip}>
          <Text style={styles.filterLabel}>{filter.label}</Text>
          <Text style={styles.filterValue}>{filter.value}</Text>
        </View>
      ))}
    </ScrollView>
  );
}

export function RevenueExportButtonPrimitive(props: { label?: string; onPress?: () => void }) {
  return (
    <Pressable accessibilityLabel={props.label ?? "Export History and Forecast report"} onPress={props.onPress} style={styles.button}>
      <Text style={styles.buttonText}>{props.label ?? "Export"}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: tokens.color.surface.raised,
    borderRadius: tokens.radius.lg,
    borderWidth: 1,
    borderColor: tokens.color.border.subtle,
    padding: tokens.space.md,
    gap: tokens.space.md
  },
  panelHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: tokens.space.md },
  titleStack: { flex: 1, gap: 4 },
  title: { color: tokens.color.text.primary, fontSize: tokens.font.size.title, fontWeight: "800", letterSpacing: 0 },
  muted: { color: tokens.color.text.muted, fontWeight: "700", letterSpacing: 0 },
  row: { flexDirection: "row", alignItems: "center", gap: tokens.space.sm, justifyContent: "space-between" },
  kpiGrid: { gap: tokens.space.sm, paddingVertical: tokens.space.xs },
  kpiCard: {
    minWidth: 154,
    backgroundColor: tokens.color.surface.raised,
    borderRadius: tokens.radius.md,
    borderWidth: 1,
    borderColor: tokens.color.border.subtle,
    borderLeftWidth: 4,
    padding: tokens.space.md,
    gap: tokens.space.xs
  },
  kpiLabel: { color: tokens.color.text.muted, fontSize: tokens.font.size.caption, fontWeight: "800", letterSpacing: 0 },
  kpiValue: { color: tokens.color.brand.nightBlue, fontSize: 24, fontWeight: "900", letterSpacing: 0 },
  delta: { fontSize: tokens.font.size.caption, fontWeight: "900", letterSpacing: 0 },
  forecastMarker: { color: tokens.color.brand.violet, fontSize: tokens.font.size.caption, fontWeight: "900", letterSpacing: 0 },
  badge: { borderWidth: 1, borderRadius: tokens.radius.md, padding: tokens.space.sm, gap: 3, backgroundColor: tokens.color.surface.base },
  badgeText: { fontWeight: "900", letterSpacing: 0 },
  badgeDetail: { color: tokens.color.text.muted, fontSize: tokens.font.size.caption, letterSpacing: 0 },
  boundary: { flexDirection: "row", alignItems: "center", gap: tokens.space.sm },
  boundaryLine: { height: 1, flex: 1, backgroundColor: tokens.color.brand.violet },
  boundaryText: { color: tokens.color.text.secondary, fontWeight: "800", fontSize: tokens.font.size.caption, letterSpacing: 0 },
  alert: { backgroundColor: tokens.color.surface.base, borderRadius: tokens.radius.md, borderWidth: 1, borderColor: tokens.color.border.subtle, borderLeftWidth: 5, padding: tokens.space.md, gap: tokens.space.xs },
  alertTitle: { color: tokens.color.text.primary, fontWeight: "900", letterSpacing: 0 },
  alertSeverity: { fontSize: tokens.font.size.caption, fontWeight: "900", letterSpacing: 0 },
  body: { color: tokens.color.text.secondary, lineHeight: 21, letterSpacing: 0 },
  nextAction: { color: tokens.color.brand.deepIndigo, fontWeight: "900", letterSpacing: 0 },
  table: { borderWidth: 1, borderColor: tokens.color.border.subtle, borderRadius: tokens.radius.md, overflow: "hidden" },
  tableRow: { flexDirection: "row", backgroundColor: tokens.color.surface.raised },
  tableSummaryRow: { backgroundColor: tokens.color.surface.soft },
  tableHead: { width: 118, padding: tokens.space.sm, color: tokens.color.brand.nightBlue, fontWeight: "900", fontSize: tokens.font.size.caption, letterSpacing: 0 },
  tableCell: { width: 118, padding: tokens.space.sm, color: tokens.color.text.secondary, fontWeight: "700", fontSize: tokens.font.size.caption, letterSpacing: 0 },
  selector: { borderWidth: 1, borderColor: tokens.color.border.subtle, borderRadius: tokens.radius.md, padding: tokens.space.sm, minWidth: 144, backgroundColor: tokens.color.surface.base },
  selectorValue: { color: tokens.color.text.primary, fontWeight: "900", letterSpacing: 0 },
  filterBar: { gap: tokens.space.xs, paddingVertical: tokens.space.xs },
  filterChip: { borderWidth: 1, borderColor: tokens.color.border.subtle, borderRadius: tokens.radius.pill, paddingHorizontal: tokens.space.sm, paddingVertical: tokens.space.xs, backgroundColor: tokens.color.surface.base },
  filterLabel: { color: tokens.color.text.muted, fontSize: 10, fontWeight: "900", letterSpacing: 0 },
  filterValue: { color: tokens.color.text.primary, fontWeight: "900", letterSpacing: 0 },
  button: { minHeight: 44, borderRadius: tokens.radius.pill, backgroundColor: tokens.color.brand.deepIndigo, paddingHorizontal: tokens.space.md, alignItems: "center", justifyContent: "center" },
  buttonText: { color: tokens.color.text.inverse, fontWeight: "900", letterSpacing: 0 }
});
