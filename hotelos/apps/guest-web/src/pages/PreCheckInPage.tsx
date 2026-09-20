import { useState } from "react";
import type { FormEvent } from "react";
import { Layout, useLang } from "../components/Layout";
import { submitPreCheckIn } from "../api/client";
import type { PreCheckInPayload } from "../api/client";
import { useGuestSession } from "../auth/GuestSessionContext";
import { t } from "../checkin/wizard";
import type { CopyKey, Lang } from "../checkin/wizard";

// Tanda L7 · L7-01: etiquetas por clave de copy (mismas que el asistente).
const DOC_TYPES: { value: PreCheckInPayload["documentType"]; key: CopyKey }[] = [
  { value: "passport", key: "docPassport" },
  { value: "dni", key: "docDni" },
  { value: "nie", key: "docTie" },
  { value: "other", key: "docOther" }
];

// Países como código ISO 3166-1 alfa-2 (valor que viaja al registro de viajeros);
// el nombre se pinta en el idioma del portal con Intl.DisplayNames.
const COUNTRY_CODES = ["ES", "FR", "PT", "DE", "GB", "IT", "US", "MX", "AR"] as const;
const COUNTRY_OTHER = "other";

const LOCALE: Record<Lang, string> = { es: "es-ES", en: "en-GB" };

export function countryLabel(code: string, lang: Lang): string {
  if (code === COUNTRY_OTHER) return t(lang, "countryOther");
  try {
    return new Intl.DisplayNames([LOCALE[lang]], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

export function PreCheckInPage({ onBack }: { onBack: () => void }) {
  const { session } = useGuestSession();
  const lang = useLang();
  const [documentType, setDocumentType] = useState<PreCheckInPayload["documentType"]>("passport");
  const [documentNumber, setDocumentNumber] = useState("");
  const [residenceAddress, setResidenceAddress] = useState("");
  const [country, setCountry] = useState<string>("ES");
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
      setError(err instanceof Error && err.message ? err.message : t(lang, "preCheckInSaveError"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Layout
      eyebrow={t(lang, "preCheckInBlock")}
      title={t(lang, "preCheckInTitle")}
      subtitle={t(lang, "preCheckInSubtitle")}
      reservationCode={session?.reservationCode}
      back={{ label: t(lang, "backToStay"), onClick: onBack }}
      footer={<p className="gp-disclosure">{t(lang, "retention")}</p>}
    >
      {confirmation ? (
        <section className="gp-card gp-success" role="status" aria-live="polite">
          <h2>{t(lang, "preCheckInDoneTitle")}</h2>
          <p>
            {t(lang, "preCheckInDoneBody")}
            {confirmation.eta ? <> {t(lang, "seeYouOn", { date: new Date(confirmation.eta).toLocaleDateString(LOCALE[lang]) })}</> : null}
          </p>
          <p className="gp-meta">{t(lang, "confirmationNumber")}</p>
          <p className="gp-confirmation">{confirmation.number}</p>
          <button type="button" className="gp-button gp-button-primary" onClick={onBack}>
            {t(lang, "backToStay")}
          </button>
        </section>
      ) : (
        <form className="gp-card gp-form" onSubmit={onSubmit} noValidate aria-busy={submitting}>
          <label className="gp-field">
            <span>{t(lang, "documentType")}</span>
            <select value={documentType} onChange={(e) => setDocumentType(e.target.value as PreCheckInPayload["documentType"])}>
              {DOC_TYPES.map((opt) => (
                <option key={opt.value} value={opt.value}>{t(lang, opt.key)}</option>
              ))}
            </select>
          </label>
          <label className="gp-field">
            <span>{t(lang, "documentNumber")}</span>
            <input
              type="text"
              value={documentNumber}
              onChange={(e) => setDocumentNumber(e.target.value)}
              placeholder={t(lang, "documentNumberPlaceholder")}
              required
            />
          </label>
          <label className="gp-field">
            <span>{t(lang, "residenceFullAddress")}</span>
            <textarea
              rows={3}
              value={residenceAddress}
              onChange={(e) => setResidenceAddress(e.target.value)}
              placeholder={t(lang, "addressPlaceholder")}
              required
            />
          </label>
          <label className="gp-field">
            <span>{t(lang, "countryOfResidence")}</span>
            <select value={country} onChange={(e) => setCountry(e.target.value)}>
              {[...COUNTRY_CODES, COUNTRY_OTHER].map((code) => (
                <option key={code} value={code}>{countryLabel(code, lang)}</option>
              ))}
            </select>
          </label>
          <label className="gp-field">
            <span>{t(lang, "arrivalEta")}</span>
            <input
              type="datetime-local"
              value={arrivalEta}
              onChange={(e) => setArrivalEta(e.target.value)}
              required
            />
          </label>
          <label className="gp-field">
            <span>{t(lang, "specialRequests")} <small>{t(lang, "optional")}</small></span>
            <textarea
              rows={3}
              value={specialRequests}
              onChange={(e) => setSpecialRequests(e.target.value)}
              placeholder={t(lang, "specialRequestsPlaceholder")}
            />
          </label>
          <div aria-live="polite">{error ? <p className="gp-error" role="alert">{error}</p> : null}</div>
          <button type="submit" className="gp-button gp-button-primary" disabled={submitting}>
            {submitting ? t(lang, "saving") : t(lang, "submitPreCheckIn")}
          </button>
        </form>
      )}
    </Layout>
  );
}
