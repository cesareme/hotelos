// Tasa turística por comunidad autónoma — /cumplimiento/impuestos/tasa-turistica
// (Cocoa 22 · ola 8 · lote 8-C, plantilla DashboardAlojado; hosted in ImpuestosTabs).
//
// Real endpoints:
//   GET  /tourist-tax/rates[?ccaaCode=CAT]      — list the rates
//   POST /tourist-tax/rates                     — create a rate
//   POST /tourist-tax/seed                      — seed the real 2026 rates
//
// Model: `TouristTaxRate` (packages/database/prisma/schema.prisma). Seeded real
// data: Cataluña (Ley 2/2026), Baleares (Decreto 35/2016), País Vasco /
// Gipuzkoa (Norma Foral 2/2024). The engine computes the tax per night ·
// person · class, with an optional high-season surcharge and exemptions
// (minors, medical reasons).
//
// Page: KPI strip (rates, valid today, regions, municipal rates) → filter by
// region → one CocoaSection per region with its CocoaTable (8 columns: the
// short ones `fit`, the secondary ones from laptop / desktop) → the new-rate
// form lives in a CocoaDrawer (two-button footer, field-level validation).

import { useMemo, useState } from "react";
import { useApiData } from "../../hooks/useApiData";
import { createTouristTaxRate, seedTouristTaxRates, type CreateTouristTaxRatePayload, type TouristTaxRate } from "../../services/touristTaxApi";
import { useToast } from "../../components/Toast";
import { PlusIcon } from "../../components/cocoa-icons/ActionIcons";
import { date, DEFAULT_CURRENCY, money, percent, plural, toNumber } from "../../lib/format";
import { ACTIONS, STATUS_LABELS, newLabel } from "../../content/actions";
import { toArray } from "../../utils/toArray";
import { treeHeaderFor } from "../tabs/tab-helpers";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDatePicker,
  CocoaDrawer,
  CocoaField,
  CocoaFormRow,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaSkeleton,
  CocoaState,
  CocoaTable,
  CocoaToolbar,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

// Menu labels of the tree (Cumplimiento › Impuestos › Tasa turística), never retyped here.
const HEADER = treeHeaderFor("TouristTax", { eyebrow: "Cumplimiento · Impuestos", title: "Tasa turística" });

const CCAA_LABEL: Record<string, string> = {
  CAT: "Cataluña",
  BAL: "Baleares",
  EUSK: "País Vasco",
  CAN: "Canarias",
  MAD: "Madrid",
  VAL: "Valencia",
  AND: "Andalucía",
  GAL: "Galicia",
  NAV: "Navarra",
  AST: "Asturias",
  CANT: "Cantabria",
  ARA: "Aragón",
  MUR: "Murcia",
  RIO: "La Rioja",
  CYL: "Castilla y León",
  CLM: "Castilla-La Mancha",
  EXT: "Extremadura",
  CEU: "Ceuta",
  MEL: "Melilla"
};

const CLASS_LABEL: Record<string, string> = {
  lujo_5e: "Lujo / Gran lujo (5*GL)",
  "5_estrellas": "5 estrellas",
  "4_estrellas_sup": "4 estrellas superior",
  "4_estrellas": "4 estrellas",
  "3_estrellas": "3 estrellas",
  "2_estrellas": "2 estrellas",
  "2_o_menos": "2 estrellas o menos",
  "1_estrella": "1 estrella",
  apt_turistico: "Apartamento turístico",
  apt_4_4sup: "Apt. 4 estrellas / 4 superior",
  apt_3_2_1: "Apt. 1-3 estrellas",
  rural: "Turismo rural",
  camping: "Camping",
  hostel: "Hostel / albergue"
};

const EXEMPTION_LABEL: Record<string, string> = {
  MENORES_16: "Menores de 16",
  MENORES_18: "Menores de 18",
  MEDICAL_TRIP: "Motivos médicos",
  FORCED_BY_AUTHORITY: "Estancia forzosa",
  ARMED_FORCES: "Fuerzas armadas"
};

const CCAA_OPTIONS = Object.keys(CCAA_LABEL).map((code) => ({ value: code, label: `${CCAA_LABEL[code]} (${code})` }));
const CCAA_FILTER_OPTIONS = [{ value: "", label: "Todas las comunidades" }, ...CCAA_OPTIONS];
const CLASS_OPTIONS = Object.keys(CLASS_LABEL).map((code) => ({ value: code, label: CLASS_LABEL[code] }));

