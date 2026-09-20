import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertNoLoginGate } from "../_helpers";
import { PISOS, forceCoarse, loginAsPisos } from "./_pisos";

/**
 * Auditoría táctil de pisos y mantenimiento (Tanda UX-3 · lote U0 ·
 * docs/design/UX-PISOS-MANTENIMIENTO-FEEL.md §6; mismo método que
 * e2e/target-size.spec.ts de UX-1 U10, que no se toca: contrato
 * target-size-contract). Proyecto Playwright `touch` (hasTouch → `pointer:
 * coarse`, reforzado por CDP), tablet de pasillo vertical 820 × 1180 y iPad
 * apaisado 1024 × 768, claro y oscuro, sobre el tenant UXDAY (seed-ux-day +
 * seed-ux-day-pisos) con la persona de cada pantalla:
 *
 *   · /operaciones/pisos (gobernanta) · /operaciones/pisos/mi-turno (camarera)
 *   · /operaciones/mantenimiento (encargado) · …/mis-averias (técnico)
 *   · /recepcion/reservas/tablero (gobernanta)
 *   y sus cajones: Nueva tarea, Reportar incidencia, ficha de la orden, Añadir
 *   nota y ficha de la habitación.
 *
 * Por pantalla: 0 objetivos interactivos < 24 × 24 px CSS (WCAG 2.2 · 2.5.8,
 * salvo enlaces en línea); los < 44 px (2.5.5 / Apple HIG; objetivo de la
 * tablet de pasillo, §6) se LISTAN en el JSON (`TARGET_SIZE_OUT`, por defecto
 * el outputDir) sin nombres (los controles de fila o tarjeta se describen por
 * su tipo); contraste de los badges: texto ≥ 4,5:1 (1.4.3) en claro y oscuro,
 * borde / punto ≥ 3:1 (1.4.11) afirmado en oscuro (en claro se anota).
 *
 * Tras UX-3 (Q1, F11 cerrada por P1/P2/P3): las cuatro páginas de pisos y
 * mantenimiento declaran `density="operational"` y con el dedo resuelven
 * `comfortable` (afirmado: `data-density-mode` + `data-cocoa-density`); Mi
 * turno y Mis averías pintan la barra del pulgar (`CocoaActionBar`, ya no
 * `mobileOnly` con puntero grueso) con todos sus controles ≥ 44 px (afirmado
 * a 820 × 1180 y 1024 × 768). El tablero de habitaciones conserva su densidad
 * (UX-1 U10) y no lleva barra.
 */

const VIEWPORTS = {
  apaisado: { width: 1024, height: 768 },
  vertical: { width: 820, height: 1180 }
} as const;

const SCHEMES = ["light", "dark"] as const;

type RouteId = "pisos" | "mi-turno" | "mantenimiento" | "mis-averias" | "tablero";

type Overlay = {
  id: string;
  /** Abre el cajón o la ficha y devuelve el elemento a esperar; null si no hay nada que abrir. */
  open: (page: Page) => Promise<Locator | null>;
};

type Route = {
  id: RouteId;
  path: string;
  /** Persona que usa la pantalla (usuarios de seed-ux-day-pisos). */
  user: string;
  /** Marcador de «pantalla lista» (datos pintados). */
  ready: (page: Page) => Locator;
  /** La página declara `density="operational"` (§6 P5): con el dedo debe resolver `comfortable`. */
  operational: boolean;
  /** Barra del pulgar (`CocoaActionBar`) esperada con puntero grueso, con controles ≥ 44 px. */
  actionBar: boolean;
  overlays?: readonly Overlay[];
};

const firstRoomCard = (page: Page) => page.getByRole("group", { name: /^Habitación \d+/ }).first();

