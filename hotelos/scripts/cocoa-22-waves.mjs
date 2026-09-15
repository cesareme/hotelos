#!/usr/bin/env node
// Cocoa 22 · §6 of docs/design/COCOA-22-MIGRACION.md (waves and lots).
//
// The per-wave tables of the migration plan are GENERATED from three sources
// that already exist and are kept current by their own gates:
//   • docs/design/cocoa-22-inventory.json   (scripts/cocoa-22-inventory.mjs; rule 15)
//   • apps/admin-web/src/navigation/nav-tree.generated.json (scripts/build-nav-tree.mjs --check)
//   • NOT_MIGRATED of tests/cocoa-22-contract.test.mjs (parsed from source, never imported:
//     importing the test file runs its suites)
// plus the wave rules of this file (§2.3 of the plan): a screen belongs to the
// wave of its inventory category, a key-less dialog/drawer/sub-view to the wave
// of the screen that mounts it (OVERRIDE), and eight files without importers
// are retired, not migrated (DEAD). Lots inside a wave are disjoint by
// construction (first matching LOT test wins; the last lot is the catch-all).
//
// Usage (from hotelos/):
//   node scripts/cocoa-22-waves.mjs --stdout    print the block
//   node scripts/cocoa-22-waves.mjs --write     replace the block between the markers
//                                               <!-- cocoa-22-waves:start --> … <!-- cocoa-22-waves:end -->
//   node scripts/cocoa-22-waves.mjs --check     exit 1 when the block in the plan is stale
//   node scripts/cocoa-22-waves.mjs --summary   JSON per wave (files, lines, points, sizes, days)
//
// Run --write after every lot (the allowlist shrinks) and after regenerating the
// inventory; --check is meant for the contract (rule 16 candidate).

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const inventoryPath = join(repoRoot, "docs", "design", "cocoa-22-inventory.json");
const navTreePath = join(repoRoot, "apps", "admin-web", "src", "navigation", "nav-tree.generated.json");
const contractPath = join(repoRoot, "tests", "cocoa-22-contract.test.mjs");
const planPath = join(repoRoot, "docs", "design", "COCOA-22-MIGRACION.md");
const START = "<!-- cocoa-22-waves:start -->";
const END = "<!-- cocoa-22-waves:end -->";

// ------------------------------------------------------------------ rules

/** Wave of every inventory category (COCOA-22.md §10). */
const WAVE_OF_CATEGORY = { publico: 1, hoy: 2, recepcion: 3, operaciones: 4, revenue: 5, finanzas: 6, comercial: 7, cumplimiento: 8, informes: 9, configuracion: 10, compartido: 11, desarrollo: 11 };

const WAVE_TITLES = {
  1: "Público (acceso y errores)",
  2: "Hoy",
  3: "Recepción",
  4: "Operaciones",
  5: "Revenue",
  6: "Finanzas",
  7: "Comercial",
  8: "Cumplimiento",
  9: "Informes",
  10: "Configuración",
  11: "Compartido, desarrollo y limpieza"
};

/**
 * Files whose wave, mode, URL or note differ from what the inventory and the
 * nav tree say on their own (key-less dialogs follow the screen that mounts
 * them; public auth screens live in auth/PublicAuthRoutes.tsx).
 */
