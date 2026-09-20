// Tributos del activo inmobiliario — Finanzas › Activo inmobiliario › Tributos
// (Tanda ACT · lote ACT-F2, diseño docs/design/ASSET-MANAGEMENT-INMOBILIARIO.md §8).
// Nombre distinto de compliance/PropertyTaxesScreen.tsx (que es IVA).
//
// Cocoa 22 «lista / tabla»: CocoaPage → CocoaKpiStrip (carga fiscal prevista,
// recibos pendientes, pagado y vencidos del ejercicio) → CocoaSegmentedControl
// (Tributos · Recibos · Calendario) sobre un ejercicio elegible:
//   · Tributos: tabla (tipo, sujeto pasivo, autoridad, referencia, base, tipo,
//     importe previsto, periodicidad, domiciliado, estado) con «Generar previstos
//     <año>» por fila y «Nuevo tributo» (property_tax.manage).
//   · Recibos: recibos del ejercicio con estado (previsto · recibido · domiciliado
//     · pagado · recurrido · «Vencido» derivado) y el estado del asiento enlazado
//     (Borrador / Contabilizado / Anulado, CocoaBadge); la fila abre un cajón con
//     las acciones «Marcar recibido», «Marcar pagado», «Proponer asiento» (crea el
//     JournalEntry 631 en BORRADOR; deshabilitado con motivo en `title` cuando el
//     sujeto pasivo no es la sociedad, ya hay asiento o el recibo sigue previsto),
//     «Contabilizar» (solo visible con accounting.journal.post; la ruta exige
//     además ai.high_risk.confirm, sin ella queda deshabilitado con motivo),
//     «Recurrir» (referencia del recurso) y «Enlazar asiento» / «Desenlazar»
//     (journalEntryId manual, ejercicios cerrados). El 409 FISCAL_YEAR_CLOSED y
//     el resto de códigos se explican con realEstateErrorMessage.
//   · Calendario: 12 meses (CocoaGrid) con los periodos voluntarios del ejercicio:
//     recibos con ventana, periodos previstos sin recibo y eventos TAX_DUE /
//     TAX_OVERDUE del calendario municipal.
// Estados loading · empty · error con CocoaState; sin ficha del centro (404
// ASSET_NOT_FOUND) el vacío remite a la pestaña Ficha. Cero estilos en línea.
//
// Lee services/realEstateApi.ts (listPropertyTaxes · createPropertyTax ·
// generatePropertyTaxReceipts · listPropertyTaxReceipts · updatePropertyTaxReceipt ·
// proposeReceiptEntry · postProposedEntry · getPropertyTaxCalendar) y
// screens/realEstate/real-estate-helpers.ts. Los helpers puros de abajo se prueban
// en __tests__/RealEstateTaxesScreen.test.mts.

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import type { PropertyTaxKind, PropertyTaxPaidWith, PropertyTaxPeriodicity, PropertyTaxReceiptRecord, PropertyTaxReceiptStatus, PropertyTaxRecord, PropertyTaxTaxpayer } from "@hotelos/shared";
import { PROPERTY_TAX_KINDS, PROPERTY_TAX_PAID_WITH, PROPERTY_TAX_PERIODICITIES, PROPERTY_TAX_TAXPAYERS } from "@hotelos/shared";
import {
  createPropertyTax,
  generatePropertyTaxReceipts,
  getPropertyTaxCalendar,
  listPropertyTaxReceipts,
  listPropertyTaxes,
  postProposedEntry,
  proposeReceiptEntry,
  updatePropertyTaxReceipt,
  type PropertyTaxCalendar,
  type PropertyTaxReceiptListItem,
  type PropertyTaxReceiptPatchRequest,
  type PropertyTaxRequest,
  type PropertyTaxWithReceipts
} from "../../services/realEstateApi";
import { financeErrorCode, financeErrorStatus } from "../../services/finance-contracts";
import { useActiveProperty } from "../../services/activeProperty";
import { useNavGate } from "../../navigation/useEnabledModules";
import type { NavGateState } from "../../navigation/useEnabledModules";
import { canDo, todayIso } from "../accounting/accounting-ui";
import { decimalInput } from "../payables/payables-helpers";
import { useTabHost } from "../tabs/TabHost";
import { useToast } from "../../components/Toast";
import { ACTIONS, STATUS_LABELS, UI_STATES } from "../../content/actions";
import { plural, toNumber } from "../../lib/format";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaCard,
  CocoaDatePicker,
  CocoaDialog,
  CocoaDrawer,
  CocoaField,
  CocoaFormRow,
  CocoaGrid,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSegmentedControl,
  CocoaSelect,
  CocoaSpan,
  CocoaStat,
  CocoaState,
  CocoaSwitch,
  CocoaTable,
  CocoaToolbar,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";
import {
  PAID_WITH_LABELS,
  TAXPAYER_LABELS,
  TAX_KIND_LABELS,
  TAX_PERIODICITY_LABELS,
  catalogOptions,
  formatDay,
  formatMoney,
  formatPercent,
  journalEntryStatusLabel,
  journalEntryStatusTone,
  monthDayRangeLabel,
  paidWithLabel,
  realEstateErrorMessage,
  receiptStatusTone,
  receiptStatusText,
  taxKindLabel,
  taxPeriodicityLabel,
  taxStatusLabel,
  taxStatusTone,
  taxpayerLabel
} from "./real-estate-helpers";

// ---------------------------------------------------------------------------
// Pantalla
// ---------------------------------------------------------------------------

