import { hotelOSTokens } from "../tokens/index.js";
import { ChartPrimitive, type ChartSeries } from "./chartPrimitive.js";

export function RevenueLineChart(props: { title?: string; series: ChartSeries[] }) {
  return <ChartPrimitive title={props.title ?? "Revenue line chart"} type="line" series={props.series} />;
}

export const revenueLineChartDefaultColor = hotelOSTokens.color.brand.electricBlue;
