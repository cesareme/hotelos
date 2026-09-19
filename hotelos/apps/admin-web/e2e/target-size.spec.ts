import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertNoLoginGate, loginAsUxDay } from "./_helpers";

/**
 * Contrato de tamaño de objetivos y contraste en tablet (Tanda UX-1 · lote U10 ·
 * docs/design/UX-RECEPCION-FEEL.md §7.1 2.5.8 / 1.4.11, §7.2, D4, D10, R7).
 * Proyecto Playwright `touch` (hasTouch → Chromium responde `pointer: coarse`),
 * iPad apaisado 1024 × 768 («portátil táctil») y vertical 820 × 1180, claro y
 * oscuro con `colorScheme`, sobre el tenant UXDAY (seed-ux-day).
 *
 * Por cada pantalla de recepción (Mi día, lista, ficha, tablero, cronograma):
 *   · 0 objetivos interactivos < 24 × 24 px CSS (WCAG 2.2 · 2.5.8, salvo los
 *     enlaces en línea de un párrafo, excepción «inline» del criterio);
 *   · los objetivos < 44 px (el objetivo AAA 2.5.5 / Apple HIG) se listan en el
 *     JSON de salida (`TARGET_SIZE_OUT`, por defecto el outputDir de la prueba)
 *     para justificarlos en el informe de cierre — sin nombres: los controles
 *     de una fila, tarjeta o barra se describen por su tipo, no por su texto;
 *   · las cuatro pantallas con `density="operational"` resuelven `comfortable`
 *     con el dedo (CocoaPage, D10) y a 1024 px la página marca
 *     `data-touch-laptop` (isTouchLaptop, §7.2) y el inspector apila bajo la
 *     tabla (banda tablet de cocoa-22-layout.css);
 *   · casilla de fila (`.c22-table__check`) y barra de lote con objetivos ≥ 44
 *     (mobile.css / cocoa-22.css bajo `pointer: coarse`);
 *   · contraste de todos los badges visibles (CocoaBadge / CocoaStatusBadge:
 *     outline, tinted y dot, incluidos «No-show» y «Cancelada» de la leyenda
 *     del cronograma) medido con getComputedStyle y la fórmula WCAG: texto
 *     ≥ 4,5:1 (1.4.3) en claro y en oscuro; borde o punto pintados ≥ 3:1
 *     (1.4.11) afirmado en OSCURO (el riesgo que señala §7.1: «no_show
 *     neutral casi invisible frente a cancelled danger»). En claro el borde
 *     `outline` y el punto `dot` llevan el TONO (matiz), no la tinta: 2,0–2,9:1
 *     para warning / success (documentado en CocoaBadge: «the hue itself is
 *     only 2–3.5:1»); el texto y el icono ya nombran el estado, así que el
 *     borde no es información necesaria (1.4.11 «required to identify»): se
 *     mide, se escribe en el JSON y se lista en el informe, no se afirma.
 */

const VIEWPORTS = {
  apaisado: { width: 1024, height: 768 },
  vertical: { width: 820, height: 1180 }
} as const;

const SCHEMES = ["light", "dark"] as const;

type RouteId = "hoy" | "lista" | "ficha" | "tablero" | "cronograma";

type Route = {
  id: RouteId;
  path: string;
  /** Marcador de «pantalla lista» (datos pintados). */
  ready: (page: Page) => Locator;
  /** La CocoaPage declara density="operational" (U10). */
  operational: boolean;
  /** Overlays que también se auditan (cajones de check-in / check-out abiertos, corrector L-07): abre, deja el marcador visible, y cierra al terminar. */
  overlays?: ReadonlyArray<{ id: string; open: (page: Page) => Promise<Locator | null> }>;
};

const DRAWER_OVERLAYS: Route["overlays"] = [
  {
    id: "checkin",
    open: async (page) => {
      const arrivals = page.getByRole("table", { name: "Llegadas de hoy" });
      const button = arrivals.getByRole("button", { name: /^(Hacer check-in|Check-in en \d+[A-Za-z]?)$/ }).first();
      if (!(await button.isVisible().catch(() => false))) return null;
      await button.click();
      const drawer = page.getByRole("dialog", { name: "Check-in" });
      await expect(drawer.getByRole("tablist", { name: "Modo de cobro" })).toBeVisible({ timeout: 10_000 });
      return drawer;
    }
  },
  {
    id: "checkout",
    open: async (page) => {
      await page.getByRole("tablist", { name: "Vista de recepción" }).getByRole("tab", { name: /^Salen hoy/ }).click();
      const departures = page.getByRole("table", { name: "Salidas de hoy" });
      await expect(departures).toBeVisible({ timeout: 10_000 });
      const button = departures.getByRole("button", { name: /^(Hacer check-out|Cobrar .* y cerrar)$/ }).first();
      if (!(await button.isVisible().catch(() => false))) return null;
      await button.click();
      const drawer = page.getByRole("dialog", { name: "Check-out" });
      await expect(drawer.getByRole("tablist", { name: "Factura", exact: true })).toBeVisible({ timeout: 10_000 });
      return drawer;
    }
  }
];

