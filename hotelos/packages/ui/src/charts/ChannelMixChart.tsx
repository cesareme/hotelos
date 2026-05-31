import { hotelOSTokens } from "../tokens/index.js";
import { ChartPrimitive, type ChartSeries } from "./chartPrimitive.js";

export function ChannelMixChart(props: { title?: string; series: ChartSeries[] }) {
  return <ChartPrimitive title={props.title ?? "Channel mix"} type="mix" series={props.series} />;
}

export const channelMixDirectColor = hotelOSTokens.color.semantic.success;
