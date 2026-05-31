import { RevenueReportTablePrimitive, type RevenueReportRow } from "./revenuePrimitives.js";

export function RevenueReportTable(props: { rows: RevenueReportRow[]; compact?: boolean }) {
  return <RevenueReportTablePrimitive rows={props.rows} compact={props.compact} />;
}
