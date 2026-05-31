import { getActivePropertyId } from "../../services/activeProperty";
import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { fetchConfigurationCategories, type ConfigurationCategoryGroup } from "../../services/backofficeApi";
import {
  createReservation,
  fetchRoomTypes,
  fetchRooms,
  quoteAvailability,
  scanIdDocument,
  type AdminReservation,
  type AdminRoom,
  type AdminRoomType,
  type AvailabilityQuote
} from "../../services/pmsCommerceApi";
import { useToast } from "../../components/Toast";
import { logBreadcrumb } from "../../lib/breadcrumb";
import { CocoaButton } from "../../components/cocoa/CocoaButton";
import { CocoaInput } from "../../components/cocoa/CocoaInput";
import { CocoaSelect } from "../../components/cocoa/CocoaSelect";
import { CocoaCard } from "../../components/cocoa/CocoaCard";
import { CocoaStepper } from "../../components/cocoa/CocoaStepper";
import { CocoaDatePicker } from "../../components/cocoa/CocoaDatePicker";
import { CocoaSwitch } from "../../components/cocoa/CocoaSwitch";
import { CocoaFormFieldset } from "../../components/cocoa-extras/CocoaFormFieldset";

const PROPERTY_ID = getActivePropertyId();

const TODAY_ISO = new Date().toISOString().slice(0, 10);
const TOMORROW_ISO = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

// Companion guest — accompanying guests linked to the primary reservation. The
// titular fills in their own data in the main form; companions are added
// dynamically (add/remove) inside the Huéspedes fieldset.
type CompanionGuest = {
  id: string;
  firstName: string;
  surname1: string;
  documentType: string;
  documentNumber: string;
  dateOfBirth: string;
  nationality: string;
  type: "adult" | "child" | "infant";
};

