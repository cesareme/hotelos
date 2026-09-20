// Configuración del portal del huésped (Tanda CHK · L0).
//
// `Reservation.code` solo es único por hotel (`@@unique([propertyId, code])`),
// así que POST /guest-portal/sign-in exige `propertyId`; el portal es una app
// por hotel y lo resuelve, por este orden, de:
//   1. `?property=<id>` en la URL (enlace de invitación / QR del hotel);
//   2. `VITE_GUEST_PROPERTY_ID` (build del portal para un hotel concreto);
//   3. "" → SignInPage avisa de que falta y el API responde ok:false.

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

export { PROPERTY_QUERY_PARAM };
