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
//
// Tanda L3 · lote A («precio de reserva desde tarifa al crear»): the rate plans
// come from GET /properties/:id/rate-plans (real ids; the fixed rp_* list
// answered 400), the cancellation policy from GET /cancellation-policies
// (default preselected), the availability quote carries the selected type /
// plan and says where its price comes from (`fallback` = filler, warned, never
// copied into the total), and `totalAmount` travels ONLY when the user typed
// it: an empty field lets the API price the stay from the rate grid
// (`pricing.source` on the response). `baseAmount` / `taxAmount` are no longer
// sent (the API ignored them).
//
// Tanda UX-1 · lote U9a (docs/design/UX-RECEPCION-FEEL.md §5.10, F12, F33,
// 3.3.7): dos modos en la misma URL (`?modo=rapida|completa`, rápida por
// defecto, conmutador en la cabecera). El modo rápido (ReservationQuickCreate)
// es una sola pantalla con los tres obligatorios, precio en vivo y los CTA
// «Crear y…»; el completo conserva los seis pasos. Los dos comparten el
// formulario, el prefijado (Live Timeline `?arrivalDate&departureDate&
// roomTypeId&assignedRoomId` y huésped `?guestId=` de la lista y la ficha de
// huéspedes, 3.3.7) y el cuerpo del POST (`buildCreateReservationPayload`). El
// catálogo (tipos y habitaciones) viene de la caché compartida (`useApiData`,
// 5 min) y mientras no está la página pinta un esqueleto espejo: «Sin tipos de
// habitación» solo se dice cuando la carga ha terminado sin tipos (F33).

import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { RateGridRatePlan } from "@hotelos/shared";
import { getActivePropertyId } from "../../services/activeProperty";
import { fetchRatePlans } from "../../services/rateGridApi";
import { fetchCancellationPolicies, type CancellationPolicy } from "../../services/cancellationApi";
import { urlForScreen } from "../../navigation/nav-tree";
import { fetchConfigurationCategories, type ConfigurationCategoryGroup } from "../../services/backofficeApi";
import {
  createReservation,
  quoteAvailability,
  scanIdDocument,
  type AdminReservation,
  type AdminRoom,
  type AdminRoomType,
  type AvailabilityQuote,
  type ReservationPriceSource
} from "../../services/pmsCommerceApi";
import { fetchGuest } from "../../services/guestsApi";
import { useApiData } from "../../hooks/useApiData";
import { toArray } from "../../utils/toArray";
import { useToast } from "../../components/Toast";
import { rememberTaxId } from "../../components/billing/InvoiceFromReservationDialog";
import { CocoaScreenInstructionsCard } from "../../components/cocoa-guidance/CocoaScreenInstructionsCard";
import { PREFILL_NOTE, hasReservationPrefill, parseReservationPrefill } from "./reservation-create-prefill";
import {
  ReservationQuickCreate,
  ReservationQuickCreateSkeleton,
  ReservationWizardSkeleton,
  buildCreateReservationPayload,
  defaultReservationForm,
  guestDisplayName,
  guestIdFromSearch,
  guestPrefillValues,
  reservationModeFromSearch,
  searchWithReservationMode,
  type ReservationCreateMode,
  type ReservationFormValues
} from "./ReservationQuickCreate";
import { logBreadcrumb } from "../../lib/breadcrumb";
import { useTabHost } from "../tabs/TabHost";
import { navigateTo } from "../../lib/navigate";
import { money, plural } from "../../lib/format";
import { ACTIONS, FIELD_LABELS, RESERVATION_CREATE_ACTIONS, RESERVATION_CREATE_TOASTS } from "../../content/actions";
import { RESERVATION_CREATE_INSTRUCTIONS } from "../../content/screen-instructions/reservations";
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
  CocoaState,
  CocoaStepper,
  CocoaSwitch,
  openTabPath,
  type CocoaTone
} from "../../components/cocoa";

const PROPERTY_ID = getActivePropertyId();

/** Caché del catálogo (tipos y habitaciones) compartida con Mi día y el walk-in. */
const CATALOG_STALE_MS = 5 * 60_000;