/** Sanity ceiling: real Spanish rates go from 0,25 € (Asturias) to about 7–8 € per person and night (5* GL in Cataluña / Baleares); above 100 € it is almost surely a typo. */
const MAX_AMOUNT_PER_PERSON_NIGHT = 100;
const SEED_LABEL = "Sembrar tarifas 2026";
const NEW_RATE_LABEL = newLabel("f", "tarifa");
const CCAA_FIELD_ID = "tourist-tax-new-rate-ccaa";

type Draft = {
  ccaaCode: string;
  municipality: string;
  establishmentClass: string;
  amountPerPersonNight: string;
  currency: string;
  validFrom: string;
  validUntil: string;
  maxNightsPerStay: string;
  highSeasonSurcharge: string;
  highSeasonFromMmdd: string;
  highSeasonUntilMmdd: string;
  taxableAgeFrom: string;
  legalSource: string;
};

type DraftErrors = Partial<Record<keyof Draft, string>>;
type Notice = { tone: CocoaTone; text: string };

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function emptyDraft(): Draft {
  return {
    ccaaCode: "CAT",
    municipality: "",
    establishmentClass: "4_estrellas",
    amountPerPersonNight: "",
    currency: "EUR",
    validFrom: todayIso(),
    validUntil: "",
    maxNightsPerStay: "7",
    highSeasonSurcharge: "",
    highSeasonFromMmdd: "",
    highSeasonUntilMmdd: "",
    taxableAgeFrom: "16",
    legalSource: ""
  };
}

/** Field-level validation of the new-rate form (pure): the same rules the legacy screen enforced, plus the 0–1 range of the surcharge. */
export function validateDraft(draft: Draft): DraftErrors {
  const errors: DraftErrors = {};
  if (!draft.ccaaCode.trim()) errors.ccaaCode = "Indica la comunidad autónoma.";
  if (!draft.establishmentClass.trim()) errors.establishmentClass = "Indica la categoría del establecimiento.";
  const amount = toNumber(draft.amountPerPersonNight);
  if (!draft.amountPerPersonNight.trim() || amount === null || amount < 0) {
    errors.amountPerPersonNight = "La tarifa por persona y noche es obligatoria y no puede ser negativa.";
  } else if (amount > MAX_AMOUNT_PER_PERSON_NIGHT) {
    errors.amountPerPersonNight = `La tarifa parece desproporcionada (${money(amount)} por persona y noche). El máximo admitido es ${money(MAX_AMOUNT_PER_PERSON_NIGHT)}. Revisa el importe.`;
  }
  if (!draft.validFrom) errors.validFrom = "La fecha de inicio de vigencia es obligatoria.";
  if (draft.maxNightsPerStay.trim()) {
    const maxNights = toNumber(draft.maxNightsPerStay);
    if (maxNights === null || maxNights < 0 || maxNights > 365) errors.maxNightsPerStay = "Máx. noches debe estar entre 0 (sin límite) y 365.";
  }
  if (draft.highSeasonSurcharge.trim()) {
    const surcharge = toNumber(draft.highSeasonSurcharge);
    if (surcharge === null || surcharge < 0 || surcharge > 1) errors.highSeasonSurcharge = "El recargo se indica como fracción entre 0 y 1 (0,25 = +25 %).";
  }
  return errors;
}

function highSeasonCell(rate: TouristTaxRate) {
  if (!rate.highSeasonSurcharge || rate.highSeasonSurcharge <= 0) return "—";
  const surcharge = percent(rate.highSeasonSurcharge, { ratio: true, signDisplay: "always", maximumFractionDigits: 0 });
  const detail = `Recargo del ${percent(rate.highSeasonSurcharge, { ratio: true, maximumFractionDigits: 0 })} entre ${rate.highSeasonFromMmdd} y ${rate.highSeasonUntilMmdd}`;
  return (
    <CocoaBadge tone="warning" uppercase={false} title={detail}>
      {surcharge} · {rate.highSeasonFromMmdd} → {rate.highSeasonUntilMmdd}
    </CocoaBadge>
  );
}