const OVERRIDE = {
  "operations/GroupDetailDialog.tsx": { wave: 3, note: "diálogo de GroupsEventsDashboard (`/recepcion/grupos`) y GroupsCalendarScreen" },
  "operations/NewGroupDialog.tsx": { wave: 3, note: "diálogo de GroupsEventsDashboard (`/recepcion/grupos`)" },
  "operations/NewEventDialog.tsx": { wave: 3, note: "diálogo de GroupsEventsDashboard (`/recepcion/grupos`)" },
  "operations/RoomBlockGridDialog.tsx": { wave: 3, note: "diálogo de GroupsEventsDashboard (`/recepcion/grupos`)" },
  "operations/RoomingListImportDialog.tsx": { wave: 3, note: "diálogo de GroupsEventsDashboard (`/recepcion/grupos`)" },
  "operations/GroupsPickupCard.tsx": { wave: 3, note: "tarjeta de GroupsEventsDashboard (`/recepcion/grupos`)" },
  "operations/QuickCheckInDrawer.tsx": { wave: 2, note: "drawer de FrontDeskDashboard (`/hoy`); también lo abren FrontDeskActionQueue y RoomRackScreen (ola 3)" },
  "operations/QuickCheckOutDrawer.tsx": { wave: 2, note: "drawer de FrontDeskDashboard (`/hoy`); también lo abren FrontDeskActionQueue y RoomRackScreen (ola 3)" },
  "operations/FrontDeskActionQueue.tsx": { wave: 2, mode: "sub-vista", note: "sub-vista de FrontDeskDashboard (`/hoy`)" },
  "onboarding/OnboardingInteractive.tsx": { wave: 11, mode: "sub-vista", note: "solo lo monta OnboardingScreens (dev-only, `/desarrollo/migracion`)" },
  "invoicing/InvoiceRectifyDialog.tsx": { wave: 6, note: "diálogo de InvoiceRectificationsScreen (`/finanzas/facturacion/rectificativas`)" },
  "admin/InviteUserDialog.tsx": { wave: 10, note: "diálogo (barrel `admin/index.ts`) de UserRoleManager (`/configuracion/usuarios`)" },
  "admin/NewTenantWizardDialog.tsx": { wave: 10, note: "diálogo de TenantAdminConsoleScreen (`/configuracion/sistema/organizaciones`)" },
  "admin/ResetPasswordConfirmDialog.tsx": { wave: 10, note: "diálogo (barrel `admin/index.ts`) de UserRoleManager (`/configuracion/usuarios`)" },
  "fiscal/ReportErrorCard.tsx": { wave: 8, mode: "componente (tarjeta)", note: "tarjeta de Modelo111/115/180/303/390 (`/cumplimiento/modelos-aeat/*`)" },
  "fiscal/ComplianceInbox.tsx": { wave: 8, mode: "standalone", url: "/cumplimiento/bandeja", note: "App.tsx:158 la envuelve en `ComplianceInboxWired` (clave `ComplianceInbox`)" },
  "auth/AcceptInviteScreen.tsx": { wave: 1, mode: "pública", url: "/accept-invite", note: "auth/PublicAuthRoutes.tsx — marco `auth/AuthShell.tsx` (ola 1)" },
  "auth/ChangePasswordScreen.tsx": { wave: 1, mode: "pública", note: "sin ruta propia: se monta cuando la sesión debe rotar la contraseña (auth/PublicAuthRoutes.tsx:91) — marco `auth/AuthShell.tsx`" },
  "auth/ResetPasswordScreen.tsx": { wave: 1, mode: "pública", url: "/reset-password", note: "auth/PublicAuthRoutes.tsx — marco `auth/AuthShell.tsx` (ola 1)" },
  "errors/CocoaNotFoundScreen.tsx": { wave: 1, mode: "shell", note: "404 del shell (App.tsx:766): `CocoaState kind=\"error\"` a página completa, sin `<h1>` crudo" },
  "ModuleSettingsPlaceholder.tsx": { wave: 11, mode: "fábrica", note: "`makeModulePlaceholder` (App.tsx; 16 placeholders, presupuesto 20 de check-discoverability)" },
  "ScreenScaffold.tsx": { wave: 11, mode: "sub-vista", note: "solo lo usa OnboardingScreens" },
  "tabs/tab-helpers.tsx": { wave: 11, note: "pinta el `<h1>` alojado (`HostedHead`): exención de la regla 8 o traslado a `components/` antes de salir de `NOT_MIGRATED`" },
  "tabs/TabHost.tsx": { wave: 11, note: "pinta el `<h1>` alojado: misma exención de la regla 8 que `tab-helpers.tsx`" },
  "tabs/NavItemTabs.tsx": { wave: 11, note: "ya Cocoa (`CocoaPageHeader` + `CocoaRouteTabs`); solo salir de `NOT_MIGRATED`" },
  "tabs/configuracion/tab-helpers.tsx": { wave: 10, note: "helper de 13 líneas; solo salir de `NOT_MIGRATED`" },
  "dev/StyleGuideScreen.tsx": { wave: 11, note: "ya en `CocoaPage` (37 `style={` de muestras): `STYLE_BUDGET` 40 y salir de `NOT_MIGRATED` en cuanto el integrador lo decida (puede ir con la ola 1)" }
};

