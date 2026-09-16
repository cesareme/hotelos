// Extractos y remesas — Finanzas › Conciliación bancaria › Extractos y remesas
// (/finanzas/conciliacion/extractos-remesas, hosted in ConciliacionTabs).
//
// Cocoa 22 (docs/design/COCOA-22.md §4, «DashboardAlojado» with two inner
// views selected by the page tabs):
//   · «Extractos Cuaderno 43»: the AEB Cuaderno 43 file of the bank is
//     imported through POST /properties/:id/banking/csb43/import (persisted;
//     `Csb43ImportResult` reports per account `persisted`, `newLines`,
//     `duplicateLines`, `warnings` and the suggested `matches[].matchType`);
//     the bank account can be pinned or resolved by the IBAN of the file.
//   · «Remesas SEPA»: persisted remittances (Norma 19 direct debits and Norma
//     34 transfers) with their status (generada → enviada → aceptada |
//     rechazada · cancelada) from GET /treasury/sepa/remittances; a Norma 19
//     remittance is built in a drawer and created with POST
//     /treasury/sepa/remittances (the XML is downloaded from the answer).
// Hosted: the container paints eyebrow and title. Writes need banking.reconcile.

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import type { Csb43ImportAccount, SepaNorma19Request, SepaRemittanceStatus } from "@hotelos/shared";
import { useApiData } from "../../hooks/useApiData";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { importCsb43, validateIban, type Csb43ImportResult } from "../../services/bankingApi";
import { createSepaRemittance, getSepaRemittance, listSepaRemittances, treasuryErrorMessage, updateSepaRemittanceStatus, type SepaRemittanceRecord } from "../../services/treasuryApi";
import { useToast } from "../../components/Toast";
import { useTabHost } from "../tabs/TabHost";
import { toArray } from "../../utils/toArray";
import { ACTIONS, STATUS_LABELS, newLabel } from "../../content/actions";
import { date, dateRange, dateTime, isoDate, money, number, plural, toNumber } from "../../lib/format";
import { DownloadIcon, PlusIcon } from "../../components/cocoa-icons/ActionIcons";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDialog,
  CocoaDrawer,
  CocoaField,
  CocoaFileInput,
  CocoaFormRow,
  CocoaFormSection,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaSkeleton,
  CocoaState,
  CocoaSwitch,
  CocoaTable,
  toneInk,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

type View = "statements" | "remittances";

type BankAccountOption = { id: string; name: string; bankName: string | null; iban: string | null };

type Movement = Csb43ImportAccount["movements"][number] & { index: number; match: Csb43ImportAccount["matches"][number] | null };

type Debtor = { mandateId: string; mandateSignedAt: string; name: string; iban: string; amount: string; description: string; endToEndId: string };

const MATCH_TYPE_LABEL: Record<string, string> = {
  payment: "Cobro del hotel",
  card_settlement: "Liquidación de datáfono",
  supplier_bill: "Factura recibida",
  payroll_period: "Nómina",
  commission_accrual: "Comisión de canal",
  bank_fee: "Comisión bancaria",
  bank_interest: "Intereses bancarios",
  manual: "Manual"
};
const CONFIDENCE_LABEL: Record<string, string> = { high: "alta", medium: "media", low: "baja" };
const CONFIDENCE_TONE: Record<string, CocoaTone> = { high: "success", medium: "warning", low: "neutral" };

const REMITTANCE_STATUS_LABEL: Record<SepaRemittanceStatus, string> = { generated: "Generada", sent: "Enviada al banco", accepted: "Aceptada", rejected: "Rechazada", cancelled: "Cancelada" };
const REMITTANCE_STATUS_TONE: Record<SepaRemittanceStatus, CocoaTone> = { generated: "info", sent: "warning", accepted: "success", rejected: "danger", cancelled: "neutral" };
const REMITTANCE_KIND_LABEL: Record<SepaRemittanceRecord["kind"], string> = { norma19: "Norma 19 · adeudos", norma34: "Norma 34 · transferencias" };
/** Allowed status transitions (the API answers REMITTANCE_STATUS_TRANSITION otherwise). */
const NEXT_STATUS: Record<SepaRemittanceStatus, Array<{ status: SepaRemittanceStatus; label: string; destructive: boolean }>> = {
  generated: [
    { status: "sent", label: "Marcar enviada", destructive: false },
    { status: "cancelled", label: "Cancelar", destructive: true }
  ],
  sent: [
    { status: "accepted", label: "Marcar aceptada", destructive: false },
    { status: "rejected", label: "Marcar rechazada", destructive: true },
    { status: "cancelled", label: "Cancelar", destructive: true }
  ],
  accepted: [],
  rejected: [],
  cancelled: []
};