const ROUTES: readonly Route[] = [
  {
    id: "pisos",
    path: PISOS.routes.pisos,
    user: PISOS.users.gobernanta,
    ready: (page) => page.getByRole("group", { name: "Filtrar habitaciones" }),
    operational: true,
    actionBar: false,
    overlays: [
      {
        id: "nueva-tarea",
        open: async (page) => {
          const button = firstRoomCard(page).getByRole("button", { name: "Nueva tarea", exact: true });
          if (!(await button.isVisible().catch(() => false))) return null;
          await button.click();
          const drawer = page.getByRole("dialog", { name: "Nueva tarea" });
          await expect(drawer).toBeVisible({ timeout: 10_000 });
          return drawer;
        }
      }
    ]
  },
  {
    id: "mi-turno",
    path: PISOS.routes.miTurno,
    user: PISOS.users.pisos,
    ready: (page) => page.getByRole("group", { name: "Filtrar por prioridad" }),
    operational: true,
    actionBar: true,
    overlays: [
      {
        id: "reportar",
        open: async (page) => {
          const button = firstRoomCard(page).getByRole("button", { name: "Reportar", exact: true });
          if (!(await button.isVisible().catch(() => false))) return null;
          await button.click();
          const drawer = page.getByRole("dialog", { name: "Reportar incidencia" });
          await expect(drawer).toBeVisible({ timeout: 10_000 });
          return drawer;
        }
      }
    ]
  },
  {
    id: "mantenimiento",
    path: PISOS.routes.mantenimiento,
    user: PISOS.users.encargado,
    ready: (page) => page.getByRole("group", { name: "Filtrar órdenes" }),
    operational: true,
    actionBar: false,
    overlays: [
      {
        id: "ficha",
        open: async (page) => {
          const row = page.getByRole("list", { name: "Órdenes de trabajo" }).getByRole("button").first();
          if (!(await row.isVisible().catch(() => false))) return null;
          await row.click();
          // < 900 px la ficha abre en un cajón; a 1024 px es la columna derecha. En ambos casos pinta «Datos de la orden».
          const detail = page.getByRole("list", { name: "Datos de la orden" });
          await expect(detail).toBeVisible({ timeout: 10_000 });
          return detail;
        }
      }
    ]
  },
  {
    id: "mis-averias",
    path: PISOS.routes.misAverias,
    user: PISOS.users.mantenimiento,
    ready: (page) => page.getByRole("group", { name: "Filtrar por prioridad" }),
    operational: true,
    actionBar: true,
    overlays: [
      {
        id: "nota",
        open: async (page) => {
          const button = page.getByRole("group", { name: /^Avería / }).first().getByRole("button", { name: "Nota", exact: true });
          if (!(await button.isVisible().catch(() => false))) return null;
          await button.click();
          const drawer = page.getByRole("dialog", { name: "Añadir nota" });
          await expect(drawer).toBeVisible({ timeout: 10_000 });
          return drawer;
        }
      }
    ]
  },
  {
    id: "tablero",
    path: PISOS.routes.tablero,
    user: PISOS.users.gobernanta,
    ready: (page) => page.locator(".c22-tile-grid").first(),
    // Recepción no cambia (UX-1 U10 dejó el tablero con su densidad y sin barra del pulgar).
    operational: false,
    actionBar: false,
    overlays: [
      {
        id: "ficha",
        open: async (page) => {
          const tile = page.locator(".c22-tile-grid").getByRole("button", { name: /^Habitación \d+/ }).first();
          if (!(await tile.isVisible().catch(() => false))) return null;
          await tile.click();
          const drawer = page.getByRole("dialog", { name: /^Habitación \d+/ });
          await expect(drawer.getByRole("button", { name: /^(Bloquear|Desbloquear) habitación$/ })).toBeVisible({ timeout: 10_000 });
          return drawer;
        }
      }
    ]
  }
];

/** Objetivo interactivo medido en la página (sin texto de filas ni tarjetas: nunca nombres). */
type TargetSample = { kind: string; label: string; w: number; h: number; min: number; inline: boolean };

type BadgeSample = {
  text: string;
  tone: string;
  variant: string;
  /** Contraste texto/fondo efectivo (WCAG 1.4.3, mínimo 4,5). */
  textRatio: number;
  /** Contraste borde/fondo si el borde se pinta (WCAG 1.4.11, mínimo 3). */
  borderRatio: number | null;
  /** Contraste del punto (variant dot) frente al fondo (1.4.11, mínimo 3). */
  dotRatio: number | null;
};

type Audit = {
  coarse: boolean;
  hoverNone: boolean;
  pages: Array<{ density: string | null; mode: string | null; touchLaptop: boolean }>;
  /** Barra de acciones del pulgar (CocoaActionBar) presente en el DOM (F11: con puntero grueso ya no es mobileOnly). */
  actionBar: boolean;
  /** Controles de la barra del pulgar: cuántos y el lado menor del más pequeño (objetivo ≥ 44 px, §6). */
  actionBarTargets: { count: number; min: number | null };
  totals: { targets: number; below24: number; below44: number; inlineExempt: number };
  below24: TargetSample[];
  below44: TargetSample[];
  badges: BadgeSample[];
};

