import { ForecastConfidenceBadgePrimitive } from "./revenuePrimitives.js";

export function ForecastConfidenceBadge(props: { value: number; drivers?: string[] }) {
  return <ForecastConfidenceBadgePrimitive value={props.value} drivers={props.drivers} />;
}
