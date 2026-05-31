import { RevenueKpiGridPrimitive, type RevenueKpi } from "./revenuePrimitives.js";

export function RevenueKpiGrid(props: { kpis: RevenueKpi[] }) {
  return <RevenueKpiGridPrimitive kpis={props.kpis} />;
}
