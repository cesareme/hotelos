import { RevenueKpiCardPrimitive, type RevenueKpi } from "./revenuePrimitives.js";

export function RevenueKpiCard(props: RevenueKpi) {
  return <RevenueKpiCardPrimitive {...props} />;
}
