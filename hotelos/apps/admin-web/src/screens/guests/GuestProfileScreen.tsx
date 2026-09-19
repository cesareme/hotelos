// Ficha del huésped — Recepción › Huéspedes › Ficha (/recepcion/huespedes/:id · /new).
//
// Cocoa 22 (ola 3 · lote 3-C): CocoaPage (hosted inside HuespedesTabs the
// container paints «Huéspedes» and the tabs Listado · Ficha · Cronología;
// standalone the page paints the guest's name) → CocoaKpiStrip (stays,
// lifetime value, VIP, loyalty) → four CocoaFormSections (identity, contact,
// residence, loyalty and preferences) with CocoaField + CocoaInput / Select /
// DatePicker / Switch → CocoaActionBar (Crear huésped · Guardar cambios,
// ⌘/Ctrl+Enter, status text) → «Estancias» CocoaTable (a row opens the
// reservation). Same API: fetchGuest, createGuest, updateGuest; the `:id`
// comes from the tab URL (useRouteParam) and `new` opens an empty form.
//
// Tanda UX-1 · lote U8 (§5.8): barra de comandos en la cabecera — primaria
// «Abrir la estancia de hoy» si el huésped está en el hotel, si no «Nueva
// reserva para este huésped» (prefill por `?guestId=`, U9a) — y `keepData`:
// una recarga o un guardado nunca vacían la ficha ni las estancias (el
// esqueleto solo sale la primera vez). Sin cambios de estructura.

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { urlForScreen } from "../../navigation/nav-tree";
import { createGuest, fetchGuest, updateGuest, type GuestDetail, type GuestInput, type GuestStay } from "../../services/guestsApi";
import { useToast } from "../../components/Toast";
import { useTabHost } from "../tabs/TabHost";
import { useRouteParam } from "../tabs/tab-helpers";
import { reservationStatus } from "../../content/status-dictionary";
import { EMPTY, date, money, number, plural } from "../../lib/format";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import {
  CocoaActionBar,
  CocoaBadge,
  CocoaStatusBadge,
  CocoaButton,
  CocoaDatePicker,
  CocoaField,
  CocoaFormRow,
  CocoaFormSection,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaSkeleton,
  CocoaState,
  CocoaSwitch,
  CocoaTable,
  openTabPath,
  type CocoaTableColumn
} from "../../components/cocoa";

const FICHA_URL = urlForScreen("GuestDetail") ?? "/recepcion/huespedes/:id";
const LIST_URL = urlForScreen("GuestsList") ?? "/recepcion/huespedes";
/** Nueva reserva (modo rápido) con el huésped prefijado (`?guestId=`, lo lee ReservationCreateScreen en U9a). */
const NEW_RESERVATION_URL = urlForScreen("ReservationCreate") ?? "/recepcion/reservas/nueva";
const OPEN_TODAY_STAY = "Abrir la estancia de hoy";
const NEW_RESERVATION_FOR_GUEST = "Nueva reserva para este huésped";

// A real «none» choice is an explicit { value: "", label } option (never a placeholder).
const TITLE_OPTIONS = ["", "Sr.", "Sra.", "Srta.", "Dr.", "Dra.", "Mr.", "Mrs.", "Ms.", "Mx."].map((t) => ({ value: t, label: t || EMPTY }));
const SEX_OPTIONS = [
  { value: "", label: EMPTY },
  { value: "M", label: "Hombre" },
  { value: "F", label: "Mujer" },
  { value: "X", label: "No especificado" }
];
const DOC_OPTIONS = ["", "DNI", "NIE", "PASSPORT", "TIE"].map((d) => ({ value: d, label: d || EMPTY }));
const LANG_OPTIONS = [
  { value: "", label: EMPTY },
  { value: "es", label: "Español" },
  { value: "en", label: "English" },
  { value: "fr", label: "Français" },
  { value: "de", label: "Deutsch" },
  { value: "it", label: "Italiano" },
  { value: "pt", label: "Português" }
];

type FormState = Record<string, string> & { marketingConsent?: string };