export function RealEstateTaxesScreen() {
  const hosted = useTabHost() !== null;
  const { showToast } = useToast();
  const gate = useNavGate();
  const canManageTaxes = canDo(gate, "property_tax.manage");
  const posting = postEntryGate(gate);
  const { propertyId } = useActiveProperty();

  const [year, setYear] = useState<number>(currentYear());
  const [view, setView] = useState<TaxView>("tributos");
  const key = `${propertyId}|${year}`;
  const taxes = useLoad(() => listPropertyTaxes({ year }, propertyId), key);
  const receipts = useLoad(() => listPropertyTaxReceipts({ year }, propertyId), key);
  const calendar = useLoad(() => getPropertyTaxCalendar({ year }, propertyId), key);

  const taxRows = taxes.data ?? [];
  const receiptRows = receipts.data ?? [];
  const kpis = taxKpis(taxRows, receiptRows);
  const errorCode = financeErrorCode(taxes.error);
  const errorStatus = financeErrorStatus(taxes.error);
  const noAsset = errorCode === "ASSET_NOT_FOUND";

  // Recibo abierto (cajón)
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = selectedId ? (receiptRows.find((receipt) => receipt.id === selectedId) ?? null) : null;
  const [busy, setBusy] = useState(false);
  const [actionFailure, setActionFailure] = useState<string | null>(null);
  const [paidAt, setPaidAt] = useState(todayIso());
  const [paidWith, setPaidWith] = useState<PropertyTaxPaidWith>("bank");
  const [appealRef, setAppealRef] = useState("");
  const [linkEntryId, setLinkEntryId] = useState("");
  const [askPost, setAskPost] = useState(false);

  // Alta de tributo (cajón)
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<TaxForm>(emptyTaxForm);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailure, setSaveFailure] = useState<string | null>(null);
  const formErrors = validateTaxForm(form);
  const shownErrors: TaxFormErrors = touched ? formErrors : {};

  // Generar previstos (por tributo)
  const [generating, setGenerating] = useState<string | null>(null);
  const [listFailure, setListFailure] = useState<string | null>(null);

  function refreshAll() {
    taxes.refresh();
    receipts.refresh();
    calendar.refresh();
  }

  function openReceipt(receipt: PropertyTaxReceiptListItem) {
    setActionFailure(null);
    setPaidAt(receipt.paidAt ?? todayIso());
    setPaidWith(receipt.paidWith ?? "bank");
    setAppealRef(receipt.appealRef ?? "");
    setLinkEntryId("");
    setSelectedId(receipt.id);
  }

  function closeReceipt() {
    setSelectedId(null);
    setAskPost(false);
    setActionFailure(null);
  }

  async function patchReceipt(receipt: PropertyTaxReceiptListItem, body: PropertyTaxReceiptPatchRequest, success: string) {
    if (busy) return;
    setBusy(true);
    setActionFailure(null);
    setListFailure(null);
    try {
      await updatePropertyTaxReceipt(receipt.id, body, propertyId);
      showToast(success, { variant: "success" });
      refreshAll();
    } catch (error: unknown) {
      const message = taxFailureMessage(error, "No se pudo actualizar el recibo.");
      if (selectedId === receipt.id) setActionFailure(message);
      else setListFailure(message);
    } finally {
      setBusy(false);
    }
  }

  function markReceived(receipt: PropertyTaxReceiptListItem) {
    void patchReceipt(receipt, { status: "recibido" }, `Recibo ${receiptTitle(receipt)} marcado como recibido.`);
  }

  function markPaid(receipt: PropertyTaxReceiptListItem, fromDrawer: boolean) {
    // Con asiento enlazado el API congela importes, fecha y medio (409 RECEIPT_ENTRY_EXISTS): solo viaja el estado (hoy · banco);
    // el API regenera el borrador propio (H 57x) o, si ya está contabilizado con H 475, propone el asiento de pago (ACT-REV-04).
    const body: PropertyTaxReceiptPatchRequest = fromDrawer && !paidFieldsLocked(receipt) ? { status: "pagado", paidAt: paidAt || null, paidWith } : { status: "pagado" };
    void patchReceipt(receipt, body, `Recibo ${receiptTitle(receipt)} marcado como pagado.`);
  }

  function appeal(receipt: PropertyTaxReceiptListItem) {
    const ref = appealRef.trim();
    if (!ref) {
      setActionFailure("Indica la referencia del recurso.");
      return;
    }
    void patchReceipt(receipt, { status: "recurrido", appealRef: ref }, `Recibo ${receiptTitle(receipt)} marcado como recurrido.`);
  }

  function linkEntry(receipt: PropertyTaxReceiptListItem) {
    const id = linkEntryId.trim();
    if (!id) {
      setActionFailure("Indica el identificador del asiento contabilizado.");
      return;
    }
    void patchReceipt(receipt, { journalEntryId: id }, `Asiento enlazado al recibo ${receiptTitle(receipt)}.`);
  }

  function unlinkEntry(receipt: PropertyTaxReceiptListItem) {
    void patchReceipt(receipt, { journalEntryId: null }, `Asiento desenlazado del recibo ${receiptTitle(receipt)}.`);
  }

  async function proposeEntry(receipt: PropertyTaxReceiptListItem) {
    if (busy) return;
    setBusy(true);
    setActionFailure(null);
    const result = await proposeEntryFor(receipt.id, propertyId);
    if (result.ok) {
      showToast(`Asiento propuesto en borrador para ${receiptTitle(receipt)}.`, { variant: "success" });
      refreshAll();
    } else {
      // 409 FISCAL_YEAR_CLOSED → «El ejercicio está cerrado: enlaza el asiento importado…» (real-estate-helpers).
      setActionFailure(result.message);
    }
    setBusy(false);
  }

  async function confirmPost() {
    if (!selected?.journalEntryId || busy) return;
    setBusy(true);
    setActionFailure(null);
    try {
      const posted = await postProposedEntry(selected.journalEntryId);
      showToast(`Asiento ${posted.entryNumber ? `n.º ${posted.entryNumber} ` : ""}contabilizado para ${receiptTitle(selected)}.`, { variant: "success" });
      setAskPost(false);
      refreshAll();
    } catch (error: unknown) {
      setActionFailure(taxFailureMessage(error, "No se pudo contabilizar el asiento."));
      setAskPost(false);
    } finally {
      setBusy(false);
    }
  }

  async function generate(tax: PropertyTaxWithReceipts) {
    if (generating) return;
    setGenerating(tax.id);
    setListFailure(null);
    try {
      const result = await generatePropertyTaxReceipts(tax.id, year, propertyId);
      showToast(result.created.length > 0 ? `${plural(result.created.length, "recibo previsto", "recibos previstos")} de ${taxKindLabel(tax.kind)} ${year} generados.` : `${taxKindLabel(tax.kind)} ${year} ya tenía todos los recibos previstos (${result.existing}).`, { variant: "success" });
      refreshAll();
    } catch (error: unknown) {
      setListFailure(taxFailureMessage(error, "No se pudieron generar los recibos previstos."));
    } finally {
      setGenerating(null);
    }
  }

  function openCreate() {
    setForm(emptyTaxForm());
    setTouched(false);
    setSaveFailure(null);
    setCreating(true);
  }

  function set<K extends keyof TaxForm>(field: K, value: TaxForm[K]) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function saveTax() {
    if (saving) return;
    setTouched(true);
    if (Object.keys(formErrors).length > 0) return;
    setSaving(true);
    setSaveFailure(null);
    try {
      const created = await createPropertyTax(taxRequestOf(form), propertyId);
      showToast(`Tributo ${taxKindLabel(created.kind)} de ${created.authorityName} registrado.`, { variant: "success" });
      setCreating(false);
      refreshAll();
    } catch (error: unknown) {
      setSaveFailure(taxFailureMessage(error, "No se pudo registrar el tributo. Revisa los datos e inténtalo de nuevo."));
    } finally {
      setSaving(false);
    }
  }

  const newTaxLabel = "Nuevo tributo";
  const generateLabel = `Generar previstos ${year}`;
  const loadingAny = (taxes.loading && !taxes.data) || (receipts.loading && !receipts.data);

  let shared: ReactElement | null = null;
  if (taxes.error && noAsset) {
    shared = <CocoaState kind="empty" illustration="box" title={NO_ASSET_TITLE} message={NO_ASSET_MESSAGE} />;
  } else if (taxes.error && errorStatus === 403) {
    shared = <CocoaState kind="empty" title={UI_STATES.forbidden.title} message={UI_STATES.forbidden.message} />;
  } else if (taxes.error) {
    shared = <CocoaState kind="error" title="No se pudieron cargar los tributos" message={taxFailureMessage(taxes.error, UI_STATES.error.message)} onRetry={refreshAll} />;
  }

  let panel: ReactElement;
  if (shared) {
    panel = shared;
  } else if (view === "tributos") {
    panel =
      loadingAny && taxRows.length === 0 ? (
        <CocoaTable columns={TAX_COLUMNS} rows={[]} loading aria-label="Tributos del centro" />
      ) : taxRows.length === 0 ? (
        <CocoaState kind="empty" illustration="box" title="Aún no hay tributos registrados" message="Registra el IBI, el IAE y las tasas municipales del inmueble con su autoridad, su base y su periodo voluntario; después genera los recibos previstos de cada ejercicio." primaryAction={canManageTaxes ? { label: newTaxLabel, onClick: openCreate } : undefined} />
      ) : (
        <CocoaTable
          columns={TAX_COLUMNS}
          rows={taxRows}
          rowKey="id"
          rowTone={(tax) => (tax.status === "baja" ? "neutral" : undefined)}
          rowActions={(tax) => (
            <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => void generate(tax)} loading={generating === tax.id} disabled={!canManageTaxes || generating !== null || tax.status !== "activo"} title={!canManageTaxes ? NO_PERMISSION_TAXES : tax.status !== "activo" ? "El tributo está de baja: no se generan recibos previstos." : `Crea los recibos previstos de ${year} que falten según el calendario del municipio`}>
              {generateLabel}
            </CocoaButton>
          )}
          rowActionsVisible="always"
          caption="Tributos del centro"
          aria-label="Tributos del centro"
        />
      );
  } else if (view === "recibos") {
    panel =
      loadingAny && receiptRows.length === 0 ? (
        <CocoaTable columns={RECEIPT_COLUMNS} rows={[]} loading aria-label={`Recibos de ${year}`} />
      ) : receipts.error ? (
        <CocoaState kind="error" title="No se pudieron cargar los recibos" message={taxFailureMessage(receipts.error, UI_STATES.error.message)} onRetry={refreshAll} />
      ) : receiptRows.length === 0 ? (
        <CocoaState kind="empty" illustration="box" title={`Sin recibos en ${year}`} message={taxRows.length > 0 ? `Genera los recibos previstos de ${year} desde la pestaña Tributos o registra los recibidos.` : "Registra antes los tributos del inmueble."} />
      ) : (
        <CocoaTable
          columns={RECEIPT_COLUMNS}
          rows={receiptRows}
          rowKey="id"
          selectedKey={selectedId ?? undefined}
          onSelect={openReceipt}
          rowTone={(receipt) => (receipt.overdue && receipt.status !== "pagado" ? "danger" : undefined)}
          rowActions={(receipt) => (
            <span className="cocoa-cluster">
              {canMarkReceived(receipt) ? (
                <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => markReceived(receipt)} disabled={!canManageTaxes || busy} title={canManageTaxes ? undefined : NO_PERMISSION_TAXES}>
                  Marcar recibido
                </CocoaButton>
              ) : null}
              {canMarkPaid(receipt) ? (
                <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => markPaid(receipt, false)} disabled={!canManageTaxes || busy} title={canManageTaxes ? "Pagado hoy por banco; para otra fecha o medio abre el recibo" : NO_PERMISSION_TAXES}>
                  Marcar pagado
                </CocoaButton>
              ) : null}
            </span>
          )}
          rowActionsVisible="always"
          caption={`Recibos de ${year}`}
          aria-label={`Recibos de ${year}`}
          columnsPrefsKey="real-estate-receipts"
        />
      );
  } else {
    const months = taxCalendarMonths(year, calendar.data, receiptRows);
    panel = calendar.error ? (
      <CocoaState kind="error" title="No se pudo cargar el calendario" message={taxFailureMessage(calendar.error, UI_STATES.error.message)} onRetry={refreshAll} />
    ) : calendar.loading && !calendar.data ? (
      <CocoaState kind="loading" title={STATUS_LABELS.loading} />
    ) : (
      <CocoaGrid columns={12} gap={3} align="start" role="list" aria-label={`Calendario de tributos ${year}`}>
        {months.map((month) => (
          <CocoaSpan key={month.month} cols={3} min={240}>
            <CocoaCard role="listitem" aria-label={`${month.label} ${year}`}>
              <div className="cocoa-stack" data-gap="2">
                <div className="cocoa-row" data-gap="2" data-justify="between">
                  <strong>{month.label}</strong>
                  <CocoaBadge tone={month.items.length > 0 ? "info" : "neutral"} variant="outline" uppercase={false}>
                    {plural(month.items.length, "plazo", "plazos")}
                  </CocoaBadge>
                </div>
                {month.items.length === 0 ? (
                  <span>Sin periodos voluntarios.</span>
                ) : (
                  month.items.map((item) => (
                    <div key={item.key} className="cocoa-stack" data-gap="1">
                      <span className="cocoa-cluster">
                        <CocoaBadge tone={item.tone} variant="dot" uppercase={false}>
                          {item.label}
                        </CocoaBadge>
                      </span>
                      <span>{item.detail}</span>
                    </div>
                  ))
                )}
              </div>
            </CocoaCard>
          </CocoaSpan>
        ))}
      </CocoaGrid>
    );
  }

  const panelId = "real-estate-taxes-panel";
  const viewLabel = TAX_VIEW_OPTIONS.find((option) => option.value === view)?.label ?? view;

  return (
    <CocoaPage
      eyebrow="Finanzas · Activo inmobiliario"
      title="Tributos"
      subtitle={hosted ? undefined : "IBI, IAE y tasas del inmueble: recibos del ejercicio con su estado, asiento 631 propuesto en borrador y calendario de periodos voluntarios."}
      actions={
        <>
          <CocoaSelect value={String(year)} onChange={(value) => setYear(Number(value))} size="small" inline aria-label="Ejercicio" options={yearOptions(currentYear())} />
          <CocoaButton variant="filled" tone="accent" size={hosted ? "small" : "regular"} onClick={openCreate} disabled={!canManageTaxes || noAsset} title={canManageTaxes ? undefined : NO_PERMISSION_TAXES}>
            {newTaxLabel}
          </CocoaButton>
        </>
      }
      commands={[
        { id: "real-estate-taxes-new", label: newTaxLabel, run: openCreate },
        { id: "real-estate-taxes-refresh", label: "Actualizar tributos", run: refreshAll }
      ]}
    >
      <CocoaKpiStrip min={200} aria-label={`Resumen de tributos ${year}`}>
        <CocoaKpi label="Carga fiscal anual prevista" value={taxes.data ? (kpis.annualBurden !== null ? formatMoney(kpis.annualBurden) : "—") : "—"} caption={taxes.data ? plural(kpis.activeTaxes, "tributo activo", "tributos activos") : undefined} degraded={Boolean(taxes.error)} />
        <CocoaKpi label={`Recibos pendientes ${year}`} value={receipts.data ? kpis.pendingCount : "—"} caption={receipts.data ? formatMoney(kpis.pendingAmount) : undefined} status={kpis.pendingCount > 0 ? "warning" : undefined} degraded={Boolean(receipts.error)} />
        <CocoaKpi label={`Pagado ${year}`} value={receipts.data ? formatMoney(kpis.paidAmount) : "—"} caption={receipts.data ? plural(kpis.paidCount, "recibo", "recibos") : undefined} degraded={Boolean(receipts.error)} />
        <CocoaKpi label="Vencidos sin pagar" value={receipts.data ? kpis.overdueCount : "—"} status={kpis.overdueCount > 0 ? "critical" : undefined} degraded={Boolean(receipts.error)} />
      </CocoaKpiStrip>

      <CocoaToolbar variant="content" aria-label="Vista de tributos" leftSlot={<CocoaSegmentedControl value={view} onChange={(value) => setView(isTaxView(value) ? value : "tributos")} options={TAX_VIEW_OPTIONS} panelId={panelId} aria-label="Vista" />} />

      {listFailure ? (
        <CocoaCallout tone="danger" role="alert" title="No se pudo completar la acción">
          {listFailure}
        </CocoaCallout>
      ) : null}

      <div id={panelId} role="tabpanel" aria-label={viewLabel}>
        <CocoaSection padding={shared || view === "calendario" ? "md" : "none"} aria-label={viewLabel}>
          {panel}
        </CocoaSection>
      </div>

      <CocoaDrawer
        open={selected !== null}
        onClose={closeReceipt}
        title={selected ? `Recibo ${receiptTitle(selected)}` : "Recibo"}
        subtitle={selected ? `${selected.tax.authorityName} · ${taxpayerLabel(selected.tax.taxpayer)}` : undefined}
        size="md"
        footer={
          <div className="cocoa-row" data-gap="2" data-justify="end">
            <CocoaButton variant="bordered" tone="neutral" onClick={closeReceipt} disabled={busy}>
              {ACTIONS.close}
            </CocoaButton>
          </div>
        }
      >
        {selected ? (
          <div className="cocoa-stack" data-gap="4">
            <div className="cocoa-cluster">
              <CocoaBadge tone={receiptStatusTone(selected)} variant="tinted" uppercase={false}>
                {receiptStatusText(selected)}
              </CocoaBadge>
              <JournalEntryBadge receipt={selected} />
              {selected.overdue && selected.status !== "pagado" ? (
                <CocoaBadge tone="danger" variant="outline" uppercase={false}>
                  {`Vencido desde el ${formatDay(selected.dueTo)}`}
                </CocoaBadge>
              ) : null}
            </div>

            {actionFailure ? (
              <CocoaCallout tone="danger" role="alert" title="No se pudo completar la acción">
                {actionFailure}
              </CocoaCallout>
            ) : null}

            <CocoaFormRow columns={3} min={140}>
              <CocoaStat label="Importe" value={formatMoney(selected.amount)} hint={toNumber(selected.surchargeAmount) ? `Recargo ${formatMoney(selected.surchargeAmount)}` : undefined} />
              <CocoaStat label="Periodo voluntario" value={selected.dueFrom || selected.dueTo ? `${formatDay(selected.dueFrom)} – ${formatDay(selected.dueTo)}` : "—"} tabular={false} />
              <CocoaStat label="Emitido" value={formatDay(selected.issuedAt)} />
              <CocoaStat label="Pago" value={selected.paidAt ? `${formatDay(selected.paidAt)} · ${paidWithLabel(selected.paidWith)}` : "—"} tabular={false} />
              <CocoaStat label="Recurso" value={selected.appealRef ?? "—"} tabular={false} />
              <CocoaStat label="Cuenta" value={selected.tax.accountCode} hint={selected.tax.fiscalReference ?? undefined} />
            </CocoaFormRow>

            <CocoaSection title="Estado del recibo" aria-label="Acciones sobre el estado del recibo">
              <div className="cocoa-stack" data-gap="3">
                {canMarkReceived(selected) ? (
                  <div className="cocoa-row" data-gap="2">
                    <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => markReceived(selected)} disabled={!canManageTaxes || busy} title={canManageTaxes ? undefined : NO_PERMISSION_TAXES}>
                      Marcar recibido
                    </CocoaButton>
                  </div>
                ) : null}
                {canMarkPaid(selected) ? (
                  <CocoaFormRow columns={3} min={140}>
                    <CocoaField label="Fecha de pago" help={paidFieldsLocked(selected) ? PAID_FIELDS_LOCKED : undefined}>
                      <CocoaDatePicker value={paidAt} onChange={setPaidAt} disabled={busy || paidFieldsLocked(selected)} />
                    </CocoaField>
                    <CocoaField label="Medio de pago">
                      <CocoaSelect value={paidWith} onChange={(value) => setPaidWith(value as PropertyTaxPaidWith)} options={catalogOptions(PROPERTY_TAX_PAID_WITH, PAID_WITH_LABELS)} disabled={busy || paidFieldsLocked(selected)} />
                    </CocoaField>
                    <CocoaField label="Pago">
                      <CocoaButton variant="filled" tone="accent" size="small" onClick={() => markPaid(selected, true)} disabled={!canManageTaxes || busy || Boolean(paidDisabledReason(selected))} title={!canManageTaxes ? NO_PERMISSION_TAXES : (paidDisabledReason(selected) ?? undefined)}>
                        Marcar pagado
                      </CocoaButton>
                    </CocoaField>
                  </CocoaFormRow>
                ) : null}
                {canAppeal(selected) ? (
                  <CocoaFormRow columns={2} min={180}>
                    <CocoaField label="Referencia del recurso">
                      <CocoaInput value={appealRef} onChange={setAppealRef} placeholder="Número de expediente" maxLength={120} disabled={busy} />
                    </CocoaField>
                    <CocoaField label="Recurso">
                      <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => appeal(selected)} disabled={!canManageTaxes || busy} title={canManageTaxes ? "El recibo pasa a recurrido; la deuda sigue viva hasta que se resuelva" : NO_PERMISSION_TAXES}>
                        Recurrir
                      </CocoaButton>
                    </CocoaField>
                  </CocoaFormRow>
                ) : null}
                {selected.status === "pagado" ? <span>El recibo está pagado: solo admite «Recurrir» (conserva la fecha y el medio de pago).</span> : null}
              </div>
            </CocoaSection>

            <CocoaSection title="Asiento contable" meta={`cuenta ${selected.tax.accountCode}`} aria-label="Asiento contable del recibo">
              <div className="cocoa-stack" data-gap="3">
                <div className="cocoa-cluster">
                  <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void proposeEntry(selected)} disabled={busy || proposeEntryDisabledReason(selected, selected.tax, canManageTaxes) !== null} title={proposeEntryDisabledReason(selected, selected.tax, canManageTaxes) ?? "Crea el asiento en borrador (gasto 631 o inversión si es capitalizable); lo contabiliza Administración"}>
                    Proponer asiento
                  </CocoaButton>
                  {posting.visible ? (
                    <CocoaButton variant="filled" tone="accent" size="small" onClick={() => setAskPost(true)} disabled={busy || postEntryDisabledReason(selected, posting) !== null} title={postEntryDisabledReason(selected, posting) ?? "Contabiliza el borrador propuesto (acción crítica)"}>
                      Contabilizar
                    </CocoaButton>
                  ) : null}
                  {selected.journalEntryId ? (
                    <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => unlinkEntry(selected)} disabled={!canManageTaxes || busy} title={canManageTaxes ? "Quita el enlace al asiento; el asiento no se borra ni se anula" : NO_PERMISSION_TAXES}>
                      Desenlazar asiento
                    </CocoaButton>
                  ) : null}
                </div>
                {selected.journalEntryId ? (
                  <span>{`Asiento ${selected.journalEntryId} · ${journalEntryStatusLabel(selected.journalEntryStatus)}`}</span>
                ) : (
                  <CocoaFormRow columns={2} min={180}>
                    <CocoaField label="Enlazar asiento contabilizado" help="Identificador del asiento del diario (ejercicios cerrados o asientos importados de Sage).">
                      <CocoaInput value={linkEntryId} onChange={setLinkEntryId} placeholder="je_…" maxLength={64} disabled={busy} />
                    </CocoaField>
                    <CocoaField label="Enlace">
                      <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => linkEntry(selected)} disabled={!canManageTaxes || busy} title={canManageTaxes ? undefined : NO_PERMISSION_TAXES}>
                        Enlazar asiento
                      </CocoaButton>
                    </CocoaField>
                  </CocoaFormRow>
                )}
              </div>
            </CocoaSection>
          </div>
        ) : null}
      </CocoaDrawer>

      <CocoaDialog
        open={askPost && selected !== null}
        onClose={() => setAskPost(false)}
        title="Contabilizar el asiento"
        description={selected ? `El borrador ${selected.journalEntryId ?? ""} del recibo ${receiptTitle(selected)} (${formatMoney(selected.amount)}) pasará a contabilizado en el diario. Es una acción crítica y auditada.` : ""}
        confirmLabel="Contabilizar"
        onConfirm={confirmPost}
        busy={busy}
      />

      <CocoaDrawer
        open={creating}
        onClose={() => setCreating(false)}
        title={newTaxLabel}
        subtitle="Tributo local del inmueble: autoridad, base, tipo y periodo voluntario."
        size="md"
        footer={
          <div className="cocoa-row" data-gap="2" data-justify="end">
            <CocoaButton variant="plain" tone="neutral" onClick={() => setCreating(false)} disabled={saving}>
              {ACTIONS.cancel}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" onClick={() => void saveTax()} loading={saving} disabled={!canManageTaxes}>
              {ACTIONS.save}
            </CocoaButton>
          </div>
        }
      >
        <div className="cocoa-stack" data-gap="4">
          {saveFailure ? (
            <CocoaCallout tone="danger" role="alert" title="No se pudo registrar">
              {saveFailure}
            </CocoaCallout>
          ) : null}
          <CocoaFormRow columns={2}>
            <CocoaField label="Tributo" required>
              <CocoaSelect value={form.kind} onChange={(value) => set("kind", value as PropertyTaxKind)} options={catalogOptions(PROPERTY_TAX_KINDS, TAX_KIND_LABELS)} disabled={saving} />
            </CocoaField>
            <CocoaField label="Sujeto pasivo" required help="Solo se propone asiento cuando lo paga la sociedad.">
              <CocoaSelect value={form.taxpayer} onChange={(value) => set("taxpayer", value as PropertyTaxTaxpayer)} options={catalogOptions(PROPERTY_TAX_TAXPAYERS, TAXPAYER_LABELS)} disabled={saving} />
            </CocoaField>
            <CocoaField label="Autoridad" required error={shownErrors.authorityName}>
              <CocoaInput value={form.authorityName} onChange={(value) => set("authorityName", value)} placeholder="Ayuntamiento de…" maxLength={160} disabled={saving} />
            </CocoaField>
            <CocoaField label="Referencia fiscal" help="Referencia del recibo o del objeto tributario.">
              <CocoaInput value={form.fiscalReference} onChange={(value) => set("fiscalReference", value)} maxLength={64} disabled={saving} />
            </CocoaField>
            <CocoaField label="Base" error={shownErrors.taxBase}>
              <CocoaInput value={form.taxBase} onChange={(value) => set("taxBase", value)} inputMode="decimal" placeholder="0,00" disabled={saving} />
            </CocoaField>
            <CocoaField label="Tipo (%)" help="Hasta 4 decimales (0,4525)." error={shownErrors.ratePct}>
              <CocoaInput value={form.ratePct} onChange={(value) => set("ratePct", value)} inputMode="decimal" placeholder="0,0000" disabled={saving} />
            </CocoaField>
            <CocoaField label="Importe anual previsto" error={shownErrors.expectedAnnualAmount}>
              <CocoaInput value={form.expectedAnnualAmount} onChange={(value) => set("expectedAnnualAmount", value)} inputMode="decimal" placeholder="0,00" disabled={saving} />
            </CocoaField>
            <CocoaField label="Periodicidad">
              <CocoaSelect value={form.periodicity} onChange={(value) => set("periodicity", value as PropertyTaxPeriodicity)} options={catalogOptions(PROPERTY_TAX_PERIODICITIES, TAX_PERIODICITY_LABELS)} disabled={saving} />
            </CocoaField>
            <CocoaField label="Periodo voluntario: desde" help="Mes-día (10-01). Van juntos con «hasta»." error={shownErrors.voluntaryFrom}>
              <CocoaInput value={form.voluntaryFrom} onChange={(value) => set("voluntaryFrom", value)} placeholder="10-01" maxLength={5} disabled={saving} />
            </CocoaField>
            <CocoaField label="Periodo voluntario: hasta" error={shownErrors.voluntaryTo}>
              <CocoaInput value={form.voluntaryTo} onChange={(value) => set("voluntaryTo", value)} placeholder="11-30" maxLength={5} disabled={saving} />
            </CocoaField>
            <CocoaField label="Domiciliado" inline>
              <CocoaSwitch checked={form.directDebit} onChange={(value) => set("directDebit", value)} disabled={saving} />
            </CocoaField>
            <CocoaField label="Bonificación por domiciliar (%)" error={shownErrors.directDebitBonusPct}>
              <CocoaInput value={form.directDebitBonusPct} onChange={(value) => set("directDebitBonusPct", value)} inputMode="decimal" placeholder="0,00" disabled={saving || !form.directDebit} />
            </CocoaField>
          </CocoaFormRow>
        </div>
      </CocoaDrawer>
    </CocoaPage>
  );
}

