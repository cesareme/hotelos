// «Añadir centro» — the wizard of Configuración › Estructura societaria
// (Tanda 6b · L6; design §5.3): a CocoaDrawer (640) with CocoaChart.Progress +
// the step list (there is no step stepper primitive, §4.2), one section per
// step and Anterior / Siguiente / «Crear centro» in the footer.
//
//   1 Tipo y nombre     Hotel · Oficina · Otro; nombre, nombre comercial, código
//                       autosugerido (editable); a hotel also declares its first
//                       inventory (plantas × habitaciones, un tipo «estándar»)
//                       because POST /legal-entities/:id/properties refuses a hotel
//                       without building / totalRooms / roomTypes (R6).
//   2 Ubicación fiscal  dirección, CP, municipio, INE, provincia, territorio;
//                       hotel: categoría, plazas, registro turístico.
//   3 Facturación       (hotel · otro) the three R3 series — FAC · FS · R — with
//                       their proposed prefix and a LIVE `dryRun` that paints
//                       «Libre» / «Ya usado por <centro>» before creating anything
//                       (409 SERIES_PREFIX_CLASH never reaches the apply). The
//                       office skips the step: it does not bill (R6) and the
//                       sociedad's bank account is the one it uses.
//   4 Resumen           the plan the dry run returned → «Crear centro».
//
// On success a CocoaState success offers «Configurar habitaciones» (hotel) and
// «Abrir Finanzas en este centro» (the new centre becomes the active property).
// Nothing here writes to the API except the final POST without `dryRun`.

import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { PropertyKind } from "@hotelos/shared";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaChart,
  CocoaDialog,
  CocoaDrawer,
  CocoaField,
  CocoaFormRow,
  CocoaInput,
  CocoaSection,
  CocoaSegmentedControl,
  CocoaSelect,
  CocoaState,
  CocoaSwitch,
  openTabPath,
  type CocoaTone
} from "../../components/cocoa";
import { ACTIONS, STATUS_LABELS, confirmDiscard } from "../../content/actions";
import { number, plural } from "../../lib/format";
import { urlForScreen } from "../../navigation/nav-tree";
import { invalidateSwitchableProperties, setActiveProperty } from "../../services/activeProperty";
import { provisionCentre, type CentreSpecBody, type ProvisionCentreResult, type StructureLegalEntity, type StructureProperty } from "../../services/structureApi";
import { FISCAL_TERRITORY_OPTIONS } from "../../services/taxesApi";
import { currentFiscalYear } from "./structure-model";
import {
  PROPERTY_KIND_OPTIONS,
  countBillingCentres,
  normalizeStructureCode,
  proposeSeries,
  propertyCreatedTitle,
  propertyKindLabel,
  structureCodeError,
  structureErrorCode,
  structureErrorMessage,
  suggestCentreCode,
  type ProposedSeries
} from "./structure-ui";

export type AddPropertyWizardProps = {
  open: boolean;
  onClose: () => void;
  legalEntity: StructureLegalEntity;
  properties: StructureProperty[];
  singleHotel: boolean;
  /** Called after a real creation so the structure reloads. */
  onCreated: () => void;
};

type SeriesDraft = ProposedSeries & { enabled: boolean };

type Draft = {
  kind: PropertyKind;
  name: string;
  tradeName: string;
  code: string;
  codeTouched: boolean;
  floors: string;
  totalRooms: string;
  address: string;
  postalCode: string;
  municipality: string;
  ineMunicipalityCode: string;
  province: string;
  fiscalTerritory: string;
  starRating: string;
  bedCapacity: string;
  tourismRegistryNumber: string;
  surfaceM2: string;
  year: string;
  series: SeriesDraft[];
};

const STAR_OPTIONS = [
  { value: "", label: "Sin categoría" },
  ...[1, 2, 3, 4, 5].map((stars) => ({ value: String(stars), label: `${stars} ${stars === 1 ? "estrella" : "estrellas"}` }))
];

const TERRITORY_OPTIONS = [{ value: "", label: "Sin indicar" }, ...FISCAL_TERRITORY_OPTIONS.map((option) => ({ value: option.value, label: option.label }))];