/** Recorre el DOM visible: objetivos interactivos (tamaño) y badges (contraste). Se ejecuta en la página (copia de e2e/target-size.spec.ts auditPage + actionBar). */
function auditPage(): Audit {
  const INTERACTIVE =
    'a[href], button, input, select, textarea, summary, [role="button"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="checkbox"], [role="radio"], [role="switch"], [role="option"], [role="link"], [role="slider"], [role="row"][tabindex], [tabindex="0"]';

  const isVisible = (element: Element): boolean => {
    if (element.closest('[aria-hidden="true"], [hidden], .cocoa-sr-only')) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    if (element.getClientRects().length === 0) return false;
    return true;
  };

  const kindOf = (element: Element): string => {
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute("role");
    const cocoa = element.getAttribute("data-cocoa") ?? element.closest("[data-cocoa]")?.getAttribute("data-cocoa") ?? null;
    const type = tag === "input" ? `[${(element as HTMLInputElement).type}]` : "";
    return `${tag}${type}${role ? `[role=${role}]` : ""}${cocoa ? ` (${cocoa})` : ""}`;
  };

  const labelOf = (element: Element): string => {
    // Dentro de una fila, tarjeta o barra el texto puede ser un nombre: se describe solo por su tipo.
    if (element.closest('tr, [role="row"], .tl-bar, .c22-card, .cocoa-card, [data-cocoa="card"], [data-cocoa="inspector"], .tl-legend, .c22-tile-grid')) return "(fila/tarjeta)";
    const aria = element.getAttribute("aria-label") ?? element.getAttribute("title") ?? "";
    const text = aria || (element.textContent ?? "").replace(/\s+/g, " ").trim();
    return text.slice(0, 48);
  };

  const rectOf = (element: Element): DOMRect => {
    const input = element as HTMLInputElement;
    if (element.tagName === "INPUT" && (input.type === "checkbox" || input.type === "radio")) {
      const label = element.closest("label");
      if (label) return label.getBoundingClientRect();
    }
    return element.getBoundingClientRect();
  };

  const isInlineLink = (element: Element): boolean => {
    if (element.tagName !== "A") return false;
    const parent = element.parentElement;
    if (!parent) return false;
    if (!/^(P|SPAN|LI|TD|DD|SMALL|EM|STRONG)$/.test(parent.tagName)) return false;
    // Hay texto que no es enlace alrededor: el enlace forma parte de una frase.
    return Array.from(parent.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim().length > 0);
  };

  const seen = new Set<Element>();
  const samples: TargetSample[] = [];
  const actionBarSamples: TargetSample[] = [];
  for (const element of Array.from(document.querySelectorAll(INTERACTIVE))) {
    if (seen.has(element)) continue;
    seen.add(element);
    const input = element as HTMLInputElement;
    if (element.tagName === "INPUT" && (input.type === "hidden" || input.type === "file")) continue;
    if ((element as HTMLButtonElement).disabled || element.getAttribute("aria-disabled") === "true") continue;
    if (!isVisible(element)) continue;
    const rect = rectOf(element);
    const w = Math.round(rect.width * 100) / 100;
    const h = Math.round(rect.height * 100) / 100;
    if (w === 0 || h === 0) continue;
    const sample: TargetSample = { kind: kindOf(element), label: labelOf(element), w, h, min: Math.min(w, h), inline: isInlineLink(element) };
    samples.push(sample);
    if (element.closest('[data-cocoa="action-bar"]')) actionBarSamples.push(sample);
  }

  // ---- contraste (WCAG 2.x, fórmula de luminancia relativa sRGB)
  type Rgba = { r: number; g: number; b: number; a: number };
  const parseColor = (value: string): Rgba | null => {
    const match = value.match(/^rgba?\(([^)]+)\)$/);
    if (!match) return null;
    const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const over = (src: Rgba, dst: Rgba): Rgba => ({
    r: src.r * src.a + dst.r * (1 - src.a),
    g: src.g * src.a + dst.g * (1 - src.a),
    b: src.b * src.a + dst.b * (1 - src.a),
    a: 1
  });
  const luminance = (c: Rgba): number => {
    const channel = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  };
  const ratio = (a: Rgba, b: Rgba): number => {
    const la = luminance(a);
    const lb = luminance(b);
    const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  };
  /** Fondo efectivo bajo `element` (sin contar su propio fondo): los fondos de los ancestros compuestos de fuera hacia dentro. */
  const backdropOf = (element: Element): Rgba => {
    const stack: Rgba[] = [];
    for (let node = element.parentElement; node; node = node.parentElement) {
      const bg = parseColor(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0) stack.push(bg);
    }
    let result: Rgba = { r: 255, g: 255, b: 255, a: 1 };
    const rootBg = parseColor(getComputedStyle(document.documentElement).backgroundColor);
    if (rootBg && rootBg.a > 0) result = over(rootBg, result);
    for (const bg of stack.reverse()) result = over(bg, result);
    return result;
  };

  const badges: BadgeSample[] = [];
  for (const element of Array.from(document.querySelectorAll('[data-cocoa="badge"]'))) {
    if (!isVisible(element)) continue;
    const style = getComputedStyle(element);
    const backdrop = backdropOf(element);
    const own = parseColor(style.backgroundColor);
    const surface = own && own.a > 0 ? over(own, backdrop) : backdrop;
    const fg = parseColor(style.color);
    const border = parseColor(style.borderTopColor);
    const borderWidth = parseFloat(style.borderTopWidth) || 0;
    const variant = element.getAttribute("data-variant") ?? "outline";
    let dotRatio: number | null = null;
    if (variant === "dot") {
      const dot = parseColor(getComputedStyle(element, "::before").backgroundColor);
      if (dot && dot.a > 0) dotRatio = ratio(over(dot, backdrop), backdrop);
    }
    badges.push({
      text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40),
      tone: element.getAttribute("data-tone") ?? "neutral",
      variant,
      textRatio: fg ? ratio(over(fg, surface), surface) : 0,
      borderRatio: border && border.a > 0 && borderWidth > 0 ? ratio(over(border, backdrop), backdrop) : null,
      dotRatio
    });
  }

  const pages = Array.from(document.querySelectorAll('[data-cocoa="page"]')).map((page) => ({
    density: page.getAttribute("data-cocoa-density"),
    mode: page.getAttribute("data-density-mode"),
    touchLaptop: page.getAttribute("data-touch-laptop") === "true"
  }));

  const below24 = samples.filter((s) => s.min < 24);
  const below44 = samples.filter((s) => s.min < 44);
  return {
    coarse: matchMedia("(pointer: coarse)").matches,
    hoverNone: matchMedia("(hover: none)").matches,
    pages,
    actionBar: document.querySelector('[data-cocoa="action-bar"]') !== null,
    actionBarTargets: { count: actionBarSamples.length, min: actionBarSamples.length > 0 ? Math.min(...actionBarSamples.map((s) => s.min)) : null },
    totals: { targets: samples.length, below24: below24.length, below44: below44.length, inlineExempt: below24.filter((s) => s.inline).length },
    below24,
    below44,
    badges
  };
}

