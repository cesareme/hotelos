#!/usr/bin/env node
// docs/manual/tools/capturas.mjs — receta de captura para el manual de uso de ehotelOS.
//
// Login por POST /auth/login (token cacheado en <tmpdir>/ehotelos-manual-capturas-session.json, FUERA del
// repo porque contiene un JWT, para no agotar el límite de 10 logins/min), sesión inyectada en localStorage (hotelos.auth.token / hotelos.auth.user /
// hotelos-active-property / hotelos-active-org / hotelos-active-property-name / hotelos.theme=light),
// captura de una URL del front (http://localhost:5173) a 1280×800, DPR 1, tema claro, es-ES,
// recorte opcional (--clip o --selector) y PNG optimizado (paleta ≤ 256 colores, ≤ 150 KB).
// Sin dependencias nuevas: usa el chromium de @playwright/test de apps/admin-web y zlib de Node.
//
// Uso (desde la raíz del monorepo; --out se resuelve desde el directorio actual):
//   node docs/manual/tools/capturas.mjs --url /hoy/live-timeline --out docs/manual/img/recepcion/live-timeline.png
//   node docs/manual/tools/capturas.mjs --url /operaciones/pisos --out docs/manual/img/pisos/tablero.png --view-as pisos
//   node docs/manual/tools/capturas.mjs --url /recepcion/reservas --out x.png --selector "main" --wait-for "table"
//   node docs/manual/tools/capturas.mjs --url /revenue/parrilla --out x.png --clip 240,96,1040,704
//   node docs/manual/tools/capturas.mjs --batch docs/manual/img/<perfil>/capturas.json
//       # [{ "url", "out", "viewAs", "clip", "selector", "waitFor", "readyText", "wait", "full", "property",
//       #    "hideInstructions", "hideCaret", "showTour", "showSetupBanner", "maxKb", "colors", "keepRaw",
//       #    "actions", "fixDrawer" }]  (las claves que empiezan por "_" son notas). Cualquier otra clave
//       # (p. ej. noSession, collapse, pushState, cmdk de lotes hechos a mano) aborta el lote con error antes de
//       # capturar nada, para que una captura no se regenere en silencio con otro resultado.
//
// Opciones: --base http://localhost:5173  --api http://localhost:3000  --property prop_123
//           --view-as <token>   (direccion|recepcion|pisos|mantenimiento|revenue|finanzas|comercial|fnb|
//                                administracion|rrhh|propiedad|activos|auditoria|sistemas; solo cambia el menú)
//           --wait <ms> (600)   --wait-for <css>   --ready-text <texto>   --full (página completa)
//           --clip x,y,w,h      --selector <css>   --max-kb 150   --colors 256   --keep-raw (guarda .raw.png)
//           --repo <ruta del monorepo>  (por defecto la raíz del monorepo, resuelta desde este fichero)  --headed  --hide-caret
//           --show-tour (deja el popup de bienvenida/recorrido; por defecto se marca como visto)
//           --show-setup-banner (deja el aviso «Faltan N comprobaciones…»; por defecto se oculta para la sesión)
//           --hide-instructions (oculta las tarjetas de instrucciones in-app de las pantallas que las tienen)
//           --actions '<json>'  (pasos que se ejecutan en orden ANTES de capturar; en el lote, la clave "actions" del trabajo):
//                                {"click":"<selector>"} · {"button":"<nombre>"} · {"tab":"<nombre>"} · {"fill":["<selector>","<texto>"]}
//                                · {"select":["<selector>","<valor>"]} · {"waitFor":"<selector>"} · {"wait":<ms>}
//                                · {"file":{"selector":"input[type=file]","name":"x.csv","mimeType":"text/csv","content":"…"}}
//                                (selectores de Playwright: css, text=, role=, >> …). Los pasos rellenan y navegan: nunca
//                                pulsan «Guardar», «Crear» ni «Contabilizar»; el fichero de ejemplo va embebido en el lote.
//           --fix-drawer        (SOLO mientras dure el defecto de los cajones laterales en escritorio: la regla
//                                `.c22-scrim { display: none }` de apps/admin-web/src/styles/cocoa-22-shell.css, pensada
//                                para el velo del menú compacto, oculta también el velo de CocoaDrawer y con él el cajón.
//                                Esta opción inyecta `display: block` para el velo abierto en la sesión de captura y nada
//                                más; las guías marcan esas capturas «forzada». Retírala de los lotes al corregir el defecto.)
// Notas: «Ver como» vive en memoria (no en localStorage): se aplica tras cargar la URL con el select #c22-view-as.
//        No abras el selector de hotel (arriba a la izquierda) en una captura: el administrador de plataforma ve
//        también las propiedades de otras organizaciones (cliente piloto) y no deben aparecer en el manual.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import zlib from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));