function newCompanion(type: CompanionGuest["type"] = "adult"): CompanionGuest {
  return {
    id: `cmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    firstName: "",
    surname1: "",
    documentType: "DNI",
    documentNumber: "",
    dateOfBirth: "",
    nationality: "ESP",
    type
  };
}

const defaultForm = {
  // ── Estancia ───────────────────────────────────────────────────────────
  arrivalDate: TODAY_ISO,
  departureDate: TOMORROW_ISO,
  eta: "",
  etd: "",
  estimatedArrivalTime: "",
  adults: "2",
  children: "0",
  infants: "0",
  childrenAges: "",
  roomsCount: "1",
  roomTypeId: "rt_double",
  assignedRoomId: "",
  // ── Tarifa ─────────────────────────────────────────────────────────────
  ratePlanId: "rp_flexible",
  boardType: "BB",
  totalAmount: "272",
  // ── Origen (Channel / Source / Market) ─────────────────────────────────
  bookingSource: "direct",
  channel: "direct",
  marketSegment: "leisure",
  sourceCode: "direct_web",
  purposeOfStay: "leisure",
  externalReference: "",
  groupCode: "",
  companyName: "",
  travelAgentName: "",
  bookerName: "Ana Martinez",
  bookerEmail: "ana@example.com",
  // ── Pagos ──────────────────────────────────────────────────────────────
  paymentMethod: "credit_card",
  depositAmount: "",
  depositPaid: "",
  depositDueDate: "",
  guaranteeType: "card_guarantee",
  cancellationPolicyCode: "flexible_18",
  billingInstruction: "guest_pays_checkout",
  // ── Primary guest (titular) ────────────────────────────────────────────
  title: "",
  firstName: "Ana",
  middleName: "",
  surname1: "Martinez",
  surname2: "",
  email: "ana@example.com",
  phone: "+34600000000",
  mobilePhone: "",
  languagePreference: "es",
  guestCompany: "",
  vipCode: "",
  vipFlag: "",
  loyaltyProgram: "",
  loyaltyNumber: "",
  loyaltyTier: "",
  // Guest identity & residence — required by SES Hospedajes (RD 933/2021) for the
  // parte de viajeros. Optional at booking; can be completed by check-in (24h).
  documentType: "DNI",
  documentNumber: "",
  documentSupportNumber: "",
  documentIssueCountry: "",
  documentExpiryDate: "",
  dateOfBirth: "",
  nationality: "ESP",
  sex: "",
  residenceAddress: "",
  residenceCountry: "España",
  residenceProvince: "",
  residenceLocality: "",
  residencePostalCode: "",
  // ── Solicitudes & preferencias ─────────────────────────────────────────
  preferences: "",
  marketingConsent: "",
  emergencyContactName: "",
  emergencyContactPhone: "",
  specialRequests: "",
  accessibilityNeeds: "",
  dietaryRequirements: "",
  internalNotes: "",
  notes: ""
};

const DOCUMENT_TYPE_OPTIONS = [
  { value: "DNI", label: "DNI" },
  { value: "NIE", label: "NIE" },
  { value: "PASSPORT", label: "Pasaporte" },
  { value: "TIE", label: "TIE / Permiso de residencia" }
];

const SEX_OPTIONS = [
  { value: "", label: "—" },
  { value: "M", label: "Hombre" },
  { value: "F", label: "Mujer" },
  { value: "X", label: "No especificado" }
];

const TITLE_OPTIONS = [
  { value: "", label: "—" },
  { value: "Sr.", label: "Sr." },
  { value: "Sra.", label: "Sra." },
  { value: "Srta.", label: "Srta." },
  { value: "Dr.", label: "Dr." },
  { value: "Dra.", label: "Dra." },
  { value: "Mr.", label: "Mr." },
  { value: "Mrs.", label: "Mrs." },
  { value: "Ms.", label: "Ms." },
  { value: "Mx.", label: "Mx." }
];

const BOARD_OPTIONS = [
  { value: "RO", label: "Solo alojamiento (RO)" },
  { value: "BB", label: "Alojamiento y desayuno (BB)" },
  { value: "HB", label: "Media pensión (HB)" },
  { value: "FB", label: "Pensión completa (FB)" },
  { value: "AI", label: "Todo incluido (AI)" }
];

const PURPOSE_OPTIONS = [
  { value: "leisure", label: "Ocio" },
  { value: "business", label: "Negocios" },
  { value: "group", label: "Grupo" },
  { value: "event", label: "Evento / MICE" },
  { value: "other", label: "Otro" }
];

const LANGUAGE_OPTIONS = [
  { value: "es", label: "Español" },
  { value: "en", label: "English" },
  { value: "fr", label: "Français" },
  { value: "de", label: "Deutsch" },
  { value: "it", label: "Italiano" },
  { value: "pt", label: "Português" }
];

// Booking source — high-level provenance of the reservation (origin channel).
// Mews "BookingSource" + Opera "Source" + Cloudbeds "Source of business".
const BOOKING_SOURCE_OPTIONS = [
  { value: "direct", label: "Direct (web/email)" },
  { value: "phone", label: "Phone" },
  { value: "email", label: "Email" },
  { value: "walk_in", label: "Walk-in" },
  { value: "booking_com", label: "Booking.com" },
  { value: "expedia", label: "Expedia" },
  { value: "airbnb", label: "Airbnb" },
  { value: "wholesale", label: "Wholesale / TTOO" },
  { value: "gds", label: "GDS" },
  { value: "corporate", label: "Corporate" }
];

// Market segment — extended to include MICE, wedding and sports segments
// commonly tracked by Opera/Cloudbeds for revenue analysis.
const MARKET_SEGMENT_OPTIONS = [
  { value: "corporate", label: "Corporate" },
  { value: "leisure", label: "Leisure" },
  { value: "mice", label: "MICE / Conventions" },
  { value: "wedding", label: "Wedding" },
  { value: "sports", label: "Sports" },
  { value: "group", label: "Group" },
  { value: "government", label: "Government" },
  { value: "wholesale", label: "Wholesale" },
  { value: "complimentary", label: "Complimentary" }
];

// Payment methods — Mews "PaymentMethod" + Opera "Payment Type".
const PAYMENT_METHOD_OPTIONS = [
  { value: "cash", label: "Cash" },
  { value: "credit_card", label: "Credit card" },
  { value: "debit_card", label: "Debit card" },
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "voucher", label: "Voucher / Gift card" },
  { value: "company_invoice", label: "Company invoice" },
  { value: "online_prepaid", label: "Online prepaid (OTA)" },
  { value: "pms_account", label: "PMS account / Direct billing" }
];

const CHANNEL_OPTIONS = [
  { value: "direct", label: "Direct" },
  { value: "booking_com_mock", label: "Booking.com Mock" },
  { value: "expedia_mock", label: "Expedia Mock" },
  { value: "corporate", label: "Corporate" }
];

const RATE_PLAN_OPTIONS = [
  { value: "rp_flexible", label: "Flexible BAR" },
  { value: "rp_nonref", label: "Non-refundable" },
  { value: "rp_breakfast", label: "Breakfast included" }
];

function categoryOptions(groups: ConfigurationCategoryGroup[], categoryCode: string) {
  return groups
    .flatMap((group) => group.categories)
    .find((category) => category.code === categoryCode)
    ?.options.filter((option) => option.active)
    .map((option) => ({ value: option.code, label: option.label })) ?? [];
}

function updateField(setForm: Dispatch<SetStateAction<typeof defaultForm>>, key: keyof typeof defaultForm, value: string) {
  setForm((current) => ({ ...current, [key]: value }));
}

// Re-usable label wrapper for a Cocoa form row. We keep a thin wrapper so spacing
// remains consistent without re-implementing every input's chrome.
function FieldRow({ label, required, hint, children }: { label: string; required?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    <label
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--cocoa-space-1)",
        fontFamily: "var(--cocoa-font)",
        fontSize: "var(--cocoa-fs-body)",
        color: "var(--cocoa-label)"
      }}
    >
      <span style={{ fontSize: "var(--cocoa-fs-subheadline)", color: "var(--cocoa-label-secondary)" }}>
        {label}
        {required ? (
          <span style={{ color: "var(--cocoa-danger)", marginLeft: "var(--cocoa-space-1)" }}>*</span>
        ) : null}
      </span>
      {children}
      {hint ? (
        <span style={{ fontSize: "var(--cocoa-fs-caption)", color: "var(--cocoa-label-tertiary)" }}>{hint}</span>
      ) : null}
    </label>
  );
}

// Standard three-column responsive grid used inside each fieldset.
const gridThreeStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: "var(--cocoa-space-3)"
};

const actionsRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--cocoa-space-2)",
  marginTop: "var(--cocoa-space-3)"
};

const sectionStackStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--cocoa-space-5)"
};

export function ReservationCreateScreen() {
  const { showToast } = useToast();
  const [form, setForm] = useState(defaultForm);
  const [companions, setCompanions] = useState<CompanionGuest[]>([]);
  const [roomTypes, setRoomTypes] = useState<AdminRoomType[]>([]);
  const [rooms, setRooms] = useState<AdminRoom[]>([]);
  const [categoryGroups, setCategoryGroups] = useState<ConfigurationCategoryGroup[]>([]);
  const [quotes, setQuotes] = useState<AvailabilityQuote[]>([]);
  const [createdReservation, setCreatedReservation] = useState<AdminReservation | null>(null);
  const [status, setStatus] = useState("Listo para consultar disponibilidad y crear una reserva.");

  useEffect(() => {
    void Promise.all([fetchRoomTypes(PROPERTY_ID), fetchConfigurationCategories(PROPERTY_ID)])
      .then(([roomTypeResponse, categoryResponse]) => {
        setRoomTypes(roomTypeResponse);
        setCategoryGroups(categoryResponse.groups);
      })
      .catch(() => setStatus("Usando datos de demo. La API no está accesible."));
    void fetchRooms(PROPERTY_ID).then(setRooms).catch(() => setRooms([]));
  }, []);

  const sourceOptions = useMemo(() => categoryOptions(categoryGroups, "reservation_source_codes"), [categoryGroups]);
  const marketOptions = useMemo(() => categoryOptions(categoryGroups, "market_segments"), [categoryGroups]);
  const guaranteeOptions = useMemo(() => categoryOptions(categoryGroups, "guarantee_policies"), [categoryGroups]);
  const cancellationOptions = useMemo(() => categoryOptions(categoryGroups, "cancellation_policies"), [categoryGroups]);
  const billingOptions = useMemo(() => categoryOptions(categoryGroups, "billing_instruction_types"), [categoryGroups]);

  // Build the live select options for each select that supports a backend
  // category override. We always supply at least one option to keep the select
  // legible when the API is empty.
  const roomTypeOptions = useMemo(
    () =>
      roomTypes.length
        ? roomTypes.map((roomType) => ({ value: roomType.id, label: roomType.name }))
        : [{ value: "rt_double", label: "Double" }],
    [roomTypes]
  );

  // Rooms that match the selected room type (for optional assignment at booking).
  const assignableRooms = useMemo(
    () => rooms.filter((room) => !form.roomTypeId || room.roomTypeId === form.roomTypeId),
    [rooms, form.roomTypeId]
  );

  const assignableRoomOptions = useMemo(
    () => [
      { value: "", label: "Sin asignar (se asigna en check-in)" },
      ...assignableRooms.map((room) => ({
        value: room.id,
        label: `${room.number}${room.floor ? ` · ${room.floor}` : ""}`
      }))
    ],
    [assignableRooms]
  );

  // Calculate nights count from arrival/departure for live display.
  const nightsCount = useMemo(() => {
    if (!form.arrivalDate || !form.departureDate) return 0;
    const a = new Date(`${form.arrivalDate}T00:00:00`);
    const d = new Date(`${form.departureDate}T00:00:00`);
    const diff = Math.round((d.getTime() - a.getTime()) / (24 * 60 * 60 * 1000));
    return Math.max(0, diff);
  }, [form.arrivalDate, form.departureDate]);

  // Live taxes preview (IVA reducido 10% for hospedaje en España).
  const taxesPreview = useMemo(() => {
    const total = Number(form.totalAmount) || 0;
    const base = total / 1.1;
    const tax = total - base;
    return { base: base.toFixed(2), tax: tax.toFixed(2) };
  }, [form.totalAmount]);

  function updateCompanion(id: string, key: keyof Omit<CompanionGuest, "id">, value: string) {
    setCompanions((current) =>
      current.map((c) => (c.id === id ? { ...c, [key]: value } : c))
    );
  }

  function addCompanion(type: CompanionGuest["type"]) {
    setCompanions((current) => [...current, newCompanion(type)]);
  }

  function removeCompanion(id: string) {
    setCompanions((current) => current.filter((c) => c.id !== id));
  }

  async function handleQuote() {
    setStatus("Consultando disponibilidad...");
    logBreadcrumb("reservation.quote", "ui", {
      arrivalDate: form.arrivalDate,
      departureDate: form.departureDate,
      adults: Number(form.adults),
      children: Number(form.children)
    });
    try {
      const response = await quoteAvailability(PROPERTY_ID, {
        arrivalDate: form.arrivalDate,
        departureDate: form.departureDate,
        adults: Number(form.adults),
        children: Number(form.children)
      });
      setQuotes(response);
      const firstAvailable = response.find((quote) => quote.availableRooms > 0);
      if (firstAvailable) {
        setForm((current) => ({
          ...current,
          roomTypeId: firstAvailable.roomTypeId,
          totalAmount: String(firstAvailable.totalAmount)
        }));
      }
      setStatus("Disponibilidad consultada. Revisa tarifa, categorías y datos del huésped antes de confirmar.");
      showToast(
        firstAvailable
          ? `Disponibilidad consultada · ${response.length} tipos de habitación`
          : "Sin disponibilidad para esas fechas",
        { variant: firstAvailable ? "success" : "info" }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "No se pudo consultar disponibilidad.";
      setStatus(message);
      showToast(message, { variant: "error" });
    }
  }

  async function handleCreate() {
    setStatus("Creando reserva y abriendo folio...");
    // PII-safe: no incluimos nombre, email ni documento. Solo datos
    // operacionales que ayudan a diagnosticar errores de creación.
    logBreadcrumb("reservation.create.attempt", "mutation", {
      channel: form.channel,
      bookingSource: form.bookingSource,
      roomTypeId: form.roomTypeId,
      arrivalDate: form.arrivalDate,
      departureDate: form.departureDate,
      totalAmount: Number(form.totalAmount),
      paymentMethod: form.paymentMethod,
      companionCount: companions.length
    });
    try {
      const childrenAges = form.childrenAges
        .split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value) && value >= 0);
      const preferences = form.preferences
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      const accessibilityList = form.accessibilityNeeds
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      const dietaryList = form.dietaryRequirements
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);

      const reservation = await createReservation(PROPERTY_ID, {
        // Estancia
        arrivalDate: form.arrivalDate,
        departureDate: form.departureDate,
        nightsCount,
        eta: form.eta || undefined,
        etd: form.etd || undefined,
        estimatedArrivalTime: form.estimatedArrivalTime || form.eta || undefined,
        adults: Number(form.adults),
        children: Number(form.children),
        infants: Number(form.infants) || 0,
        childrenAges: childrenAges.length ? childrenAges : undefined,
        roomsCount: Number(form.roomsCount) || 1,
        roomTypeId: form.roomTypeId,
        assignedRoomId: form.assignedRoomId || undefined,
        // Tarifa
        ratePlanId: form.ratePlanId,
        boardType: form.boardType || undefined,
        totalAmount: Number(form.totalAmount),
        baseAmount: Number(taxesPreview.base),
        taxAmount: Number(taxesPreview.tax),
        currency: "EUR",
        // Origen (commercial provenance)
        bookingSource: form.bookingSource,
        channel: form.channel,
        marketSegment: form.marketSegment,
        sourceCode: form.sourceCode,
        purposeOfStay: form.purposeOfStay || undefined,
        externalReference: form.externalReference || undefined,
        groupCode: form.groupCode || undefined,
        companyName: form.companyName || undefined,
        travelAgentName: form.travelAgentName || undefined,
        bookerName: form.bookerName,
        bookerEmail: form.bookerEmail,
        // Pagos
        paymentMethod: form.paymentMethod,
        depositAmount: form.depositAmount ? Number(form.depositAmount) : undefined,
        depositPaid: form.depositPaid ? Number(form.depositPaid) : undefined,
        depositDueDate: form.depositDueDate || undefined,
        guaranteeType: form.guaranteeType,
        cancellationPolicyCode: form.cancellationPolicyCode,
        billingInstruction: form.billingInstruction,
        // Solicitudes & operativos
        specialRequests: form.specialRequests || undefined,
        accessibilityNeeds: accessibilityList.length ? accessibilityList : undefined,
        dietaryRequirements: dietaryList.length ? dietaryList : undefined,
        vipFlag: form.vipFlag === "yes",
        internalNotes: form.internalNotes || undefined,
        notes: form.notes,
        // Companion guests (acompañantes & bebés)
        companions: companions.length
          ? companions.map((c) => ({
              firstName: c.firstName,
              surname1: c.surname1,
              documentType: c.documentType,
              documentNumber: c.documentNumber || undefined,
              dateOfBirth: c.dateOfBirth || undefined,
              nationality: c.nationality || undefined,
              type: c.type
            }))
          : undefined,
        // Primary guest (titular)
        primaryGuest: {
          title: form.title || undefined,
          firstName: form.firstName,
          middleName: form.middleName || undefined,
          surname1: form.surname1,
          surname2: form.surname2 || undefined,
          phone: form.phone,
          mobilePhone: form.mobilePhone || undefined,
          email: form.email,
          languagePreference: form.languagePreference || undefined,
          company: form.guestCompany || undefined,
          vipCode: form.vipCode || undefined,
          vipFlag: form.vipFlag === "yes",
          loyaltyProgram: form.loyaltyProgram || undefined,
          loyaltyNumber: form.loyaltyNumber || undefined,
          loyaltyTier: form.loyaltyTier || undefined,
          documentType: form.documentType || undefined,
          documentNumber: form.documentNumber || undefined,
          documentSupportNumber: form.documentSupportNumber || undefined,
          documentIssueCountry: form.documentIssueCountry || undefined,
          documentExpiryDate: form.documentExpiryDate || undefined,
          dateOfBirth: form.dateOfBirth || undefined,
          nationality: form.nationality || undefined,
          sex: form.sex || undefined,
          residenceAddress: form.residenceAddress || undefined,
          residenceCountry: form.residenceCountry || undefined,
          residenceProvince: form.residenceProvince || undefined,
          residenceLocality: form.residenceLocality || undefined,
          residencePostalCode: form.residencePostalCode || undefined,
          emergencyContactName: form.emergencyContactName || undefined,
          emergencyContactPhone: form.emergencyContactPhone || undefined,
          marketingConsent: form.marketingConsent === "yes",
          preferences: preferences.length ? preferences : undefined
        }
      });
      setCreatedReservation(reservation);
      setStatus(`Reserva ${reservation.code} creada. Se abrió un folio y se registró el evento de auditoría.`);
      showToast(`Reserva ${reservation.code} creada`, { variant: "success" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "No se pudo crear la reserva.";
      setStatus(message);
      showToast(message, { variant: "error" });
    }
  }

  function handleScanFile(file: File | undefined) {
    if (!file) return;
    setStatus("Escaneando documento con IA…");
    const reader = new FileReader();
    reader.onload = () => {
      void (async () => {
        try {
          const result = await scanIdDocument(String(reader.result));
          if (!result.configured) {
            setStatus(result.message ?? "OCR no configurado; introduce los datos manualmente.");
            return;
          }
          const f = result.fields;
          setForm((current) => ({
            ...current,
            documentType: f.documentType ?? current.documentType,
            documentNumber: f.documentNumber ?? current.documentNumber,
            documentSupportNumber: f.documentSupportNumber ?? current.documentSupportNumber,
            dateOfBirth: f.dateOfBirth ?? current.dateOfBirth,
            nationality: f.nationality ?? current.nationality,
            sex: f.sex ?? current.sex,
            firstName: f.firstName ?? current.firstName,
            surname1: f.surname1 ?? current.surname1,
            surname2: f.surname2 ?? current.surname2
          }));
          setStatus("Documento leído por IA. Revisa los datos antes de confirmar.");
        } catch (error) {
          setStatus(error instanceof Error ? error.message : "No se pudo escanear el documento.");
        }
      })();
    };
    reader.readAsDataURL(file);
  }

  // Convenience parsers for stepper -> string sync. The default form keeps the
  // adults/children/infants/rooms count as strings (existing API contract), so we
  // bridge Cocoa's numeric stepper through Number()/String() at the boundary.
  const parseStepper = (raw: string, fallback: number) => {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };

  return (
    <section className="bo-card">
      <div className="bo-card-head">
        <div>
          <p className="bo-muted">PMS · Manual reservation</p>
          <h2>Create Reservation</h2>
        </div>
        <span className="bo-chip">Manual entry</span>
      </div>
      <p>
        Manual reservation creation must collect the commercial categories, guest details, stay dates, rate context and billing instruction before
        confirming. Critical lifecycle actions still use confirmation workflows.
      </p>

      <div style={sectionStackStyle}>

        {/* ===== 1 · Estancia ===== */}
        <CocoaFormFieldset
          title="1 · Estancia"
          description={`Fechas, ocupación, tipo de habitación y asignación opcional · ${nightsCount} ${nightsCount === 1 ? "noche" : "noches"}`}
        >
          <div style={gridThreeStyle}>
            <FieldRow label="Arrival date" required>
              <CocoaDatePicker value={form.arrivalDate} onChange={(v) => updateField(setForm, "arrivalDate", v)} />
            </FieldRow>
            <FieldRow label="Departure date" required>
              <CocoaDatePicker value={form.departureDate} onChange={(v) => updateField(setForm, "departureDate", v)} />
            </FieldRow>
            <FieldRow label="Noches (auto)" hint="Calculado automáticamente desde las fechas.">
              <CocoaInput value={String(nightsCount)} onChange={() => {}} disabled type="number" />
            </FieldRow>
            <FieldRow label="Nº de habitaciones">
              <CocoaStepper
                value={parseStepper(form.roomsCount, 1)}
                onChange={(n) => updateField(setForm, "roomsCount", String(n))}
                min={1}
              />
            </FieldRow>
            {/* TODO(cocoa): CocoaTimePicker */}
            <FieldRow label="ETA (hora estimada de llegada)">
              <CocoaInput value={form.eta} onChange={(v) => updateField(setForm, "eta", v)} type="time" />
            </FieldRow>
            {/* TODO(cocoa): CocoaTimePicker */}
            <FieldRow label="ETD (hora estimada de salida)">
              <CocoaInput value={form.etd} onChange={(v) => updateField(setForm, "etd", v)} type="time" />
            </FieldRow>
            <FieldRow label="Tipo de habitación" required>
              <CocoaSelect
                value={form.roomTypeId}
                onChange={(v) => updateField(setForm, "roomTypeId", v)}
                options={roomTypeOptions}
              />
            </FieldRow>
            <FieldRow label="Habitación asignada (opcional)" hint="Puede dejarse vacío y asignarse al check-in.">
              <CocoaSelect
                value={form.assignedRoomId}
                onChange={(v) => updateField(setForm, "assignedRoomId", v)}
                options={assignableRoomOptions}
              />
            </FieldRow>
            <FieldRow label="Adultos">
              <CocoaStepper
                value={parseStepper(form.adults, 1)}
                onChange={(n) => updateField(setForm, "adults", String(n))}
                min={1}
              />
            </FieldRow>
            <FieldRow label="Niños">
              <CocoaStepper
                value={parseStepper(form.children, 0)}
                onChange={(n) => updateField(setForm, "children", String(n))}
                min={0}
              />
            </FieldRow>
            <FieldRow label="Bebés">
              <CocoaStepper
                value={parseStepper(form.infants, 0)}
                onChange={(n) => updateField(setForm, "infants", String(n))}
                min={0}
              />
            </FieldRow>
          </div>

          <div style={actionsRowStyle}>
            <CocoaButton variant="filled" tone="accent" onClick={handleQuote}>Consultar disponibilidad</CocoaButton>
            <CocoaButton
              variant="bordered"
              tone="neutral"
              onClick={() => window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: "CategoryManagerScreen" }))}
            >
              Configurar categorías
            </CocoaButton>
          </div>

          {quotes.length ? (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
                gap: "var(--cocoa-space-3)",
                marginTop: "var(--cocoa-space-3)"
              }}
            >
              {quotes.map((quote) => (
                <CocoaCard key={quote.roomTypeId} variant="bordered" padding="md">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--cocoa-space-2)" }}>
                    <h3 style={{ margin: 0, fontSize: "var(--cocoa-fs-headline)", color: "var(--cocoa-label)" }}>{quote.roomTypeName}</h3>
                    <span
                      style={{
                        fontSize: "var(--cocoa-fs-caption)",
                        color: quote.availableRooms > 0 ? "var(--cocoa-success)" : "var(--cocoa-danger)"
                      }}
                    >
                      {quote.availableRooms} disponibles
                    </span>
                  </div>
                  <div style={{ fontSize: "var(--cocoa-fs-title-2)", fontWeight: 600, color: "var(--cocoa-label)" }}>
                    {quote.totalAmount} {quote.currency}
                  </div>
                  <p style={{ marginTop: "var(--cocoa-space-1)", marginBottom: "var(--cocoa-space-3)", color: "var(--cocoa-label-secondary)", fontSize: "var(--cocoa-fs-subheadline)" }}>
                    {quote.cancellationPolicy}
                  </p>
                  <CocoaButton
                    variant="tinted"
                    tone="accent"
                    onClick={() =>
                      setForm((current) => ({
                        ...current,
                        roomTypeId: quote.roomTypeId,
                        totalAmount: String(quote.totalAmount)
                      }))
                    }
                  >
                    Seleccionar este tipo
                  </CocoaButton>
                </CocoaCard>
              ))}
            </div>
          ) : null}
        </CocoaFormFieldset>

        {/* ===== 2 · Huéspedes ===== */}
        <CocoaFormFieldset
          title="2 · Huéspedes"
          description={`Titular, acompañantes y bebés · Adultos ${form.adults} · Niños ${form.children} · Bebés ${form.infants}`}
        >
          {/* TODO(cocoa): OCR dropzone affordance — replace the native file label with a dedicated dropzone primitive when it ships. */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--cocoa-space-2)",
              marginBottom: "var(--cocoa-space-3)",
              flexWrap: "wrap"
            }}
          >
            <label
              style={{
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "var(--cocoa-space-2)"
              }}
            >
              <CocoaButton variant="tinted" tone="accent">Escanear documento (IA)</CocoaButton>
              <input
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                onChange={(event) => handleScanFile(event.target.files?.[0])}
              />
            </label>
            <span style={{ color: "var(--cocoa-label-secondary)", fontSize: "var(--cocoa-fs-subheadline)" }}>
              La IA rellena los campos para que los revises. Nada se guarda sin tu confirmación.
            </span>
          </div>

          <h4 style={{ margin: 0, marginBottom: "var(--cocoa-space-2)", fontSize: "var(--cocoa-fs-headline)", color: "var(--cocoa-label)" }}>
            Datos del titular de la reserva
          </h4>
          <div style={gridThreeStyle}>
            <FieldRow label="Tratamiento">
              <CocoaSelect value={form.title} onChange={(v) => updateField(setForm, "title", v)} options={TITLE_OPTIONS} />
            </FieldRow>
            <FieldRow label="Nombre del huésped" required>
              <CocoaInput value={form.firstName} onChange={(v) => updateField(setForm, "firstName", v)} />
            </FieldRow>
            <FieldRow label="Segundo nombre">
              <CocoaInput value={form.middleName} onChange={(v) => updateField(setForm, "middleName", v)} />
            </FieldRow>
            <FieldRow label="Primer apellido" required>
              <CocoaInput value={form.surname1} onChange={(v) => updateField(setForm, "surname1", v)} />
            </FieldRow>
            <FieldRow label="Segundo apellido">
              <CocoaInput value={form.surname2} onChange={(v) => updateField(setForm, "surname2", v)} />
            </FieldRow>
            <FieldRow label="Idioma preferido">
              <CocoaSelect
                value={form.languagePreference}
                onChange={(v) => updateField(setForm, "languagePreference", v)}
                options={LANGUAGE_OPTIONS}
              />
            </FieldRow>
            <FieldRow label="Email">
              <CocoaInput value={form.email} onChange={(v) => updateField(setForm, "email", v)} type="email" />
            </FieldRow>
            <FieldRow label="Teléfono">
              <CocoaInput value={form.phone} onChange={(v) => updateField(setForm, "phone", v)} type="tel" />
            </FieldRow>
            <FieldRow label="Móvil">
              <CocoaInput value={form.mobilePhone} onChange={(v) => updateField(setForm, "mobilePhone", v)} type="tel" />
            </FieldRow>
          </div>

          <h4 style={{ margin: 0, marginTop: "var(--cocoa-space-4)", marginBottom: "var(--cocoa-space-2)", fontSize: "var(--cocoa-fs-headline)", color: "var(--cocoa-label)" }}>
            Identidad y residencia · SES Hospedajes (RD 933/2021)
          </h4>
          <div style={gridThreeStyle}>
            <FieldRow label="Tipo de documento">
              <CocoaSelect value={form.documentType} onChange={(v) => updateField(setForm, "documentType", v)} options={DOCUMENT_TYPE_OPTIONS} />
            </FieldRow>
            <FieldRow label="Número de documento">
              <CocoaInput value={form.documentNumber} onChange={(v) => updateField(setForm, "documentNumber", v)} placeholder="12345678Z" />
            </FieldRow>
            <FieldRow label="Número de soporte">
              <CocoaInput
                value={form.documentSupportNumber}
                onChange={(v) => updateField(setForm, "documentSupportNumber", v)}
                placeholder="ABC123456"
              />
            </FieldRow>
            <FieldRow label="Fecha de nacimiento">
              <CocoaDatePicker value={form.dateOfBirth} onChange={(v) => updateField(setForm, "dateOfBirth", v)} />
            </FieldRow>
            {/* TODO(cocoa): nationality combobox */}
            <FieldRow label="Nacionalidad (ISO)">
              <CocoaInput value={form.nationality} onChange={(v) => updateField(setForm, "nationality", v)} placeholder="ESP" />
            </FieldRow>
            <FieldRow label="Sexo">
              <CocoaSelect value={form.sex} onChange={(v) => updateField(setForm, "sex", v)} options={SEX_OPTIONS} />
            </FieldRow>
            <FieldRow label="País de expedición">
              <CocoaInput
                value={form.documentIssueCountry}
                onChange={(v) => updateField(setForm, "documentIssueCountry", v)}
                placeholder="ESP"
              />
            </FieldRow>
            <FieldRow label="Caducidad del documento">
              <CocoaDatePicker value={form.documentExpiryDate} onChange={(v) => updateField(setForm, "documentExpiryDate", v)} />
            </FieldRow>
            <FieldRow label="Dirección de residencia">
              <CocoaInput
                value={form.residenceAddress}
                onChange={(v) => updateField(setForm, "residenceAddress", v)}
                placeholder="Calle, número, piso"
              />
            </FieldRow>
            <FieldRow label="Localidad">
              <CocoaInput
                value={form.residenceLocality}
                onChange={(v) => updateField(setForm, "residenceLocality", v)}
                placeholder="Madrid"
              />
            </FieldRow>
            <FieldRow label="Provincia">
              <CocoaInput
                value={form.residenceProvince}
                onChange={(v) => updateField(setForm, "residenceProvince", v)}
                placeholder="Madrid"
              />
            </FieldRow>
            <FieldRow label="Código postal">
              <CocoaInput
                value={form.residencePostalCode}
                onChange={(v) => updateField(setForm, "residencePostalCode", v)}
                placeholder="28001"
              />
            </FieldRow>
            <FieldRow label="País de residencia">
              <CocoaInput
                value={form.residenceCountry}
                onChange={(v) => updateField(setForm, "residenceCountry", v)}
                placeholder="España"
              />
            </FieldRow>
          </div>

          <h4 style={{ margin: 0, marginTop: "var(--cocoa-space-4)", marginBottom: "var(--cocoa-space-2)", fontSize: "var(--cocoa-fs-headline)", color: "var(--cocoa-label)" }}>
            Datos comerciales del titular
          </h4>
          <div style={gridThreeStyle}>
            <FieldRow label="Empresa del huésped">
              <CocoaInput value={form.guestCompany} onChange={(v) => updateField(setForm, "guestCompany", v)} />
            </FieldRow>
            <FieldRow label="Código VIP">
              <CocoaInput value={form.vipCode} onChange={(v) => updateField(setForm, "vipCode", v)} placeholder="VIP1 / VVIP…" />
            </FieldRow>
            <FieldRow label="Booker">
              <CocoaInput value={form.bookerName} onChange={(v) => updateField(setForm, "bookerName", v)} />
            </FieldRow>
            <FieldRow label="Programa de fidelización">
              <CocoaInput value={form.loyaltyProgram} onChange={(v) => updateField(setForm, "loyaltyProgram", v)} />
            </FieldRow>
            <FieldRow label="Nº de socio">
              <CocoaInput value={form.loyaltyNumber} onChange={(v) => updateField(setForm, "loyaltyNumber", v)} />
            </FieldRow>
            <FieldRow label="Nivel / tier">
              <CocoaInput value={form.loyaltyTier} onChange={(v) => updateField(setForm, "loyaltyTier", v)} placeholder="Silver / Gold…" />
            </FieldRow>
          </div>

          {/* Acompañantes dinámicos (add/remove) ─ Mews-style accompanying guests */}
          <h4 style={{ margin: 0, marginTop: "var(--cocoa-space-4)", marginBottom: "var(--cocoa-space-2)", fontSize: "var(--cocoa-fs-headline)", color: "var(--cocoa-label)" }}>
            Composición del grupo · {companions.length} acompañante{companions.length === 1 ? "" : "s"}
          </h4>
          <div style={gridThreeStyle}>
            <FieldRow label="Edades de los niños" hint="Separadas por comas. Requeridas por algunos canales y tarifas familiares.">
              <CocoaInput
                value={form.childrenAges}
                onChange={(v) => updateField(setForm, "childrenAges", v)}
                placeholder="p. ej. 5, 8"
              />
            </FieldRow>
          </div>

          <div style={actionsRowStyle}>
            <CocoaButton variant="bordered" tone="neutral" onClick={() => addCompanion("adult")}>+ Acompañante adulto</CocoaButton>
            <CocoaButton variant="bordered" tone="neutral" onClick={() => addCompanion("child")}>+ Acompañante niño</CocoaButton>
            <CocoaButton variant="bordered" tone="neutral" onClick={() => addCompanion("infant")}>+ Bebé</CocoaButton>
          </div>

          {companions.length ? (
            <div style={{ marginTop: "var(--cocoa-space-3)", display: "flex", flexDirection: "column", gap: "var(--cocoa-space-3)" }}>
              {companions.map((c, index) => (
                <CocoaCard key={c.id} variant="bordered" padding="md">
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: "var(--cocoa-space-2)"
                    }}
                  >
                    <div>
                      <p style={{ margin: 0, fontSize: "var(--cocoa-fs-caption)", color: "var(--cocoa-label-secondary)" }}>
                        Acompañante #{index + 1}
                      </p>
                      <h4 style={{ margin: 0, fontSize: "var(--cocoa-fs-headline)", color: "var(--cocoa-label)" }}>
                        {c.firstName || "Sin nombre"} {c.surname1}
                      </h4>
                    </div>
                    <span
                      style={{
                        fontSize: "var(--cocoa-fs-caption)",
                        color: "var(--cocoa-label-secondary)",
                        padding: "2px var(--cocoa-space-2)",
                        background: "var(--cocoa-background-control)",
                        borderRadius: "var(--cocoa-radius-sm)"
                      }}
                    >
                      {c.type === "adult" ? "Adulto" : c.type === "child" ? "Niño" : "Bebé"}
                    </span>
                  </div>
                  <div style={gridThreeStyle}>
                    <FieldRow label="Nombre">
                      <CocoaInput value={c.firstName} onChange={(v) => updateCompanion(c.id, "firstName", v)} />
                    </FieldRow>
                    <FieldRow label="Apellido">
                      <CocoaInput value={c.surname1} onChange={(v) => updateCompanion(c.id, "surname1", v)} />
                    </FieldRow>
                    <FieldRow label="Fecha de nacimiento">
                      <CocoaDatePicker value={c.dateOfBirth} onChange={(v) => updateCompanion(c.id, "dateOfBirth", v)} />
                    </FieldRow>
                    <FieldRow label="Tipo de documento">
                      <CocoaSelect
                        value={c.documentType}
                        onChange={(v) => updateCompanion(c.id, "documentType", v)}
                        options={DOCUMENT_TYPE_OPTIONS}
                      />
                    </FieldRow>
                    <FieldRow label="Nº de documento">
                      <CocoaInput
                        value={c.documentNumber}
                        onChange={(v) => updateCompanion(c.id, "documentNumber", v)}
                        placeholder="Sólo necesario para >14 años"
                      />
                    </FieldRow>
                    <FieldRow label="Nacionalidad">
                      <CocoaInput
                        value={c.nationality}
                        onChange={(v) => updateCompanion(c.id, "nationality", v)}
                        placeholder="ESP"
                      />
                    </FieldRow>
                  </div>
                  <div style={actionsRowStyle}>
                    <CocoaButton variant="plain" tone="destructive" onClick={() => removeCompanion(c.id)}>Eliminar</CocoaButton>
                  </div>
                </CocoaCard>
              ))}
            </div>
          ) : null}
        </CocoaFormFieldset>

        {/* ===== 3 · Tarifa ===== */}
        <CocoaFormFieldset
          title="3 · Tarifa"
          description={`Plan tarifario, base, total y desglose de IVA · ${form.totalAmount || 0} EUR · ${nightsCount} ${nightsCount === 1 ? "noche" : "noches"}`}
        >
          <div style={gridThreeStyle}>
            <FieldRow label="Plan tarifario">
              <CocoaSelect
                value={form.ratePlanId}
                onChange={(v) => updateField(setForm, "ratePlanId", v)}
                options={RATE_PLAN_OPTIONS}
              />
            </FieldRow>
            <FieldRow label="Régimen (board)">
              <CocoaSelect
                value={form.boardType}
                onChange={(v) => updateField(setForm, "boardType", v)}
                options={BOARD_OPTIONS}
              />
            </FieldRow>
            <FieldRow label="Precio total (€)">
              <CocoaInput
                value={form.totalAmount}
                onChange={(v) => updateField(setForm, "totalAmount", v)}
                type="number"
                inputMode="decimal"
              />
            </FieldRow>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
              gap: "var(--cocoa-space-3)",
              marginTop: "var(--cocoa-space-4)"
            }}
          >
            <CocoaCard variant="bordered" padding="md">
              <span style={{ fontSize: "var(--cocoa-fs-caption)", color: "var(--cocoa-label-secondary)" }}>Base imponible</span>
              <strong style={{ display: "block", marginTop: "var(--cocoa-space-1)", fontSize: "var(--cocoa-fs-title-3)", color: "var(--cocoa-label)" }}>
                {taxesPreview.base} EUR
              </strong>
            </CocoaCard>
            <CocoaCard variant="bordered" padding="md">
              <span style={{ fontSize: "var(--cocoa-fs-caption)", color: "var(--cocoa-label-secondary)" }}>IVA (10%)</span>
              <strong style={{ display: "block", marginTop: "var(--cocoa-space-1)", fontSize: "var(--cocoa-fs-title-3)", color: "var(--cocoa-label)" }}>
                {taxesPreview.tax} EUR
              </strong>
            </CocoaCard>
            <CocoaCard variant="bordered" padding="md">
              <span style={{ fontSize: "var(--cocoa-fs-caption)", color: "var(--cocoa-label-secondary)" }}>Total</span>
              <strong style={{ display: "block", marginTop: "var(--cocoa-space-1)", fontSize: "var(--cocoa-fs-title-3)", color: "var(--cocoa-label)" }}>
                {form.totalAmount || 0} EUR
              </strong>
            </CocoaCard>
            <CocoaCard variant="bordered" padding="md">
              <span style={{ fontSize: "var(--cocoa-fs-caption)", color: "var(--cocoa-label-secondary)" }}>Precio / noche</span>
              <strong style={{ display: "block", marginTop: "var(--cocoa-space-1)", fontSize: "var(--cocoa-fs-title-3)", color: "var(--cocoa-label)" }}>
                {nightsCount > 0 ? (Number(form.totalAmount) / nightsCount).toFixed(2) : "0.00"} EUR
              </strong>
            </CocoaCard>
          </div>
        </CocoaFormFieldset>

        {/* ===== 4 · Origen ===== */}
        <CocoaFormFieldset
          title="4 · Origen"
          description={`Canal, fuente, segmento de mercado y referencias comerciales · ${form.bookingSource} · ${form.marketSegment}`}
        >
          <div style={gridThreeStyle}>
            <FieldRow label="Booking source" hint="Cómo entró la reserva (directo, OTA, walk-in, teléfono…).">
              <CocoaSelect
                value={form.bookingSource}
                onChange={(v) => updateField(setForm, "bookingSource", v)}
                options={BOOKING_SOURCE_OPTIONS}
              />
            </FieldRow>
            <FieldRow label="Market segment" hint="Corporate, Leisure, MICE, Wedding, Sports, Group…">
              <CocoaSelect
                value={form.marketSegment}
                onChange={(v) => updateField(setForm, "marketSegment", v)}
                options={marketOptions.length ? marketOptions : MARKET_SEGMENT_OPTIONS}
              />
            </FieldRow>
            <FieldRow label="Channel" hint="Canal técnico de distribución.">
              <CocoaSelect
                value={form.channel}
                onChange={(v) => updateField(setForm, "channel", v)}
                options={CHANNEL_OPTIONS}
              />
            </FieldRow>
            <FieldRow label="Source code">
              <CocoaSelect
                value={form.sourceCode}
                onChange={(v) => updateField(setForm, "sourceCode", v)}
                options={
                  sourceOptions.length
                    ? sourceOptions
                    : [
                        { value: "direct_web", label: "Direct web" },
                        { value: "phone", label: "Phone" }
                      ]
                }
              />
            </FieldRow>
            <FieldRow label="Motivo de la estancia">
              <CocoaSelect
                value={form.purposeOfStay}
                onChange={(v) => updateField(setForm, "purposeOfStay", v)}
                options={PURPOSE_OPTIONS}
              />
            </FieldRow>
            <FieldRow label="Localizador externo (OTA)">
              <CocoaInput
                value={form.externalReference}
                onChange={(v) => updateField(setForm, "externalReference", v)}
                placeholder="Confirmación del canal"
              />
            </FieldRow>
            <FieldRow label="Empresa (facturación)">
              <CocoaInput
                value={form.companyName}
                onChange={(v) => updateField(setForm, "companyName", v)}
                placeholder="Razón social"
              />
            </FieldRow>
            <FieldRow label="Agencia de viajes">
              <CocoaInput
                value={form.travelAgentName}
                onChange={(v) => updateField(setForm, "travelAgentName", v)}
                placeholder="Travel agent / TTOO"
              />
            </FieldRow>
            <FieldRow label="Código de grupo / bloqueo">
              <CocoaInput
                value={form.groupCode}
                onChange={(v) => updateField(setForm, "groupCode", v)}
                placeholder="GRP-2026-..."
              />
            </FieldRow>
            <FieldRow label="Booker name">
              <CocoaInput
                value={form.bookerName}
                onChange={(v) => updateField(setForm, "bookerName", v)}
                placeholder="Quien hace la reserva (si != huésped)"
              />
            </FieldRow>
            <FieldRow label="Booker email">
              <CocoaInput
                value={form.bookerEmail}
                onChange={(v) => updateField(setForm, "bookerEmail", v)}
                type="email"
              />
            </FieldRow>
          </div>
        </CocoaFormFieldset>

        {/* ===== 5 · Pagos ===== */}
        <CocoaFormFieldset
          title="5 · Pagos"
          description={`Método de pago, garantía, depósito y políticas comerciales · ${form.depositPaid || 0} / ${form.depositAmount || 0} EUR`}
        >
          <div style={gridThreeStyle}>
            <FieldRow label="Método de pago" hint="Tipo de cobro acordado con el huésped.">
              <CocoaSelect
                value={form.paymentMethod}
                onChange={(v) => updateField(setForm, "paymentMethod", v)}
                options={PAYMENT_METHOD_OPTIONS}
              />
            </FieldRow>
            <FieldRow label="Depósito requerido (€)" hint="Importe total a cobrar como anticipo.">
              <CocoaInput
                value={form.depositAmount}
                onChange={(v) => updateField(setForm, "depositAmount", v)}
                type="number"
                inputMode="decimal"
                placeholder="0.00"
              />
            </FieldRow>
            <FieldRow label="Depósito ya cobrado (€)" hint="Cantidad ya pagada por el huésped.">
              <CocoaInput
                value={form.depositPaid}
                onChange={(v) => updateField(setForm, "depositPaid", v)}
                type="number"
                inputMode="decimal"
                placeholder="0.00"
              />
            </FieldRow>
            <FieldRow label="Vencimiento del depósito" hint="Fecha límite para cobrar el anticipo.">
              <CocoaDatePicker value={form.depositDueDate} onChange={(v) => updateField(setForm, "depositDueDate", v)} />
            </FieldRow>
            <FieldRow label="Garantía">
              <CocoaSelect
                value={form.guaranteeType}
                onChange={(v) => updateField(setForm, "guaranteeType", v)}
                options={guaranteeOptions.length ? guaranteeOptions : [{ value: "card_guarantee", label: "Card guarantee" }]}
              />
            </FieldRow>
            <FieldRow label="Política de cancelación">
              <CocoaSelect
                value={form.cancellationPolicyCode}
                onChange={(v) => updateField(setForm, "cancellationPolicyCode", v)}
                options={
                  cancellationOptions.length
                    ? cancellationOptions
                    : [{ value: "flexible_18", label: "Flexible until 18:00 previous day" }]
                }
              />
            </FieldRow>
            <FieldRow label="Instrucción de cobro">
              <CocoaSelect
                value={form.billingInstruction}
                onChange={(v) => updateField(setForm, "billingInstruction", v)}
                options={
                  billingOptions.length
                    ? billingOptions
                    : [
                        { value: "guest_pays_checkout", label: "Guest pays at checkout" },
                        { value: "company_invoice", label: "Company invoice" }
                      ]
                }
              />
            </FieldRow>
          </div>
        </CocoaFormFieldset>

        {/* ===== 6 · Solicitudes ===== */}
        <CocoaFormFieldset
          title="6 · Solicitudes"
          description={`Peticiones especiales, accesibilidad, dieta, ETA y notas internas · ${form.vipFlag === "yes" ? "VIP" : "Estándar"}`}
        >
          <div style={gridThreeStyle}>
            {/* TODO(cocoa): CocoaTimePicker */}
            <FieldRow label="Hora estimada de llegada" hint="Para preparar bienvenida y operativa de front desk.">
              <CocoaInput
                value={form.estimatedArrivalTime}
                onChange={(v) => updateField(setForm, "estimatedArrivalTime", v)}
                type="time"
              />
            </FieldRow>
            <FieldRow label="Preferencias" hint="Separadas por comas (planta, tipo de cama, almohada, vista…).">
              <CocoaInput
                value={form.preferences}
                onChange={(v) => updateField(setForm, "preferences", v)}
                placeholder="planta alta, cama king, no fumador"
              />
            </FieldRow>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--cocoa-space-2)" }}>
              <CocoaSwitch
                checked={form.vipFlag === "yes"}
                onChange={(v) => updateField(setForm, "vipFlag", v ? "yes" : "")}
                label="Marcar como VIP"
              />
            </div>
            <FieldRow label="Contacto de emergencia">
              <CocoaInput
                value={form.emergencyContactName}
                onChange={(v) => updateField(setForm, "emergencyContactName", v)}
                placeholder="Nombre"
              />
            </FieldRow>
            <FieldRow label="Tel. de emergencia">
              <CocoaInput
                value={form.emergencyContactPhone}
                onChange={(v) => updateField(setForm, "emergencyContactPhone", v)}
                type="tel"
              />
            </FieldRow>
          </div>

          <div style={{ marginTop: "var(--cocoa-space-3)" }}>
            <FieldRow
              label="Necesidades de accesibilidad"
              hint="Separadas por comas. Visible para housekeeping y front desk."
            >
              <CocoaInput
                value={form.accessibilityNeeds}
                onChange={(v) => updateField(setForm, "accessibilityNeeds", v)}
                placeholder="silla de ruedas, ducha adaptada, planta baja…"
              />
            </FieldRow>
          </div>

          <div style={{ marginTop: "var(--cocoa-space-3)" }}>
            <FieldRow label="Requisitos dietéticos" hint="Separados por comas. Importante para F&B.">
              <CocoaInput
                value={form.dietaryRequirements}
                onChange={(v) => updateField(setForm, "dietaryRequirements", v)}
                placeholder="vegano, sin gluten, alergia frutos secos…"
              />
            </FieldRow>
          </div>

          <div style={{ marginTop: "var(--cocoa-space-3)" }}>
            <FieldRow label="Peticiones especiales (visibles para el huésped)">
              <textarea
                value={form.specialRequests}
                onChange={(event) => updateField(setForm, "specialRequests", event.target.value)}
                placeholder="Cuna, llegada tardía, late check-out…"
                style={{
                  width: "100%",
                  minHeight: "80px",
                  padding: "var(--cocoa-space-2) var(--cocoa-space-3)",
                  fontFamily: "var(--cocoa-font)",
                  fontSize: "var(--cocoa-fs-body)",
                  color: "var(--cocoa-label)",
                  background: "var(--cocoa-background-control)",
                  border: "1px solid var(--cocoa-separator)",
                  borderRadius: "var(--cocoa-radius-md)",
                  resize: "vertical",
                  boxSizing: "border-box"
                }}
              />
            </FieldRow>
          </div>

          <div style={{ marginTop: "var(--cocoa-space-3)" }}>
            <FieldRow label="Notas internas (solo staff)">
              <textarea
                value={form.internalNotes}
                onChange={(event) => updateField(setForm, "internalNotes", event.target.value)}
                placeholder="Información operativa que el huésped no debe ver."
                style={{
                  width: "100%",
                  minHeight: "80px",
                  padding: "var(--cocoa-space-2) var(--cocoa-space-3)",
                  fontFamily: "var(--cocoa-font)",
                  fontSize: "var(--cocoa-fs-body)",
                  color: "var(--cocoa-label)",
                  background: "var(--cocoa-background-control)",
                  border: "1px solid var(--cocoa-separator)",
                  borderRadius: "var(--cocoa-radius-md)",
                  resize: "vertical",
                  boxSizing: "border-box"
                }}
              />
            </FieldRow>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "var(--cocoa-space-2)", marginTop: "var(--cocoa-space-3)" }}>
            <CocoaSwitch
              checked={form.marketingConsent === "yes"}
              onChange={(v) => updateField(setForm, "marketingConsent", v ? "yes" : "")}
              label="El huésped consiente recibir comunicaciones de marketing (RGPD)"
            />
          </div>

          <div style={{ marginTop: "var(--cocoa-space-3)" }}>
            <FieldRow label="Notas adicionales">
              <textarea
                value={form.notes}
                onChange={(event) => updateField(setForm, "notes", event.target.value)}
                placeholder="Otras anotaciones generales."
                style={{
                  width: "100%",
                  minHeight: "80px",
                  padding: "var(--cocoa-space-2) var(--cocoa-space-3)",
                  fontFamily: "var(--cocoa-font)",
                  fontSize: "var(--cocoa-fs-body)",
                  color: "var(--cocoa-label)",
                  background: "var(--cocoa-background-control)",
                  border: "1px solid var(--cocoa-separator)",
                  borderRadius: "var(--cocoa-radius-md)",
                  resize: "vertical",
                  boxSizing: "border-box"
                }}
              />
            </FieldRow>
          </div>
        </CocoaFormFieldset>
      </div>

      <div style={actionsRowStyle}>
        <CocoaButton variant="filled" tone="accent" onClick={handleCreate}>Confirmar y crear reserva</CocoaButton>
        <CocoaButton
          variant="bordered"
          tone="neutral"
          onClick={() => window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: "ReservationWorkspace" }))}
        >
          Abrir espacio de reservas
        </CocoaButton>
      </div>
      {status ? <p style={{ marginTop: "var(--cocoa-space-2)", color: "var(--cocoa-label-secondary)" }}>{status}</p> : null}
      {createdReservation ? (
        <CocoaCard variant="elevated" padding="md" className="bo-card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--cocoa-space-2)" }}>
            <h3 style={{ margin: 0, fontSize: "var(--cocoa-fs-headline)", color: "var(--cocoa-label)" }}>
              {createdReservation.code}
            </h3>
            <span style={{ fontSize: "var(--cocoa-fs-caption)", color: "var(--cocoa-success)" }}>Created</span>
          </div>
          <p style={{ color: "var(--cocoa-label-secondary)" }}>
            Reserva guardada, primary guest linked and an open folio was created.
          </p>
          <div style={actionsRowStyle}>
            <CocoaButton
              variant="bordered"
              tone="neutral"
              onClick={() => {
                window.history.pushState(null, "", `/backoffice/reservations/${createdReservation.id}`);
                window.dispatchEvent(new PopStateEvent("popstate"));
              }}
            >
              Open reservation detail
            </CocoaButton>
            <CocoaButton
              variant="bordered"
              tone="neutral"
              onClick={() => window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: "BillingCenter" }))}
            >
              Open billing center
            </CocoaButton>
          </div>
        </CocoaCard>
      ) : null}
    </section>
  );
}
