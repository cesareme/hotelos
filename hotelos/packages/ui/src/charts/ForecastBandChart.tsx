import { hotelOSTokens } from "../tokens/index.js";
import { ChartPrimitive, type ChartSeries } from "./chartPrimitive.js";

export function ForecastBandChart(props: { title?: string; series: ChartSeries[] }) {
  return <ChartPrimitive title={props.title ?? "Forecast confidence band"} type="band" series={props.series} />;
}

export const forecastBandColor = hotelOSTokens.color.status.ai;
