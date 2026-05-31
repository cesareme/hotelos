import type { ChartSeries } from "../../charts/chartPrimitive.js";
import { RevenueChartPanel } from "./revenuePrimitives.js";

export function ArrivalsDeparturesChart(props: { series: ChartSeries[] }) {
  return <RevenueChartPanel title="Arrivals and departures graph" series={props.series} type="bar" />;
}