function initialDraft(year: number, codedPrefix: boolean): Draft {
  return {
    kind: "hotel",
    name: "",
    tradeName: "",
    code: "",
    codeTouched: false,
    floors: "1",
    totalRooms: "",
    address: "",
    postalCode: "",
    municipality: "",
    ineMunicipalityCode: "",
    province: "",
    fiscalTerritory: "",
    starRating: "",
    bedCapacity: "",
    tourismRegistryNumber: "",
    surfaceM2: "",
    year: String(year),
    series: proposeSeries({ code: "", year, codedPrefix }).map((row) => ({ ...row, enabled: true }))
  };
}

const digits = (value: string, max: number) => value.replace(/\D/g, "").slice(0, max);

function stepsFor(kind: PropertyKind): string[] {
  return kind === "office" ? ["Tipo y nombre", "Ubicación fiscal", "Resumen"] : ["Tipo y nombre", "Ubicación fiscal", "Facturación", "Resumen"];
}

/** The centre spec the API receives (structure.schemas.ts centreSpecSchema); `dryRun` decides whether it writes. */
export function buildCentreSpec(draft: Draft, dryRun: boolean): CentreSpecBody {
  const nullable = (value: string) => (value.trim() === "" ? null : value.trim());
  const hotel = draft.kind === "hotel";
  const totalRooms = Number(draft.totalRooms);
  const floors = Number(draft.floors);
  const census: NonNullable<CentreSpecBody["property"]["census"]> = {};
  if (hotel) {
    if (draft.starRating) census.starRating = Number(draft.starRating);
    if (draft.bedCapacity.trim()) census.bedCapacity = Number(draft.bedCapacity);
    if (draft.tourismRegistryNumber.trim()) census.tourismRegistryNumber = draft.tourismRegistryNumber.trim();
  } else if (draft.surfaceM2.trim()) {
    census.surfaceM2 = draft.surfaceM2.trim().replace(",", ".");
  }
  const spec: CentreSpecBody = {
    property: {
      name: draft.name.trim(),
      kind: draft.kind,
      code: nullable(draft.code.toUpperCase()),
      tradeName: nullable(draft.tradeName),
      address: nullable(draft.address),
      municipality: nullable(draft.municipality),
      province: nullable(draft.province),
      country: "ES",
      postalCode: nullable(draft.postalCode),
      ineMunicipalityCode: nullable(draft.ineMunicipalityCode),
      fiscalTerritory: (nullable(draft.fiscalTerritory) as CentreSpecBody["property"]["fiscalTerritory"]) ?? null,
      ...(Object.keys(census).length > 0 ? { census } : {})
    },
    invoiceSequences:
      draft.kind === "office"
        ? []
        : draft.series.filter((row) => row.enabled).map((row) => ({ sequenceCode: row.sequenceCode, invoiceType: row.invoiceType, prefix: row.prefix.trim(), year: Number(draft.year) })),
    dryRun
  };
  if (hotel && Number.isFinite(totalRooms) && totalRooms > 0 && Number.isFinite(floors) && floors > 0) {
    spec.building = { name: draft.tradeName.trim() || draft.name.trim() || "Edificio principal", code: "MAIN", floors };
    spec.totalRooms = totalRooms;
    spec.roomTypes = { items: [{ code: "STD", name: "Habitación estándar", baseCapacity: 2, maxOccupancy: 2, count: totalRooms }] };
  }
  return spec;
}

/** The wizard has input worth a discard confirmation (pure): anything differs from the fresh draft (qa#9). */
export function wizardDirty(draft: Draft, fresh: Draft): boolean {
  return JSON.stringify(draft) !== JSON.stringify(fresh);
}

/** First inventory of a hotel: plantas × habitaciones must divide (rooms are numbered per floor); null when fine. */
export function roomsError(draft: Pick<Draft, "kind" | "floors" | "totalRooms">): string | null {
  if (draft.kind !== "hotel") return null;
  const floors = Number(draft.floors);
  const rooms = Number(draft.totalRooms);
  if (!Number.isInteger(floors) || floors < 1 || floors > 50) return "Indica entre 1 y 50 plantas.";
  if (!Number.isInteger(rooms) || rooms < 1) return "Indica el total de habitaciones (al menos 1).";
  if (rooms % floors !== 0) return `${rooms} habitaciones no se reparten en ${floors} plantas: ajusta una de las dos cifras (se numeran por planta).`;
  return null;
}

