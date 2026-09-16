// Error state of the AEAT report screens (Modelo 303/390/347/111/115/180,
// libros y liquidación de IVA) — Cocoa 22 · ola 8 · lote 8-B.
//
// The accounting API answers typed 4xx errors with an actionable Spanish
// message («Falta la cuenta contable 477 … crea o importa el plan contable
// (PGC) antes de generar el modelo 303.»). The screens used to hide it behind
// a generic «No hemos podido cargar este informe» (browser-roles#5): this
// state paints the API message and, when the chart of accounts is what is
// missing, a call to action to Configuración › Contabilidad y fiscal. Painted
// inside the page body (CocoaState kind="error"), so the period pickers of
// the header stay usable while the error is on screen.

import { CocoaState, openTabPath } from "../../components/cocoa";
import { UI_STATES } from "../../content/actions";
import { urlForScreen } from "../../navigation/nav-tree";

export type ReportErrorInfo = {
  title: string;
  message: string;
  /** The API asked for the chart of accounts (PGC): offer the accounting settings. */
  needsChartOfAccounts: boolean;
};

const CHART_OF_ACCOUNTS_RE = /plan contable|plan de cuentas|cuenta contable/i;
const GENERIC_MESSAGE = "No hemos podido cargar este informe. Inténtalo de nuevo.";

/** Title, message and the accounting CTA flag for the (already Spanish) error text of a fiscal request. */
export function describeReportError(message: string | null | undefined): ReportErrorInfo {
  const text = (message ?? "").trim();
  const needsChartOfAccounts = CHART_OF_ACCOUNTS_RE.test(text);
  return {
    title: needsChartOfAccounts ? "Falta el plan contable" : UI_STATES.error.title,
    message: text || GENERIC_MESSAGE,
    needsChartOfAccounts
  };
}

export const ACCOUNTING_SETTINGS_CTA = "Abrir Contabilidad y fiscal";

export function ReportErrorCard({ message, onRetry }: { message: string | null | undefined; onRetry?: () => void }) {
  const info = describeReportError(message);
  const accountingUrl = urlForScreen("AccountingSettings");
  return (
    <CocoaState
      kind="error"
      title={info.title}
      message={info.message}
      onRetry={onRetry}
      primaryAction={info.needsChartOfAccounts && accountingUrl ? { label: ACCOUNTING_SETTINGS_CTA, onClick: () => openTabPath(accountingUrl) } : undefined}
    />
  );
}

export default ReportErrorCard;
