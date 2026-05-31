import { useEffect, useMemo, useState } from "react";
import {
  createGuest,
  fetchGuest,
  updateGuest,
  type GuestDetail,
  type GuestInput,
  type GuestStay
} from "../../services/guestsApi";
import { LoadingBlock, ErrorState } from "../../components/States";

const TITLE_OPTIONS = ["", "Sr.", "Sra.", "Srta.", "Dr.", "Dra.", "Mr.", "Mrs.", "Ms.", "Mx."];
const SEX_OPTIONS = [
  { value: "", label: "—" },
  { value: "M", label: "Hombre" },
  { value: "F", label: "Mujer" },
  { value: "X", label: "No especificado" }
];
const DOC_OPTIONS = ["", "DNI", "NIE", "PASSPORT", "TIE"];
const LANG_OPTIONS = [
  { value: "", label: "—" },
  { value: "es", label: "Español" },
  { value: "en", label: "English" },
  { value: "fr", label: "Français" },
  { value: "de", label: "Deutsch" },
  { value: "it", label: "Italiano" },
  { value: "pt", label: "Português" }
];

type FormState = Record<string, string> & { marketingConsent?: string };

const EMPTY: FormState = {
  title: "", firstName: "", middleName: "", surname1: "", surname2: "",
  documentType: "", documentNumber: "", documentSupportNumber: "", documentIssueCountry: "", documentExpiryDate: "",
  nationality: "", sex: "", languagePreference: "", dateOfBirth: "",
  residenceAddress: "", residenceLocality: "", residenceProvince: "", residencePostalCode: "", residenceCountry: "",
  phone: "", mobilePhone: "", email: "", company: "",
  vipCode: "", loyaltyProgram: "", loyaltyNumber: "", loyaltyTier: "",
  preferences: "", emergencyContactName: "", emergencyContactPhone: "", marketingConsent: "", notes: ""
};

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

function Field(props: { label: string; k: string; form: FormState; set: (k: string, v: string) => void; type?: string; hint?: string; required?: boolean }) {
  return (
    <label className="bo-form-field">
      <span>{props.label}{props.required ? <strong> required</strong> : null}</span>
      <input type={props.type ?? "text"} value={props.form[props.k] ?? ""} onChange={(e) => props.set(props.k, e.target.value)} />
      {props.hint ? <small>{props.hint}</small> : null}
    </label>
  );
}