// ---------------------------------------------------------------------------
// Piezas de presentación
// ---------------------------------------------------------------------------

/** Estado del asiento enlazado al recibo: Borrador (ámbar) · Contabilizado (verde) · Anulado (rojo); sin asiento, «—». */
export function JournalEntryBadge({ receipt }: { receipt: Pick<PropertyTaxReceiptRecord, "journalEntryId" | "journalEntryStatus"> }) {
  if (!receipt.journalEntryId) return <span>—</span>;
  return (
    <CocoaBadge tone={journalEntryStatusTone(receipt.journalEntryStatus)} variant="tinted" uppercase={false} title={`Asiento ${receipt.journalEntryId}`}>
      {journalEntryStatusLabel(receipt.journalEntryStatus)}
    </CocoaBadge>
  );
}

// ---------------------------------------------------------------------------
// Carga (clave = centro activo + ejercicio; conserva el error tipado)
// ---------------------------------------------------------------------------

type LoadState<T> = { data: T | null; loading: boolean; error: unknown; refresh: () => void };

function useLoad<T>(load: () => Promise<T>, key: string): LoadState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);
  const seq = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    const current = ++seq.current;
    setLoading(true);
    setError(null);
    loadRef
      .current()
      .then((value) => {
        if (current !== seq.current) return;
        setData(value);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (current !== seq.current) return;
        setError(err);
        setLoading(false);
      });
  }, [key, nonce]);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, refresh };
}