/** Files with zero importers in apps/admin-web/src: retired in their wave, never migrated. */
const DEAD = {
  "reservations/QuickActionsDialogs.tsx": "0 importadores en apps/admin-web/src",
  "billing/SplitFolioDialog.tsx": "0 importadores",
  "billing/InvoiceDetailScreen.tsx": "0 importadores (solo un comentario en billing/invoiceStatus.ts:2); sin clave ni URL",
  "onboarding/CocoaOnboardingWizard.tsx": "0 importadores; lo lee layouts/__tests__/shell-cocoa22-contract.test.mts:16 (ajustar el test al retirarlo)",
  // auth/CocoaLoginScreen.tsx and errors/CocoaServerErrorScreen.tsx: retired in wave 1 (git D).
  "developer/CocoaShowcaseScreen.tsx": "0 importadores ni ruta; exención en tests/admin-web-spanish-copy-contract.test.mjs:36 (borrar la línea)",
  "preview/CocoaGalleryScreen.tsx": "0 importadores ni ruta; exención en tests/admin-web-spanish-copy-contract.test.mjs:37 (borrar la línea)"
};

/** §4.3 template per archetype and rule-6 budget (§9: 25 dashboard/default · 15 list/detail/form · 40 calendar/workspace). */
const TEMPLATE = { dashboard: "DashboardAlojado / DashboardStandalone", lista: "ListaTabla", detalle: "Detalle", formulario: "Formulario", asistente: "Asistente", workspace: "Workspace", calendario: "Calendario", chat: "Chat", dialogo: "DialogoDrawer", contenedor: "— (NavItemTabs)", otro: "PlantillaBase" };
const BUDGET = { dashboard: 25, chat: 25, otro: 25, asistente: 25, contenedor: 25, lista: 15, detalle: 15, formulario: 15, dialogo: 15, calendario: 40, workspace: 40 };
/** Effort per size (COCOA-22.md §10): days per person, min–max. */
const DAYS = { S: [0.5, 0.5], M: [1, 1], L: [2, 3], XL: [4, 5] };

/** Lots per wave: [name, test(relativePath)]; the last lot of a wave is the catch-all. */
const LOTS = {
  1: [["1-A · Acceso y errores", () => true]],
  2: [["2-A · Mi día (contenedor, recepción, operaciones, propietario) + cocoa-director", (r) => /FrontDesk|QuickCheck|OperationsDirector|OwnerHome|MiDiaTabs/.test(r)], ["2-B · Cierre del día, IA y asistente", () => true]],
  3: [["3-B · Grupos y eventos", (r) => /Groups|GroupDetail|NewGroup|NewEvent|RoomBlock|RoomingList|GruposEventos/.test(r)], ["3-C · Huéspedes, cupos y conserjería", (r) => /guests\/|guestJourney|Huespedes|Allotments|Concierge|QuickActionsDialogs/.test(r)], ["3-A · Reservas (workspace, lista, nueva, agente, tablero, cronograma)", () => true]],
  4: [["4-B · Punto de venta, compras e inventario", (r) => /Pos|Fnb|Inventory|Procurement|PuntoVenta|ComprasInventario/.test(r)], ["4-C · Personal, seguridad, energía y activos", (r) => /Workforce|Safety|Energy|Assets/.test(r)], ["4-A · Pisos y mantenimiento", () => true]],
  5: [["5-A · Parrilla y demanda (+ cocoa-rate-grid)", (r) => /RateGrid|RateJournal|Parrilla|DemandCalendar/.test(r)], ["5-C · Ajustes de revenue", (r) => /RatePlans|CancellationPolicies|RateShopper|RevenueRules/.test(r)], ["5-B · Histórico, previsión y reuniones", () => true]],
  6: [["6-A · Facturación (centro, folios, rectificativas, enrutado)", (r) => /billing\/|invoicing\/|Facturacion|FolioRouting/.test(r)], ["6-C · Estados contables y cierre", (r) => /BalanceSheet|TrialBalance|ExchangeRates|YearEndClose|EstadosContables/.test(r)], ["6-B · Tesorería, conciliación, nóminas y comisiones", () => true]],
  7: [["7-A · Canales", (r) => /Channel|Canales/.test(r)], ["7-C · Ventas adicionales y portal", (r) => /Upsells|SalesPipeline|GuestPortal|VentasAdicionales/.test(r)], ["7-B · Clientes, fidelización y reputación", () => true]],
  8: [["8-B · VeriFactu, TicketBAI y modelos AEAT", (r) => /fiscal\/|Verifactu|ModelosAeat/.test(r)], ["8-C · Impuestos y sostenibilidad", (r) => /PropertyTaxes|TouristTax|Sustainability|Esrs|Impuestos|Sostenibilidad/.test(r)], ["8-A · Registro de viajeros, GDPR y centro de cumplimiento", () => true]],
  9: [["9-A · Informes", () => true]],
  10: [["10-A · Sistema, organizaciones, usuarios y desarrolladores", (r) => /AuditLog|Tenant|InviteUser|ResetPasswordConfirm|UserRole|developer\/|Sistema/.test(r)], ["10-B · Inteligencia artificial y comunicaciones", (r) => /aiOperations\/|Notifications|Inteligencia|Comunicaciones/.test(r)], ["10-D · Contabilidad, facturación y pagos", (r) => /AccountingSettings|BillingSettings|PaymentSettings|TaxCompliance|ContabilidadFiscal|FacturacionPagos/.test(r)], ["10-C · Puesta en marcha, propiedad, categorías y módulos", () => true]],
  11: [["11-A · Compartido y desarrollo", () => true]]
};

