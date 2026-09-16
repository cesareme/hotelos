// Proveedores, gastos e inmovilizado · hooks shared by the four screens of the
// lot (Tanda 6 · Finanzas · lote 6-E) plus a re-export of the pure helpers of
// payables-helpers.ts (tested under `node --test`; this file pulls api-client
// through accountingApi and cannot load there).
//
// Pure TypeScript on purpose: a `.tsx` under screens/ would be inventoried as a
// screen by tests/cocoa-22-contract.test.mjs and scripts/cocoa-22-inventory.mjs.

import { useCallback, useEffect, useRef, useState } from "react";
import { listChartAccounts, type ChartAccountView } from "../../services/accountingApi";
import { financeErrorCode, financeErrorMessage } from "../../services/finance-contracts";
import { getActiveOrganizationId } from "../../services/activeProperty";

export * from "./payables-helpers";

// ---------------------------------------------------------------------------
// Chart of accounts (postable only) for the account pickers
// ---------------------------------------------------------------------------

export type ChartState = {
  accounts: ChartAccountView[];
  loading: boolean;
  /** Spanish message when the chart could not be loaded (the pickers fall back to a free code). */
  error: string | null;
  /** false when the organisation has no chart yet (409 CHART_NOT_PROVISIONED). */
  provisioned: boolean;
};

/** GET /accounting/chart?postableOnly=1 once per mount (headers excluded: the pickers never offer a 6 or 62 header). */
export function useChartAccounts(): ChartState {
  const [state, setState] = useState<ChartState>({ accounts: [], loading: true, error: null, provisioned: true });
  const organizationId = getActiveOrganizationId();
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    listChartAccounts({ postableOnly: true })
      .then((response) => {
        if (!alive) return;
        const accounts = [...response.accounts].filter((a) => a.isPostable).sort((a, b) => a.code.localeCompare(b.code));
        setState({ accounts, loading: false, error: null, provisioned: true });
      })
      .catch((error: unknown) => {
        if (!alive) return;
        const code = financeErrorCode(error);
        setState({
          accounts: [],
          loading: false,
          error: financeErrorMessage(error, "No se pudo cargar el plan de cuentas: escribe el código de la cuenta a mano."),
          provisioned: code !== "CHART_NOT_PROVISIONED"
        });
      });
    return () => {
      alive = false;
    };
  }, [organizationId]);
  return state;
}

// ---------------------------------------------------------------------------
// Stale-safe async loader (typed clients instead of useApiData's raw path)
// ---------------------------------------------------------------------------

export type LoaderState<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
};

/**
 * Run `load` when `key` changes (and on `refresh()`); a response that arrives
 * after a newer request is ignored. `load` receives no arguments: close over
 * the filters and put them in `key`.
 */
export function useLoader<T>(load: () => Promise<T>, key: string, fallback = "No se pudieron cargar los datos. Inténtalo de nuevo."): LoaderState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
        setError(financeErrorMessage(err, fallback));
        setLoading(false);
      });
  }, [key, nonce, fallback]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, refresh };
}
