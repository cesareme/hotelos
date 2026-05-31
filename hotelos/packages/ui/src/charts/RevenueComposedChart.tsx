import { ChartPrimitive, type ChartSeries } from "./chartPrimitive.js";

export function RevenueComposedChart(props: { title?: string; series: ChartSeries[] }) {
  return <ChartPrimitive title={props.title ?? "History vs Forecast"} type="composed" series={props.series} height={210} />;
}