// ------------------------------------------------------------------ data

function readAllowlist() {
  const src = readFileSync(contractPath, "utf8");
  const m = src.match(/export const NOT_MIGRATED = \[([\s\S]*?)\];/);
  if (!m) throw new Error("NOT_MIGRATED no encontrado en tests/cocoa-22-contract.test.mjs");
  const list = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  const ceiling = Number(src.match(/export const ALLOWLIST_CEILING = (\d+);/)?.[1] ?? NaN);
  return { list, ceiling };
}

function urlMap() {
  const tree = JSON.parse(readFileSync(navTreePath, "utf8"));
  const map = {};
  for (const c of tree.categories ?? []) {
    for (const item of c.items ?? []) {
      map[item.screenKey] = { url: item.url, host: null, label: item.label };
      for (const tab of item.tabs ?? []) map[tab.screenKey] = { url: tab.url, host: item.screenKey, label: tab.label };
    }
  }
  for (const d of tree.devOnly ?? []) if (d.screenKey && !map[d.screenKey]) map[d.screenKey] = { url: d.url, host: d.parent ?? null, label: d.label, dev: true };
  for (const p of tree.publicScreens ?? []) if (p.screenKey && !map[p.screenKey]) map[p.screenKey] = { url: p.url, host: null, label: p.label, pub: true };
  return map;
}

const es = (n) => n.toLocaleString("es-ES");
const days = ([a, b]) => (a === b ? `≈ ${es(a)} días·persona` : `≈ ${es(a)}–${es(b)} días·persona`);

function buildRows() {
  const inv = JSON.parse(readFileSync(inventoryPath, "utf8"));
  const urls = urlMap();
  const { list: notMigrated, ceiling } = readAllowlist();
  const pending = new Set(notMigrated);
  const rows = inv.screens.map((s) => {
    const rel = s.path.replace("apps/admin-web/src/screens/", "");
    const keys = s.screenKeys ?? [];
    const o = OVERRIDE[rel] ?? {};
    const isContainer = rel.startsWith("tabs/");
    const targets = keys.map((k) => urls[k]).filter(Boolean);
    let mode;
    if (o.mode) mode = o.mode;
    else if (isContainer) mode = "contenedor de pestañas";
    else if (targets.length) {
      const first = targets[0];
      mode = `${first.dev ? "dev-only · " : ""}${first.pub ? "pública · " : ""}${first.host ? `alojada en ${first.host}` : "standalone"}`;
      const distinct = new Set(targets.map((t) => t.url)).size;
      if (distinct > 1) mode += ` (+${distinct - 1} ruta${distinct > 2 ? "s" : ""})`;
    } else if (/(Dialog|Drawer)\.tsx$/.test(rel)) mode = "componente (diálogo/drawer)";
    else if (/Card\.tsx$/.test(rel)) mode = "componente (tarjeta)";
    else mode = "sin ruta";
    const url = o.url ?? [...new Set(targets.map((t) => t.url))].join(" · ");
    const m = s.metrics;
    const debt = [["card", m.boCard], ["bo", m.boClasses - m.boCard], ["btn", m.rawButtons], ["tbl", m.rawTables], ["inp", m.rawInputs], ["col", m.colourLiterals], ["st", m.inlineStyles], ["emj", m.emoji], ["h1", m.rawH1]].filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join(" · ") || "—";
    let note = o.note ?? (isContainer ? "solo salir de `NOT_MIGRATED`" : "");
    if (DEAD[rel]) note = `**MUERTA** — ${DEAD[rel]}`;
    return { rel, keys, migrated: !pending.has(rel), wave: o.wave ?? WAVE_OF_CATEGORY[s.category], note, mode, url, arch: s.archetype, size: s.size, lines: s.lines, pts: s.debtPoints, debt, isContainer, dead: !!DEAD[rel], cat: s.category };
  });
  return { rows, ceiling, generatedAt: inv.generatedAt ?? null, totals: inv.totals };
}

