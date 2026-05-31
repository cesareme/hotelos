import { RevenueSelectorPrimitive } from "./revenuePrimitives.js";

export function RevenuePeriodSelector(props: { fromDate: string; toDate: string }) {
  return <RevenueSelectorPrimitive label="Period" value={`${props.fromDate} - ${props.toDate}`} options={["Longer than 1 day", "Lower than 12 months"]} />;
}
