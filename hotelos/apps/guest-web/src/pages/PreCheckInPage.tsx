import { useState } from "react";
import type { FormEvent } from "react";
import { Layout } from "../components/Layout";
import { submitPreCheckIn } from "../api/client";
import type { PreCheckInPayload } from "../api/client";
import { useGuestSession } from "../auth/GuestSessionContext";

const DOC_TYPES: { value: PreCheckInPayload["documentType"]; label: string }[] = [
  { value: "passport", label: "Passport" },
  { value: "dni", label: "DNI" },
  { value: "nie", label: "NIE" },
  { value: "other", label: "Other" }
];

const COUNTRIES = [
  "Spain",
  "France",
  "Portugal",
  "Germany",
  "United Kingdom",
  "Italy",
  "United States",
  "Mexico",
  "Argentina",
  "Other"
];

export function PreCheckInPage({ onBack }: { onBack: () => void }) {
  const { session } = useGuestSession();
  const [documentType, setDocumentType] = useState<PreCheckInPayload["documentType"]>("passport");
  const [documentNumber, setDocumentNumber] = useState("");
  const [residenceAddress, setResidenceAddress] = useState("");
  const [country, setCountry] = useState("Spain");
  const [arrivalEta, setArrivalEta] = useState("");
  const [specialRequests, setSpecialRequests] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{ number: string; eta: string } | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    setError(null);
    setSubmitting(true);
    try {
      const payload: PreCheckInPayload = {
        documentType,
        documentNumber,
        residenceAddress,
        country,
        arrivalEta,
        specialRequests: specialRequests || undefined
      };
      const result = await submitPreCheckIn(session.reservationId, payload);
      setConfirmation({ number: result.confirmationNumber, eta: arrivalEta });
    } catch (err) {
      setError(err instanceof Error ? err.message : "We couldn't save your pre-check-in. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Layout
      eyebrow="Pre-check-in"
      title="Speed up your arrival"
      subtitle="Share your details now and skip the queue at reception."
      reservationCode={session?.reservationCode}
      back={{ label: "Back to my stay", onClick: onBack }}
      footer={
        <p className="gp-disclosure">
          Your data is encrypted and only used for the legal guest register (RD 933/2021). Three-year retention applies.
        </p>
      }
    >
      {confirmation ? (
        <section className="gp-card gp-success" role="status">
          <h2>You&apos;re all set</h2>
          <p>
            Welcome! Your check-in is ready
            {confirmation.eta ? <> See you on {new Date(confirmation.eta).toLocaleDateString()}.</> : "."}
          </p>
          <p className="gp-meta">Confirmation number</p>
          <p className="gp-confirmation">{confirmation.number}</p>
          <button type="button" className="gp-button gp-button-primary" onClick={onBack}>
            Back to my stay
          </button>
        </section>
      ) : (
        <form className="gp-card gp-form" onSubmit={onSubmit} noValidate>
          <label className="gp-field">
            <span>Document type</span>
            <select value={documentType} onChange={(e) => setDocumentType(e.target.value as PreCheckInPayload["documentType"])}>
              {DOC_TYPES.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </label>
          <label className="gp-field">
            <span>Document number</span>
            <input
              type="text"
              value={documentNumber}
              onChange={(e) => setDocumentNumber(e.target.value)}
              placeholder="Enter the number on your ID"
              required
            />
          </label>
          <label className="gp-field">
            <span>Residence address</span>
            <textarea
              rows={3}
              value={residenceAddress}
              onChange={(e) => setResidenceAddress(e.target.value)}
              placeholder="Street, city, postal code"
              required
            />
          </label>
          <label className="gp-field">
            <span>Country of residence</span>
            <select value={country} onChange={(e) => setCountry(e.target.value)}>
              {COUNTRIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className="gp-field">
            <span>Estimated arrival</span>
            <input
              type="datetime-local"
              value={arrivalEta}
              onChange={(e) => setArrivalEta(e.target.value)}
              required
            />
          </label>
          <label className="gp-field">
            <span>Special requests <small>(optional)</small></span>
            <textarea
              rows={3}
              value={specialRequests}
              onChange={(e) => setSpecialRequests(e.target.value)}
              placeholder="Quiet room, early arrival, dietary needs…"
            />
          </label>
          {error ? <p className="gp-error" role="alert">{error}</p> : null}
          <button type="submit" className="gp-button gp-button-primary" disabled={submitting}>
            {submitting ? "Saving…" : "Submit pre-check-in"}
          </button>
        </form>
      )}
    </Layout>
  );
}