const EMPTY_FORM: FormState = {
  title: "", firstName: "", middleName: "", surname1: "", surname2: "",
  documentType: "", documentNumber: "", documentSupportNumber: "", documentIssueCountry: "", documentExpiryDate: "",
  nationality: "", sex: "", languagePreference: "", dateOfBirth: "",
  residenceAddress: "", residenceLocality: "", residenceProvince: "", residencePostalCode: "", residenceCountry: "",
  phone: "", mobilePhone: "", email: "", company: "",
  vipCode: "", loyaltyProgram: "", loyaltyNumber: "", loyaltyTier: "",
  preferences: "", emergencyContactName: "", emergencyContactPhone: "", marketingConsent: "", notes: ""
};

/** Last path segment: the legacy standalone route names the guest the same way as the tab URL. */
function currentGuestId(): string {
  return window.location.pathname.split("/").filter(Boolean).at(-1) ?? "new";
}

function buildInput(form: FormState): GuestInput {
  return {
    title: form.title || undefined,
    firstName: form.firstName,
    middleName: form.middleName || undefined,
    surname1: form.surname1 || undefined,
    surname2: form.surname2 || undefined,
    documentType: form.documentType || undefined,
    documentNumber: form.documentNumber || undefined,
    documentSupportNumber: form.documentSupportNumber || undefined,
    documentIssueCountry: form.documentIssueCountry || undefined,
    documentExpiryDate: form.documentExpiryDate || undefined,
    nationality: form.nationality || undefined,
    sex: form.sex || undefined,
    languagePreference: form.languagePreference || undefined,
    dateOfBirth: form.dateOfBirth || undefined,
    residenceAddress: form.residenceAddress || undefined,
    residenceLocality: form.residenceLocality || undefined,
    residenceProvince: form.residenceProvince || undefined,
    residencePostalCode: form.residencePostalCode || undefined,
    residenceCountry: form.residenceCountry || undefined,
    phone: form.phone || undefined,
    mobilePhone: form.mobilePhone || undefined,
    email: form.email || undefined,
    company: form.company || undefined,
    vipCode: form.vipCode || undefined,
    loyaltyProgram: form.loyaltyProgram || undefined,
    loyaltyNumber: form.loyaltyNumber || undefined,
    loyaltyTier: form.loyaltyTier || undefined,
    preferences: form.preferences ? form.preferences.split(",").map((p) => p.trim()).filter(Boolean) : [],
    emergencyContactName: form.emergencyContactName || undefined,
    emergencyContactPhone: form.emergencyContactPhone || undefined,
    marketingConsent: form.marketingConsent === "yes",
    notes: form.notes || undefined
  };
}

const STAY_COLUMNS: CocoaTableColumn<GuestStay>[] = [
  { key: "code", label: "Reserva", fit: true, render: (s) => <strong className="cocoa-mono">{s.code}</strong> },
  { key: "status", label: "Estado", fit: true, render: (s) => <CocoaStatusBadge entry={reservationStatus(s.status)} /> },
  { key: "arrivalDate", label: "Entrada", fit: true, render: (s) => (s.arrivalDate ? date(s.arrivalDate, "medium") : EMPTY) },
  { key: "departureDate", label: "Salida", fit: true, hideOnNarrow: true, render: (s) => (s.departureDate ? date(s.departureDate, "medium") : EMPTY) },
  { key: "totalAmount", label: "Importe", align: "right", fit: true, render: (s) => money(s.totalAmount, s.currency) },
  { key: "isPrimary", label: "Rol", fit: true, hideOnNarrow: true, render: (s) => (s.isPrimary ? "Titular" : "Acompañante") }
];

const CLIP: CSSProperties = { overflow: "clip" };

function openReservation(id: string) {
  openTabPath(urlForScreen("ReservationDetailWorkspace", { id }) ?? "/recepcion/reservas");
}

type FieldProps = {
  label: string;
  k: string;
  form: FormState;
  set: (k: string, v: string) => void;
  type?: "text" | "email" | "date";
  hint?: string;
  required?: boolean;
  error?: string;
};

