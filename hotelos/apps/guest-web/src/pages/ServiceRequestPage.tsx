import { useState } from "react";
import type { FormEvent } from "react";
import { Layout } from "../components/Layout";
import { submitServiceRequest } from "../api/client";
import type { ServiceRequestPayload } from "../api/client";
import { useGuestSession } from "../auth/GuestSessionContext";

const CATEGORIES: { value: ServiceRequestPayload["category"]; label: string; icon: string; hint: string }[] = [
  { value: "housekeeping", label: "Housekeeping", icon: "✨", hint: "Towels, amenities, cleaning" },
  { value: "food_beverage", label: "Food & beverage", icon: "\u{1F37D}", hint: "Room service, dietary needs" },
  { value: "concierge", label: "Concierge", icon: "\u{1F6CE}", hint: "Reservations, transport" },
  { value: "maintenance", label: "Maintenance", icon: "\u{1F527}", hint: "Repairs, technical issues" }
];

export function ServiceRequestPage({ onBack }: { onBack: () => void }) {
  const { session } = useGuestSession();
  const [category, setCategory] = useState<ServiceRequestPayload["category"]>("housekeeping");
  const [description, setDescription] = useState("");
  const [preferredTime, setPreferredTime] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ticket, setTicket] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    setError(null);
    setSubmitting(true);
    try {
      const payload: ServiceRequestPayload = {
        category,
        description,
        preferredTime: preferredTime || undefined
      };
      const result = await submitServiceRequest(session.reservationId, payload);
      setTicket(result.ticketNumber);
    } catch (err) {
      setError(err instanceof Error ? err.message : "We couldn't send your request. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function resetForAnother() {
    setTicket(null);
    setDescription("");
    setPreferredTime("");
  }

  return (
    <Layout
      eyebrow="Service request"
      title="How can we help?"
      subtitle="Tell us what you need and we'll route it to the right team."
      reservationCode={session?.reservationCode}
      back={{ label: "Back to my stay", onClick: onBack }}
    >
      {ticket ? (
        <section className="gp-card gp-success" role="status">
          <h2>Request received</h2>
          <p>We&apos;ll confirm shortly. Thank you for letting us know.</p>
          <p className="gp-meta">Ticket number</p>
          <p className="gp-confirmation">{ticket}</p>
          <div className="gp-stacked">
            <button type="button" className="gp-button gp-button-primary" onClick={onBack}>
              Back to my stay
            </button>
            <button type="button" className="gp-button gp-button-ghost" onClick={resetForAnother}>
              Submit another request
            </button>
          </div>
        </section>
      ) : (
        <form className="gp-card gp-form" onSubmit={onSubmit} noValidate>
          <fieldset className="gp-fieldset">
            <legend>Category</legend>
            <div className="gp-category-grid">
              {CATEGORIES.map((opt) => (
                <label
                  key={opt.value}
                  className={`gp-category${category === opt.value ? " is-active" : ""}`}
                >
                  <input
                    type="radio"
                    name="category"
                    value={opt.value}
                    checked={category === opt.value}
                    onChange={() => setCategory(opt.value)}
                  />
                  <span className="gp-category-icon" aria-hidden>{opt.icon}</span>
                  <span className="gp-category-label">{opt.label}</span>
                  <span className="gp-category-hint">{opt.hint}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <label className="gp-field">
            <span>What do you need?</span>
            <textarea
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Two extra pillows, please."
              required
            />
          </label>

          <label className="gp-field">
            <span>Preferred time <small>(optional)</small></span>
            <input
              type="datetime-local"
              value={preferredTime}
              onChange={(e) => setPreferredTime(e.target.value)}
            />
          </label>

          {error ? <p className="gp-error" role="alert">{error}</p> : null}

          <button type="submit" className="gp-button gp-button-primary" disabled={submitting}>
            {submitting ? "Sending…" : "Send request"}
          </button>
        </form>
      )}
    </Layout>
  );
}
