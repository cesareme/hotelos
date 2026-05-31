import { useMemo, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import {
  createGroupBooking,
  type CreateGroupPayload,
  type GroupBooking,
  type GroupType,
  type GroupStatus,
  type RateType,
  type AttritionType,
  type BillingMethod,
  type PaymentMethod,
  type MealPlan
} from "../../services/groupsApi";

// ─── Helpers locales (replicados para no acoplar con AllotmentsScreen) ──

const fieldsetStyle: CSSProperties = {
  border: "1px solid var(--border, #e5e7eb)",
  borderRadius: "var(--radius-sm, 6px)",
  padding: 12,
  margin: 0
};

const legendStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--ink-soft, #555)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  padding: "0 6px"
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  border: "1px solid var(--border, #d1d5db)",
  borderRadius: "var(--radius-sm, 6px)",
  background: "var(--surface, white)",
  color: "var(--ink, #1a1a1a)",
  fontSize: 14,
  fontFamily: "inherit"
};

function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: "var(--ink)" }}>
      <span style={{ fontWeight: 500 }}>{props.label}</span>
      {props.children}
      {props.hint ? <span className="bo-muted" style={{ fontSize: 11 }}>{props.hint}</span> : null}
    </label>
  );
}

// ─── Estado del form (todo con defaults sensatos) ────────────────────────

type FormState = {
  // Identificación
  code: string;
  name: string;
  groupType: GroupType;
  status: GroupStatus;
  marketCode: string;
  sourceCode: string;
  arrivalDate: string;
  departureDate: string;
  assignedToUserId: string;
  // Contacto
  contactPersonName: string;
  contactEmail: string;
  contactPhone: string;
  contactRole: string;
  // Empresa
  companyName: string;
  companyTaxId: string;
  companyAddress: string;
  industry: string;
  // Tarifa
  contractedRate: string;
  currency: string;
  rateType: RateType;
  commissionPct: string;
  // Cancelación / release
  cutOffDate: string;
  roomingListDueDate: string;
  attritionType: AttritionType;
  attritionThresholdPct: number;
  attritionPenaltyPct: number;
  // Billing
  billingMethod: BillingMethod;
  paymentMethod: PaymentMethod;
  depositPct: string;
  // F&B
  breakfastIncluded: boolean;
  mealPlan: MealPlan;
  welcomeCocktail: boolean;
  galaDinner: boolean;
  // ES specifics
  regimenEspecialAaee: boolean;
  confidentialArrival: boolean;
  // Notas
  notes: string;
};

// ─── Defaults inteligentes según tipo de grupo ─ research-backed ─────────
// 5 perfiles tipo: wedding, mice, wholesale, sports, corporate
function smartDefaultsForType(t: GroupType): Partial<FormState> {
  switch (t) {
    case "wedding":
      return { breakfastIncluded: true, galaDinner: true, mealPlan: "FB" };
    case "mice":
      return { mealPlan: "HD", attritionThresholdPct: 80 };
    case "wholesale":
      return { rateType: "net", attritionType: "cumulative", attritionThresholdPct: 90 };
    case "sports":
      return { confidentialArrival: true };
    case "corporate":
      return { billingMethod: "master_folio", paymentMethod: "credit" };
    default:
      return {};
  }
}

// Sugerencia de código YYYY-MM-XXX (XXX = sufijo aleatorio compacto de 3 chars)
function suggestCode(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const r = Math.floor(Math.random() * 36 ** 3).toString(36).toUpperCase().padStart(3, "0");
  return `${yyyy}-${mm}-${r}`;
}

