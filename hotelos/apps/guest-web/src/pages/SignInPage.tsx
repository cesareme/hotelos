import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Layout, useLang } from "../components/Layout";
import { isApiError, signIn } from "../api/client";
import { useGuestSession } from "../auth/GuestSessionContext";
import { PROPERTY_QUERY_PARAM, isApiConfigured, resolveGuestPropertyId } from "../config/guest-config";
import { t } from "../checkin/wizard";

export function SignInPage({ initialError = null }: { initialError?: string | null }) {
  const { setSession } = useGuestSession();
  const lang = useLang();
  const [reservationCode, setReservationCode] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(initialError);
  const [submitting, setSubmitting] = useState(false);
  // Tanda CHK (L0): el hotel se resuelve una vez por carga (?property=, luego
  // VITE_GUEST_PROPERTY_ID). Viaja como campo oculto y, si falta, se avisa antes
  // de enviar: sin él el API responde ok:false por diseño (anti-enumeración).
  const [propertyId] = useState(() => resolveGuestPropertyId());
  // Tanda L7 · L7-01: el aviso «cualquier código entra» solo es cierto sin API.
  const [apiConfigured] = useState(() => isApiConfigured());

  // El error del enlace caducado llega ya traducido desde App; si cambia el
  // idioma (o el enlace) se vuelve a mostrar en el idioma nuevo.
  useEffect(() => {
    setError(initialError);
  }, [initialError]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const session = await signIn({ reservationCode, email, propertyId });
      setSession(session);
    } catch (err) {
      // api/client.ts responde a `ok:false` (anti-enumeración) con un Error
      // genérico en inglés: aquí se traduce. Un fallo HTTP o de red → mensaje
      // genérico honesto, nunca el texto crudo del servidor.
      setError(isApiError(err) || err instanceof TypeError ? t(lang, "signInFailed") : t(lang, "signInNotFound"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Layout
      eyebrow={t(lang, "signInEyebrow")}
      title={t(lang, "signInTitle")}
      subtitle={t(lang, "signInSubtitle")}
      footer={<p>{t(lang, "signInHelp")}</p>}
    >
      <form className="gp-card gp-form" onSubmit={onSubmit} noValidate aria-busy={submitting}>
        <input type="hidden" name="propertyId" value={propertyId} readOnly />
        {!propertyId ? (
          <p className="gp-error" role="alert">
            {t(lang, "missingProperty", { param: `?${PROPERTY_QUERY_PARAM}=` })}
          </p>
        ) : null}
        <label className="gp-field">
          <span>{t(lang, "reservationCode")}</span>
          <input
            type="text"
            inputMode="text"
            autoComplete="off"
            placeholder={t(lang, "reservationCodePlaceholder")}
            value={reservationCode}
            onChange={(e) => setReservationCode(e.target.value)}
            required
          />
        </label>
        <label className="gp-field">
          <span>{t(lang, "email")}</span>
          <input
            type="email"
            autoComplete="email"
            placeholder={t(lang, "emailPlaceholder")}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <div aria-live="polite">{error ? <p className="gp-error" role="alert">{error}</p> : null}</div>
        <button type="submit" className="gp-button gp-button-primary" disabled={submitting || !propertyId}>
          {submitting ? t(lang, "signingInButton") : t(lang, "next")}
        </button>
        {!apiConfigured ? <p className="gp-hint">{t(lang, "previewAnyCode")}</p> : null}
      </form>
    </Layout>
  );
}