// ---------------------------------------------------------------------------
// Helpers puros (probados en __tests__/RealEstateTaxesScreen.test.mts)
// ---------------------------------------------------------------------------

export const NO_ASSET_TITLE = "Este centro aún no tiene activo inmobiliario";
export const NO_ASSET_MESSAGE = "Crea la ficha del inmueble en la pestaña Ficha; después podrás registrar aquí el IBI, el IAE y las tasas con sus recibos.";
export const NO_PERMISSION_TAXES = "Necesitas el permiso de gestión de tributos del inmueble («property_tax.manage»).";
export const NO_PERMISSION_POST = "Contabilizar exige accounting.journal.post y ai.high_risk.confirm (Administración).";

export type TaxView = "tributos" | "recibos" | "calendario";

export const TAX_VIEW_OPTIONS: Array<{ value: TaxView; label: string }> = [
  { value: "tributos", label: "Tributos" },
  { value: "recibos", label: "Recibos" },
  { value: "calendario", label: "Calendario" }
];

export function isTaxView(value: string): value is TaxView {
  return TAX_VIEW_OPTIONS.some((option) => option.value === value);
}

export function currentYear(): number {
  return Number(todayIso().slice(0, 4));
}

/** Ejercicios elegibles: dos anteriores, el actual y el siguiente (los recibos previstos se generan por adelantado). */
export function yearOptions(current: number): Array<{ value: string; label: string }> {
  return [current - 2, current - 1, current, current + 1].map((year) => ({ value: String(year), label: String(year) }));
}

