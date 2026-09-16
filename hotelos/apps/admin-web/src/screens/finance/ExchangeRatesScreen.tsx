// Tipos de cambio — Finanzas › Tesorería › Tipos de cambio
// (/finanzas/tesoreria/tipos-de-cambio, hosted in TesoreriaTabs). Cocoa 22 ·
// lote 6-C (migrated from the legacy `.bo-*` screen), archetype «formulario».
//
// GET /finance/exchange-rates[?base&quote&asOf] lists the historical rates
// (1 unit of the base currency = rate units of the quoted currency at the
// effective date); POST /finance/exchange-rates upserts one from the
// CocoaFormSection (validation in Spanish, save in the section footer so the
// history stays visible; ⌘/Ctrl+Enter through the page command). Rates keep
// up to eight decimals and are painted with lib/format.

import { useMemo, useState } from "react";
import { useApiData } from "../../hooks/useApiData";
import { apiRequest } from "../../services/api-client";
import { financeErrorMessage } from "../../services/finance-contracts";
import { useToast } from "../../components/Toast";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { date, number, plural } from "../../lib/format";
import { treeHeaderFor } from "../tabs/tab-helpers";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDatePicker,
  CocoaField,
  CocoaFormRow,
  CocoaFormSection,
  CocoaInput,
  CocoaPage,
  CocoaSection,
  CocoaState,
  CocoaTable,
  CocoaToolbar,
  type CocoaTableColumn
} from "../../components/cocoa";
import { todayIso } from "../accounting/accounting-ui";

type ExchangeRate = {
  id: string;
  baseCurrency: string;
  quoteCurrency: string;
  rate: number | string;
  effectiveDate: string;
  source?: string | null;
  organizationId?: string | null;
  createdAt: string;
};

const ISO_CURRENCY = /^[A-Z]{3}$/;

const COLUMNS: CocoaTableColumn<ExchangeRate>[] = [
  { key: "effectiveDate", label: "Fecha efectiva", width: "13ch", render: (row) => date(row.effectiveDate, "short") },
  { key: "baseCurrency", label: "Divisa base", render: (row) => <strong>{row.baseCurrency}</strong> },
  { key: "quoteCurrency", label: "Divisa cotizada", render: (row) => row.quoteCurrency },
  { key: "rate", label: "Tipo (1 base = ? cotizada)", align: "right", render: (row) => number(row.rate, { minimumFractionDigits: 4, maximumFractionDigits: 8 }) },
  { key: "source", label: "Fuente", render: (row) => row.source || "—", hideOnNarrow: true },
  { key: "scope", label: "Ámbito", render: (row) => (row.organizationId ? <CocoaBadge tone="accent">Organización</CocoaBadge> : <CocoaBadge tone="neutral">Global</CocoaBadge>), hideOnNarrow: true }
];

function normalizeCurrency(value: string): string {
  return value.replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 3);
}

