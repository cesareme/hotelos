import { useEffect, useMemo, useRef, useState } from "react";
import { flatMenuEntries, menuCategories, normalizeMenuText } from "../navigation/nav-tree";
import { useDevMode } from "../navigation/dev-mode";
import { useNavGate } from "../navigation/useEnabledModules";
import { globalSearch, type SearchHit, SEARCH_KIND_LABELS } from "../services/searchApi";
import { openPropertySwitcher } from "../services/activeProperty";
import { openHelpCenter } from "./guide/guideStore";
import { OPEN_NOTIFICATIONS_EVENT } from "../providers/CocoaGlobalProvider";
import { useSidebarRecent } from "../hooks/useSidebarRecent";
import { CocoaBadge } from "./cocoa/CocoaBadge";
import type { CocoaTone } from "./cocoa/cocoa-tones";

// Skin: styles/cocoa-22-guide.css (`c22-cmdk-*`); the selected row is keyed on
// aria-selected and the entity badge is a CocoaBadge. This palette (screen
// index + live /search hits) is NOT the CocoaCommandPalette of the global
// provider (register/unregister model) — both coexist on purpose.

type CommandPaletteProps = {
  open: boolean;
  onClose: () => void;
  // Plain navigation by screen key (used for sidebar items).
  onSelect: (screen: string) => void;
  // Optional richer navigation for entity hits — caller can build a deep path
  // from screen + params (eg ReservationDetailWorkspace + { reservationId }).
  // Falls back to onSelect when omitted.
  onSelectHit?: (hit: SearchHit) => void;
  /**
   * Query the palette opens with (Tanda 5: the toolbar search field hands its
   * text over to ⌘K instead of being a dead end). Read each time `open` flips
   * to true.
   */
  initialQuery?: string;
};

type CommandItem = {
  source: "screen" | "entity" | "action" | "recent";
  label: string;
  subtitle?: string;
  badge?: string;
  screen: string;
  group: string;
  hit?: SearchHit;
  run?: () => void;
};

// Tone of the entity badge by search kind (the legacy pill tones ok/warn/info → success/warning/info).
const KIND_BADGE_TONE: Record<string, CocoaTone> = {
  reservation: "info",
  guest: "success",
  room: "info",
  folio: "warning",
  invoice: "success",
  property: "info",
  rate_plan: "info"
};

const RECENT_GROUP = "Recientes";
const ACTIONS_GROUP = "Acciones";
const MAX_RECENT = 5;

// Shell actions reachable from the palette (no screen behind them).
const ACTION_ITEMS: CommandItem[] = [
  { source: "action", label: "Abrir el centro de ayuda", screen: "", group: ACTIONS_GROUP, run: () => openHelpCenter() },
  { source: "action", label: "Ver avisos", screen: "", group: ACTIONS_GROUP, run: () => window.dispatchEvent(new CustomEvent(OPEN_NOTIFICATIONS_EVENT)) },
  { source: "action", label: "Cambiar de propiedad", screen: "", group: ACTIONS_GROUP, run: () => openPropertySwitcher() }
];

