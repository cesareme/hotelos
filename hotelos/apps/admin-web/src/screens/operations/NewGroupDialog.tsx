// NewGroupDialog — create a group booking (POST /groups/properties/:propertyId).
//
// Cocoa 22 (ola 3 · lote 3-B, archetype «diálogo / drawer»): a CocoaDrawer
// (right, lg; bottom sheet on phones) whose body is a <form> of ten
// CocoaFormSections (identification, dates and release, contact, company,
// rate, attrition, billing, F&B, Spain specifics, notes). The footer holds two
// buttons: Cancelar and «Crear grupo» (submits the form by `form=`).
// Smart defaults by group type and the YYYY-MM-XXX code suggestion are kept.
import { useMemo, useState, type CSSProperties, type FormEvent } from "react";
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
import { date, percent } from "../../lib/format";
import { ACTIONS } from "../../content/actions";
import {
  CocoaButton,
  CocoaCallout,
  CocoaDatePicker,
  CocoaDrawer,
  CocoaField,
  CocoaFormRow,
  CocoaFormSection,
  CocoaInput,
  CocoaSelect,
  CocoaSwitch
} from "../../components/cocoa";

const FORM_ID = "new-group-form";
const CODE_INPUT_ID = "new-group-code";

// ─── Options (Spanish labels; the API enum stays in the value) ───────────

const GROUP_TYPE_OPTIONS: Array<{ value: GroupType; label: string }> = [
  { value: "corporate", label: "Corporativo (empresa, convención interna)" },
  { value: "mice", label: "MICE (reuniones, incentivos, congresos)" },
  { value: "smerf", label: "SMERF (social, militar, religioso)" },
  { value: "leisure", label: "Ocio (circuitos, asociaciones)" },
  { value: "wedding", label: "Boda" },
  { value: "sports", label: "Deportivo (equipos)" },
  { value: "wholesale", label: "Mayorista (TT.OO., bloque puntual)" }
];

const STATUS_OPTIONS: Array<{ value: GroupStatus; label: string }> = [
  { value: "inquiry", label: "Consulta inicial" },
  { value: "tentative", label: "Provisional (pre-bloqueo)" },
  { value: "definite", label: "Confirmado" }
];

const RATE_TYPE_OPTIONS: Array<{ value: RateType; label: string }> = [
  { value: "net", label: "Tarifa neta" },
  { value: "commissionable", label: "Tarifa comisionable" }
];

const CURRENCY_OPTIONS = [
  { value: "EUR", label: "EUR" },
  { value: "GBP", label: "GBP" },
  { value: "USD", label: "USD" }
];

const ATTRITION_TYPE_OPTIONS: Array<{ value: AttritionType; label: string }> = [
  { value: "cumulative", label: "Acumulativa (total estancia)" },
  { value: "nightly", label: "Por noche" },
  { value: "revenue", label: "Sobre los ingresos totales" }
];

const BILLING_METHOD_OPTIONS: Array<{ value: BillingMethod; label: string }> = [
  { value: "master_folio", label: "Folio maestro (todo a un folio común)" },
  { value: "split", label: "Separado (alojamiento y extras por separado)" },
  { value: "individual", label: "Individual (cada huésped paga)" }
];

const PAYMENT_METHOD_OPTIONS: Array<{ value: PaymentMethod; label: string }> = [
  { value: "cc_guarantee", label: "Tarjeta de garantía" },
  { value: "prepay_pct", label: "Prepago anticipado (%)" },
  { value: "deposit", label: "Depósito inicial" },
  { value: "credit", label: "Crédito (cuenta corporativa)" },
  { value: "transfer", label: "Transferencia bancaria" }
];

const MEAL_PLAN_OPTIONS: Array<{ value: MealPlan; label: string }> = [
  { value: "none", label: "Ninguno (solo alojamiento)" },
  { value: "HD", label: "HD · Media pensión" },
  { value: "FB", label: "FB · Pensión completa" },
  { value: "AI", label: "AI · Todo incluido" }
];

// ─── Form state (every field with a sensible default) ────────────────────