/** Formulario compartido por los dos modos (ReservationQuickCreate): los 70 campos del asistente más el huésped enlazado y el NIF de la empresa. */
const defaultForm = defaultReservationForm;

type FormValues = ReservationFormValues;

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

const NO_RATE_PLAN_OPTION = { value: "", label: "Sin plan tarifario (tarifa BAR del hotel)" };

/** Selector options of the property's ACTIVE rate plans (ids of the API, never invented). Pure. */
function ratePlanOptions(plans: RateGridRatePlan[]) {
  return [NO_RATE_PLAN_OPTION, ...plans.filter((plan) => plan.active).map((plan) => ({ value: plan.id, label: `${plan.code} · ${plan.name}` }))];
}

const NO_POLICY_OPTION = { value: "", label: "Sin política (se aplica la del hotel)" };

/** Selector options of the property's ACTIVE cancellation policies (code = what the API stamps). Pure. */
function policyOptions(policies: CancellationPolicy[]) {
  return [NO_POLICY_OPTION, ...policies.filter((policy) => policy.active).map((policy) => ({ value: policy.code, label: `${policy.name} (${policy.code})` }))];
}

/**
 * Code of the property's default policy (`isDefault`, one per hotel at most)
 * or "" (= «Sin política»). Corrector L3 (FUX-01): NO alphabetical fallback —
 * the API resolves a reservation without code through the rate plan's policy
 * and then the hotel's default, and a hotel without default charges nothing;
 * preselecting the first active policy stamped a code the hotel never chose
 * (FLEX before NREF on a BAR-NR plan). Pure.
 */
function defaultPolicyCode(policies: CancellationPolicy[]): string {
  return policies.find((policy) => policy.active && policy.isDefault === true)?.code ?? "";
}

/** Help of the «Política de cancelación» select: what happens with the selection left empty. Pure. */
function policyHelp(policies: CancellationPolicy[]): string {
  if (policies.length === 0) return "Sin políticas de cancelación configuradas en el hotel: la reserva se crea sin política.";
  if (policies.some((policy) => policy.active && policy.isDefault)) return "Preseleccionada la política por defecto del hotel; «Sin política» deja que decida el plan tarifario o, si no tiene, la del hotel.";
  return "El hotel no tiene política por defecto: con «Sin política» se aplica la del plan tarifario o, si no la tiene, ninguna (cancelación sin cargo).";
}

/** Human label of the price origin the API answers on creation (`pricing.source`). Pure. */
function priceSourceLabel(source: ReservationPriceSource): string {
  switch (source) {
    case "rate_plan":
      return "precio de la tarifa publicada";
    case "manual":
      return "precio manual";
    case "partial":
      return "sin tarifa publicada para todas las noches (queda a 0 €)";
    case "none":
      return "sin tarifa publicada (queda a 0 €)";
    default:
      return "precio del origen de la reserva";
  }
}

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

/** Conmutador de la cabecera (U9a): la misma URL con `?modo=` (rápida = sin parámetro). */
const MODE_TABS: Array<{ value: ReservationCreateMode; label: string }> = [
  { value: "rapida", label: RESERVATION_CREATE_ACTIONS.quickMode },
  { value: "completa", label: RESERVATION_CREATE_ACTIONS.fullMode }
];