function waves() {
  const { rows, ceiling, totals } = buildRows();
  const out = [];
  for (let w = 1; w <= 11; w++) {
    const pending = rows.filter((r) => r.wave === w && !r.migrated);
    const done = rows.filter((r) => r.wave === w && r.migrated);
    const byLot = new Map(LOTS[w].map(([name]) => [name, []]));
    for (const r of pending) {
      const lot = LOTS[w].find(([, test]) => test(r.rel)) ?? LOTS[w][LOTS[w].length - 1];
      byLot.get(lot[0]).push(r);
    }
    const sizes = { S: 0, M: 0, L: 0, XL: 0 };
    const effort = [0, 0];
    for (const r of pending) { sizes[r.size] += 1; effort[0] += DAYS[r.size][0]; effort[1] += DAYS[r.size][1]; }
    const lots = [...byLot.entries()].filter(([, l]) => l.length).sort((a, b) => a[0].localeCompare(b[0])).map(([name, list]) => {
      list.sort((a, b) => (a.isContainer - b.isContainer) || (a.dead - b.dead) || (b.pts - a.pts) || a.rel.localeCompare(b.rel));
      return { name, list, pts: list.reduce((s, r) => s + r.pts, 0) };
    });
    out.push({
      wave: w,
      title: WAVE_TITLES[w],
      files: pending.length,
      lines: pending.reduce((s, r) => s + r.lines, 0),
      pts: pending.reduce((s, r) => s + r.pts, 0),
      sizes,
      effort,
      containers: pending.filter((r) => r.isContainer).length,
      dead: pending.filter((r) => r.dead).length,
      done: done.map((r) => r.rel),
      lots
    });
  }
  const totalPending = rows.filter((r) => !r.migrated).length;
  return { waves: out, totalPending, totalPts: rows.filter((r) => !r.migrated).reduce((s, r) => s + r.pts, 0), migrated: rows.filter((r) => r.migrated).map((r) => r.rel), ceiling, totals };
}

// ------------------------------------------------------------------ markdown