type FormState = {
  // Identification
  code: string;
  name: string;
  groupType: GroupType;
  status: GroupStatus;
  marketCode: string;
  sourceCode: string;
  arrivalDate: string;
  departureDate: string;
  assignedToUserId: string;
  // Contact
  contactPersonName: string;
  contactEmail: string;
  contactPhone: string;
  contactRole: string;
  // Company
  companyName: string;
  companyTaxId: string;
  companyAddress: string;
  industry: string;
  // Rate
  contractedRate: string;
  currency: string;
  rateType: RateType;
  commissionPct: string;
  // Cancellation / release
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
  // Spain specifics
  regimenEspecialAaee: boolean;
  confidentialArrival: boolean;
  // Notes
  notes: string;
};

// Smart defaults by group type (five industry profiles).
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

// Code suggestion YYYY-MM-XXX (XXX = compact random suffix).
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

// Secondary note under a row (release summary): identity from the system.
const NOTE_STYLE: CSSProperties = {
  margin: 0,
  color: "var(--cocoa-label-secondary)",
  fontSize: "var(--cocoa-fs-callout)"
};

// ─── Main component ──────────────────────────────────────────────────────

export function NewGroupDialog(props: {
  onClose: () => void;
  onCreated: (group: GroupBooking) => void;
  onError: (msg: string) => void;
}) {
  const [form, setForm] = useState<FormState>(() => ({
    code: suggestCode(),
    name: "",
    groupType: "corporate",
    status: "inquiry",
    marketCode: "",
    sourceCode: "",
    arrivalDate: todayIso(30),
    departureDate: todayIso(33),
    assignedToUserId: "",
    contactPersonName: "",
    contactEmail: "",
    contactPhone: "",
    contactRole: "",
    companyName: "",
    companyTaxId: "",
    companyAddress: "",
    industry: "",
    contractedRate: "",
    currency: "EUR",
    rateType: "net",
    commissionPct: "",
    cutOffDate: todayIso(15),
    roomingListDueDate: todayIso(20),
    attritionType: "cumulative",
    attritionThresholdPct: 80,
    attritionPenaltyPct: 100,
    billingMethod: "master_folio",
    paymentMethod: "credit",
    depositPct: "",
    breakfastIncluded: true,
    mealPlan: "none",
    welcomeCocktail: false,
    galaDinner: false,
    regimenEspecialAaee: false,
    confidentialArrival: false,
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

  // Release summary: «fecha límite el [fecha] (T-X días antes de la llegada)».
  const cutOffSummary = useMemo(() => {
    if (!form.cutOffDate || !form.arrivalDate) return null;
    const arrive = new Date(form.arrivalDate);
    const cut = new Date(form.cutOffDate);
    if (Number.isNaN(arrive.getTime()) || Number.isNaN(cut.getTime())) return null;
    const diffDays = Math.round((arrive.getTime() - cut.getTime()) / 86400000);
    if (diffDays < 0) return null;
    return `Liberación: fecha límite el ${date(form.cutOffDate, "medium")} (T-${diffDays} días antes de la llegada).`;
  }, [form.cutOffDate, form.arrivalDate]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    // Basic validation.
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
        return setError("Indica un porcentaje de depósito entre 0 y 100.");
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
        commissionPct: form.rateType === "commissionable" && form.commissionPct.trim() ? Number(form.commissionPct) : undefined,
        cutOffDate: form.cutOffDate || undefined,
        roomingListDueDate: form.roomingListDueDate || undefined,
        attritionType: form.attritionType,
        attritionThresholdPct: form.attritionThresholdPct,
        attritionPenaltyPct: form.attritionPenaltyPct,
        billingMethod: form.billingMethod,
        paymentMethod: form.paymentMethod,
        depositPct:
          (form.paymentMethod === "prepay_pct" || form.paymentMethod === "deposit") && form.depositPct.trim()
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
    <CocoaDrawer
      open
      onClose={props.onClose}
      title="Nuevo grupo"
      subtitle="Da de alta un bloque de grupo. Los valores por defecto se adaptan al tipo de grupo (boda, MICE, deportivo, corporativo, mayorista…)."
      side="right"
      size="lg"
      initialFocus={() => document.getElementById(CODE_INPUT_ID)}
      footer={
        <>
          <CocoaButton variant="bordered" tone="neutral" onClick={props.onClose} disabled={submitting}>
            {ACTIONS.cancel}
          </CocoaButton>
          <CocoaButton variant="filled" tone="accent" type="submit" form={FORM_ID} loading={submitting} disabled={submitting}>
            Crear grupo
          </CocoaButton>
        </>
      }
    >
      <form id={FORM_ID} onSubmit={submit} className="cocoa-stack" data-gap="4" noValidate>
        <CocoaFormSection title="Identificación">
          <CocoaFormRow columns={2}>
            <CocoaField label="Código" required help="Formato sugerido AAAA-MM-XXX.">
              <CocoaInput
                id={CODE_INPUT_ID}
                value={form.code}
                onChange={(value) => update("code", value.toUpperCase())}
                maxLength={32}
                placeholder="2026-05-ABC"
                autoComplete="off"
                required
              />
            </CocoaField>
            <CocoaField label="Nombre del grupo" required>
              <CocoaInput value={form.name} onChange={(value) => update("name", value)} maxLength={160} placeholder="Boda García-López · Junio 2026" required />
            </CocoaField>
          </CocoaFormRow>
          <CocoaFormRow columns={2}>
            <CocoaField label="Tipo de grupo" required help="Cambia los valores por defecto según el segmento.">
              <CocoaSelect value={form.groupType} onChange={(value) => handleGroupTypeChange(value as GroupType)} options={GROUP_TYPE_OPTIONS} />
            </CocoaField>
            <CocoaField label="Estado inicial" required>
              <CocoaSelect value={form.status} onChange={(value) => update("status", value as GroupStatus)} options={STATUS_OPTIONS} />
            </CocoaField>
          </CocoaFormRow>
          <CocoaFormRow columns={3} min={160}>
            <CocoaField label="Código de mercado">
              <CocoaInput value={form.marketCode} onChange={(value) => update("marketCode", value)} maxLength={32} placeholder="CORP-ES" />
            </CocoaField>
            <CocoaField label="Código de origen">
              <CocoaInput value={form.sourceCode} onChange={(value) => update("sourceCode", value)} maxLength={32} placeholder="DIRECTO" />
            </CocoaField>
            <CocoaField label="Asignado a (identificador de usuario)" hint="opcional" help="Responsable comercial del grupo.">
              <CocoaInput value={form.assignedToUserId} onChange={(value) => update("assignedToUserId", value)} maxLength={64} placeholder="user_…" />
            </CocoaField>
          </CocoaFormRow>
        </CocoaFormSection>

        <CocoaFormSection title="Fechas y liberación">
          <CocoaFormRow columns={4} min={160}>
            <CocoaField label="Llegada" required>
              <CocoaDatePicker value={form.arrivalDate} onChange={(value) => update("arrivalDate", value)} required />
            </CocoaField>
            <CocoaField label="Salida" required>
              <CocoaDatePicker value={form.departureDate} onChange={(value) => update("departureDate", value)} min={form.arrivalDate} required />
            </CocoaField>
            <CocoaField label="Fecha límite (cut-off)" help="Fecha tope para que el grupo confirme la rooming list.">
              <CocoaDatePicker value={form.cutOffDate} onChange={(value) => update("cutOffDate", value)} max={form.arrivalDate} />
            </CocoaField>
            <CocoaField label="Entrega de la rooming list">
              <CocoaDatePicker value={form.roomingListDueDate} onChange={(value) => update("roomingListDueDate", value)} max={form.arrivalDate} />
            </CocoaField>
          </CocoaFormRow>
          {cutOffSummary ? <p style={NOTE_STYLE}>{cutOffSummary}</p> : null}
        </CocoaFormSection>

        <CocoaFormSection title="Contacto">
          <CocoaFormRow columns={2}>
            <CocoaField label="Nombre de contacto" required>
              <CocoaInput value={form.contactPersonName} onChange={(value) => update("contactPersonName", value)} maxLength={120} placeholder="María García" required />
            </CocoaField>
            <CocoaField label="Cargo">
              <CocoaInput value={form.contactRole} onChange={(value) => update("contactRole", value)} maxLength={80} placeholder="Responsable de eventos" />
            </CocoaField>
          </CocoaFormRow>
          <CocoaFormRow columns={2}>
            <CocoaField label="Correo electrónico">
              <CocoaInput value={form.contactEmail} onChange={(value) => update("contactEmail", value)} type="email" inputMode="email" placeholder="maria@empresa.com" autoComplete="off" />
            </CocoaField>
            <CocoaField label="Teléfono">
              <CocoaInput value={form.contactPhone} onChange={(value) => update("contactPhone", value)} type="tel" inputMode="tel" placeholder="+34 600 000 000" autoComplete="off" />
            </CocoaField>
          </CocoaFormRow>
        </CocoaFormSection>

        <CocoaFormSection title="Empresa">
          <CocoaFormRow columns={2}>
            <CocoaField label="Razón social">
              <CocoaInput value={form.companyName} onChange={(value) => update("companyName", value)} maxLength={160} placeholder="Acme Iberia S.L." />
            </CocoaField>
            <CocoaField label="NIF">
              <CocoaInput value={form.companyTaxId} onChange={(value) => update("companyTaxId", value)} maxLength={32} placeholder="B12345678" />
            </CocoaField>
          </CocoaFormRow>
          <CocoaFormRow columns={2}>
            <CocoaField label="Dirección">
              <CocoaInput value={form.companyAddress} onChange={(value) => update("companyAddress", value)} maxLength={200} placeholder="C/ Gran Vía 1, Madrid" />
            </CocoaField>
            <CocoaField label="Sector">
              <CocoaInput value={form.industry} onChange={(value) => update("industry", value)} maxLength={80} placeholder="Tecnología, farmacia, automoción…" />
            </CocoaField>
          </CocoaFormRow>
        </CocoaFormSection>

        <CocoaFormSection title="Tarifa contratada">
          <CocoaFormRow columns={2}>
            <CocoaField label="Modelo de tarifa" required help="Neta: el operador aplica su margen. Comisionable: tarifa pública con porcentaje.">
              <CocoaSelect value={form.rateType} onChange={(value) => update("rateType", value as RateType)} options={RATE_TYPE_OPTIONS} />
            </CocoaField>
            {isCommissionPctRequired ? (
              <CocoaField label="Comisión (%)" required help="Habitual en corporativo: 8–15 %. Mayorista: 18–25 %.">
                <CocoaInput value={form.commissionPct} onChange={(value) => update("commissionPct", value)} type="number" inputMode="decimal" min={0} max={100} step={0.1} placeholder="12" required />
              </CocoaField>
            ) : (
              <CocoaField label="Comisión" help="Tarifa neta: la tarifa contratada es lo que cobras directamente.">
                <CocoaInput value="" onChange={() => undefined} placeholder="No aplica" disabled />
              </CocoaField>
            )}
          </CocoaFormRow>
          <CocoaFormRow columns={2}>
            <CocoaField label="Tarifa por habitación y noche" hint="opcional" help="Si la dejas vacía se factura según el plan de tarifas público.">
              <CocoaInput value={form.contractedRate} onChange={(value) => update("contractedRate", value)} type="number" inputMode="decimal" min={0} step={0.01} placeholder="120,00" />
            </CocoaField>
            <CocoaField label="Moneda">
              <CocoaSelect value={form.currency} onChange={(value) => update("currency", value)} options={CURRENCY_OPTIONS} />
            </CocoaField>
          </CocoaFormRow>
        </CocoaFormSection>

        <CocoaFormSection title="Penalización por no ocupación (attrition)">
          <CocoaFormRow columns={3} min={160}>
            <CocoaField label="Tipo" required>
              <CocoaSelect value={form.attritionType} onChange={(value) => update("attritionType", value as AttritionType)} options={ATTRITION_TYPE_OPTIONS} />
            </CocoaField>
            <CocoaField label="Umbral (%)" required help="Pickup mínimo sin penalización.">
              <CocoaInput value={String(form.attritionThresholdPct)} onChange={(value) => update("attritionThresholdPct", Number(value))} type="number" inputMode="numeric" min={0} max={100} step={1} required />
            </CocoaField>
            <CocoaField label="Penalización (%)" required help="Sobre el déficit. 100 % = se cobra al completo.">
              <CocoaInput value={String(form.attritionPenaltyPct)} onChange={(value) => update("attritionPenaltyPct", Number(value))} type="number" inputMode="numeric" min={0} max={100} step={1} required />
            </CocoaField>
          </CocoaFormRow>
          <CocoaCallout tone="neutral" title="Ejemplo">
            Con 100 habitaciones contratadas y umbral {percent(form.attritionThresholdPct)}, si el pickup baja al {percent(70)} la penalización es ({percent(form.attritionThresholdPct)} − {percent(70)}) × tarifa × noches ×{" "}
            {percent(form.attritionPenaltyPct)}.
          </CocoaCallout>
        </CocoaFormSection>

        <CocoaFormSection title="Facturación y pago">
          <CocoaFormRow columns={isDepositPctRequired ? 3 : 2} min={160}>
            <CocoaField label="Método de facturación" required>
              <CocoaSelect value={form.billingMethod} onChange={(value) => update("billingMethod", value as BillingMethod)} options={BILLING_METHOD_OPTIONS} />
            </CocoaField>
            <CocoaField label="Método de pago" required>
              <CocoaSelect value={form.paymentMethod} onChange={(value) => update("paymentMethod", value as PaymentMethod)} options={PAYMENT_METHOD_OPTIONS} />
            </CocoaField>
            {isDepositPctRequired ? (
              <CocoaField label="Depósito (%)" required help="Porcentaje a cobrar por adelantado.">
                <CocoaInput value={form.depositPct} onChange={(value) => update("depositPct", value)} type="number" inputMode="decimal" min={0} max={100} step={1} placeholder="30" required />
              </CocoaField>
            ) : null}
          </CocoaFormRow>
        </CocoaFormSection>

        <CocoaFormSection title="Restauración y eventos (F&B)">
          <CocoaFormRow columns={2}>
            <CocoaField label="Régimen de comidas">
              <CocoaSelect value={form.mealPlan} onChange={(value) => update("mealPlan", value as MealPlan)} options={MEAL_PLAN_OPTIONS} />
            </CocoaField>
            <div className="cocoa-stack" data-gap="2">
              <CocoaField label="Desayuno incluido en la tarifa" inline>
                <CocoaSwitch checked={form.breakfastIncluded} onChange={(value) => update("breakfastIncluded", value)} />
              </CocoaField>
              <CocoaField label="Cóctel de bienvenida" inline>
                <CocoaSwitch checked={form.welcomeCocktail} onChange={(value) => update("welcomeCocktail", value)} />
              </CocoaField>
              <CocoaField label="Cena de gala incluida" inline>
                <CocoaSwitch checked={form.galaDinner} onChange={(value) => update("galaDinner", value)} />
              </CocoaField>
            </div>
          </CocoaFormRow>
        </CocoaFormSection>

        <CocoaFormSection title="España · Específicos">
          <CocoaFormRow columns={2}>
            <CocoaField label="Aplicar REAV (Régimen Especial de Agencias de Viajes)" inline help="Actívalo si el cliente es una agencia de viajes con REAV: cambia el modo de IVA.">
              <CocoaSwitch checked={form.regimenEspecialAaee} onChange={(value) => update("regimenEspecialAaee", value)} />
            </CocoaField>
            <CocoaField label="Llegada confidencial" inline help="Oculta el grupo en los informes generales; útil para clubes deportivos VIP.">
              <CocoaSwitch checked={form.confidentialArrival} onChange={(value) => update("confidentialArrival", value)} />
            </CocoaField>
          </CocoaFormRow>
        </CocoaFormSection>

        <CocoaFormSection title="Notas internas">
          <CocoaField label="Observaciones" fullWidth>
            <CocoaInput
              value={form.notes}
              onChange={(value) => update("notes", value)}
              multiline
              rows={3}
              placeholder="Condiciones especiales, alergias, preferencias de habitación…"
            />
          </CocoaField>
        </CocoaFormSection>

        {error ? (
          <CocoaCallout tone="danger" title={error} role="alert">
            {null}
          </CocoaCallout>
        ) : null}
      </form>
    </CocoaDrawer>
  );
}
