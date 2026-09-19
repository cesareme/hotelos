// InvoiceFromReservationDialog — factura a huésped / a empresa desde la ficha
// de la reserva (Tanda UX-1 · lote U7 · docs/design/UX-RECEPCION-FEEL.md §5.5
// (6), F14, §7.1 3.3.7 «Redundant Entry»).
//
// POST /folios/:id/invoice crea un BORRADOR con las líneas vivas del folio
// (customerType · customerName · customerTaxId; IssueInvoiceSchema estricto) y,
// con «Emitir con número», encadena POST /invoices/:id/issue esperando la
// respuesta: el toast lleva el número real (P7), nunca «Factura solicitada».
// Razón social y NIF llegan recordados (3.3.7): la empresa de la reserva
// (`companyName`), el documento del huésped principal y el último NIF usado en
// este navegador para ese mismo nombre (`localStorage`, `TAX_ID_MEMORY_KEY`).
// Dinero: espera con `busy`, sin optimismo ni deshacer (§1.2). Intro emite
// (cuerpo en <form>, Confirm = submit). Sin estilos en línea.

import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { useToast } from "../Toast";
import { financeErrorMessage } from "../../services/finance-contracts";
import { issueFolioInvoice, type FolioInvoiceCustomerType, type FolioInvoiceResult } from "../../services/pmsCommerceApi";
import { ACTIONS, FRONT_DESK_NOTES, FRONT_DESK_TOASTS, RESERVATION_ACTIONS, RESERVATION_NOTES } from "../../content/actions";
import { CocoaCallout, CocoaDialog, CocoaField, CocoaFormRow, CocoaInput, CocoaSegmentedControl } from "../cocoa";

export type InvoiceMode = "draft" | "issue";

export type InvoiceReservationLike = {
  id: string;
  code: string;
  companyName?: string | null;
  billingInstruction?: string | null;
  bookerName?: string | null;
  primaryGuest?: { firstName?: string | null; surname1?: string | null; surname2?: string | null; documentNumber?: string | null } | null;
};

export type InvoiceFromReservationDialogProps = {
  open: boolean;
  onClose: () => void;
  folioId: string;
  reservation: InvoiceReservationLike;
  /** Destinatario preseleccionado («Factura a huésped» / «Factura a empresa»); por defecto el que recuerda la reserva. */
  customerType?: FolioInvoiceCustomerType;
  /** Modo inicial; borrador por defecto (D-U6-1: emitir con número es irreversible). */
  mode?: InvoiceMode;
  onDone?: (result: FolioInvoiceResult) => void;
};

type StorageLike = { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void } | null | undefined;

/** localStorage: `{ "<razón social normalizada>": "<NIF>" }`, las 50 últimas. */
export const TAX_ID_MEMORY_KEY = "hotelos.invoice.taxIds";
const TAX_ID_MEMORY_MAX = 50;

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

