// Ajustes del portal del huésped · cliente del admin-web (Tanda L7 · lote L7-08,
// recon §8 y CHK audit D13).
//
// Solo persiste lo que el API guarda de verdad: las tres claves de
// `PropertyCheckInPolicy` que gobiernan el portal desde fuera del asistente de
// check-in (GET/PUT /properties/:id/check-in/policy; checkinApi.ts
// getPolicy/putPolicy, `PolicyPutSchema` parcial):
//   · postStaySurveyEnabled / postStaySurveyDelayHours (L7-04): el tick del
//     check-in invita a la encuesta post-estancia a las reservas checked_out
//     (0-72 h desde las 00:00 del día de salida; 24 = el día siguiente);
//   · allowPayAtReception (corrector CHK): sin PSP el huésped cierra el
//     pre-check-in con «se cobra en recepción».
// Marca, colores, idiomas, ventanas y «funciones visibles» no tienen columna ni
// ruta: la pantalla ya no los ofrece como ajustes que se guardan.
//
// Puro salvo las dos funciones de red (toPortalForm / validatePortalForm /
// toPortalPatch / isPortalFormDirty / guestPortalPublicUrl se prueban bajo
// node --test en screens/guest-portal/__tests__/guest-portal-settings.test.mts).

import type { PropertyCheckInPolicyDto } from "@hotelos/shared";
import type { RequestOptions } from "./api-client";
import { getPolicy, putPolicy, type CheckInPolicyPatch } from "./checkinApi";

/** Límites de `postStaySurveyDelayHours` (PolicyPutSchema: entero 0-72; el paso del tick mira 3 días atrás). */
export const SURVEY_DELAY_MIN_HOURS = 0;
export const SURVEY_DELAY_MAX_HOURS = 72;
/** Defecto de la columna `post_stay_survey_delay_hours` (migración 20260920190000_portal_huesped_l7). */
export const SURVEY_DELAY_DEFAULT_HOURS = 24;

/** Las tres claves de la política que edita la pantalla «Portal del huésped». */
export const GUEST_PORTAL_POLICY_KEYS = ["postStaySurveyEnabled", "postStaySurveyDelayHours", "allowPayAtReception"] as const;
export type GuestPortalPolicyKey = (typeof GUEST_PORTAL_POLICY_KEYS)[number];

/** Formulario controlado: las horas viajan como texto (los controles Cocoa son string-controlled). */
export type GuestPortalForm = {
  postStaySurveyEnabled: boolean;
  postStaySurveyDelayHours: string;
  allowPayAtReception: boolean;
};

export type GuestPortalFormErrors = Partial<Record<"postStaySurveyDelayHours", string>>;

export const GUEST_PORTAL_FORM_DEFAULTS: Readonly<GuestPortalForm> = Object.freeze({
  postStaySurveyEnabled: false,
  postStaySurveyDelayHours: String(SURVEY_DELAY_DEFAULT_HOURS),
  allowPayAtReception: false
});

/** Política del API → formulario; sin política (todavía no cargada) los defectos de las columnas. */
export function toPortalForm(policy: Pick<PropertyCheckInPolicyDto, GuestPortalPolicyKey> | null | undefined): GuestPortalForm {
  if (!policy) return { ...GUEST_PORTAL_FORM_DEFAULTS };
  return {
    postStaySurveyEnabled: policy.postStaySurveyEnabled === true,
    postStaySurveyDelayHours: Number.isInteger(policy.postStaySurveyDelayHours) ? String(policy.postStaySurveyDelayHours) : String(SURVEY_DELAY_DEFAULT_HOURS),
    allowPayAtReception: policy.allowPayAtReception === true
  };
}

/** Entero 0-72 escrito como texto ("24", " 24 "); "" o "24,5" no valen. */
export function parseDelayHours(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d{1,3}$/.test(trimmed)) return null;
  const hours = Number(trimmed);
  return hours >= SURVEY_DELAY_MIN_HOURS && hours <= SURVEY_DELAY_MAX_HOURS ? hours : null;
}

/** Misma regla que `PolicyPutSchema` (entero 0-72); se valida aunque la encuesta esté apagada porque el valor se guarda igual. */
export function validatePortalForm(form: GuestPortalForm): GuestPortalFormErrors {
  const errors: GuestPortalFormErrors = {};
  if (parseDelayHours(form.postStaySurveyDelayHours) === null) {
    errors.postStaySurveyDelayHours = `Indica un número entero de horas entre ${SURVEY_DELAY_MIN_HOURS} y ${SURVEY_DELAY_MAX_HOURS}.`;
  }
  return errors;
}

/** Cuerpo del PUT: exactamente las tres claves (nunca el resto de la política, que edita /hoy/check-in-automatizado). */
export function toPortalPatch(form: GuestPortalForm): Pick<CheckInPolicyPatch, GuestPortalPolicyKey> {
  const hours = parseDelayHours(form.postStaySurveyDelayHours);
  return {
    postStaySurveyEnabled: form.postStaySurveyEnabled,
    postStaySurveyDelayHours: hours ?? SURVEY_DELAY_DEFAULT_HOURS,
    allowPayAtReception: form.allowPayAtReception
  };
}

/** true si el formulario difiere de la política cargada (o si no hay política y difiere de los defectos). */
export function isPortalFormDirty(form: GuestPortalForm, policy: Pick<PropertyCheckInPolicyDto, GuestPortalPolicyKey> | null | undefined): boolean {
  const base = toPortalForm(policy);
  return form.postStaySurveyEnabled !== base.postStaySurveyEnabled || form.allowPayAtReception !== base.allowPayAtReception || form.postStaySurveyDelayHours.trim() !== base.postStaySurveyDelayHours;
}

/**
 * Dirección del portal para este hotel: `https://<host>/?property=<id>` (el
 * portal resuelve el hotel por `?property=`, guest-config.ts). El host es el de
 * la marca (brand.ts guestPortalHost); la base REAL de los enlaces que reciben
 * los huéspedes la fija `GUEST_WEB_BASE_URL` en el servidor del API, no esta pantalla.
 */
export function guestPortalPublicUrl(host: string, propertyId: string): string {
  const cleanHost = host.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return `https://${cleanHost}/?property=${encodeURIComponent(propertyId)}`;
}

/** GET /properties/:id/check-in/policy (misma ruta y caché que la pantalla de check-in automatizado). */
export function loadGuestPortalSettings(propertyId: string, options: Pick<RequestOptions, "signal"> = {}): Promise<PropertyCheckInPolicyDto> {
  return getPolicy(propertyId, options);
}

/** PUT /properties/:id/check-in/policy con SOLO las tres claves del portal; devuelve la política completa guardada. */
export function saveGuestPortalSettings(propertyId: string, form: GuestPortalForm): Promise<PropertyCheckInPolicyDto> {
  return putPolicy(propertyId, toPortalPatch(form));
}