/** Text, email or date control bound to one key of the form. */
function Field(props: FieldProps) {
  const value = props.form[props.k] ?? "";
  return (
    <CocoaField label={props.label} required={props.required} help={props.hint} error={props.error}>
      {props.type === "date" ? (
        <CocoaDatePicker value={value} onChange={(v) => props.set(props.k, v)} />
      ) : (
        <CocoaInput type={props.type ?? "text"} inputMode={props.type === "email" ? "email" : undefined} value={value} onChange={(v) => props.set(props.k, v)} autoComplete="off" />
      )}
    </CocoaField>
  );
}

function ProfileSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={4} />
      <CocoaSkeleton variant="card" height={220} />
      <CocoaSkeleton variant="card" height={160} />
    </div>
  );
}

export function GuestProfileScreen() {
  const hosted = useTabHost() !== null;
  const routeId = useRouteParam(FICHA_URL, "id");
  const guestId = routeId ?? currentGuestId();
  const isNew = guestId === "new";
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [detail, setDetail] = useState<GuestDetail | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [nameMissing, setNameMissing] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const { showToast } = useToast();

  useEffect(() => {
    if (guestId === "new") {
      setForm(EMPTY_FORM);
      setDetail(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    fetchGuest(guestId)
      .then((d) => {
        setDetail(d);
        const g = d.guest;
        setForm({
          ...EMPTY_FORM,
          title: g.title ?? "", firstName: g.firstName ?? "", middleName: g.middleName ?? "",
          surname1: g.surname1 ?? "", surname2: g.surname2 ?? "",
          documentType: g.documentType ?? "", documentNumber: g.documentNumber ?? "",
          documentSupportNumber: g.documentSupportNumber ?? "", documentIssueCountry: g.documentIssueCountry ?? "",
          documentExpiryDate: g.documentExpiryDate ?? "", nationality: g.nationality ?? "", sex: g.sex ?? "",
          languagePreference: g.languagePreference ?? "", dateOfBirth: g.dateOfBirth ?? "",
          residenceAddress: g.residenceAddress ?? "", residenceLocality: g.residenceLocality ?? "",
          residenceProvince: g.residenceProvince ?? "", residencePostalCode: g.residencePostalCode ?? "",
          residenceCountry: g.residenceCountry ?? "", phone: g.phone ?? "", mobilePhone: g.mobilePhone ?? "",
          email: g.email ?? "", company: g.company ?? "", vipCode: g.vipCode ?? "",
          loyaltyProgram: g.loyaltyProgram ?? "", loyaltyNumber: g.loyaltyNumber ?? "", loyaltyTier: g.loyaltyTier ?? "",
          preferences: (g.preferences ?? []).join(", "),
          emergencyContactName: g.emergencyContactName ?? "", emergencyContactPhone: g.emergencyContactPhone ?? "",
          marketingConsent: g.marketingConsent ? "yes" : "", notes: g.notes ?? ""
        });
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "No se pudo cargar el huésped"))
      .finally(() => setLoading(false));
  }, [guestId, reloadNonce]);

  function set(k: string, v: string) {
    if (k === "firstName" && v.trim()) setNameMissing(false);
    setForm((cur) => ({ ...cur, [k]: v }));
  }

  async function handleSave() {
    if (!form.firstName.trim()) {
      setNameMissing(true);
      setStatus("El nombre es obligatorio.");
      return;
    }
    setSaving(true);
    setStatus(isNew ? "Creando huésped…" : STATUS_LABELS.saving);
    try {
      const input = buildInput(form);
      if (isNew) {
        const created = await createGuest(input);
        setStatus(`Huésped ${created.fullName} creado.`);
        showToast(`Huésped ${created.fullName} creado.`, { variant: "success" });
        openTabPath(urlForScreen("GuestDetail", { id: created.id }) ?? LIST_URL);
      } else {
        const updated = await updateGuest(guestId, input);
        // keepData: el título y el resumen reflejan lo guardado sin recargar la ficha.
        setDetail((current) => (current ? { ...current, guest: updated } : current));
        setStatus(`Cambios guardados (${updated.fullName}).`);
        showToast(STATUS_LABELS.saved, { variant: "success" });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "No se pudo guardar.";
      setStatus(message);
      showToast(message, { variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  const lifetime = useMemo(() => detail?.stats.lifetimeValue ?? 0, [detail]);
  const guestName = isNew ? "Nuevo huésped" : detail?.guest.fullName || form.firstName || "Huésped";
  const stays = detail?.stayHistory ?? [];
  const primaryLabel = isNew ? "Crear huésped" : ACTIONS.saveChanges;
  // Barra de comandos (§5.8): la estancia en el hotel manda; si no la hay, una reserva nueva con el huésped prefijado.
  const currentStay = stays.find((stay) => stay.status === "checked_in") ?? null;
  const openNewReservation = () => openTabPath(`${NEW_RESERVATION_URL}?guestId=${encodeURIComponent(guestId)}`);
  const headerCommand = isNew || !detail ? null : currentStay ? { label: OPEN_TODAY_STAY, run: () => openReservation(currentStay.id) } : { label: NEW_RESERVATION_FOR_GUEST, run: openNewReservation };

  return (
    <CocoaPage
      eyebrow="Recepción · Huéspedes"
      title={guestName}
      subtitle={hosted ? undefined : isNew ? "Alta de un perfil de huésped: identidad, contacto, residencia y fidelización." : "Identidad, contacto, residencia, fidelización y estancias del huésped."}
      actions={
        <>
          {headerCommand ? (
            <CocoaButton variant="filled" tone="accent" size="small" onClick={headerCommand.run}>
              {headerCommand.label}
            </CocoaButton>
          ) : null}
          {headerCommand && currentStay ? (
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={openNewReservation}>
              {NEW_RESERVATION_FOR_GUEST}
            </CocoaButton>
          ) : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => openTabPath(LIST_URL)}>
            Volver al listado
          </CocoaButton>
        </>
      }
      state={loading && !detail ? "loading" : error && !detail ? "error" : "ready"}
      skeleton={<ProfileSkeleton />}
      error={{ title: "No se pudo cargar el huésped", message: error ?? undefined, onRetry: () => setReloadNonce((n) => n + 1) }}
      commands={[
        { id: "guest-profile-save", label: primaryLabel, run: () => void handleSave() },
        ...(headerCommand ? [{ id: "guest-profile-primary", label: headerCommand.label, run: headerCommand.run }] : []),
        { id: "guest-profile-back", label: "Volver al listado de huéspedes", run: () => openTabPath(LIST_URL) }
      ]}
    >
      {!isNew && detail ? (
        <CocoaKpiStrip stagger aria-label="Resumen del huésped">
          <CocoaKpi label="Estancias" value={number(detail.stats.stays)} polarity="neutral" />
          <CocoaKpi label="Valor de vida" value={money(lifetime)} caption="Gasto acumulado" polarity="neutral" />
          <CocoaKpi label="VIP" value={detail.guest.vipCode ?? EMPTY} polarity="neutral" />
          <CocoaKpi label="Fidelización" value={detail.guest.loyaltyTier ?? EMPTY} caption={detail.guest.loyaltyProgram ?? undefined} polarity="neutral" />
        </CocoaKpiStrip>
      ) : null}

      <CocoaFormSection title={hosted && !isNew ? guestName : "Identidad"} description="Nombre y documento">
        <CocoaFormRow columns={3}>
          <CocoaField label="Tratamiento">
            <CocoaSelect value={form.title} onChange={(v) => set("title", v)} options={TITLE_OPTIONS} />
          </CocoaField>
          <Field label="Nombre" k="firstName" form={form} set={set} required error={nameMissing ? "El nombre es obligatorio." : undefined} />
          <Field label="Segundo nombre" k="middleName" form={form} set={set} />
          <Field label="Primer apellido" k="surname1" form={form} set={set} />
          <Field label="Segundo apellido" k="surname2" form={form} set={set} />
          <CocoaField label="Sexo">
            <CocoaSelect value={form.sex} onChange={(v) => set("sex", v)} options={SEX_OPTIONS} />
          </CocoaField>
          <Field label="Fecha de nacimiento" k="dateOfBirth" form={form} set={set} type="date" />
          <Field label="Nacionalidad (ISO)" k="nationality" form={form} set={set} hint="p. ej. ESP" />
          <CocoaField label="Idioma preferido">
            <CocoaSelect value={form.languagePreference} onChange={(v) => set("languagePreference", v)} options={LANG_OPTIONS} />
          </CocoaField>
          <CocoaField label="Tipo de documento">
            <CocoaSelect value={form.documentType} onChange={(v) => set("documentType", v)} options={DOC_OPTIONS} />
          </CocoaField>
          <Field label="Nº de documento" k="documentNumber" form={form} set={set} />
          <Field label="Nº de soporte" k="documentSupportNumber" form={form} set={set} />
          <Field label="País de expedición" k="documentIssueCountry" form={form} set={set} hint="ESP" />
          <Field label="Caducidad del documento" k="documentExpiryDate" form={form} set={set} type="date" />
        </CocoaFormRow>
      </CocoaFormSection>

      <CocoaFormSection title="Contacto" description="Teléfonos, correo y empresa">
        <CocoaFormRow columns={3}>
          <Field label="Correo electrónico" k="email" form={form} set={set} type="email" />
          <Field label="Teléfono" k="phone" form={form} set={set} />
          <Field label="Móvil" k="mobilePhone" form={form} set={set} />
          <Field label="Empresa" k="company" form={form} set={set} />
        </CocoaFormRow>
      </CocoaFormSection>

      <CocoaFormSection title="Residencia" description="Dirección postal">
        <CocoaFormRow columns={3}>
          <Field label="Dirección" k="residenceAddress" form={form} set={set} />
          <Field label="Localidad" k="residenceLocality" form={form} set={set} />
          <Field label="Provincia" k="residenceProvince" form={form} set={set} />
          <Field label="Código postal" k="residencePostalCode" form={form} set={set} />
          <Field label="País" k="residenceCountry" form={form} set={set} />
        </CocoaFormRow>
      </CocoaFormSection>

      <CocoaFormSection title="Fidelización y preferencias" description="VIP, programa, peticiones y consentimientos">
        <CocoaFormRow columns={3}>
          <Field label="Código VIP" k="vipCode" form={form} set={set} hint="VIP1 / VVIP…" />
          <Field label="Programa de fidelización" k="loyaltyProgram" form={form} set={set} />
          <Field label="Nº de socio" k="loyaltyNumber" form={form} set={set} />
          <Field label="Nivel" k="loyaltyTier" form={form} set={set} hint="Silver / Gold…" />
          <Field label="Contacto de emergencia" k="emergencyContactName" form={form} set={set} />
          <Field label="Tel. de emergencia" k="emergencyContactPhone" form={form} set={set} />
          <CocoaField label="Preferencias" help="Separadas por comas." fullWidth>
            <CocoaInput value={form.preferences} onChange={(v) => set("preferences", v)} placeholder="planta alta, cama king, no fumador" />
          </CocoaField>
          <CocoaField label="Consiente comunicaciones de marketing (RGPD)" inline fullWidth>
            <CocoaSwitch checked={form.marketingConsent === "yes"} onChange={(v) => set("marketingConsent", v ? "yes" : "")} />
          </CocoaField>
          <CocoaField label="Notas" fullWidth>
            <CocoaInput multiline rows={3} value={form.notes} onChange={(v) => set("notes", v)} />
          </CocoaField>
        </CocoaFormRow>
      </CocoaFormSection>

      <CocoaActionBar
        aria-label="Guardar la ficha del huésped"
        status={status ?? undefined}
        primary={{ label: primaryLabel, onClick: () => void handleSave(), loading: saving }}
        publishToastOffset
      />

      {!isNew ? (
        <CocoaSection title="Estancias" meta={detail ? plural(stays.length, "estancia", "estancias") : undefined} padding={stays.length > 0 ? "none" : "md"} style={CLIP}>
          {stays.length > 0 ? (
            <CocoaTable
              columns={STAY_COLUMNS}
              rows={stays}
              rowKey="id"
              loading={loading}
              keepDataWhileLoading
              selectedKey={currentStay?.id}
              onSelect={(s) => openReservation(s.id)}
              rowTitle={() => "Abrir la reserva"}
              caption="Estancias del huésped"
              aria-label="Estancias del huésped"
            />
          ) : (
            <CocoaState kind="empty" inline title="Sin estancias registradas todavía." />
          )}
        </CocoaSection>
      ) : null}
    </CocoaPage>
  );
}
