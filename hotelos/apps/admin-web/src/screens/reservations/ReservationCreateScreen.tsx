// Nueva reserva — Recepción › Nueva reserva › Formulario (/recepcion/reservas/nueva).
//
// Cocoa 22 · ola 3 · lote 3-A (wizard archetype, template `Asistente`; there is
// no step primitive yet, so the indicator is CocoaChart.Progress + an
// `ol.c22-section__list` with CocoaBadge dots — handoff CocoaSteps): the six
// blocks of the booking form (Estancia · Huéspedes · Tarifa · Origen · Pagos ·
// Solicitudes) become six steps, one CocoaFormSection group per step, with
// Anterior / Siguiente in a CocoaActionBar and «Confirmar y crear reserva» on
// the last one. Every field keeps its key and the request body is the same
// createReservation payload as before (nothing is sent until the last step);
// the availability quote, the OCR scan (CocoaFileInput) and the companions
// list are untouched. On success the page paints `state="empty"` with the
// success illustration and the two follow-up actions. Hosted inside
// NuevaReservaTabs the container paints the title.

import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { getActivePropertyId } from "../../services/activeProperty";
import { urlForScreen } from "../../navigation/nav-tree";
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
import { useTabHost } from "../tabs/TabHost";
import { navigateTo } from "../../lib/navigate";
import { money, plural } from "../../lib/format";
import { ACTIONS, FIELD_LABELS } from "../../content/actions";
import {
  CocoaActionBar,
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaCard,
  CocoaChart,
  CocoaDatePicker,
  CocoaField,
  CocoaFileInput,
  CocoaFormRow,
  CocoaFormSection,
  CocoaGrid,
  CocoaInput,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaSpan,
  CocoaStat,
  CocoaStepper,
  CocoaSwitch,
  openTabPath,
  type CocoaTone
} from "../../components/cocoa";

const PROPERTY_ID = getActivePropertyId();

const TODAY_ISO = new Date().toISOString().slice(0, 10);
const TOMORROW_ISO = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

// Companion guest — accompanying guests linked to the primary reservation. The
// titular fills in their own data in the main form; companions are added
// dynamically (add/remove) inside the Huéspedes step.
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

const COMPANION_TYPE_LABEL: Record<CompanionGuest["type"], string> = { adult: "Adulto", child: "Niño", infant: "Bebé" };

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
  roomTypeId: "",
  assignedRoomId: "",
  // ── Tarifa ─────────────────────────────────────────────────────────────
  ratePlanId: "",
  boardType: "BB",
  totalAmount: "",
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
  bookerName: "",
  bookerEmail: "",
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
  firstName: "",
  middleName: "",
  surname1: "",
  surname2: "",
  email: "",
  phone: "",
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

type FormValues = typeof defaultForm;

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
const BOOKING_SOURCE_OPTIONS = [
  { value: "direct", label: "Directo (web / correo)" },
  { value: "phone", label: "Teléfono" },
  { value: "email", label: "Correo electrónico" },
  { value: "walk_in", label: "Walk-in" },
  { value: "booking_com", label: "Booking.com" },
  { value: "expedia", label: "Expedia" },
  { value: "airbnb", label: "Airbnb" },
  { value: "wholesale", label: "Mayorista / TTOO" },
  { value: "gds", label: "GDS" },
  { value: "corporate", label: "Corporativo" }
];

// Market segment — MICE, weddings and sports segments included for revenue analysis.
const MARKET_SEGMENT_OPTIONS = [
  { value: "corporate", label: "Corporativo" },
  { value: "leisure", label: "Ocio" },
  { value: "mice", label: "MICE / Convenciones" },
  { value: "wedding", label: "Bodas" },
  { value: "sports", label: "Deportes" },
  { value: "group", label: "Grupos" },
  { value: "government", label: "Administración pública" },
  { value: "wholesale", label: "Mayorista" },
  { value: "complimentary", label: "Cortesía" }
];

const PAYMENT_METHOD_OPTIONS = [
  { value: "cash", label: "Efectivo" },
  { value: "credit_card", label: "Tarjeta de crédito" },
  { value: "debit_card", label: "Tarjeta de débito" },
  { value: "bank_transfer", label: "Transferencia bancaria" },
  { value: "voucher", label: "Bono / tarjeta regalo" },
  { value: "company_invoice", label: "Factura a empresa" },
  { value: "online_prepaid", label: "Prepago en línea (OTA)" },
  { value: "pms_account", label: "Cuenta PMS / facturación directa" }
];

const CHANNEL_OPTIONS = [
  { value: "direct", label: "Directo" },
  { value: "booking_com_mock", label: "Booking.com (conector de pruebas)" },
  { value: "expedia_mock", label: "Expedia (conector de pruebas)" },
  { value: "corporate", label: "Corporativo" }
];

const RATE_PLAN_OPTIONS = [
  { value: "", label: "Sin plan tarifario" },
  { value: "rp_flexible", label: "Flexible BAR" },
  { value: "rp_nonref", label: "No reembolsable" },
  { value: "rp_breakfast", label: "Desayuno incluido" }
];

