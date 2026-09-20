import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flatMenuEntries, menuCategories, normalizeMenuText } from "../navigation/nav-tree";
import { useDevMode } from "../navigation/dev-mode";
import { useNavGate } from "../navigation/useEnabledModules";
import { globalSearch, type SearchHit, SEARCH_KIND_LABELS } from "../services/searchApi";
import { openPropertySwitcher } from "../services/activeProperty";
import { openHelpCenter } from "./guide/guideStore";
import { OPEN_NOTIFICATIONS_EVENT } from "../providers/CocoaGlobalProvider";
import { useSidebarRecent } from "../hooks/useSidebarRecent";
import { CocoaBadge } from "./cocoa/CocoaBadge";
import { CocoaKbd } from "./cocoa/CocoaKbd";
import { getPageCommands, subscribePageCommands, type CocoaPageCommand } from "./cocoa/cocoa-page-commands";
import type { CocoaTone } from "./cocoa/cocoa-tones";
import { reservationStatus, roomStatus, sourceLabel } from "../content/status-dictionary";
import { date as formatDate } from "../lib/format";
import { openAssistantWith } from "./assistant/assistant-panel-store";

// Skin: styles/cocoa-22-guide.css (`c22-cmdk-*`); the selected row is keyed on
// aria-selected and the entity badge is a CocoaBadge. This palette (screen
// index + live /search hits) is NOT the CocoaCommandPalette of the global
// provider (register/unregister model) — both coexist on purpose.
//
// Tanda UX-1 · lote U5 (docs/design/UX-RECEPCION-FEEL.md §4 «Paleta ⌘K
// ampliada», F16, §7.1 2.1.1):
//   · the `commands` of the mounted CocoaPage (cocoa-page-commands.ts) come
//     FIRST, under «Esta pantalla», with their `CocoaKbd` when they declare a
//     shortcut; they filter with the same accent-insensitive match as screens;
//   · a reservation hit of TODAY gets actions right under it («Check-in» for a
//     confirmed arrival, «Cobrar» for an in-house stay): they dispatch a
//     cancelable window event (`hotelos-open-checkin` / `hotelos-open-payment`,
//     detail `{ reservationId, code, hit }`) that Mi día (U6) and the ficha (U7)
//     claim with `event.preventDefault()`; when nobody claims it, the palette
//     opens the reservation instead, so the row never does nothing;
//   · a numeric query («204») ranks the room hits first (kind `room` of /search);
//   · the search box carries `aria-activedescendant` → the active option.
// The pure ordering / filtering lives in the exported helpers below
// (components/__tests__/CommandPalette.test.mts).
//
// Tanda L6b · lote L6b-07 (asistente unificado, objetivo 3; nav-tree fila 79
// «también en ⌘K»): whenever the box has text, the LAST item is «Preguntar al
// asistente: “…”» under «Acciones» (`assistantAskItem`), so a question that
// matches nothing is never a dead end — with no hits it is the ONLY item and
// Enter sends it. It opens the assistant panel of the shell (BackOfficeLayout)
// through the store of components/assistant/assistant-panel-store.ts with the
// question pending; no new shortcut (D9: ⌘K stays the single entry point).

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

export type CommandItemSource = "screen" | "entity" | "action" | "recent" | "page" | "hit-action" | "assistant";

