import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "cocoa-sb-recent";
const MAX_RECENT = 8;

function readFromStorage(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string").slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

function writeToStorage(value: string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Ignore quota / serialization errors.
  }
}

export function useSidebarRecent(): {
  recent: string[];
  pushRecent: (screen: string) => void;
  clearRecent: () => void;
} {
  const [recent, setRecent] = useState<string[]>(() => readFromStorage());

  useEffect(() => {
    writeToStorage(recent);
  }, [recent]);

  const pushRecent = useCallback((screen: string) => {
    if (!screen) return;
    setRecent((prev) => {
      const deduped = prev.filter((item) => item !== screen);
      const next = [screen, ...deduped];
      return next.slice(0, MAX_RECENT);
    });
  }, []);

  const clearRecent = useCallback(() => {
    setRecent([]);
  }, []);

  return { recent, pushRecent, clearRecent };
}