export type TaxKpis = { annualBurden: number | null; activeTaxes: number; pendingCount: number; pendingAmount: number; paidCount: number; paidAmount: number; overdueCount: number };

/** Carga fiscal anual (suma de `expectedAnnualAmount` de los tributos activos; null si ninguno lo informa) y recibos pendientes / pagados / vencidos del ejercicio. */
export function taxKpis(taxes: readonly Pick<PropertyTaxRecord, "status" | "expectedAnnualAmount">[], receipts: readonly Pick<PropertyTaxReceiptRecord, "status" | "amount" | "surchargeAmount" | "overdue">[]): TaxKpis {
  const active = taxes.filter((tax) => tax.status === "activo");
  const informed = active.map((tax) => toNumber(tax.expectedAnnualAmount)).filter((value): value is number => value !== null);
  const total = (receipt: Pick<PropertyTaxReceiptRecord, "amount" | "surchargeAmount">) => (toNumber(receipt.amount) ?? 0) + (toNumber(receipt.surchargeAmount) ?? 0);
  const pending = receipts.filter((receipt) => receipt.status !== "pagado");
  const paid = receipts.filter((receipt) => receipt.status === "pagado");
  return {
    annualBurden: informed.length > 0 ? informed.reduce((sum, value) => sum + value, 0) : null,
    activeTaxes: active.length,
    pendingCount: pending.length,
    pendingAmount: pending.reduce((sum, receipt) => sum + total(receipt), 0),
    paidCount: paid.length,
    paidAmount: paid.reduce((sum, receipt) => sum + total(receipt), 0),
    overdueCount: pending.filter((receipt) => receipt.overdue).length
  };
}

