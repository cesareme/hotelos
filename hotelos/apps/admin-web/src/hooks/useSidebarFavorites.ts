import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "cocoa-sb-favorites";
const MAX_FAVORITES = 10;

function readFromStorage(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

export function useSidebarFavorites(): {
  favorites: string[];
  toggleFavorite: (screen: string) => void;
  isFavorite: (screen: string) => boolean;
} {
  const [favorites, setFavorites] = useState<string[]>(() => readFromStorage());

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(favorites));
    } catch {
      // Ignore storage errors (quota exceeded, disabled, etc.)
    }
  }, [favorites]);

  const toggleFavorite = useCallback((screen: string) => {
    setFavorites((current) => {
      if (current.includes(screen)) {
        return current.filter((item) => item !== screen);
      }
      const next = [...current, screen];
      // FIFO: drop oldest entries when exceeding the cap.
      if (next.length > MAX_FAVORITES) {
        return next.slice(next.length - MAX_FAVORITES);
      }
      return next;
    });
  }, []);

  const isFavorite = useCallback(
    (screen: string) => favorites.includes(screen),
    [favorites]
  );

  return { favorites, toggleFavorite, isFavorite };
}