export function GuestProfileScreen() {
  const [guestId, setGuestId] = useState(currentGuestId());
  const isNew = guestId === "new";
  const [form, setForm] = useState<FormState>(EMPTY);
  const [detail, setDetail] = useState<GuestDetail | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    function onNav() { setGuestId(currentGuestId()); }
    window.addEventListener("popstate", onNav);
    return () => window.removeEventListener("popstate", onNav);
  }, []);

  useEffect(() => {
    if (guestId === "new") {
      setForm(EMPTY);
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
          ...EMPTY,
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
  }, [guestId]);

  function set(k: string, v: string) {
    setForm((cur) => ({ ...cur, [k]: v }));
  }

  async function handleSave() {
    if (!form.firstName.trim()) {
      setStatus("El nombre es obligatorio.");
      return;
    }
    setSaving(true);
    setStatus(isNew ? "Creando huésped…" : "Guardando…");
    try {
      const input = buildInput(form);
      if (isNew) {
        const created = await createGuest(input);
        setStatus(`Huésped ${created.fullName} creado.`);
        window.history.pushState(null, "", `/backoffice/guests/${created.id}`);
        window.dispatchEvent(new PopStateEvent("popstate"));
      } else {
        const updated = await updateGuest(guestId, input);
        setStatus(`Cambios guardados (${updated.fullName}).`);
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "No se pudo guardar.");
    } finally {
      setSaving(false);
    }
  }

  const lifetime = useMemo(() => detail?.stats.lifetimeValue ?? 0, [detail]);

  if (loading) return <section className="bo-card"><LoadingBlock label="Cargando huésped…" /></section>;
  if (error) return <section className="bo-card"><ErrorState message={error} onRetry={() => setGuestId(currentGuestId())} /></section>;

  return (
    <section className="bo-card">
      <div className="bo-card-head">
        <div>
          <p className="bo-muted">CRM · Perfil de huésped</p>
          <h2>{isNew ? "Nuevo huésped" : (detail?.guest.fullName || form.firstName || "Huésped")}</h2>
        </div>
        <button type="button" onClick={() => { window.history.pushState(null, "", "/backoffice/guests"); window.dispatchEvent(new PopStateEvent("popstate")); }}>← Volver al listado</button>
      </div>

      {!isNew && detail ? (
        <div className="rev-kpi-grid" style={{ marginBottom: "var(--space-4)" }}>
          <div className="rev-kpi"><span className="rev-kpi-label">Estancias</span><span className="rev-kpi-value">{detail.stats.stays}</span></div>
          <div className="rev-kpi"><span className="rev-kpi-label">Valor de vida (LTV)</span><span className="rev-kpi-value">{lifetime.toLocaleString("es-ES", { useGrouping: true })} €</span></div>
          <div className="rev-kpi"><span className="rev-kpi-label">VIP</span><span className="rev-kpi-value">{detail.guest.vipCode ?? "—"}</span></div>
          <div className="rev-kpi"><span className="rev-kpi-label">Fidelización</span><span className="rev-kpi-value">{detail.guest.loyaltyTier ?? "—"}</span></div>
        </div>
      ) : null}

      {/* Identidad */}
      <div className="bo-card-head" style={{ marginTop: 8 }}><div><p className="bo-muted">Identidad</p><h3 style={{ margin: 0 }}>Nombre y documento</h3></div></div>
      <div className="bo-grid three">
        <label className="bo-form-field"><span>Tratamiento</span>
          <select value={form.title} onChange={(e) => set("title", e.target.value)}>{TITLE_OPTIONS.map((t) => <option key={t} value={t}>{t || "—"}</option>)}</select>
        </label>
        <Field label="Nombre" k="firstName" form={form} set={set} required />
        <Field label="Segundo nombre" k="middleName" form={form} set={set} />
        <Field label="Primer apellido" k="surname1" form={form} set={set} />
        <Field label="Segundo apellido" k="surname2" form={form} set={set} />
        <label className="bo-form-field"><span>Sexo</span>
          <select value={form.sex} onChange={(e) => set("sex", e.target.value)}>{SEX_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
        </label>
        <Field label="Fecha de nacimiento" k="dateOfBirth" form={form} set={set} type="date" />
        <Field label="Nacionalidad (ISO)" k="nationality" form={form} set={set} hint="p. ej. ESP" />
        <label className="bo-form-field"><span>Idioma preferido</span>
          <select value={form.languagePreference} onChange={(e) => set("languagePreference", e.target.value)}>{LANG_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
        </label>
        <label className="bo-form-field"><span>Tipo de documento</span>
          <select value={form.documentType} onChange={(e) => set("documentType", e.target.value)}>{DOC_OPTIONS.map((d) => <option key={d} value={d}>{d || "—"}</option>)}</select>
        </label>
        <Field label="Nº de documento" k="documentNumber" form={form} set={set} />
        <Field label="Nº de soporte" k="documentSupportNumber" form={form} set={set} />
        <Field label="País de expedición" k="documentIssueCountry" form={form} set={set} hint="ESP" />
        <Field label="Caducidad del documento" k="documentExpiryDate" form={form} set={set} type="date" />
      </div>

      {/* Contacto */}
      <div className="bo-card-head" style={{ marginTop: 8 }}><div><p className="bo-muted">Contacto</p><h3 style={{ margin: 0 }}>Teléfonos, email, empresa</h3></div></div>
      <div className="bo-grid three">
        <Field label="Email" k="email" form={form} set={set} type="email" />
        <Field label="Teléfono" k="phone" form={form} set={set} />
        <Field label="Móvil" k="mobilePhone" form={form} set={set} />
        <Field label="Empresa" k="company" form={form} set={set} />
      </div>

      {/* Residencia */}
      <div className="bo-card-head" style={{ marginTop: 8 }}><div><p className="bo-muted">Residencia</p><h3 style={{ margin: 0 }}>Dirección postal</h3></div></div>
      <div className="bo-grid three">
        <Field label="Dirección" k="residenceAddress" form={form} set={set} />
        <Field label="Localidad" k="residenceLocality" form={form} set={set} />
        <Field label="Provincia" k="residenceProvince" form={form} set={set} />
        <Field label="Código postal" k="residencePostalCode" form={form} set={set} />
        <Field label="País" k="residenceCountry" form={form} set={set} />
      </div>

      {/* Fidelización y preferencias */}
      <div className="bo-card-head" style={{ marginTop: 8 }}><div><p className="bo-muted">Fidelización y preferencias</p><h3 style={{ margin: 0 }}>VIP, programa, peticiones, consentimientos</h3></div></div>
      <div className="bo-grid three">
        <Field label="Código VIP" k="vipCode" form={form} set={set} hint="VIP1 / VVIP…" />
        <Field label="Programa de fidelización" k="loyaltyProgram" form={form} set={set} />
        <Field label="Nº de socio" k="loyaltyNumber" form={form} set={set} />
        <Field label="Nivel / tier" k="loyaltyTier" form={form} set={set} hint="Silver / Gold…" />
        <Field label="Contacto de emergencia" k="emergencyContactName" form={form} set={set} />
        <Field label="Tel. de emergencia" k="emergencyContactPhone" form={form} set={set} />
      </div>
      <label className="bo-form-field"><span>Preferencias</span>
        <input value={form.preferences} onChange={(e) => set("preferences", e.target.value)} placeholder="planta alta, cama king, no fumador" />
        <small>Separadas por comas.</small>
      </label>
      <label className="bo-form-field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <input type="checkbox" checked={form.marketingConsent === "yes"} onChange={(e) => set("marketingConsent", e.target.checked ? "yes" : "")} style={{ width: "auto" }} />
        <span style={{ fontWeight: 500 }}>Consiente comunicaciones de marketing (RGPD)</span>
      </label>
      <label className="bo-form-field"><span>Notas</span>
        <textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} />
      </label>

      <div className="bo-actions">
        <button className="primary" type="button" onClick={handleSave} disabled={saving}>
          {isNew ? "Crear huésped" : "Guardar cambios"}
        </button>
      </div>
      {status ? <p className="bo-muted" style={{ marginTop: 8 }}>{status}</p> : null}

      {/* Historial de estancias */}
      {!isNew ? (
        <>
          <div className="bo-card-head" style={{ marginTop: 16 }}><div><p className="bo-muted">Historial</p><h3 style={{ margin: 0 }}>Estancias</h3></div></div>
          {detail && detail.stayHistory.length ? (
            <div className="bo-table-wrap">
              <table>
                <thead><tr><th>Reserva</th><th>Estado</th><th>Entrada</th><th>Salida</th><th>Importe</th><th>Rol</th></tr></thead>
                <tbody>
                  {detail.stayHistory.map((s: GuestStay) => (
                    <tr key={s.id} style={{ cursor: "pointer" }} onClick={() => { window.history.pushState(null, "", `/backoffice/reservations/${s.id}`); window.dispatchEvent(new PopStateEvent("popstate")); }}>
                      <td><strong>{s.code}</strong></td>
                      <td><span className="bo-chip">{s.status}</span></td>
                      <td>{s.arrivalDate ?? "—"}</td>
                      <td>{s.departureDate ?? "—"}</td>
                      <td>{s.totalAmount.toLocaleString("es-ES", { useGrouping: true })} {s.currency}</td>
                      <td>{s.isPrimary ? "Titular" : "Acompañante"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="bo-muted">Sin estancias registradas todavía.</p>
          )}
        </>
      ) : null}
    </section>
  );
}