function block() {
  const data = waves();
  const L = [];
  L.push(`_Generado por \`node scripts/cocoa-22-waves.mjs --write\` · inventario: ${data.totals.files} pantallas · ${es(data.totals.lines)} líneas · ${es(data.totals.debtPoints)} puntos · allowlist \`NOT_MIGRATED\` = ${data.totalPending} (techo ${data.ceiling}) · pendientes: **${data.totalPending} ficheros · ${es(data.totalPts)} puntos** · migradas: ${data.migrated.map((m) => `\`${m}\``).join(", ")}._`);
  L.push("");
  L.push("| Ola | Alcance | Ficheros | Líneas | Puntos | S · M · L · XL | Esfuerzo | Lotes | Contenedores | Muertas |");
  L.push("|---|---|---|---|---|---|---|---|---|---|");
  let effort = [0, 0];
  for (const w of data.waves) {
    effort = [effort[0] + w.effort[0], effort[1] + w.effort[1]];
    L.push(`| ${w.wave} | ${w.title} | ${w.files} | ${es(w.lines)} | **${es(w.pts)}** | ${w.sizes.S} · ${w.sizes.M} · ${w.sizes.L} · ${w.sizes.XL} | ${days(w.effort)} | ${w.lots.length} | ${w.containers} | ${w.dead} |`);
  }
  L.push(`| **Total** | | **${data.totalPending}** | **${es(data.waves.reduce((s, w) => s + w.lines, 0))}** | **${es(data.totalPts)}** | ${["S", "M", "L", "XL"].map((k) => data.waves.reduce((s, w) => s + w.sizes[k], 0)).join(" · ")} | ${days(effort)} | ${data.waves.reduce((s, w) => s + w.lots.length, 0)} | ${data.waves.reduce((s, w) => s + w.containers, 0)} | ${data.waves.reduce((s, w) => s + w.dead, 0)} |`);
  L.push("");
  for (const w of data.waves) {
    L.push(`### Ola ${w.wave} · ${w.title}`);
    L.push("");
    L.push(`**${w.files} ficheros** · ${es(w.lines)} líneas · **${es(w.pts)} puntos** · S ${w.sizes.S} · M ${w.sizes.M} · L ${w.sizes.L} · XL ${w.sizes.XL} · ${days(w.effort)}${w.containers ? ` · ${w.containers} contenedor${w.containers > 1 ? "es" : ""} (0 código)` : ""}${w.dead ? ` · ${w.dead} muerta${w.dead > 1 ? "s" : ""} (retirar, no migrar)` : ""}${w.done.length ? ` · ya migradas: ${w.done.map((r) => `\`${r}\``).join(", ")}` : ""}`);
    L.push("");
    for (const lot of w.lots) {
      L.push(`#### Lote ${lot.name} — ${lot.list.length} ficheros · ${es(lot.pts)} pts`);
      L.push("");
      L.push("| # | Fichero (`apps/admin-web/src/screens/`) | Clave(s) · modo | URL | Arquetipo · plantilla §4.3 | Tam. · líneas · pts | Deuda a cero | `STYLE_BUDGET` | Notas |");
      L.push("|---|---|---|---|---|---|---|---|---|");
      lot.list.forEach((r, i) => {
        const keys = r.keys.length ? r.keys.map((k) => `\`${k}\``).join(", ") : "—";
        const budget = r.isContainer ? "—" : BUDGET[r.arch] === 25 ? "25 (defecto)" : String(BUDGET[r.arch]);
        const url = r.url ? r.url.split(" · ").map((u) => `\`${u}\``).join(" · ") : "—";
        L.push(`| ${i + 1} | \`${r.rel}\` | ${keys} · ${r.mode} | ${url} | ${r.arch} · ${TEMPLATE[r.arch]} | ${r.size} · ${r.lines} · **${r.pts}** | ${r.debt} | ${budget} | ${r.note} |`);
      });
      L.push("");
    }
  }
  return L.join("\n").trimEnd() + "\n";
}

function splice(doc, inner) {
  const a = doc.indexOf(START);
  const b = doc.indexOf(END);
  if (a === -1 || b === -1 || b < a) throw new Error(`Marcadores ${START} / ${END} no encontrados en ${planPath}`);
  return `${doc.slice(0, a + START.length)}\n${inner}${doc.slice(b)}`;
}

// ------------------------------------------------------------------ cli

const arg = process.argv[2] ?? "--stdout";
if (arg === "--stdout") {
  process.stdout.write(block());
} else if (arg === "--summary") {
  const data = waves();
  console.log(JSON.stringify({ totalPending: data.totalPending, totalPts: data.totalPts, ceiling: data.ceiling, migrated: data.migrated, waves: data.waves.map((w) => ({ wave: w.wave, title: w.title, files: w.files, lines: w.lines, pts: w.pts, sizes: w.sizes, effort: w.effort, lots: w.lots.map((l) => ({ name: l.name, files: l.list.length, pts: l.pts })), containers: w.containers, dead: w.dead, done: w.done })) }, null, 2));
} else if (arg === "--write") {
  const doc = readFileSync(planPath, "utf8");
  const next = splice(doc, block());
  writeFileSync(planPath, next);
  const data = waves();
  console.log(`§6 escrito en docs/design/COCOA-22-MIGRACION.md · ${data.totalPending} pendientes · ${data.totalPts} puntos · ${data.waves.reduce((s, w) => s + w.lots.length, 0)} lotes`);
} else if (arg === "--check") {
  const doc = readFileSync(planPath, "utf8");
  const expected = splice(doc, block());
  if (expected !== doc) {
    console.error("§6 de docs/design/COCOA-22-MIGRACION.md está desactualizado: node scripts/cocoa-22-waves.mjs --write");
    process.exit(1);
  }
  console.log("§6 al día");
} else {
  console.error("Uso: node scripts/cocoa-22-waves.mjs --stdout | --write | --check | --summary");
  process.exit(2);
}
