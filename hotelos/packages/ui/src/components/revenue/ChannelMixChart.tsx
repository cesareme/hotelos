import type { ChartSeries } from "../../charts/chartPrimitive.js";
import { RevenueChartPanel } from "./revenuePrimitives.js";

export function ChannelMixChart(props: { series: ChartSeries[] }) {
  return <RevenueChartPanel title="Channel mix chart" series={props.series} type="mix" />;
}
