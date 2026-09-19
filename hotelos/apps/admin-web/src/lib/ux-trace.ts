// Tanda UX-1 · lote U1 · trazas de uso para las pruebas con recepcionistas
// (docs/design/UX-RECEPCION-FEEL.md §6.4 «Medidas · Cliente» y §8.4 modo C).
//
// Registra, por sesión de prueba (`sessionId`) y tarea (`taskId`, T1…T6), los
// clics, teclas, cambios de ruta, overlays (role="dialog") y fetch inicio/fin,
// con `performance.mark/measure` de nombres estables (`ui:<pantalla>:<acción>`),
// en IndexedDB (`hotelos-ux-trace`) y exporta JSON al final de la sesión.
//
// SIN PII por construcción (corrector UX1-REV-07 / R1): se guardan ids, roles,
// data-testid, rutas sin query string y códigos de tecla normalizados («char»
// para cualquier carácter imprimible). La ETIQUETA de un control solo se guarda
// para botones, enlaces, pestañas y elementos de menú NATIVOS (`button`, `a`,
// `summary`, role tab/menuitem/checkbox/radio/switch) y recortada al primer
// separador («·», «:», «—», «(») o conector («de», «del», «a», «para», «con»,
// «en»): «Más acciones de Ana Alfa» → «Más acciones». Nunca para `role="option"`
// (⌘K), `role="button"` (barras del cronograma, filas-tarjeta) ni `role="link"`,
// cuyo texto es la entidad. Nunca el valor de un campo, el texto de una fila ni
// lo tecleado. Cada evento pasa además por el breadcrumb inyectado
// (lib/breadcrumb.ts logBreadcrumb, categorías "ui" | "api") para Sentry cuando
// hay VITE_SENTRY_DSN, SIN la etiqueta (`name`): al breadcrumb solo llegan
// tag / role / id / testId.
//
// Este módulo no toca el DOM al importarse (los tests corren en node --test):
// `install(window)` engancha los listeners y devuelve la función que los quita.

export type UxTraceKind = "session" | "task" | "click" | "keydown" | "route" | "overlay" | "fetch:start" | "fetch:end" | "mark";

export type UxTraceEvent = {
  seq: number;
  /** ms desde el arranque de la sesión de prueba. */
  t: number;
  at: string;
  sessionId: string;
  taskId: string;
  kind: UxTraceKind;
  data: Record<string, unknown>;
};

export type UxTraceStore = {
  append(event: UxTraceEvent): Promise<void>;
  list(sessionId?: string): Promise<UxTraceEvent[]>;
  clear(): Promise<void>;
};

export type UxTraceBreadcrumb = (message: string, category: "ui" | "api", data?: Record<string, unknown>) => void;

export type UxTraceExport = {
  version: 1;
  sessionId: string;
  taskId: string;
  exportedAt: string;
  events: UxTraceEvent[];
};

export type UxTrace = {
  readonly sessionId: string;
  readonly taskId: string;
  record(kind: UxTraceKind, data?: Record<string, unknown>): UxTraceEvent;
  setTask(taskId: string): void;
  /** T1 → T2 → … (⌘⇧T del moderador). */
  nextTask(): string;
  /** performance.mark con nombre estable `ui:<screen>:<action>` y evento "mark". */
  mark(screen: string, action: string): void;
  events(): Promise<UxTraceEvent[]>;
  exportJson(): Promise<string>;
  clear(): Promise<void>;
  install(win: Window): () => void;
};

// ---------------------------------------------------------------------------
// Identificadores y normalización (puros, sin DOM)
// ---------------------------------------------------------------------------

