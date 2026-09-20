import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { UXDAY, loginAsUxDay, type UxDaySession } from "./_helpers";

/**
 * Helpers de e2e de dirección (Tanda UX-2 · lote D2 · medida d1…d6).
 *
 * `loginAsDirector(page, request)` reutiliza el dev-bypass de `loginAsUxDay`
 * (_helpers.ts: POST /auth/login real + sesión en localStorage antes de que
 * cargue la app) con el usuario de dirección del seed `db:seed:ux-direccion`
 * (lote D1: `director@uxday.test`, misma contraseña de demo que UXDAY) y
 * repunta la propiedad activa al segundo hotel del tenant de prueba
 * (`prop_uxday_b`): las specs d1…d6 solo ESCRIBEN ahí (aprobaciones, revisión
 * del cierre, exportaciones), nunca en `prop_uxday` (UX-1) ni en Faranda.
 *
 * Sin overrides por entorno (corrector UX2-REV-13): las specs d2, d5 y d6
 * ESCRIBEN (aprueban, exportan, revisan un cierre) y solo pueden apuntar al tenant
 * de prueba; `loginAsDirector` rechaza cualquier propiedad que no sea `prop_uxday*`
 * (guarda `assertUxDayProperty`), Faranda incluida.
 */

export const UXDAY_DIRECCION = {
  organizationId: UXDAY.organizationId,
  propertyId: "prop_uxday_b",
  propertyName: "Hotel UXDAY B (prueba)",
  email: "director@uxday.test"
} as const;

/** Prefijo de las propiedades del tenant de prueba UXDAY (seed-ux-day / seed-ux-direccion): las únicas donde se escribe. */
export const UXDAY_PROPERTY_PREFIX = "prop_uxday";

/** Lanza si la propiedad no es del tenant de prueba: ninguna spec de dirección escribe fuera de `prop_uxday*`. */
export function assertUxDayProperty(propertyId: string): void {
  if (!propertyId.startsWith(UXDAY_PROPERTY_PREFIX)) {
    throw new Error(`[e2e] propiedad ${propertyId} fuera del tenant de prueba UXDAY: las specs de dirección solo escriben en ${UXDAY_PROPERTY_PREFIX}*`);
  }
}

export type DirectorSession = UxDaySession & {
  propertyId: string;
  propertyName: string;
  /** Cabeceras para llamadas directas al API en el hotel de dirección. */
  headers: Record<string, string>;
};

/**
 * Autentica al director del tenant UXDAY y deja la sesión persistida con
 * `prop_uxday_b` (o `options.propertyId`) como propiedad activa. Los init
 * scripts corren en orden de registro: el de `loginAsUxDay` escribe la sesión y
 * `prop_uxday`; este segundo script sobrescribe SOLO las dos claves de la
 * propiedad activa (services/activeProperty.ts) antes de la primera navegación.
 */
export async function loginAsDirector(
  page: Page,
  request: APIRequestContext,
  options: { propertyId?: string; propertyName?: string } = {}
): Promise<DirectorSession> {
  const propertyId = options.propertyId ?? UXDAY_DIRECCION.propertyId;
  const propertyName = options.propertyName ?? UXDAY_DIRECCION.propertyName;
  assertUxDayProperty(propertyId);
  const session = await loginAsUxDay(page, request, { email: UXDAY_DIRECCION.email });
  await page.addInitScript(
    (active) => {
      try {
        window.localStorage.setItem("hotelos-active-property", active.propertyId);
        window.localStorage.setItem("hotelos-active-property-name", active.propertyName);
      } catch {
        /* localStorage no disponible: la spec fallará en assertNoLoginGate con diagnóstico */
      }
    },
    { propertyId, propertyName }
  );
  return {
    ...session,
    propertyId,
    propertyName,
    headers: { Authorization: `Bearer ${session.token}`, "x-property-id": propertyId }
  };
}

/** Mi día de dirección listo: KPI «Ocupación» de la tira «Indicadores de hoy» (GeneralManagerScreen.tsx). */
export async function waitForDireccion(page: Page): Promise<void> {
  await expect(page.getByRole("group", { name: "Indicadores de hoy" }).getByText("Ocupación", { exact: true })).toBeVisible({ timeout: 15_000 });
}