/** Máquina RECEIPT del API (modules/real-estate/state-machines.ts): transiciones que la pantalla ofrece; el API responde 409 RECEIPT_NOT_PAYABLE fuera de ellas. */
export const RECEIPT_TRANSITIONS: Readonly<Record<PropertyTaxReceiptStatus, readonly PropertyTaxReceiptStatus[]>> = Object.freeze({
  previsto: ["recibido", "domiciliado", "pagado", "recurrido"],
  recibido: ["pagado", "recurrido"],
  domiciliado: ["pagado", "recurrido"],
  recurrido: ["pagado"],
  // ACT-REV-10: «Recurrir» también desde pagado (el API conserva paidAt / paidWith).
  pagado: ["recurrido"]
});

function transitionsOf(status: string): readonly PropertyTaxReceiptStatus[] {
  return Object.hasOwn(RECEIPT_TRANSITIONS, status) ? RECEIPT_TRANSITIONS[status as PropertyTaxReceiptStatus] : [];
}

export function canMarkReceived(receipt: Pick<PropertyTaxReceiptRecord, "status">): boolean {
  return transitionsOf(receipt.status).includes("recibido");
}

export function canMarkPaid(receipt: Pick<PropertyTaxReceiptRecord, "status">): boolean {
  return transitionsOf(receipt.status).includes("pagado");
}

export function canAppeal(receipt: Pick<PropertyTaxReceiptRecord, "status">): boolean {
  return transitionsOf(receipt.status).includes("recurrido");
}

export const PAID_FIELDS_LOCKED = "Con asiento enlazado el pago se registra hoy por banco (el API congela fecha y medio): desenlaza el asiento para indicar otros. Si el asiento es un borrador, el API lo regenera con la contrapartida de tesorería; si ya está contabilizado (H 475), propone el asiento de pago en borrador.";

/** Con asiento enlazado el API congela importes, fecha y medio de pago (409 RECEIPT_ENTRY_EXISTS si viajan): el pago solo puede ir como cambio de estado. */
export function paidFieldsLocked(receipt: Pick<PropertyTaxReceiptRecord, "journalEntryId">): boolean {
  return Boolean(receipt.journalEntryId);
}

/** Pagar sin importe es imposible (409 RECEIPT_NOT_PAYABLE); con asiento enlazado se puede (solo el estado, ver paidFieldsLocked). */
export function paidDisabledReason(receipt: Pick<PropertyTaxReceiptRecord, "amount">): string | null {
  if ((toNumber(receipt.amount) ?? 0) <= 0) return "El recibo no tiene importe: regístralo antes de pagarlo.";
  return null;
}

/**
 * Motivo (en `title`) por el que «Proponer asiento» está deshabilitado, o null si
 * se puede proponer: permiso, sujeto pasivo distinto de la sociedad
 * (TAXPAYER_NOT_ENTITY), asiento ya enlazado (RECEIPT_ENTRY_EXISTS), recibo
 * previsto o sin importe (RECEIPT_NOT_PAYABLE).
 */
export function proposeEntryDisabledReason(receipt: Pick<PropertyTaxReceiptRecord, "status" | "journalEntryId" | "journalEntryStatus" | "amount">, tax: Pick<PropertyTaxRecord, "taxpayer">, canManage: boolean): string | null {
  if (!canManage) return NO_PERMISSION_TAXES;
  if (tax.taxpayer !== "sociedad") return `Solo se propone asiento cuando el sujeto pasivo es la sociedad: este tributo lo paga ${taxpayerLabel(tax.taxpayer).toLowerCase()}.`;
  if (receipt.journalEntryId) return `El recibo ya tiene un asiento enlazado (${journalEntryStatusLabel(receipt.journalEntryStatus).toLowerCase()}): desenlázalo antes de proponer otro.`;
  if (receipt.status === "previsto") return "El recibo está previsto: márcalo como recibido antes de proponer el asiento.";
  if ((toNumber(receipt.amount) ?? 0) <= 0) return "El recibo no tiene importe: regístralo antes de proponer el asiento.";
  return null;
}

