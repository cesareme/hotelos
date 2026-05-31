import { RevenueFilterBarPrimitive } from "./revenuePrimitives.js";

export function RevenueFilterBar(props: { filters: Array<{ label: string; value: string }> }) {
  return <RevenueFilterBarPrimitive filters={props.filters} />;
}
