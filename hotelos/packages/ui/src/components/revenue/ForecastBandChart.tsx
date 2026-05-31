import type { ChartSeries } from "../../charts/chartPrimitive.js";
import { RevenueChartPanel } from "./revenuePrimitives.js";

export function ForecastBandChart(props: { series: ChartSeries[] }) {
  return <RevenueChartPanel title="Forecast confidence chart" series={props.series} type="band" />;
}