export type PostEntryGate = { visible: boolean; enabled: boolean; reason: string | null };

/** «Contabilizar» solo se muestra con accounting.journal.post; la ruta POST /journal-entries/:id/post exige además ai.high_risk.confirm. */
export function postEntryGate(gate: Pick<NavGateState, "grantedPermissions" | "isPlatformAdmin">): PostEntryGate {
  const visible = canDo(gate, "accounting.journal.post");
  const enabled = visible && canDo(gate, "ai.high_risk.confirm");
  return { visible, enabled, reason: enabled ? null : NO_PERMISSION_POST };
}

/** Motivo (en `title`) por el que «Contabilizar» está deshabilitado, o null si el borrador enlazado se puede contabilizar. */
export function postEntryDisabledReason(receipt: Pick<PropertyTaxReceiptRecord, "journalEntryId" | "journalEntryStatus">, gate: PostEntryGate): string | null {
  if (!gate.visible) return NO_PERMISSION_POST;
  if (!receipt.journalEntryId) return "Propón primero el asiento en borrador.";
  if (receipt.journalEntryStatus === "posted") return "El asiento ya está contabilizado.";
  if (receipt.journalEntryStatus === "reversed") return "El asiento está anulado: desenlázalo y propón otro.";
  if (!gate.enabled) return gate.reason;
  return null;
}

/** Frase en español de un fallo (FISCAL_YEAR_CLOSED, TAXPAYER_NOT_ENTITY, RECEIPT_ENTRY_EXISTS, PROPERTY_TAX_INACTIVE…) o `fallback`. */
export function taxFailureMessage(error: unknown, fallback?: string): string {
  return realEstateErrorMessage(error, fallback);
}

export type ProposeEntryResult = { ok: true; receipt: PropertyTaxReceiptRecord } | { ok: false; message: string };

/** POST …/receipts/:id/propose-entry: el borrador queda enlazado; un 4xx vuelve como frase (409 FISCAL_YEAR_CLOSED incluido). */
export async function proposeEntryFor(receiptId: string, propertyId: string): Promise<ProposeEntryResult> {
  try {
    const receipt = await proposeReceiptEntry(receiptId, propertyId);
    return { ok: true, receipt };
  } catch (error: unknown) {
    return { ok: false, message: taxFailureMessage(error, "No se pudo proponer el asiento.") };
  }
}

export function receiptTitle(receipt: Pick<PropertyTaxReceiptListItem, "fiscalYear" | "period"> & { tax: Pick<PropertyTaxRecord, "kind"> }): string {
  const period = receipt.period && receipt.period !== "anual" ? ` · ${receipt.period}` : "";
  return `${taxKindLabel(receipt.tax.kind)} ${receipt.fiscalYear}${period}`;
}

export const TAX_COLUMNS: CocoaTableColumn<PropertyTaxWithReceipts>[] = [
  { key: "kind", label: "Tributo", fit: true, render: (tax) => taxKindLabel(tax.kind) },
  { key: "taxpayer", label: "Sujeto pasivo", fit: true, render: (tax) => taxpayerLabel(tax.taxpayer) },
  { key: "authorityName", label: "Autoridad", truncate: 220, render: (tax) => tax.authorityName },
  { key: "fiscalReference", label: "Referencia", truncate: 160, showFrom: "laptop", render: (tax) => tax.fiscalReference ?? "—" },
  { key: "taxBase", label: "Base", align: "right", hideOnNarrow: true, render: (tax) => formatMoney(tax.taxBase) },
  { key: "ratePct", label: "Tipo", align: "right", hideOnNarrow: true, render: (tax) => formatPercent(tax.ratePct, 4) },
  { key: "expectedAnnualAmount", label: "Importe previsto", align: "right", render: (tax) => formatMoney(tax.expectedAnnualAmount) },
  { key: "periodicity", label: "Periodicidad", fit: true, showFrom: "tablet", render: (tax) => `${taxPeriodicityLabel(tax.periodicity)}${tax.voluntaryFrom ? ` · ${monthDayRangeLabel(tax.voluntaryFrom, tax.voluntaryTo)}` : ""}` },
  {
    key: "directDebit",
    label: "Domiciliado",
    fit: true,
    render: (tax) => (
      <CocoaBadge tone={tax.directDebit ? "success" : "neutral"} variant="outline" uppercase={false}>
        {tax.directDebit ? `${STATUS_LABELS.yes}${tax.directDebitBonusPct ? ` · ${formatPercent(tax.directDebitBonusPct)}` : ""}` : STATUS_LABELS.no}
      </CocoaBadge>
    )
  },
  {
    key: "status",
    label: "Estado",
    fit: true,
    render: (tax) => (
      <CocoaBadge tone={taxStatusTone(tax.status)} variant="tinted" uppercase={false}>
        {taxStatusLabel(tax.status)}
      </CocoaBadge>
    )
  },
  { key: "receipts", label: "Recibos", fit: true, align: "right", showFrom: "tablet", render: (tax) => String(tax.receipts.length) }
];

export const RECEIPT_COLUMNS: CocoaTableColumn<PropertyTaxReceiptListItem>[] = [
  { key: "tax", label: "Tributo", truncate: 260, render: (receipt) => `${taxKindLabel(receipt.tax.kind)} · ${receipt.tax.authorityName}` },
  { key: "period", label: "Periodo", fit: true, render: (receipt) => `${receipt.fiscalYear}${receipt.period && receipt.period !== "anual" ? ` · ${receipt.period}` : ""}` },
  { key: "window", label: "Periodo voluntario", fit: true, hideOnNarrow: true, render: (receipt) => (receipt.dueFrom || receipt.dueTo ? `${formatDay(receipt.dueFrom)} – ${formatDay(receipt.dueTo)}` : "—") },
  { key: "amount", label: "Importe", align: "right", render: (receipt) => formatMoney(receipt.amount) },
  {
    key: "status",
    label: "Estado",
    fit: true,
    render: (receipt) => (
      <CocoaBadge tone={receiptStatusTone(receipt)} variant="tinted" uppercase={false}>
        {receiptStatusText(receipt)}
      </CocoaBadge>
    )
  },
  { key: "paid", label: "Pago", fit: true, showFrom: "tablet", render: (receipt) => (receipt.paidAt ? `${formatDay(receipt.paidAt)} · ${paidWithLabel(receipt.paidWith)}` : "—") },
  { key: "journal", label: "Asiento", fit: true, render: (receipt) => <JournalEntryBadge receipt={receipt} /> },
  { key: "taxpayer", label: "Sujeto pasivo", fit: true, showFrom: "laptop", render: (receipt) => taxpayerLabel(receipt.tax.taxpayer) }
];

// ---------------------------------------------------------------------------
// Calendario de 12 meses
// ---------------------------------------------------------------------------