const ROUTES: readonly Route[] = [
  { id: "hoy", path: "/hoy", ready: (page) => page.getByText("Llegan hoy").first(), operational: true, overlays: DRAWER_OVERLAYS },
  { id: "lista", path: "/recepcion/reservas/lista", ready: (page) => page.getByRole("table", { name: "Reservas" }).locator("tbody tr[data-interactive]").first(), operational: true },
  { id: "ficha", path: "/recepcion/reservas/res_uxday_t4", ready: (page) => page.getByRole("group", { name: "Acciones de la reserva" }), operational: true },
  { id: "tablero", path: "/recepcion/reservas/tablero", ready: (page) => page.locator(".c22-tile-grid").first(), operational: false },
  { id: "cronograma", path: "/hoy/live-timeline", ready: (page) => page.locator(".tl-grid .tl-bar").first(), operational: false }
];

/** Objetivo interactivo medido en la página (sin texto de filas: nunca nombres). */
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
  totals: { targets: number; below24: number; below44: number; inlineExempt: number };
  below24: TargetSample[];
  below44: TargetSample[];
  badges: BadgeSample[];
};

/** Recorre el DOM visible: objetivos interactivos (tamaño) y badges (contraste). Se ejecuta en la página. */
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
    if (element.closest('tr, [role="row"], .tl-bar, .c22-card, .cocoa-card, [data-cocoa="inspector"], .tl-legend')) return "(fila/tarjeta)";
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
    samples.push({ kind: kindOf(element), label: labelOf(element), w, h, min: Math.min(w, h), inline: isInlineLink(element) });
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

async function forceCoarse(page: Page): Promise<void> {
  // Chromium ya responde `pointer: coarse` con hasTouch; se fija además por CDP (como e2e/timeline.spec.ts) para que la medida no dependa del emulador.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: "coarse" }, { name: "hover", value: "none" }] });
}

