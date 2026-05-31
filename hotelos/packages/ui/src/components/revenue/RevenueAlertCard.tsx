import { RevenueAlertCardPrimitive, type RevenueAlert } from "./revenuePrimitives.js";

export function RevenueAlertCard(props: RevenueAlert) {
  return <RevenueAlertCardPrimitive {...props} />;
}