const SCHEMA_OPTIONS = [
  { value: "CORE", label: "CORE · consumidores" },
  { value: "B2B", label: "B2B · empresas" }
];
const SEQUENCE_OPTIONS = [
  { value: "OOFF", label: "Adeudo único (OOFF)" },
  { value: "FRST", label: "Primero de una serie (FRST)" },
  { value: "RCUR", label: "Recurrente (RCUR)" },
  { value: "FNAL", label: "Último de la serie (FNAL)" }
];

function emptyDebtor(index: number): Debtor {
  return { mandateId: "", mandateSignedAt: "", name: "", iban: "", amount: "", description: "", endToEndId: `REF-${String(index).padStart(3, "0")}` };
}

function plusDays(days: number): string {
  return isoDate(new Date(Date.now() + days * 86_400_000)) ?? "";
}

function downloadXml(filename: string, xml: string) {
  const blob = new Blob([xml], { type: "application/xml" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Text styles (tokens only).
const captionStyle: CSSProperties = { display: "block", fontSize: "var(--cocoa-fs-caption)", color: "var(--cocoa-label-secondary)" };
const secondaryStyle: CSSProperties = { color: "var(--cocoa-label-secondary)" };

function amountStyle(value: number): CSSProperties {
  const tone: CocoaTone = Math.abs(value) < 0.005 ? "neutral" : value < 0 ? "danger" : "success";
  return { color: tone === "neutral" ? "var(--cocoa-label)" : toneInk(tone) };
}

function movementColumns(currency: string): CocoaTableColumn<Movement>[] {
  return [
    { key: "operationDate", label: "Fecha", width: "11ch", render: (m) => date(m.operationDate, "short") },
    {
      key: "concept",
      label: "Concepto",
      render: (m) => (
        <>
          <span>{m.descriptions[0] ?? `Concepto ${m.conceptCode}`}</span>
          {m.referenceA || m.referenceB || m.descriptions[1] ? (
            <span style={captionStyle}>
              {[m.descriptions[1], m.referenceB ? `ref. ${m.referenceB}` : null, m.referenceA ? `ref. ${m.referenceA}` : null].filter(Boolean).join(" · ")}
            </span>
          ) : null}
        </>
      )
    },
    { key: "amount", label: "Importe", align: "right", render: (m) => <strong style={amountStyle(m.amount)}>{money(m.amount, currency)}</strong> },
    { key: "runningBalance", label: "Saldo", align: "right", hideOnNarrow: true, render: (m) => money(m.runningBalance, currency) },
    {
      key: "match",
      label: "Coincidencia",
      render: (m) =>
        m.match ? (
          <span className="cocoa-cluster">
            <CocoaBadge tone="success" size="small" title={m.match.reason}>
              {MATCH_TYPE_LABEL[m.match.matchType] ?? m.match.matchType}
            </CocoaBadge>
            <CocoaBadge tone={CONFIDENCE_TONE[m.match.confidence] ?? "neutral"} size="small" variant="tinted">
              confianza {CONFIDENCE_LABEL[m.match.confidence] ?? m.match.confidence}
            </CocoaBadge>
          </span>
        ) : (
          <span style={secondaryStyle}>—</span>
        )
    }
  ];
}

const REMITTANCE_COLUMNS: CocoaTableColumn<SepaRemittanceRecord>[] = [
  {
    key: "messageId",
    label: "Remesa",
    render: (r) => (
      <>
        <strong>{r.messageId}</strong>
        <span style={captionStyle}>
          {REMITTANCE_KIND_LABEL[r.kind] ?? r.kind} · creada {dateTime(r.createdAt)}
        </span>
      </>
    )
  },
  { key: "executionDate", label: "Fecha de cargo", hideOnNarrow: true, render: (r) => date(r.executionDate, "short") },
  { key: "transactions", label: "Operaciones", align: "right", hideOnNarrow: true, render: (r) => number(r.transactions) },
  { key: "totalAmount", label: "Importe", align: "right", render: (r) => <strong>{money(r.totalAmount)}</strong> },
  {
    key: "status",
    label: "Estado",
    render: (r) => (
      <span className="cocoa-cluster">
        <CocoaBadge tone={REMITTANCE_STATUS_TONE[r.status] ?? "neutral"} size="small">
          {REMITTANCE_STATUS_LABEL[r.status] ?? r.status}
        </CocoaBadge>
        {r.warnings.length > 0 ? (
          <CocoaBadge tone="warning" size="small" variant="tinted" title={r.warnings.join(" · ")}>
            {plural(r.warnings.length, "aviso", "avisos")}
          </CocoaBadge>
        ) : null}
      </span>
    )
  }
];

function BankingSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton variant="card" height={260} />
      <CocoaSkeleton variant="card" height={200} />
    </div>
  );
}

export function BankingSpainScreen() {
  const hosted = useTabHost() !== null;
  const propertyId = getActivePropertyId();
  const propertyName = getActiveProperty().propertyName;
  const { showToast } = useToast();
  const [view, setView] = useState<View>("statements");

  const accountsState = useApiData<BankAccountOption[]>("/banking/accounts", { query: { propertyId } });
  const accounts = toArray<BankAccountOption>(accountsState.data);

  // ---- CSB43 import ----
  const [bankAccountId, setBankAccountId] = useState("");
  const [content, setContent] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [autoMatch, setAutoMatch] = useState(true);
  const [createMissingAccount, setCreateMissingAccount] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [result, setResult] = useState<Csb43ImportResult | null>(null);

  async function handleFile(file: File) {
    setContent(await file.text());
    setFileName(file.name);
  }

  async function runImport() {
    if (content.trim() === "" || importing) return;
    setImporting(true);
    setImportError(null);
    try {
      const imported = await importCsb43(propertyId, content, { bankAccountId: bankAccountId || null, autoMatch, createMissingAccount });
      setResult(imported);
      const newLines = imported.accounts.reduce((sum, account) => sum + account.newLines, 0);
      showToast(newLines > 0 ? `${plural(newLines, "movimiento importado", "movimientos importados")}` : "Nada nuevo que importar", { variant: newLines > 0 ? "success" : "warning" });
      setContent("");
      setFileName(null);
      accountsState.refresh();
    } catch (err) {
      setImportError(treasuryErrorMessage(err, "No se pudo importar el fichero Cuaderno 43."));
    } finally {
      setImporting(false);
    }
  }

  // ---- SEPA remittances ----
  const [remittances, setRemittances] = useState<SepaRemittanceRecord[] | null>(null);
  const [remittancesError, setRemittancesError] = useState<string | null>(null);
  const [remittancesLoading, setRemittancesLoading] = useState(false);

  const loadRemittances = useCallback(() => {
    setRemittancesLoading(true);
    listSepaRemittances({ propertyId })
      .then((items) => {
        setRemittances(items);
        setRemittancesError(null);
      })
      .catch((err: unknown) => setRemittancesError(treasuryErrorMessage(err, "No se pudieron cargar las remesas.")))
      .finally(() => setRemittancesLoading(false));
  }, [propertyId]);

  useEffect(() => {
    loadRemittances();
  }, [loadRemittances]);

  const [downloading, setDownloading] = useState<string | null>(null);
  async function downloadRemittance(remittance: SepaRemittanceRecord) {
    setDownloading(remittance.id);
    try {
      const detail = remittance.xml ? remittance : await getSepaRemittance(remittance.id);
      if (!detail.xml) throw new Error("La remesa no conserva el fichero XML.");
      downloadXml(`${detail.messageId}.xml`, detail.xml);
    } catch (err) {
      showToast(treasuryErrorMessage(err, "No se pudo descargar el fichero."), { variant: "error" });
    } finally {
      setDownloading(null);
    }
  }

  const [statusTarget, setStatusTarget] = useState<{ remittance: SepaRemittanceRecord; status: SepaRemittanceStatus; label: string; destructive: boolean } | null>(null);
  const [statusNote, setStatusNote] = useState("");
  const [statusBusy, setStatusBusy] = useState(false);

  async function changeStatus() {
    if (!statusTarget) return;
    setStatusBusy(true);
    try {
      await updateSepaRemittanceStatus(statusTarget.remittance.id, { status: statusTarget.status, note: statusNote.trim() || undefined });
      showToast(`Remesa ${statusTarget.remittance.messageId}: ${REMITTANCE_STATUS_LABEL[statusTarget.status].toLowerCase()}`, { variant: "success" });
      setStatusTarget(null);
      setStatusNote("");
      loadRemittances();
    } catch (err) {
      showToast(treasuryErrorMessage(err, "No se pudo cambiar el estado de la remesa."), { variant: "error" });
    } finally {
      setStatusBusy(false);
    }
  }

  // ---- new Norma 19 remittance (drawer) ----
  const [remittanceOpen, setRemittanceOpen] = useState(false);
  const [remittanceAccountId, setRemittanceAccountId] = useState("");
  const [creditorName, setCreditorName] = useState("");
  const [creditorId, setCreditorId] = useState("");
  const [creditorIban, setCreditorIban] = useState("");
  const [creditorBic, setCreditorBic] = useState("");
  const [schema, setSchema] = useState("CORE");
  const [sequenceType, setSequenceType] = useState("OOFF");
  const [collectionDate, setCollectionDate] = useState(() => plusDays(7));
  const [debtors, setDebtors] = useState<Debtor[]>([emptyDebtor(1)]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [created, setCreated] = useState<SepaRemittanceRecord | null>(null);

  function updateDebtor(index: number, patch: Partial<Debtor>) {
    setDebtors((current) => current.map((debtor, i) => (i === index ? { ...debtor, ...patch } : debtor)));
  }

  const debtorTotal = debtors.reduce((sum, debtor) => sum + (toNumber(debtor.amount) ?? 0), 0);
  const creditorErrors = {
    name: creditorName.trim() === "" ? "El nombre del acreedor es obligatorio." : undefined,
    id: creditorId.trim().length < 8 ? "El identificador de acreedor SEPA tiene al menos 8 caracteres." : undefined,
    iban: creditorIban.replace(/\s+/g, "").length < 15 ? "Indica el IBAN de la cuenta de abono." : undefined,
    date: collectionDate === "" ? "Indica la fecha de cargo." : undefined
  };
  const debtorErrors = debtors.map((debtor) => ({
    name: debtor.name.trim() === "" ? "Nombre obligatorio." : undefined,
    iban: debtor.iban.replace(/\s+/g, "").length < 15 ? "IBAN obligatorio." : undefined,
    mandateId: debtor.mandateId.trim() === "" ? "Mandato obligatorio." : undefined,
    mandateSignedAt: debtor.mandateSignedAt === "" ? "Fecha de firma obligatoria." : undefined,
    amount: (toNumber(debtor.amount) ?? 0) <= 0 ? "Importe positivo." : undefined,
    description: debtor.description.trim() === "" ? "Concepto obligatorio." : undefined,
    endToEndId: debtor.endToEndId.trim() === "" ? "Referencia obligatoria." : undefined
  }));
  const remittanceValid = Object.values(creditorErrors).every((e) => e === undefined) && debtorErrors.every((errors) => Object.values(errors).every((e) => e === undefined));

  async function createRemittance() {
    if (!remittanceValid || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const iban = creditorIban.replace(/\s+/g, "").toUpperCase();
      const valid = await validateIban(iban);
      if (!valid.valid) throw new Error("El IBAN del acreedor no supera el control de dígitos (mod-97).");
      const body: SepaNorma19Request = {
        schema: schema as SepaNorma19Request["schema"],
        collectionDate,
        sequenceType: sequenceType as SepaNorma19Request["sequenceType"],
        creditor: { name: creditorName.trim(), creditorId: creditorId.trim(), iban, ...(creditorBic.trim() ? { bic: creditorBic.trim().toUpperCase() } : {}) },
        debtors: debtors.map((debtor) => ({
          mandateId: debtor.mandateId.trim(),
          mandateSignedAt: debtor.mandateSignedAt,
          name: debtor.name.trim(),
          iban: debtor.iban.replace(/\s+/g, "").toUpperCase(),
          amount: debtor.amount.trim().replace(",", "."),
          description: debtor.description.trim(),
          endToEndId: debtor.endToEndId.trim()
        }))
      };
      const record = await createSepaRemittance({ kind: "norma19", bankAccountId: remittanceAccountId || undefined, body });
      setCreated(record);
      showToast(`Remesa ${record.messageId} generada`, { variant: "success" });
      loadRemittances();
    } catch (err) {
      setCreateError(treasuryErrorMessage(err, "No se pudo generar la remesa."));
    } finally {
      setCreating(false);
    }
  }

  function closeRemittanceDrawer() {
    setRemittanceOpen(false);
    if (created) {
      setCreated(null);
      setDebtors([emptyDebtor(1)]);
      setCreateError(null);
    }
  }

  // ---- derived ----
  const list = toArray<SepaRemittanceRecord>(remittances);
  const newRemittanceLabel = newLabel("f", "remesa");
  const accountOptions = [{ value: "", label: "Detectar por el IBAN del fichero" }, ...accounts.map((a) => ({ value: a.id, label: `${a.name}${a.bankName ? ` · ${a.bankName}` : ""}${a.iban ? ` · ${a.iban}` : ""}` }))];
  const remittanceAccountOptions = [{ value: "", label: "Sin asociar (por el IBAN del acreedor)" }, ...accounts.map((a) => ({ value: a.id, label: `${a.name}${a.iban ? ` · ${a.iban}` : ""}` }))];
  const state = accountsState.loading && !accountsState.data && remittances === null && remittancesLoading ? "loading" : "ready";
  const globalWarnings = toArray<string>(result?.warnings);
  const unmatchedPayments = toArray<string>(result?.unmatchedPayments);

  return (
    <CocoaPage
      eyebrow={`Finanzas · ${propertyName}`}
      title="Extractos y remesas"
      subtitle={hosted ? undefined : "Importa los extractos AEB Cuaderno 43 que emite tu banco y genera remesas SEPA de adeudos (Norma 19) con seguimiento de su estado."}
      actions={
        <>
          {accountsState.loading || remittancesLoading ? <CocoaBadge tone="info">{STATUS_LABELS.loading}</CocoaBadge> : null}
          <CocoaButton
            variant="bordered"
            tone="neutral"
            size="small"
            onClick={() => {
              accountsState.refresh();
              loadRemittances();
            }}
          >
            {ACTIONS.refresh}
          </CocoaButton>
          <CocoaButton variant="filled" tone="accent" size="small" icon={<PlusIcon size={14} aria-hidden="true" />} onClick={() => setRemittanceOpen(true)}>
            {newRemittanceLabel}
          </CocoaButton>
        </>
      }
      tabs={[
        { value: "statements", label: "Extractos Cuaderno 43" },
        { value: "remittances", label: `Remesas SEPA${remittances ? ` (${number(list.length)})` : ""}` }
      ]}
      activeTab={view}
      onTabChange={(value) => setView(value as View)}
      state={state}
      skeleton={<BankingSkeleton />}
      commands={[
        { id: "banking-spain-new-remittance", label: newRemittanceLabel, run: () => setRemittanceOpen(true) },
        { id: "banking-spain-import", label: "Importar extracto Cuaderno 43", run: () => setView("statements") }
      ]}
    >
      {view === "statements" ? (
        <>
          <CocoaSection title="Importar extracto Cuaderno 43" meta="texto fijo de 80 columnas · los duplicados no se repiten" headingLevel={2}>
            <CocoaFormRow columns={2}>
              <CocoaField label="Cuenta bancaria" help={accounts.length === 0 ? "Sin cuentas registradas: la cuenta se crea con el IBAN del fichero si lo permites." : "Fija la cuenta o deja que se reconozca por el IBAN del registro de cabecera."}>
                <CocoaSelect value={bankAccountId} onChange={setBankAccountId} options={accountOptions} />
              </CocoaField>
              <CocoaField label="Buscar coincidencias al importar" inline help="Sugiere cobros y liquidaciones de datáfono para cada movimiento nuevo.">
                <CocoaSwitch checked={autoMatch} onChange={setAutoMatch} size="small" />
              </CocoaField>
              <CocoaField label="Crear la cuenta si el IBAN es nuevo" inline help="Desactívalo para que un IBAN desconocido se reporte en vez de crearse.">
                <CocoaSwitch checked={createMissingAccount} onChange={setCreateMissingAccount} size="small" />
              </CocoaField>
              <CocoaField label="Contenido del fichero" fullWidth help="Elige el fichero .n43 / .txt del banco o pega su contenido.">
                <CocoaInput value={content} onChange={setContent} multiline rows={6} placeholder={"11…\n22…\n23…\n33…\n88…"} />
              </CocoaField>
            </CocoaFormRow>
            <div className="cocoa-row" data-gap="2">
              <CocoaFileInput accept=".n43,.txt,.csb,.dat,text/plain" fileName={fileName} onPick={(file) => void handleFile(file)} onReject={(message) => showToast(message, { variant: "error" })} />
              <CocoaButton variant="filled" tone="accent" size="small" onClick={() => void runImport()} loading={importing} disabled={content.trim() === "" || importing}>
                Importar y buscar coincidencias
              </CocoaButton>
              {content ? <span style={secondaryStyle}>{plural(content.split(/\r?\n/).filter((line) => line.trim() !== "").length, "registro", "registros")}</span> : null}
            </div>
            {importError ? (
              <CocoaCallout tone="danger" title="No se pudo importar" role="alert">
                {importError}
              </CocoaCallout>
            ) : null}
            {globalWarnings.length > 0 ? (
              <CocoaCallout tone="warning" title="Avisos del fichero" role="status">
                <ul className="c22-section__list">
                  {globalWarnings.map((warning, index) => (
                    <li key={index}>
                      <span>{warning}</span>
                    </li>
                  ))}
                </ul>
              </CocoaCallout>
            ) : null}
          </CocoaSection>

          {result
            ? result.accounts.map((account, accountIndex) => {
                const movements: Movement[] = account.movements.map((movement, index) => ({ ...movement, index, match: account.matches.find((m) => m.movementIndex === index) ?? null }));
                return (
                  <CocoaSection
                    key={`${account.iban}-${accountIndex}`}
                    title={`Banco ${account.bankCode} · sucursal ${account.branchCode} · …${account.accountNumber.slice(-4)}`}
                    meta={
                      <span className="cocoa-cluster">
                        {dateRange(account.fromDate, account.toDate)}
                        <CocoaBadge tone={account.persisted ? "success" : "warning"} size="small">
                          {account.persisted ? "Guardado" : "No guardado"}
                        </CocoaBadge>
                      </span>
                    }
                    headingLevel={2}
                    padding={movements.length > 0 ? "none" : "md"}
                    style={{ overflow: "clip" }}
                  >
                    <div className="cocoa-stack" data-gap="3" style={movements.length > 0 ? { padding: "var(--cocoa-space-4) var(--cocoa-space-4) 0" } : undefined}>
                      {account.ownerName ? <span style={secondaryStyle}>Titular: {account.ownerName} · {account.iban}</span> : <span style={secondaryStyle}>{account.iban}</span>}
                      <CocoaKpiStrip min={180} aria-label={`Resumen del extracto …${account.accountNumber.slice(-4)}`}>
                        <CocoaKpi label="Saldo inicial" value={money(account.initialBalance, account.currency)} size="compact" polarity="neutral" />
                        <CocoaKpi label="Saldo final" value={money(account.finalBalance, account.currency)} size="compact" polarity="neutral" />
                        <CocoaKpi label="Movimientos" value={number(account.movements.length)} size="compact" polarity="neutral" />
                        <CocoaKpi label="Nuevos" value={number(account.newLines)} size="compact" polarity="neutral" status={account.newLines === 0 ? "warning" : "ok"} />
                        <CocoaKpi label="Duplicados omitidos" value={number(account.duplicateLines)} size="compact" polarity="neutral" />
                        <CocoaKpi label="Coincidencias sugeridas" value={number(account.matches.length)} size="compact" polarity="neutral" deltaLabel={plural(account.unmatchedMovementIdxs.length, "sin coincidencia", "sin coincidencia")} />
                      </CocoaKpiStrip>
                      {account.warnings.length > 0 ? (
                        <CocoaCallout tone="warning" title="Avisos de la cuenta">
                          <ul className="c22-section__list">
                            {account.warnings.map((warning, index) => (
                              <li key={index}>
                                <span>{warning}</span>
                              </li>
                            ))}
                          </ul>
                        </CocoaCallout>
                      ) : null}
                    </div>
                    {movements.length === 0 ? (
                      <CocoaState kind="empty" inline title="El fichero no trae movimientos para esta cuenta." />
                    ) : (
                      <CocoaTable columns={movementColumns(account.currency)} rows={movements} rowKey={(m) => `${m.index}-${m.fingerprint}`} density="compact" caption="Movimientos del extracto" aria-label="Movimientos del extracto" />
                    )}
                  </CocoaSection>
                );
              })
            : null}

          {result && unmatchedPayments.length > 0 ? (
            <CocoaSection title="Cobros del hotel sin reflejo en el extracto" meta={plural(unmatchedPayments.length, "cobro", "cobros")} headingLevel={2}>
              <span style={secondaryStyle}>Capturados en el hotel pero no encontrados en el fichero: revisa fechas de abono o referencias del banco.</span>
              <ul className="c22-section__list" aria-label="Cobros sin reflejo en el extracto">
                {unmatchedPayments.map((paymentId) => (
                  <li key={paymentId}>
                    <span>{paymentId}</span>
                  </li>
                ))}
              </ul>
            </CocoaSection>
          ) : null}

          {!result ? (
            <CocoaSection aria-label="Cómo funciona la importación" variant="plain">
              <CocoaState
                kind="empty"
                inline
                title="El resultado de la importación aparece aquí: saldos, movimientos nuevos y duplicados, y las coincidencias sugeridas con los cobros del hotel. Después, concilia cada movimiento en la pestaña «Conciliación bancaria»."
              />
            </CocoaSection>
          ) : null}
        </>
      ) : null}

      {view === "remittances" ? (
        <CocoaSection
          title="Remesas SEPA"
          meta="generada → enviada → aceptada o rechazada · cancelada"
          headingLevel={2}
          action={
            <CocoaButton variant="plain" tone="accent" size="small" onClick={() => setRemittanceOpen(true)}>
              {newRemittanceLabel}
            </CocoaButton>
          }
          padding={list.length > 0 ? "none" : "md"}
          style={{ overflow: "clip" }}
        >
          {remittancesError && remittances === null ? (
            <CocoaState kind="error" title="No se pudieron cargar las remesas" message={remittancesError} onRetry={loadRemittances} />
          ) : remittances === null ? (
            <CocoaTable columns={REMITTANCE_COLUMNS} rows={[]} loading aria-label="Remesas SEPA" />
          ) : list.length === 0 ? (
            <CocoaState
              kind="empty"
              title="Aún no hay remesas"
              message="Genera una remesa de adeudos Norma 19 para los clientes con mandato. Las transferencias a proveedores (Norma 34) se preparan desde las facturas recibidas contabilizadas."
              primaryAction={{ label: newRemittanceLabel, onClick: () => setRemittanceOpen(true) }}
            />
          ) : (
            <CocoaTable
              columns={REMITTANCE_COLUMNS}
              rows={list}
              rowKey="id"
              rowActions={(r) => (
                <span className="cocoa-cluster">
                  <CocoaButton
                    variant="plain"
                    tone="neutral"
                    size="small"
                    icon={<DownloadIcon size={14} aria-hidden="true" />}
                    loading={downloading === r.id}
                    onClick={(event) => {
                      event.stopPropagation();
                      void downloadRemittance(r);
                    }}
                  >
                    XML
                  </CocoaButton>
                  {NEXT_STATUS[r.status].map((next) => (
                    <CocoaButton
                      key={next.status}
                      variant="plain"
                      tone={next.destructive ? "destructive" : "accent"}
                      size="small"
                      onClick={(event) => {
                        event.stopPropagation();
                        setStatusNote("");
                        setStatusTarget({ remittance: r, status: next.status, label: next.label, destructive: next.destructive });
                      }}
                    >
                      {next.label}
                    </CocoaButton>
                  ))}
                </span>
              )}
              caption="Remesas SEPA"
              aria-label="Remesas SEPA"
            />
          )}
        </CocoaSection>
      ) : null}

      {/* Cambio de estado */}
      <CocoaDialog
        open={statusTarget !== null}
        onClose={() => setStatusTarget(null)}
        tone={statusTarget?.destructive ? "destructive" : "primary"}
        title={statusTarget ? `${statusTarget.label}: ${statusTarget.remittance.messageId}` : "Cambiar estado"}
        description={
          statusTarget
            ? `${money(statusTarget.remittance.totalAmount)} en ${plural(statusTarget.remittance.transactions, "operación", "operaciones")} con cargo el ${date(statusTarget.remittance.executionDate, "short")}. El cambio queda en el historial de la remesa.`
            : undefined
        }
        confirmLabel={statusTarget?.label ?? ACTIONS.confirm}
        cancelLabel={ACTIONS.cancel}
        busy={statusBusy}
        onConfirm={changeStatus}
      >
        <CocoaField label="Nota" hint="opcional">
          <CocoaInput value={statusNote} onChange={setStatusNote} placeholder="Referencia del banco, motivo del rechazo…" maxLength={500} />
        </CocoaField>
      </CocoaDialog>

      {/* Nueva remesa Norma 19 */}
      <CocoaDrawer
        open={remittanceOpen}
        onClose={closeRemittanceDrawer}
        title={created ? `Remesa ${created.messageId}` : "Nueva remesa de adeudos (Norma 19)"}
        subtitle={created ? "Generada y guardada: descarga el fichero y súbelo al banco; después marca la remesa como enviada." : "Adeudos directos SEPA (pain.008) a clientes y empresas con mandato firmado. La remesa se guarda con su estado."}
        side="right"
        size="lg"
        footer={
          created ? (
            <>
              <CocoaButton variant="bordered" tone="neutral" onClick={closeRemittanceDrawer}>
                {ACTIONS.close}
              </CocoaButton>
              <CocoaButton variant="filled" tone="accent" icon={<DownloadIcon size={14} aria-hidden="true" />} onClick={() => void downloadRemittance(created)}>
                Descargar XML
              </CocoaButton>
            </>
          ) : (
            <>
              <CocoaButton variant="bordered" tone="neutral" onClick={closeRemittanceDrawer} disabled={creating}>
                {ACTIONS.cancel}
              </CocoaButton>
              <CocoaButton variant="filled" tone="accent" onClick={() => void createRemittance()} loading={creating} disabled={!remittanceValid || creating}>
                {creating ? "Generando…" : "Generar remesa"}
              </CocoaButton>
            </>
          )
        }
      >
        {created ? (
          <div className="cocoa-stack" data-gap="3">
            <CocoaCallout tone="success" title="Remesa generada" role="status">
              {money(created.totalAmount)} en {plural(created.transactions, "adeudo", "adeudos")} con fecha de cargo {date(created.executionDate, "short")}.
            </CocoaCallout>
            {created.warnings.length > 0 ? (
              <CocoaCallout tone="warning" title="Avisos">
                <ul className="c22-section__list">
                  {created.warnings.map((warning, index) => (
                    <li key={index}>
                      <span>{warning}</span>
                    </li>
                  ))}
                </ul>
              </CocoaCallout>
            ) : null}
          </div>
        ) : (
          <>
            <CocoaFormSection title="Acreedor (el hotel)" description="Los datos SEPA que te ha asignado tu banco.">
              <CocoaFormRow columns={2}>
                <CocoaField label="Nombre" required error={creditorName === "" ? undefined : creditorErrors.name}>
                  <CocoaInput value={creditorName} onChange={setCreditorName} placeholder={propertyName} maxLength={70} autoFocus />
                </CocoaField>
                <CocoaField label="Identificador de acreedor SEPA" required error={creditorId === "" ? undefined : creditorErrors.id} help="Lo asigna el banco (ES + 2 dígitos de control + sufijo + NIF).">
                  <CocoaInput value={creditorId} onChange={setCreditorId} placeholder="ES00000A00000000" maxLength={35} />
                </CocoaField>
                <CocoaField label="IBAN de abono" required error={creditorIban === "" ? undefined : creditorErrors.iban}>
                  <CocoaInput value={creditorIban} onChange={setCreditorIban} placeholder="ES00 0000 0000 0000 0000 0000" maxLength={34} />
                </CocoaField>
                <CocoaField label="BIC" hint="opcional">
                  <CocoaInput value={creditorBic} onChange={setCreditorBic} maxLength={11} />
                </CocoaField>
                <CocoaField label="Cuenta bancaria del hotel" help="Asocia la remesa a una cuenta registrada; si no, se busca por el IBAN de abono.">
                  <CocoaSelect value={remittanceAccountId} onChange={setRemittanceAccountId} options={remittanceAccountOptions} />
                </CocoaField>
                <CocoaField label="Esquema" required>
                  <CocoaSelect value={schema} onChange={setSchema} options={SCHEMA_OPTIONS} />
                </CocoaField>
                <CocoaField label="Secuencia" required>
                  <CocoaSelect value={sequenceType} onChange={setSequenceType} options={SEQUENCE_OPTIONS} />
                </CocoaField>
                <CocoaField label="Fecha de cargo" required error={creditorErrors.date}>
                  <CocoaInput value={collectionDate} onChange={setCollectionDate} type="date" min={isoDate(new Date()) ?? undefined} />
                </CocoaField>
              </CocoaFormRow>
            </CocoaFormSection>

            {debtors.map((debtor, index) => {
              const errors = debtorErrors[index];
              return (
                <CocoaFormSection
                  key={index}
                  title={`Deudor ${number(index + 1)}`}
                  actions={
                    <CocoaButton variant="plain" tone="destructive" size="small" onClick={() => setDebtors((current) => current.filter((_, i) => i !== index))} disabled={debtors.length === 1}>
                      {ACTIONS.remove}
                    </CocoaButton>
                  }
                >
                  <CocoaFormRow columns={2}>
                    <CocoaField label="Nombre" required error={debtor.name === "" ? undefined : errors.name}>
                      <CocoaInput value={debtor.name} onChange={(v) => updateDebtor(index, { name: v })} maxLength={70} />
                    </CocoaField>
                    <CocoaField label="IBAN" required error={debtor.iban === "" ? undefined : errors.iban}>
                      <CocoaInput value={debtor.iban} onChange={(v) => updateDebtor(index, { iban: v })} maxLength={34} />
                    </CocoaField>
                    <CocoaField label="Identificador del mandato" required error={debtor.mandateId === "" ? undefined : errors.mandateId}>
                      <CocoaInput value={debtor.mandateId} onChange={(v) => updateDebtor(index, { mandateId: v })} maxLength={35} />
                    </CocoaField>
                    <CocoaField label="Firma del mandato" required error={errors.mandateSignedAt && debtor.mandateSignedAt !== "" ? errors.mandateSignedAt : undefined}>
                      <CocoaInput value={debtor.mandateSignedAt} onChange={(v) => updateDebtor(index, { mandateSignedAt: v })} type="date" max={collectionDate || undefined} />
                    </CocoaField>
                    <CocoaField label="Importe (€)" required error={debtor.amount === "" ? undefined : errors.amount}>
                      <CocoaInput value={debtor.amount} onChange={(v) => updateDebtor(index, { amount: v })} type="number" inputMode="decimal" min={0.01} step="0.01" />
                    </CocoaField>
                    <CocoaField label="Referencia única" required error={debtor.endToEndId === "" ? undefined : errors.endToEndId} help="Identifica la operación de punta a punta (máximo 35 caracteres).">
                      <CocoaInput value={debtor.endToEndId} onChange={(v) => updateDebtor(index, { endToEndId: v })} maxLength={35} />
                    </CocoaField>
                    <CocoaField label="Concepto" required error={debtor.description === "" ? undefined : errors.description} fullWidth>
                      <CocoaInput value={debtor.description} onChange={(v) => updateDebtor(index, { description: v })} maxLength={140} />
                    </CocoaField>
                  </CocoaFormRow>
                </CocoaFormSection>
              );
            })}

            <div className="cocoa-row" data-gap="2" data-justify="between">
              <CocoaButton variant="bordered" tone="neutral" size="small" icon={<PlusIcon size={14} aria-hidden="true" />} onClick={() => setDebtors((current) => [...current, emptyDebtor(current.length + 1)])}>
                Añadir deudor
              </CocoaButton>
              <span>
                <span style={secondaryStyle}>Total de la remesa </span>
                <strong>{money(debtorTotal)}</strong>
              </span>
            </div>

            {createError ? (
              <CocoaCallout tone="danger" title="No se pudo generar la remesa" role="alert">
                {createError}
              </CocoaCallout>
            ) : null}
          </>
        )}
      </CocoaDrawer>
    </CocoaPage>
  );
}

export default BankingSpainScreen;