/** Client-side check of a step (the API repeats every rule); null when the step can continue. */
export function stepError(step: string, draft: Draft): string | null {
  if (step === "Tipo y nombre") {
    if (draft.name.trim() === "") return "Indica el nombre del centro.";
    const codeError = structureCodeError(draft.code);
    if (codeError) return codeError;
    const rooms = roomsError(draft);
    if (rooms) return rooms;
  }
  if (step === "Ubicación fiscal") {
    if (draft.postalCode.trim() !== "" && !/^\d{5}$/.test(draft.postalCode.trim())) return "Código postal de 5 dígitos.";
    if (draft.ineMunicipalityCode.trim() !== "" && !/^\d{5}$/.test(draft.ineMunicipalityCode.trim())) return "Código INE de 5 dígitos.";
    if (draft.postalCode.trim() !== "" && draft.ineMunicipalityCode.trim() !== "" && draft.postalCode.slice(0, 2) !== draft.ineMunicipalityCode.slice(0, 2)) {
      return "El código postal y el código INE deben empezar por la misma provincia.";
    }
    if (draft.kind !== "hotel" && draft.surfaceM2.trim() !== "" && !/^\d{1,8}([.,]\d{1,2})?$/.test(draft.surfaceM2.trim())) return "Superficie en m² con hasta dos decimales.";
  }
  if (step === "Facturación") {
    if (!/^\d{4}$/.test(draft.year.trim())) return "Año de la serie con 4 dígitos.";
    const enabled = draft.series.filter((row) => row.enabled);
    if (enabled.some((row) => row.prefix.trim() === "")) return "Cada serie activada necesita un prefijo.";
    const prefixes = enabled.map((row) => row.prefix.trim().toUpperCase());
    if (new Set(prefixes).size !== prefixes.length) return "Dos series no pueden compartir prefijo.";
  }
  return null;
}

