// Estado PURO de la sección «Preparación y salida en vivo» del Setup Center
// (SetupCenterScreen · Tanda L5 lote C). Corrector L5:
//   · L5F-02: separado de la vista para fijarlo con tests (`__tests__/launch-readiness.test.mts`);
//   · L5F-05: el fallo del GET …/readiness se distingue del de los pasos — con la
//     preparación ilegible las cifras de comprobaciones / bloqueantes no se muestran
//     como «0» sino como no disponibles, con el aviso;
//   · L5F-06: las etiquetas de los pasos vienen del API (`step.label`, SETUP_STEP_LABELS
//     de backoffice.service.ts); aquí solo el fallback al código.
import type { CocoaTone } from "../../components/cocoa/cocoa-tones";
import { date, dateTime, plural } from "../../lib/format";
import type { PropertySetupProgress, PropertySetupStep } from "../../services/backofficeApi";
import type { PropertyReadiness, ReadinessCheck } from "../../services/billingApi";

export type LaunchState = {
  readiness: PropertyReadiness | null;
  progress: PropertySetupProgress | null;
  loading: boolean;
  /** Error del GET …/readiness (aunque los pasos hayan cargado). */
  readinessError: string | null;
  /** Error del GET …/setup (aunque la preparación haya cargado). */
  progressError: string | null;
};

export const LAUNCH_STATE_LOADING: LaunchState = { readiness: null, progress: null, loading: true, readinessError: null, progressError: null };

const DEFAULT_READINESS_ERROR = "No se pudo leer el estado de preparación de la propiedad.";
const DEFAULT_PROGRESS_ERROR = "No se pudieron leer los pasos de la puesta en marcha.";

function reasonMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

/** Estado a partir de los dos GET (allSettled): cada fallo se guarda por separado. */
export function launchStateFromResults(readinessResult: PromiseSettledResult<PropertyReadiness>, progressResult: PromiseSettledResult<PropertySetupProgress>): LaunchState {
  return {
    readiness: readinessResult.status === "fulfilled" ? readinessResult.value : null,
    progress: progressResult.status === "fulfilled" ? progressResult.value : null,
    loading: false,
    readinessError: readinessResult.status === "rejected" ? reasonMessage(readinessResult.reason, DEFAULT_READINESS_ERROR) : null,
    progressError: progressResult.status === "rejected" ? reasonMessage(progressResult.reason, DEFAULT_PROGRESS_ERROR) : null
  };
}

export const SETUP_STEP_STATUS_LABELS: Readonly<Record<PropertySetupStep["status"], string>> = Object.freeze({
  not_started: "Sin empezar",
  in_progress: "En curso",
  completed: "Completado",
  blocked: "Bloqueado",
  needs_review: "Revisar"
});

export function setupStepTone(status: PropertySetupStep["status"]): CocoaTone {
  if (status === "completed") return "success";
  if (status === "blocked") return "danger";
  if (status === "in_progress" || status === "needs_review") return "warning";
  return "neutral";
}

/** Etiqueta del paso: la del API (SETUP_STEP_LABELS) y, si falta, el código. */
export function setupStepLabel(step: Pick<PropertySetupStep, "stepCode" | "label">): string {
  return step.label?.trim() || step.stepCode;
}

/** Badge de la sección: en vivo · lista · N bloqueantes · sin datos. */
export function launchBadge(readiness: PropertyReadiness | null, progress: PropertySetupProgress | null): { label: string; tone: CocoaTone } {
  const goLiveAt = readiness?.goLiveAt ?? progress?.goLiveAt ?? null;
  if (goLiveAt) return { label: `En vivo desde ${date(goLiveAt)}`, tone: "success" };
  if (!readiness) return { label: "Preparación sin datos", tone: "info" };
  if (readiness.status === "ready") return { label: "Lista para salir en vivo", tone: "success" };
  return { label: plural(readiness.blockingCount, "comprobación bloqueante", "comprobaciones bloqueantes"), tone: "danger" };
}

export type LaunchSectionView = {
  kind: "loading" | "unavailable" | "ready";
  /** Solo la preparación falló (los pasos cargaron): cifras de comprobaciones no disponibles + aviso. */
  readinessUnavailable: boolean;
  /** Solo los pasos fallaron (la preparación cargó). */
  progressUnavailable: boolean;
  /** Mensaje del aviso cuando algo falló y hay algo que mostrar. */
  warning: string | null;
  badge: { label: string; tone: CocoaTone };
  goLiveAt: string | null;
  blockers: ReadinessCheck[];
  pendingSteps: PropertySetupStep[];
  stepsDone: number;
  stepsTotal: number;
  stepsPct: number;
  checksPassed: number;
  checksTotal: number;
  /** null = no disponible (preparación ilegible), nunca un «0» inventado. */
  blockingCount: number | null;
  lastComputed: string;
};

export function launchSectionView(launch: LaunchState): LaunchSectionView {
  const { readiness, progress } = launch;
  const badge = launchBadge(readiness, progress);
  const goLiveAt = readiness?.goLiveAt ?? progress?.goLiveAt ?? null;
  const checks = readiness?.checks ?? [];
  const blockers = checks.filter((check) => check.severity === "blocking" && check.status !== "pass");
  const pendingSteps = (progress?.steps ?? []).filter((step) => step.status !== "completed");
  const stepsDone = progress?.completed ?? 0;
  const stepsTotal = progress?.total ?? 0;
  const readinessUnavailable = !launch.loading && !readiness && Boolean(launch.readinessError);
  const progressUnavailable = !launch.loading && !progress && Boolean(launch.progressError);
  const kind: LaunchSectionView["kind"] = launch.loading ? "loading" : !readiness && !progress ? "unavailable" : "ready";
  const warning =
    kind === "ready" && readinessUnavailable
      ? `No se ha podido leer la preparación de la propiedad: ${launch.readinessError}. Las comprobaciones y los bloqueantes no están disponibles.`
      : kind === "ready" && progressUnavailable
        ? `No se han podido leer los pasos de la puesta en marcha: ${launch.progressError}.`
        : kind === "unavailable"
          ? (launch.readinessError ?? launch.progressError ?? DEFAULT_READINESS_ERROR)
          : null;
  return {
    kind,
    readinessUnavailable,
    progressUnavailable,
    warning,
    badge,
    goLiveAt,
    blockers,
    pendingSteps,
    stepsDone,
    stepsTotal,
    stepsPct: stepsTotal > 0 ? Math.round((stepsDone / stepsTotal) * 100) : 0,
    checksPassed: checks.filter((check) => check.status === "pass").length,
    checksTotal: checks.length,
    blockingCount: readiness ? readiness.blockingCount : null,
    lastComputed: readiness?.computedAt ? dateTime(readiness.computedAt) : "Sin calcular"
  };
}
