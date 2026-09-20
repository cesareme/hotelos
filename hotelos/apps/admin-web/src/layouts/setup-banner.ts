// Regla PURA del banner «Puesta en marcha pendiente» del shell (BackOfficeLayout).
// Corrector L5 (L5F-02): separada de la vista para poder fijarla con tests
// (`layouts/__tests__/setup-banner.test.mts`) sin montar React ni el shell.
import type { PropertyReadiness } from "../services/billingApi";

/**
 * Tanda L5 (lote C): el GET calcula las comprobaciones en vivo (nunca una lista
 * vacía), así que el banner solo sale cuando hay algo que arreglar
 * (`blockingCount > 0`) y nunca para una propiedad cuya salida en vivo ya está
 * aprobada (`goLiveAt`), diga lo que diga una comprobación posterior.
 */
export function shouldShowSetupBanner(readiness: PropertyReadiness | null | undefined, dismissed: boolean): boolean {
  if (dismissed || !readiness) return false;
  if (readiness.goLiveAt) return false;
  return readiness.status === "blocked" && (readiness.blockingCount ?? 0) > 0;
}

/**
 * Texto del banner para `pending` comprobaciones bloqueantes (shouldShowSetupBanner
 * garantiza pending > 0). Verbo y sustantivo concuerdan (FIX-1 · F9): «Falta 1
 * comprobación», «Faltan 3 comprobaciones».
 */
export function setupBannerMessage(pending: number): string {
  return `${pending === 1 ? "Falta" : "Faltan"} ${pending} ${pending === 1 ? "comprobación" : "comprobaciones"} para poner la propiedad en marcha.`;
}