function todayIso(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function fmtDateEs(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" });
}

// ─── Componente principal ────────────────────────────────────────────────

export function NewGroupDialog(props: {
  onClose: () => void;
  onCreated: (group: GroupBooking) => void;
  onError: (msg: string) => void;
}) {
  const [form, setForm] = useState<FormState>(() => ({
    // Identificación
    code: suggestCode(),
    name: "",
    groupType: "corporate",
    status: "inquiry",
    marketCode: "",
    sourceCode: "",
    arrivalDate: todayIso(30),
    departureDate: todayIso(33),
    assignedToUserId: "",
    // Contacto
    contactPersonName: "",
    contactEmail: "",
    contactPhone: "",
    contactRole: "",
    // Empresa
    companyName: "",
    companyTaxId: "",
    companyAddress: "",
    industry: "",
    // Tarifa
    contractedRate: "",
    currency: "EUR",
    rateType: "net",
    commissionPct: "",
    // Cancelación / release
    cutOffDate: todayIso(15),
    roomingListDueDate: todayIso(20),
    attritionType: "cumulative",
    attritionThresholdPct: 80,
    attritionPenaltyPct: 100,
    // Billing
    billingMethod: "master_folio",
    paymentMethod: "credit",
    depositPct: "",
    // F&B
    breakfastIncluded: true,
    mealPlan: "none",
    welcomeCocktail: false,
    galaDinner: false,
    // ES
    regimenEspecialAaee: false,
    confidentialArrival: false,
    // Notas
    notes: ""
  }));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function handleGroupTypeChange(next: GroupType) {
    const patch = smartDefaultsForType(next);
    setForm((f) => ({ ...f, ...patch, groupType: next }));
  }

  // Texto dinámico del ciclo de release · "cut-off el [fecha] (T-X días antes)"
  const cutOffSummary = useMemo(() => {
    if (!form.cutOffDate || !form.arrivalDate) return null;
    const arrive = new Date(form.arrivalDate);
    const cut = new Date(form.cutOffDate);
    if (Number.isNaN(arrive.getTime()) || Number.isNaN(cut.getTime())) return null;
    const diffDays = Math.round((arrive.getTime() - cut.getTime()) / 86400000);
    if (diffDays < 0) return null;
    return `Release: cut-off el ${fmtDateEs(form.cutOffDate)} (T-${diffDays} días antes de la llegada)`;
  }, [form.cutOffDate, form.arrivalDate]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    // Validaciones básicas
    if (!form.code.trim()) return setError("El código es obligatorio.");
    if (!form.name.trim()) return setError("El nombre del grupo es obligatorio.");
    if (!form.contactPersonName.trim()) return setError("El nombre de contacto es obligatorio.");
    if (!form.arrivalDate || !form.departureDate) return setError("Las fechas de llegada y salida son obligatorias.");
    if (form.departureDate <= form.arrivalDate) return setError("La salida debe ser posterior a la llegada.");
    if (form.rateType === "commissionable") {
      const pct = Number(form.commissionPct);
      if (!form.commissionPct.trim() || Number.isNaN(pct) || pct < 0 || pct > 100) {
        return setError("Para tarifa comisionable, indica un porcentaje entre 0 y 100.");
      }
    }
    if (form.paymentMethod === "prepay_pct" || form.paymentMethod === "deposit") {
      const dp = Number(form.depositPct);
      if (!form.depositPct.trim() || Number.isNaN(dp) || dp < 0 || dp > 100) {
        return setError("Indica un % de depósito entre 0 y 100.");
      }
    }

    setSubmitting(true);
    try {
      const payload: CreateGroupPayload = {
        code: form.code.trim().toUpperCase(),
        name: form.name.trim(),
        groupType: form.groupType,
        status: form.status,
        marketCode: form.marketCode.trim() || undefined,
        sourceCode: form.sourceCode.trim() || undefined,
        arrivalDate: form.arrivalDate,
        departureDate: form.departureDate,
        assignedToUserId: form.assignedToUserId.trim() || undefined,
        contactPersonName: form.contactPersonName.trim(),
        contactEmail: form.contactEmail.trim() || undefined,
        contactPhone: form.contactPhone.trim() || undefined,
        contactRole: form.contactRole.trim() || undefined,
        companyName: form.companyName.trim() || undefined,
        companyTaxId: form.companyTaxId.trim() || undefined,
        companyAddress: form.companyAddress.trim() || undefined,
        industry: form.industry.trim() || undefined,
        contractedRate: form.contractedRate.trim() ? Number(form.contractedRate) : undefined,
        currency: form.currency,
        rateType: form.rateType,
        commissionPct: form.rateType === "commissionable" && form.commissionPct.trim()
          ? Number(form.commissionPct)
          : undefined,
        cutOffDate: form.cutOffDate || undefined,
        roomingListDueDate: form.roomingListDueDate || undefined,
        attritionType: form.attritionType,
        attritionThresholdPct: form.attritionThresholdPct,
        attritionPenaltyPct: form.attritionPenaltyPct,
        billingMethod: form.billingMethod,
        paymentMethod: form.paymentMethod,
        depositPct: (form.paymentMethod === "prepay_pct" || form.paymentMethod === "deposit") && form.depositPct.trim()
          ? Number(form.depositPct)
          : undefined,
        breakfastIncluded: form.breakfastIncluded,
        mealPlan: form.mealPlan,
        welcomeCocktail: form.welcomeCocktail,
        galaDinner: form.galaDinner,
        regimenEspecialAaee: form.regimenEspecialAaee,
        confidentialArrival: form.confidentialArrival,
        notes: form.notes.trim() || undefined
      };
      const created = await createGroupBooking(payload);
      props.onCreated(created);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      props.onError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  const isCommissionPctRequired = form.rateType === "commissionable";
  const isDepositPctRequired = form.paymentMethod === "prepay_pct" || form.paymentMethod === "deposit";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-group-title"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.55)",
        backdropFilter: "blur(2px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 16
      }}
      onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}
      onKeyDown={(e) => { if (e.key === "Escape") props.onClose(); }}
    >
      <form
        onSubmit={submit}
        className="bo-card"
        style={{
          width: "100%",
          maxWidth: 760,
          maxHeight: "92vh",
          overflow: "auto",
          background: "var(--surface-1, var(--surface))",
          padding: "var(--space-5, 20px)",
          borderRadius: "var(--radius-md, 12px)",
          display: "flex",
          flexDirection: "column",
          gap: 12
        }}
      >
        <div className="bo-card-head" style={{ marginBottom: 4 }}>
          <div>
            <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 11, margin: 0 }}>
              Comercial · Groups &amp; Events
            </p>
            <h3 id="new-group-title" style={{ margin: "2px 0 0 0" }}>Nuevo grupo</h3>
          </div>
          <button
            type="button"
            onClick={props.onClose}
            aria-label="Cerrar"
            style={{ background: "transparent", border: "none", fontSize: 20, cursor: "pointer", color: "var(--ink)" }}
          >×</button>
        </div>

        <p className="bo-muted" style={{ margin: 0, fontSize: 13 }}>
          Da de alta un bloque de grupo. Los defaults se adaptan según el tipo de grupo
          (boda, MICE, deportivo, corporate, wholesale…).
        </p>

        {/* 1. Identificación */}
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>Identificación</legend>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12, marginBottom: 12 }}>
            <Field label="Código *" hint="Sugerencia formato YYYY-MM-XXX">
              <input
                type="text"
                required
                maxLength={32}
                value={form.code}
                onChange={(e) => update("code", e.target.value.toUpperCase())}
                style={inputStyle}
                placeholder="2026-05-ABC"
                autoFocus
              />
            </Field>
            <Field label="Nombre del grupo *">
              <input
                type="text"
                required
                maxLength={160}
                value={form.name}
                onChange={(e) => update("name", e.target.value)}
                style={inputStyle}
                placeholder="Boda García-López · Junio 2026"
              />
            </Field>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Tipo de grupo *" hint="Cambia los defaults inteligentes según el segmento.">
              <select
                value={form.groupType}
                onChange={(e) => handleGroupTypeChange(e.target.value as GroupType)}
                style={inputStyle}
              >
                <option value="corporate">🏢 Corporate (empresa / kick-off)</option>
                <option value="mice">🎯 MICE (meetings / incentives / conf.)</option>
                <option value="smerf">⛪ SMERF (social / militar / religioso)</option>
                <option value="leisure">🏖️ Leisure (tours / asociaciones)</option>
                <option value="wedding">💍 Wedding (boda)</option>
                <option value="sports">⚽ Sports (equipos deportivos)</option>
                <option value="wholesale">🌐 Wholesale (TT.OO. bloque puntual)</option>
              </select>
            </Field>
            <Field label="Estado inicial *">
              <select
                value={form.status}
                onChange={(e) => update("status", e.target.value as GroupStatus)}
                style={inputStyle}
              >
                <option value="inquiry">Inquiry (consulta inicial)</option>
                <option value="tentative">Tentative (pre-bloqueo)</option>
                <option value="definite">Definite (confirmado)</option>
              </select>
            </Field>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginTop: 12 }}>
            <Field label="Market code">
              <input
                type="text"
                maxLength={32}
                value={form.marketCode}
                onChange={(e) => update("marketCode", e.target.value)}
                style={inputStyle}
                placeholder="CORP-ES"
              />
            </Field>
            <Field label="Source code">
              <input
                type="text"
                maxLength={32}
                value={form.sourceCode}
                onChange={(e) => update("sourceCode", e.target.value)}
                style={inputStyle}
                placeholder="DIRECT"
              />
            </Field>
            <Field label="Asignado a (user ID)" hint="Opcional · responsable comercial del grupo.">
              <input
                type="text"
                maxLength={64}
                value={form.assignedToUserId}
                onChange={(e) => update("assignedToUserId", e.target.value)}
                style={inputStyle}
                placeholder="user_..."
              />
            </Field>
          </div>
        </fieldset>

        {/* 2. Fechas y release */}
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>Fechas y release</legend>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 }}>
            <Field label="Llegada *">
              <input
                type="date"
                required
                value={form.arrivalDate}
                onChange={(e) => update("arrivalDate", e.target.value)}
                style={inputStyle}
              />
            </Field>
            <Field label="Salida *">
              <input
                type="date"
                required
                value={form.departureDate}
                min={form.arrivalDate}
                onChange={(e) => update("departureDate", e.target.value)}
                style={inputStyle}
              />
            </Field>
            <Field label="Cut-off" hint="Fecha tope para que el grupo confirme rooming list.">
              <input
                type="date"
                value={form.cutOffDate}
                max={form.arrivalDate}
                onChange={(e) => update("cutOffDate", e.target.value)}
                style={inputStyle}
              />
            </Field>
            <Field label="Rooming list due">
              <input
                type="date"
                value={form.roomingListDueDate}
                max={form.arrivalDate}
                onChange={(e) => update("roomingListDueDate", e.target.value)}
                style={inputStyle}
              />
            </Field>
          </div>
          {cutOffSummary ? (
            <p className="bo-muted" style={{ margin: "8px 0 0 0", fontSize: 12 }}>
              {cutOffSummary}
            </p>
          ) : null}
        </fieldset>

        {/* 3. Contacto */}
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>Contacto</legend>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <Field label="Nombre de contacto *">
              <input
                type="text"
                required
                maxLength={120}
                value={form.contactPersonName}
                onChange={(e) => update("contactPersonName", e.target.value)}
                style={inputStyle}
                placeholder="María García"
              />
            </Field>
            <Field label="Cargo / rol">
              <input
                type="text"
                maxLength={80}
                value={form.contactRole}
                onChange={(e) => update("contactRole", e.target.value)}
                style={inputStyle}
                placeholder="Event Manager"
              />
            </Field>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Email">
              <input
                type="email"
                inputMode="email"
                value={form.contactEmail}
                onChange={(e) => update("contactEmail", e.target.value)}
                style={inputStyle}
                placeholder="maria@empresa.com"
              />
            </Field>
            <Field label="Teléfono">
              <input
                type="tel"
                inputMode="tel"
                value={form.contactPhone}
                onChange={(e) => update("contactPhone", e.target.value)}
                style={inputStyle}
                placeholder="+34 600 000 000"
              />
            </Field>
          </div>
        </fieldset>

        {/* 4. Empresa */}
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>Empresa</legend>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <Field label="Razón social">
              <input
                type="text"
                maxLength={160}
                value={form.companyName}
                onChange={(e) => update("companyName", e.target.value)}
                style={inputStyle}
                placeholder="Acme Iberia S.L."
              />
            </Field>
            <Field label="NIF / Tax ID">
              <input
                type="text"
                maxLength={32}
                value={form.companyTaxId}
                onChange={(e) => update("companyTaxId", e.target.value)}
                style={inputStyle}
                placeholder="B12345678"
              />
            </Field>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}>
            <Field label="Dirección">
              <input
                type="text"
                maxLength={200}
                value={form.companyAddress}
                onChange={(e) => update("companyAddress", e.target.value)}
                style={inputStyle}
                placeholder="C/ Gran Vía 1, Madrid"
              />
            </Field>
            <Field label="Sector / industry">
              <input
                type="text"
                maxLength={80}
                value={form.industry}
                onChange={(e) => update("industry", e.target.value)}
                style={inputStyle}
                placeholder="Tech / Farma / Auto…"
              />
            </Field>
          </div>
        </fieldset>

        {/* 5. Tarifa */}
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>Tarifa contratada</legend>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <Field label="Modelo de tarifa *" hint="Net: el operador aplica markup. Comisionable: tarifa pública con %.">
              <select
                value={form.rateType}
                onChange={(e) => update("rateType", e.target.value as RateType)}
                style={inputStyle}
              >
                <option value="net">Tarifa neta (net)</option>
                <option value="commissionable">Tarifa comisionable</option>
              </select>
            </Field>
            {isCommissionPctRequired ? (
              <Field label="Comisión (%) *" hint="Típico grupo corporativo: 8-15%. Wholesale: 18-25%.">
                <input
                  type="number"
                  inputMode="decimal"
                  required
                  min={0}
                  max={100}
                  step={0.1}
                  value={form.commissionPct}
                  onChange={(e) => update("commissionPct", e.target.value)}
                  style={inputStyle}
                  placeholder="12"
                />
              </Field>
            ) : (
              <Field label="" hint="Net rate: la tarifa contratada es lo que cobras directamente.">
                <input type="text" disabled style={{ ...inputStyle, opacity: 0.5 }} placeholder="—" />
              </Field>
            )}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}>
            <Field label="Tarifa / habitación / noche" hint="Opcional. Si la dejas vacía se factura según rate plan público.">
              <input
                type="number"
                inputMode="decimal"
                min={0}
                step={0.01}
                value={form.contractedRate}
                onChange={(e) => update("contractedRate", e.target.value)}
                style={inputStyle}
                placeholder="120.00"
              />
            </Field>
            <Field label="Moneda">
              <select
                value={form.currency}
                onChange={(e) => update("currency", e.target.value)}
                style={inputStyle}
              >
                <option value="EUR">EUR</option>
                <option value="GBP">GBP</option>
                <option value="USD">USD</option>
              </select>
            </Field>
          </div>
        </fieldset>

        {/* 6. Attrition */}
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>Attrition (penalización por no-pickup)</legend>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            <Field label="Tipo de attrition *">
              <select
                value={form.attritionType}
                onChange={(e) => update("attritionType", e.target.value as AttritionType)}
                style={inputStyle}
              >
                <option value="cumulative">Acumulativa (total estancia)</option>
                <option value="nightly">Por noche (nightly)</option>
                <option value="revenue">Sobre revenue total</option>
              </select>
            </Field>
            <Field label="Threshold (%) *" hint="Pickup mínimo sin penalización.">
              <input
                type="number"
                inputMode="numeric"
                required
                min={0}
                max={100}
                step={1}
                value={form.attritionThresholdPct}
                onChange={(e) => update("attritionThresholdPct", Number(e.target.value))}
                style={inputStyle}
              />
            </Field>
            <Field label="Penalty (%) *" hint="Sobre el déficit. 100% = se cobra al completo.">
              <input
                type="number"
                inputMode="numeric"
                required
                min={0}
                max={100}
                step={1}
                value={form.attritionPenaltyPct}
                onChange={(e) => update("attritionPenaltyPct", Number(e.target.value))}
                style={inputStyle}
              />
            </Field>
          </div>
          <p className="bo-muted" style={{ fontSize: 12, margin: "8px 0 0 0" }}>
            Ejemplo: con 100 hab contratadas, threshold {form.attritionThresholdPct}%, si el pickup baja a 70%
            la penalización = ({form.attritionThresholdPct}-70) × tarifa × noches × {form.attritionPenaltyPct}%.
          </p>
        </fieldset>

        {/* 7. Billing */}
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>Facturación &amp; pago</legend>
          <div style={{ display: "grid", gridTemplateColumns: isDepositPctRequired ? "1fr 1fr 1fr" : "1fr 1fr", gap: 12 }}>
            <Field label="Método de facturación *">
              <select
                value={form.billingMethod}
                onChange={(e) => update("billingMethod", e.target.value as BillingMethod)}
                style={inputStyle}
              >
                <option value="master_folio">Master folio (todo a un folio común)</option>
                <option value="split">Split (room + extras separados)</option>
                <option value="individual">Individual (cada huésped paga)</option>
              </select>
            </Field>
            <Field label="Método de pago *">
              <select
                value={form.paymentMethod}
                onChange={(e) => update("paymentMethod", e.target.value as PaymentMethod)}
                style={inputStyle}
              >
                <option value="cc_guarantee">Tarjeta de garantía</option>
                <option value="prepay_pct">Prepago % anticipado</option>
                <option value="deposit">Depósito inicial</option>
                <option value="credit">Crédito (cuenta corporativa)</option>
                <option value="transfer">Transferencia bancaria</option>
              </select>
            </Field>
            {isDepositPctRequired ? (
              <Field label="Depósito (%) *" hint="Porcentaje a cobrar por adelantado.">
                <input
                  type="number"
                  inputMode="decimal"
                  required
                  min={0}
                  max={100}
                  step={1}
                  value={form.depositPct}
                  onChange={(e) => update("depositPct", e.target.value)}
                  style={inputStyle}
                  placeholder="30"
                />
              </Field>
            ) : null}
          </div>
        </fieldset>

        {/* 8. F&B */}
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>F&amp;B (catering &amp; restauración)</legend>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Plan de comidas">
              <select
                value={form.mealPlan}
                onChange={(e) => update("mealPlan", e.target.value as MealPlan)}
                style={inputStyle}
              >
                <option value="none">Ninguno (sólo alojamiento)</option>
                <option value="HD">HD · Media pensión</option>
                <option value="FB">FB · Pensión completa</option>
                <option value="AI">AI · Todo incluido</option>
              </select>
            </Field>
            <Field label="Desayuno incluido">
              <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", fontSize: 14, color: "var(--ink)" }}>
                <input
                  type="checkbox"
                  checked={form.breakfastIncluded}
                  onChange={(e) => update("breakfastIncluded", e.target.checked)}
                />
                Incluido en tarifa
              </label>
            </Field>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 8 }}>
            <Field label="Welcome cocktail">
              <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", fontSize: 14, color: "var(--ink)" }}>
                <input
                  type="checkbox"
                  checked={form.welcomeCocktail}
                  onChange={(e) => update("welcomeCocktail", e.target.checked)}
                />
                Cóctel de bienvenida
              </label>
            </Field>
            <Field label="Cena de gala">
              <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", fontSize: 14, color: "var(--ink)" }}>
                <input
                  type="checkbox"
                  checked={form.galaDinner}
                  onChange={(e) => update("galaDinner", e.target.checked)}
                />
                Gala dinner incluido
              </label>
            </Field>
          </div>
        </fieldset>

        {/* 9. ES Específicos */}
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>España · Específicos</legend>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field
              label="Régimen Especial AAEE"
              hint="Activar si el cliente es agencia de viajes con REAV. Cambia el modo IVA."
            >
              <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", fontSize: 14, color: "var(--ink)" }}>
                <input
                  type="checkbox"
                  checked={form.regimenEspecialAaee}
                  onChange={(e) => update("regimenEspecialAaee", e.target.checked)}
                />
                Aplicar REAV
              </label>
            </Field>
            <Field
              label="Llegada confidencial"
              hint="Oculta el grupo en informes generales · útil para clubs deportivos VIP."
            >
              <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", fontSize: 14, color: "var(--ink)" }}>
                <input
                  type="checkbox"
                  checked={form.confidentialArrival}
                  onChange={(e) => update("confidentialArrival", e.target.checked)}
                />
                Confidencial
              </label>
            </Field>
          </div>
        </fieldset>

        {/* 10. Notas */}
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>Notas internas</legend>
          <Field label="Observaciones">
            <textarea
              value={form.notes}
              onChange={(e) => update("notes", e.target.value)}
              style={{ ...inputStyle, minHeight: 70, resize: "vertical" }}
              placeholder="Condiciones especiales, allergens, alergias, preferencias de habitación…"
            />
          </Field>
        </fieldset>

        {error ? (
          <p className="bo-status error" style={{ textTransform: "none", margin: 0 }}>{error}</p>
        ) : null}

        <div className="bo-row" style={{ gap: 8, justifyContent: "space-between", marginTop: 4 }}>
          <p className="bo-muted" style={{ fontSize: 12, margin: 0 }}>* Campos obligatorios</p>
          <div className="bo-row" style={{ gap: 8 }}>
            <button type="button" onClick={props.onClose} disabled={submitting}>Cancelar</button>
            <button type="submit" className="primary" disabled={submitting}>
              {submitting ? "Creando…" : "Crear grupo"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
