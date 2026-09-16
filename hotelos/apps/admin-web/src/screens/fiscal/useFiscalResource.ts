// Cumplimiento › Modelos AEAT (Cocoa 22 · ola 8 · lote 8-B) — one loader hook
// for the typed fiscal clients (services/fiscalApi.ts). useApiData takes a
// path and a query; the fiscal screens call functions (getFiscalModel,
// getVatBook, previewVatSettlement) whose query builders live in
// finance-contracts.ts, so this hook takes a `key` (the parameters that
// identify the resource) and a loader. A refresh of the SAME key keeps the
// previous data (no layout jump); a new key (another period, another scope)
// drops it so the skeleton, not a stale period, is what the user sees. The
// raw error is exposed (the screens map `details.code` through
// fiscalErrorText) and answers of a request that is no longer the latest are
// ignored.

import { useCallback, useEffect, useRef, useState } from "react";

export type FiscalResource<T> = {
  data: T | null;
  /** True while a load is in flight and there is no data for the current key. */
  loading: boolean;
  /** True while any load is in flight (a refresh keeps the previous data). */
  refreshing: boolean;
  error: unknown;
  refresh: () => void;
};

export function useFiscalResource<T>(key: string | null, load: () => Promise<T>): FiscalResource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [inFlight, setInFlight] = useState<boolean>(Boolean(key));
  const [nonce, setNonce] = useState(0);
  const loader = useRef(load);
  loader.current = load;
  const latest = useRef(0);
  const loadedKey = useRef<string | null>(null);

  useEffect(() => {
    if (!key) {
      setInFlight(false);
      return undefined;
    }
    const request = ++latest.current;
    if (loadedKey.current !== key) setData(null);
    setInFlight(true);
    setError(null);
    loader
      .current()
      .then((value) => {
        if (latest.current !== request) return;
        loadedKey.current = key;
        setData(value);
        setInFlight(false);
      })
      .catch((err: unknown) => {
        if (latest.current !== request) return;
        setError(err);
        setInFlight(false);
      });
    return undefined;
  }, [key, nonce]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  return {
    data,
    loading: inFlight && data === null,
    refreshing: inFlight,
    error,
    refresh
  };
}