// ----------------------------------------------------------------------------- args
function parseArgs(argv) {
  const o = { base: "http://localhost:5173", api: "http://localhost:3000", property: "prop_123", wait: 600, maxKb: 150, colors: 256, repo: resolve(HERE, "../../..") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--url": o.url = next(); break;
      case "--out": o.out = next(); break;
      case "--base": o.base = next(); break;
      case "--api": o.api = next(); break;
      case "--property": o.property = next(); break;
      case "--view-as": o.viewAs = next(); break;
      case "--wait": o.wait = Number(next()); break;
      case "--wait-for": o.waitFor = next(); break;
      case "--ready-text": o.readyText = next(); break;
      case "--full": o.full = true; break;
      case "--clip": o.clip = next(); break;
      case "--selector": o.selector = next(); break;
      case "--max-kb": o.maxKb = Number(next()); break;
      case "--colors": o.colors = Number(next()); break;
      case "--keep-raw": o.keepRaw = true; break;
      case "--repo": o.repo = next(); break;
      case "--batch": o.batch = next(); break;
      case "--headed": o.headed = true; break;
      case "--hide-caret": o.hideCaret = true; break;
      case "--show-tour": o.showTour = true; break;
      case "--show-setup-banner": o.showSetupBanner = true; break;
      case "--hide-instructions": o.hideInstructions = true; break;
      case "--actions": o.actions = JSON.parse(next()); break;
      case "--fix-drawer": o.fixDrawer = true; break;
      case "--help": case "-h": o.help = true; break;
      default: throw new Error(`Opción desconocida: ${a}`);
    }
  }
  return o;
}

// ----------------------------------------------------------------------------- session (API)
// El token de sesión (JWT) se cachea en el directorio temporal del sistema: NUNCA junto al script ni bajo docs/manual.
const SESSION_FILE = join(tmpdir(), "ehotelos-manual-capturas-session.json");
const PROPERTY_NAMES = { prop_123: "Hotel Demo Madrid Centro", prop_canary: "Hotel Demo Tenerife Sur" };

