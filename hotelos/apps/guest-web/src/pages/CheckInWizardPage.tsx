import { useCallback, useContext, useEffect, useRef, useState } from "react";
import type { FormEvent, RefObject } from "react";
import { LangContext, Layout } from "../components/Layout";
import { StatusPill } from "../components/StatusPill";
import { ChatWidget } from "../components/ChatWidget";
import { DocumentCamera } from "../components/DocumentCamera";
import { SignaturePad, deferSignatureLabel } from "../components/SignaturePad";
import type { SignaturePayload } from "../components/SignaturePad";
import { useGuestSession } from "../auth/GuestSessionContext";
import {
  addGuest,
  arrive,
  completeCheckIn,
  getCheckIn,
  getReservation,
  handoffCheckIn,
  isApiError,
  patchCheckIn,
  patchGuest,
  removeGuest,
  requestOtp,
  requestPaymentLink,
  signGuest,
  submitMrz,
  uploadDocument,
  verifyOtp
} from "../api/client";
import type { CheckInGuest, CheckInSession, DocumentCapture, GuestInput, OtpRequestResponse, PaymentLinkResponse, ReservationSummary } from "../api/client";
import {
  ARRIVED_SESSION_STATUSES,
  PREFERENCE_OPTIONS,
  WIZARD_STEPS,
  adultsFor,
  canAddGuest,
  canAdvance,
  guestLabel,
  hasDocument,
  initialStep,
  isSigned,
  mergeMissing,
  missingFor,
  needsOtp,
  nextStep,
  otpChannelsFor,
  pendingSigners,
  prevStep,
  primaryGuestOf,
  progressFor,
  sessionStatusLabel,
  sourceLabel,
  stepLabel,
  t,
  togglePreference
} from "../checkin/wizard";
import type { CopyKey, Lang, OtpChannel, WizardStep } from "../checkin/wizard";
import type { ArrivalOutcome } from "./ArrivalPage";

// Tanda CHK · W4-C — asistente de pre-check-in de 6 pasos (diseño §4a pasos
// 3-9, §4c «Móvil del huésped» y «Kiosco», §8 fila «Portal del huésped»):
// Viajeros → Documento → Datos → Firma → Pago y extras → Llegada. Toda la
// lógica (pasos, faltas, MRZ, copy es/en, errores de llegada) vive en
// checkin/wizard.ts (puro, testeado); esta página solo pinta y llama al API.
// La sesión se reanuda por el primer paso incompleto (initialStep). Aviso
// legal: retention (RD 933/2021, tres años) en el pie, igual que en
// PreCheckInPage.
//
// Tanda L7 · L7-05 — accesibilidad WCAG 2.2 AA (UX-RECEPCION-FEEL.md §7.1,
// recon-delta §14 y §18 D6), solo con claves de copy existentes y clases de
// styles.css (0 CSS nuevo, 0 `style=`):
//   · el título del paso («Paso n de 6 · Nombre») es un encabezado con
//     tabIndex -1 que recibe el foco al cambiar de paso y al cargar (2.4.3);
//   · errores y estado «guardando…» en regiones vivas (`aria-live`, `role=alert`,
//     `role=status`) y `aria-busy` en el asistente (4.1.3);
//   · cada campo con `<label htmlFor>` + `id`; en «Datos» los campos que faltan
//     llevan `aria-invalid` y `aria-describedby` a la lista de faltas y al origen
//     del dato (MRZ / visión) (1.3.1, 3.3.1, 3.3.2);
//   · firma con alternativa sin arrastre «Firmar en recepción» (2.5.7 · D6):
//     en el kiosco registra la llegada y deriva al mostrador con ticket; en el
//     móvil deja el aviso y permite seguir (recepción cierra el parte);
//   · el selector de idioma vive en la cabecera (LangContext); el asistente solo
//     pinta el suyo si no hay proveedor (sin dos controles equivalentes).

export type KioskContext = { deviceId: string; name: string | null; capabilities: { mrzReader: boolean; cardEncoder: boolean; paymentTerminal: boolean; printer: boolean } };

export type CheckInWizardPageProps = {
  lang: Lang;
  onLangChange: (lang: Lang) => void;
  onBack: () => void;
  onArrived: (outcome: ArrivalOutcome) => void;
  kiosk?: KioskContext | null;
};

type Session = CheckInSession & { reservation?: ReservationSummary | null };

const DOCUMENT_TYPES: Array<{ value: string; key: CopyKey }> = [
  { value: "PASSPORT", key: "docPassport" },
  { value: "DNI", key: "docDni" },
  { value: "TIE", key: "docTie" },
  { value: "OTHER", key: "docOther" }
];

const MISSING_LABEL: Record<string, CopyKey> = {
  firstName: "firstName",
  surname1: "surname1",
  surname2: "surname2",
  sex: "sex",
  nationality: "nationality",
  dateOfBirth: "dateOfBirth",
  documentType: "documentType",
  documentNumber: "documentNumber",
  documentSupportNumber: "documentSupportNumber",
  documentExpiryDate: "documentExpiryDate",
  email: "email",
  phoneMobile: "phoneMobile",
  contact: "missingContact",
  residenceFullAddress: "residenceFullAddress",
  residenceAddress: "residenceFullAddress",
  residenceLocality: "residenceLocality",
  residenceCountry: "residenceCountry",
  providedByCheckInGuestId: "minorGuardian",
  providedByAdultGuestId: "minorGuardian",
  kinship: "kinship",
  kinshipRelationIfMinor: "kinship",
  guardianTitle: "guardianTitle"
};

/** Claves de falta (cliente + servidor) que marcan cada campo de «Datos» como inválido. */
const MISSING_BY_FIELD: Record<string, readonly string[]> = {
  sex: ["sex"],
  nationality: ["nationality"],
  dateOfBirth: ["dateOfBirth"],
  documentType: ["documentType"],
  documentNumber: ["documentNumber"],
  documentSupportNumber: ["documentSupportNumber"],
  documentExpiryDate: ["documentExpiryDate"],
  email: ["contact", "email"],
  phoneMobile: ["contact", "phoneMobile"],
  residenceFullAddress: ["residenceFullAddress", "residenceAddress"],
  residenceLocality: ["residenceLocality"],
  residenceCountry: ["residenceCountry"],
  providedByCheckInGuestId: ["providedByCheckInGuestId", "providedByAdultGuestId"],
  kinship: ["kinship", "kinshipRelationIfMinor"],
  guardianTitle: ["guardianTitle"]
};

/** Id estable y único por tarjeta + viajero + campo (los ids de viajero son cuid). */
export function fieldId(scope: string, guestId: string, field: string): string {
  return `gp-${scope}-${guestId}-${field}`;
}

/** true si alguna de las faltas (cliente o servidor) afecta al campo. */
export function isFieldMissing(field: string, missing: readonly string[]): boolean {
  const keys = MISSING_BY_FIELD[field] ?? [field];
  return missing.some((key) => keys.includes(key));
}

function missingLabel(key: string, lang: Lang): string {
  const copy = MISSING_LABEL[key];
  return copy ? t(lang, copy) : key;
}

