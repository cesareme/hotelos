import type { ChartSeries } from "../../charts/chartPrimitive.js";
import { RevenueChartPanel } from "./revenuePrimitives.js";

export function IndividualGroupMixChart(props: { series: ChartSeries[] }) {
  return <RevenueChartPanel title="Individual vs group graph" series={props.series} type="bar" />;
}
