export type StatusTone = "ok" | "warn" | "info" | "error";

export function StatusPill({ label, tone = "info" }: { label: string; tone?: StatusTone }) {
  return <span className={`gp-pill gp-pill-${tone}`}>{label}</span>;
}