async function getSession(api) {
  const cached = existsSync(SESSION_FILE) ? JSON.parse(readFileSync(SESSION_FILE, "utf8")) : null;
  if (cached?.token) {
    const me = await fetch(`${api}/users/me`, { headers: { authorization: `Bearer ${cached.token}`, "x-property-id": "prop_123" } }).catch(() => null);
    if (me && me.ok) return cached;
  }
  const res = await fetch(`${api}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: process.env.MANUAL_LOGIN_EMAIL ?? "reception@example.com", password: process.env.MANUAL_LOGIN_PASSWORD ?? "hotelos-demo" })
  });
  if (!res.ok) throw new Error(`POST /auth/login → ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const session = { token: json.token, user: json.user, at: new Date().toISOString() };
  writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
  return session;
}

// ----------------------------------------------------------------------------- PNG decode / quantize / encode (sin dependencias)
const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Decodes an 8-bit, non-interlaced RGB/RGBA/gray/indexed PNG into RGBA. */
function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error("No es un PNG");
  let pos = 8, width = 0, height = 0, depth = 0, colorType = 0, interlace = 0, palette = null, trns = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos); const type = buf.toString("ascii", pos + 4, pos + 8); const data = buf.subarray(pos + 8, pos + 8 + len); pos += 12 + len;
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; colorType = data[9]; interlace = data[12]; }
    else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
  }
  if (depth !== 8 || interlace !== 0) throw new Error(`PNG no soportado (depth ${depth}, interlace ${interlace})`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`PNG color type ${colorType} no soportado`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    raw.copy(cur, 0, y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0, b = prev[i], c = i >= channels ? prev[i - channels] : 0;
      let v = cur[i];
      if (filter === 1) v += a; else if (filter === 2) v += b; else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4, s = x * channels;
      if (colorType === 6) { out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2]; out[o + 3] = cur[s + 3]; }
      else if (colorType === 2) { out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2]; out[o + 3] = 255; }
      else if (colorType === 0) { out[o] = out[o + 1] = out[o + 2] = cur[s]; out[o + 3] = 255; }
      else if (colorType === 4) { out[o] = out[o + 1] = out[o + 2] = cur[s]; out[o + 3] = cur[s + 1]; }
      else { const idx = cur[s]; out[o] = palette[idx * 3]; out[o + 1] = palette[idx * 3 + 1]; out[o + 2] = palette[idx * 3 + 2]; out[o + 3] = trns && idx < trns.length ? trns[idx] : 255; }
    }
    [prev, cur] = [cur, prev];
  }
  return { width, height, rgba: out };
}

/** Median-cut palette (≤ maxColors) over the unique colours weighted by frequency. */
function medianCut(counts, maxColors) {
  const entries = [...counts.entries()].map(([key, n]) => ({ r: (key >>> 16) & 255, g: (key >>> 8) & 255, b: key & 255, n }));
  if (entries.length <= maxColors) return entries.map((e) => [e.r, e.g, e.b]);
  const boxes = [entries];
  while (boxes.length < maxColors) {
    let bi = -1, best = -1;
    for (let i = 0; i < boxes.length; i++) {
      const bx = boxes[i]; if (bx.length < 2) continue;
      let mn = [255, 255, 255], mx = [0, 0, 0];
      for (const e of bx) { mn = [Math.min(mn[0], e.r), Math.min(mn[1], e.g), Math.min(mn[2], e.b)]; mx = [Math.max(mx[0], e.r), Math.max(mx[1], e.g), Math.max(mx[2], e.b)]; }
      const range = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]);
      const score = range * Math.log2(bx.length + 1);
      if (score > best) { best = score; bi = i; }
    }
    if (bi < 0) break;
    const bx = boxes[bi];
    let mn = [255, 255, 255], mx = [0, 0, 0];
    for (const e of bx) { mn = [Math.min(mn[0], e.r), Math.min(mn[1], e.g), Math.min(mn[2], e.b)]; mx = [Math.max(mx[0], e.r), Math.max(mx[1], e.g), Math.max(mx[2], e.b)]; }
    const ranges = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
    const axis = ranges.indexOf(Math.max(...ranges));
    const k = ["r", "g", "b"][axis];
    bx.sort((a, b) => a[k] - b[k]);
    const total = bx.reduce((s, e) => s + e.n, 0);
    let acc = 0, cut = 0;
    for (; cut < bx.length - 1; cut++) { acc += bx[cut].n; if (acc >= total / 2) { cut++; break; } }
    if (cut <= 0 || cut >= bx.length) cut = Math.floor(bx.length / 2);
    boxes.splice(bi, 1, bx.slice(0, cut), bx.slice(cut));
  }
  return boxes.map((bx) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (const e of bx) { r += e.r * e.n; g += e.g * e.n; b += e.b * e.n; n += e.n; }
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  });
}

