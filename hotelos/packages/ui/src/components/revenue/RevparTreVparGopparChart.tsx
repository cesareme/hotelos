import type { ChartSeries } from "../../charts/chartPrimitive.js";
import { RevenueChartPanel } from "./revenuePrimitives.js";

export function RevparTreVparGopparChart(props: { series: ChartSeries[] }) {
  return <RevenueChartPanel title="RevPAR / TRevPAR / GOPPAR graph" series={props.series} type="line" />;
}
