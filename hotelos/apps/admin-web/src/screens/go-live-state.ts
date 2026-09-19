// Estado PURO de la cabecera de «Salida en vivo» (GoLiveChecklist): tono y
// etiqueta del badge, si se ofrece «Aprobar salida en vivo» y el tono del
// progreso. Corrector L5 (L5F-02): separado de la vista para fijarlo con tests
// (`screens/__tests__/go-live-checklist.test.mts`).
import type { CocoaTone } from "../components/cocoa/cocoa-tones";
import { date, plural } from "../lib/format";
import type { PropertyReadiness, ReadinessCheck } from "../services/billingApi";

export type GoLiveHeadState = {
  /** No hay comprobaciones legibles (403 / red): «Sin calcular». */
  uncalculated: boolean;
  /** Lista para salir en vivo, sin goLiveAt y la sesión puede aprobar. */
  showApprove: boolean;
  tone: CocoaTone;
  label: string;
  progressTone: CocoaTone;
  blocking: ReadinessCheck[];
  passed: number;
};

/** Tanda L5 (lote C): «Aprobar salida en vivo» solo con la propiedad lista y no viva; «En vivo desde …» cuando approveGoLive escribió goLiveAt. */
export function goLiveHeadState(readiness: PropertyReadiness | null | undefined, checks: ReadinessCheck[], canApprove: boolean): GoLiveHeadState {
  const blocking = checks.filter((check) => check.severity === "blocking" && check.status !== "pass");
  const passed = checks.filter((check) => check.status === "pass").length;
  const goLiveAt = readiness?.goLiveAt ?? null;
  const isReady = readiness?.status === "ready";
  const uncalculated = !readiness || checks.length === 0;
  const showApprove = Boolean(readiness) && isReady && !goLiveAt && canApprove;
  const tone: CocoaTone = goLiveAt ? "success" : uncalculated ? "info" : isReady ? "success" : "danger";
  const label = goLiveAt ? `En vivo desde ${date(goLiveAt)}` : uncalculated ? "Sin calcular" : isReady ? "Lista para salir en vivo" : plural(blocking.length, "bloqueante", "bloqueantes");
  const progressTone: CocoaTone = isReady ? "success" : blocking.length > 0 ? "danger" : "warning";
  return { uncalculated, showApprove, tone, label, progressTone, blocking, passed };
}