for (const [orientation, viewport] of Object.entries(VIEWPORTS) as Array<[keyof typeof VIEWPORTS, { width: number; height: number }]>) {
  for (const scheme of SCHEMES) {
    test.describe(`tablet ${orientation} ${viewport.width}×${viewport.height} · ${scheme === "dark" ? "oscuro" : "claro"}`, () => {
      test.use({ viewport, colorScheme: scheme });

      for (const route of ROUTES) {
        test(`${route.id}: 0 objetivos < 24 px, badges con contraste AA, densidad por dispositivo`, async ({ page, request }, testInfo) => {
          await loginAsUxDay(page, request);
          await forceCoarse(page);
          await page.goto(route.path, { waitUntil: "domcontentloaded" });
          await assertNoLoginGate(page, testInfo);
          await expect(route.ready(page)).toBeVisible({ timeout: 20_000 });
          // Sin esqueletos pendientes ni red en vuelo antes de medir (condición, no ventana fija: UX1-REV-13).
          await page.waitForFunction(() => !document.querySelector('[data-skeleton="visible"], [data-skeleton="pending"]'), null, { timeout: 10_000 }).catch(() => undefined);
          await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);

          const audit = await page.evaluate(auditPage);
          const name = `${route.id}-${orientation}-${scheme}`;
          writeAudit(testInfo, name, { route: route.path, viewport, scheme, ...audit, below44Summary: summarize(audit.below44) });
          if (process.env.TARGET_SIZE_OUT) await page.screenshot({ path: join(process.env.TARGET_SIZE_OUT, `${name}.png`) });
          // eslint-disable-next-line no-console
          console.log(`[target-size:${name}] targets=${audit.totals.targets} <24=${audit.totals.below24} (inline ${audit.totals.inlineExempt}) <44=${audit.totals.below44} badges=${audit.badges.length}`);

          expect(audit.coarse, "la emulación táctil responde pointer: coarse").toBe(true);
          const offenders = audit.below24.filter((sample) => !sample.inline);
          expect(offenders, `objetivos < 24 × 24 px (2.5.8): ${JSON.stringify(offenders)}`).toEqual([]);

          // Cajones abiertos (L-07): los segmentados y el switch del check-in / check-out también miden ≥ 24 (44 con el dedo).
          for (const overlay of route.overlays ?? []) {
            const drawer = await overlay.open(page);
            if (!drawer) continue;
            await page.waitForFunction(() => !document.querySelector('[data-skeleton="visible"], [data-skeleton="pending"]'), null, { timeout: 10_000 }).catch(() => undefined);
            const overlayAudit = await page.evaluate(auditPage);
            writeAudit(testInfo, `${name}-${overlay.id}`, { route: route.path, overlay: overlay.id, viewport, scheme, ...overlayAudit, below44Summary: summarize(overlayAudit.below44) });
            const drawerOffenders = overlayAudit.below24.filter((sample) => !sample.inline);
            expect(drawerOffenders, `cajón ${overlay.id}: objetivos < 24 × 24 px (2.5.8): ${JSON.stringify(drawerOffenders)}`).toEqual([]);
            const tabs = await drawer.getByRole("tab").evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().height)));
            expect(tabs.length, `cajón ${overlay.id}: segmentados`).toBeGreaterThan(0);
            for (const height of tabs) expect(height, `cajón ${overlay.id}: pestaña de ${height} px con el dedo`).toBeGreaterThanOrEqual(44);
            await page.keyboard.press("Escape");
            await expect(drawer).toBeHidden({ timeout: 10_000 });
          }

          // Densidad por dispositivo (D10) y portátil táctil (§7.2).
          const operational = audit.pages.filter((p) => p.mode === "operational");
          if (route.operational) {
            expect(operational.length, "la pantalla declara density=\"operational\"").toBeGreaterThan(0);
            for (const p of operational) expect(p.density, "con el dedo la densidad operativa es comfortable").toBe("comfortable");
            for (const p of audit.pages) expect(p.touchLaptop, `data-touch-laptop a ${viewport.width} px`).toBe(viewport.width >= 900 && viewport.width < 1200);
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
          if (route.id === "cronograma") {
            const legend = page.getByRole("list", { name: "Leyenda" });
            await expect(legend.getByText("No-show")).toBeVisible();
            await expect(legend.getByText("Cancelada")).toBeVisible();
            const noShow = audit.badges.find((b) => b.text === "No-show");
            expect(noShow, "la leyenda del cronograma pinta el badge No-show").toBeTruthy();
            expect(noShow!.textRatio).toBeGreaterThanOrEqual(4.5);
          }

          // Lista: casilla de fila y barra de lote ≥ 44 px con el dedo; a 1024 el inspector apila bajo la tabla.
          if (route.id === "lista") {
            const table = page.getByRole("table", { name: "Reservas" });
            const check = table.locator("tbody .c22-table__check").first();
            const checkBox = await check.boundingBox();
            expect(checkBox && Math.min(checkBox.width, checkBox.height), "casilla de fila ≥ 44 px (mobile.css / cocoa-22.css coarse)").toBeGreaterThanOrEqual(44);
            await check.tap();
            const batch = page.locator(".c22-table__batch");
            await expect(batch).toBeVisible();
            for (const button of await batch.getByRole("button").all()) {
              const box = await button.boundingBox();
              expect(box && box.height, "botones de la barra de lote ≥ 44 px").toBeGreaterThanOrEqual(44);
            }
            const firstRow = table.locator("tbody tr[data-interactive]").first();
            await firstRow.focus();
            await page.keyboard.press("Enter");
            const inspector = page.locator('[data-cocoa="inspector"]');
            await expect(inspector).toBeVisible();
            const direction = await page.locator('[data-cocoa="inspector-layout"]').evaluate((node) => getComputedStyle(node).flexDirection);
            expect(direction, `inspector apilado bajo la tabla a ${viewport.width} px con el dedo (banda tablet)`).toBe("column");
            const tableBox = await table.boundingBox();
            const inspectorBox = await inspector.boundingBox();
            expect(inspectorBox!.y, "el inspector empieza por debajo de la tabla").toBeGreaterThanOrEqual(tableBox!.y + tableBox!.height - 1);
            expect(inspectorBox!.width, "el inspector ocupa el ancho de la columna").toBeGreaterThan(viewport.width * 0.6);
          }
        });
      }
    });
  }
}
