import { StyleSheet, Text, View } from "react-native";
import { hotelOSTokens } from "../tokens/index.js";

export type ChartPoint = {
  label: string;
  value: number;
  section?: "history" | "forecast";
  confidenceLow?: number;
  confidenceHigh?: number;
};

export type ChartSeries = {
  key: string;
  label: string;
  color?: string;
  points: ChartPoint[];
};

export function ChartPrimitive(props: {
  title: string;
  type: "line" | "area" | "bar" | "composed" | "band" | "sparkline" | "mix" | "heatmap";
  series: ChartSeries[];
  height?: number;
  emptyLabel?: string;
}) {
  const tokens = hotelOSTokens;
  const max = Math.max(1, ...props.series.flatMap((series) => series.points.map((point) => point.value)));
  const firstSeries = props.series[0];
  return (
    <View style={styles.card} accessible accessibilityLabel={`${props.title} ${props.type} chart`}>
      <View style={styles.header}>
        <Text style={styles.title}>{props.title}</Text>
        <Text style={styles.meta}>{props.type}</Text>
      </View>
      {props.series.length === 0 ? <Text style={styles.empty}>{props.emptyLabel ?? "No chart data available."}</Text> : null}
      <View style={[styles.canvas, { height: props.height ?? 172 }]}>
        {firstSeries?.points.map((point, index) => {
          const height = Math.max(8, (point.value / max) * 100);
          const isForecast = point.section === "forecast";
          return (
            <View style={styles.barSlot} key={`${firstSeries.key}-${point.label}-${index}`}>
              <View
                style={[
                  styles.bar,
                  {
                    height: `${height}%`,
                    backgroundColor: firstSeries.color ?? tokens.color.brand.electricBlue,
                    opacity: isForecast ? 0.52 : 0.94,
                    borderStyle: isForecast ? "dashed" : "solid"
                  }
                ]}
              />
            </View>
          );
        })}
      </View>
      <View style={styles.legend}>
        {props.series.map((series) => (
          <View key={series.key} style={styles.legendItem}>
            <View style={[styles.dot, { backgroundColor: series.color ?? tokens.color.brand.electricBlue }]} />
            <Text style={styles.legendText}>{series.label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: hotelOSTokens.color.surface.raised,
    borderColor: hotelOSTokens.color.border.subtle,
    borderWidth: 1,
    borderRadius: hotelOSTokens.radius.lg,
    padding: hotelOSTokens.space.md,
    gap: hotelOSTokens.space.sm
  },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: hotelOSTokens.space.sm },
  title: { color: hotelOSTokens.color.text.primary, fontSize: hotelOSTokens.font.size.bodyLarge, fontWeight: "800", letterSpacing: 0 },
  meta: { color: hotelOSTokens.color.text.muted, fontSize: hotelOSTokens.font.size.caption, fontWeight: "800", letterSpacing: 0 },
  canvas: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 4,
    backgroundColor: hotelOSTokens.color.surface.soft,
    borderRadius: hotelOSTokens.radius.md,
    padding: hotelOSTokens.space.sm
  },
  barSlot: { flex: 1, height: "100%", justifyContent: "flex-end" },
  bar: { width: "100%", minHeight: 8, borderRadius: hotelOSTokens.radius.xs, borderWidth: 1, borderColor: "rgba(255,255,255,0.55)" },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: hotelOSTokens.space.sm },
  legendItem: { flexDirection: "row", alignItems: "center", gap: hotelOSTokens.space.xs },
  dot: { width: 9, height: 9, borderRadius: hotelOSTokens.radius.pill },
  legendText: { color: hotelOSTokens.color.text.secondary, fontSize: hotelOSTokens.font.size.caption, fontWeight: "700", letterSpacing: 0 },
  empty: { color: hotelOSTokens.color.text.muted, fontWeight: "700", letterSpacing: 0 }
});
