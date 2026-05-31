import { RevenueExportButtonPrimitive } from "./revenuePrimitives.js";

export function RevenueExportButton(props: { format?: "PDF" | "CSV" | "XLSX" | "JSON"; onPress?: () => void }) {
  return <RevenueExportButtonPrimitive label={`Export ${props.format ?? "PDF"}`} onPress={props.onPress} />;
}
