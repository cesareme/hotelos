import { ChartPrimitive, type ChartSeries } from "./chartPrimitive.js";

export function MetricSparkline(props: { title?: string; series: ChartSeries[] }) {
  return <ChartPrimitive title={props.title ?? "Metric sparkline"} type="sparkline" series={props.series} height={72} />;
}
