import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  TAB_CHANGED_EVENT,
  TAB_NAV_EVENT,
  hrefForTab,
  isBaseTab,
  nextTabKey,
  pickLandingTab,
  resolveTabKey,
  tabPath,
  type CocoaRouteTab
} from "../CocoaRouteTabs.tsx";

const BASE = "/recepcion/reservas";
const TABS: CocoaRouteTab[] = [
  { key: "lista", label: "Lista" },
  { key: "cronograma", label: "Cronograma" },
  { key: "tablero", label: "Tablero de habitaciones" },
  { key: "detalle", label: "Detalle", path: "/recepcion/reservas/:id", hidden: true },
  { key: "recorrido", label: "Recorrido", path: "/recepcion/reservas/:id/recorrido", hidden: true },
  { key: "nueva", label: "Nueva reserva", path: "/recepcion/reservas/nueva" }
];

describe("CocoaRouteTabs · events", () => {
  it("uses its own channel, never the shell's hotelos-nav", () => {
    assert.equal(TAB_NAV_EVENT, "hotelos-tab-nav");
    assert.equal(TAB_CHANGED_EVENT, "hotelos-tab-changed");
  });
});

describe("CocoaRouteTabs · tabPath", () => {
  it("derives the path from basePath + key unless overridden", () => {
    assert.equal(tabPath(BASE, { key: "lista" }), "/recepcion/reservas/lista");
    assert.equal(tabPath(`${BASE}/`, { key: "lista" }), "/recepcion/reservas/lista");
    assert.equal(tabPath(BASE, { key: "detalle", path: "/recepcion/reservas/:id/" }), "/recepcion/reservas/:id");
    assert.equal(tabPath(BASE, { key: "" }), BASE);
    assert.equal(tabPath("/", { key: "hoy" }), "/hoy");
    assert.equal(isBaseTab("/hoy", { key: "recepcion", path: "/hoy" }), true);
    assert.equal(isBaseTab("/hoy", { key: "operaciones" }), false);
  });
});

describe("CocoaRouteTabs · resolveTabKey", () => {
  it("matches static tabs, param tabs and nested param tabs; static wins", () => {
    assert.equal(resolveTabKey("/recepcion/reservas/lista", BASE, TABS), "lista");
    assert.equal(resolveTabKey("/recepcion/reservas/lista/", BASE, TABS), "lista");
    assert.equal(resolveTabKey("/recepcion/reservas/lista?estado=abierta", BASE, TABS), "lista");
    assert.equal(resolveTabKey("/recepcion/reservas/RS-1", BASE, TABS), "detalle");
    assert.equal(resolveTabKey("/recepcion/reservas/nueva", BASE, TABS), "nueva");
    assert.equal(resolveTabKey("/recepcion/reservas/RS-1/recorrido", BASE, TABS), "recorrido");
  });

  it("returns null on the bare base path and outside the container", () => {
    assert.equal(resolveTabKey(BASE, BASE, TABS), null);
    assert.equal(resolveTabKey("/hoy", BASE, TABS), null);
    assert.equal(resolveTabKey("/recepcion/reservas/RS-1/otra", BASE, TABS), null);
    assert.equal(resolveTabKey("/hoy", "/hoy", [{ key: "recepcion", path: "/hoy" }, { key: "operaciones" }]), "recepcion");
  });
});

describe("CocoaRouteTabs · pickLandingTab", () => {
  const visibleKeys = ["lista", "cronograma", "tablero"];

  it("keeps the tab named in the URL when it is visible", () => {
    assert.equal(pickLandingTab({ resolvedKey: "tablero", visibleKeys, defaultTab: "lista", isMobile: false }), "tablero");
    assert.equal(pickLandingTab({ resolvedKey: "tablero", visibleKeys, defaultTab: "lista", mobileDefaultTab: "cronograma", isMobile: true }), "tablero");
  });

  it("lands on the mobile default below the breakpoint, the default otherwise", () => {
    assert.equal(pickLandingTab({ resolvedKey: null, visibleKeys, defaultTab: "lista", mobileDefaultTab: "tablero", isMobile: true }), "tablero");
    assert.equal(pickLandingTab({ resolvedKey: null, visibleKeys, defaultTab: "lista", mobileDefaultTab: "tablero", isMobile: false }), "lista");
    assert.equal(pickLandingTab({ resolvedKey: null, visibleKeys, defaultTab: "lista", isMobile: true }), "lista");
  });

  it("falls back to the first visible tab and to null when nothing is visible", () => {
    assert.equal(pickLandingTab({ resolvedKey: "lista", visibleKeys: ["cronograma", "tablero"], defaultTab: "lista", isMobile: false }), "cronograma");
    assert.equal(pickLandingTab({ resolvedKey: null, visibleKeys: ["tablero"], defaultTab: "lista", mobileDefaultTab: "cronograma", isMobile: true }), "tablero");
    assert.equal(pickLandingTab({ resolvedKey: "lista", visibleKeys: [], defaultTab: "lista", isMobile: false }), null);
  });
});

describe("CocoaRouteTabs · hrefForTab", () => {
  it("keeps the query string only when asked and never the hash", () => {
    assert.equal(hrefForTab("/a", "?desde=2026-09-01&hasta=2026-09-30", true), "/a?desde=2026-09-01&hasta=2026-09-30");
    assert.equal(hrefForTab("/a", "desde=1", true), "/a?desde=1");
    assert.equal(hrefForTab("/a", "?desde=1", false), "/a");
    assert.equal(hrefForTab("/a", "", true), "/a");
    assert.equal(hrefForTab("/a", "?", true), "/a");
  });
});

describe("CocoaRouteTabs · keyboard (roving focus)", () => {
  const keys = ["lista", "cronograma", "tablero"];

  it("moves with arrows (wrapping), Home and End; ignores other keys", () => {
    assert.equal(nextTabKey("lista", keys, "ArrowRight"), "cronograma");
    assert.equal(nextTabKey("tablero", keys, "ArrowRight"), "lista");
    assert.equal(nextTabKey("lista", keys, "ArrowLeft"), "tablero");
    assert.equal(nextTabKey("cronograma", keys, "ArrowDown"), "tablero");
    assert.equal(nextTabKey("cronograma", keys, "ArrowUp"), "lista");
    assert.equal(nextTabKey("tablero", keys, "Home"), "lista");
    assert.equal(nextTabKey("lista", keys, "End"), "tablero");
    assert.equal(nextTabKey("lista", keys, "Enter"), null);
    assert.equal(nextTabKey("lista", keys, "Tab"), null);
  });

  it("starts from the first tab when the focused key is unknown or null", () => {
    assert.equal(nextTabKey("nope", keys, "ArrowRight"), "cronograma");
    assert.equal(nextTabKey(null, keys, "ArrowLeft"), "tablero");
    assert.equal(nextTabKey("lista", [], "ArrowRight"), null);
  });
});
