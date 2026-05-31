import { hotelOSTokens } from "../tokens/index.js";
import { ChartPrimitive, type ChartSeries } from "./chartPrimitive.js";

export function OccupancyHeatmap(props: { title?: string; series: ChartSeries[] }) {
  return <ChartPrimitive title={props.title ?? "Occupancy heatmap"} type="heatmap" series={props.series} height={132} />;
}

export const occupancyHeatmapHighDemandColor = hotelOSTokens.color.semantic.warning;
