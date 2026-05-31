import { RevenueSelectorPrimitive } from "./revenuePrimitives.js";

export function RevenueGranularitySelector(props: { value: "daily" | "weekly" | "monthly" | "auto" }) {
  return <RevenueSelectorPrimitive label="Granularity" value={props.value} options={["daily", "weekly", "monthly"]} />;
}