export function newSessionId(now: number = Date.now()): string {
  return `ux-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** "T1" → "T2"; cualquier otra cosa → "T1". */
export function nextTaskId(current: string | null | undefined): string {
  const match = /^T(\d+)$/i.exec((current ?? "").trim());
  return match ? `T${Number(match[1]) + 1}` : "T1";
}

/** Ruta sin origen ni query string (la query puede llevar lo buscado: `?q=…`). */
export function sanitizePath(url: string): { path: string; hasQuery: boolean } {
  const withoutHash = url.split("#")[0] ?? "";
  const queryIndex = withoutHash.indexOf("?");
  const beforeQuery = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
  const path = beforeQuery.replace(/^[a-z]+:\/\/[^/]+/i, "") || "/";
  return { path, hasQuery: queryIndex >= 0 };
}

const NAVIGATION_KEYS = new Set(["Enter", "Escape", "Tab", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", " "]);

export type KeyLike = { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean };

/** «Meta+Shift+T», «Enter», «char» (cualquier carácter imprimible sin modificador: nunca se guarda cuál). */
export function describeKey(event: KeyLike): string {
  const modifiers: string[] = [];
  if (event.metaKey) modifiers.push("Meta");
  if (event.ctrlKey) modifiers.push("Ctrl");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  const key = event.key ?? "";
  const printable = key.length === 1 && key !== " ";
  if (printable && modifiers.length === 0) return "char";
  if (printable) return `${modifiers.join("+")}+${key.toLowerCase()}`;
  const name = key === " " ? "Space" : key;
  if (NAVIGATION_KEYS.has(key) || /^F\d{1,2}$/.test(key) || key === "Meta" || key === "Control" || key === "Alt" || key === "Shift") {
    return modifiers.length ? `${modifiers.join("+")}+${name}` : name;
  }
  return modifiers.length ? `${modifiers.join("+")}+${name}` : name;
}

export type ElementLike = {
  tagName?: string;
  getAttribute?: (name: string) => string | null;
  closest?: (selector: string) => ElementLike | null;
  textContent?: string | null;
};

export type ElementDescription = {
  tag: string;
  role?: string;
  /** Etiqueta del control (solo elementos interactivos, ≤ 48 caracteres). */
  name?: string;
  id?: string;
  testId?: string;
};

const INTERACTIVE_SELECTOR = 'button, a, [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], summary';
const FIELD_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
/** Controles cuya etiqueta es copy de la aplicación (nunca la entidad): se guarda recortada. */
const LABELLED_TAGS = new Set(["BUTTON", "A", "SUMMARY"]);
const LABELLED_ROLES = new Set(["tab", "menuitem", "checkbox", "radio", "switch"]);
/** Separadores y conectores tras los que empieza el dato de la entidad («Más acciones de Ana Alfa», «Reserva X de …», «Cobrar 12,00 € · …»). */
const LABEL_CUT = /\s*(?:[·:—(\[]|\s(?:de|del|a|al|para|con|en)\s)/i;

/** Etiqueta PII-safe de un control (pura): solo copy estático antes del primer separador o conector; ≤ 48 caracteres. */
export function scrubLabel(label: string | null | undefined): string | undefined {
  const text = (label ?? "").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  const cut = text.split(LABEL_CUT)[0]?.trim() ?? "";
  return (cut || undefined)?.slice(0, 48);
}

/** Si el control pulsado admite etiqueta (pura): nativo o con uno de los roles de copy estático; nunca option / button / link por rol. */
export function isLabelledControl(el: ElementLike | null | undefined): boolean {
  if (!el) return false;
  const role = el.getAttribute?.("role") ?? "";
  if (role) return LABELLED_ROLES.has(role);
  return LABELLED_TAGS.has((el.tagName ?? "").toUpperCase());
}

function attr(el: ElementLike | null | undefined, name: string): string | undefined {
  const value = el?.getAttribute?.(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Descripción PII-safe de un objetivo de clic: nunca valores de campos ni texto de filas. */
export function describeElement(target: unknown): ElementDescription {
  const el = (target ?? null) as ElementLike | null;
  const tag = (el?.tagName ?? "unknown").toLowerCase();
  const interactive = el?.closest?.(INTERACTIVE_SELECTOR) ?? null;
  const field = FIELD_TAGS.has((el?.tagName ?? "").toUpperCase()) ? el : null;
  const subject = interactive ?? field ?? el;
  const description: ElementDescription = { tag: subject === el ? tag : (subject?.tagName ?? tag).toLowerCase() };
  const role = attr(subject, "role");
  if (role) description.role = role;
  const id = attr(subject, "id");
  if (id) description.id = id;
  const testId = attr(subject, "data-testid");
  if (testId) description.testId = testId;
  if (interactive) {
    if (isLabelledControl(interactive)) {
      const label = scrubLabel(attr(interactive, "aria-label") ?? attr(interactive, "title") ?? interactive.textContent);
      if (label) description.name = label;
    }
  } else if (field) {
    // Un campo se identifica por su etiqueta accesible o su nombre, jamás por su valor.
    const label = attr(field, "aria-label") ?? attr(field, "name") ?? attr(field, "placeholder");
    if (label) description.name = label.slice(0, 48);
    description.role = description.role ?? (attr(field, "type") ?? tag);
  }
  return description;
}

// ---------------------------------------------------------------------------
// Almacenes
// ---------------------------------------------------------------------------

export function createMemoryStore(): UxTraceStore {
  const events: UxTraceEvent[] = [];
  return {
    async append(event) {
      events.push(event);
    },
    async list(sessionId) {
      return events.filter((e) => !sessionId || e.sessionId === sessionId);
    },
    async clear() {
      events.length = 0;
    }
  };
}

type IdbFactoryLike = { open(name: string, version?: number): IDBOpenDBRequest };

/**
 * IndexedDB (`hotelos-ux-trace` / `events`, índice por sessionId). Si el
 * navegador no lo ofrece, cae a memoria (la exportación sigue funcionando).
 */
export function createIndexedDbStore(dbName = "hotelos-ux-trace", storeName = "events", factory?: IdbFactoryLike): UxTraceStore {
  const idb = factory ?? (typeof indexedDB !== "undefined" ? (indexedDB as IdbFactoryLike) : undefined);
  if (!idb) return createMemoryStore();
  const fallback = createMemoryStore();
  let dbPromise: Promise<IDBDatabase | null> | null = null;

  function open(): Promise<IDBDatabase | null> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      try {
        const request = idb!.open(dbName, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(storeName)) {
            const store = db.createObjectStore(storeName, { keyPath: "key", autoIncrement: true });
            store.createIndex("sessionId", "sessionId", { unique: false });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return dbPromise;
  }

  function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
    return open().then(
      (db) =>
        new Promise<T | null>((resolve) => {
          if (!db) {
            resolve(null);
            return;
          }
          try {
            const tx = db.transaction(storeName, mode);
            const request = work(tx.objectStore(storeName));
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => resolve(null);
          } catch {
            resolve(null);
          }
        })
    );
  }

  return {
    async append(event) {
      const written = await run("readwrite", (store) => store.add(event));
      if (written === null) await fallback.append(event);
    },
    async list(sessionId) {
      const rows = (await run<UxTraceEvent[]>("readonly", (store) => (sessionId ? store.index("sessionId").getAll(sessionId) : store.getAll()))) ?? [];
      const memory = await fallback.list(sessionId);
      return [...rows, ...memory].sort((a, b) => a.seq - b.seq);
    },
    async clear() {
      await run("readwrite", (store) => store.clear());
      await fallback.clear();
    }
  };
}

// ---------------------------------------------------------------------------
// Trazador
// ---------------------------------------------------------------------------

export type UxTraceOptions = {
  sessionId?: string;
  taskId?: string;
  store?: UxTraceStore;
  breadcrumb?: UxTraceBreadcrumb;
  now?: () => number;
  /** performance.mark inyectable (por defecto `performance` global si existe). */
  perf?: { mark: (name: string) => unknown; measure?: (name: string, start: string, end: string) => unknown };
};

/** Datos de un evento para el breadcrumb de Sentry (puro): el `target` viaja sin `name` (solo tag / role / id / testId). */
export function breadcrumbData(data: Record<string, unknown>): Record<string, unknown> {
  const target = data.target;
  if (!target || typeof target !== "object") return data;
  const { name: _name, ...rest } = target as ElementDescription;
  return { ...data, target: rest };
}

export function createUxTrace(options: UxTraceOptions = {}): UxTrace {
  const now = options.now ?? (() => Date.now());
  const store = options.store ?? createMemoryStore();
  const breadcrumb = options.breadcrumb ?? (() => undefined);
  const perf = options.perf ?? (typeof performance !== "undefined" ? performance : undefined);
  const sessionId = options.sessionId ?? newSessionId(now());
  const startedAt = now();
  let taskId = options.taskId ?? "T1";
  let seq = 0;

  function record(kind: UxTraceKind, data: Record<string, unknown> = {}): UxTraceEvent {
    seq += 1;
    const event: UxTraceEvent = {
      seq,
      t: now() - startedAt,
      at: new Date(now()).toISOString(),
      sessionId,
      taskId,
      kind,
      data
    };
    void store.append(event);
    breadcrumb(`ux.${kind}`, kind.startsWith("fetch") ? "api" : "ui", { sessionId, taskId, seq, ...breadcrumbData(data) });
    return event;
  }

  record("session", { startedAt: new Date(startedAt).toISOString() });

  const trace: UxTrace = {
    sessionId,
    get taskId() {
      return taskId;
    },
    record,
    setTask(next) {
      taskId = next.trim() || taskId;
      record("task", { taskId });
    },
    nextTask() {
      trace.setTask(nextTaskId(taskId));
      return taskId;
    },
    mark(screen, action) {
      const name = `ui:${screen}:${action}`;
      try {
        perf?.mark(name);
      } catch {
        /* performance.mark no disponible */
      }
      record("mark", { name });
    },
    events: () => store.list(sessionId),
    async exportJson() {
      const payload: UxTraceExport = { version: 1, sessionId, taskId, exportedAt: new Date(now()).toISOString(), events: await store.list(sessionId) };
      return JSON.stringify(payload, null, 2);
    },
    clear: () => store.clear(),
    install(win) {
      return installListeners(win, trace);
    }
  };
  return trace;
}

// ---------------------------------------------------------------------------
// Listeners de navegador (solo en install)
// ---------------------------------------------------------------------------

function installListeners(win: Window, trace: UxTrace): () => void {
  const doc = win.document;
  const cleanups: Array<() => void> = [];
  const currentScreen = () => sanitizePath(win.location.pathname).path;

  const onClick = (event: MouseEvent) => {
    trace.record("click", { screen: currentScreen(), target: describeElement(event.target), button: event.button });
  };
  doc.addEventListener("click", onClick, true);
  cleanups.push(() => doc.removeEventListener("click", onClick, true));

  const onKeydown = (event: KeyboardEvent) => {
    const target = event.target as ElementLike | null;
    const inField = FIELD_TAGS.has((target?.tagName ?? "").toUpperCase());
    trace.record("keydown", { screen: currentScreen(), key: describeKey(event), inField });
  };
  doc.addEventListener("keydown", onKeydown, true);
  cleanups.push(() => doc.removeEventListener("keydown", onKeydown, true));

  // Rutas: la app navega con history.pushState/replaceState (lib/navigate.ts, BackOfficeLayout) y popstate.
  let lastPath = currentScreen();
  const recordRoute = (via: string) => {
    const next = currentScreen();
    if (next === lastPath) return;
    trace.record("route", { from: lastPath, to: next, via });
    lastPath = next;
  };
  const history = win.history;
  const originalPush = history.pushState.bind(history);
  const originalReplace = history.replaceState.bind(history);
  history.pushState = function pushState(...args: Parameters<History["pushState"]>) {
    originalPush(...args);
    recordRoute("pushState");
  };
  history.replaceState = function replaceState(...args: Parameters<History["replaceState"]>) {
    originalReplace(...args);
    recordRoute("replaceState");
  };
  const onPopState = () => recordRoute("popstate");
  win.addEventListener("popstate", onPopState);
  cleanups.push(() => {
    history.pushState = originalPush;
    history.replaceState = originalReplace;
    win.removeEventListener("popstate", onPopState);
  });

  // Overlays: apertura/cierre de role="dialog" (drawers, diálogos, ⌘K, recorrido).
  const describeDialog = (el: Element) => ({
    role: el.getAttribute("role") ?? "dialog",
    id: el.getAttribute("id") ?? undefined,
    className: (el.getAttribute("class") ?? "").split(/\s+/)[0] || undefined,
    modal: el.getAttribute("aria-modal") === "true"
  });
  const dialogsIn = (node: Node): Element[] => {
    if (!(node instanceof Element)) return [];
    const found: Element[] = [];
    if (node.getAttribute("role") === "dialog") found.push(node);
    node.querySelectorAll('[role="dialog"]').forEach((el) => found.push(el));
    return found;
  };
  if (typeof MutationObserver === "function" && doc.body) {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => dialogsIn(node).forEach((el) => trace.record("overlay", { screen: currentScreen(), state: "open", ...describeDialog(el) })));
        mutation.removedNodes.forEach((node) => dialogsIn(node).forEach((el) => trace.record("overlay", { screen: currentScreen(), state: "close", ...describeDialog(el) })));
      }
    });
    observer.observe(doc.body, { childList: true, subtree: true });
    cleanups.push(() => observer.disconnect());
  }

  // fetch inicio/fin: método, ruta sin query, estado y duración (nunca cuerpos ni cabeceras).
  const originalFetch = win.fetch.bind(win);
  let fetchSeq = 0;
  win.fetch = function tracedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    fetchSeq += 1;
    const reqId = fetchSeq;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET") ?? "GET").toUpperCase();
    const { path, hasQuery } = sanitizePath(url);
    const startedAt = Date.now();
    trace.record("fetch:start", { reqId, method, path, hasQuery, screen: currentScreen() });
    return originalFetch(input, init).then(
      (response) => {
        trace.record("fetch:end", { reqId, method, path, status: response.status, ms: Date.now() - startedAt });
        return response;
      },
      (error: unknown) => {
        trace.record("fetch:end", { reqId, method, path, status: 0, ms: Date.now() - startedAt, error: error instanceof Error ? error.name : "error" });
        throw error;
      }
    );
  };
  cleanups.push(() => {
    win.fetch = originalFetch;
  });

  return () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  };
}
