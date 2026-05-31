import type { ChartSeries } from "../../charts/chartPrimitive.js";
import { RevenueChartPanel } from "./revenuePrimitives.js";

export function RevenueHeatmap(props: { series: ChartSeries[] }) {
  return <RevenueChartPanel title="Occupancy heatmap" series={props.series} type="heatmap" />;
}