export type CommandItem = {
  source: CommandItemSource;
  /** Stable id (aria-activedescendant, React key). */
  id: string;
  label: string;
  subtitle?: string;
  badge?: string;
  /** Tone of the badge (dictionary for reservation / room hits). */
  badgeTone?: CocoaTone;
  screen: string;
  group: string;
  hit?: SearchHit;
  run?: () => void;
  /** Display hint of a page command («⌘R»). */
  shortcut?: string;
  /** hit-action: the window event it dispatches. */
  event?: string;
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

export const RECENT_GROUP = "Recientes";
export const ACTIONS_GROUP = "Acciones";
/** Group of the mounted page's commands (always first). */
export const PAGE_GROUP = "Esta pantalla";
const MAX_RECENT = 5;
const MAX_SCREENS = 18;

/** Window events of the reservation hit actions (detail: `{ reservationId, code, hit }`, cancelable). */
export const OPEN_CHECKIN_EVENT = "hotelos-open-checkin";
export const OPEN_PAYMENT_EVENT = "hotelos-open-payment";

export type HitActionDetail = { reservationId: string; code: string; hit: SearchHit };

// Shell actions reachable from the palette (no screen behind them).
const ACTION_ITEMS: CommandItem[] = [
  { source: "action", id: "action:help", label: "Abrir el centro de ayuda", screen: "", group: ACTIONS_GROUP, run: () => openHelpCenter() },
  { source: "action", id: "action:notifications", label: "Ver avisos", screen: "", group: ACTIONS_GROUP, run: () => window.dispatchEvent(new CustomEvent(OPEN_NOTIFICATIONS_EVENT)) },
  { source: "action", id: "action:property", label: "Cambiar de propiedad", screen: "", group: ACTIONS_GROUP, run: () => openPropertySwitcher() }
];

// ---------------------------------------------------------------------------
// Pure helpers (ordering / filtering), unit-tested.
// ---------------------------------------------------------------------------

/** The mounted page's commands as palette items, filtered by the query (empty query = all). */
export function pageCommandItems(commands: readonly CocoaPageCommand[], query: string): CommandItem[] {
  const q = normalizeMenuText(query);
  return commands
    .filter((command) => !q || normalizeMenuText(command.label).includes(q))
    .map((command) => ({
      source: "page" as const,
      id: `page:${command.id}`,
      label: command.label,
      screen: "",
      group: PAGE_GROUP,
      shortcut: command.shortcut,
      run: command.run
    }));
}

/** «204», «12», «101A»: a room number rather than a name or a code. */
export function isRoomNumberQuery(query: string): boolean {
  return /^\d{1,4}[a-z]?$/i.test(query.trim());
}

/** Rooms first for a room-number query (stable otherwise). */
export function rankLiveHits(hits: readonly SearchHit[], query: string): SearchHit[] {
  if (!isRoomNumberQuery(query)) return [...hits];
  const rooms = hits.filter((hit) => hit.kind === "room");
  const rest = hits.filter((hit) => hit.kind !== "room");
  return [...rooms, ...rest];
}

/** `arrival → departure` (ISO) of a reservation hit, read from the subtitle /search builds; null when absent. */
export function reservationDatesOf(hit: Pick<SearchHit, "subtitle">): { arrival: string; departure: string } | null {
  const match = /(\d{4}-\d{2}-\d{2})\s*→\s*(\d{4}-\d{2}-\d{2})/.exec(hit.subtitle ?? "");
  return match ? { arrival: match[1], departure: match[2] } : null;
}

export type HitAction = { id: "checkin" | "payment"; label: string; event: string };

const ARRIVAL_STATUSES = new Set(["confirmed", "pending", "tentative", "guaranteed"]);

/**
 * Actions offered right under a reservation hit of today (§4 «Paleta ⌘K»):
 * «Check-in» for a confirmed reservation arriving today, «Cobrar» for an
 * in-house stay. Other kinds and other days get none.
 */
export function hitActionsFor(hit: Pick<SearchHit, "kind" | "badge" | "subtitle">, today: string): HitAction[] {
  if (hit.kind !== "reservation") return [];
  const status = (hit.badge ?? "").toLowerCase();
  const dates = reservationDatesOf(hit);
  if (status === "checked_in") return [{ id: "payment", label: "Cobrar", event: OPEN_PAYMENT_EVENT }];
  if (ARRIVAL_STATUSES.has(status) && dates?.arrival === today) return [{ id: "checkin", label: "Check-in", event: OPEN_CHECKIN_EVENT }];
  return [];
}

/**
 * What the operator reads of a hit (pure, corrector L-05 / R4, P6): the
 * reservation / room status through the dictionary (never the raw enum), the
 * ISO dates of a reservation subtitle as «18 sep → 20 sep» and the channel
 * code as its label. Other kinds keep the badge /search sends (VIP code,
 * invoice status…).
 */
export function hitPresentation(hit: Pick<SearchHit, "kind" | "badge" | "subtitle">): { badge: string | undefined; badgeTone: CocoaTone; subtitle: string | undefined } {
  const fallbackTone: CocoaTone = KIND_BADGE_TONE[hit.kind as SearchHit["kind"]] ?? "info";
  if (hit.kind === "reservation") {
    const entry = hit.badge ? reservationStatus(hit.badge) : null;
    const subtitle = hit.subtitle
      ? hit.subtitle
          .replace(/(\d{4}-\d{2}-\d{2})\s*→\s*(\d{4}-\d{2}-\d{2})/, (_all, arrival: string, departure: string) => `${formatDate(arrival, "dayMonth")} → ${formatDate(departure, "dayMonth")}`)
          .replace(/ · ([a-z0-9_-]+)$/i, (_all, code: string) => ` · ${sourceLabel(code)}`)
      : undefined;
    return { badge: entry?.label, badgeTone: entry?.tone ?? fallbackTone, subtitle };
  }
  if (hit.kind === "room") {
    const entry = hit.badge ? roomStatus(hit.badge) : null;
    return { badge: entry?.label, badgeTone: entry?.tone ?? fallbackTone, subtitle: hit.subtitle };
  }
  return { badge: hit.badge, badgeTone: fallbackTone, subtitle: hit.subtitle };
}

/** Live hits as items (ranked), each followed by its actions. */
export function liveHitItems(hits: readonly SearchHit[], query: string, today: string): CommandItem[] {
  const items: CommandItem[] = [];
  for (const hit of rankLiveHits(hits, query)) {
    const group = SEARCH_KIND_LABELS[hit.kind] ?? hit.kind;
    const id = `hit:${hit.kind}:${hit.id}`;
    const shown = hitPresentation(hit);
    items.push({ source: "entity", id, label: hit.title, subtitle: shown.subtitle, badge: shown.badge, badgeTone: shown.badgeTone, screen: hit.screen, group, hit });
    for (const action of hitActionsFor(hit, today)) {
      items.push({ source: "hit-action", id: `${id}:${action.id}`, label: action.label, subtitle: hit.title, screen: hit.screen, group, hit, event: action.event });
    }
  }
  return items;
}

/** Id of the «Preguntar al asistente» item (one per palette). */
export const ASSISTANT_ITEM_ID = "assistant:ask";

/** Label of the assistant item (pure): the question as typed, between Spanish quotes. */
export function assistantAskLabel(question: string): string {
  return `Preguntar al asistente: “${question}”`;
}

/**
 * «Preguntar al asistente: “…”» (pure): null without text; otherwise an
 * action item of the «Acciones» group whose `run` opens the assistant panel
 * with the (whitespace-collapsed) question pending.
 */
export function assistantAskItem(query: string): CommandItem | null {
  const question = query.replace(/\s+/g, " ").trim();
  if (!question) return null;
  return {
    source: "assistant",
    id: ASSISTANT_ITEM_ID,
    label: assistantAskLabel(question),
    screen: "",
    group: ACTIONS_GROUP,
    run: () => openAssistantWith({ question })
  };
}

/**
 * Final order: page commands · live hits (+ actions) · recents (empty query
 * only) · screens · shell actions · «Preguntar al asistente» (with text only:
 * the single item when nothing else matches).
 */
export function buildPaletteItems(input: {
  pageItems: readonly CommandItem[];
  liveItems: readonly CommandItem[];
  recentItems: readonly CommandItem[];
  screenItems: readonly CommandItem[];
  actionItems: readonly CommandItem[];
  query: string;
}): CommandItem[] {
  const ask = assistantAskItem(input.query);
  return [...input.pageItems, ...input.liveItems, ...(input.query.trim() ? [] : input.recentItems), ...input.screenItems, ...input.actionItems, ...(ask ? [ask] : [])];
}

/** Screens filtered by the query (label or category), capped. */
export function filterScreenItems(screens: readonly CommandItem[], query: string, limit = MAX_SCREENS): CommandItem[] {
  const q = normalizeMenuText(query);
  if (!q) return screens.slice(0, limit);
  return screens.filter((item) => normalizeMenuText(item.label).includes(q) || normalizeMenuText(item.group).includes(q)).slice(0, limit);
}

/** DOM id of an option (aria-activedescendant): list id + item id with unsafe characters folded. */
export function optionDomId(listId: string, itemId: string): string {
  return `${listId}-${itemId.replace(/[^A-Za-z0-9_-]+/g, "_")}`;
}

/** Today as ISO date (local time), the same day Mi día shows. */
export function todayIso(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Cancelable event of a hit action; the consumer claims it with `preventDefault()`. */
export function hitActionEvent(action: string, hit: SearchHit): CustomEvent<HitActionDetail> {
  return new CustomEvent<HitActionDetail>(action, { detail: { reservationId: hit.id, code: hit.title, hit }, cancelable: true });
}

// ---------------------------------------------------------------------------
// Component.
// ---------------------------------------------------------------------------
export function CommandPalette(props: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [liveHits, setLiveHits] = useState<SearchHit[]>([]);
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [pageCommands, setPageCommands] = useState<readonly CocoaPageCommand[]>(() => getPageCommands());
  const inputRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const { recent } = useSidebarRecent();
  // Same role/module gate as the tab containers and the sidebar (Tanda 5 · L1b):
  // the palette never offers a screen the menu would not show («Ver como…»
  // included, L1c) and «Desarrollo» follows the reactive dev mode of the tab.
  const gate = useNavGate();
  const devMode = useDevMode();

  // The mounted CocoaPage's commands (F16): read on open and on every change.
  useEffect(() => {
    setPageCommands(getPageCommands());
    return subscribePageCommands((next) => setPageCommands(next));
  }, []);

  useEffect(() => {
    if (props.open) {
      setPageCommands(getPageCommands());
      setQuery(props.initialQuery ?? "");
      setActiveIdx(0);
      setLiveHits([]);
      setLiveError(null);
    }
    // `initialQuery` is read only when the palette opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  // Focus the search box synchronously on open (corrector L-10): the old
  // 50 ms timeout lost the first characters of a fast operator («Zeta» typed
  // right after ⌘K → empty box). A layout effect runs before the browser
  // paints, so the next keystroke already lands in the input.
  useLayoutEffect(() => {
    if (!props.open) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    // Keep the caret after the handed-over text so the user just keeps typing.
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }, [props.open]);

  // The focus stays inside the palette while it is open (aria-modal): an
  // overlay closing underneath — the assistant drawer restoring the focus to
  // its trigger at the end of its 400 ms exit transition after ⌘K (L6b-07) —
  // must not leave the operator typing into the toolbar.
  useEffect(() => {
    if (!props.open) return;
    function onFocusIn(event: FocusEvent) {
      const root = overlayRef.current;
      const input = inputRef.current;
      if (!root || !input || root.contains(event.target as Node) || document.activeElement === input) return;
      input.focus();
    }
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
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
        id: `screen:${entry.screenKey}`,
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
      items.push({ ...match, source: "recent", id: `recent:${screen}`, subtitle: match.group, group: RECENT_GROUP });
      if (items.length >= MAX_RECENT) break;
    }
    return items;
  }, [recent, allScreens]);

  const filteredScreens = useMemo(() => filterScreenItems(allScreens, query), [query, allScreens]);

  const filteredActions = useMemo(() => {
    const q = normalizeMenuText(query);
    if (!q) return ACTION_ITEMS;
    return ACTION_ITEMS.filter((item) => normalizeMenuText(item.label).includes(q));
  }, [query]);

  const pageItems = useMemo(() => pageCommandItems(pageCommands, query), [pageCommands, query]);

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

  // Entity hits (rooms first for a room number) each followed by its actions.
  const liveItems = useMemo<CommandItem[]>(() => liveHitItems(liveHits, query, todayIso()), [liveHits, query]);

  const filtered = useMemo(
    () => buildPaletteItems({ pageItems, liveItems, recentItems, screenItems: filteredScreens, actionItems: filteredActions, query }),
    [pageItems, liveItems, recentItems, filteredScreens, filteredActions, query]
  );

  useEffect(() => {
    setActiveIdx(0);
  }, [filtered.length]);

  // Layout effect on purpose: the listener must exist before the next key
  // event, even when the screen underneath is still rendering (an Esc or ↓
  // pressed right after opening was lost with a passive effect).
  useLayoutEffect(() => {
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

  // Keep the active option in view when moving with the arrows.
  const activeItem = filtered[activeIdx];
  const activeDomId = activeItem ? optionDomId(listId, activeItem.id) : undefined;
  useEffect(() => {
    if (!props.open || !activeDomId || typeof document === "undefined") return;
    document.getElementById(activeDomId)?.scrollIntoView?.({ block: "nearest" });
  }, [props.open, activeDomId]);

  function commit(item: CommandItem) {
    if (item.event && item.hit) {
      // Hit action: the screen that owns the flow claims the event; otherwise open the reservation.
      const hit = item.hit;
      props.onClose();
      const event = hitActionEvent(item.event, hit);
      window.dispatchEvent(event);
      if (event.defaultPrevented) return;
      if (props.onSelectHit) props.onSelectHit(hit);
      else props.onSelect(hit.screen);
      return;
    }
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
  // Show the page's commands first, then entity groups, then screens. Keep insertion order otherwise.
  const groupOrder = Array.from(new Set(filtered.map((it) => it.group)));
  // With text the assistant item is always listed: «Buscando…» must still show while /search is in flight and nothing else matched yet.
  const onlyAssistant = filtered.length > 0 && filtered.every((it) => it.source === "assistant");

  return (
    <div ref={overlayRef} className="c22-cmdk-overlay" role="dialog" aria-modal="true" aria-label="Buscar en la aplicación" onClick={props.onClose}>
      <div className="c22-cmdk" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          type="search"
          className="c22-cmdk-input"
          placeholder="Buscar reserva, huésped, habitación, factura, pantalla o comando…"
          aria-label="Buscar (escribe al menos 2 caracteres)"
          aria-controls={listId}
          aria-activedescendant={activeDomId}
          aria-autocomplete="list"
          autoComplete="off"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setActiveIdx(0); }}
        />
        <div id={listId} className="c22-cmdk-list" role="listbox" aria-label="Resultados de búsqueda">
          {liveLoading && (filtered.length === 0 || onlyAssistant) ? (
            <div role="status" aria-live="polite" className="c22-cmdk-status">Buscando…</div>
          ) : null}
          {liveError ? (
            <div role="alert" className="c22-cmdk-error">{liveError}</div>
          ) : null}
          {!liveLoading && filtered.length === 0 ? (
            <div className="c22-cmdk-empty">
              {query.trim() ? `Sin resultados para "${query}"` : "Empieza a escribir para buscar o para preguntar al asistente"}
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
                    const badgeTone: CocoaTone = item.badgeTone ?? (item.hit ? (KIND_BADGE_TONE[item.hit.kind] ?? "info") : "neutral");
                    const meta =
                      item.source === "recent" ? "Reciente"
                        : item.source === "page" ? (item.shortcut ? <CocoaKbd>{item.shortcut}</CocoaKbd> : "Comando")
                        : item.source === "hit-action" ? "Acción"
                        : item.source === "assistant" ? <CocoaBadge tone="ai" size="small">IA</CocoaBadge>
                        : item.group;
                    return (
                      <div
                        key={item.id}
                        id={optionDomId(listId, item.id)}
                        role="option"
                        aria-selected={globalIdx === activeIdx}
                        className="c22-cmdk-item"
                        data-source={item.source}
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
                        <span className="c22-cmdk-item-meta">{meta}</span>
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