export function CommandPalette(props: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [liveHits, setLiveHits] = useState<SearchHit[]>([]);
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { recent } = useSidebarRecent();
  // Same role/module gate as the tab containers and the sidebar (Tanda 5 · L1b):
  // the palette never offers a screen the menu would not show («Ver como…»
  // included, L1c) and «Desarrollo» follows the reactive dev mode of the tab.
  const gate = useNavGate();
  const devMode = useDevMode();

  useEffect(() => {
    if (props.open) {
      setQuery(props.initialQuery ?? "");
      setActiveIdx(0);
      setLiveHits([]);
      setLiveError(null);
      setTimeout(() => {
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        // Keep the caret after the handed-over text so the user just keeps typing.
        const end = input.value.length;
        input.setSelectionRange(end, end);
      }, 50);
    }
    // `initialQuery` is read only when the palette opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  // Screen catalogue — the same nine categories the sidebar renders from the
  // navigation tree (items and their paintable tabs, filtered by the role
  // tokens and the enabled modules; «Desarrollo» only with dev mode + admin).
  const allScreens = useMemo<CommandItem[]>(() => {
    const categories = menuCategories(gate.tokens, gate.modules, { devMode });
    return flatMenuEntries(categories, { includeTabs: true })
      .filter((entry) => entry.visibility === "visible")
      .map((entry) => ({
        source: "screen" as const,
        label: entry.tab ? `${entry.itemLabel} · ${entry.label}` : entry.label,
        screen: entry.screenKey,
        group: entry.categoryLabel
      }));
  }, [gate.tokens, gate.modules, devMode]);

  // Recently visited screens (hooks/useSidebarRecent), labelled from the catalog.
  const recentItems = useMemo<CommandItem[]>(() => {
    const seen = new Set<string>();
    const items: CommandItem[] = [];
    for (const screen of recent) {
      if (seen.has(screen)) continue;
      const match = allScreens.find((item) => item.screen === screen);
      if (!match) continue;
      seen.add(screen);
      items.push({ ...match, source: "recent", subtitle: match.group, group: RECENT_GROUP });
      if (items.length >= MAX_RECENT) break;
    }
    return items;
  }, [recent, allScreens]);

  const filteredScreens = useMemo(() => {
    const q = normalizeMenuText(query);
    if (!q) return allScreens.slice(0, 18);
    return allScreens
      .filter((item) => normalizeMenuText(item.label).includes(q) || normalizeMenuText(item.group).includes(q))
      .slice(0, 18);
  }, [query, allScreens]);

  const filteredActions = useMemo(() => {
    const q = normalizeMenuText(query);
    if (!q) return ACTION_ITEMS;
    return ACTION_ITEMS.filter((item) => normalizeMenuText(item.label).includes(q));
  }, [query]);

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

  // Merge in order: entity hits first (concrete data), then recents, screens and actions.
  const liveItems = useMemo<CommandItem[]>(() => liveHits.map((h) => ({
    source: "entity" as const,
    label: h.title,
    subtitle: h.subtitle,
    badge: h.badge,
    screen: h.screen,
    group: SEARCH_KIND_LABELS[h.kind] ?? h.kind,
    hit: h
  })), [liveHits]);

  const filtered = useMemo(
    () => [...liveItems, ...(query.trim() ? [] : recentItems), ...filteredScreens, ...filteredActions],
    [liveItems, query, recentItems, filteredScreens, filteredActions]
  );

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
    if (item.run) {
      props.onClose();
      item.run();
      return;
    }
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
    <div className="c22-cmdk-overlay" role="dialog" aria-modal="true" aria-label="Buscar en la aplicación" onClick={props.onClose}>
      <div className="c22-cmdk" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          type="search"
          className="c22-cmdk-input"
          placeholder="Buscar reserva, huésped, habitación, factura, pantalla…"
          aria-label="Buscar (escribe al menos 2 caracteres)"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setActiveIdx(0); }}
        />
        <div className="c22-cmdk-list" role="listbox" aria-label="Resultados de búsqueda">
          {liveLoading && filtered.length === 0 ? (
            <div role="status" aria-live="polite" className="c22-cmdk-status">Buscando…</div>
          ) : null}
          {liveError ? (
            <div role="alert" className="c22-cmdk-error">{liveError}</div>
          ) : null}
          {!liveLoading && filtered.length === 0 ? (
            <div className="c22-cmdk-empty">
              {query.trim() ? `Sin resultados para "${query}"` : "Empieza a escribir para buscar"}
            </div>
          ) : (
            groupOrder.map((group) => {
              const items = grouped[group];
              if (!items || items.length === 0) return null;
              return (
                <div key={group}>
                  <div className="c22-cmdk-section">{group}</div>
                  {items.map((item) => {
                    const globalIdx = filtered.indexOf(item);
                    const badgeTone: CocoaTone = item.hit ? (KIND_BADGE_TONE[item.hit.kind] ?? "info") : "neutral";
                    return (
                      <div
                        key={`${group}-${item.source}-${item.screen}-${item.hit?.id ?? item.label}`}
                        role="option"
                        aria-selected={globalIdx === activeIdx}
                        className="c22-cmdk-item"
                        onMouseEnter={() => setActiveIdx(globalIdx)}
                        onClick={() => commit(item)}
                      >
                        <span className="c22-cmdk-item-text">
                          <span className="c22-cmdk-item-title">
                            <span className="c22-cmdk-item-label">{item.label}</span>
                            {item.badge ? <CocoaBadge tone={badgeTone} size="small">{item.badge}</CocoaBadge> : null}
                          </span>
                          {item.subtitle ? <span className="c22-cmdk-item-subtitle">{item.subtitle}</span> : null}
                        </span>
                        <span className="c22-cmdk-item-meta">{item.source === "recent" ? "Reciente" : item.group}</span>
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
