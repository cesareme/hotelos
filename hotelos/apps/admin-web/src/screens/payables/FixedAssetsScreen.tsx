// Inmovilizado — /finanzas/proveedores/inmovilizado (Tanda 6 · Finanzas · lote 6-E).
//
// Cocoa 22 «lista / tabla» (docs/design/COCOA-22.md §4, pilot GuestsListScreen)
// with two drawers and the monthly depreciation workspace: CocoaPage →
// CocoaKpiStrip (elements, cost, accumulated depreciation, net book value) →
// CocoaToolbar (search + status) → CocoaSection padding none → CocoaTable of the
// register (a row opens the element: figures, configuration, run history,
// disposal entry; «Editar» patches name / coefficient / residual / start /
// useful life; «Dar de baja» posts the disposal with its 572 · 570 · 4300
// counter account) → «Nuevo elemento» drawer (category with its art. 12 LIS
// maximum, 20x/21x account picker, coefficient, cost, residual, dates) →
// «Amortización mensual» (organisation): month picker → preview with lines,
// skipped elements and `pendingPeriods` (Contabilizar disabled and the earlier
// months offered in order; 409 PREVIOUS_PERIOD_MISSING explained) → history of
// runs with the reversal of the latest one.
//
// Reads services/assetsApi.ts: listFixedAssets · getFixedAsset ·
// createFixedAsset · updateFixedAsset · disposeFixedAsset ·
// previewDepreciationRun · postDepreciationRun · listDepreciationRuns ·
// reverseDepreciationRun; the account picker reads GET /accounting/chart.

import { useMemo, useState, type CSSProperties } from "react";
import type { DisposeFixedAssetRequest, FixedAssetCategory, FixedAssetPatchRequest, FixedAssetStatus } from "@hotelos/shared";
import { FIXED_ASSET_CATEGORIES, FIXED_ASSET_MAX_COEFFICIENT_PCT } from "@hotelos/shared";
import {
  createFixedAsset,
  disposeFixedAsset,
  getFixedAsset,
  listDepreciationRuns,
  listFixedAssets,
  postDepreciationRun,
  previewDepreciationRun,
  reverseDepreciationRun,
  updateFixedAsset,
  type DepreciationRunDto,
  type FixedAssetDetailDto,
  type FixedAssetDto,
  type FixedAssetRequest
} from "../../services/assetsApi";
import { getActivePropertyId, getActivePropertyName } from "../../services/activeProperty";
import { useToast } from "../../components/Toast";
import { useTabHost } from "../tabs/TabHost";
import { date, dateTime, money, percent, plural, toNumber } from "../../lib/format";
import { ACTIONS, FIELD_LABELS, STATUS_LABELS, newLabel } from "../../content/actions";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDatePicker,
  CocoaDialog,
  CocoaDrawer,
  CocoaField,
  CocoaFormRow,
  CocoaFormSection,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSearchInput,
  CocoaSection,
  CocoaSelect,
  CocoaStat,
  CocoaState,
  CocoaTable,
  CocoaToolbar,
  type CocoaTableColumn
} from "../../components/cocoa";
import {
  ASSET_CATEGORY_LABELS,
  ASSET_STATUS_LABELS,
  ASSET_STATUS_TONES,
  RUN_STATUS_LABELS,
  RUN_STATUS_TONES,
  accountLabel,
  accountOptions,
  amountOf,
  decimalInput,
  describeFailure,
  isInvestmentAccount,
  PERIOD_PATTERN,
  maxCoefficientLabel,
  periodLabel,
  previousMonthPeriod,
  todayIso,
  useChartAccounts,
  useLoader
} from "./payables-shared";

// Secondary line under a cell value: caption secondary.
const subStyle: CSSProperties = {
  display: "block",
  fontSize: "var(--cocoa-fs-caption)",
  fontWeight: "var(--cocoa-fw-regular)" as CSSProperties["fontWeight"],
  color: "var(--cocoa-label-secondary)"
};
// Label of a detail row.
const mutedStyle: CSSProperties = { color: "var(--cocoa-label-secondary)" };
// A form-row cell that holds a button: sit it at the end of the track so it shares the inputs' baseline.
const bottomAligned: CSSProperties = { display: "flex", alignItems: "flex-end", alignSelf: "end", minWidth: 0 };

const PROPERTY_ID = getActivePropertyId();

const STATUS_OPTIONS = (["active", "fully_depreciated", "disposed"] as FixedAssetStatus[]).map((value) => ({ value, label: ASSET_STATUS_LABELS[value] }));
const CATEGORY_OPTIONS = FIXED_ASSET_CATEGORIES.map((value) => ({ value, label: `${ASSET_CATEGORY_LABELS[value]} · máx. ${maxCoefficientLabel(value)}` }));
// 4300 is the ONE customer sub-account every writer uses (fixed-assets.service.ts disposeSchema).
type DisposalCounterAccount = NonNullable<DisposeFixedAssetRequest["counterAccountCode"]>;
const COUNTER_OPTIONS: Array<{ value: DisposalCounterAccount; label: string }> = [
  { value: "572", label: "572 · Bancos (cobro por banco)" },
  { value: "570", label: "570 · Caja (cobro en efectivo)" },
  { value: "4300", label: "4300 · Clientes (pendiente de cobro)" }
];

type AssetForm = {
  name: string;
  category: FixedAssetCategory | "";
  accountCode: string;
  coefficientPct: string;
  acquisitionDate: string;
  startDate: string;
  acquisitionCost: string;
  residualValue: string;
  usefulLifeMonths: string;
};

function emptyForm(): AssetForm {
  return { name: "", category: "", accountCode: "", coefficientPct: "", acquisitionDate: todayIso(), startDate: "", acquisitionCost: "", residualValue: "", usefulLifeMonths: "" };
}

