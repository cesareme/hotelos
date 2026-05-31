import { useState } from "react";
import type { FormEvent } from "react";
import { Layout } from "../components/Layout";
import { signIn } from "../api/client";
import { useGuestSession } from "../auth/GuestSessionContext";

export function SignInPage({ initialError = null }: { initialError?: string | null }) {
  const { setSession } = useGuestSession();
  const [reservationCode, setReservationCode] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(initialError);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const session = await signIn({ reservationCode, email });
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
        <button type="submit" className="gp-button gp-button-primary" disabled={submitting}>
          {submitting ? "Signing in..." : "Continue"}
        </button>
        <p className="gp-hint">
          We will send a single-use link to your email in production. For now any code and email work in this preview.
        </p>
      </form>
    </Layout>
  );
}