/** Agrupa los objetivos < 44 por tipo con su tamaño mínimo (para la tabla del informe). */
function summarize(samples: TargetSample[]): Array<{ kind: string; label: string; count: number; min: number }> {
  const groups = new Map<string, { kind: string; label: string; count: number; min: number }>();
  for (const sample of samples) {
    const key = `${sample.kind} · ${sample.label}`;
    const group = groups.get(key) ?? { kind: sample.kind, label: sample.label, count: 0, min: Number.POSITIVE_INFINITY };
    group.count += 1;
    group.min = Math.min(group.min, sample.min);
    groups.set(key, group);
  }
  return Array.from(groups.values()).sort((a, b) => a.min - b.min || b.count - a.count);
}

function writeAudit(testInfo: TestInfo, name: string, payload: unknown): void {
  const dir = process.env.TARGET_SIZE_OUT ?? testInfo.outputDir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function settle(page: Page): Promise<void> {
  // Sin esqueletos pendientes ni red en vuelo antes de medir (condición, no ventana fija).
  await page.waitForFunction(() => !document.querySelector('[data-skeleton="visible"], [data-skeleton="pending"]'), null, { timeout: 10_000 }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
}

for (const [orientation, viewport] of Object.entries(VIEWPORTS) as Array<[keyof typeof VIEWPORTS, { width: number; height: number }]>) {
  for (const scheme of SCHEMES) {
    test.describe(`pisos · tablet ${orientation} ${viewport.width}×${viewport.height} · ${scheme === "dark" ? "oscuro" : "claro"}`, () => {
      test.use({ viewport, colorScheme: scheme });

      for (const route of ROUTES) {
        test(`${route.id}: 0 objetivos < 24 px, badges con contraste AA; los < 44 px se listan`, async ({ page, request }, testInfo) => {
          await loginAsPisos(page, request, route.user);
          await forceCoarse(page);
          await page.goto(route.path, { waitUntil: "domcontentloaded" });
          await assertNoLoginGate(page, testInfo);
          await expect(route.ready(page)).toBeVisible({ timeout: 20_000 });
          await settle(page);

          const audit = await page.evaluate(auditPage);
          const name = `pisos-${route.id}-${orientation}-${scheme}`;
          writeAudit(testInfo, name, { route: route.path, user: route.user, viewport, scheme, ...audit, below44Summary: summarize(audit.below44) });
          if (process.env.TARGET_SIZE_OUT) await page.screenshot({ path: join(process.env.TARGET_SIZE_OUT, `${name}.png`) });
          // eslint-disable-next-line no-console
          console.log(`[target-size:${name}] targets=${audit.totals.targets} <24=${audit.totals.below24} (inline ${audit.totals.inlineExempt}) <44=${audit.totals.below44} badges=${audit.badges.length} actionBar=${audit.actionBar} (${audit.actionBarTargets.count} ≥ ${audit.actionBarTargets.min ?? "-"}) density=${audit.pages.map((p) => `${p.mode ?? "-"}/${p.density ?? "-"}`).join(",")}`);

          expect(audit.coarse, "la emulación táctil responde pointer: coarse").toBe(true);
          const offenders = audit.below24.filter((sample) => !sample.inline);
          expect(offenders, `objetivos < 24 × 24 px (2.5.8): ${JSON.stringify(offenders)}`).toEqual([]);

          // §6 P5: density="operational" resuelve `comfortable` con el dedo en las cuatro páginas de pisos y mantenimiento (F11).
          if (route.operational) {
            expect(audit.pages.some((p) => p.mode === "operational" && p.density === "comfortable"), `${route.id}: CocoaPage density="operational" → comfortable con puntero grueso (${JSON.stringify(audit.pages)})`).toBe(true);
          }
          // §6: la barra del pulgar (CocoaActionBar) está en la tablet y todos sus controles miden ≥ 44 px (F11).
          if (route.actionBar) {
            expect(audit.actionBar, `${route.id}: CocoaActionBar presente con puntero grueso`).toBe(true);
            expect(audit.actionBarTargets.count, `${route.id}: la barra del pulgar tiene controles`).toBeGreaterThan(0);
            expect(audit.actionBarTargets.min ?? 0, `${route.id}: controles de la barra del pulgar ≥ 44 px (mín. ${audit.actionBarTargets.min})`).toBeGreaterThanOrEqual(44);
          }

          // Cajones y fichas: los controles de los formularios de pisos/mantenimiento también miden ≥ 24 (44 con el dedo, listados).
          for (const overlay of route.overlays ?? []) {
            const target = await overlay.open(page);
            if (!target) continue;
            await settle(page);
            const overlayAudit = await page.evaluate(auditPage);
            writeAudit(testInfo, `${name}-${overlay.id}`, { route: route.path, overlay: overlay.id, user: route.user, viewport, scheme, ...overlayAudit, below44Summary: summarize(overlayAudit.below44) });
            // eslint-disable-next-line no-console
            console.log(`[target-size:${name}-${overlay.id}] targets=${overlayAudit.totals.targets} <24=${overlayAudit.totals.below24} <44=${overlayAudit.totals.below44} badges=${overlayAudit.badges.length}`);
            const overlayOffenders = overlayAudit.below24.filter((sample) => !sample.inline);
            expect(overlayOffenders, `${overlay.id}: objetivos < 24 × 24 px (2.5.8): ${JSON.stringify(overlayOffenders)}`).toEqual([]);
            const isDialog = (await target.getAttribute("role").catch(() => null)) === "dialog";
            await page.keyboard.press("Escape");
            if (isDialog) await expect(target).toBeHidden({ timeout: 10_000 });
          }

          // Contraste de badges: texto ≥ 4,5 (1.4.3) siempre; borde / punto ≥ 3 (1.4.11) afirmado en oscuro (ver cabecera).
          const weakText = audit.badges.filter((b) => b.textRatio < 4.5);
          const weakUi = audit.badges.filter((b) => (b.borderRatio !== null && b.borderRatio < 3) || (b.dotRatio !== null && b.dotRatio < 3));
          expect(weakText, `badges con texto < 4,5:1 (${scheme}): ${JSON.stringify(weakText)}`).toEqual([]);
          if (scheme === "dark") expect(weakUi, `badges con borde o punto < 3:1 (oscuro): ${JSON.stringify(weakUi)}`).toEqual([]);
          else if (weakUi.length > 0) {
            // eslint-disable-next-line no-console
            console.log(`[target-size:${name}] borde/punto < 3:1 en claro (informativo, tono = matiz): ${[...new Set(weakUi.map((b) => `${b.tone}/${b.variant} ${b.borderRatio ?? b.dotRatio}`))].join(" · ")}`);
          }
        });
      }
    });
  }
}