function formOf(asset: FixedAssetDto): AssetForm {
  return {
    name: asset.name,
    category: asset.category ?? "",
    accountCode: asset.accountCode ?? "",
    coefficientPct: asset.coefficientPct ? String(toNumber(asset.coefficientPct) ?? "") : "",
    acquisitionDate: asset.acquisitionDate ?? "",
    startDate: asset.startDate && asset.startDate !== asset.acquisitionDate ? asset.startDate : "",
    acquisitionCost: asset.acquisitionCost,
    residualValue: toNumber(asset.residualValue) ? asset.residualValue : "",
    usefulLifeMonths: asset.usefulLifeMonths === null ? "" : String(asset.usefulLifeMonths)
  };
}

type FieldErrors = Partial<Record<keyof AssetForm, string>>;

function validate(form: AssetForm, mode: "new" | "edit"): FieldErrors {
  const errors: FieldErrors = {};
  if (!form.name.trim()) errors.name = "El nombre es obligatorio.";
  if (mode === "new") {
    if (!form.category) errors.category = "Elige la categoría del elemento.";
    if (form.accountCode.trim() && !isInvestmentAccount(form.accountCode.trim())) errors.accountCode = "La cuenta debe ser 20x o 21x.";
    if (!form.acquisitionDate) errors.acquisitionDate = "Indica la fecha de adquisición.";
    const cost = decimalInput(form.acquisitionCost);
    if (cost === null || Number(cost) <= 0) errors.acquisitionCost = "Importe mayor que cero con dos decimales como máximo.";
  }
  if (form.coefficientPct.trim()) {
    const coefficient = decimalInput(form.coefficientPct);
    const max = form.category ? Number(FIXED_ASSET_MAX_COEFFICIENT_PCT[form.category]) : 100;
    if (coefficient === null || Number(coefficient) <= 0) errors.coefficientPct = "Porcentaje anual mayor que cero.";
    else if (Number(coefficient) > max) errors.coefficientPct = `Supera el máximo de tablas para ${form.category ? ASSET_CATEGORY_LABELS[form.category].toLowerCase() : "la categoría"} (${percent(max, { maximumFractionDigits: 0 })}).`;
  }
  if (form.residualValue.trim()) {
    const residual = decimalInput(form.residualValue);
    if (residual === null || Number(residual) < 0) errors.residualValue = "Importe con dos decimales como máximo.";
    else if (mode === "new" && Number(residual) > amountOf(form.acquisitionCost)) errors.residualValue = "No puede superar el coste de adquisición.";
  }
  if (form.startDate && form.acquisitionDate && form.startDate < form.acquisitionDate) errors.startDate = "No puede ser anterior a la adquisición.";
  if (form.usefulLifeMonths.trim()) {
    const months = Number(form.usefulLifeMonths.trim());
    if (!Number.isInteger(months) || months < 1 || months > 1200) errors.usefulLifeMonths = "Entre 1 y 1200 meses.";
  }
  return errors;
}

function createBody(form: AssetForm): FixedAssetRequest {
  const coefficient = form.coefficientPct.trim() ? decimalInput(form.coefficientPct) : null;
  const residual = form.residualValue.trim() ? decimalInput(form.residualValue) : null;
  return {
    name: form.name.trim(),
    ...(form.category ? { category: form.category } : {}),
    ...(form.accountCode.trim() ? { accountCode: form.accountCode.trim() } : {}),
    acquisitionDate: form.acquisitionDate,
    ...(form.startDate ? { startDate: form.startDate } : {}),
    acquisitionCost: decimalInput(form.acquisitionCost) ?? "0.00",
    ...(residual ? { residualValue: residual } : {}),
    ...(coefficient ? { coefficientPct: coefficient } : {}),
    ...(form.usefulLifeMonths.trim() ? { usefulLifeMonths: Number(form.usefulLifeMonths.trim()) } : {})
  };
}

function patchBody(form: AssetForm, asset: FixedAssetDto): FixedAssetPatchRequest {
  const body: FixedAssetPatchRequest = {};
  if (form.name.trim() !== asset.name) body.name = form.name.trim();
  const coefficient = form.coefficientPct.trim() ? decimalInput(form.coefficientPct) : null;
  if (coefficient && coefficient !== asset.coefficientPct) body.coefficientPct = coefficient;
  const residual = form.residualValue.trim() ? decimalInput(form.residualValue) : "0.00";
  if (residual && residual !== asset.residualValue) body.residualValue = residual;
  const start = form.startDate || null;
  if (start !== null && start !== asset.startDate) body.startDate = start;
  const months = form.usefulLifeMonths.trim() ? Number(form.usefulLifeMonths.trim()) : null;
  if (months !== asset.usefulLifeMonths) body.usefulLifeMonths = months;
  return body;
}

const COLUMNS: CocoaTableColumn<FixedAssetDto>[] = [
  {
    key: "name",
    label: "Elemento",
    render: (a) => (
      <>
        <strong>{a.name}</strong>
        <span style={subStyle}>{a.category ? ASSET_CATEGORY_LABELS[a.category] : "Sin categoría"}{a.accountCode ? ` · ${a.accountCode}` : ""}</span>
      </>
    )
  },
  { key: "acquisitionDate", label: "Adquisición", hideOnNarrow: true, render: (a) => date(a.acquisitionDate) },
  { key: "coefficientPct", label: "Coeficiente", align: "right", hideOnNarrow: true, render: (a) => (a.coefficientPct ? `${percent(a.coefficientPct)} anual` : "—") },
  { key: "acquisitionCost", label: "Coste", align: "right", hideOnNarrow: true, render: (a) => money(a.acquisitionCost) },
  { key: "accumulatedDepreciation", label: "Amortizado", align: "right", hideOnNarrow: true, render: (a) => money(a.accumulatedDepreciation) },
  { key: "netBookValue", label: "Valor neto", align: "right", render: (a) => <strong>{money(a.netBookValue)}</strong> },
  {
    key: "status",
    label: FIELD_LABELS.status,
    render: (a) => (
      <span className="cocoa-cluster">
        <CocoaBadge tone={ASSET_STATUS_TONES[a.status]}>{ASSET_STATUS_LABELS[a.status]}</CocoaBadge>
        {!a.depreciable && a.status === "active" ? (
          <CocoaBadge tone="warning" size="small" title="Sin categoría, coeficiente o cuentas: la corrida mensual lo omite">
            Sin configurar
          </CocoaBadge>
        ) : null}
      </span>
    )
  }
];

