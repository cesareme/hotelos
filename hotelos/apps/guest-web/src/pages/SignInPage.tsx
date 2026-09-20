import { useState } from "react";
import type { FormEvent } from "react";
import { Layout } from "../components/Layout";
import { signIn } from "../api/client";
import { useGuestSession } from "../auth/GuestSessionContext";
import { PROPERTY_QUERY_PARAM, resolveGuestPropertyId } from "../config/guest-config";

export function SignInPage({ initialError = null }: { initialError?: string | null }) {
  const { setSession } = useGuestSession();
  const [reservationCode, setReservationCode] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(initialError);
  const [submitting, setSubmitting] = useState(false);
  // Tanda CHK (L0): el hotel se resuelve una vez por carga (?property=, luego
  // VITE_GUEST_PROPERTY_ID). Viaja como campo oculto y, si falta, se avisa antes
  // de enviar: sin él el API responde ok:false por diseño (anti-enumeración).
  const [propertyId] = useState(() => resolveGuestPropertyId());

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const session = await signIn({ reservationCode, email, propertyId });
      setSession(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Layout
      eyebrow="Guest portal"
      title="Welcome"
      subtitle="Sign in with your reservation code and the email you used when booking."
      footer={<p>Need help? Reach out to the hotel and a team member will assist you.</p>}
    >
      <form className="gp-card gp-form" onSubmit={onSubmit} noValidate>
        <input type="hidden" name="propertyId" value={propertyId} readOnly />
        {!propertyId ? (
          <p className="gp-error" role="alert">
            This portal link is missing the hotel identifier (<code>?{PROPERTY_QUERY_PARAM}=</code>). Open the link the hotel sent you or contact reception.
          </p>
        ) : null}
        <label className="gp-field">
          <span>Reservation code</span>
          <input
            type="text"
            inputMode="text"
            autoComplete="off"
            placeholder="RES-2026-00042"
            value={reservationCode}
            onChange={(e) => setReservationCode(e.target.value)}
            required
          />
        </label>
        <label className="gp-field">
          <span>Email</span>
          <input
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        {error ? <p className="gp-error" role="alert">{error}</p> : null}
        <button type="submit" className="gp-button gp-button-primary" disabled={submitting || !propertyId}>
          {submitting ? "Signing in..." : "Continue"}
        </button>
        <p className="gp-hint">
          We will send a single-use link to your email in production. For now any code and email work in this preview.
        </p>
      </form>
    </Layout>
  );
}