/** RGBA → indexed PNG (colour type 3) with ≤ maxColors colours; alpha is flattened over white. */
function encodeIndexedPng({ width, height, rgba }, maxColors) {
  const counts = new Map();
  const keys = new Uint32Array(width * height);
  for (let i = 0, p = 0; i < keys.length; i++, p += 4) {
    const a = rgba[p + 3] / 255;
    const r = Math.round(rgba[p] * a + 255 * (1 - a)), g = Math.round(rgba[p + 1] * a + 255 * (1 - a)), b = Math.round(rgba[p + 2] * a + 255 * (1 - a));
    const key = ((r << 16) | (g << 8) | b) >>> 0;
    keys[i] = key;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const palette = medianCut(counts, maxColors);
  const index = new Map();
  const nearest = (key) => {
    let hit = index.get(key);
    if (hit !== undefined) return hit;
    const r = (key >>> 16) & 255, g = (key >>> 8) & 255, b = key & 255;
    let bi = 0, bd = Infinity;
    for (let i = 0; i < palette.length; i++) { const [pr, pg, pb] = palette[i]; const d = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2; if (d < bd) { bd = d; bi = i; if (d === 0) break; } }
    index.set(key, bi);
    return bi;
  };
  const depth = palette.length <= 2 ? 1 : palette.length <= 4 ? 2 : palette.length <= 16 ? 4 : 8;
  const ppb = 8 / depth, stride = Math.ceil(width / ppb);
  const rows = Buffer.alloc((stride + 1) * height);
  const line = new Uint8Array(width);
  let prevPacked = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) line[x] = nearest(keys[y * width + x]);
    const packed = Buffer.alloc(stride);
    for (let x = 0; x < width; x++) packed[Math.floor(x / ppb)] |= line[x] << (8 - depth - (x % ppb) * depth);
    // Filter choice per row: None vs Up (cheap and effective on flat UI).
    let sumNone = 0, sumUp = 0;
    for (let i = 0; i < stride; i++) { sumNone += Math.abs((packed[i] << 24) >> 24); sumUp += Math.abs((((packed[i] - prevPacked[i]) & 0xff) << 24) >> 24); }
    const off = y * (stride + 1);
    if (sumUp < sumNone) { rows[off] = 2; for (let i = 0; i < stride; i++) rows[off + 1 + i] = (packed[i] - prevPacked[i]) & 0xff; }
    else { rows[off] = 0; packed.copy(rows, off + 1); }
    prevPacked = packed;
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = depth; ihdr[9] = 3; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const plte = Buffer.from(palette.flat());
  const idat = zlib.deflateSync(rows, { level: 9, memLevel: 9 });
  return { png: Buffer.concat([PNG_SIG, chunk("IHDR", ihdr), chunk("PLTE", plte), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]), colors: palette.length, unique: counts.size };
}

/** Optimises a Playwright PNG to ≤ maxKb using progressively smaller palettes. */
export function optimisePng(rawPng, { maxKb = 150, colors = 256 } = {}) {
  const img = decodePng(rawPng);
  let best = null;
  for (const n of [colors, 128, 64, 32, 16].filter((v) => v <= colors)) {
    const r = encodeIndexedPng(img, n);
    if (!best || r.png.length < best.png.length) best = { ...r, width: img.width, height: img.height };
    if (r.png.length <= maxKb * 1024) { best = { ...r, width: img.width, height: img.height }; break; }
  }
  if (rawPng.length < best.png.length) return { png: rawPng, colors: null, unique: best.unique, width: img.width, height: img.height };
  return best;
}

/** Claves admitidas en un trabajo del lote (todo lo demás aborta: ver cabecera). */
const JOB_KEYS = new Set(["url", "out", "viewAs", "clip", "selector", "waitFor", "readyText", "wait", "full", "property", "hideInstructions", "hideCaret", "showTour", "showSetupBanner", "maxKb", "colors", "keepRaw", "actions", "fixDrawer"]);

// ----------------------------------------------------------------------------- actions
/** Velo abierto de CocoaDrawer visible en escritorio (workaround del defecto de cocoa-22-shell.css; ver --fix-drawer). */
const DRAWER_FIX_CSS = `.c22-scrim[data-cocoa="scrim"][data-open="true"] { display: block !important; }`;

