import { hotelOSTokens } from "../tokens/index.js";
import { ChartPrimitive, type ChartSeries } from "./chartPrimitive.js";

export function RevenueAreaChart(props: { title?: string; series: ChartSeries[] }) {
  return <ChartPrimitive title={props.title ?? "Revenue area chart"} type="area" series={props.series} />;
}

export const revenueAreaChartForecastColor = hotelOSTokens.color.brand.violet;