function localStorageOrNull(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

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
  // Tanda TL: el Live Timeline llega con ?arrivalDate&departureDate&roomTypeId&
  // assignedRoomId al crear por celdas (window.location.search: sin react-router,
  // como ReservationImportScreen). Se lee UNA vez al montar; lo inválido se ignora.
  const [prefill] = useState(() => parseReservationPrefill(typeof window === "undefined" ? "" : window.location.search));
  const prefilled = hasReservationPrefill(prefill);
  const [form, setForm] = useState<FormValues>(() => ({ ...defaultForm, ...prefill }));
  // U9a: modo (`?modo=`, rápida por defecto) y huésped prefijado (`?guestId=`, lista y ficha de huéspedes), leídos UNA vez al montar.
  const [mode, setMode] = useState<ReservationCreateMode>(() => reservationModeFromSearch(typeof window === "undefined" ? "" : window.location.search));
  const [prefillGuestId] = useState(() => guestIdFromSearch(typeof window === "undefined" ? "" : window.location.search));
  const [prefilledGuestName, setPrefilledGuestName] = useState<string | null>(null);
  const [companions, setCompanions] = useState<CompanionGuest[]>([]);
  // U9a: catálogo desde la caché compartida (sin petición si es fresco); la página pinta el esqueleto mientras no hay datos (F33).
  const roomTypesState = useApiData<AdminRoomType[]>(`/properties/${PROPERTY_ID}/room-types`, { staleTime: CATALOG_STALE_MS });
  const roomsState = useApiData<AdminRoom[]>(`/properties/${PROPERTY_ID}/rooms`, { staleTime: CATALOG_STALE_MS });
  const roomTypes = useMemo(() => toArray<AdminRoomType>(roomTypesState.data), [roomTypesState.data]);
  const rooms = useMemo(() => toArray<AdminRoom>(roomsState.data), [roomsState.data]);
  const catalogLoading = roomTypesState.loading && roomTypesState.data === null;
  const roomTypesLoaded = !roomTypesState.loading && roomTypesState.data !== null;
  const [categoryGroups, setCategoryGroups] = useState<ConfigurationCategoryGroup[]>([]);
  const [quotes, setQuotes] = useState<AvailabilityQuote[]>([]);
  const [quoted, setQuoted] = useState(false);
  const [ratePlans, setRatePlans] = useState<RateGridRatePlan[]>([]);
  const [policies, setPolicies] = useState<CancellationPolicy[]>([]);
  const [createdReservation, setCreatedReservation] = useState<AdminReservation | null>(null);
  const [status, setStatus] = useState("");
  const [step, setStep] = useState(0);
  const [quoting, setQuoting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [attempted, setAttempted] = useState(false);

  useEffect(() => {
    // Auditoría 2026-07: cargas INDEPENDIENTES (tipos y habitaciones ya vienen de
    // useApiData). Antes un Promise.all descartaba los tipos reales si fallaba la
    // llamada de categorías.
    void fetchConfigurationCategories(PROPERTY_ID)
      .then((categoryResponse) => setCategoryGroups(categoryResponse.groups))
      .catch(() => undefined); // opcional: los selects usan sus valores locales
    // Tanda L3 (lote A): real rate plans and cancellation policies of the hotel.
    void fetchRatePlans(PROPERTY_ID).then(setRatePlans).catch(() => setRatePlans([]));
    void fetchCancellationPolicies(PROPERTY_ID)
      .then((items) => {
        setPolicies(items);
        setForm((current) => (current.cancellationPolicyCode ? current : { ...current, cancellationPolicyCode: defaultPolicyCode(items) }));
      })
      .catch(() => setPolicies([]));
  }, []);

  useEffect(() => {
    if (roomTypesState.error) setStatus("No se pudieron cargar los tipos de habitación. Reintenta.");
  }, [roomTypesState.error]);

  // 3.3.7 (U9a): huésped prefijado por `?guestId=` → su ficha rellena el formulario y viaja como `primaryGuestId`.
  useEffect(() => {
    if (!prefillGuestId) return undefined;
    let cancelled = false;
    fetchGuest(prefillGuestId)
      .then((detail) => {
        if (cancelled) return;
        const name = guestDisplayName(detail.guest);
        setForm((current) => ({ ...current, ...guestPrefillValues(detail.guest) }));
        setPrefilledGuestName(name);
        setStatus(RESERVATION_CREATE_TOASTS.guestPrefilled(name));
      })
      .catch(() => {
        if (!cancelled) setStatus("No se pudo cargar la ficha del huésped: rellena sus datos a mano.");
      });
    return () => {
      cancelled = true;
    };
  }, [prefillGuestId]);

  /** Conmutador Rápida / Completa: misma URL, `?modo=` sin recargar ni cambiar de pestaña. */
  function switchMode(next: ReservationCreateMode) {
    setMode(next);
    if (typeof window === "undefined") return;
    const search = searchWithReservationMode(window.location.search, next);
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${search}${window.location.hash}`);
    logBreadcrumb("reservation.create.mode", "ui", { mode: next });
  }

  const sourceOptions = useMemo(() => categoryOptions(categoryGroups, "reservation_source_codes"), [categoryGroups]);
  const marketOptions = useMemo(() => categoryOptions(categoryGroups, "market_segments"), [categoryGroups]);
  const guaranteeOptions = useMemo(() => categoryOptions(categoryGroups, "guarantee_policies"), [categoryGroups]);
  const billingOptions = useMemo(() => categoryOptions(categoryGroups, "billing_instruction_types"), [categoryGroups]);
  const ratePlanOptionList = useMemo(() => ratePlanOptions(ratePlans), [ratePlans]);
  const policyOptionList = useMemo(() => policyOptions(policies), [policies]);

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

  // Tanda L3 (lote A): the quote of the selected type (one room, whole stay);
  // a `fallback` quote is a filler and never becomes the total. The manual
  // field wins when the user typed it; otherwise the API prices the stay.
  const selectedQuote = useMemo(() => quotes.find((quote) => quote.roomTypeId === form.roomTypeId) ?? null, [quotes, form.roomTypeId]);
  const roomsCountNumber = Number(form.roomsCount) || 1;
  const quotedTotal = useMemo(
    () => (selectedQuote && selectedQuote.priceSource !== "fallback" ? Math.round(selectedQuote.totalAmount * roomsCountNumber * 100) / 100 : null),
    [selectedQuote, roomsCountNumber]
  );
  const manualTotal = form.totalAmount.trim() === "" ? null : Number(form.totalAmount);
  const displayTotal = manualTotal ?? quotedTotal ?? 0;

  // Live taxes preview (IVA reducido 10 % for hospedaje en España) — display only, nothing of it is sent.
  const taxesPreview = useMemo(() => {
    const total = Number.isFinite(displayTotal) ? displayTotal : 0;
    const base = Math.round((total / 1.1) * 100) / 100;
    const tax = Math.round((total - base) * 100) / 100;
    return { base, tax, total };
  }, [displayTotal]);

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
        children: Number(form.children),
        // Tanda L3 (lote A): quote the selected type from the selected plan's grid.
        ...(form.roomTypeId ? { roomTypeId: form.roomTypeId } : {}),
        ...(form.ratePlanId ? { ratePlanId: form.ratePlanId } : {})
      });
      setQuotes(response);
      setQuoted(true);
      const firstAvailable = response.find((quote) => quote.availableRooms > 0);
      // The total is NOT copied into the form: an empty total lets the API price
      // the stay from the rate grid (a `fallback` figure is never a tariff).
      if (firstAvailable && !form.roomTypeId) {
        setForm((current) => ({ ...current, roomTypeId: firstAvailable.roomTypeId }));
      }
      const withFallback = response.filter((quote) => quote.availableRooms > 0 && quote.priceSource === "fallback");
      if (!firstAvailable) {
        setStatus("Sin disponibilidad para esas fechas y ocupación. Cambia las fechas, la ocupación o el tipo de habitación.");
      } else if (withFallback.length > 0) {
        const sample = withFallback[0];
        setStatus(
          `Disponibilidad consultada. Aviso: ${plural(sample.nightsWithoutRate ?? 0, "noche", "noches")} sin tarifa publicada en ${withFallback.map((quote) => quote.roomTypeName).join(", ")} — el importe mostrado usa un precio de relleno de ${money(sample.fallbackNightly ?? 0)}/noche, no es tarifa publicada.`
        );
      } else {
        setStatus("Disponibilidad consultada con la tarifa publicada. Deja el precio total vacío para que la reserva tome el precio de la parrilla, o escribe un importe manual.");
      }
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

  /**
   * Valida los tres obligatorios y crea la reserva con el cuerpo compartido
   * (`buildCreateReservationPayload`). Devuelve la reserva o null si falta
   * algo (mensaje, foco en el campo y, en el modo completo, salto al paso). Lo
   * usan los dos modos: el rápido encadena después el cobro o el check-in.
   */
  async function createFromForm(): Promise<AdminReservation | null> {
    // Required-field guard. Defaults are blank on purpose (no demo guest
    // pre-filled): block without a room type (500 on the FK) or a guest name.
    setAttempted(true);
    if (!form.roomTypeId) {
      const message = "Selecciona un tipo de habitación antes de crear la reserva.";
      setStatus(message);
      showToast(message, { variant: "error" });
      setStep(0);
      focusField("rc-field-roomtype");
      return null;
    }
    if (!form.firstName.trim() || !form.surname1.trim()) {
      const message = "Indica al menos el nombre y el primer apellido del huésped.";
      setStatus(message);
      showToast(message, { variant: "error" });
      setStep(1);
      focusField(!form.firstName.trim() ? "rc-field-firstname" : "rc-field-surname1");
      return null;
    }
    setCreating(true);
    setStatus("Creando reserva y abriendo folio…");
    // PII-safe: no name, email or document; only operational data.
    logBreadcrumb("reservation.create.attempt", "mutation", {
      mode,
      channel: form.channel,
      bookingSource: form.bookingSource,
      roomTypeId: form.roomTypeId,
      arrivalDate: form.arrivalDate,
      departureDate: form.departureDate,
      totalAmount: manualTotal,
      ratePlanId: form.ratePlanId || null,
      paymentMethod: form.paymentMethod,
      companionCount: companions.length,
      guestLinked: Boolean(form.primaryGuestId)
    });
    try {
      const reservation = await createReservation(PROPERTY_ID, buildCreateReservationPayload(form, { nightsCount, manualTotal, companions }));
      // 3.3.7: el NIF de la empresa se recuerda para la factura a la empresa desde la ficha.
      if (form.companyName.trim() && form.companyTaxId.trim()) rememberTaxId(localStorageOrNull(), form.companyName, form.companyTaxId);
      const pricing = reservation.pricing;
      const priceNote = pricing
        ? `${priceSourceLabel(pricing.source)}: ${money(reservation.totalAmount, reservation.currency)}.${pricing.warning ? ` ${pricing.warning}` : ""}`
        : `importe ${money(reservation.totalAmount, reservation.currency)}.`;
      setStatus(`Reserva ${reservation.code} creada (${priceNote}) Se abrió un folio y se registró el evento de auditoría.`);
      showToast(RESERVATION_CREATE_TOASTS.created(reservation.code, money(reservation.totalAmount, reservation.currency)), { variant: pricing?.warning ? "info" : "success" });
      return reservation;
    } catch (error) {
      const message = error instanceof Error ? error.message : "No se pudo crear la reserva.";
      setStatus(message);
      showToast(message, { variant: "error" });
      return null;
    } finally {
      setCreating(false);
    }
  }

  /** Modo completo: crear y pintar el estado de éxito con «Abrir el detalle de la reserva». */
  async function handleCreate() {
    const reservation = await createFromForm();
    if (reservation) setCreatedReservation(reservation);
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
            {prefilled ? (
              <CocoaCallout tone="info" role="note">
                {PREFILL_NOTE}
              </CocoaCallout>
            ) : null}
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
              <CocoaField label={FIELD_LABELS.roomType} required error={roomTypeError} help={roomTypesLoaded && roomTypes.length === 0 ? "Sin tipos de habitación: configúralos primero." : undefined}>
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

            {quoted && !quotes.some((quote) => quote.availableRooms > 0) ? (
              <CocoaState kind="empty" inline title="Sin disponibilidad" message="No hay habitaciones libres para esas fechas y ocupación. Cambia las fechas, la ocupación o el tipo de habitación." />
            ) : null}
            {quotes.length > 0 ? (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "var(--cocoa-space-3)" }}>
                {quotes.map((quote) => {
                  const selected = form.roomTypeId === quote.roomTypeId;
                  const filler = quote.priceSource === "fallback";
                  return (
                    <CocoaCard key={quote.roomTypeId} variant="bordered" padding="md" role="group" aria-label={quote.roomTypeName}>
                      <div className="cocoa-stack" data-gap="2">
                        <span className="cocoa-row" data-gap="2" data-justify="between">
                          <strong>{quote.roomTypeName}</strong>
                          <CocoaBadge tone={quote.availableRooms > 0 ? "success" : "danger"} size="small">
                            {plural(quote.availableRooms, "disponible", "disponibles")}
                          </CocoaBadge>
                        </span>
                        <CocoaStat
                          label="Estancia por habitación"
                          value={money(quote.totalAmount, quote.currency)}
                          hint={filler ? "Precio de relleno, no es tarifa publicada" : "Tarifa publicada"}
                          tone={filler ? "warning" : "neutral"}
                        />
                        {filler ? (
                          <CocoaCallout tone="warning">
                            {plural(quote.nightsWithoutRate ?? 0, "noche", "noches")} sin tarifa publicada en ningún plan: precio de relleno de {money(quote.fallbackNightly ?? 0, quote.currency)}/noche, no es tarifa publicada. Sin importe manual la reserva se creará a {money(0)} con aviso.
                          </CocoaCallout>
                        ) : quote.ratePlanSwitched ? (
                          <CocoaCallout tone="info">
                            El plan elegido no publica precio para estas noches: la estimación usa la tarifa BAR, la misma que fijará el precio al crear la reserva.
                          </CocoaCallout>
                        ) : null}
                        <div className="cocoa-row" data-gap="2">
                          <CocoaButton
                            variant={selected ? "filled" : "tinted"}
                            tone="accent"
                            size="small"
                            aria-pressed={selected}
                            onClick={() => setForm((c) => ({ ...c, roomTypeId: quote.roomTypeId }))}
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
                <CocoaField label="País de residencia" help="Código ISO de tres letras.">
                  <CocoaInput value={form.residenceCountry} onChange={set("residenceCountry")} placeholder="ESP" maxLength={3} autoComplete="off" />
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
              <CocoaField label={FIELD_LABELS.ratePlan} help={ratePlans.length === 0 ? "Sin planes tarifarios cargados: la reserva se cotiza con la tarifa BAR del hotel." : "Sin plan, la reserva se cotiza con la tarifa BAR del hotel."}>
                <CocoaSelect value={form.ratePlanId} onChange={set("ratePlanId")} options={ratePlanOptionList} />
              </CocoaField>
              <CocoaField label="Régimen">
                <CocoaSelect value={form.boardType} onChange={set("boardType")} options={BOARD_OPTIONS} />
              </CocoaField>
              <CocoaField label="Precio total (€)" hint="opcional" help="IVA incluido. Déjalo vacío para que la reserva tome el precio de la tarifa publicada.">
                <CocoaInput
                  value={form.totalAmount}
                  onChange={set("totalAmount")}
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  placeholder={quotedTotal !== null ? quotedTotal.toFixed(2) : "Según tarifa"}
                />
              </CocoaField>
            </CocoaFormRow>
            {selectedQuote?.priceSource === "fallback" ? (
              <CocoaCallout tone="warning">
                Ningún plan publica precio para {plural(selectedQuote.nightsWithoutRate ?? 0, "noche", "noches")} de {plural(nightsCount, "noche", "noches")} (precio de relleno de {money(selectedQuote.fallbackNightly ?? 0, selectedQuote.currency)}/noche, no es tarifa publicada). Sin importe manual la reserva se creará a {money(0)} con aviso.
              </CocoaCallout>
            ) : manualTotal !== null && quotedTotal !== null && manualTotal < quotedTotal ? (
              <CocoaCallout tone="warning">
                Importe por debajo de la tarifa publicada ({money(quotedTotal)}): se registra como descuento y, según el porcentaje, exige clave de descuento, motivo o autorización.
              </CocoaCallout>
            ) : manualTotal === null && quotedTotal !== null ? (
              <CocoaCallout tone="info">
                Precio estimado desde la tarifa publicada: {money(quotedTotal)} ({plural(nightsCount, "noche", "noches")} × {plural(roomsCountNumber, "habitación", "habitaciones")}). Al crear la reserva el importe se toma de la parrilla con el mismo cotizador.
                {selectedQuote?.ratePlanSwitched ? " El plan elegido no publica precio para estas noches: se usa la tarifa BAR (la respuesta del API lo avisa en pricing.warning)." : ""}
              </CocoaCallout>
            ) : manualTotal === null ? (
              <CocoaCallout tone="neutral">
                Sin importe manual la reserva toma el precio de la tarifa publicada al crearse. Consulta la disponibilidad en el paso Estancia para ver la estimación.
              </CocoaCallout>
            ) : null}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "var(--cocoa-space-3)" }}>
              <CocoaStat label="Base imponible" value={money(taxesPreview.base)} />
              <CocoaStat label="IVA (10 %)" value={money(taxesPreview.tax)} />
              <CocoaStat label={FIELD_LABELS.total} value={money(taxesPreview.total)} tone="accent" hint={manualTotal !== null ? "importe manual" : quotedTotal !== null ? "estimación de tarifa" : "se cotiza al crear"} />
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
              <CocoaField label="NIF de la empresa" help="Se recuerda para la factura a la empresa desde la ficha.">
                <CocoaInput value={form.companyTaxId} onChange={set("companyTaxId")} placeholder="B12345674" autoComplete="off" />
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
              <CocoaField
                label="Política de cancelación"
                help={policyHelp(policies)}
              >
                <CocoaSelect value={form.cancellationPolicyCode} onChange={set("cancellationPolicyCode")} options={policyOptionList} />
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

  const quick = mode === "rapida";
  const instructions = (
    <CocoaScreenInstructionsCard
      title={RESERVATION_CREATE_INSTRUCTIONS.title}
      description={RESERVATION_CREATE_INSTRUCTIONS.description}
      steps={[...RESERVATION_CREATE_INSTRUCTIONS.steps]}
      tip={RESERVATION_CREATE_INSTRUCTIONS.tip}
      dismissible
      persistKey="reservation-create"
    />
  );

  return (
    <CocoaPage
      eyebrow="Recepción · Nueva reserva"
      title="Nueva reserva"
      subtitle={
        hosted
          ? undefined
          : quick
            ? "Lo mínimo para reservar en una pantalla: estancia, tipo con precio y huésped. Intro crea la reserva."
            : "Recoge la estancia, los huéspedes, la tarifa, el origen, los pagos y las solicitudes antes de confirmar."
      }
      tabs={MODE_TABS}
      activeTab={mode}
      onTabChange={(value) => switchMode(value === "completa" ? "completa" : "rapida")}
      state={createdReservation ? "empty" : catalogLoading ? "loading" : "ready"}
      skeleton={quick ? <ReservationQuickCreateSkeleton /> : <ReservationWizardSkeleton />}
      empty={{
        title: `Reserva ${createdReservation?.code ?? ""} creada`,
        message: createdReservation
          ? `Reserva guardada, huésped principal vinculado y folio abierto · ${createdReservation.pricing ? priceSourceLabel(createdReservation.pricing.source) : "importe"}: ${money(createdReservation.totalAmount, createdReservation.currency)}.`
          : "Reserva guardada, huésped principal vinculado y folio abierto.",
        illustration: "success",
        primaryAction: { label: "Abrir el detalle de la reserva", onClick: openCreated },
        secondaryAction: { label: "Abrir facturación", onClick: () => navigateTo("BillingCenter") }
      }}
      commands={
        quick
          ? [{ id: "nueva-reserva-modo-completo", label: "Nueva reserva: pasar al modo completo", run: () => switchMode("completa") }]
          : [
              { id: "nueva-reserva-modo-rapido", label: "Nueva reserva: pasar al modo rápido", run: () => switchMode("rapida") },
              { id: "nueva-reserva-disponibilidad", label: "Consultar disponibilidad de la nueva reserva", run: () => void handleQuote() },
              { id: "nueva-reserva-crear", label: "Confirmar y crear la reserva", run: () => void handleCreate() }
            ]
      }
    >
      {instructions}
      {quick ? (
        <ReservationQuickCreate
          propertyId={PROPERTY_ID}
          form={form}
          setForm={setForm}
          roomTypes={roomTypes}
          rooms={rooms}
          ratePlanOptions={ratePlanOptionList}
          bookingSourceOptions={BOOKING_SOURCE_OPTIONS}
          status={status || null}
          errors={{ roomType: roomTypeError, firstName: firstNameError, surname1: surnameError }}
          prefillNote={prefilled ? PREFILL_NOTE : null}
          prefilledGuestName={prefilledGuestName}
          creating={creating}
          onCreate={createFromForm}
        />
      ) : (
        <>
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
        </>
      )}
    </CocoaPage>
  );
}