function exemptionsCell(rate: TouristTaxRate) {
  return (
    <span className="cocoa-row" data-gap="1">
      <CocoaBadge tone="neutral" size="small" uppercase={false} title={`Menores de ${rate.taxableAgeFrom} años exentos`}>
        Menores de {rate.taxableAgeFrom}
      </CocoaBadge>
      {rate.ccaaCode === "CAT" ? (
        <>
          <CocoaBadge tone="neutral" size="small" uppercase={false}>
            {EXEMPTION_LABEL.MEDICAL_TRIP}
          </CocoaBadge>
          <CocoaBadge tone="neutral" size="small" uppercase={false}>
            {EXEMPTION_LABEL.FORCED_BY_AUTHORITY}
          </CocoaBadge>
        </>
      ) : null}
    </span>
  );
}

// Columns outside the component (A5): the short ones fit their content, the secondary ones show from laptop / desktop (D26).
const RATE_COLUMNS: CocoaTableColumn<TouristTaxRate>[] = [
  { key: "municipality", label: "Municipio", minWidth: 140, render: (rate) => rate.municipality ?? <span className="cocoa-caption">Toda la comunidad</span> },
  { key: "establishmentClass", label: "Categoría", minWidth: 160, render: (rate) => CLASS_LABEL[rate.establishmentClass] ?? rate.establishmentClass },
  { key: "amountPerPersonNight", label: "€ por persona y noche", align: "right", fit: true, render: (rate) => <strong>{money(rate.amountPerPersonNight, rate.currency)}</strong> },
  {
    key: "maxNightsPerStay",
    label: "Máx. noches",
    align: "right",
    fit: true,
    hideOnNarrow: true,
    render: (rate) => (rate.maxNightsPerStay > 0 ? plural(rate.maxNightsPerStay, "noche", "noches", { withCount: true }) : "Sin límite")
  },
  { key: "highSeason", label: "Temporada alta", fit: true, showFrom: "laptop", render: highSeasonCell },
  { key: "exemptions", label: "Exenciones", showFrom: "laptop", render: exemptionsCell },
  {
    key: "validity",
    label: "Vigencia",
    fit: true,
    hideOnNarrow: true,
    render: (rate) => `${date(rate.validFrom, "medium")} → ${rate.validUntil ? date(rate.validUntil, "medium") : "indefinida"}`
  },
  { key: "legalSource", label: "Fuente legal", showFrom: "desktop", render: (rate) => rate.legalSource ?? "—" }
];

// Mirror skeleton: the KPI strip and one region card.
function TouristTaxSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={4} />
      <CocoaSkeleton variant="card" height={280} />
    </div>
  );
}

