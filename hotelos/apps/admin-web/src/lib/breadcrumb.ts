// PILOT-D2: helper para enviar breadcrumbs a Sentry desde acciones críticas del
// usuario. Permite reconstruir la secuencia previa al error (click → navigation
// → API call → error) en lugar de ver solo el error final.
//
// Categorías acotadas para mantener consistencia en los dashboards de Sentry.
import * as Sentry from "@sentry/react";

export type BreadcrumbCategory =
  | "auth"
  | "navigation"
  | "mutation"
  | "api"
  | "ui";

export function logBreadcrumb(
  message: string,
  category: BreadcrumbCategory,
  data?: Record<string, unknown>
): void {
  try {
    Sentry.addBreadcrumb({
      message,
      category,
      level: "info",
      data
    });
  } catch {
    // Sentry no inicializado o entorno sin soporte: silenciar para no romper
    // la acción del usuario por un fallo de telemetría.
  }
}