// Steps of the wizard: one CocoaFormSection group each.
type StepKey = "estancia" | "huespedes" | "tarifa" | "origen" | "pagos" | "solicitudes";
const STEPS: Array<{ key: StepKey; label: string; description: string }> = [
  { key: "estancia", label: "Estancia", description: "Fechas, ocupación, tipo de habitación y asignación opcional." },
  { key: "huespedes", label: "Huéspedes", description: "Titular, identidad y residencia (SES Hospedajes) y acompañantes." },
  { key: "tarifa", label: "Tarifa", description: "Plan tarifario, régimen, total y desglose de IVA." },
  { key: "origen", label: "Origen", description: "Canal, fuente, segmento de mercado y referencias comerciales." },
  { key: "pagos", label: "Pagos", description: "Método de pago, garantía, depósito y políticas comerciales." },
  { key: "solicitudes", label: "Solicitudes", description: "Peticiones especiales, accesibilidad, dieta y notas internas." }
];

function categoryOptions(groups: ConfigurationCategoryGroup[], categoryCode: string) {
  return groups
    .flatMap((group) => group.categories)
    .find((category) => category.code === categoryCode)
    ?.options.filter((option) => option.active)
    .map((option) => ({ value: option.code, label: option.label })) ?? [];
}

function updateField(setForm: Dispatch<SetStateAction<FormValues>>, key: keyof FormValues, value: string) {
  setForm((current) => ({ ...current, [key]: value }));
}

// A11y (audit 2026-06 · #14): focus the first invalid required field after
// the wizard has switched to its step, so the error is never off-screen.
function focusField(id: string) {
  if (typeof document === "undefined") return;
  window.requestAnimationFrame(() => {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.focus({ preventScroll: true });
  });
}