export const MONTH_LABELS_ES: readonly string[] = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

export type TaxCalendarItem = { key: string; label: string; detail: string; at: string; tone: CocoaTone };
export type TaxCalendarMonth = { month: number; label: string; items: TaxCalendarItem[] };

function monthOf(day: string | null | undefined, year: number): number | null {
  if (!day || day.length < 7 || Number(day.slice(0, 4)) !== year) return null;
  const month = Number(day.slice(5, 7));
  return month >= 1 && month <= 12 ? month : null;
}

function rangeLabel(from: string | null, to: string | null): string {
  if (from && to) return `del ${formatDay(from)} al ${formatDay(to)}`;
  if (to) return `hasta el ${formatDay(to)}`;
  if (from) return `desde el ${formatDay(from)}`;
  return "sin ventana";
}

/**
 * Los 12 meses del ejercicio con sus periodos voluntarios: recibos del año (en el
 * mes en que termina su ventana), periodos del calendario municipal sin recibo
 * generado y eventos TAX_DUE / TAX_OVERDUE de recibos que no estén ya en la lista.
 */
export function taxCalendarMonths(year: number, calendar: PropertyTaxCalendar | null, receipts: readonly PropertyTaxReceiptListItem[]): TaxCalendarMonth[] {
  const months: TaxCalendarMonth[] = MONTH_LABELS_ES.map((label, index) => ({ month: index + 1, label, items: [] }));
  const push = (month: number | null, item: TaxCalendarItem) => {
    if (month !== null) months[month - 1].items.push(item);
  };
  const listed = new Set<string>();
  for (const receipt of receipts) {
    listed.add(receipt.id);
    const month = monthOf(receipt.dueTo, year) ?? monthOf(receipt.dueFrom, year);
    const paid = receipt.status === "pagado";
    const tone: CocoaTone = paid ? "success" : receipt.overdue ? "danger" : receipt.status === "previsto" ? "neutral" : "warning";
    push(month, {
      key: `receipt:${receipt.id}`,
      label: `${receiptTitle(receipt)} · ${receiptStatusText(receipt)}`,
      detail: `${rangeLabel(receipt.dueFrom, receipt.dueTo)} · ${formatMoney(receipt.amount)}`,
      at: receipt.dueTo ?? receipt.dueFrom ?? `${year}-12-31`,
      tone
    });
  }
  for (const pending of calendar?.pending ?? []) {
    push(monthOf(pending.dueTo, year) ?? monthOf(pending.dueFrom, year), {
      key: `pending:${pending.taxId}:${pending.period}`,
      label: `${taxKindLabel(pending.kind)} ${year}${pending.period !== "anual" ? ` · ${pending.period}` : ""} · sin recibo`,
      detail: `${rangeLabel(pending.dueFrom, pending.dueTo)}${pending.amount ? ` · ${formatMoney(pending.amount)}` : ""}`,
      at: pending.dueTo,
      tone: "neutral"
    });
  }
  for (const event of calendar?.events ?? []) {
    if (event.entityType === "property_tax_receipt" && listed.has(event.entityId)) continue;
    push(monthOf(event.dueAt, year), {
      key: `event:${event.kind}:${event.entityId}:${event.dueAt}`,
      label: event.label,
      detail: formatDay(event.dueAt),
      at: event.dueAt,
      tone: event.kind === "TAX_OVERDUE" ? "danger" : "warning"
    });
  }
  for (const month of months) month.items.sort((a, b) => a.at.localeCompare(b.at) || a.label.localeCompare(b.label));
  return months;
}

// ---------------------------------------------------------------------------
// Alta de tributo
// ---------------------------------------------------------------------------

export type TaxForm = {
  kind: PropertyTaxKind;
  taxpayer: PropertyTaxTaxpayer;
  authorityName: string;
  fiscalReference: string;
  taxBase: string;
  ratePct: string;
  expectedAnnualAmount: string;
  periodicity: PropertyTaxPeriodicity;
  voluntaryFrom: string;
  voluntaryTo: string;
  directDebit: boolean;
  directDebitBonusPct: string;
};

export type TaxFormErrors = Partial<Record<keyof TaxForm, string>>;

export function emptyTaxForm(): TaxForm {
  return { kind: "ibi", taxpayer: "sociedad", authorityName: "", fiscalReference: "", taxBase: "", ratePct: "", expectedAnnualAmount: "", periodicity: "anual", voluntaryFrom: "", voluntaryTo: "", directDebit: false, directDebitBonusPct: "" };
}

const MONTH_DAY = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const DECIMAL_4 = /^\d+(\.\d{1,4})?$/;

/** «0,4525» / «0.4525» → «0.4525» (hasta 4 decimales); null si no es un número válido. */
export function percentInput(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const normalised = text.includes(",") ? text.replace(/\./g, "").replace(",", ".") : text;
  return DECIMAL_4.test(normalised) ? normalised : null;
}

export function validateTaxForm(form: TaxForm): TaxFormErrors {
  const errors: TaxFormErrors = {};
  if (!form.authorityName.trim()) errors.authorityName = "Indica la autoridad que recauda el tributo.";
  if (form.taxBase.trim() && decimalInput(form.taxBase) === null) errors.taxBase = "Importe con dos decimales como máximo.";
  if (form.expectedAnnualAmount.trim() && decimalInput(form.expectedAnnualAmount) === null) errors.expectedAnnualAmount = "Importe con dos decimales como máximo.";
  if (form.ratePct.trim() && percentInput(form.ratePct) === null) errors.ratePct = "Porcentaje con cuatro decimales como máximo.";
  if (form.directDebit && form.directDebitBonusPct.trim() && decimalInput(form.directDebitBonusPct) === null) errors.directDebitBonusPct = "Porcentaje con dos decimales como máximo.";
  const from = form.voluntaryFrom.trim();
  const to = form.voluntaryTo.trim();
  if ((from && !to) || (!from && to)) errors.voluntaryTo = "Indica las dos fechas del periodo voluntario o ninguna.";
  if (from && !MONTH_DAY.test(from)) errors.voluntaryFrom = "Formato mes-día (10-01).";
  if (to && !MONTH_DAY.test(to)) errors.voluntaryTo = "Formato mes-día (11-30).";
  return errors;
}

/** Cuerpo del alta tal como viaja al API (importes normalizados; vacío → sin clave / null). */
export function taxRequestOf(form: TaxForm): PropertyTaxRequest {
  const from = form.voluntaryFrom.trim();
  const to = form.voluntaryTo.trim();
  const body: PropertyTaxRequest = {
    kind: form.kind,
    taxpayer: form.taxpayer,
    authorityName: form.authorityName.trim(),
    fiscalReference: form.fiscalReference.trim() || null,
    taxBase: decimalInput(form.taxBase),
    ratePct: percentInput(form.ratePct),
    expectedAnnualAmount: decimalInput(form.expectedAnnualAmount),
    periodicity: form.periodicity,
    directDebit: form.directDebit,
    directDebitBonusPct: form.directDebit ? decimalInput(form.directDebitBonusPct) : null
  };
  if (from && to) {
    body.voluntaryFrom = from;
    body.voluntaryTo = to;
  }
  return body;
}

export default RealEstateTaxesScreen;