function readMemory(storage: StorageLike): Record<string, string> {
  try {
    const raw = storage?.getItem(TAX_ID_MEMORY_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim()) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** Último NIF usado en este navegador para esa razón social (3.3.7), o null. */
export function readRememberedTaxId(storage: StorageLike, customerName: string): string | null {
  const key = normalizeName(customerName);
  if (!key) return null;
  return readMemory(storage)[key] ?? null;
}

export function rememberTaxId(storage: StorageLike, customerName: string, taxId: string): void {
  const key = normalizeName(customerName);
  const value = taxId.trim();
  if (!key || !value) return;
  try {
    const memory = readMemory(storage);
    delete memory[key];
    const entries = [...Object.entries(memory), [key, value]].slice(-TAX_ID_MEMORY_MAX);
    storage?.setItem(TAX_ID_MEMORY_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Modo privado o cuota llena: la próxima vez se vuelve a teclear.
  }
}

/** Nombre completo del huésped principal («Nombre Apellido1 Apellido2») o null. */
export function guestDisplayName(guest: InvoiceReservationLike["primaryGuest"]): string | null {
  if (!guest) return null;
  const name = [guest.firstName, guest.surname1, guest.surname2]
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter(Boolean)
    .join(" ");
  return name || null;
}

/** Destinatario que la reserva recuerda: empresa si se factura a empresa o tiene razón social; huésped si no. */
export function rememberedCustomerType(reservation: Pick<InvoiceReservationLike, "billingInstruction" | "companyName">): FolioInvoiceCustomerType {
  return reservation.billingInstruction === "company_invoice" || Boolean(reservation.companyName?.trim()) ? "company" : "guest";
}

/**
 * Valores iniciales del formulario (3.3.7): razón social y NIF recordados de
 * la reserva (empresa), del huésped principal (documento) o del navegador
 * (último NIF para ese nombre). Puro salvo la lectura del almacenamiento.
 */
export function invoiceDefaultsFor(
  reservation: InvoiceReservationLike,
  customerType: FolioInvoiceCustomerType,
  storage: StorageLike = null
): { customerName: string; customerTaxId: string; taxIdSource: "reservation" | "guest" | "memory" | null } {
  if (customerType === "company") {
    const customerName = reservation.companyName?.trim() ?? "";
    const remembered = customerName ? readRememberedTaxId(storage, customerName) : null;
    return { customerName, customerTaxId: remembered ?? "", taxIdSource: remembered ? "memory" : null };
  }
  const customerName = guestDisplayName(reservation.primaryGuest) ?? reservation.bookerName?.trim() ?? "";
  const document = reservation.primaryGuest?.documentNumber?.trim() ?? "";
  if (document) return { customerName, customerTaxId: document, taxIdSource: "guest" };
  const remembered = customerName ? readRememberedTaxId(storage, customerName) : null;
  return { customerName, customerTaxId: remembered ?? "", taxIdSource: remembered ? "memory" : null };
}

/** Etiqueta del botón de confirmación (pura): «Crear borrador» / «Emitir con número» / «Emitiendo…». */
export function invoiceConfirmLabel(input: { mode: InvoiceMode; busy: boolean }): string {
  if (input.busy) return input.mode === "issue" ? "Emitiendo…" : "Creando…";
  return input.mode === "issue" ? RESERVATION_ACTIONS.issueWithNumber : RESERVATION_ACTIONS.createDraft;
}

/** Una factura a empresa exige razón social y NIF (issueInvoice rechaza F1 con NIF sin nombre, 400). */
export function invoiceFormError(input: { customerType: FolioInvoiceCustomerType; customerName: string; customerTaxId: string }): string | null {
  if (input.customerType !== "company") return null;
  if (!input.customerName.trim()) return "Indica la razón social de la empresa.";
  if (!input.customerTaxId.trim()) return "Indica el NIF de la empresa.";
  return null;
}

function localStorageOrNull(): StorageLike {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function InvoiceFromReservationDialog({ open, onClose, folioId, reservation, customerType: requestedType, mode: initialMode = "draft", onDone }: InvoiceFromReservationDialogProps) {
  const { showToast } = useToast();
  const formId = useId();
  const nameId = useId();
  const taxIdId = useId();
  const [customerType, setCustomerType] = useState<FolioInvoiceCustomerType>(requestedType ?? rememberedCustomerType(reservation));
  const [mode, setMode] = useState<InvoiceMode>(initialMode);
  const [customerName, setCustomerName] = useState("");
  const [customerTaxId, setCustomerTaxId] = useState("");
  const [taxIdSource, setTaxIdSource] = useState<"reservation" | "guest" | "memory" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Al abrir (o cambiar de destinatario) los campos vuelven a lo recordado (3.3.7).
  useEffect(() => {
    if (!open) return;
    setMode(initialMode);
    setError(null);
    const next = requestedType ?? rememberedCustomerType(reservation);
    setCustomerType(next);
    const defaults = invoiceDefaultsFor(reservation, next, localStorageOrNull());
    setCustomerName(defaults.customerName);
    setCustomerTaxId(defaults.customerTaxId);
    setTaxIdSource(defaults.taxIdSource);
    // Importa el id de la reserva y el destinatario pedido, no el objeto.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reservation.id, requestedType, initialMode]);

  function switchCustomerType(next: FolioInvoiceCustomerType) {
    setCustomerType(next);
    const defaults = invoiceDefaultsFor(reservation, next, localStorageOrNull());
    setCustomerName(defaults.customerName);
    setCustomerTaxId(defaults.customerTaxId);
    setTaxIdSource(defaults.taxIdSource);
    setError(null);
  }

  const formError = useMemo(() => invoiceFormError({ customerType, customerName, customerTaxId }), [customerType, customerName, customerTaxId]);
  const canSubmit = !busy && !formError;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const result = await issueFolioInvoice(folioId, { customerType, customerName, customerTaxId, issue: mode === "issue" });
      if (customerTaxId.trim()) rememberTaxId(localStorageOrNull(), customerName, customerTaxId);
      if (result.issued && result.invoiceNumber) {
        showToast(FRONT_DESK_TOASTS.invoiceIssued(result.invoiceNumber), { variant: "success", duration: 8000 });
      } else if (mode === "issue") {
        showToast("Borrador creado, pero la emisión no devolvió número: emítela desde Facturación.", { variant: "warning", duration: 9000 });
      } else {
        showToast(FRONT_DESK_TOASTS.invoiceDrafted, { variant: "info", duration: 6000 });
      }
      onDone?.(result);
      onClose();
    } catch (err) {
      setError(financeErrorMessage(err, "No se pudo crear la factura."));
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit();
  }

  const title = customerType === "company" ? `${RESERVATION_ACTIONS.invoiceToCompany} · ${reservation.code}` : `${RESERVATION_ACTIONS.invoiceToGuest} · ${reservation.code}`;

  return (
    <CocoaDialog
      open={open}
      onClose={onClose}
      title={title}
      description={mode === "issue" ? RESERVATION_NOTES.invoiceIssueHelp : RESERVATION_NOTES.invoiceDraftHelp}
      size="md"
      confirmLabel={invoiceConfirmLabel({ mode, busy })}
      cancelLabel={ACTIONS.cancel}
      onConfirm={submit}
      confirmForm={formId}
      confirmDisabled={!canSubmit}
      busy={busy}
      initialFocus={() => document.getElementById(customerType === "company" ? (customerName.trim() ? taxIdId : nameId) : taxIdId)}
    >
      <form id={formId} className="cocoa-stack" data-gap="3" noValidate onSubmit={onSubmit} aria-label="Factura desde la reserva">
        <CocoaField label={FRONT_DESK_NOTES.invoiceTo}>
          <CocoaSegmentedControl
            size="small"
            aria-label={FRONT_DESK_NOTES.invoiceTo}
            value={customerType}
            onChange={(value) => switchCustomerType(value as FolioInvoiceCustomerType)}
            options={[
              { value: "guest", label: FRONT_DESK_NOTES.invoiceGuest },
              { value: "company", label: FRONT_DESK_NOTES.invoiceCompany }
            ]}
          />
        </CocoaField>
        <CocoaFormRow columns={2} min={200}>
          <CocoaField label={customerType === "company" ? FRONT_DESK_NOTES.companyName : "Nombre"} required={customerType === "company"} htmlFor={nameId}>
            <CocoaInput id={nameId} value={customerName} onChange={setCustomerName} autoComplete={customerType === "company" ? "organization" : "name"} disabled={busy} maxLength={500} />
          </CocoaField>
          <CocoaField
            label={FRONT_DESK_NOTES.taxId}
            required={customerType === "company"}
            htmlFor={taxIdId}
            help={taxIdSource === "memory" ? RESERVATION_NOTES.invoiceTaxIdRemembered : customerType === "guest" ? RESERVATION_NOTES.invoiceGuestTaxIdHelp : undefined}
          >
            <CocoaInput id={taxIdId} value={customerTaxId} onChange={setCustomerTaxId} autoComplete="off" disabled={busy} maxLength={40} placeholder={customerType === "company" ? "B12345674" : "12345678Z"} />
          </CocoaField>
        </CocoaFormRow>
        <CocoaField label="Factura" help={mode === "issue" ? RESERVATION_NOTES.invoiceIssueHelp : RESERVATION_NOTES.invoiceDraftHelp}>
          <CocoaSegmentedControl
            size="small"
            aria-label="Factura"
            value={mode}
            onChange={(value) => setMode(value as InvoiceMode)}
            options={[
              { value: "draft", label: FRONT_DESK_NOTES.invoiceDraft },
              { value: "issue", label: FRONT_DESK_NOTES.invoiceIssueNow }
            ]}
          />
        </CocoaField>
        {error ? (
          <CocoaCallout tone="danger" role="alert">
            {error}
          </CocoaCallout>
        ) : null}
      </form>
    </CocoaDialog>
  );
}

export default InvoiceFromReservationDialog;
