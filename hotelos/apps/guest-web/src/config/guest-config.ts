// Configuración del portal del huésped (Tanda CHK · L0).
//
// `Reservation.code` solo es único por hotel (`@@unique([propertyId, code])`),
// así que POST /guest-portal/sign-in exige `propertyId`; el portal es una app
// por hotel y lo resuelve, por este orden, de:
//   1. `?property=<id>` en la URL (enlace de invitación / QR del hotel);
//   2. `VITE_GUEST_PROPERTY_ID` (build del portal para un hotel concreto);
//   3. "" → SignInPage avisa de que falta y el API responde ok:false.
//
// Tanda L7 · L7-01: `isApiConfigured()` dice si el portal habla con el API real
// (`VITE_GUEST_API_BASE`, la misma variable que lee api/client.ts) o con los
// stubs en memoria; las páginas solo muestran el aviso «vista previa sin API:
// cualquier código entra» cuando NO hay API.

const PROPERTY_QUERY_PARAM = "property";

function envPropertyId(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return (env?.VITE_GUEST_PROPERTY_ID ?? "").trim();
}

function urlPropertyId(): string {
  if (typeof window === "undefined") return "";
  try {
    return (new URLSearchParams(window.location.search).get(PROPERTY_QUERY_PARAM) ?? "").trim();
  } catch {
    return "";
  }
}

/** Identificador del hotel al que pertenece este portal ("" si no se puede resolver). */
export function resolveGuestPropertyId(): string {
  return urlPropertyId() || envPropertyId() || "";
}

/** Base del API del portal (`VITE_GUEST_API_BASE` sin barra final; "" = stubs en memoria). */
export function resolveGuestApiBase(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return (env?.VITE_GUEST_API_BASE ?? "").trim().replace(/\/$/, "");
}

/** true si el portal está conectado al API real (sin API los datos son de demostración). */
export function isApiConfigured(): boolean {
  return resolveGuestApiBase() !== "";
}

export { PROPERTY_QUERY_PARAM };