export function TouristTaxScreen() {
  // Hosted in ImpuestosTabs: CocoaPage reads the host context itself and paints
  // only the subtitle and the actions row under the container's head.
  const { showToast } = useToast();
  const [filterCcaa, setFilterCcaa] = useState<string>("");
  const path = filterCcaa ? `/tourist-tax/rates?ccaaCode=${encodeURIComponent(filterCcaa)}` : `/tourist-tax/rates`;
  const { data, loading, error, refresh } = useApiData<{ items: TouristTaxRate[] }>(path, { pollIntervalMs: 0 });
  const rates = useMemo(() => toArray<TouristTaxRate>(data?.items), [data]);

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [draftErrors, setDraftErrors] = useState<DraftErrors>({});

  // Group by region; inside each group municipality first (null first), then class.
  const byCcaa = useMemo(() => {
    const m = new Map<string, TouristTaxRate[]>();
    for (const r of rates) {
      const arr = m.get(r.ccaaCode) ?? [];
      arr.push(r);
      m.set(r.ccaaCode, arr);
    }
    for (const [k, arr] of m.entries()) {
      arr.sort((a, b) => {
        if ((a.municipality ?? "") !== (b.municipality ?? "")) {
          return (a.municipality ?? "").localeCompare(b.municipality ?? "");
        }
        return a.establishmentClass.localeCompare(b.establishmentClass);
      });
      m.set(k, arr);
    }
    return m;
  }, [rates]);

  const kpis = useMemo(() => {
    const activeCcaa = new Set(rates.map((r) => r.ccaaCode));
    const munis = new Set(rates.filter((r) => r.municipality).map((r) => `${r.ccaaCode}:${r.municipality}`));
    const now = Date.now();
    const validNow = rates.filter((r) => {
      const from = new Date(r.validFrom).getTime();
      const until = r.validUntil ? new Date(r.validUntil).getTime() : Number.POSITIVE_INFINITY;
      return now >= from && now <= until;
    });
    return { totalRates: rates.length, ccaaCount: activeCcaa.size, muniCount: munis.size, validCount: validNow.length };
  }, [rates]);

  function openForm() {
    setDraft(emptyDraft());
    setDraftErrors({});
    setFormError(null);
    setNotice(null);
    setShowForm(true);
  }

  function closeForm() {
    if (busy) return;
    setShowForm(false);
    setDraftErrors({});
    setFormError(null);
  }

  function patch<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    if (draftErrors[key]) {
      setDraftErrors((errors) => {
        const next = { ...errors };
        delete next[key];
        return next;
      });
    }
  }

  async function seed() {
    setBusy(true);
    setNotice(null);
    try {
      const r = await seedTouristTaxRates();
      setNotice({
        tone: "success",
        text: `Carga completada: ${plural(r.rates, "tarifa", "tarifas", { withCount: true })} y ${plural(r.exemptions, "exención", "exenciones", { withCount: true })}.`
      });
      showToast(`${plural(r.rates, "registro de tasa turística sembrado", "registros de tasa turística sembrados", { withCount: true })}`, { variant: "success" });
      refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : "No se pudo sembrar.";
      setNotice({ tone: "danger", text: message });
      showToast(message, { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const errors = validateDraft(draft);
    setDraftErrors(errors);
    setFormError(null);
    if (Object.keys(errors).length > 0) return;
    const amount = toNumber(draft.amountPerPersonNight) ?? 0;
    setBusy(true);
    setNotice(null);
    try {
      const payload: CreateTouristTaxRatePayload = {
        ccaaCode: draft.ccaaCode.trim(),
        municipality: draft.municipality.trim() || null,
        establishmentClass: draft.establishmentClass.trim(),
        amountPerPersonNight: amount,
        currency: draft.currency || DEFAULT_CURRENCY,
        validFrom: draft.validFrom,
        validUntil: draft.validUntil || null,
        maxNightsPerStay: toNumber(draft.maxNightsPerStay) ?? 0,
        highSeasonSurcharge: toNumber(draft.highSeasonSurcharge),
        highSeasonFromMmdd: draft.highSeasonFromMmdd.trim() || null,
        highSeasonUntilMmdd: draft.highSeasonUntilMmdd.trim() || null,
        taxableAgeFrom: toNumber(draft.taxableAgeFrom) ?? 16,
        legalSource: draft.legalSource.trim() || null
      };
      await createTouristTaxRate(payload);
      const ccaaName = CCAA_LABEL[draft.ccaaCode] ?? draft.ccaaCode;
      setNotice({ tone: "success", text: `Tarifa creada en ${ccaaName}.` });
      showToast(`Tarifa de ${ccaaName} creada`, { variant: "success" });
      setShowForm(false);
      setDraft(emptyDraft());
      refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : "No se pudo crear la tarifa.";
      setFormError(message);
      showToast(message, { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  const groups = [...byCcaa.entries()];
  const actions = (
    <>
      {busy ? <CocoaBadge tone="info">{STATUS_LABELS.saving}</CocoaBadge> : loading && data ? <CocoaBadge tone="info">{STATUS_LABELS.loading}</CocoaBadge> : null}
      <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh} disabled={loading || busy}>
        {ACTIONS.refresh}
      </CocoaButton>
      <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void seed()} disabled={busy}>
        {SEED_LABEL}
      </CocoaButton>
      <CocoaButton variant="filled" tone="accent" size="small" icon={<PlusIcon size={14} />} onClick={openForm} disabled={busy}>
        {NEW_RATE_LABEL}
      </CocoaButton>
    </>
  );

  return (
    <CocoaPage
      eyebrow={HEADER.eyebrow}
      title={HEADER.title}
      subtitle="Tarifas vigentes en España. El motor de tasa turística aplica la tarifa más específica (municipio + comunidad, o solo comunidad), respetando recargos de temporada alta y exenciones (menores, motivos médicos, fuerzas armadas según jurisdicción)."
      actions={actions}
      state={loading && !data ? "loading" : "ready"}
      skeleton={<TouristTaxSkeleton />}
      commands={[
        { id: "tasa-turistica-refresh", label: "Actualizar la tasa turística", run: refresh },
        { id: "tasa-turistica-seed", label: `${SEED_LABEL} de tasa turística`, run: () => void seed() },
        { id: "tasa-turistica-new", label: `${NEW_RATE_LABEL} de tasa turística`, run: openForm }
      ]}
    >
      {notice ? (
        <CocoaCallout tone={notice.tone} role="status">
          {notice.text}
        </CocoaCallout>
      ) : null}

      <CocoaKpiStrip stagger aria-label="Resumen de la tasa turística">
        <CocoaKpi label="Tarifas catalogadas" value={kpis.totalRates} caption="en total" polarity="neutral" />
        <CocoaKpi label="Vigentes hoy" value={kpis.validCount} caption="activas" polarity="neutral" status="ok" />
        <CocoaKpi label="Comunidades cubiertas" value={kpis.ccaaCount} caption="distintas" polarity="neutral" />
        <CocoaKpi label="Tarifas municipales" value={kpis.muniCount} caption="recargo local" polarity="neutral" />
      </CocoaKpiStrip>

      <CocoaToolbar
        variant="content"
        aria-label="Filtro de tarifas"
        leftSlot={<CocoaSelect inline aria-label="Filtrar por comunidad autónoma" value={filterCcaa} onChange={setFilterCcaa} options={CCAA_FILTER_OPTIONS} disabled={busy} />}
        rightSlot={<span className="cocoa-caption">{plural(rates.length, "tarifa", "tarifas", { withCount: true })}</span>}
      />

      {error && rates.length > 0 ? (
        <CocoaCallout
          tone="danger"
          role="alert"
          title="No se pudieron cargar las tarifas"
          actions={
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh}>
              {ACTIONS.retry}
            </CocoaButton>
          }
        >
          {error} Se muestran las últimas tarifas cargadas.
        </CocoaCallout>
      ) : null}

      {error && rates.length === 0 ? (
        <CocoaSection aria-label="Tarifas de tasa turística">
          <CocoaState kind="error" title="No se pudieron cargar las tarifas" message={error} onRetry={refresh} />
        </CocoaSection>
      ) : !loading && rates.length === 0 ? (
        <CocoaSection aria-label="Tarifas de tasa turística">
          <CocoaState
            kind="empty"
            illustration={filterCcaa ? "search" : "box"}
            title="Sin tarifas catalogadas"
            message={
              filterCcaa
                ? `Ninguna tarifa catalogada en ${CCAA_LABEL[filterCcaa] ?? filterCcaa}. Prueba con otra comunidad o crea una tarifa manual.`
                : `Pulsa «${SEED_LABEL}» para cargar las tarifas reales vigentes en España (Cataluña, Baleares y País Vasco), o «${NEW_RATE_LABEL}» para crear una manual.`
            }
            primaryAction={{ label: SEED_LABEL, onClick: () => void seed(), loading: busy }}
            secondaryAction={{ label: NEW_RATE_LABEL, onClick: openForm }}
          />
        </CocoaSection>
      ) : (
        groups.map(([ccaa, items]) => (
          <CocoaSection
            key={ccaa}
            title={`${CCAA_LABEL[ccaa] ?? ccaa} (${ccaa})`}
            meta={plural(items.length, "tarifa catalogada", "tarifas catalogadas", { withCount: true })}
            padding="none"
            style={{ overflow: "clip" }}
          >
            <CocoaTable columns={RATE_COLUMNS} rows={items} rowKey="id" caption={`Tarifas de ${CCAA_LABEL[ccaa] ?? ccaa}`} aria-label={`Tarifas de ${CCAA_LABEL[ccaa] ?? ccaa}`} />
          </CocoaSection>
        ))
      )}

      <CocoaDrawer
        open={showForm}
        onClose={closeForm}
        title={NEW_RATE_LABEL}
        subtitle="Tarifa por persona y noche para una comunidad autónoma o un municipio."
        side="right"
        size="lg"
        initialFocus={() => document.getElementById(CCAA_FIELD_ID)}
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={closeForm} disabled={busy}>
              {ACTIONS.cancel}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" onClick={() => void save()} loading={busy}>
              Crear tarifa
            </CocoaButton>
          </>
        }
      >
        <div className="cocoa-stack" data-gap="4">
          {formError ? (
            <CocoaCallout tone="danger" role="alert" title="No se pudo crear la tarifa">
              {formError}
            </CocoaCallout>
          ) : null}
          <CocoaFormRow columns={2}>
            <CocoaField label="Comunidad autónoma" required error={draftErrors.ccaaCode}>
              <CocoaSelect id={CCAA_FIELD_ID} value={draft.ccaaCode} onChange={(value) => patch("ccaaCode", value)} options={CCAA_OPTIONS} disabled={busy} />
            </CocoaField>
            <CocoaField label="Municipio" help="Vacío = toda la comunidad autónoma.">
              <CocoaInput value={draft.municipality} onChange={(value) => patch("municipality", value)} placeholder="Ej. Barcelona" disabled={busy} />
            </CocoaField>
            <CocoaField label="Categoría del establecimiento" required error={draftErrors.establishmentClass}>
              <CocoaSelect value={draft.establishmentClass} onChange={(value) => patch("establishmentClass", value)} options={CLASS_OPTIONS} disabled={busy} />
            </CocoaField>
            <CocoaField label="€ por persona y noche" required error={draftErrors.amountPerPersonNight} help={`Hasta ${money(MAX_AMOUNT_PER_PERSON_NIGHT)}.`}>
              <CocoaInput inputMode="decimal" value={draft.amountPerPersonNight} onChange={(value) => patch("amountPerPersonNight", value)} placeholder="3,50" disabled={busy} />
            </CocoaField>
            <CocoaField label="Vigente desde" required error={draftErrors.validFrom}>
              <CocoaDatePicker value={draft.validFrom} onChange={(value) => patch("validFrom", value)} disabled={busy} />
            </CocoaField>
            <CocoaField label="Vigente hasta" hint={STATUS_LABELS.optional.toLowerCase()}>
              <CocoaDatePicker value={draft.validUntil} onChange={(value) => patch("validUntil", value)} disabled={busy} />
            </CocoaField>
            <CocoaField label="Máx. noches por estancia" help="0 = sin límite." error={draftErrors.maxNightsPerStay}>
              <CocoaInput type="number" inputMode="numeric" min={0} max={365} step={1} value={draft.maxNightsPerStay} onChange={(value) => patch("maxNightsPerStay", value)} disabled={busy} />
            </CocoaField>
            <CocoaField label="Edad mínima tributable">
              <CocoaInput type="number" inputMode="numeric" min={0} max={99} step={1} value={draft.taxableAgeFrom} onChange={(value) => patch("taxableAgeFrom", value)} disabled={busy} />
            </CocoaField>
            <CocoaField label="Recargo de temporada alta" help="Fracción: 0,25 = +25 %." error={draftErrors.highSeasonSurcharge}>
              <CocoaInput inputMode="decimal" value={draft.highSeasonSurcharge} onChange={(value) => patch("highSeasonSurcharge", value)} placeholder="0,25" disabled={busy} />
            </CocoaField>
            <CocoaField label="Temporada alta desde" help="Formato mm-dd.">
              <CocoaInput value={draft.highSeasonFromMmdd} onChange={(value) => patch("highSeasonFromMmdd", value)} placeholder="05-01" disabled={busy} />
            </CocoaField>
            <CocoaField label="Temporada alta hasta" help="Formato mm-dd.">
              <CocoaInput value={draft.highSeasonUntilMmdd} onChange={(value) => patch("highSeasonUntilMmdd", value)} placeholder="10-31" disabled={busy} />
            </CocoaField>
            <CocoaField label="Fuente legal" fullWidth help="DOGC, BOE, etc.">
              <CocoaInput value={draft.legalSource} onChange={(value) => patch("legalSource", value)} placeholder="DOGC Ley 2/2026" disabled={busy} />
            </CocoaField>
          </CocoaFormRow>
        </div>
      </CocoaDrawer>
    </CocoaPage>
  );
}