export function ExchangeRatesScreen() {
  const header = treeHeaderFor("ExchangeRatesScreen", { eyebrow: "Finanzas · Tesorería", title: "Tipos de cambio" });
  const { showToast } = useToast();

  // ---- filters --------------------------------------------------------------------
  const [base, setBase] = useState("");
  const [quote, setQuote] = useState("");
  const [asOf, setAsOf] = useState("");
  const query = useMemo(() => {
    const q: Record<string, string> = {};
    if (base) q.base = base;
    if (quote) q.quote = quote;
    if (asOf) q.asOf = asOf;
    return q;
  }, [base, quote, asOf]);
  const { data, loading, error, refresh } = useApiData<ExchangeRate[]>("/finance/exchange-rates", { query });
  const rows = data ?? [];
  const filtered = base !== "" || quote !== "" || asOf !== "";

  // ---- form -------------------------------------------------------------------------
  const [formBase, setFormBase] = useState("USD");
  const [formQuote, setFormQuote] = useState("EUR");
  const [formRate, setFormRate] = useState("");
  const [formDate, setFormDate] = useState(() => todayIso());
  const [formSource, setFormSource] = useState("manual");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [touched, setTouched] = useState(false);

  const rateValue = Number(formRate.trim().replace(",", "."));
  const errors = {
    base: !ISO_CURRENCY.test(formBase) ? "Código ISO de tres letras (USD, GBP…)." : undefined,
    quote: !ISO_CURRENCY.test(formQuote) ? "Código ISO de tres letras (EUR…)." : formQuote === formBase ? "La divisa cotizada tiene que ser distinta de la base." : undefined,
    rate: formRate.trim() === "" || !Number.isFinite(rateValue) || rateValue <= 0 ? "El tipo es un número positivo (hasta ocho decimales)." : undefined,
    date: !/^\d{4}-\d{2}-\d{2}$/.test(formDate) ? "Indica la fecha efectiva." : undefined
  };
  const valid = !errors.base && !errors.quote && !errors.rate && !errors.date;

  async function save() {
    setTouched(true);
    if (!valid || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await apiRequest("/finance/exchange-rates", {
        method: "POST",
        body: { baseCurrency: formBase, quoteCurrency: formQuote, rate: formRate.trim().replace(",", "."), effectiveDate: formDate, source: formSource.trim() || null }
      });
      setFormRate("");
      setTouched(false);
      refresh();
      showToast(`Tipo ${formBase}/${formQuote} del ${date(formDate, "short")} guardado.`, { variant: "success" });
    } catch (err) {
      setSaveError(err);
      showToast(financeErrorMessage(err, STATUS_LABELS.saveError), { variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  const ready = !loading && !error && rows.length > 0;

  let body;
  if (loading && rows.length === 0) {
    body = <CocoaTable columns={COLUMNS} rows={[]} loading aria-label="Tipos de cambio" />;
  } else if (error) {
    body = <CocoaState kind="error" title="No se pudieron cargar los tipos de cambio" message={error} onRetry={refresh} />;
  } else if (rows.length === 0) {
    body = (
      <CocoaState
        kind="empty"
        illustration={filtered ? "search" : "box"}
        title={filtered ? STATUS_LABELS.noResults : "Sin tipos de cambio registrados"}
        message={filtered ? "Ningún tipo coincide con los filtros." : "Añade el primero con el formulario: las facturas en divisa consultan esta tabla al emitirse y guardan el tipo aplicado."}
        primaryAction={
          filtered
            ? {
                label: ACTIONS.clearFilters,
                onClick: () => {
                  setBase("");
                  setQuote("");
                  setAsOf("");
                }
              }
            : undefined
        }
      />
    );
  } else {
    body = <CocoaTable columns={COLUMNS} rows={rows} rowKey="id" density="compact" caption="Tipos de cambio" aria-label="Tipos de cambio" />;
  }

  return (
    <CocoaPage
      eyebrow={header.eyebrow}
      title={header.title}
      subtitle="Histórico de tipos de cambio: cada fila indica cuántas unidades de la divisa cotizada vale una unidad de la divisa base en la fecha efectiva."
      actions={
        <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh} loading={loading && rows.length > 0}>
          {ACTIONS.refresh}
        </CocoaButton>
      }
      commands={[
        { id: "exchange-rates-save", label: `${ACTIONS.save}: tipo de cambio`, run: () => void save(), shortcut: "⌘ Enter" },
        { id: "exchange-rates-refresh", label: "Actualizar los tipos de cambio", run: refresh }
      ]}
      id="exchange-rates-screen"
    >
      <CocoaFormSection
        title="Añadir tipo de cambio"
        description="Un tipo por par de divisas y fecha efectiva; volver a guardar el mismo par y fecha lo sustituye."
        actions={
          <CocoaButton variant="filled" tone="accent" loading={saving} disabled={saving || (touched && !valid)} onClick={() => void save()}>
            {saving ? STATUS_LABELS.saving : "Guardar tipo"}
          </CocoaButton>
        }
      >
        <CocoaFormRow columns={3} min={140}>
          <CocoaField label="Divisa base" required error={touched ? errors.base : undefined}>
            <CocoaInput value={formBase} onChange={(value) => setFormBase(normalizeCurrency(value))} placeholder="USD" maxLength={3} autoComplete="off" />
          </CocoaField>
          <CocoaField label="Divisa cotizada" required error={touched ? errors.quote : undefined}>
            <CocoaInput value={formQuote} onChange={(value) => setFormQuote(normalizeCurrency(value))} placeholder="EUR" maxLength={3} autoComplete="off" />
          </CocoaField>
          <CocoaField label="Tipo" required error={touched ? errors.rate : undefined} help={ISO_CURRENCY.test(formBase) && ISO_CURRENCY.test(formQuote) ? `1 ${formBase} = tipo × ${formQuote}` : undefined}>
            <CocoaInput value={formRate} onChange={setFormRate} inputMode="decimal" placeholder="0,92" />
          </CocoaField>
          <CocoaField label="Fecha efectiva" required error={touched ? errors.date : undefined}>
            <CocoaDatePicker value={formDate} onChange={setFormDate} />
          </CocoaField>
          <CocoaField label="Fuente" hint="opcional" help="Quién publicó el tipo: manual, BCE, banco…">
            <CocoaInput value={formSource} onChange={setFormSource} placeholder="manual" maxLength={40} />
          </CocoaField>
        </CocoaFormRow>
        {saveError ? (
          <CocoaCallout tone="danger" title={STATUS_LABELS.saveError} role="alert">
            {financeErrorMessage(saveError)}
          </CocoaCallout>
        ) : null}
      </CocoaFormSection>

      <CocoaToolbar
        variant="content"
        wrap
        aria-label="Filtros del histórico"
        leftSlot={
          <div className="cocoa-row" data-gap="2" data-align="end">
            <CocoaField label="Divisa base">
              <CocoaInput value={base} onChange={(value) => setBase(normalizeCurrency(value))} placeholder="Todas" maxLength={3} size="small" aria-label="Filtrar por divisa base" />
            </CocoaField>
            <CocoaField label="Divisa cotizada">
              <CocoaInput value={quote} onChange={(value) => setQuote(normalizeCurrency(value))} placeholder="Todas" maxLength={3} size="small" aria-label="Filtrar por divisa cotizada" />
            </CocoaField>
            <CocoaField label="Vigentes a">
              <CocoaDatePicker value={asOf} onChange={setAsOf} size="small" aria-label="Tipos vigentes a la fecha" />
            </CocoaField>
          </div>
        }
        rightSlot={
          filtered ? (
            <CocoaButton
              variant="plain"
              tone="neutral"
              size="small"
              onClick={() => {
                setBase("");
                setQuote("");
                setAsOf("");
              }}
            >
              {ACTIONS.clearFilters}
            </CocoaButton>
          ) : undefined
        }
      />

      <CocoaSection title="Histórico" meta={ready ? plural(rows.length, "tipo", "tipos") : undefined} padding={ready ? "none" : "md"} style={{ overflow: "clip" }} aria-label="Histórico de tipos de cambio">
        {body}
      </CocoaSection>
    </CocoaPage>
  );
}

export default ExchangeRatesScreen;