function errorMessage(error: unknown, lang: Lang): string {
  return error instanceof Error && error.message ? error.message : t(lang, "genericError");
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

function withReservation(session: CheckInSession, reservation: ReservationSummary | null | undefined): Session {
  return {
    ...session,
    reservation: reservation ?? null,
    ...(reservation ? { balanceDue: reservation.balanceDue, guestCapacity: reservation.guests } : {})
  };
}

// ── Progreso ───────────────────────────────────────────────────────────────────

export const STEP_TITLE_ID = "gp-step-title";

function StepProgress({ step, lang, onLangChange, titleRef }: { step: WizardStep; lang: Lang; onLangChange: (lang: Lang) => void; titleRef: RefObject<HTMLElement | null> }) {
  const progress = progressFor(step);
  // Con LangContext (portal) el selector es/en está en la cabecera: no se duplica aquí.
  const headerHasLanguage = useContext(LangContext) !== null;
  return (
    <div className="gp-progress" role="group" aria-label={t(lang, "stepOf", { index: progress.index, total: progress.total })}>
      <div className="gp-progress-top">
        <span className="gp-progress-label" role="heading" aria-level={2} id={STEP_TITLE_ID} tabIndex={-1} ref={titleRef}>
          {t(lang, "stepOf", { index: progress.index, total: progress.total })} · {stepLabel(step, lang)}
        </span>
        {!headerHasLanguage ? (
          <button type="button" className="gp-link gp-lang" onClick={() => onLangChange(lang === "es" ? "en" : "es")} lang={lang === "es" ? "en" : "es"}>
            {t(lang, "language")}
          </button>
        ) : null}
      </div>
      <div className="gp-progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent} aria-labelledby={STEP_TITLE_ID}>
        <span className="gp-progress-fill" data-percent={progress.percent} />
      </div>
      <ol className="gp-steps">
        {WIZARD_STEPS.map((key, index) => (
          <li key={key} className={`gp-step${key === step ? " is-current" : index < progress.index - 1 ? " is-done" : ""}`} aria-current={key === step ? "step" : undefined}>
            <span className="gp-step-index" aria-hidden>{index + 1}</span>
            <span className="gp-step-label">{stepLabel(key, lang)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ── Paso 1 · Viajeros ─────────────────────────────────────────────────────────

function TravellerCard({ guest, session, lang, onSave, onRemove, busy }: { guest: CheckInGuest; session: Session; lang: Lang; onSave: (id: string, input: GuestInput) => Promise<void>; onRemove: (id: string) => Promise<void>; busy: boolean }) {
  const [firstName, setFirstName] = useState(guest.firstName ?? "");
  const [surname1, setSurname1] = useState(guest.surname1 ?? "");
  const [surname2, setSurname2] = useState(guest.surname2 ?? "");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [providedBy, setProvidedBy] = useState(guest.providedByCheckInGuestId ?? "");
  const [kinship, setKinship] = useState(guest.kinship ?? "");
  const dirty = firstName !== (guest.firstName ?? "") || surname1 !== (guest.surname1 ?? "") || surname2 !== (guest.surname2 ?? "") || dateOfBirth !== "" || providedBy !== (guest.providedByCheckInGuestId ?? "") || kinship !== (guest.kinship ?? "");
  const adults = adultsFor(session, guest.id);
  const id = (field: string) => fieldId("trav", guest.id, field);
  const headId = id("head");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input: GuestInput = { firstName: firstName.trim() || null, surname1: surname1.trim() || null, surname2: surname2.trim() || null };
    if (dateOfBirth) input.dateOfBirth = dateOfBirth;
    if (guest.isMinor || providedBy) input.providedByCheckInGuestId = providedBy || null;
    if (guest.isMinor || kinship) input.kinship = kinship.trim() || null;
    await onSave(guest.id, input);
    setDateOfBirth("");
  }

  return (
    <form className="gp-card gp-form gp-traveller" onSubmit={(event) => void submit(event)} noValidate aria-labelledby={headId} aria-busy={busy}>
      <div className="gp-traveller-head">
        <strong id={headId}>{guest.isPrimary ? t(lang, "travellerPrimary") : t(lang, "travellerCompanion", { n: guest.ordinal })}</strong>
        <div className="gp-traveller-badges">
          {guest.isMinor ? <StatusPill label={t(lang, "travellerMinor")} tone="warn" /> : null}
          {isSigned(guest) ? <StatusPill label={t(lang, "statusReady")} tone="ok" /> : null}
        </div>
      </div>
      <div className="gp-grid-2">
        <label className="gp-field" htmlFor={id("firstName")}>
          <span>{t(lang, "firstName")}</span>
          <input id={id("firstName")} type="text" value={firstName} onChange={(event) => setFirstName(event.target.value)} autoComplete="given-name" required aria-required />
        </label>
        <label className="gp-field" htmlFor={id("surname1")}>
          <span>{t(lang, "surname1")}</span>
          <input id={id("surname1")} type="text" value={surname1} onChange={(event) => setSurname1(event.target.value)} autoComplete="family-name" required aria-required />
        </label>
      </div>
      <div className="gp-grid-2">
        <label className="gp-field" htmlFor={id("surname2")}>
          <span>{t(lang, "surname2")}</span>
          <input id={id("surname2")} type="text" value={surname2} onChange={(event) => setSurname2(event.target.value)} />
        </label>
        <label className="gp-field" htmlFor={id("dateOfBirth")}>
          <span>{t(lang, "dateOfBirth")}</span>
          <input id={id("dateOfBirth")} type="date" value={dateOfBirth} onChange={(event) => setDateOfBirth(event.target.value)} />
        </label>
      </div>
      {guest.isMinor ? (
        <div className="gp-grid-2">
          <label className="gp-field" htmlFor={id("providedBy")}>
            <span>{t(lang, "minorGuardian")}</span>
            <select id={id("providedBy")} value={providedBy} onChange={(event) => setProvidedBy(event.target.value)}>
              <option value="">{t(lang, "chooseAdult")}</option>
              {adults.map((adult) => (
                <option key={adult.id} value={adult.id}>
                  {guestLabel(adult, lang)}
                </option>
              ))}
            </select>
          </label>
          <label className="gp-field" htmlFor={id("kinship")}>
            <span>{t(lang, "kinship")}</span>
            <input id={id("kinship")} type="text" value={kinship} onChange={(event) => setKinship(event.target.value)} />
          </label>
        </div>
      ) : null}
      <div className="gp-traveller-actions">
        <button type="submit" className="gp-button gp-button-primary" disabled={busy || !dirty}>
          {busy ? t(lang, "saving") : t(lang, "saveTraveller")}
        </button>
        {!guest.isPrimary && !isSigned(guest) ? (
          <button type="button" className="gp-link" onClick={() => void onRemove(guest.id)} disabled={busy} aria-describedby={headId}>
            {t(lang, "removeTraveller")}
          </button>
        ) : null}
      </div>
    </form>
  );
}

function TravellersStep({ session, lang, busy, onSave, onRemove, onAdd }: { session: Session; lang: Lang; busy: boolean; onSave: (id: string, input: GuestInput) => Promise<void>; onRemove: (id: string) => Promise<void>; onAdd: () => Promise<void> }) {
  const canAdd = canAddGuest(session);
  return (
    <>
      <p className="gp-intro">{t(lang, "travellersIntro")}</p>
      {session.guests.map((guest) => (
        <TravellerCard key={guest.id} guest={guest} session={session} lang={lang} busy={busy} onSave={onSave} onRemove={onRemove} />
      ))}
      <button type="button" className="gp-button gp-button-ghost" onClick={() => void onAdd()} disabled={busy || !canAdd}>
        {canAdd ? t(lang, "addTraveller") : t(lang, "capacityReached")}
      </button>
    </>
  );
}

// ── Paso 2 · Documento ────────────────────────────────────────────────────────

/** Origen del documento del viajero para la etiqueta: lectura (MRZ/visión) o datos del perfil sin leer (corrector REV3-11). */
export function documentOriginLabel(guest: Pick<CheckInGuest, "identityVerificationMethod">, capture: DocumentCapture | undefined, lang: Lang): string {
  if (capture) return sourceLabel(capture.source, capture.confidence.documentNumber ?? null, lang);
  if (guest.identityVerificationMethod === "mrz_checksum") return sourceLabel("mrz_reader", null, lang);
  return t(lang, "documentSourceProfile");
}

function DocumentStep({ session, lang, captures, unreadable, mismatch, busyGuestId, onImage, onMrz }: { session: Session; lang: Lang; captures: Record<string, DocumentCapture>; unreadable: Record<string, boolean>; mismatch: Record<string, boolean>; busyGuestId: string | null; onImage: (guestId: string, dataUrl: string, documentType: string) => Promise<void>; onMrz: (guestId: string, lines: string[]) => Promise<void> }) {
  const [types, setTypes] = useState<Record<string, string>>({});
  // Corrector REV3-11: con documento del perfil (o ya leído) el viajero puede volver a leerlo (cámara / MRZ).
  const [rereading, setRereading] = useState<Record<string, boolean>>({});
  return (
    <>
      <p className="gp-intro">{t(lang, "documentIntro")}</p>
      {session.guests.map((guest) => {
        const documentType = types[guest.id] ?? guest.documentType ?? "PASSPORT";
        const capture = captures[guest.id];
        const done = hasDocument(guest);
        const showCapture = !done || rereading[guest.id] === true;
        const headId = fieldId("doc", guest.id, "head");
        const typeId = fieldId("doc", guest.id, "type");
        return (
          <section key={guest.id} className="gp-card gp-document" aria-labelledby={headId} aria-busy={busyGuestId === guest.id}>
            <div className="gp-traveller-head">
              <strong id={headId}>{t(lang, "documentFor", { name: guestLabel(guest, lang) })}</strong>
              {done ? <StatusPill label={t(lang, "documentDone", { last3: guest.documentNumberLast3 ?? "" })} tone="ok" /> : null}
            </div>
            {done ? <p className="gp-meta">{documentOriginLabel(guest, mismatch[guest.id] ? undefined : capture, lang)}</p> : null}
            {done && !showCapture ? (
              <>
                <p className="gp-hint">{t(lang, "documentRereadHint")}</p>
                <button type="button" className="gp-button gp-button-ghost" onClick={() => setRereading((current) => ({ ...current, [guest.id]: true }))} disabled={busyGuestId === guest.id}>
                  {t(lang, "documentReread")}
                </button>
              </>
            ) : null}
            {showCapture ? (
              <>
                <label className="gp-field" htmlFor={typeId}>
                  <span>{t(lang, "documentType")}</span>
                  <select id={typeId} value={documentType} onChange={(event) => setTypes((current) => ({ ...current, [guest.id]: event.target.value }))}>
                    {DOCUMENT_TYPES.map((option) => (
                      <option key={option.value} value={option.value}>
                        {t(lang, option.key)}
                      </option>
                    ))}
                  </select>
                </label>
                <DocumentCamera lang={lang} documentType={documentType} busy={busyGuestId === guest.id} showMrzFallback={Boolean(unreadable[guest.id])} onImage={(dataUrl) => onImage(guest.id, dataUrl, documentType)} onMrz={(lines) => onMrz(guest.id, lines)} />
                <div aria-live="polite">{unreadable[guest.id] ? <p className="gp-error" role="alert">{t(lang, "documentUnreadable")}</p> : null}</div>
                {done ? (
                  <button type="button" className="gp-link" onClick={() => setRereading((current) => ({ ...current, [guest.id]: false }))}>
                    {t(lang, "documentRereadCancel")}
                  </button>
                ) : null}
              </>
            ) : null}
            <div aria-live="polite">{mismatch[guest.id] ? <p className="gp-error" role="alert">{t(lang, "documentMismatch")}</p> : null}</div>
          </section>
        );
      })}
    </>
  );
}

// ── Paso 3 · Datos ────────────────────────────────────────────────────────────

type DetailsForm = {
  sex: string;
  nationality: string;
  dateOfBirth: string;
  documentType: string;
  documentNumber: string;
  documentSupportNumber: string;
  documentExpiryDate: string;
  email: string;
  phoneMobile: string;
  residenceFullAddress: string;
  residenceLocality: string;
  residenceCountry: string;
  providedByCheckInGuestId: string;
  kinship: string;
  guardianTitle: string;
};

function initialDetails(guest: CheckInGuest, capture: DocumentCapture | undefined): DetailsForm {
  const fields = capture?.fields ?? {};
  return {
    sex: fields.sex ?? "",
    nationality: fields.nationality ?? guest.nationality ?? "",
    dateOfBirth: fields.dateOfBirth ?? "",
    documentType: fields.documentType ?? guest.documentType ?? "",
    documentNumber: fields.documentNumber ?? "",
    documentSupportNumber: fields.documentSupportNumber ?? "",
    documentExpiryDate: fields.documentExpiryDate ?? "",
    email: "",
    phoneMobile: "",
    residenceFullAddress: "",
    residenceLocality: "",
    residenceCountry: "",
    providedByCheckInGuestId: guest.providedByCheckInGuestId ?? "",
    kinship: guest.kinship ?? "",
    guardianTitle: guest.guardianTitle ?? ""
  };
}

function DetailsCard({ guest, session, lang, capture, serverMissing, busy, onSave }: { guest: CheckInGuest; session: Session; lang: Lang; capture: DocumentCapture | undefined; serverMissing: string[]; busy: boolean; onSave: (id: string, input: GuestInput) => Promise<void> }) {
  const [form, setForm] = useState<DetailsForm>(() => initialDetails(guest, capture));
  const [touched, setTouched] = useState<Set<keyof DetailsForm>>(() => new Set());
  const missing = mergeMissing(missingFor(guest), serverMissing);
  const adults = adultsFor(session, guest.id);
  const id = (field: string) => fieldId("det", guest.id, field);
  const headId = id("head");
  const missingId = id("missing");

  function set<K extends keyof DetailsForm>(key: K, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
    setTouched((current) => new Set(current).add(key));
  }

  function hasBadge(key: keyof DocumentCapture["fields"]): boolean {
    return Boolean(capture && key in capture.fields && !touched.has(key as keyof DetailsForm));
  }

  function badge(key: keyof DocumentCapture["fields"]) {
    if (!capture || !hasBadge(key)) return null;
    return (
      <small className="gp-badge-source" id={id(`${key}-source`)}>
        {sourceLabel(capture.source, capture.confidence[key] ?? null, lang)}
      </small>
    );
  }

  /** aria-invalid (falta) + aria-describedby (lista de faltas, origen del dato) del campo. */
  function a11y(key: keyof DetailsForm) {
    const invalid = isFieldMissing(key, missing);
    const describedBy = [invalid ? missingId : null, hasBadge(key as keyof DocumentCapture["fields"]) ? id(`${key}-source`) : null].filter(Boolean).join(" ");
    return { id: id(key), "aria-invalid": invalid || undefined, "aria-describedby": describedBy || undefined } as const;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input: GuestInput = {};
    // Send captured fields once (so the row gets them) and any field the guest touched.
    const send = (key: keyof DetailsForm) => touched.has(key) || (capture && key in capture.fields && !(key === "documentType" && guest.documentType) && !(key === "nationality" && guest.nationality));
    for (const key of ["sex", "nationality", "dateOfBirth", "documentType", "documentNumber", "documentSupportNumber", "documentExpiryDate", "email", "phoneMobile", "residenceFullAddress", "residenceLocality", "residenceCountry", "kinship", "guardianTitle"] as const) {
      if (!send(key)) continue;
      const value = form[key].trim();
      if (value) (input as Record<string, string>)[key] = key === "nationality" || key === "residenceCountry" ? value.toUpperCase() : value;
    }
    if (touched.has("providedByCheckInGuestId") || (guest.isMinor && form.providedByCheckInGuestId)) input.providedByCheckInGuestId = form.providedByCheckInGuestId || null;
    if (Object.keys(input).length === 0) return;
    await onSave(guest.id, input);
    setTouched(new Set());
  }

  return (
    <form className="gp-card gp-form gp-details" onSubmit={(event) => void submit(event)} noValidate aria-labelledby={headId} aria-busy={busy}>
      <div className="gp-traveller-head">
        <strong id={headId}>{guestLabel(guest, lang)}</strong>
        {missing.length === 0 ? <StatusPill label={t(lang, "statusReady")} tone="ok" /> : <StatusPill label={`${t(lang, "missingTitle")}: ${missing.length}`} tone="warn" />}
      </div>
      <div aria-live="polite">{missing.length > 0 ? <p className="gp-missing" id={missingId}>{missing.map((key) => missingLabel(key, lang)).join(" · ")}</p> : null}</div>
      <div className="gp-grid-2">
        <label className="gp-field" htmlFor={id("sex")}>
          <span>{t(lang, "sex")} {badge("sex")}</span>
          <select {...a11y("sex")} value={form.sex} onChange={(event) => set("sex", event.target.value)}>
            <option value="">—</option>
            <option value="H">{t(lang, "sexH")}</option>
            <option value="M">{t(lang, "sexM")}</option>
            <option value="O">{t(lang, "sexO")}</option>
          </select>
        </label>
        <label className="gp-field" htmlFor={id("nationality")}>
          <span>{t(lang, "nationality")} {badge("nationality")}</span>
          <input {...a11y("nationality")} type="text" value={form.nationality} onChange={(event) => set("nationality", event.target.value)} maxLength={3} autoCapitalize="characters" />
        </label>
      </div>
      <div className="gp-grid-2">
        <label className="gp-field" htmlFor={id("dateOfBirth")}>
          <span>{t(lang, "dateOfBirth")} {badge("dateOfBirth")}</span>
          <input {...a11y("dateOfBirth")} type="date" value={form.dateOfBirth} onChange={(event) => set("dateOfBirth", event.target.value)} />
        </label>
        <label className="gp-field" htmlFor={id("documentType")}>
          <span>{t(lang, "documentType")} {badge("documentType")}</span>
          <select {...a11y("documentType")} value={form.documentType} onChange={(event) => set("documentType", event.target.value)}>
            <option value="">—</option>
            {DOCUMENT_TYPES.map((option) => (
              <option key={option.value} value={option.value}>
                {t(lang, option.key)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="gp-grid-2">
        <label className="gp-field" htmlFor={id("documentNumber")}>
          <span>{t(lang, "documentNumber")} {badge("documentNumber")}</span>
          <input {...a11y("documentNumber")} type="text" value={form.documentNumber} onChange={(event) => set("documentNumber", event.target.value)} placeholder={guest.documentNumberLast3 ? `···${guest.documentNumberLast3}` : ""} autoComplete="off" />
        </label>
        <label className="gp-field" htmlFor={id("documentSupportNumber")}>
          <span>{t(lang, "documentSupportNumber")} {badge("documentSupportNumber")}</span>
          <input {...a11y("documentSupportNumber")} type="text" value={form.documentSupportNumber} onChange={(event) => set("documentSupportNumber", event.target.value)} autoComplete="off" />
        </label>
      </div>
      <label className="gp-field" htmlFor={id("documentExpiryDate")}>
        <span>{t(lang, "documentExpiryDate")} {badge("documentExpiryDate")}</span>
        <input {...a11y("documentExpiryDate")} type="date" value={form.documentExpiryDate} onChange={(event) => set("documentExpiryDate", event.target.value)} />
      </label>
      <div className="gp-grid-2">
        <label className="gp-field" htmlFor={id("email")}>
          <span>{t(lang, "email")}</span>
          <input {...a11y("email")} type="email" value={form.email} onChange={(event) => set("email", event.target.value)} placeholder={guest.hasEmail ? "✓" : ""} autoComplete="email" />
        </label>
        <label className="gp-field" htmlFor={id("phoneMobile")}>
          <span>{t(lang, "phoneMobile")}</span>
          <input {...a11y("phoneMobile")} type="tel" value={form.phoneMobile} onChange={(event) => set("phoneMobile", event.target.value)} placeholder={guest.hasPhoneMobile ? "✓" : "+34"} autoComplete="tel" />
        </label>
      </div>
      <label className="gp-field" htmlFor={id("residenceFullAddress")}>
        <span>{t(lang, "residenceFullAddress")}</span>
        <input {...a11y("residenceFullAddress")} type="text" value={form.residenceFullAddress} onChange={(event) => set("residenceFullAddress", event.target.value)} autoComplete="street-address" />
      </label>
      <div className="gp-grid-2">
        <label className="gp-field" htmlFor={id("residenceLocality")}>
          <span>{t(lang, "residenceLocality")}</span>
          <input {...a11y("residenceLocality")} type="text" value={form.residenceLocality} onChange={(event) => set("residenceLocality", event.target.value)} autoComplete="address-level2" />
        </label>
        <label className="gp-field" htmlFor={id("residenceCountry")}>
          <span>{t(lang, "residenceCountry")}</span>
          <input {...a11y("residenceCountry")} type="text" value={form.residenceCountry} onChange={(event) => set("residenceCountry", event.target.value)} maxLength={3} autoCapitalize="characters" autoComplete="country" />
        </label>
      </div>
      {guest.isMinor ? (
        <>
          <div className="gp-grid-2">
            <label className="gp-field" htmlFor={id("providedByCheckInGuestId")}>
              <span>{t(lang, "minorGuardian")}</span>
              <select {...a11y("providedByCheckInGuestId")} value={form.providedByCheckInGuestId} onChange={(event) => set("providedByCheckInGuestId", event.target.value)}>
                <option value="">{t(lang, "chooseAdult")}</option>
                {adults.map((adult) => (
                  <option key={adult.id} value={adult.id}>
                    {guestLabel(adult, lang)}
                  </option>
                ))}
              </select>
            </label>
            <label className="gp-field" htmlFor={id("kinship")}>
              <span>{t(lang, "kinship")}</span>
              <input {...a11y("kinship")} type="text" value={form.kinship} onChange={(event) => set("kinship", event.target.value)} />
            </label>
          </div>
          <label className="gp-field" htmlFor={id("guardianTitle")}>
            <span>{t(lang, "guardianTitle")}</span>
            <input {...a11y("guardianTitle")} type="text" value={form.guardianTitle} onChange={(event) => set("guardianTitle", event.target.value)} />
          </label>
        </>
      ) : null}
      <button type="submit" className="gp-button gp-button-primary" disabled={busy}>
        {busy ? t(lang, "saving") : t(lang, "saveTraveller")}
      </button>
    </form>
  );
}

function ConsentCard({ session, lang, busy, onConsent }: { session: Session; lang: Lang; busy: boolean; onConsent: (consent: { gdpr?: boolean; aiDisclosure?: boolean; marketing?: boolean; whatsappOptIn?: boolean }) => Promise<void> }) {
  const consent = session.consent;
  const policy = session.policy;
  const id = (field: string) => fieldId("consent", session.id, field);
  return (
    <section className="gp-card gp-consent" aria-busy={busy}>
      {policy.guestConsentText ? <p className="gp-meta" id={id("gdpr-text")}>{policy.guestConsentText}</p> : null}
      <label className="gp-check" htmlFor={id("gdpr")}>
        <input id={id("gdpr")} type="checkbox" checked={Boolean(consent.gdprAt)} disabled={busy} onChange={(event) => void onConsent({ gdpr: event.target.checked })} aria-required aria-describedby={policy.guestConsentText ? id("gdpr-text") : undefined} />
        <span>{t(lang, "consentGdpr")}</span>
      </label>
      {policy.aiDisclosureText ? <p className="gp-meta" id={id("ai-text")}>{policy.aiDisclosureText}</p> : null}
      <label className="gp-check" htmlFor={id("ai")}>
        <input id={id("ai")} type="checkbox" checked={Boolean(consent.aiDisclosureAt)} disabled={busy} onChange={(event) => void onConsent({ aiDisclosure: event.target.checked })} aria-describedby={policy.aiDisclosureText ? id("ai-text") : undefined} />
        <span>{t(lang, "consentAi")}</span>
      </label>
      <label className="gp-check" htmlFor={id("marketing")}>
        <input id={id("marketing")} type="checkbox" checked={consent.marketing} disabled={busy} onChange={(event) => void onConsent({ marketing: event.target.checked })} />
        <span>{t(lang, "consentMarketing")}</span>
      </label>
      <label className="gp-check" htmlFor={id("whatsapp")}>
        <input id={id("whatsapp")} type="checkbox" checked={Boolean(consent.whatsappOptInAt)} disabled={busy} onChange={(event) => void onConsent({ whatsappOptIn: event.target.checked })} />
        <span>{t(lang, "consentWhatsapp")}</span>
      </label>
    </section>
  );
}

// ── Paso 4 · Firma ────────────────────────────────────────────────────────────

/** Aviso del móvil tras «Firmar en recepción»: derivado de claves existentes (sin copy nuevo). */
export function deferredSignatureMessage(lang: Lang): string {
  return `${t(lang, "signatureMissing")} ${deferSignatureLabel(lang)}.`;
}

function SignatureStep({ session, lang, preparing, busyGuestId, kiosk, deferred, onSign, onDefer }: { session: Session; lang: Lang; preparing: boolean; busyGuestId: string | null; kiosk: boolean; deferred: Record<string, boolean>; onSign: (guestId: string, payload: SignaturePayload) => Promise<void>; onDefer: (guestId: string) => void }) {
  const [payloads, setPayloads] = useState<Record<string, SignaturePayload | null>>({});
  const pending = pendingSigners(session);
  return (
    <>
      <p className="gp-intro">{t(lang, "signatureIntro")}</p>
      <div aria-live="polite">{preparing ? <p className="gp-card gp-skeleton" role="status">{t(lang, "preparingRecords")}</p> : null}</div>
      {session.guests.map((guest) => {
        const headId = fieldId("sig", guest.id, "head");
        return (
          <section key={guest.id} className="gp-card gp-signature-card" aria-labelledby={headId} aria-busy={busyGuestId === guest.id}>
            <div className="gp-traveller-head">
              <strong id={headId}>{t(lang, "signatureFor", { name: guestLabel(guest, lang) })}</strong>
              {guest.isMinor ? <StatusPill label={t(lang, "travellerMinor")} tone="info" /> : isSigned(guest) ? <StatusPill label={t(lang, "statusReady")} tone="ok" /> : deferred[guest.id] ? <StatusPill label={t(lang, "statusHandedOff")} tone="info" /> : null}
            </div>
            {guest.isMinor ? (
              <p className="gp-meta">{t(lang, "signatureIntro")}</p>
            ) : isSigned(guest) ? (
              <p className="gp-meta">{t(lang, "signatureDone", { date: new Date(guest.updatedAt).toLocaleDateString(lang === "es" ? "es-ES" : "en-GB") })}</p>
            ) : !kiosk && deferred[guest.id] ? (
              // Móvil: aviso honesto; el parte lo cierra recepción a la llegada (recon §18 D6).
              <p className="gp-meta" role="status">{deferredSignatureMessage(lang)}</p>
            ) : pending.some((row) => row.id === guest.id) ? (
              <>
                <SignaturePad lang={lang} disabled={busyGuestId === guest.id || preparing || !guest.guestRegisterRecordId} onChange={(payload) => setPayloads((current) => ({ ...current, [guest.id]: payload }))} onDefer={() => onDefer(guest.id)} />
                <button type="button" className="gp-button gp-button-primary" disabled={!payloads[guest.id] || busyGuestId === guest.id || preparing || !guest.guestRegisterRecordId} onClick={() => void onSign(guest.id, payloads[guest.id]!)}>
                  {busyGuestId === guest.id ? t(lang, "saving") : t(lang, "sign")}
                </button>
              </>
            ) : null}
          </section>
        );
      })}
    </>
  );
}

// ── Paso 5 · Pago y extras ────────────────────────────────────────────────────

function PaymentStep({ session, lang, outcome, busy, onPay, onRefresh }: { session: Session; lang: Lang; outcome: PaymentLinkResponse | null; busy: boolean; onPay: () => void; onRefresh: () => Promise<void> }) {
  const balance = session.reservation ? formatMoney(session.reservation.balanceDue, session.reservation.currency) : null;
  const settled = session.paymentStatus === "paid" || session.paymentStatus === "authorized";
  let message: string;
  if (settled || outcome?.status === "settled") message = t(lang, "paymentSettled");
  else if (session.paymentStatus === "at_reception" || outcome?.status === "at_reception") message = t(lang, "paymentAtReception");
  else if (outcome?.status === "no_folio" || outcome?.status === "no_charges" || (session.balanceDue ?? 0) <= 0) message = t(lang, "paymentNothingDue");
  else if (outcome?.status === "link_sent" || session.paymentStatus === "link_sent") message = outcome?.status === "link_sent" ? t(lang, "paymentLinkReady") : t(lang, "paymentPending");
  else message = t(lang, "paymentPending");
  const titleId = fieldId("pay", session.id, "title");
  return (
    <>
      <section className="gp-card gp-payment" aria-labelledby={titleId} aria-busy={busy}>
        <p className="gp-label" id={titleId}>{t(lang, "paymentIntro")}</p>
        {balance && (session.balanceDue ?? 0) > 0 ? <p className="gp-value">{t(lang, "balanceDue", { amount: balance })}</p> : null}
        <p className="gp-payment-message" role="status">{busy && !outcome ? t(lang, "loading") : message}</p>
        {outcome?.status === "link_sent" ? (
          <button type="button" className="gp-button gp-button-primary" onClick={onPay} disabled={busy}>
            {t(lang, "payNow")}
          </button>
        ) : null}
        {session.paymentStatus === "link_sent" ? (
          <button type="button" className="gp-button gp-button-ghost" onClick={() => void onRefresh()} disabled={busy}>
            {t(lang, "checkPayment")}
          </button>
        ) : null}
      </section>
      {session.offers && session.offers.length > 0 ? (
        <section className="gp-card gp-extras" aria-labelledby={fieldId("pay", session.id, "extras")}>
          <p className="gp-label" id={fieldId("pay", session.id, "extras")}>{t(lang, "extrasTitle")}</p>
          <p className="gp-meta">{t(lang, "extrasIntro")}</p>
          <ul className="gp-offers">
            {session.offers.map((offer) => (
              <li key={offer.id}>
                <span>{offer.title}</span>
                {typeof offer.price === "number" ? <span className="gp-meta">{formatMoney(offer.price, offer.currency ?? session.reservation?.currency ?? "EUR")}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

// ── Paso 6 · Llegada ──────────────────────────────────────────────────────────

function ArrivalStep({ session, lang, kiosk, busy, otp, onSavePreferences, onRequestOtp, onVerifyOtp, onArrive, inlineError }: { session: Session; lang: Lang; kiosk: boolean; busy: boolean; otp: OtpRequestResponse | null; onSavePreferences: (eta: string | null, preferences: string[]) => Promise<void>; onRequestOtp: (channel: OtpChannel) => Promise<void>; onVerifyOtp: (code: string) => Promise<void>; onArrive: () => Promise<void>; inlineError: string | null }) {
  const [eta, setEta] = useState(session.etaDeclared ?? "");
  const [preferences, setPreferences] = useState<string[]>(session.preferences);
  const [code, setCode] = useState("");
  const [verified, setVerified] = useState(false);
  const channels = otpChannelsFor(session.policy);
  const primary = primaryGuestOf(session);
  const otpRequired = !kiosk && needsOtp(session) && !verified;
  // Identidad ya resuelta en línea: verificación fechada por un método admitido, o
  // MRZ con dígitos de control válidos cuando la política admite mrz_checksum.
  const identityOk = verified || Boolean(primary?.identityVerifiedAt) || (primary?.identityVerificationMethod === "mrz_checksum" && session.policy.allowedVerificationMethods.includes("mrz_checksum"));
  const prefsDirty = eta !== (session.etaDeclared ?? "") || preferences.join(",") !== session.preferences.join(",");
  // Sesión ya cerrada (llegada registrada / alojada / en recepción): nada que editar ni volver a llegar.
  const closed = (ARRIVED_SESSION_STATUSES as readonly string[]).includes(session.status);
  const id = (field: string) => fieldId("arr", session.id, field);

  async function verify() {
    await onVerifyOtp(code);
    setVerified(true);
    setCode("");
  }

  if (closed) {
    return (
      <section className="gp-card gp-success" role="status">
        <StatusPill label={sessionStatusLabel(session.status, lang)} tone={session.status === "checked_in" ? "ok" : "info"} />
        <p>{session.status === "checked_in" ? t(lang, "alreadyCheckedIn") : t(lang, "identityAtReception")}</p>
      </section>
    );
  }

  return (
    <>
      <p className="gp-intro">{t(lang, "arrivalIntro")}</p>
      {!kiosk ? (
        <section className="gp-card gp-form" aria-labelledby={id("prefs-title")} aria-busy={busy}>
          <label className="gp-field" htmlFor={id("eta")}>
            <span>{t(lang, "eta")}</span>
            <input id={id("eta")} type="time" value={eta} onChange={(event) => setEta(event.target.value)} />
          </label>
          <p className="gp-label" id={id("prefs-title")}>{t(lang, "preferences")}</p>
          <div className="gp-chips" role="group" aria-labelledby={id("prefs-title")}>
            {PREFERENCE_OPTIONS.map((option) => (
              <button key={option.code} type="button" className={`gp-chip${preferences.includes(option.code) ? " is-active" : ""}`} aria-pressed={preferences.includes(option.code)} onClick={() => setPreferences((current) => togglePreference(current, option.code))}>
                {lang === "es" ? option.es : option.en}
              </button>
            ))}
          </div>
          <button type="button" className="gp-button gp-button-ghost" disabled={busy || !prefsDirty} onClick={() => void onSavePreferences(eta || null, preferences)}>
            {t(lang, "savePreferences")}
          </button>
        </section>
      ) : null}

      {!kiosk && channels.length > 0 && (otpRequired || verified || Boolean(primary?.identityVerifiedAt)) ? (
        <section className="gp-card gp-otp" aria-labelledby={id("otp-title")} aria-busy={busy}>
          <p className="gp-label" id={id("otp-title")}>{t(lang, "otpTitle")}</p>
          {identityOk ? (
            <p role="status">
              <StatusPill label={t(lang, "otpVerified")} tone="ok" />
            </p>
          ) : (
            <>
              <p className="gp-meta">{t(lang, "otpIntro")}</p>
              <div aria-live="polite">
                {otp ? (
                  <>
                    <p className="gp-meta" id={id("otp-sent")}>{t(lang, "otpSentTo", { recipient: otp.recipient })}</p>
                    {otp.debugCode ? <p className="gp-hint">{t(lang, "otpDebug", { code: otp.debugCode })}</p> : null}
                  </>
                ) : null}
              </div>
              {otp ? (
                <>
                  <label className="gp-field" htmlFor={id("otp-code")}>
                    <span>{t(lang, "otpCode")}</span>
                    <input id={id("otp-code")} type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(event) => setCode(event.target.value)} aria-describedby={id("otp-sent")} />
                  </label>
                  <button type="button" className="gp-button gp-button-primary" disabled={busy || code.replace(/\D/g, "").length !== 6} onClick={() => void verify()}>
                    {t(lang, "otpVerify")}
                  </button>
                </>
              ) : null}
              <div className="gp-stacked">
                {channels.map((channel) => (
                  <button key={channel} type="button" className="gp-button gp-button-ghost" disabled={busy} onClick={() => void onRequestOtp(channel)}>
                    {t(lang, channel === "email" ? "otpByEmail" : "otpByPhone")}
                  </button>
                ))}
              </div>
            </>
          )}
        </section>
      ) : null}
      {!kiosk && !identityOk && !otpRequired ? <p className="gp-meta">{t(lang, "identityAtReception")}</p> : null}

      <div aria-live="polite">{inlineError ? <p className="gp-error" role="alert">{inlineError}</p> : null}</div>
      <section className="gp-card gp-arrive" aria-busy={busy}>
        <p className="gp-meta" id={id("arrive-hint")}>{t(lang, "arriveHint")}</p>
        <button type="button" className="gp-button gp-button-primary gp-button-big" disabled={busy} onClick={() => void onArrive()} aria-describedby={id("arrive-hint")}>
          {busy ? t(lang, "saving") : t(lang, "arriveNow")}
        </button>
      </section>
    </>
  );
}

// ── Página ────────────────────────────────────────────────────────────────────

export function CheckInWizardPage({ lang, onLangChange, onBack, onArrived, kiosk = null }: CheckInWizardPageProps) {
  const { session: guestSession } = useGuestSession();
  const [session, setSession] = useState<Session | null>(null);
  const [step, setStep] = useState<WizardStep>("travellers");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notInvited, setNotInvited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyGuestId, setBusyGuestId] = useState<string | null>(null);
  const [captures, setCaptures] = useState<Record<string, DocumentCapture>>({});
  const [unreadable, setUnreadable] = useState<Record<string, boolean>>({});
  /** Discrepancia de nombre en la última lectura (corrector REV3-05): el documento no se aplicó. */
  const [mismatch, setMismatch] = useState<Record<string, boolean>>({});
  const [serverMissing, setServerMissing] = useState<Record<string, string[]>>({});
  const [preparing, setPreparing] = useState(false);
  const [payment, setPayment] = useState<PaymentLinkResponse | null>(null);
  const [otp, setOtp] = useState<OtpRequestResponse | null>(null);
  const [arrivalError, setArrivalError] = useState<string | null>(null);
  /** Firmas que el huésped dejó para recepción («Firmar en recepción», solo móvil; estado de la pestaña). */
  const [deferredSignatures, setDeferredSignatures] = useState<Record<string, boolean>>({});
  const reservationRef = useRef<ReservationSummary | null>(null);
  const preparedRef = useRef(false);
  const paymentAskedRef = useRef(false);
  const titleRef = useRef<HTMLElement | null>(null);
  const focusedStepRef = useRef<WizardStep | null>(null);
  // L7-05 (WCAG 3.2.2 On Input): cambiar de idioma NO recarga la sesión ni devuelve al
  // primer paso incompleto; `load` lee el idioma por ref para no depender de él.
  const langRef = useRef<Lang>(lang);
  langRef.current = lang;

  const apply = useCallback((next: CheckInSession) => {
    setSession(withReservation(next, reservationRef.current));
  }, []);

  const load = useCallback(async () => {
    if (!guestSession) return;
    setLoading(true);
    setError(null);
    setNotInvited(false);
    try {
      const [reservation, checkIn] = await Promise.all([getReservation(guestSession.reservationId).catch(() => null), getCheckIn()]);
      reservationRef.current = reservation;
      const merged = withReservation(checkIn, reservation);
      setSession(merged);
      setStep(initialStep(merged));
    } catch (err) {
      if (isApiError(err) && (err.status === 401 || err.status === 403 || err.status === 404)) setNotInvited(true);
      else setError(errorMessage(err, langRef.current));
    } finally {
      setLoading(false);
    }
  }, [guestSession]);

  useEffect(() => {
    void load();
  }, [load]);

  // L7-05 (2.4.3): al cargar y en cada cambio de paso el foco va al título del paso.
  const ready = !loading && session !== null;
  useEffect(() => {
    if (!ready || focusedStepRef.current === step) return;
    focusedStepRef.current = step;
    titleRef.current?.focus({ preventScroll: false });
  }, [ready, step]);

  async function run<T>(work: () => Promise<T>, guestId: string | null = null): Promise<T | undefined> {
    setBusy(true);
    setBusyGuestId(guestId);
    setError(null);
    try {
      return await work();
    } catch (err) {
      setError(errorMessage(err, lang));
      return undefined;
    } finally {
      setBusy(false);
      setBusyGuestId(null);
    }
  }

  // ── Viajeros ──
  const saveGuest = async (id: string, input: GuestInput) => {
    await run(async () => {
      const result = await patchGuest(id, input);
      setServerMissing((current) => ({ ...current, [id]: result.missing }));
      apply(result.session);
    }, id);
  };
  const removeTraveller = async (id: string) => {
    await run(async () => apply((await removeGuest(id)).session), id);
  };
  const addTraveller = async () => {
    await run(async () => apply((await addGuest({})).session));
  };

  // ── Documento ──
  const captureImage = async (guestId: string, dataUrl: string, documentType: string) => {
    setUnreadable((current) => ({ ...current, [guestId]: false }));
    await run(async () => {
      try {
        const result = await uploadDocument(guestId, dataUrl, { documentType });
        setCaptures((current) => ({ ...current, [guestId]: result.capture }));
        apply(result.session);
      } catch (err) {
        if (isApiError(err, "DOCUMENT_UNREADABLE")) {
          setUnreadable((current) => ({ ...current, [guestId]: true }));
          return;
        }
        throw err;
      }
    }, guestId);
  };
  const captureMrz = async (guestId: string, lines: string[]) => {
    await run(async () => {
      const result = await submitMrz(guestId, lines);
      const warnings = result.warnings ?? [];
      const mismatch = result.capture.needsReview.includes("identity_mismatch");
      // Corrector REV3-05: con discrepancia de nombre el API NO aplica los datos; la captura queda para el cotejo.
      setCaptures((current) => ({ ...current, [guestId]: { captureId: result.capture.id, fields: result.capture.fields, confidence: Object.fromEntries(Object.keys(result.capture.fields).map((key) => [key, 1])), checks: result.capture.checks, source: "mrz_reader", mrzFormat: result.capture.format, needsReview: result.capture.needsReview, warnings, persisted: true } }));
      setMismatch((current) => ({ ...current, [guestId]: mismatch }));
      if (!mismatch) setServerMissing((current) => ({ ...current, [guestId]: result.missing }));
      setUnreadable((current) => ({ ...current, [guestId]: false }));
      apply((await getCheckIn()));
    }, guestId);
  };

  // ── Datos ──
  const saveConsent = async (consent: { gdpr?: boolean; aiDisclosure?: boolean; marketing?: boolean; whatsappOptIn?: boolean }) => {
    await run(async () => apply(await patchCheckIn({ consent })));
  };

  // ── Firma: los partes se crean al cerrar el pre-check-in ──
  useEffect(() => {
    if (step !== "signature" || !session || preparedRef.current) return;
    if (session.guests.every((guest) => Boolean(guest.guestRegisterRecordId))) return;
    preparedRef.current = true;
    setPreparing(true);
    void (async () => {
      try {
        apply(await completeCheckIn());
      } catch (err) {
        if (isApiError(err, "CHECKIN_INCOMPLETE")) {
          const missing = (err.details?.missing as Array<{ checkInGuestId?: string; fields?: string[] }> | undefined) ?? [];
          setServerMissing((current) => {
            const next = { ...current };
            for (const row of missing) if (row.checkInGuestId) next[row.checkInGuestId] = row.fields ?? [];
            return next;
          });
          setError(t(lang, "signatureNeedsData"));
          setStep("details");
        } else {
          setError(errorMessage(err, lang));
        }
        preparedRef.current = false;
      } finally {
        setPreparing(false);
      }
    })();
  }, [step, session, apply, lang]);

  const sign = async (guestId: string, payload: SignaturePayload) => {
    await run(async () => {
      await signGuest(guestId, payload);
      apply(await getCheckIn());
    }, guestId);
  };

  // ── Pago ──
  useEffect(() => {
    if (step !== "payment" || !session || paymentAskedRef.current) return;
    if (session.paymentStatus === "paid" || session.paymentStatus === "authorized" || session.paymentStatus === "at_reception") return;
    paymentAskedRef.current = true;
    void run(async () => {
      const returnUrl = typeof window !== "undefined" && /^https?:/.test(window.location.href) ? window.location.href : undefined;
      const outcome = await requestPaymentLink(returnUrl ? { returnUrl } : {});
      setPayment(outcome);
      apply(await getCheckIn());
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, session?.id]);

  const pay = () => {
    if (!payment || payment.status !== "link_sent") return;
    const redirect = payment.link.redirect;
    if (redirect.method === "GET") {
      window.location.assign(redirect.url);
      return;
    }
    const form = document.createElement("form");
    form.method = "POST";
    form.action = redirect.url;
    for (const [name, value] of Object.entries(redirect.fields)) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      input.value = value;
      form.appendChild(input);
    }
    document.body.appendChild(form);
    form.submit();
  };

  // ── Llegada ──
  const savePreferences = async (eta: string | null, preferences: string[]) => {
    await run(async () => apply(await patchCheckIn({ eta, preferences })));
  };
  const askOtp = async (channel: OtpChannel) => {
    await run(async () => setOtp(await requestOtp(channel)));
  };
  const checkOtp = async (code: string) => {
    await run(async () => {
      await verifyOtp(code);
      setOtp(null);
      apply(await getCheckIn());
    });
  };
  /**
   * POST /guest-portal/check-in/arrive. `handoff` fuerza el ticket del kiosco
   * aunque el 409 no sea de handoff (el huésped pidió terminar en recepción).
   */
  const doArrive = async (handoff = false) => {
    setArrivalError(null);
    setBusy(true);
    const at = new Date().toISOString();
    // Corrector REV3-14: la validez de la llave se muestra en la hora del hotel.
    const timeZone = reservationRef.current?.propertyTimezone;
    try {
      const data = await arrive(null);
      onArrived({ ok: true, data, at, ...(timeZone ? { timeZone } : {}) });
    } catch (err) {
      if (isApiError(err)) {
        onArrived({ ok: false, code: err.code, message: err.message, details: err.details, at, ...(timeZone ? { timeZone } : {}), ...(handoff ? { handoff: true } : {}) });
      } else {
        setArrivalError(errorMessage(err, lang));
      }
    } finally {
      setBusy(false);
    }
  };

  /**
   * Corrector L7-REV-05: «Firmar en recepción» en el kiosco deriva la sesión en
   * el SERVIDOR (POST /guest-portal/check-in/handoff → handed_off · signature_pending
   * · ticket K-nnnn · kioskDeviceId · auditoría; recepción lo ve en su cola). La
   * pantalla de llegada solo pinta el ticket que devuelve esa ruta.
   */
  const handoffAtReception = async () => {
    setError(null);
    setBusy(true);
    const at = new Date().toISOString();
    const timeZone = reservationRef.current?.propertyTimezone;
    try {
      const result = await handoffCheckIn("signature");
      onArrived({ ok: false, code: "SIGNATURE_AT_RECEPTION", message: t(lang, "handoffSignatureMessage"), details: { handoffKind: result.handoffKind, ticket: result.ticket, sessionId: result.sessionId }, at, ...(timeZone ? { timeZone } : {}), handoff: true, ticket: result.ticket });
    } catch (err) {
      setError(isApiError(err) && err.message ? err.message : t(lang, "handoffError"));
    } finally {
      setBusy(false);
    }
  };

  // ── Firma en recepción (2.5.7 · D6) ──
  const deferSignature = (guestId: string) => {
    if (kiosk) {
      // Kiosco: el huésped está en el hotel → la derivación se registra en el servidor y
      // la página de llegada muestra el ticket que devuelve el API.
      void handoffAtReception();
      return;
    }
    setDeferredSignatures((current) => ({ ...current, [guestId]: true }));
  };

  // ── Navegación ──
  const goNext = () => {
    if (!session) return;
    const next = nextStep(step, session);
    if (next) setStep(next);
  };
  const goPrev = () => {
    const previous = prevStep(step);
    if (previous) setStep(previous);
  };

  const footer = <p className="gp-disclosure">{t(lang, "retention")}</p>;
  const reservationCode = session?.reservation?.reservationCode ?? guestSession?.reservationCode;

  if (loading) {
    return (
      <Layout eyebrow={t(lang, "wizardEyebrow")} title={t(lang, "wizardTitle")} reservationCode={reservationCode} back={{ label: t(lang, "backToStay"), onClick: onBack }} footer={footer}>
        <div className="gp-card gp-skeleton" role="status" aria-live="polite">{t(lang, "loading")}</div>
      </Layout>
    );
  }

  if (notInvited || !session) {
    return (
      <Layout eyebrow={t(lang, "wizardEyebrow")} title={t(lang, "wizardTitle")} reservationCode={reservationCode} back={{ label: t(lang, "backToStay"), onClick: onBack }} footer={footer}>
        <div className="gp-card gp-error" role="alert">{notInvited ? t(lang, "notInvited") : (error ?? t(lang, "genericError"))}</div>
        <button type="button" className="gp-button gp-button-ghost" onClick={() => void load()}>
          {t(lang, "retry")}
        </button>
      </Layout>
    );
  }

  const isKiosk = Boolean(kiosk);
  // Móvil: con todas las firmas pendientes dejadas para recepción se puede seguir (el API sigue mandando en la llegada).
  const allDeferred = !isKiosk && step === "signature" && session.guests.every((guest) => Boolean(guest.guestRegisterRecordId)) && pendingSigners(session).length > 0 && pendingSigners(session).every((guest) => deferredSignatures[guest.id]);
  const advance = canAdvance(session, step) || allDeferred;

  return (
    <Layout
      eyebrow={t(lang, "wizardEyebrow")}
      title={t(lang, "wizardTitle")}
      subtitle={t(lang, "wizardSubtitle")}
      propertyName={session.reservation?.propertyName}
      reservationCode={reservationCode}
      back={{ label: isKiosk ? t(lang, "kioskFinish") : t(lang, "backToStay"), onClick: onBack }}
      footer={footer}
    >
      <div className={`gp-wizard${isKiosk ? " gp-wizard-kiosk" : ""}`} aria-busy={busy || preparing}>
        <StepProgress step={step} lang={lang} onLangChange={onLangChange} titleRef={titleRef} />
        <p className="gp-visually-hidden" role="status">{busy ? t(lang, "saving") : ""}</p>
        <div aria-live="polite">{error ? <p className="gp-error" role="alert">{error}</p> : null}</div>

        {step === "travellers" ? <TravellersStep session={session} lang={lang} busy={busy} onSave={saveGuest} onRemove={removeTraveller} onAdd={addTraveller} /> : null}
        {step === "document" ? <DocumentStep session={session} lang={lang} captures={captures} unreadable={unreadable} mismatch={mismatch} busyGuestId={busyGuestId} onImage={captureImage} onMrz={captureMrz} /> : null}
        {step === "details" ? (
          <>
            <p className="gp-intro">{t(lang, "detailsIntro")}</p>
            {session.guests.map((guest) => (
              <DetailsCard key={guest.id} guest={guest} session={session} lang={lang} capture={captures[guest.id]} serverMissing={serverMissing[guest.id] ?? []} busy={busyGuestId === guest.id} onSave={saveGuest} />
            ))}
            <ConsentCard session={session} lang={lang} busy={busy} onConsent={saveConsent} />
          </>
        ) : null}
        {step === "signature" ? <SignatureStep session={session} lang={lang} preparing={preparing} busyGuestId={busyGuestId} kiosk={isKiosk} deferred={deferredSignatures} onSign={sign} onDefer={deferSignature} /> : null}
        {step === "payment" ? <PaymentStep session={session} lang={lang} outcome={payment} busy={busy} onPay={pay} onRefresh={async () => apply(await getCheckIn())} /> : null}
        {step === "arrival" ? <ArrivalStep session={session} lang={lang} kiosk={isKiosk} busy={busy} otp={otp} onSavePreferences={savePreferences} onRequestOtp={askOtp} onVerifyOtp={checkOtp} onArrive={() => doArrive()} inlineError={arrivalError} /> : null}

        <nav className="gp-wizard-nav" aria-label={t(lang, "wizardEyebrow")}>
          <button type="button" className="gp-button gp-button-ghost" onClick={goPrev} disabled={busy || !prevStep(step)}>
            {t(lang, "back")}
          </button>
          {step !== "arrival" ? (
            <button type="button" className="gp-button gp-button-primary" onClick={goNext} disabled={busy || !advance}>
              {t(lang, "next")}
            </button>
          ) : null}
        </nav>

        {/* Tanda CHK · corrector REV3-10: chat con el recepcionista IA también desde el asistente (no en el kiosco). */}
        {!isKiosk ? <ChatWidget lang={lang} propertyName={session.reservation?.propertyName} /> : null}
      </div>
    </Layout>
  );
}