export function AddPropertyWizard({ open, onClose, legalEntity, properties, singleHotel, onCreated }: AddPropertyWizardProps) {
  const year = currentFiscalYear();
  const codedPrefix = countBillingCentres(properties) >= 1;
  const takenCodes = useMemo(() => properties.map((property) => property.code).filter((code): code is string => Boolean(code)), [properties]);
  const propertyNames = useMemo(() => Object.fromEntries(properties.map((property) => [property.id, property.tradeName ?? property.name])), [properties]);

  const [draft, setDraft] = useState<Draft>(() => initialDraft(year, codedPrefix));
  const [stepIndex, setStepIndex] = useState(0);
  const [touched, setTouched] = useState(false);
  const [dryRun, setDryRun] = useState<{ status: "idle" | "loading" | "ready" | "error"; result: ProvisionCentreResult | null; message: string | null }>({ status: "idle", result: null, message: null });
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [created, setCreated] = useState<ProvisionCentreResult | null>(null);
  const [askDiscard, setAskDiscard] = useState(false);
  const nameInputId = useId();

  // Reset ONLY when the drawer opens: after «Crear centro» the structure reloads and
  // `codedPrefix` may flip, which must not wipe the success state being shown.
  useEffect(() => {
    if (!open) return;
    setDraft(initialDraft(year, codedPrefix));
    setStepIndex(0);
    setTouched(false);
    setDryRun({ status: "idle", result: null, message: null });
    setCreating(false);
    setFailure(null);
    setCreated(null);
    setAskDiscard(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Dirty guard (qa#9): Esc, the scrim and «Cancelar» ask before dropping typed
  // data; the success state and an untouched wizard close straight away.
  const dirty = !created && wizardDirty(draft, initialDraft(year, codedPrefix));
  const discard = confirmDiscard();
  function requestClose() {
    if (creating) return;
    if (dirty) setAskDiscard(true);
    else onClose();
  }

  const steps = stepsFor(draft.kind);
  const step = steps[Math.min(stepIndex, steps.length - 1)]!;
  const last = stepIndex === steps.length - 1;
  const error = stepError(step, draft);

  // Code suggestion follows the name until the user edits the code; the series prefixes follow the code (R3).
  function update(partial: Partial<Draft>) {
    setDraft((current) => {
      const next = { ...current, ...partial };
      if (!next.codeTouched) next.code = next.name.trim() ? suggestCentreCode(next.name, takenCodes, [legalEntity.legalName]) : "";
      const proposed = proposeSeries({ code: next.code, year: Number(next.year) || year, codedPrefix });
      next.series = proposed.map((row) => {
        const existing = current.series.find((candidate) => candidate.sequenceCode === row.sequenceCode);
        const previous = proposeSeries({ code: current.code, year: Number(current.year) || year, codedPrefix }).find((candidate) => candidate.sequenceCode === row.sequenceCode);
        const customised = existing && previous && existing.prefix !== previous.prefix;
        return { ...row, enabled: existing?.enabled ?? true, prefix: customised ? existing.prefix : row.prefix };
      });
      return next;
    });
    setFailure(null);
  }

  function setSeries(sequenceCode: string, partial: Partial<SeriesDraft>) {
    setDraft((current) => ({ ...current, series: current.series.map((row) => (row.sequenceCode === sequenceCode ? { ...row, ...partial } : row)) }));
    setFailure(null);
  }

  // Live dry run on the Facturación and Resumen steps (debounced): prefixes «Libre» / «Ya usado por …», resolved code, plan.
  const specKey = JSON.stringify(buildCentreSpec(draft, true));
  const wantsDryRun = open && !created && (step === "Facturación" || step === "Resumen") && error === null;
  useEffect(() => {
    if (!wantsDryRun) return;
    let cancelled = false;
    setDryRun((current) => ({ ...current, status: "loading" }));
    const timer = window.setTimeout(() => {
      provisionCentre(legalEntity.id, JSON.parse(specKey) as CentreSpecBody)
        .then((result) => {
          if (!cancelled) setDryRun({ status: "ready", result, message: null });
        })
        .catch((err: unknown) => {
          if (!cancelled) setDryRun({ status: "error", result: null, message: structureErrorMessage(err, "No se pudo validar el centro.", { propertyNames }) });
        });
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [wantsDryRun, specKey, legalEntity.id, propertyNames]);

  const clashesByCode = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of dryRun.result?.series ?? []) {
      if (row.clash) map.set(row.sequenceCode, propertyNames[row.clash.propertyId] ?? "otro centro");
    }
    return map;
  }, [dryRun.result, propertyNames]);
  const hasClash = clashesByCode.size > 0;

  async function create() {
    if (error || creating) return;
    setCreating(true);
    setFailure(null);
    try {
      const result = await provisionCentre(legalEntity.id, buildCentreSpec(draft, false));
      setCreated(result);
      invalidateSwitchableProperties();
      onCreated();
    } catch (err) {
      const code = structureErrorCode(err);
      setFailure(structureErrorMessage(err, "No se pudo crear el centro.", { propertyNames }));
      if (code === "PROPERTY_NAME_IN_USE" || code === "CODE_IN_USE") setStepIndex(0);
      if (code === "SERIES_PREFIX_CLASH") setStepIndex(Math.max(0, steps.indexOf("Facturación")));
    } finally {
      setCreating(false);
    }
  }

  function openCreatedIn(screenKey: "RoomSetupForm" | "JournalScreen") {
    const propertyId = created?.applied?.propertyId ?? created?.property.id;
    if (!propertyId) return;
    const url = urlForScreen(screenKey);
    if (url) openTabPath(url);
    setActiveProperty({ propertyId, organizationId: legalEntity.organizationId, propertyName: draft.tradeName.trim() || draft.name.trim() });
  }

  function stepTone(index: number): CocoaTone {
    return index < stepIndex ? "success" : index === stepIndex ? "accent" : "neutral";
  }

  const hotel = draft.kind === "hotel";
  const kindLabel = propertyKindLabel(draft.kind);

  let body: ReactNode;
  if (created) {
    const createdKind = created.property.kind;
    body = (
      <CocoaState
        kind="empty"
        illustration="success"
        title={propertyCreatedTitle(createdKind, created.property.name)}
        message={`Código ${created.property.code} en ${legalEntity.legalName}.${createdKind === "hotel" ? " Puedes ajustar sus habitaciones y tarifas o abrir sus finanzas." : " Ya puede recibir nóminas, gastos, bancos e inmovilizado; no ofrece módulos operativos."}`}
        primaryAction={createdKind === "hotel" ? { label: "Configurar habitaciones", onClick: () => openCreatedIn("RoomSetupForm") } : { label: "Abrir Finanzas en este centro", onClick: () => openCreatedIn("JournalScreen") }}
        secondaryAction={createdKind === "hotel" ? { label: "Abrir Finanzas en este centro", onClick: () => openCreatedIn("JournalScreen") } : { label: ACTIONS.close, onClick: onClose }}
        role="status"
      />
    );
  } else {
    body = (
      <div className="cocoa-stack" data-gap="4">
        <CocoaSection title="Progreso" meta={`${stepIndex + 1} / ${steps.length}`}>
          <CocoaChart.Progress value={((stepIndex + 1) / steps.length) * 100} label={step} showValue={false} />
          <ol className="c22-section__list" aria-label="Pasos del asistente">
            {steps.map((label, index) => (
              <li key={label} aria-current={index === stepIndex ? "step" : undefined}>
                <CocoaBadge tone={stepTone(index)} variant="dot" size="small">
                  {index < stepIndex ? "hecho" : index === stepIndex ? "actual" : "pendiente"}
                </CocoaBadge>
                <span>{label}</span>
              </li>
            ))}
          </ol>
        </CocoaSection>

        {failure ? (
          <CocoaCallout tone="danger" title="No se pudo crear el centro" role="alert">
            {failure}
          </CocoaCallout>
        ) : null}

        {step === "Tipo y nombre" ? (
          <CocoaSection title="Tipo y nombre" headingLevel={3}>
            <div className="cocoa-stack" data-gap="3">
              <CocoaField label="Tipo de centro" required help={hotel ? "Habitaciones, tarifas, recepción, tasa turística y SES." : "Sin habitaciones ni operación hotelera: solo nóminas, gastos, bancos, inmovilizado y retenciones."}>
                <CocoaSegmentedControl value={draft.kind} onChange={(value) => update({ kind: value as PropertyKind })} options={[...PROPERTY_KIND_OPTIONS]} size="small" aria-label="Tipo de centro" />
              </CocoaField>
              <CocoaFormRow columns={2}>
                <CocoaField label={hotel ? "Nombre del hotel" : "Nombre del centro"} required error={touched && draft.name.trim() === "" ? "Indica el nombre del centro." : undefined}>
                  <CocoaInput id={nameInputId} value={draft.name} onChange={(value) => update({ name: value })} placeholder={hotel ? "Hotel Faranda Pathos" : "Oficina central"} maxLength={120} />
                </CocoaField>
                <CocoaField label="Nombre comercial (en factura)" hint="opcional" help="Bloque «Establecimiento» de la factura; la razón social es la de la sociedad.">
                  <CocoaInput value={draft.tradeName} onChange={(value) => update({ tradeName: value })} placeholder={draft.name || "Como quieres que se lea en la factura"} maxLength={200} />
                </CocoaField>
                <CocoaField label="Código" required error={touched ? structureCodeError(draft.code) ?? undefined : undefined} help="De 2 a 6 letras o dígitos; identifica el centro en series, informes y ámbito.">
                  <CocoaInput value={draft.code} onChange={(value) => update({ code: normalizeStructureCode(value), codeTouched: true })} placeholder="PG" maxLength={6} />
                </CocoaField>
                {hotel ? (
                  <>
                    <CocoaField label="Plantas del edificio" required help="Las habitaciones se numeran por planta (101, 102… 201…).">
                      <CocoaInput value={draft.floors} onChange={(value) => update({ floors: digits(value, 2) })} inputMode="numeric" maxLength={2} />
                    </CocoaField>
                    <CocoaField label="Total de habitaciones" required error={touched ? roomsError(draft) ?? undefined : undefined} help="Nacen como un solo tipo «Habitación estándar»; afínalo después en Configuración › Habitaciones.">
                      <CocoaInput value={draft.totalRooms} onChange={(value) => update({ totalRooms: digits(value, 4) })} inputMode="numeric" maxLength={4} placeholder="48" />
                    </CocoaField>
                  </>
                ) : null}
              </CocoaFormRow>
              {!hotel ? (
                <CocoaCallout tone="info" title={`${kindLabel}: sin módulos operativos`}>
                  Un centro de tipo {kindLabel.toLowerCase()} no aparece en Hoy, Recepción, Operaciones, Comercial ni Revenue; solo en Finanzas y Configuración.
                </CocoaCallout>
              ) : null}
            </div>
          </CocoaSection>
        ) : null}

        {step === "Ubicación fiscal" ? (
          <CocoaSection title="Ubicación fiscal" headingLevel={3}>
            <CocoaFormRow columns={2}>
              <CocoaField label="Dirección" fullWidth>
                <CocoaInput value={draft.address} onChange={(value) => update({ address: value })} placeholder="Avenida de Portugal 12" maxLength={240} autoComplete="street-address" />
              </CocoaField>
              <CocoaField label="Código postal" error={touched && draft.postalCode.trim() !== "" && !/^\d{5}$/.test(draft.postalCode) ? "Código postal de 5 dígitos." : undefined}>
                <CocoaInput value={draft.postalCode} onChange={(value) => update({ postalCode: digits(value, 5) })} inputMode="numeric" maxLength={5} placeholder="15179" autoComplete="postal-code" />
              </CocoaField>
              <CocoaField label="Municipio">
                <CocoaInput value={draft.municipality} onChange={(value) => update({ municipality: value })} placeholder="Oleiros" maxLength={120} autoComplete="address-level2" />
              </CocoaField>
              <CocoaField label="Código INE del municipio" help="5 dígitos; misma provincia que el código postal. Lo exige SES.HOSPEDAJES.">
                <CocoaInput value={draft.ineMunicipalityCode} onChange={(value) => update({ ineMunicipalityCode: digits(value, 5) })} inputMode="numeric" maxLength={5} placeholder="15058" />
              </CocoaField>
              <CocoaField label="Provincia">
                <CocoaInput value={draft.province} onChange={(value) => update({ province: value })} placeholder="A Coruña" maxLength={80} autoComplete="address-level1" />
              </CocoaField>
              <CocoaField label="Territorio de facturación" help="Común (AEAT · VeriFactu) o foral (TicketBAI / Navarra).">
                <CocoaSelect value={draft.fiscalTerritory} onChange={(value) => update({ fiscalTerritory: value })} options={TERRITORY_OPTIONS} />
              </CocoaField>
              {hotel ? (
                <>
                  <CocoaField label="Categoría">
                    <CocoaSelect value={draft.starRating} onChange={(value) => update({ starRating: value })} options={STAR_OPTIONS} />
                  </CocoaField>
                  <CocoaField label="Plazas" help="Capacidad autorizada; base del IAE (grupo 681) y de la tasa turística.">
                    <CocoaInput value={draft.bedCapacity} onChange={(value) => update({ bedCapacity: digits(value, 5) })} inputMode="numeric" maxLength={5} />
                  </CocoaField>
                  <CocoaField label="Registro turístico" hint="opcional">
                    <CocoaInput value={draft.tourismRegistryNumber} onChange={(value) => update({ tourismRegistryNumber: value })} placeholder="H-CO-000123" maxLength={40} />
                  </CocoaField>
                </>
              ) : (
                <CocoaField label="Superficie (m²)" hint="opcional" help="Base del IAE por superficie de la oficina; se guarda como dato para la gestoría.">
                  <CocoaInput value={draft.surfaceM2} onChange={(value) => update({ surfaceM2: value })} inputMode="decimal" placeholder="120,50" maxLength={12} />
                </CocoaField>
              )}
            </CocoaFormRow>
          </CocoaSection>
        ) : null}

        {step === "Facturación" ? (
          <CocoaSection title="Facturación" headingLevel={3} meta={dryRun.status === "loading" ? "comprobando…" : dryRun.status === "ready" ? (hasClash ? "prefijos en conflicto" : "prefijos libres") : undefined}>
            <div className="cocoa-stack" data-gap="3">
              <p className="cocoa-note">
                {codedPrefix
                  ? "La sociedad ya factura desde otro centro: los prefijos llevan el código del centro para que dos centros nunca emitan el mismo número bajo el mismo NIF."
                  : "Primer centro facturador de la sociedad: los prefijos van sin código, como hasta ahora."}
              </p>
              <CocoaFormRow columns={2}>
                <CocoaField label="Año de las series" required>
                  <CocoaInput value={draft.year} onChange={(value) => update({ year: digits(value, 4) })} inputMode="numeric" maxLength={4} />
                </CocoaField>
              </CocoaFormRow>
              {dryRun.status === "error" ? (
                <CocoaCallout tone="danger" title="No se pudo comprobar" role="alert">
                  {dryRun.message}
                </CocoaCallout>
              ) : null}
              <ul className="c22-section__list" aria-label="Series propuestas">
                {draft.series.map((row) => {
                  const clash = clashesByCode.get(row.sequenceCode);
                  return (
                    <li key={row.sequenceCode}>
                      <div className="cocoa-stack" data-gap="2">
                        <CocoaField label={`${row.sequenceCode} · ${row.label}`} inline>
                          <CocoaSwitch checked={row.enabled} onChange={(value) => setSeries(row.sequenceCode, { enabled: value })} size="small" />
                        </CocoaField>
                        {row.enabled ? (
                          <CocoaField label="Prefijo" error={clash ? `Ya usado por ${clash}: elige otro prefijo.` : undefined}>
                            <CocoaInput value={row.prefix} onChange={(value) => setSeries(row.sequenceCode, { prefix: value.toUpperCase() })} maxLength={24} />
                          </CocoaField>
                        ) : null}
                      </div>
                      {row.enabled ? (
                        dryRun.status === "ready" ? (
                          clash ? <CocoaBadge tone="danger">ya usado por {clash}</CocoaBadge> : <CocoaBadge tone="success">libre</CocoaBadge>
                        ) : (
                          <CocoaBadge tone="neutral">{dryRun.status === "loading" ? "comprobando" : "sin comprobar"}</CocoaBadge>
                        )
                      ) : (
                        <CocoaBadge tone="neutral">no se abre</CocoaBadge>
                      )}
                    </li>
                  );
                })}
              </ul>
              <CocoaCallout tone="info">La cadena VeriFactu del centro se abre con su instalación al activar la primera emisión; hasta entonces la serie numera sin envío.</CocoaCallout>
            </div>
          </CocoaSection>
        ) : null}

        {step === "Resumen" ? (
          <CocoaSection title="Resumen" headingLevel={3} meta={dryRun.status === "loading" ? "comprobando…" : undefined}>
            <div className="cocoa-stack" data-gap="3">
              <ul className="c22-section__list" aria-label="Resumen del centro">
                <li>
                  <span>Tipo</span>
                  <strong>{kindLabel}</strong>
                </li>
                <li>
                  <span>Nombre</span>
                  <strong>{draft.name.trim()}</strong>
                </li>
                {draft.tradeName.trim() ? (
                  <li>
                    <span>Nombre comercial</span>
                    <strong>{draft.tradeName.trim()}</strong>
                  </li>
                ) : null}
                <li>
                  <span>Código</span>
                  <strong>{dryRun.result?.property.code || draft.code || "se derivará del nombre"}</strong>
                </li>
                <li>
                  <span>Sociedad</span>
                  <strong>{legalEntity.legalName}</strong>
                </li>
                {hotel ? (
                  <li>
                    <span>Inventario inicial</span>
                    <strong>{`${plural(Number(draft.totalRooms) || 0, "habitación", "habitaciones")} en ${plural(Number(draft.floors) || 0, "planta", "plantas")}`}</strong>
                  </li>
                ) : null}
                <li>
                  <span>Ubicación</span>
                  <strong>{[draft.address, draft.postalCode, draft.municipality, draft.province].filter((part) => part.trim()).join(", ") || "sin indicar"}</strong>
                </li>
                <li>
                  <span>Series</span>
                  <strong>{draft.kind === "office" ? "ninguna (la oficina no factura)" : draft.series.filter((row) => row.enabled).map((row) => row.prefix).join(" · ") || "ninguna"}</strong>
                </li>
              </ul>
              {draft.kind === "office" ? (
                <CocoaCallout tone="info" title="Cuenta bancaria">
                  La oficina usa la cuenta bancaria de la sociedad: asígnala en Finanzas › Tesorería cuando exista. Sus nóminas, gastos e inmovilizado se contabilizan con centro «Oficina central».
                </CocoaCallout>
              ) : null}
              {dryRun.status === "error" ? (
                <CocoaCallout tone="danger" title="La comprobación previa falló" role="alert">
                  {dryRun.message}
                </CocoaCallout>
              ) : null}
              {hasClash ? (
                <CocoaCallout tone="danger" title="Prefijos en conflicto" role="alert">
                  {[...clashesByCode.entries()].map(([code, sister]) => `${code}: ya usado por ${sister}`).join(" · ")}. Vuelve a Facturación y elige otros prefijos.
                </CocoaCallout>
              ) : null}
              {dryRun.result && dryRun.result.plan.conflicts.length > 0 && !hasClash ? (
                <CocoaCallout tone="warning" title="Avisos del plan">
                  {dryRun.result.plan.conflicts.join(" · ")}
                </CocoaCallout>
              ) : null}
              {dryRun.result?.property.existed ? (
                <CocoaCallout tone="danger" title="Ya existe un centro con ese nombre" role="alert">
                  Elige otro nombre: el alta desde producto nunca converge en silencio sobre un centro existente.
                </CocoaCallout>
              ) : null}
              {dryRun.result ? (
                <p className="cocoa-note">
                  {plural(dryRun.result.plan.writes.reduce((acc, write) => acc + write.count, 0), "fila", "filas")} en {number(dryRun.result.plan.writes.length)} tablas al crear.
                </p>
              ) : null}
            </div>
          </CocoaSection>
        ) : null}
      </div>
    );
  }

  const canCreate = last && error === null && dryRun.status === "ready" && !hasClash && !dryRun.result?.property.existed && !creating;

  const drawer = (
    <CocoaDrawer
      open={open}
      onClose={requestClose}
      title={singleHotel ? "Añadir otro establecimiento" : "Añadir centro"}
      subtitle={created ? undefined : `${legalEntity.legalName} · paso ${stepIndex + 1} de ${steps.length}: ${step}`}
      side="right"
      size="lg"
      dismissible={!creating}
      initialFocus={() => document.getElementById(nameInputId)}
      footer={
        created ? (
          <CocoaButton variant="filled" tone="accent" onClick={onClose}>
            {ACTIONS.close}
          </CocoaButton>
        ) : (
          <>
            <CocoaButton variant="plain" tone="neutral" onClick={requestClose} disabled={creating}>
              {ACTIONS.cancel}
            </CocoaButton>
            {stepIndex > 0 ? (
              <CocoaButton variant="bordered" tone="neutral" onClick={() => setStepIndex((index) => index - 1)} disabled={creating}>
                {ACTIONS.previous}
              </CocoaButton>
            ) : null}
            {last ? (
              <CocoaButton variant="filled" tone="accent" onClick={() => void create()} loading={creating} disabled={!canCreate}>
                {creating ? STATUS_LABELS.saving : "Crear centro"}
              </CocoaButton>
            ) : (
              <CocoaButton
                variant="filled"
                tone="accent"
                onClick={() => {
                  setTouched(true);
                  if (error === null) {
                    setTouched(false);
                    setStepIndex((index) => index + 1);
                  }
                }}
                disabled={creating}
                title={error ?? undefined}
              >
                {ACTIONS.next}
              </CocoaButton>
            )}
          </>
        )
      }
    >
      {touched && error && !created ? (
        <CocoaCallout tone="warning" role="status">
          {error}
        </CocoaCallout>
      ) : null}
      {body}
    </CocoaDrawer>
  );

  // The dialog is a sibling of the drawer (both are portals): inside the drawer
  // its Tab presses would bubble through the React tree into the drawer's trap.
  return (
    <>
      {drawer}
      <CocoaDialog
        open={askDiscard}
        onClose={() => setAskDiscard(false)}
        tone="destructive"
        title={discard.title}
        description={discard.message}
        confirmLabel={discard.confirmLabel}
        cancelLabel={discard.cancelLabel}
        onConfirm={() => {
          setAskDiscard(false);
          onClose();
        }}
      />
    </>
  );
}

export default AddPropertyWizard;
