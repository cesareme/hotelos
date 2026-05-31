import { useEffect, useRef, useState } from "react";
import { apiRequest, type RequestOptions } from "../services/api-client";

export type ApiState<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
};

export type UseApiDataOptions = RequestOptions & {
  /** Auto-refresh interval in ms while a predicate matches (or always when `true`). */
  pollIntervalMs?: number;
  /** Predicate that decides if the auto-poll should keep firing. */
  pollWhile?: (data: unknown) => boolean;
};

export function useApiData<T>(path: string | null, options: UseApiDataOptions = {}): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(path));
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const lastPath = useRef<string | null>(null);

  useEffect(() => {
    if (!path) {
      setLoading(false);
      return;
    }
    lastPath.current = path;
    setLoading(true);
    setError(null);
    apiRequest<T>(path, { method: options.method, body: options.body, query: options.query })
      .then((value) => {
        if (lastPath.current !== path) return;
        setData(value);
        setLoading(false);
      })
      .catch((err) => {
        if (lastPath.current !== path) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, nonce, JSON.stringify(options.query ?? {})]);

  // Polling — re-fires nonce when predicate matches.
  useEffect(() => {
    if (!path || !options.pollIntervalMs) return;
    const interval = window.setInterval(() => {
      const shouldPoll = options.pollWhile ? options.pollWhile(data) : true;
      if (shouldPoll) setNonce((n) => n + 1);
    }, options.pollIntervalMs);
    return () => window.clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, data, options.pollIntervalMs]);

  return {
    data,
    loading,
    error,
    refresh: () => setNonce((n) => n + 1)
  };
}
