import { ForecastBoundaryMarkerPrimitive } from "./revenuePrimitives.js";

export function ForecastBoundaryMarker(props: { businessDate: string; historyLabel?: string; forecastLabel?: string }) {
  return <ForecastBoundaryMarkerPrimitive {...props} />;
}
