import { useEffect, useMemo, useRef, useState } from "react";
import { backOfficeNavigationGroups } from "../navigation/Sidebar";
import { globalSearch, type SearchHit, SEARCH_KIND_LABELS } from "../services/searchApi";

type CommandPaletteProps = {
  open: boolean;
  onClose: () => void;
  // Plain navigation by screen key (used for sidebar items).
  onSelect: (screen: string) => void;
  // Optional richer navigation for entity hits — caller can build a deep path
  // from screen + params (eg ReservationDetailWorkspace + { reservationId }).
  // Falls back to onSelect when omitted.
  onSelectHit?: (hit: SearchHit) => void;
};

type CommandItem = {
  source: "screen" | "entity";
  label: string;
  subtitle?: string;
  badge?: string;
  screen: string;
  group: string;
  hit?: SearchHit;
};

const KIND_BADGE_COLOR: Record<string, string> = {
  reservation: "info",
  guest: "ok",
  room: "info",
  folio: "warn",
  invoice: "ok",
  property: "info",
  rate_plan: "info"
};

export function CommandPalette(props: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [liveHits, setLiveHits] = useState<SearchHit[]>([]);
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (props.open) {
      setQuery("");
      setActiveIdx(0);
      setLiveHits([]);
      setLiveError(null);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [props.open]);

  // Static screen catalog — sourced from the same nav config the sidebar uses.
  const allScreens = useMemo<CommandItem[]>(() => {
    const items: CommandItem[] = [];
    for (const group of backOfficeNavigationGroups) {
      for (const it of group.items ?? []) {
        items.push({ source: "screen", label: it.label, screen: it.screen, group: group.title });
      }
      for (const sub of group.subgroups ?? []) {
        for (const it of sub.items) {
          items.push({ source: "screen", label: it.label, screen: it.screen, group: `${group.title} · ${sub.title}` });
        }
      }
    }
    return items;
  }, []);

  const filteredScreens = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allScreens.slice(0, 18);
    return allScreens
      .filter((item) => item.label.toLowerCase().includes(q) || item.group.toLowerCase().includes(q))
      .slice(0, 18);
  }, [query, allScreens]);

  // Debounced live search against /search every 200ms while the palette is open.
  useEffect(() => {
    if (!props.open) return;
    const q = query.trim();
    if (q.length < 2) {
      setLiveHits([]);
      setLiveError(null);
      setLiveLoading(false);
      return;
    }
    const controller = new AbortController();
    setLiveLoading(true);
    const t = setTimeout(() => {
      globalSearch(q, { signal: controller.signal })
        .then((res) => {
          setLiveHits(res.items);
          setLiveError(null);
        })
        .catch((err: unknown) => {
          if ((err as { name?: string })?.name === "AbortError") return;
          setLiveError(err instanceof Error ? err.message : "No se pudo buscar.");
          setLiveHits([]);
        })
        .finally(() => setLiveLoading(false));
    }, 200);
    return () => {
      clearTimeout(t);
      controller.abort();
    };
  }, [query, props.open]);

  // Merge in order: entity hits first (concrete data), then screens.
  const liveItems = useMemo<CommandItem[]>(() => liveHits.map((h) => ({
    source: "entity" as const,
    label: h.title,
    subtitle: h.subtitle,
    badge: h.badge,
    screen: h.screen,
    group: SEARCH_KIND_LABELS[h.kind] ?? h.kind,
    hit: h
  })), [liveHits]);

  const filtered = useMemo<CommandItem[]>(() => [...liveItems, ...filteredScreens], [liveItems, filteredScreens]);

  useEffect(() => {
    setActiveIdx(0);
  }, [filtered.length]);

  useEffect(() => {
    if (!props.open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        props.onClose();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIdx((idx) => Math.min(idx + 1, filtered.length - 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIdx((idx) => Math.max(idx - 1, 0));
      } else if (event.key === "Enter") {
        event.preventDefault();
        const item = filtered[activeIdx];
        if (item) commit(item);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props, filtered, activeIdx]);

  function commit(item: CommandItem) {
    if (item.hit && props.onSelectHit) {
      props.onSelectHit(item.hit);
    } else {
      props.onSelect(item.screen);
    }
    props.onClose();
  }

  if (!props.open) return null;

  const grouped = filtered.reduce<Record<string, CommandItem[]>>((acc, item) => {
    (acc[item.group] ??= []).push(item);
    return acc;
  }, {});
  // Show entity groups first, then screens. Keep insertion order otherwise.
  const groupOrder = Array.from(new Set(filtered.map((it) => it.group)));

  return (
    <div className="bo-cmdk-overlay" role="dialog" aria-modal="true" aria-label="Buscar en la aplicación" onClick={props.onClose}>
      <div className="bo-cmdk" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          type="search"
          className="bo-cmdk-input"
          placeholder="Buscar reserva, huésped, habitación, factura, pantalla…"
          aria-label="Buscar (escribe al menos 2 caracteres)"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setActiveIdx(0); }}
        />
        <div className="bo-cmdk-list" role="listbox" aria-label="Resultados de búsqueda">
          {liveLoading && filtered.length === 0 ? (
            <div role="status" aria-live="polite" style={{ padding: 16, textAlign: "center", color: "var(--ink-muted)", fontSize: 13 }}>Buscando…</div>
          ) : null}
          {liveError ? (
            <div role="alert" style={{ padding: 12, color: "var(--warn-ink, #f59e0b)", fontSize: 12 }}>{liveError}</div>
          ) : null}
          {!liveLoading && filtered.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", color: "var(--ink-muted)", fontSize: 14 }}>
              {query.trim() ? `Sin resultados para "${query}"` : "Empieza a escribir para buscar"}
            </div>
          ) : (
            groupOrder.map((group) => {
              const items = grouped[group];
              if (!items || items.length === 0) return null;
              return (
                <div key={group}>
                  <div className="bo-cmdk-section">{group}</div>
                  {items.map((item) => {
                    const globalIdx = filtered.indexOf(item);
                    const badgeCls = item.hit ? (KIND_BADGE_COLOR[item.hit.kind] ?? "info") : "";
                    return (
                      <div
                        key={`${group}-${item.source}-${item.screen}-${item.hit?.id ?? item.label}`}
                        role="option"
                        aria-selected={globalIdx === activeIdx}
                        className={`bo-cmdk-item${globalIdx === activeIdx ? " selected" : ""}`}
                        onMouseEnter={() => setActiveIdx(globalIdx)}
                        onClick={() => commit(item)}
                      >
                        <span style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: "1 1 0%" }}>
                          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.label}</span>
                            {item.badge ? <span className={`bo-status ${badgeCls}`} style={{ fontSize: 10 }}>{item.badge}</span> : null}
                          </span>
                          {item.subtitle ? (
                            <span style={{ fontSize: 11, color: "var(--ink-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.subtitle}</span>
                          ) : null}
                        </span>
                        <span className="bo-cmdk-item-meta">{item.group}</span>
                      </div>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
