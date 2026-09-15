// Error card of the AEAT report screens (Modelo 303/111/115/180/390).
//
// The accounting API answers typed 4xx errors with an actionable Spanish
// message («Falta la cuenta contable 477 … crea o importa el plan contable
// (PGC) antes de generar el modelo 303.»). The screens used to hide it behind
// a generic «No hemos podido cargar este informe» (browser-roles#5): this card
// paints the API message and, when the chart of accounts is what is missing,
// a call to action to Configuración › Contabilidad y fiscal.

import { openTabPath } from "../../components/cocoa/CocoaRouteTabs";
import { ACTIONS, UI_STATES } from "../../content/actions";
import { urlForScreen } from "../../navigation/nav-tree";

export type ReportErrorInfo = {
  title: string;
  message: string;
  /** The API asked for the chart of accounts (PGC): offer the accounting settings. */
  needsChartOfAccounts: boolean;
};

const CHART_OF_ACCOUNTS_RE = /plan contable|plan de cuentas|cuenta contable/i;
const GENERIC_MESSAGE = "No hemos podido cargar este informe. Inténtalo de nuevo.";

/** Title, message and the accounting CTA flag for an error string of useApiData (the ApiError message). */
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
    <div className="bo-card" role="alert" style={{ borderLeft: "3px solid var(--danger-ink)" }}>
      <h3>{info.title}</h3>
      <p style={{ color: "var(--ink-soft)" }}>{info.message}</p>
      <div className="bo-actions">
        {info.needsChartOfAccounts && accountingUrl ? (
          <button type="button" className="primary" onClick={() => openTabPath(accountingUrl)}>
            {ACCOUNTING_SETTINGS_CTA}
          </button>
        ) : null}
        {onRetry ? (
          <button type="button" onClick={onRetry}>
            {ACTIONS.retry}
          </button>
        ) : null}
      </div>
    </div>
  );
}