const PREVIEW_COLUMNS: CocoaTableColumn<DepreciationRunDto["lines"][number]>[] = [
  {
    key: "name",
    label: "Elemento",
    render: (l) => (
      <>
        {l.name}
        <span style={subStyle}>{l.propertyId === PROPERTY_ID ? "Esta propiedad" : "Otra propiedad de la organización"}</span>
      </>
    )
  },
  { key: "accounts", label: "Cuentas", hideOnNarrow: true, render: (l) => `D ${l.expenseAccountCode ?? "—"} · H ${l.depreciationAccountCode ?? "—"}` },
  { key: "amount", label: "Cuota del mes", align: "right", render: (l) => <strong>{money(l.amount)}</strong> },
  { key: "accumulatedAfter", label: "Acumulado", align: "right", hideOnNarrow: true, render: (l) => money(l.accumulatedAfter) },
  { key: "netBookValueAfter", label: "Valor neto", align: "right", hideOnNarrow: true, render: (l) => money(l.netBookValueAfter) }
];

const RUN_COLUMNS: CocoaTableColumn<DepreciationRunDto>[] = [
  { key: "period", label: "Mes", render: (r) => periodLabel(r.period) },
  { key: "status", label: FIELD_LABELS.status, render: (r) => <CocoaBadge tone={RUN_STATUS_TONES[r.status] ?? "neutral"}>{RUN_STATUS_LABELS[r.status] ?? r.status}</CocoaBadge> },
  { key: "lines", label: "Elementos", align: "right", hideOnNarrow: true, render: (r) => r.lines.length },
  { key: "totalAmount", label: FIELD_LABELS.amount, align: "right", render: (r) => <strong>{money(r.totalAmount)}</strong> },
  { key: "createdAt", label: "Contabilizada", hideOnNarrow: true, render: (r) => dateTime(r.createdAt) }
];

type AssetFieldsProps = {
  form: AssetForm;
  mode: "new" | "edit";
  errors: FieldErrors;
  disabled: boolean;
  accountOptionsList: Array<{ value: string; label: string }>;
  chartError: string | null;
  onChange: <K extends keyof AssetForm>(key: K, value: AssetForm[K]) => void;
};

/** Element form shared by the create drawer and the edit mode of the detail drawer. */
function AssetFields({ form, mode, errors, disabled, accountOptionsList, chartError, onChange }: AssetFieldsProps) {
  const maxLabel = form.category ? maxCoefficientLabel(form.category) : null;
  return (
    <>
      <CocoaFormSection title="Elemento" description={mode === "new" ? "La categoría fija el coeficiente máximo de las tablas del artículo 12 de la Ley del Impuesto sobre Sociedades y propone la cuenta 20x/21x." : undefined}>
        <CocoaFormRow columns={2}>
          <CocoaField label={FIELD_LABELS.name} required error={errors.name} fullWidth>
            <CocoaInput value={form.name} onChange={(v) => onChange("name", v)} placeholder="Lavadora industrial 25 kg" maxLength={200} disabled={disabled} />
          </CocoaField>
          {mode === "new" ? (
            <>
              <CocoaField label="Categoría" required error={errors.category}>
                <CocoaSelect value={form.category} onChange={(v) => onChange("category", v as FixedAssetCategory | "")} options={CATEGORY_OPTIONS} placeholder="Elige la categoría" disabled={disabled} />
              </CocoaField>
              <CocoaField label="Cuenta del inmovilizado" error={errors.accountCode} hint={STATUS_LABELS.optional.toLowerCase()} help={chartError ?? "Si no la indicas se usa la habitual de la categoría."}>
                {accountOptionsList.length > 0 ? (
                  <CocoaSelect value={form.accountCode} onChange={(v) => onChange("accountCode", v)} options={[{ value: "", label: "La habitual de la categoría" }, ...accountOptionsList]} disabled={disabled} />
                ) : (
                  <CocoaInput value={form.accountCode} onChange={(v) => onChange("accountCode", v)} placeholder="216" maxLength={12} disabled={disabled} />
                )}
              </CocoaField>
            </>
          ) : null}
          <CocoaField label="Coeficiente anual (%)" error={errors.coefficientPct} hint={STATUS_LABELS.optional.toLowerCase()} help={maxLabel ? `Máximo ${maxLabel}; vacío = el de tablas para la cuenta.` : "Vacío = el de tablas para la cuenta."}>
            <CocoaInput value={form.coefficientPct} onChange={(v) => onChange("coefficientPct", v)} inputMode="decimal" placeholder={form.category ? String(FIXED_ASSET_MAX_COEFFICIENT_PCT[form.category]) : "10"} disabled={disabled} />
          </CocoaField>
          <CocoaField label="Vida útil (meses)" error={errors.usefulLifeMonths} hint={STATUS_LABELS.optional.toLowerCase()}>
            <CocoaInput value={form.usefulLifeMonths} onChange={(v) => onChange("usefulLifeMonths", v)} inputMode="numeric" placeholder="120" disabled={disabled} />
          </CocoaField>
        </CocoaFormRow>
      </CocoaFormSection>
      <CocoaFormSection title="Valor y fechas">
        <CocoaFormRow columns={2}>
          {mode === "new" ? (
            <>
              <CocoaField label="Coste de adquisición" required error={errors.acquisitionCost}>
                <CocoaInput value={form.acquisitionCost} onChange={(v) => onChange("acquisitionCost", v)} inputMode="decimal" placeholder="2400,00" disabled={disabled} />
              </CocoaField>
              <CocoaField label="Fecha de adquisición" required error={errors.acquisitionDate}>
                <CocoaDatePicker value={form.acquisitionDate} onChange={(v) => onChange("acquisitionDate", v)} max={todayIso()} disabled={disabled} />
              </CocoaField>
            </>
          ) : null}
          <CocoaField label="Valor residual" error={errors.residualValue} hint={STATUS_LABELS.optional.toLowerCase()} help="Parte del coste que no se amortiza.">
            <CocoaInput value={form.residualValue} onChange={(v) => onChange("residualValue", v)} inputMode="decimal" placeholder="0,00" disabled={disabled} />
          </CocoaField>
          <CocoaField label="Inicio de la amortización" error={errors.startDate} hint={STATUS_LABELS.optional.toLowerCase()} help="Vacío = desde la adquisición (puesta en funcionamiento).">
            <CocoaDatePicker value={form.startDate} onChange={(v) => onChange("startDate", v)} min={form.acquisitionDate || undefined} disabled={disabled} />
          </CocoaField>
        </CocoaFormRow>
      </CocoaFormSection>
    </>
  );
}

