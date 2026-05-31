import { hotelOSTokens } from "../tokens/index.js";
import { ChartPrimitive, type ChartSeries } from "./chartPrimitive.js";

export function RevenueBarChart(props: { title?: string; series: ChartSeries[] }) {
  return <ChartPrimitive title={props.title ?? "Revenue bar chart"} type="bar" series={props.series} />;
}

export const revenueBarChartColor = hotelOSTokens.color.semantic.success;
