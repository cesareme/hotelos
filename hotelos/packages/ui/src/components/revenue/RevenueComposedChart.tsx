import type { ChartSeries } from "../../charts/chartPrimitive.js";
import { RevenueChartPanel } from "./revenuePrimitives.js";

export function RevenueComposedChart(props: { series: ChartSeries[] }) {
  return <RevenueChartPanel title="Revenue and occupancy comparison" series={props.series} type="composed" />;
}