/** Ejecuta los pasos de "actions" en orden (ver cabecera). Cada paso es un objeto con una sola clave. */
async function runActions(page, actions) {
  for (const step of actions) {
    if (!step || typeof step !== "object") throw new Error(`Acción inválida: ${JSON.stringify(step)}`);
    if ("click" in step) await page.locator(step.click).first().click();
    else if ("button" in step) await page.getByRole("button", { name: step.button }).first().click();
    else if ("tab" in step) {
      const tab = page.getByRole("tab", { name: step.tab });
      if ((await tab.count()) > 0) await tab.first().click();
      else await page.getByText(step.tab, { exact: true }).first().click();
    } else if ("fill" in step) await page.locator(step.fill[0]).first().fill(String(step.fill[1]));
    else if ("select" in step) await page.locator(step.select[0]).first().selectOption(String(step.select[1]));
    else if ("file" in step) {
      const { selector = "input[type=file]", name, mimeType = "text/csv", content } = step.file;
      await page.locator(selector).first().setInputFiles({ name, mimeType, buffer: Buffer.from(String(content), "utf8") });
    } else if ("waitFor" in step) await page.waitForSelector(step.waitFor, { timeout: 20000 });
    else if ("wait" in step) await page.waitForTimeout(Number(step.wait));
    else throw new Error(`Acción desconocida: ${JSON.stringify(step)}`);
  }
}