// Stepper to string bridge: the form keeps the counts as strings (existing API
// contract), so Cocoa's numeric stepper is parsed at the boundary.
function parseStepper(raw: string, fallback: number) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function ReservationCreateScreen() {
  const hosted = useTabHost() !== null;
  const { showToast } = useToast();
  const [form, setForm] = useState<FormValues>(defaultForm);
  const [companions, setCompanions] = useState<CompanionGuest[]>([]);
  const [roomTypes, setRoomTypes] = useState<AdminRoomType[]>([]);
  const [rooms, setRooms] = useState<AdminRoom[]>([]);
  const [categoryGroups, setCategoryGroups] = useState<ConfigurationCategoryGroup[]>([]);
  const [quotes, setQuotes] = useState<AvailabilityQuote[]>([]);
  const [createdReservation, setCreatedReservation] = useState<AdminReservation | null>(null);
  const [status, setStatus] = useState("Listo para consultar disponibilidad y crear una reserva.");
  const [step, setStep] = useState(0);
  const [quoting, setQuoting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [attempted, setAttempted] = useState(false);

  useEffect(() => {
    // Auditoría 2026-07: cargas INDEPENDIENTES. Antes un Promise.all descartaba
    // los tipos de habitación reales si fallaba la llamada de categorías.
    void fetchRoomTypes(PROPERTY_ID)
      .then(setRoomTypes)
      .catch(() => setStatus("No se pudieron cargar los tipos de habitación. Reintenta."));
    void fetchConfigurationCategories(PROPERTY_ID)
      .then((categoryResponse) => setCategoryGroups(categoryResponse.groups))
      .catch(() => undefined); // opcional: los selects usan sus valores locales
    void fetchRooms(PROPERTY_ID).then(setRooms).catch(() => setRooms([]));
  }, []);

  const sourceOptions = useMemo(() => categoryOptions(categoryGroups, "reservation_source_codes"), [categoryGroups]);
  const marketOptions = useMemo(() => categoryOptions(categoryGroups, "market_segments"), [categoryGroups]);
  const guaranteeOptions = useMemo(() => categoryOptions(categoryGroups, "guarantee_policies"), [categoryGroups]);
  const cancellationOptions = useMemo(() => categoryOptions(categoryGroups, "cancellation_policies"), [categoryGroups]);
  const billingOptions = useMemo(() => categoryOptions(categoryGroups, "billing_instruction_types"), [categoryGroups]);

  // Auditoría 2026-07: sin tipos de habitación no hay opción inventada; el
  // selector queda vacío con su placeholder y el alta se bloquea.
  const roomTypeOptions = useMemo(() => roomTypes.map((roomType) => ({ value: roomType.id, label: roomType.name })), [roomTypes]);

  // Rooms that match the selected room type (for optional assignment at booking).
  const assignableRoomOptions = useMemo(
    () => [
      { value: "", label: "Sin asignar (se asigna en el check-in)" },
      ...rooms
        .filter((room) => !form.roomTypeId || room.roomTypeId === form.roomTypeId)
        .map((room) => ({ value: room.id, label: `${room.number}${room.floor ? ` · ${room.floor}` : ""}` }))
    ],
    [rooms, form.roomTypeId]
  );

  // Nights from arrival/departure for live display.
  const nightsCount = useMemo(() => {
    if (!form.arrivalDate || !form.departureDate) return 0;
    const a = new Date(`${form.arrivalDate}T00:00:00`);
    const d = new Date(`${form.departureDate}T00:00:00`);
    const diff = Math.round((d.getTime() - a.getTime()) / (24 * 60 * 60 * 1000));
    return Math.max(0, diff);
  }, [form.arrivalDate, form.departureDate]);

  // Live taxes preview (IVA reducido 10 % for hospedaje en España).
  const taxesPreview = useMemo(() => {
    const total = Number(form.totalAmount) || 0;
    const base = Math.round((total / 1.1) * 100) / 100;
    const tax = Math.round((total - base) * 100) / 100;
    return { base, tax, total };
  }, [form.totalAmount]);

  function updateCompanion(id: string, key: keyof Omit<CompanionGuest, "id">, value: string) {
    setCompanions((current) => current.map((c) => (c.id === id ? { ...c, [key]: value } : c)));
  }
  function addCompanion(type: CompanionGuest["type"]) {
    setCompanions((current) => [...current, newCompanion(type)]);
  }
  function removeCompanion(id: string) {
    setCompanions((current) => current.filter((c) => c.id !== id));
  }

  async function handleQuote() {
    setQuoting(true);
    setStatus("Consultando disponibilidad…");
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
        setForm((current) => ({ ...current, roomTypeId: firstAvailable.roomTypeId, totalAmount: String(firstAvailable.totalAmount) }));
      }
      setStatus("Disponibilidad consultada. Revisa tarifa, categorías y datos del huésped antes de confirmar.");
      showToast(firstAvailable ? `Disponibilidad consultada · ${plural(response.length, "tipo de habitación", "tipos de habitación")}` : "Sin disponibilidad para esas fechas", {
        variant: firstAvailable ? "success" : "info"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "No se pudo consultar la disponibilidad.";
      setStatus(message);
      showToast(message, { variant: "error" });
    } finally {
      setQuoting(false);
    }
  }

  async function handleCreate() {
    // Required-field guard. Defaults are blank on purpose (no demo guest
    // pre-filled): block without a room type (500 on the FK) or a guest name.
    setAttempted(true);
    if (!form.roomTypeId) {
      const message = "Selecciona un tipo de habitación antes de crear la reserva.";
      setStatus(message);
      showToast(message, { variant: "error" });
      setStep(0);
      focusField("rc-field-roomtype");
      return;
    }
    if (!form.firstName.trim() || !form.surname1.trim()) {
      const message = "Indica al menos el nombre y el primer apellido del huésped.";
      setStatus(message);
      showToast(message, { variant: "error" });
      setStep(1);
      focusField(!form.firstName.trim() ? "rc-field-firstname" : "rc-field-surname1");
      return;
    }
    setCreating(true);
    setStatus("Creando reserva y abriendo folio…");
    // PII-safe: no name, email or document; only operational data.
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
        roomTypeId: form.roomTypeId || undefined,
        assignedRoomId: form.assignedRoomId || undefined,
        // Tarifa
        ratePlanId: form.ratePlanId || undefined,
        boardType: form.boardType || undefined,
        totalAmount: Number(form.totalAmount),
        baseAmount: taxesPreview.base,
        taxAmount: taxesPreview.tax,
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
    } finally {
      setCreating(false);
    }
  }

  function handleScanFile(file: File) {
    setStatus("Leyendo el documento con IA…");
    const reader = new FileReader();
    reader.onload = () => {
      void (async () => {
        try {
          const result = await scanIdDocument(String(reader.result));
          if (!result.configured) {
            setStatus(result.message ?? "Lectura de documentos no configurada; introduce los datos manualmente.");
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
          setStatus(error instanceof Error ? error.message : "No se pudo leer el documento.");
        }
      })();
    };
    reader.readAsDataURL(file);
  }

  const set = (key: keyof FormValues) => (value: string) => updateField(setForm, key, value);
  const last = step === STEPS.length - 1;
  const current = STEPS[step];
  const roomTypeError = attempted && !form.roomTypeId ? "Selecciona un tipo de habitación." : undefined;
  const firstNameError = attempted && !form.firstName.trim() ? "El nombre es obligatorio." : undefined;
  const surnameError = attempted && !form.surname1.trim() ? "El primer apellido es obligatorio." : undefined;

  function stepTone(index: number): CocoaTone {
    return index < step ? "success" : index === step ? "accent" : "neutral";
  }

  function openCreated() {
    if (!createdReservation) return;
    openTabPath(urlForScreen("ReservationDetailWorkspace", { id: createdReservation.id }) ?? "/recepcion/reservas");
  }

  const stepSummary = `Paso ${step + 1} de ${STEPS.length} · ${money(taxesPreview.total)} · ${plural(nightsCount, "noche", "noches")}`;

  function renderStep() {
    switch (current.key) {
      case "estancia":
        return (
          <CocoaFormSection
            title="Estancia"
            description={`Fechas, ocupación, tipo de habitación y asignación opcional · ${plural(nightsCount, "noche", "noches")}`}
            actions={
              <>
                <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => navigateTo("CategoryManagerScreen")}>
                  Configurar categorías
                </CocoaButton>
                <CocoaButton variant="filled" tone="accent" size="small" loading={quoting} disabled={quoting} onClick={() => void handleQuote()}>
                  Consultar disponibilidad
                </CocoaButton>
              </>
            }
          >
            <CocoaFormRow columns={3} min={220}>
              <CocoaField label="Fecha de llegada" required>
                <CocoaDatePicker value={form.arrivalDate} onChange={set("arrivalDate")} />
              </CocoaField>
              <CocoaField label="Fecha de salida" required>
                <CocoaDatePicker value={form.departureDate} onChange={set("departureDate")} />
              </CocoaField>
              <CocoaField label="Noches" help="Calculadas desde las fechas.">
                <CocoaInput value={String(nightsCount)} onChange={() => undefined} readOnly />
              </CocoaField>
              <CocoaField label={FIELD_LABELS.roomType} required error={roomTypeError} help={roomTypes.length === 0 ? "Sin tipos de habitación: configúralos primero." : undefined}>
                <CocoaSelect id="rc-field-roomtype" value={form.roomTypeId} onChange={set("roomTypeId")} options={roomTypeOptions} placeholder="Selecciona un tipo…" />
              </CocoaField>
              <CocoaField label="Habitación asignada" hint="opcional" help="Puede dejarse vacía y asignarse en el check-in.">
                <CocoaSelect value={form.assignedRoomId} onChange={set("assignedRoomId")} options={assignableRoomOptions} />
              </CocoaField>
              <CocoaField label="Número de habitaciones">
                <CocoaStepper value={parseStepper(form.roomsCount, 1)} onChange={(n) => updateField(setForm, "roomsCount", String(n))} min={1} />
              </CocoaField>
              <CocoaField label="Adultos">
                <CocoaStepper value={parseStepper(form.adults, 1)} onChange={(n) => updateField(setForm, "adults", String(n))} min={1} />
              </CocoaField>
              <CocoaField label="Niños">
                <CocoaStepper value={parseStepper(form.children, 0)} onChange={(n) => updateField(setForm, "children", String(n))} min={0} />
              </CocoaField>
              <CocoaField label="Bebés">
                <CocoaStepper value={parseStepper(form.infants, 0)} onChange={(n) => updateField(setForm, "infants", String(n))} min={0} />
              </CocoaField>
              <CocoaField label="Hora prevista de llegada">
                <CocoaInput value={form.eta} onChange={set("eta")} type="time" />
              </CocoaField>
              <CocoaField label="Hora prevista de salida">
                <CocoaInput value={form.etd} onChange={set("etd")} type="time" />
              </CocoaField>
            </CocoaFormRow>

            {quotes.length > 0 ? (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "var(--cocoa-space-3)" }}>
                {quotes.map((quote) => {
                  const selected = form.roomTypeId === quote.roomTypeId;
                  return (
                    <CocoaCard key={quote.roomTypeId} variant="bordered" padding="md" role="group" aria-label={quote.roomTypeName}>
                      <div className="cocoa-stack" data-gap="2">
                        <span className="cocoa-row" data-gap="2" data-justify="between">
                          <strong>{quote.roomTypeName}</strong>
                          <CocoaBadge tone={quote.availableRooms > 0 ? "success" : "danger"} size="small">
                            {plural(quote.availableRooms, "disponible", "disponibles")}
                          </CocoaBadge>
                        </span>
                        <CocoaStat label="Total de la estancia" value={money(quote.totalAmount, quote.currency)} hint={quote.cancellationPolicy} />
                        <div className="cocoa-row" data-gap="2">
                          <CocoaButton
                            variant={selected ? "filled" : "tinted"}
                            tone="accent"
                            size="small"
                            aria-pressed={selected}
                            onClick={() => setForm((c) => ({ ...c, roomTypeId: quote.roomTypeId, totalAmount: String(quote.totalAmount) }))}
                          >
                            {selected ? "Tipo seleccionado" : "Seleccionar este tipo"}
                          </CocoaButton>
                        </div>
                      </div>
                    </CocoaCard>
                  );
                })}
              </div>
            ) : null}
          </CocoaFormSection>
        );

      case "huespedes":
        return (
          <div className="cocoa-stack" data-gap="4">
            <CocoaFormSection
              title="Titular de la reserva"
              description="La IA rellena los campos a partir del documento para que los revises. Nada se guarda sin tu confirmación."
              actions={<CocoaFileInput label="Escanear documento (IA)" accept="image/*" onPick={handleScanFile} onReject={(message) => setStatus(message)} />}
            >
              <CocoaFormRow columns={3} min={220}>
                <CocoaField label="Tratamiento">
                  <CocoaSelect value={form.title} onChange={set("title")} options={TITLE_OPTIONS} />
                </CocoaField>
                <CocoaField label="Nombre" required error={firstNameError}>
                  <CocoaInput id="rc-field-firstname" value={form.firstName} onChange={set("firstName")} autoComplete="off" />
                </CocoaField>
                <CocoaField label="Segundo nombre">
                  <CocoaInput value={form.middleName} onChange={set("middleName")} autoComplete="off" />
                </CocoaField>
                <CocoaField label="Primer apellido" required error={surnameError}>
                  <CocoaInput id="rc-field-surname1" value={form.surname1} onChange={set("surname1")} autoComplete="off" />
                </CocoaField>
                <CocoaField label="Segundo apellido">
                  <CocoaInput value={form.surname2} onChange={set("surname2")} autoComplete="off" />
                </CocoaField>
                <CocoaField label="Idioma preferido">
                  <CocoaSelect value={form.languagePreference} onChange={set("languagePreference")} options={LANGUAGE_OPTIONS} />
                </CocoaField>
                <CocoaField label={FIELD_LABELS.email}>
                  <CocoaInput value={form.email} onChange={set("email")} type="email" autoComplete="off" />
                </CocoaField>
                <CocoaField label={FIELD_LABELS.phone}>
                  <CocoaInput value={form.phone} onChange={set("phone")} type="tel" autoComplete="off" />
                </CocoaField>
                <CocoaField label="Móvil">
                  <CocoaInput value={form.mobilePhone} onChange={set("mobilePhone")} type="tel" autoComplete="off" />
                </CocoaField>
              </CocoaFormRow>
            </CocoaFormSection>

            <CocoaFormSection title="Identidad y residencia" description="Datos del parte de viajeros (SES Hospedajes, RD 933/2021). Opcionales al reservar; se completan en el check-in.">
              <CocoaFormRow columns={3} min={220}>
                <CocoaField label="Tipo de documento">
                  <CocoaSelect value={form.documentType} onChange={set("documentType")} options={DOCUMENT_TYPE_OPTIONS} />
                </CocoaField>
                <CocoaField label="Número de documento">
                  <CocoaInput value={form.documentNumber} onChange={set("documentNumber")} placeholder="12345678Z" autoComplete="off" />
                </CocoaField>
                <CocoaField label="Número de soporte">
                  <CocoaInput value={form.documentSupportNumber} onChange={set("documentSupportNumber")} placeholder="ABC123456" autoComplete="off" />
                </CocoaField>
                <CocoaField label="Fecha de nacimiento">
                  <CocoaDatePicker value={form.dateOfBirth} onChange={set("dateOfBirth")} />
                </CocoaField>
                <CocoaField label="Nacionalidad" help="Código ISO de tres letras.">
                  <CocoaInput value={form.nationality} onChange={set("nationality")} placeholder="ESP" maxLength={3} />
                </CocoaField>
                <CocoaField label="Sexo">
                  <CocoaSelect value={form.sex} onChange={set("sex")} options={SEX_OPTIONS} />
                </CocoaField>
                <CocoaField label="País de expedición">
                  <CocoaInput value={form.documentIssueCountry} onChange={set("documentIssueCountry")} placeholder="ESP" maxLength={3} />
                </CocoaField>
                <CocoaField label="Caducidad del documento">
                  <CocoaDatePicker value={form.documentExpiryDate} onChange={set("documentExpiryDate")} />
                </CocoaField>
                <CocoaField label="Dirección de residencia">
                  <CocoaInput value={form.residenceAddress} onChange={set("residenceAddress")} placeholder="Calle, número, piso" autoComplete="off" />
                </CocoaField>
                <CocoaField label="Localidad">
                  <CocoaInput value={form.residenceLocality} onChange={set("residenceLocality")} placeholder="Madrid" autoComplete="off" />
                </CocoaField>
                <CocoaField label="Provincia">
                  <CocoaInput value={form.residenceProvince} onChange={set("residenceProvince")} placeholder="Madrid" autoComplete="off" />
                </CocoaField>
                <CocoaField label="Código postal">
                  <CocoaInput value={form.residencePostalCode} onChange={set("residencePostalCode")} placeholder="28001" autoComplete="off" />
                </CocoaField>
                <CocoaField label="País de residencia">
                  <CocoaInput value={form.residenceCountry} onChange={set("residenceCountry")} placeholder="España" autoComplete="off" />
                </CocoaField>
              </CocoaFormRow>
            </CocoaFormSection>

            <CocoaFormSection title="Datos comerciales del titular">
              <CocoaFormRow columns={3} min={220}>
                <CocoaField label="Empresa del huésped">
                  <CocoaInput value={form.guestCompany} onChange={set("guestCompany")} autoComplete="off" />
                </CocoaField>
                <CocoaField label="Código VIP">
                  <CocoaInput value={form.vipCode} onChange={set("vipCode")} placeholder="VIP1 / VVIP…" />
                </CocoaField>
                <CocoaField label="Programa de fidelización">
                  <CocoaInput value={form.loyaltyProgram} onChange={set("loyaltyProgram")} />
                </CocoaField>
                <CocoaField label="Número de socio">
                  <CocoaInput value={form.loyaltyNumber} onChange={set("loyaltyNumber")} />
                </CocoaField>
                <CocoaField label="Nivel del programa">
                  <CocoaInput value={form.loyaltyTier} onChange={set("loyaltyTier")} placeholder="Silver / Gold…" />
                </CocoaField>
              </CocoaFormRow>
            </CocoaFormSection>

            <CocoaFormSection
              title="Acompañantes"
              description={`${plural(companions.length, "acompañante", "acompañantes")} · adultos ${form.adults} · niños ${form.children} · bebés ${form.infants}`}
              actions={
                <>
                  <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => addCompanion("adult")}>
                    {ACTIONS.add} adulto
                  </CocoaButton>
                  <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => addCompanion("child")}>
                    {ACTIONS.add} niño
                  </CocoaButton>
                  <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => addCompanion("infant")}>
                    {ACTIONS.add} bebé
                  </CocoaButton>
                </>
              }
            >
              <CocoaFormRow columns={3} min={220}>
                <CocoaField label="Edades de los niños" help="Separadas por comas. Las piden algunos canales y tarifas familiares.">
                  <CocoaInput value={form.childrenAges} onChange={set("childrenAges")} placeholder="p. ej. 5, 8" />
                </CocoaField>
              </CocoaFormRow>
              {companions.map((c, index) => (
                <CocoaSection
                  key={c.id}
                  title={`Acompañante ${index + 1}: ${c.firstName || "sin nombre"} ${c.surname1}`.trim()}
                  meta={<CocoaBadge tone="neutral">{COMPANION_TYPE_LABEL[c.type]}</CocoaBadge>}
                  action={
                    <CocoaButton variant="plain" tone="destructive" size="small" onClick={() => removeCompanion(c.id)}>
                      {ACTIONS.remove}
                    </CocoaButton>
                  }
                >
                  <CocoaFormRow columns={3} min={200}>
                    <CocoaField label="Nombre">
                      <CocoaInput value={c.firstName} onChange={(v) => updateCompanion(c.id, "firstName", v)} autoComplete="off" />
                    </CocoaField>
                    <CocoaField label="Apellido">
                      <CocoaInput value={c.surname1} onChange={(v) => updateCompanion(c.id, "surname1", v)} autoComplete="off" />
                    </CocoaField>
                    <CocoaField label="Fecha de nacimiento">
                      <CocoaDatePicker value={c.dateOfBirth} onChange={(v) => updateCompanion(c.id, "dateOfBirth", v)} />
                    </CocoaField>
                    <CocoaField label="Tipo de documento">
                      <CocoaSelect value={c.documentType} onChange={(v) => updateCompanion(c.id, "documentType", v)} options={DOCUMENT_TYPE_OPTIONS} />
                    </CocoaField>
                    <CocoaField label="Número de documento" help="Solo necesario a partir de 14 años.">
                      <CocoaInput value={c.documentNumber} onChange={(v) => updateCompanion(c.id, "documentNumber", v)} autoComplete="off" />
                    </CocoaField>
                    <CocoaField label="Nacionalidad">
                      <CocoaInput value={c.nationality} onChange={(v) => updateCompanion(c.id, "nationality", v)} placeholder="ESP" maxLength={3} />
                    </CocoaField>
                  </CocoaFormRow>
                </CocoaSection>
              ))}
            </CocoaFormSection>
          </div>
        );

      case "tarifa":
        return (
          <CocoaFormSection title="Tarifa" description={`Plan tarifario, régimen, total y desglose de IVA · ${money(taxesPreview.total)} · ${plural(nightsCount, "noche", "noches")}`}>
            <CocoaFormRow columns={3} min={220}>
              <CocoaField label={FIELD_LABELS.ratePlan}>
                <CocoaSelect value={form.ratePlanId} onChange={set("ratePlanId")} options={RATE_PLAN_OPTIONS} />
              </CocoaField>
              <CocoaField label="Régimen">
                <CocoaSelect value={form.boardType} onChange={set("boardType")} options={BOARD_OPTIONS} />
              </CocoaField>
              <CocoaField label="Precio total (€)" help="IVA incluido.">
                <CocoaInput value={form.totalAmount} onChange={set("totalAmount")} type="number" inputMode="decimal" min={0} step="0.01" />
              </CocoaField>
            </CocoaFormRow>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "var(--cocoa-space-3)" }}>
              <CocoaStat label="Base imponible" value={money(taxesPreview.base)} />
              <CocoaStat label="IVA (10 %)" value={money(taxesPreview.tax)} />
              <CocoaStat label={FIELD_LABELS.total} value={money(taxesPreview.total)} tone="accent" />
              <CocoaStat label="Precio por noche" value={money(nightsCount > 0 ? taxesPreview.total / nightsCount : 0)} />
            </div>
          </CocoaFormSection>
        );

      case "origen":
        return (
          <CocoaFormSection title="Origen" description="Canal, fuente, segmento de mercado y referencias comerciales.">
            <CocoaFormRow columns={3} min={220}>
              <CocoaField label="Origen de la reserva" help="Cómo entró la reserva (directo, OTA, walk-in, teléfono…).">
                <CocoaSelect value={form.bookingSource} onChange={set("bookingSource")} options={BOOKING_SOURCE_OPTIONS} />
              </CocoaField>
              <CocoaField label="Segmento de mercado">
                <CocoaSelect value={form.marketSegment} onChange={set("marketSegment")} options={marketOptions.length ? marketOptions : MARKET_SEGMENT_OPTIONS} />
              </CocoaField>
              <CocoaField label={FIELD_LABELS.channel} help="Canal técnico de distribución.">
                <CocoaSelect value={form.channel} onChange={set("channel")} options={CHANNEL_OPTIONS} />
              </CocoaField>
              <CocoaField label="Código de origen">
                <CocoaSelect
                  value={form.sourceCode}
                  onChange={set("sourceCode")}
                  options={
                    sourceOptions.length
                      ? sourceOptions
                      : [
                          { value: "direct_web", label: "Web directa" },
                          { value: "phone", label: "Teléfono" }
                        ]
                  }
                />
              </CocoaField>
              <CocoaField label="Motivo de la estancia">
                <CocoaSelect value={form.purposeOfStay} onChange={set("purposeOfStay")} options={PURPOSE_OPTIONS} />
              </CocoaField>
              <CocoaField label="Localizador externo (OTA)">
                <CocoaInput value={form.externalReference} onChange={set("externalReference")} placeholder="Confirmación del canal" autoComplete="off" />
              </CocoaField>
              <CocoaField label="Empresa (facturación)">
                <CocoaInput value={form.companyName} onChange={set("companyName")} placeholder="Razón social" autoComplete="off" />
              </CocoaField>
              <CocoaField label="Agencia de viajes">
                <CocoaInput value={form.travelAgentName} onChange={set("travelAgentName")} placeholder="Agencia o turoperador" autoComplete="off" />
              </CocoaField>
              <CocoaField label="Código de grupo o bloqueo">
                <CocoaInput value={form.groupCode} onChange={set("groupCode")} placeholder="GRP-2026-…" autoComplete="off" />
              </CocoaField>
              <CocoaField label="Nombre de quien reserva" help="Si no coincide con el huésped.">
                <CocoaInput value={form.bookerName} onChange={set("bookerName")} autoComplete="off" />
              </CocoaField>
              <CocoaField label="Correo de quien reserva">
                <CocoaInput value={form.bookerEmail} onChange={set("bookerEmail")} type="email" autoComplete="off" />
              </CocoaField>
            </CocoaFormRow>
          </CocoaFormSection>
        );

      case "pagos":
        return (
          <CocoaFormSection
            title="Pagos"
            description={`Método de pago, garantía, depósito y políticas comerciales · cobrado ${money(form.depositPaid || 0)} de ${money(form.depositAmount || 0)}`}
          >
            <CocoaFormRow columns={3} min={220}>
              <CocoaField label="Método de pago" help="Tipo de cobro acordado con el huésped.">
                <CocoaSelect value={form.paymentMethod} onChange={set("paymentMethod")} options={PAYMENT_METHOD_OPTIONS} />
              </CocoaField>
              <CocoaField label="Depósito requerido (€)" help="Importe total a cobrar como anticipo.">
                <CocoaInput value={form.depositAmount} onChange={set("depositAmount")} type="number" inputMode="decimal" min={0} step="0.01" placeholder="0,00" />
              </CocoaField>
              <CocoaField label="Depósito ya cobrado (€)" help="Cantidad ya pagada por el huésped.">
                <CocoaInput value={form.depositPaid} onChange={set("depositPaid")} type="number" inputMode="decimal" min={0} step="0.01" placeholder="0,00" />
              </CocoaField>
              <CocoaField label="Vencimiento del depósito" help="Fecha límite para cobrar el anticipo.">
                <CocoaDatePicker value={form.depositDueDate} onChange={set("depositDueDate")} />
              </CocoaField>
              <CocoaField label="Garantía">
                <CocoaSelect
                  value={form.guaranteeType}
                  onChange={set("guaranteeType")}
                  options={guaranteeOptions.length ? guaranteeOptions : [{ value: "card_guarantee", label: "Garantía con tarjeta" }]}
                />
              </CocoaField>
              <CocoaField label="Política de cancelación">
                <CocoaSelect
                  value={form.cancellationPolicyCode}
                  onChange={set("cancellationPolicyCode")}
                  options={cancellationOptions.length ? cancellationOptions : [{ value: "flexible_18", label: "Flexible hasta las 18:00 del día anterior" }]}
                />
              </CocoaField>
              <CocoaField label="Instrucción de cobro">
                <CocoaSelect
                  value={form.billingInstruction}
                  onChange={set("billingInstruction")}
                  options={
                    billingOptions.length
                      ? billingOptions
                      : [
                          { value: "guest_pays_checkout", label: "El huésped paga al check-out" },
                          { value: "company_invoice", label: "Factura a empresa" }
                        ]
                  }
                />
              </CocoaField>
            </CocoaFormRow>
          </CocoaFormSection>
        );

      case "solicitudes":
      default:
        return (
          <CocoaFormSection title="Solicitudes" description={`Peticiones especiales, accesibilidad, dieta, hora de llegada y notas internas · ${form.vipFlag === "yes" ? "VIP" : "Estándar"}`}>
            <CocoaFormRow columns={3} min={220}>
              <CocoaField label="Hora estimada de llegada" help="Para preparar la bienvenida y la operativa de recepción.">
                <CocoaInput value={form.estimatedArrivalTime} onChange={set("estimatedArrivalTime")} type="time" />
              </CocoaField>
              <CocoaField label="Preferencias" help="Separadas por comas (planta, tipo de cama, almohada, vista…).">
                <CocoaInput value={form.preferences} onChange={set("preferences")} placeholder="planta alta, cama grande, no fumador" />
              </CocoaField>
              <CocoaField label="Marcar como VIP" inline>
                <CocoaSwitch checked={form.vipFlag === "yes"} onChange={(v) => updateField(setForm, "vipFlag", v ? "yes" : "")} size="small" />
              </CocoaField>
              <CocoaField label="Contacto de emergencia">
                <CocoaInput value={form.emergencyContactName} onChange={set("emergencyContactName")} placeholder="Nombre" autoComplete="off" />
              </CocoaField>
              <CocoaField label="Teléfono de emergencia">
                <CocoaInput value={form.emergencyContactPhone} onChange={set("emergencyContactPhone")} type="tel" autoComplete="off" />
              </CocoaField>
              <CocoaField label="Necesidades de accesibilidad" help="Separadas por comas. Visible para pisos y recepción." fullWidth>
                <CocoaInput value={form.accessibilityNeeds} onChange={set("accessibilityNeeds")} placeholder="silla de ruedas, ducha adaptada, planta baja…" />
              </CocoaField>
              <CocoaField label="Requisitos dietéticos" help="Separados por comas. Importante para restauración." fullWidth>
                <CocoaInput value={form.dietaryRequirements} onChange={set("dietaryRequirements")} placeholder="vegano, sin gluten, alergia a frutos secos…" />
              </CocoaField>
              <CocoaField label="Peticiones especiales" help="Visibles para el huésped." fullWidth>
                <CocoaInput value={form.specialRequests} onChange={set("specialRequests")} multiline rows={3} placeholder="Cuna, llegada tardía, salida tardía…" />
              </CocoaField>
              <CocoaField label="Notas internas" help="Solo para el equipo." fullWidth>
                <CocoaInput value={form.internalNotes} onChange={set("internalNotes")} multiline rows={3} placeholder="Información operativa que el huésped no debe ver." />
              </CocoaField>
              <CocoaField label="Consentimiento de marketing (RGPD)" help="El huésped acepta recibir comunicaciones comerciales." inline fullWidth>
                <CocoaSwitch checked={form.marketingConsent === "yes"} onChange={(v) => updateField(setForm, "marketingConsent", v ? "yes" : "")} size="small" />
              </CocoaField>
              <CocoaField label="Notas adicionales" fullWidth>
                <CocoaInput value={form.notes} onChange={set("notes")} multiline rows={3} placeholder="Otras anotaciones generales." />
              </CocoaField>
            </CocoaFormRow>
          </CocoaFormSection>
        );
    }
  }

  return (
    <CocoaPage
      eyebrow="Recepción · Nueva reserva"
      title="Nueva reserva"
      subtitle={hosted ? undefined : "Recoge la estancia, los huéspedes, la tarifa, el origen, los pagos y las solicitudes antes de confirmar."}
      state={createdReservation ? "empty" : "ready"}
      empty={{
        title: `Reserva ${createdReservation?.code ?? ""} creada`,
        message: "Reserva guardada, huésped principal vinculado y folio abierto.",
        illustration: "success",
        primaryAction: { label: "Abrir el detalle de la reserva", onClick: openCreated },
        secondaryAction: { label: "Abrir facturación", onClick: () => navigateTo("BillingCenter") }
      }}
      commands={[
        { id: "nueva-reserva-disponibilidad", label: "Consultar disponibilidad de la nueva reserva", run: () => void handleQuote() },
        { id: "nueva-reserva-crear", label: "Confirmar y crear la reserva", run: () => void handleCreate() }
      ]}
    >
      <CocoaGrid align="start" aria-label="Asistente de nueva reserva">
        <CocoaSpan cols={4} min={240}>
          <CocoaSection title="Pasos" meta={`${step + 1} / ${STEPS.length}`}>
            <CocoaChart.Progress value={((step + 1) / STEPS.length) * 100} label={current.label} showValue={false} aria-label={stepSummary} />
            {/* aria-current marks the current step once, on the button (fix:3-A qa#12). */}
            <ol className="c22-section__list" aria-label="Pasos del asistente">
              {STEPS.map((s, index) => (
                <li key={s.key}>
                  <CocoaButton
                    variant="plain"
                    tone={index === step ? "accent" : "neutral"}
                    size="small"
                    wrap
                    aria-current={index === step ? "step" : undefined}
                    onClick={() => setStep(index)}
                    style={{ flex: "1 1 auto", justifyContent: "flex-start" }}
                  >
                    {index + 1}. {s.label}
                  </CocoaButton>
                  <CocoaBadge tone={stepTone(index)} variant="dot" size="small">
                    {index < step ? "revisado" : index === step ? "actual" : "pendiente"}
                  </CocoaBadge>
                </li>
              ))}
            </ol>
            <p>{current.description}</p>
          </CocoaSection>
        </CocoaSpan>
        <CocoaSpan cols={8} min={480}>
          <div className="cocoa-stack" data-gap="4">
            {status ? (
              <CocoaCallout tone="neutral" role="status">
                {status}
              </CocoaCallout>
            ) : null}
            {renderStep()}
          </div>
        </CocoaSpan>
      </CocoaGrid>

      <CocoaActionBar
        aria-label="Navegación del asistente"
        status={stepSummary}
        extra={
          <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => navigateTo("ReservationWorkspace")}>
            Abrir espacio de reservas
          </CocoaButton>
        }
        secondary={step > 0 ? { label: ACTIONS.previous, onClick: () => setStep((s) => Math.max(0, s - 1)) } : undefined}
        primary={
          last
            ? { label: creating ? "Creando…" : "Confirmar y crear reserva", loading: creating, disabled: creating, onClick: () => void handleCreate() }
            : { label: ACTIONS.next, onClick: () => setStep((s) => Math.min(STEPS.length - 1, s + 1)) }
        }
        publishToastOffset
      />
    </CocoaPage>
  );
}
