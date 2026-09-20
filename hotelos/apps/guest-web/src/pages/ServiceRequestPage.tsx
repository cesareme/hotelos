import { useState } from "react";
import type { FormEvent } from "react";
import { Layout, useLang } from "../components/Layout";
import { submitServiceRequest, isApiError } from "../api/client";
import type { ServiceRequestPayload } from "../api/client";
import { useGuestSession } from "../auth/GuestSessionContext";
import { t } from "../checkin/wizard";
import type { CopyKey } from "../checkin/wizard";

// Tanda L7 · L7-01: etiquetas y pistas por clave de copy (es/en).
const CATEGORIES: { value: ServiceRequestPayload["category"]; labelKey: CopyKey; hintKey: CopyKey; icon: string }[] = [
  { value: "housekeeping", labelKey: "catHousekeeping", hintKey: "catHousekeepingHint", icon: "✨" },
  { value: "food_beverage", labelKey: "catFood", hintKey: "catFoodHint", icon: "\u{1F37D}" },
  { value: "concierge", labelKey: "catConcierge", hintKey: "catConciergeHint", icon: "\u{1F6CE}" },
  { value: "maintenance", labelKey: "catMaintenance", hintKey: "catMaintenanceHint", icon: "\u{1F527}" }
];

export function ServiceRequestPage({ onBack }: { onBack: () => void }) {
  const { session } = useGuestSession();
  const lang = useLang();
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
      // Corrector REV-L7-05: reserva cancelada / no_show → 409 STAY_CLOSED (mismo texto que la salida).
      setError(isApiError(err, "STAY_CLOSED") ? t(lang, "stayClosedError") : err instanceof Error && err.message ? err.message : t(lang, "serviceSendError"));
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
      eyebrow={t(lang, "serviceEyebrow")}
      title={t(lang, "serviceTitle")}
      subtitle={t(lang, "serviceSubtitle")}
      reservationCode={session?.reservationCode}
      back={{ label: t(lang, "backToStay"), onClick: onBack }}
    >
      {ticket ? (
        <section className="gp-card gp-success" role="status" aria-live="polite">
          <h2>{t(lang, "requestReceived")}</h2>
          <p>{t(lang, "requestReceivedBody")}</p>
          <p className="gp-meta">{t(lang, "ticketNumber")}</p>
          <p className="gp-confirmation">{ticket}</p>
          <div className="gp-stacked">
            <button type="button" className="gp-button gp-button-primary" onClick={onBack}>
              {t(lang, "backToStay")}
            </button>
            <button type="button" className="gp-button gp-button-ghost" onClick={resetForAnother}>
              {t(lang, "anotherRequest")}
            </button>
          </div>
        </section>
      ) : (
        <form className="gp-card gp-form" onSubmit={onSubmit} noValidate aria-busy={submitting}>
          <fieldset className="gp-fieldset">
            <legend>{t(lang, "category")}</legend>
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
                  <span className="gp-category-label">{t(lang, opt.labelKey)}</span>
                  <span className="gp-category-hint">{t(lang, opt.hintKey)}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <label className="gp-field">
            <span>{t(lang, "whatDoYouNeed")}</span>
            <textarea
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t(lang, "serviceExample")}
              required
            />
          </label>

          <label className="gp-field">
            <span>{t(lang, "preferredTime")} <small>{t(lang, "optional")}</small></span>
            <input
              type="datetime-local"
              value={preferredTime}
              onChange={(e) => setPreferredTime(e.target.value)}
            />
          </label>

          <div aria-live="polite">{error ? <p className="gp-error" role="alert">{error}</p> : null}</div>

          <button type="submit" className="gp-button gp-button-primary" disabled={submitting}>
            {submitting ? t(lang, "chatSending") : t(lang, "sendRequest")}
          </button>
        </form>
      )}
    </Layout>
  );
}