// ----------------------------------------------------------------------------- capture
export async function capture(job, opts, shared) {
  const { browser, session } = shared;
  const property = job.property ?? opts.property;
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    colorScheme: "light",
    locale: "es-ES",
    timezoneId: "Europe/Madrid",
    reducedMotion: "reduce"
  });
  const showTour = job.showTour ?? opts.showTour;
  const showSetupBanner = job.showSetupBanner ?? opts.showSetupBanner;
  const hideInstructions = job.hideInstructions ?? opts.hideInstructions;
  await context.addInitScript(({ token, user, property, propertyName, showTour, showSetupBanner, hideInstructions, tokens, instructionKeys }) => {
    try {
      localStorage.setItem("hotelos.auth.token", token);
      localStorage.setItem("hotelos.auth.user", JSON.stringify(user));
      localStorage.setItem("hotelos-active-property", property);
      localStorage.setItem("hotelos-active-org", user.organizationId ?? "org_123");
      localStorage.setItem("hotelos-active-property-name", propertyName);
      localStorage.setItem("hotelos.theme", "light");
      // Welcome tour («Te damos la bienvenida…») and per-role tour offers: off unless --show-tour.
      if (!showTour) localStorage.setItem("hotelos.guide.v1", JSON.stringify({ tourCompleted: true, welcomeDismissed: true, seenRoles: tokens }));
      // Readiness banner («Faltan N comprobaciones para poner la propiedad en marcha»): session flag per property.
      if (!showSetupBanner) sessionStorage.setItem(`anfitorio.setup-banner.dismissed.${property}`, "1");
      // In-app instruction cards (CocoaScreenInstructionsCard persistKey): hidden only with --hide-instructions.
      if (hideInstructions) for (const key of instructionKeys) localStorage.setItem(`cocoa-screen-instructions:${key}`, "1");
    } catch { /* storage unavailable */ }
  }, {
    token: session.token, user: session.user, property, propertyName: PROPERTY_NAMES[property] ?? property,
    showTour: Boolean(showTour), showSetupBanner: Boolean(showSetupBanner), hideInstructions: Boolean(hideInstructions),
    tokens: ["direccion", "recepcion", "pisos", "mantenimiento", "revenue", "finanzas", "comercial", "fnb", "administracion", "rrhh", "propiedad", "activos", "auditoria", "sistemas", "admin"],
    instructionKeys: ["live-timeline", "frontdesk-cockpit", "reservations", "housekeeping", "maintenance", "revenue", "channels", "billing", "compliance", "groups", "property-taxes", "tax-compliance-settings"]
  });
  const page = await context.newPage();
  const url = job.url.startsWith("http") ? job.url : `${opts.base}${job.url.startsWith("/") ? "" : "/"}${job.url}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
  await page.addStyleTag({ content: `*, *::before, *::after { animation: none !important; transition: none !important; }${job.hideCaret ?? opts.hideCaret ? " * { caret-color: transparent !important; }" : ""}` }).catch(() => undefined);
  const viewAs = job.viewAs ?? opts.viewAs;
  if (viewAs) {
    await page.waitForSelector("#c22-view-as", { timeout: 15000 });
    await page.selectOption("#c22-view-as", viewAs);
    await page.waitForSelector(".c22-nav-viewas-badge", { timeout: 5000 }).catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => undefined);
  }
  if (job.fixDrawer ?? opts.fixDrawer) await page.addStyleTag({ content: DRAWER_FIX_CSS });
  await runActions(page, job.actions ?? opts.actions ?? []);
  const waitFor = job.waitFor ?? opts.waitFor;
  if (waitFor) await page.waitForSelector(waitFor, { timeout: 20000 });
  const readyText = job.readyText ?? opts.readyText;
  if (readyText) await page.getByText(readyText).first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(job.wait ?? opts.wait);

  const shot = { type: "png" };
  let raw;
  const selector = job.selector ?? opts.selector;
  const clip = job.clip ?? opts.clip;
  if (selector) raw = await page.locator(selector).first().screenshot(shot);
  else if (clip) { const [x, y, width, height] = String(clip).split(",").map(Number); raw = await page.screenshot({ ...shot, clip: { x, y, width, height } }); }
  else raw = await page.screenshot({ ...shot, fullPage: Boolean(job.full ?? opts.full) });
  const title = await page.title();
  const finalUrl = page.url();
  await context.close();

  const out = resolve(job.out);
  mkdirSync(dirname(out), { recursive: true });
  if (job.keepRaw ?? opts.keepRaw) writeFileSync(out.replace(/\.png$/i, ".raw.png"), raw);
  const best = optimisePng(raw, { maxKb: job.maxKb ?? opts.maxKb, colors: job.colors ?? opts.colors });
  writeFileSync(out, best.png);
  const result = { out, url: finalUrl, title, bytes: best.png.length, rawBytes: raw.length, width: best.width, height: best.height, colors: best.colors, viewAs: viewAs ?? null, property, fixDrawer: Boolean(job.fixDrawer ?? opts.fixDrawer), ok: best.png.length <= (job.maxKb ?? opts.maxKb) * 1024 };
  console.log(JSON.stringify(result));
  if (!result.ok) console.error(`AVISO: ${out} pesa ${(best.png.length / 1024).toFixed(1)} KB > ${job.maxKb ?? opts.maxKb} KB: recorta (--clip/--selector) o baja --colors.`);
  return result;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || (!opts.url && !opts.batch)) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).join("\n"));
    process.exit(opts.help ? 0 : 1);
  }
  const jobs = opts.batch ? JSON.parse(readFileSync(opts.batch, "utf8")) : [{ url: opts.url, out: opts.out ?? `capture-${Date.now()}.png` }];
  for (const [i, job] of jobs.entries()) {
    const unknown = Object.keys(job).filter((k) => !k.startsWith("_") && !JOB_KEYS.has(k));
    if (unknown.length) throw new Error(`Trabajo ${i + 1} (${job.out ?? job.url ?? "?"}): claves no admitidas ${unknown.join(", ")}. La receta no reproduce ese estado: captúralo a mano (ver README «Qué lotes NO regenera el comando»).`);
    if (!job.url || !job.out) throw new Error(`Trabajo ${i + 1}: faltan "url" u "out"`);
  }
  const require = createRequire(join(opts.repo, "apps/admin-web/package.json"));
  const { chromium } = require("@playwright/test");
  const session = await getSession(opts.api);
  const browser = await chromium.launch({ headless: !opts.headed });
  const results = [];
  try {
    for (const job of jobs) results.push(await capture(job, opts, { browser, session }));
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length) process.exit(2);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`ERROR: ${e.stack ?? e.message}`); process.exit(1); });
}
