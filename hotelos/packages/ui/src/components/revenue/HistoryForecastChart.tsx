import type { ChartSeries } from "../../charts/chartPrimitive.js";
import { RevenueChartPanel } from "./revenuePrimitives.js";

export function HistoryForecastChart(props: { series: ChartSeries[] }) {
  return <RevenueChartPanel title="Main History vs Forecast chart" series={props.series} type="composed" />;
}