export function FixedAssetsScreen() {
  const hosted = useTabHost() !== null;
  const { showToast } = useToast();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const assets = useLoader(() => listFixedAssets({ q: search.trim() || undefined, status: (status || undefined) as FixedAssetStatus | undefined, limit: 500 }), `${search}|${status}`, "No se pudo cargar el registro de inmovilizado.");
  const chart = useChartAccounts();
  const investmentOptions = useMemo(() => accountOptions(chart.accounts, isInvestmentAccount), [chart.accounts]);

  // Detail drawer (+ edit mode + disposal)
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detail = useLoader<FixedAssetDetailDto | null>(() => (selectedId ? getFixedAsset(selectedId) : Promise.resolve(null)), selectedId ?? "", "No se pudo cargar el elemento.");
  const [editMode, setEditMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionFailure, setActionFailure] = useState<string | null>(null);
  const [askDispose, setAskDispose] = useState(false);
  const [disposeDate, setDisposeDate] = useState(todayIso());
  const [saleAmount, setSaleAmount] = useState("");
  const [counterAccount, setCounterAccount] = useState<DisposalCounterAccount>("572");
  const [disposeReason, setDisposeReason] = useState("");
  const [disposeError, setDisposeError] = useState<string | undefined>(undefined);

  // Create drawer and edit form
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<AssetForm>(emptyForm);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailure, setSaveFailure] = useState<string | null>(null);

  // Depreciation (organisation)
  const [period, setPeriod] = useState(previousMonthPeriod());
  const periodValid = PERIOD_PATTERN.test(period);
  const preview = useLoader<DepreciationRunDto | null>(() => (periodValid ? previewDepreciationRun(period) : Promise.resolve(null)), periodValid ? period : "", "No se pudo calcular la vista previa de la amortización.");
  const runs = useLoader(() => listDepreciationRuns(24), "runs", "No se pudo cargar el historial de corridas.");
  const [askPost, setAskPost] = useState(false);
  const [runFailure, setRunFailure] = useState<string | null>(null);
  const [runBusy, setRunBusy] = useState(false);
  const [reverseRun, setReverseRun] = useState<DepreciationRunDto | null>(null);
  const [reverseReason, setReverseReason] = useState("");
  const [reverseError, setReverseError] = useState<string | undefined>(undefined);

  const rows = assets.data ?? [];
  const selected = detail.data;
  const mode: "new" | "edit" = creating ? "new" : "edit";
  const errors = validate(form, mode);
  const valid = Object.keys(errors).length === 0;
  const newAssetLabel = newLabel("m", "elemento");
  const live = rows.filter((a) => a.status !== "disposed");
  const kpis = {
    count: live.length,
    cost: live.reduce((sum, a) => sum + (toNumber(a.acquisitionCost) ?? 0), 0),
    accumulated: live.reduce((sum, a) => sum + (toNumber(a.accumulatedDepreciation) ?? 0), 0),
    nbv: live.reduce((sum, a) => sum + (toNumber(a.netBookValue) ?? 0), 0),
    unconfigured: live.filter((a) => !a.depreciable).length
  };
  const runRows = runs.data ?? [];
  const latestPosted = [...runRows].filter((r) => r.status === "posted").sort((a, b) => b.period.localeCompare(a.period))[0] ?? null;
  const previewData = preview.data;
  const pending = previewData?.pendingPeriods ?? [];
  const canPost = Boolean(previewData && !previewData.alreadyPosted && pending.length === 0 && previewData.lines.length > 0 && periodValid && !runBusy);

  function refreshAll() {
    assets.refresh();
    if (selectedId) detail.refresh();
    preview.refresh();
    runs.refresh();
  }

  function set<K extends keyof AssetForm>(key: K, value: AssetForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function openNew() {
    setForm(emptyForm());
    setTouched(false);
    setSaveFailure(null);
    setCreating(true);
  }

  function openDetail(asset: FixedAssetDto) {
    setActionFailure(null);
    setEditMode(false);
    setSelectedId(asset.id);
  }

  function startEdit() {
    if (!selected) return;
    setForm(formOf(selected));
    setTouched(false);
    setSaveFailure(null);
    setEditMode(true);
  }

  async function saveNew() {
    if (saving) return;
    setTouched(true);
    if (!valid) return;
    setSaving(true);
    setSaveFailure(null);
    try {
      const created = await createFixedAsset(createBody(form));
      showToast(`Elemento ${created.name} registrado.`, { variant: "success" });
      setCreating(false);
      refreshAll();
      setSelectedId(created.id);
    } catch (error: unknown) {
      setSaveFailure(describeFailure(error, "No se pudo registrar el elemento. Revisa los datos e inténtalo de nuevo.").message);
    } finally {
      setSaving(false);
    }
  }

  async function saveEdit() {
    if (saving || !selected) return;
    setTouched(true);
    if (!valid) return;
    const body = patchBody(form, selected);
    if (Object.keys(body).length === 0) {
      setEditMode(false);
      return;
    }
    setSaving(true);
    setSaveFailure(null);
    try {
      await updateFixedAsset(selected.id, body);
      showToast("Elemento actualizado.", { variant: "success" });
      setEditMode(false);
      refreshAll();
    } catch (error: unknown) {
      setSaveFailure(describeFailure(error, "No se pudo guardar el elemento.").message);
    } finally {
      setSaving(false);
    }
  }

  function openDispose() {
    setDisposeDate(todayIso());
    setSaleAmount("");
    setCounterAccount("572");
    setDisposeReason("");
    setDisposeError(undefined);
    setAskDispose(true);
  }

  async function confirmDispose() {
    if (!selected) return;
    if (!disposeDate) {
      setDisposeError("Indica la fecha de la baja.");
      return;
    }
    const sale = saleAmount.trim() ? decimalInput(saleAmount) : null;
    if (saleAmount.trim() && sale === null) {
      setDisposeError("Importe de venta con dos decimales como máximo.");
      return;
    }
    setBusy(true);
    setActionFailure(null);
    try {
      const body = { date: disposeDate, ...(sale ? { saleAmount: sale } : {}), counterAccountCode: counterAccount, ...(disposeReason.trim() ? { reason: disposeReason.trim() } : {}) };
      await disposeFixedAsset(selected.id, body);
      showToast("Elemento dado de baja: asiento de baja contabilizado.", { variant: "success" });
      setAskDispose(false);
      refreshAll();
    } catch (error: unknown) {
      setActionFailure(describeFailure(error, "No se pudo dar de baja el elemento.").message);
      setAskDispose(false);
    } finally {
      setBusy(false);
    }
  }

  async function confirmPostRun() {
    if (!periodValid) return;
    setRunBusy(true);
    setRunFailure(null);
    try {
      const run = await postDepreciationRun({ period });
      showToast(run.alreadyPosted ? `La amortización de ${periodLabel(period)} ya estaba contabilizada.` : `Amortización de ${periodLabel(period)} contabilizada: ${money(run.totalAmount)}.`, { variant: "success" });
      setAskPost(false);
      refreshAll();
    } catch (error: unknown) {
      setRunFailure(describeFailure(error, "No se pudo contabilizar la amortización.").message);
      setAskPost(false);
      preview.refresh();
    } finally {
      setRunBusy(false);
    }
  }

  async function confirmReverseRun() {
    const text = reverseReason.trim();
    if (text.length < 3) {
      setReverseError("Indica el motivo (al menos 3 caracteres).");
      return;
    }
    if (!reverseRun?.id) return;
    setRunBusy(true);
    setRunFailure(null);
    try {
      await reverseDepreciationRun(reverseRun.id, { reason: text });
      showToast(`Corrida de ${periodLabel(reverseRun.period)} revertida.`, { variant: "success" });
      setReverseRun(null);
      setReverseReason("");
      refreshAll();
    } catch (error: unknown) {
      setRunFailure(describeFailure(error, "No se pudo revertir la corrida.").message);
      setReverseRun(null);
    } finally {
      setRunBusy(false);
    }
  }

  const ready = !assets.loading && !assets.error && rows.length > 0;
  const filtered = Boolean(search || status);
  const shownErrors: FieldErrors = touched ? errors : {};

  let body;
  if (assets.loading && rows.length === 0) {
    body = <CocoaTable columns={COLUMNS} rows={[]} loading aria-label="Inmovilizado" />;
  } else if (assets.error) {
    body = <CocoaState kind="error" title="No se pudo cargar el inmovilizado" message={assets.error} onRetry={assets.refresh} />;
  } else if (rows.length === 0) {
    body = (
      <CocoaState
        kind="empty"
        illustration={filtered ? "search" : "box"}
        title={filtered ? STATUS_LABELS.noResults : "Aún no hay elementos de inmovilizado"}
        message={filtered ? "Ningún elemento coincide con los filtros." : "Registra mobiliario, instalaciones, equipos o vehículos con su categoría y coeficiente para amortizarlos mes a mes."}
        primaryAction={{ label: newAssetLabel, onClick: openNew }}
      />
    );
  } else {
    body = <CocoaTable columns={COLUMNS} rows={rows} rowKey="id" selectedKey={selectedId ?? undefined} onSelect={openDetail} rowTone={(a) => (a.status === "disposed" ? "neutral" : !a.depreciable ? "warning" : undefined)} caption="Registro de inmovilizado" aria-label="Registro de inmovilizado" />;
  }

  return (
    <CocoaPage
      eyebrow={`Finanzas · ${getActivePropertyName()}`}
      title="Inmovilizado"
      subtitle={hosted ? undefined : "Elementos del inmovilizado de la propiedad, coeficientes de amortización y corridas mensuales sin huecos para toda la organización."}
      actions={
        <CocoaButton variant="filled" tone="accent" size={hosted ? "small" : "regular"} onClick={openNew}>
          {newAssetLabel}
        </CocoaButton>
      }
      commands={[
        { id: "fixed-assets-new", label: newAssetLabel, run: openNew },
        { id: "fixed-assets-refresh", label: "Actualizar inmovilizado", run: refreshAll }
      ]}
    >
      <CocoaKpiStrip min={200} aria-label="Resumen del inmovilizado">
        <CocoaKpi label="Elementos" value={assets.data ? kpis.count : "—"} unit={kpis.unconfigured > 0 ? `${kpis.unconfigured} sin configurar` : undefined} status={kpis.unconfigured > 0 ? "warning" : undefined} degraded={Boolean(assets.error)} />
        <CocoaKpi label="Coste de adquisición" value={assets.data ? money(kpis.cost) : "—"} degraded={Boolean(assets.error)} />
        <CocoaKpi label="Amortización acumulada" value={assets.data ? money(kpis.accumulated) : "—"} degraded={Boolean(assets.error)} />
        <CocoaKpi label="Valor neto contable" value={assets.data ? money(kpis.nbv) : "—"} degraded={Boolean(assets.error)} />
      </CocoaKpiStrip>

      <CocoaToolbar
        variant="content"
        aria-label="Filtros del inmovilizado"
        leftSlot={<CocoaSearchInput value={search} onChange={setSearch} debounceMs={250} placeholder="Nombre del elemento…" aria-label="Buscar elementos por nombre" />}
        rightSlot={<CocoaSelect value={status} onChange={setStatus} size="small" aria-label="Filtrar por estado" options={[{ value: "", label: "Todos los estados" }, ...STATUS_OPTIONS]} />}
      />

      <CocoaSection padding={ready ? "none" : "md"} style={{ overflow: "clip" }} aria-label="Registro de inmovilizado" footer={ready ? <span>{plural(rows.length, "elemento", "elementos")}</span> : undefined}>
        {body}
      </CocoaSection>

      {/* Monthly depreciation (organisation) */}
      <CocoaSection title="Amortización mensual" meta="toda la organización" aria-label="Amortización mensual">
        <div className="cocoa-stack" data-gap="3">
          <CocoaFormRow columns={4} min={160}>
            <CocoaField label="Mes" help="Las corridas van mes a mes, sin huecos.">
              <CocoaInput value={period} onChange={setPeriod} type="month" max={todayIso().slice(0, 7)} disabled={runBusy} />
            </CocoaField>
            <CocoaStat label="Cuota del mes" value={previewData ? money(previewData.totalAmount) : "—"} hint={previewData ? plural(previewData.lines.length, "elemento", "elementos") : undefined} />
            <CocoaStat label="Última corrida" value={latestPosted ? periodLabel(latestPosted.period) : "ninguna"} tabular={false} hint={latestPosted ? money(latestPosted.totalAmount) : undefined} />
            <div style={bottomAligned}>
              <CocoaButton variant="filled" tone="accent" disabled={!canPost} onClick={() => setAskPost(true)} title={pending.length > 0 ? `Antes hay que contabilizar ${pending.map(periodLabel).join(", ")}` : undefined}>
                Contabilizar {periodValid ? periodLabel(period) : "el mes"}
              </CocoaButton>
            </div>
          </CocoaFormRow>

          {runFailure ? (
            <CocoaCallout tone="danger" role="alert" title="No se pudo contabilizar">
              {runFailure}
            </CocoaCallout>
          ) : null}
          {!periodValid ? <CocoaCallout tone="warning">El mes debe tener el formato año-mes (por ejemplo 2026-08).</CocoaCallout> : null}
          {preview.error ? (
            <CocoaState kind="error" inline title={preview.error} onRetry={preview.refresh} />
          ) : preview.loading && !previewData ? (
            <CocoaState kind="loading" inline title={STATUS_LABELS.loading} />
          ) : previewData ? (
            <>
              {previewData.alreadyPosted ? (
                <CocoaCallout tone="info" title={`${periodLabel(period)} ya está contabilizado`}>
                  Para modificarlo, revierte la corrida desde el historial y vuelve a contabilizar.
                </CocoaCallout>
              ) : null}
              {pending.length > 0 ? (
                <CocoaCallout
                  tone="warning"
                  role="status"
                  title="Faltan meses anteriores"
                  actions={
                    <span className="cocoa-cluster">
                      {pending.map((p) => (
                        <CocoaButton key={p} variant="bordered" tone="neutral" size="small" onClick={() => setPeriod(p)} disabled={runBusy}>
                          {periodLabel(p)}
                        </CocoaButton>
                      ))}
                    </span>
                  }
                >
                  Contabiliza antes, en este orden: {pending.map(periodLabel).join(", ")}.
                </CocoaCallout>
              ) : null}
              {previewData.lines.length === 0 ? (
                <CocoaState kind="empty" inline title={`Nada que amortizar en ${periodLabel(period)}.`} />
              ) : (
                <CocoaTable columns={PREVIEW_COLUMNS} rows={previewData.lines} rowKey="fixedAssetId" footer={{ name: plural(previewData.lines.length, "elemento", "elementos"), amount: <strong>{money(previewData.totalAmount)}</strong> }} caption="Vista previa de la amortización" aria-label="Vista previa de la amortización" />
              )}
              {previewData.skipped.length > 0 ? (
                <CocoaCallout tone="neutral" title={`${plural(previewData.skipped.length, "elemento omitido", "elementos omitidos")}`}>
                  <ul className="c22-section__list" aria-label="Elementos omitidos">
                    {previewData.skipped.map((s) => (
                      <li key={s.fixedAssetId}>
                        <span>{s.name}</span>
                        <span style={mutedStyle}>{s.reason}</span>
                      </li>
                    ))}
                  </ul>
                </CocoaCallout>
              ) : null}
            </>
          ) : null}
        </div>
      </CocoaSection>

      <CocoaSection title="Historial de corridas" meta={runRows.length > 0 ? plural(runRows.length, "corrida", "corridas") : undefined} padding={runRows.length > 0 ? "none" : "md"} style={{ overflow: "clip" }} aria-label="Historial de corridas">
        {runs.error ? (
          <CocoaState kind="error" title="No se pudo cargar el historial" message={runs.error} onRetry={runs.refresh} />
        ) : runs.loading && runRows.length === 0 ? (
          <CocoaTable columns={RUN_COLUMNS} rows={[]} loading aria-label="Corridas de amortización" />
        ) : runRows.length === 0 ? (
          <CocoaState kind="empty" inline title="Ninguna corrida contabilizada todavía." />
        ) : (
          <CocoaTable
            columns={RUN_COLUMNS}
            rows={runRows}
            rowKey={(r) => r.id ?? r.period}
            rowActions={(r) =>
              latestPosted && r.id === latestPosted.id ? (
                <CocoaButton
                  variant="plain"
                  tone="destructive"
                  size="small"
                  disabled={runBusy}
                  onClick={(event) => {
                    event.stopPropagation();
                    setReverseReason("");
                    setReverseError(undefined);
                    setReverseRun(r);
                  }}
                >
                  {ACTIONS.revert}
                </CocoaButton>
              ) : null
            }
            caption="Corridas de amortización"
            aria-label="Corridas de amortización"
          />
        )}
      </CocoaSection>

      {/* Detail drawer */}
      <CocoaDrawer
        open={selectedId !== null}
        onClose={() => (busy || saving ? undefined : setSelectedId(null))}
        title={selected ? selected.name : "Elemento"}
        subtitle={selected ? `${selected.category ? ASSET_CATEGORY_LABELS[selected.category] : "Sin categoría"} · ${ASSET_STATUS_LABELS[selected.status]}` : undefined}
        side="right"
        size="lg"
        dismissible={!busy && !saving}
        footer={
          editMode ? (
            <>
              <CocoaButton variant="bordered" tone="neutral" onClick={() => setEditMode(false)} disabled={saving}>
                {ACTIONS.cancel}
              </CocoaButton>
              <CocoaButton variant="filled" tone="accent" onClick={() => void saveEdit()} loading={saving} disabled={saving || (touched && !valid)}>
                {ACTIONS.saveChanges}
              </CocoaButton>
            </>
          ) : (
            <>
              <CocoaButton variant="bordered" tone="neutral" onClick={() => setSelectedId(null)} disabled={busy}>
                {ACTIONS.close}
              </CocoaButton>
              {selected && selected.status !== "disposed" ? (
                <CocoaButton variant="filled" tone="accent" onClick={startEdit} disabled={busy}>
                  {ACTIONS.edit}
                </CocoaButton>
              ) : null}
            </>
          )
        }
      >
        {detail.loading && !selected ? (
          <CocoaState kind="loading" title={STATUS_LABELS.loading} />
        ) : detail.error ? (
          <CocoaState kind="error" title="No se pudo cargar el elemento" message={detail.error} onRetry={detail.refresh} />
        ) : selected && editMode ? (
          <div className="cocoa-stack" data-gap="4">
            {saveFailure ? (
              <CocoaCallout tone="danger" role="alert" title="No se pudo guardar">
                {saveFailure}
              </CocoaCallout>
            ) : null}
            {selected.history.length > 0 ? <CocoaCallout tone="info">El elemento ya tiene amortización contabilizada: el nuevo coeficiente se aplica a las corridas futuras.</CocoaCallout> : null}
            <AssetFields form={form} mode="edit" errors={shownErrors} disabled={saving} accountOptionsList={investmentOptions} chartError={chart.error} onChange={set} />
          </div>
        ) : selected ? (
          <div className="cocoa-stack" data-gap="4">
            {actionFailure ? (
              <CocoaCallout tone="danger" role="alert">
                {actionFailure}
              </CocoaCallout>
            ) : null}
            {!selected.depreciable && selected.status !== "disposed" ? (
              <CocoaCallout tone="warning" title="Sin configurar para amortizar">
                Le falta categoría, coeficiente o cuentas y la corrida mensual lo omite. La categoría y la cuenta no se pueden cambiar después del alta: registra el elemento de nuevo con ellas y da de baja este.
              </CocoaCallout>
            ) : null}
            {selected.status === "disposed" ? (
              <CocoaCallout tone="neutral" title="Dado de baja">
                Baja el {date(selected.disposedAt)}{selected.disposalEntry ? ` · asiento nº ${selected.disposalEntry.entryNumber ?? "—"}` : ""}.
              </CocoaCallout>
            ) : null}

            <div className="cocoa-row" data-gap="2" data-justify="between">
              <span className="cocoa-cluster">
                <CocoaBadge tone={ASSET_STATUS_TONES[selected.status]}>{ASSET_STATUS_LABELS[selected.status]}</CocoaBadge>
                {selected.supplierBillId ? <CocoaBadge tone="info">Desde factura recibida</CocoaBadge> : null}
              </span>
              {selected.status !== "disposed" ? (
                <CocoaButton variant="bordered" tone="destructive" size="small" onClick={openDispose} disabled={busy}>
                  Dar de baja
                </CocoaButton>
              ) : null}
            </div>

            <CocoaFormRow columns={4} min={110}>
              <CocoaStat label="Coste" value={money(selected.acquisitionCost)} />
              <CocoaStat label="Amortizado" value={money(selected.accumulatedDepreciation)} />
              <CocoaStat label="Valor neto" value={money(selected.netBookValue)} size="large" />
              <CocoaStat label="Cuota mensual" value={selected.monthlyAmount ? money(selected.monthlyAmount) : "—"} hint={selected.coefficientPct ? `${percent(selected.coefficientPct)} anual` : undefined} />
            </CocoaFormRow>

            <ul className="c22-section__list" aria-label="Configuración del elemento">
              <li>
                <span style={mutedStyle}>Cuenta del inmovilizado</span>
                <strong>{accountLabel(chart.accounts, selected.accountCode)}</strong>
              </li>
              <li>
                <span style={mutedStyle}>Amortización acumulada · gasto</span>
                <strong>{selected.depreciationAccountCode ?? "—"} · {selected.expenseAccountCode ?? "—"}</strong>
              </li>
              <li>
                <span style={mutedStyle}>Adquisición · inicio</span>
                <strong>
                  {date(selected.acquisitionDate)} · {date(selected.startDate)}
                </strong>
              </li>
              <li>
                <span style={mutedStyle}>Valor residual</span>
                <strong>{money(selected.residualValue)}</strong>
              </li>
              {selected.usefulLifeMonths !== null ? (
                <li>
                  <span style={mutedStyle}>Vida útil</span>
                  <strong>{plural(selected.usefulLifeMonths, "mes", "meses")}</strong>
                </li>
              ) : null}
              {selected.maxCoefficientPct ? (
                <li>
                  <span style={mutedStyle}>Máximo de tablas</span>
                  <strong>{percent(selected.maxCoefficientPct)} anual</strong>
                </li>
              ) : null}
            </ul>

            <CocoaSection title="Amortización contabilizada" meta={plural(selected.history.length, "mes", "meses")} headingLevel={3}>
              {selected.history.length === 0 ? (
                <CocoaState kind="empty" inline title="Ninguna corrida ha amortizado este elemento todavía." />
              ) : (
                <ul className="c22-section__list" aria-label="Historial de amortización">
                  {selected.history.map((h) => (
                    <li key={h.runId}>
                      <span>
                        {periodLabel(h.period)}
                        <span style={subStyle}>{RUN_STATUS_LABELS[h.status] ?? h.status} · acumulado {money(h.accumulatedAfter)} · valor neto {money(h.netBookValueAfter)}</span>
                      </span>
                      <strong>{money(h.amount)}</strong>
                    </li>
                  ))}
                </ul>
              )}
            </CocoaSection>

            {selected.disposalEntry ? (
              <CocoaSection title="Asiento de baja" meta={`Nº ${selected.disposalEntry.entryNumber ?? "—"} · ${date(selected.disposalEntry.entryDate)}`} headingLevel={3}>
                <ul className="c22-section__list" aria-label="Líneas del asiento de baja">
                  {selected.disposalEntry.lines.map((line) => (
                    <li key={line.id}>
                      <span>
                        {line.accountCode}
                        <span style={subStyle}>{line.description ?? ""}</span>
                      </span>
                      <strong>{toNumber(line.debit) ? `D ${money(line.debit)}` : `H ${money(line.credit)}`}</strong>
                    </li>
                  ))}
                </ul>
              </CocoaSection>
            ) : null}
          </div>
        ) : null}
      </CocoaDrawer>

      <CocoaDialog
        open={askDispose}
        onClose={() => setAskDispose(false)}
        tone="destructive"
        title={`¿Dar de baja ${selected?.name ?? "el elemento"}?`}
        description="Se asienta la baja: sale la cuenta del inmovilizado y su amortización acumulada; la diferencia con el importe de venta va a resultados (671 pérdida · 771 beneficio)."
        confirmLabel="Dar de baja"
        cancelLabel={ACTIONS.cancel}
        onConfirm={confirmDispose}
        busy={busy}
        size="md"
      >
        <CocoaFormRow columns={2} min={160}>
          <CocoaField label="Fecha de la baja" required error={disposeError}>
            <CocoaDatePicker
              value={disposeDate}
              onChange={(v) => {
                setDisposeDate(v);
                setDisposeError(undefined);
              }}
              min={selected?.acquisitionDate ?? undefined}
              max={todayIso()}
            />
          </CocoaField>
          <CocoaField label="Importe de venta" hint={STATUS_LABELS.optional.toLowerCase()} help="Vacío o cero = achatarramiento (pérdida del valor neto).">
            <CocoaInput
              value={saleAmount}
              onChange={(v) => {
                setSaleAmount(v);
                setDisposeError(undefined);
              }}
              inputMode="decimal"
              placeholder="0,00"
            />
          </CocoaField>
          <CocoaField label="Contrapartida del cobro" fullWidth>
            <CocoaSelect value={counterAccount} onChange={(v) => setCounterAccount(v as DisposalCounterAccount)} options={COUNTER_OPTIONS} />
          </CocoaField>
          <CocoaField label="Motivo" hint={STATUS_LABELS.optional.toLowerCase()} fullWidth>
            <CocoaInput value={disposeReason} onChange={setDisposeReason} placeholder="Venta, avería irreparable, robo…" maxLength={300} />
          </CocoaField>
        </CocoaFormRow>
      </CocoaDialog>

      <CocoaDialog
        open={askPost}
        onClose={() => setAskPost(false)}
        title={`¿Contabilizar la amortización de ${periodLabel(period)}?`}
        description={`Se asienta D 68x / H 28x por cada elemento, ${previewData ? money(previewData.totalAmount) : ""} en total, con fecha del último día del mes. Las corridas van mes a mes: la siguiente exigirá que esta exista.`}
        confirmLabel="Contabilizar"
        cancelLabel={ACTIONS.cancel}
        onConfirm={confirmPostRun}
        busy={runBusy}
      />

      <CocoaDialog
        open={reverseRun !== null}
        onClose={() => setReverseRun(null)}
        tone="destructive"
        title={`¿Revertir la corrida de ${reverseRun ? periodLabel(reverseRun.period) : ""}?`}
        description="Se contabiliza el asiento inverso con la fecha de hoy y los elementos recuperan su amortización acumulada. Solo se puede revertir la última corrida contabilizada."
        confirmLabel={ACTIONS.revert}
        cancelLabel={ACTIONS.cancel}
        onConfirm={confirmReverseRun}
        busy={runBusy}
      >
        <CocoaField label="Motivo" required error={reverseError}>
          <CocoaInput
            value={reverseReason}
            onChange={(v) => {
              setReverseReason(v);
              setReverseError(undefined);
            }}
            placeholder="Elemento dado de alta con coeficiente erróneo…"
            maxLength={300}
          />
        </CocoaField>
      </CocoaDialog>

      {/* New element drawer */}
      <CocoaDrawer
        open={creating}
        onClose={() => (saving ? undefined : setCreating(false))}
        title={newAssetLabel}
        subtitle="Se amortiza mes a mes desde su inicio"
        side="right"
        size="lg"
        dismissible={!saving}
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={() => setCreating(false)} disabled={saving}>
              {ACTIONS.cancel}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" onClick={() => void saveNew()} loading={saving} disabled={saving || (touched && !valid)}>
              Registrar elemento
            </CocoaButton>
          </>
        }
      >
        <div className="cocoa-stack" data-gap="4">
          {saveFailure ? (
            <CocoaCallout tone="danger" role="alert" title="No se pudo registrar">
              {saveFailure}
            </CocoaCallout>
          ) : null}
          <AssetFields form={form} mode="new" errors={shownErrors} disabled={saving} accountOptionsList={investmentOptions} chartError={chart.error} onChange={set} />
        </div>
      </CocoaDrawer>
    </CocoaPage>
  );
}

export default FixedAssetsScreen;
