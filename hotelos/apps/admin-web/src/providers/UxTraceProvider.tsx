// Tanda UX-1 · lote U1 · modo prueba (docs/design/UX-RECEPCION-FEEL.md §8.4 C).
//
// Se monta en main.tsx SOLO con `VITE_UX_TRACE=1` (fuera de App.tsx, que toca
// U4). Arranca lib/ux-trace.ts sobre IndexedDB, engancha clic / tecla / ruta /
// overlay / fetch, y ofrece al moderador:
//
//   · ⌘⇧T (Ctrl+Shift+T)  → tarea siguiente (T1 → T2 → …);
//   · ⌘⇧E (Ctrl+Shift+E)  → exporta el JSON de la sesión (descarga
//                            `ux-trace-<sessionId>.json`);
//   · window.__hotelosUxTrace → { sessionId, taskId, nextTask, setTask,
//                            exportJson, download, clear } desde la consola.
//
// Los cambios de tarea y las exportaciones se anuncian en una región
// `role="status"` visualmente oculta (.cocoa-sr-only). Cada evento pasa también
// por logBreadcrumb (lib/breadcrumb.ts) con categoría "ui" | "api".
import { useEffect, useState, type ReactNode } from "react";
import { createIndexedDbStore, createUxTrace, type UxTrace } from "../lib/ux-trace";
import { logBreadcrumb } from "../lib/breadcrumb";

export const UX_TRACE_ENABLED = import.meta.env.VITE_UX_TRACE === "1";

export type UxTraceConsoleApi = {
  sessionId: string;
  readonly taskId: string;
  nextTask: () => string;
  setTask: (taskId: string) => void;
  exportJson: () => Promise<string>;
  download: () => Promise<void>;
  clear: () => Promise<void>;
};

declare global {
  interface Window {
    __hotelosUxTrace?: UxTraceConsoleApi;
  }
}

function isTaskShortcut(event: KeyboardEvent, letter: string): boolean {
  return (event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === letter;
}

async function downloadExport(trace: UxTrace): Promise<void> {
  const json = await trace.exportJson();
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `ux-trace-${trace.sessionId}.json`;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function UxTraceProvider({ children }: { children: ReactNode }) {
  const [announcement, setAnnouncement] = useState<string>("");

  useEffect(() => {
    if (!UX_TRACE_ENABLED) return undefined;
    const trace = createUxTrace({ store: createIndexedDbStore(), breadcrumb: logBreadcrumb });
    const uninstall = trace.install(window);
    setAnnouncement(`Modo prueba activo · sesión ${trace.sessionId} · tarea ${trace.taskId}`);

    const api: UxTraceConsoleApi = {
      sessionId: trace.sessionId,
      get taskId() {
        return trace.taskId;
      },
      nextTask: () => {
        const next = trace.nextTask();
        setAnnouncement(`Tarea ${next}`);
        return next;
      },
      setTask: (taskId) => {
        trace.setTask(taskId);
        setAnnouncement(`Tarea ${trace.taskId}`);
      },
      exportJson: () => trace.exportJson(),
      download: async () => {
        await downloadExport(trace);
        setAnnouncement(`Sesión ${trace.sessionId} exportada`);
      },
      clear: () => trace.clear()
    };
    window.__hotelosUxTrace = api;

    function onKeydown(event: KeyboardEvent) {
      if (isTaskShortcut(event, "t")) {
        event.preventDefault();
        api.nextTask();
      } else if (isTaskShortcut(event, "e")) {
        event.preventDefault();
        void api.download();
      }
    }
    window.addEventListener("keydown", onKeydown);
    // eslint-disable-next-line no-console
    console.info(`[ux-trace] modo prueba · sesión ${trace.sessionId} · ⌘⇧T tarea siguiente · ⌘⇧E exportar · window.__hotelosUxTrace`);

    return () => {
      window.removeEventListener("keydown", onKeydown);
      uninstall();
      if (window.__hotelosUxTrace === api) delete window.__hotelosUxTrace;
    };
  }, []);

  return (
    <>
      {children}
      {UX_TRACE_ENABLED ? (
        <div role="status" aria-live="polite" className="cocoa-sr-only" data-ux-trace="status">
          {announcement}
        </div>
      ) : null}
    </>
  );
}
