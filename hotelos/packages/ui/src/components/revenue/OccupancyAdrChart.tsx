import type { ChartSeries } from "../../charts/chartPrimitive.js";
import { RevenueChartPanel } from "./revenuePrimitives.js";

export function OccupancyAdrChart(props: { series: ChartSeries[] }) {
  return <RevenueChartPanel title="Occupancy + ADR chart" series={props.series} type="area" />;
}
