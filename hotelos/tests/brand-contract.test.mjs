// Contrato de marca «ehotelOS» (rebrand 2026-09 · lote 1 · brand-core).
//
// Fija la fuente de la marca (apps/admin-web/src/config/brand.ts) y sus tres
// copias mínimas, y barre el inventario VISIBLE (UI, correos, PDFs, docs vivos,
// deploy) en busca de la marca anterior («Anfitorio», «HotelOS»), de grafías
// incorrectas de la nueva («Ehotelos», «eHotelOS»…) y de los dominios antiguos
// (demo.hotelos.es, hotelos.app, anfitorio.es/.com).
//
// Diseño (rebrand-plan.json · lote brand-core):
//   - VISIBLE_ROOTS es una lista de INCLUSIÓN explícita; lo que no está no se
//     escanea. HISTORICAL documenta los históricos que se conservan (auditorías,
//     estrategia, READMEs OBSOLETO) y se salta en el barrido. El runbook fechado
//     del VPS (docs/runbooks/vps-demo-actualizacion-2026-09-17.md) NO es histórico:
//     D16 sustituye dominio y marca en su texto (no en rutas/unidades) y se escanea.
//   - TECHNICAL blanquea (con espacios, para conservar los números de línea) los
//     identificadores que llevan la marca y NO cambian: @hotelos/*, HOTELOS_*,
//     X-HotelOS-* / X-Anfitorio-* (D7), hotelos://, claves localStorage
//     anfitorio.* / hotelos.* (D11), rutas /opt|/etc|/srv/anfitorio, unidades
//     systemd (D9), funciones SQL hotelos_*(), y la grafía nueva en
//     identificadores (ehotelos-shell-v1, @ehotelos.demo, demo.ehotelos.com).
//   - Comentarios: solo en ficheros de código y SOLO los que EMPIEZAN línea
//     (`//`, `/* … */`, `{/* … */}`). PROHIBIDO el bloque «desnudo»
//     /\/\*[\s\S]*?\*\//g: un `/*` dentro de un `//` (module-manifest.ts:643,
//     `/desarrollo/migracion/*`) se tragaría código visible hasta el siguiente
//     `*/` (R15). Un comentario al final de una línea de código se renombra.
//   - Salida del barrido: `ruta:línea: token · contexto` (token y contexto
//     separados por « · » para poder filtrar por token).
//
// Estado esperado por lotes (D12): con el lote 1 pasan «brand.ts es la fuente»,
// «los 4 ficheros brand coinciden», «las raíces visibles existen» y «allowlist
// corta y justificada»; el barrido lista el residuo del inventario y queda rojo
// hasta que los lotes 2-6 lo vacíen. Corre con `pnpm test` (node --test
// tests/*.test.mjs) y, por tanto, en CI.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, extname, join, relative, sep } from "node:path";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const rel = (file) => relative(ROOT, file).split(sep).join("/");
const read = (relative) => readFileSync(join(ROOT, relative), "utf8");
const exists = (relative) => existsSync(join(ROOT, relative));

// ---------------------------------------------------------------------------
// Inventario visible (lista de inclusión explícita).
// ---------------------------------------------------------------------------

/** `x/**` = directorio recursivo; `dir/*.ext` o `dir/*.{a,b}` = un nivel; resto = fichero. */
const VISIBLE_ROOTS = [
  "apps/admin-web/index.html",
  "apps/admin-web/public/manifest.webmanifest",
  "apps/admin-web/public/icon.svg",
  "apps/admin-web/public/sw.js",
  "apps/admin-web/src/**",
  "apps/guest-web/index.html",
  "apps/guest-web/src/**",
  "apps/mobile/app.json",
  "apps/mobile/App.tsx",
  "apps/mobile/src/**",
  "apps/worker/src/**",
  "apps/api/src/**",
  "apps/api/docs/openapi.yaml",
  "apps/api/scripts/generate-openapi.mjs",
  "apps/ai-gateway/src/**",
  "packages/compliance/src/**",
  "packages/shared/src/**",
  "packages/product/src/**",
  "packages/ui/src/**",
  "packages/onboarding/src/**",
  "packages/integrations/src/**",
  "packages/database/prisma/seed.ts",
  "packages/database/prisma/seed-operations.ts",
  "packages/database/seeds/**",
  "packages/database/MIGRATIONS_README.md",
  "README.md",
  "CLAUDE.md",
  "deploy/README-INSTALL.md",
  "deploy/*.yml",
  "deploy/Caddyfile",
  "deploy/caddy/*",
  "deploy/Dockerfile.*",
  "deploy/systemd/*",
  "deploy/scripts/*.sh",
  "deploy/.env.production.example",
  ".env.example",
  "scripts/*.{mjs,sh,json}",
  "docs/runbooks/*.md",
  "docs/design/COCOA-22.md",
  "docs/design/COCOA-22-MIGRACION.md",
  "docs/api-contracts.md",
  "docs/compliance/*.md",
  "demo/public/**",
  "demo/server.mjs",
  // La CI vive en la raíz git (../.github); solo si existe (R11).
  "../.github/workflows/*.yml"
];
const OPTIONAL_ROOTS = new Set(["../.github/workflows/*.yml"]);

const EXCLUDED_DIR_NAMES = new Set(["node_modules", "dist", "__tests__", "e2e"]);
const EXCLUDED_PREFIXES = ["packages/database/prisma/migrations/"];
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".zip", ".gz", ".mp4", ".mp3", ".wasm", ".swp"
]);

/** Históricos que se conservan tal cual: ruta → motivo. Corta, justificada y viva (cada ruta existe). */
const HISTORICAL = new Map([
  ["docs/audits", "informes de auditoría fechados: histórico"],
  ["docs/strategy", "documentos de estrategia fechados (rate-grid-docs-contract lee PLAN-MAESTRO.md)"],
  ["docs/design/olas", "olas de migración Cocoa 22 ya cerradas: histórico"],
  ["docs/cocoa-design", "notas de diseño previas a Cocoa 22: histórico"],
  ["docs/pilot-client", "material del piloto: histórico"],
  ["docs/pilots", "notas de pilotos: histórico"],
  ["docs/chat-transcript-readable.md", "transcripción histórica de sesión"],
  ["docs/SESSION-LOG-2026-05.md", "diario de sesión fechado: histórico"],
  ["AUDITORIA.md", "auditoría fechada: histórico"],
  ["AUDITORIA-IA.md", "auditoría de IA fechada: histórico"],
  ["deploy/CLAUDE-RESUME-CONTEXT.md", "contexto de sesión OBSOLETO (deployment-contract lo fija)"],
  ["deploy/README-HOSTINGER.md", "README marcado OBSOLETO (deployment-contract lo fija)"],
  ["deploy/README-REMOTE-DEV.md", "README marcado OBSOLETO (deployment-contract lo fija)"],
  ["docs/deploy-pilot.md", "guía marcada OBSOLETO (deployment-contract lo fija)"],
  ["docs/deployment.md", "guía marcada OBSOLETO (deployment-contract lo fija)"],
  ["demo/partner-demo", "one-pager y PDF de la demo a socios: histórico"],
  ["design-tokens/hotelos.tokens.json", "tokens de diseño fijados por front-ui-aurora-contract.test.mjs"],
  ["docs/front_ui_implementation_addendum.md", "addendum de implementación histórico (no es UI)"],
  ["docs/modular-suite-addendum.md", "addendum de suite modular histórico (no es UI)"]
]);
// Los runbooks fechados (docs/runbooks/*-AAAA-MM-DD.md) NO se saltan: D16 renombra el
// texto del runbook del VPS y el barrido lo cubre como al resto de docs/runbooks/*.md.

function isHistorical(path) {
  for (const key of HISTORICAL.keys()) {
    if (path === key || path.startsWith(`${key}/`)) return true;
  }
  return false;
}

function isExcluded(path) {
  if (EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  return path.split("/").some((segment) => EXCLUDED_DIR_NAMES.has(segment));
}

function isBinary(file) {
  if (BINARY_EXTENSIONS.has(extname(file).toLowerCase())) return true;
  const head = readFileSync(file).subarray(0, 8192);
  return head.includes(0);
}

function walkDir(dir, out) {
  for (const entry of readdirSync(dir).sort()) {
    if (entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry)) continue;
      walkDir(full, out);
    } else if (stats.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function globToRegExp(glob) {
  const escaped = glob
    .replace(/[.+^$()|[\]\\]/g, "\\$&")
    .replace(/\{([^}]+)\}/g, (_m, alts) => `(?:${alts.split(",").join("|")})`)
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
}

/** Expande una entrada de VISIBLE_ROOTS a ficheros absolutos (sin filtrar históricos ni binarios). */
function expandRoot(root) {
  const abs = join(ROOT, root);
  if (root.endsWith("/**")) {
    const dir = abs.slice(0, -3);
    return existsSync(dir) ? walkDir(dir, []) : [];
  }
  const name = basename(root);
  if (/[*{]/.test(name)) {
    const dir = dirname(abs);
    if (!existsSync(dir)) return [];
    const re = globToRegExp(name);
    return readdirSync(dir)
      .filter((entry) => re.test(entry) && statSync(join(dir, entry)).isFile())
      .sort()
      .map((entry) => join(dir, entry));
  }
  return existsSync(abs) ? [abs] : [];
}

/** Ficheros visibles: expandidos, sin excluidos, sin históricos, sin binarios; una vez cada uno. */
function visibleFiles() {
  const seen = new Set();
  const files = [];
  for (const root of VISIBLE_ROOTS) {
    for (const file of expandRoot(root)) {
      const path = rel(file);
      if (seen.has(path) || isExcluded(path) || isHistorical(path) || isBinary(file)) continue;
      seen.add(path);
      files.push({ file, path });
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Scrub: comentarios que empiezan línea (solo código) + identificadores técnicos.
// ---------------------------------------------------------------------------

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx", ".css"]);

/** Sustituye todo salvo los saltos de línea por espacios: los números de línea no cambian. */
const blank = (text) => text.replace(/[^\n]/g, " ");

function blankLeadingComments(source) {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, blank)
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, blank)
    .replace(/^[ \t]*\/\/.*$/gm, blank);
}

/** Identificadores con marca que NO cambian (se blanquean antes del barrido). */
const TECHNICAL = [
  /@hotelos\/[\w-]+/g,
  /HOTELOS_[A-Z0-9_]+/g,
  /[xX]-[hH]otel[oO][sS]-[\w-]+/g,
  /HotelOS(?:Flow)?Tokens|HotelOSTabs|HotelOsToolName|hotelOSTokens|hotelOSFlowTokens/g,
  /hotelos[._/-][\w./-]*/g,
  /\bhotelos:\/\/[\w./?=&-]*/g,
  /[xX]-[aA]nfitorio-[\w-]+/g,
  /anfitorio[._-][\w.-]+/g,
  /\/(?:opt|etc|srv|var\/backups|var\/log(?:\/caddy)?|home\/[\w-]+\/\.config)\/anfitorio[\w./-]*/g,
  /(?:User|Group|SyslogIdentifier)=anfitorio/g,
  /ANFITORIO_RIAS|anfitorio\.scheduler/g,
  // Clave JSON/columna `anfitorio` de la conciliación OPERA (pms-shadow).
  /\banfitorio\b(?=\s*[:,}\]"'?])/g,
  /~\/anfitorio-demo/g,
  // Funciones SQL hotelos_*(...).
  /hotelos_[a-z_]+\(/g,
  // Grafía nueva en identificadores: ehotelos-shell-v1, ehotelos_${slug}, /ehotelos/webhook.
  /ehotelos[._/-][\w./-]*/g,
  // Dominios y buzones nuevos: demo.ehotelos.com, soporte@ehotelos.com, @ehotelos.demo, compliance@ehotelos.example.
  // La barra opcional (`ehotelos\\.com`) cubre los `sed` del instalador que exige la aserción «dominios».
  /[\w.+-]*@?ehotelos\\?\.(?:com|demo|example)[\w./-]*/g,
  // Pin de producción del SIF VeriFactu (D4): valor declarado ante la AEAT, no copy de marca
  // (docs/compliance/verifactu-declaracion-responsable.md §4.7.5, deploy/README-INSTALL.md §9).
  /VERIFACTU_SYSTEM_NAME=Anfitorio\b/g
];

function scrub(source, path) {
  let text = CODE_EXTENSIONS.has(extname(path)) ? blankLeadingComments(source) : source;
  for (const re of TECHNICAL) text = text.replace(re, blank);
  return text;
}

/** `ruta:línea: token · contexto` para cada coincidencia de `re` en `text` (contexto = línea original). */
function findHits(path, text, originalLines, re) {
  const hits = [];
  const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  let match;
  while ((match = global.exec(text)) !== null) {
    const line = text.slice(0, match.index).split("\n").length;
    const context = (originalLines[line - 1] ?? "").replace(/\s+/g, " ").trim().slice(0, 100);
    hits.push(`${path}:${line}: ${match[0]} · ${context}`);
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Expresiones del barrido.
// ---------------------------------------------------------------------------

// `hotelOS` caza «el PMS de hotelOS» (glossary.ts); `ehotelOS` NO casa porque no hay
// límite de palabra entre la e y la h; hotelOSTokens ya está blanqueado.
const OLD_BRAND_RE = /\b(?:Anfitorio|ANFITORIO|HotelOS|hotelOS|Hotel OS)\b/g;
// Grafías incorrectas de la marca nueva (`ehotelos` en minúsculas solo se admite en
// dominios e identificadores, que TECHNICAL ya ha blanqueado).
const MISSPELLING_RE = /\b(?:Ehotelos|EhotelOS|EHotelOS|EHOTELOS|eHotelOS|eHotelos|Ehotel OS|e-hotelOS|e hotelOS|ehotelos)\b/g;
// Dominios antiguos, sobre el texto SIN scrub. NO incluye hotelos.example ni
// hotelos.demo: D9 conserva los placeholders de gdpr.service.ts.
const OLD_DOMAIN_RE = /demo\.hotelos\.es|hotelos\.app|anfitorio\.(?:es|com)/g;

const BRAND_FILES = [
  "apps/admin-web/src/config/brand.ts",
  "apps/guest-web/src/config/brand.ts",
  "apps/mobile/src/config/brand.ts",
  "apps/api/src/lib/brand.ts"
];
const BRAND_SOURCE = BRAND_FILES[0];

function brandField(source, field) {
  const match = source.match(new RegExp(`^\\s*${field}:\\s*"([^"]*)"`, "m"));
  return match ? match[1] : undefined;
}

// Literales `ehotelOS` admitidos en apps/admin-web/src fuera de brand.ts y __tests__.
const ALLOWED_LITERALS = new Map([
  ["apps/admin-web/src/navigation/nav-tree.generated.json", "generado desde el CSV, no importa BRAND"],
  ["apps/admin-web/src/services/activeProperty.ts", "nombres demo D3/D6 (preferir `${BRAND.name} …`)"],
  ["apps/admin-web/src/services/financeScope.ts", "nombres demo D3/D6 (preferir `${BRAND.name} …`)"],
  ["apps/admin-web/src/screens/loyalty/LoyaltyProgramScreen.tsx", "nombres demo D3/D6 (preferir `${BRAND.name} …`)"]
]);
const MAX_ADMIN_WEB_LITERALS = 4;

const CADDY_NATIVE = "deploy/caddy/Caddyfile.native";
const INSTALLER = "deploy/scripts/install-from-scratch.sh";

// ---------------------------------------------------------------------------

describe("Contrato de marca · ehotelOS", () => {
  it("brand.ts es la fuente", () => {
    assert.ok(exists(BRAND_SOURCE), `${BRAND_SOURCE} debe existir`);
    assert.match(read(BRAND_SOURCE), /name:\s*"ehotelOS"/, `${BRAND_SOURCE} debe declarar name: "ehotelOS"`);
  });

  it("los 4 ficheros brand coinciden", () => {
    const problems = [];
    const values = new Map();
    for (const path of BRAND_FILES) {
      if (!exists(path)) {
        problems.push(`${path}: no existe`);
        continue;
      }
      const source = read(path);
      for (const field of ["name", "legalSuffix", "domain", "demoUrl"]) {
        const value = brandField(source, field);
        if (value === undefined) problems.push(`${path}: falta el campo ${field}`);
        else values.set(`${path}#${field}`, value);
      }
      if (!/\}\s*as const;/.test(source)) problems.push(`${path}: el objeto BRAND debe cerrarse con \`as const\``);
    }
    const source = read(BRAND_SOURCE);
    for (const field of ["name", "legalSuffix", "domain", "demoUrl"]) {
      const expected = brandField(source, field);
      for (const path of BRAND_FILES.slice(1)) {
        const actual = values.get(`${path}#${field}`);
        if (actual !== undefined && actual !== expected) {
          problems.push(`${path}: ${field} = "${actual}" ≠ "${expected}" (${BRAND_SOURCE})`);
        }
      }
    }
    assert.equal(values.get(`${BRAND_SOURCE}#name`), "ehotelOS");
    assert.deepEqual(problems, [], `Las copias de brand.ts divergen de la fuente:\n${problems.join("\n")}`);
  });

  it("las raíces visibles existen", () => {
    const missing = VISIBLE_ROOTS.filter((root) => !OPTIONAL_ROOTS.has(root) && expandRoot(root).length === 0);
    assert.deepEqual(missing, [], `Raíces del inventario sin ningún fichero (¿movidas?):\n${missing.join("\n")}`);
  });

  it("allowlist corta y justificada", () => {
    assert.ok(HISTORICAL.size <= 25, `HISTORICAL tiene ${HISTORICAL.size} entradas (máximo 25)`);
    for (const [path, reason] of HISTORICAL) {
      assert.ok(reason.length > 10, `${path}: motivo demasiado corto («${reason}»)`);
      assert.ok(exists(path), `${path}: la entrada de HISTORICAL ya no existe; retírala`);
    }
  });

  it("ningún Anfitorio/HotelOS visible", () => {
    const hits = [];
    for (const { file, path } of visibleFiles()) {
      const source = readFileSync(file, "utf8");
      const text = scrub(source, path);
      if (!/Anfitorio|ANFITORIO|HotelOS|hotelOS|Hotel OS/.test(text)) continue;
      hits.push(...findHits(path, text, source.split("\n"), OLD_BRAND_RE));
    }
    assert.deepEqual(hits, [], `Residuo de la marca anterior en el inventario visible (${hits.length}):\n${hits.join("\n")}`);
  });

  it("grafía exacta", () => {
    const hits = [];
    for (const { file, path } of visibleFiles()) {
      const source = readFileSync(file, "utf8");
      const text = scrub(source, path);
      if (!/hotelos|hotelOS|Hotelos|HotelOS|HOTELOS/i.test(text)) continue;
      hits.push(...findHits(path, text, source.split("\n"), MISSPELLING_RE));
    }
    assert.deepEqual(hits, [], `Grafía incorrecta de «ehotelOS» (${hits.length}):\n${hits.join("\n")}`);
  });

  it("literales acotados en admin-web", () => {
    const hits = [];
    const dir = join(ROOT, "apps/admin-web/src");
    for (const file of walkDir(dir, [])) {
      const path = rel(file);
      if (path === BRAND_SOURCE || isExcluded(path) || isBinary(file)) continue;
      const source = readFileSync(file, "utf8");
      const text = CODE_EXTENSIONS.has(extname(path)) ? blankLeadingComments(source) : source;
      if (!text.includes("ehotelOS")) continue;
      hits.push(...findHits(path, text, source.split("\n"), /ehotelOS/g));
    }
    const offenders = hits.filter((hit) => !ALLOWED_LITERALS.has(hit.slice(0, hit.indexOf(":"))));
    assert.deepEqual(
      offenders,
      [],
      `Literales «ehotelOS» en admin-web fuera de brand.ts y de ALLOWED_LITERALS (usar BRAND.name) (${offenders.length}):\n${offenders.join("\n")}`
    );
    assert.ok(hits.length <= MAX_ADMIN_WEB_LITERALS, `${hits.length} literales «ehotelOS» en admin-web (máximo ${MAX_ADMIN_WEB_LITERALS}):\n${hits.join("\n")}`);
  });

  it("superficies fijas", () => {
    const problems = [];
    const expect = (path, re, label) => {
      if (!exists(path)) problems.push(`${path}: no existe`);
      else if (!re.test(read(path))) problems.push(`${path}: falta ${label}`);
    };
    expect("apps/admin-web/index.html", /<title>ehotelOS · Back Office<\/title>/, "<title>ehotelOS · Back Office</title>");
    expect("apps/admin-web/index.html", /apple-mobile-web-app-title" content="ehotelOS"/, 'apple-mobile-web-app-title content="ehotelOS"');
    expect("apps/admin-web/public/manifest.webmanifest", /"name":\s*"ehotelOS"/, '"name": "ehotelOS"');
    expect("apps/admin-web/public/manifest.webmanifest", /"short_name":\s*"ehotelOS"/, '"short_name": "ehotelOS"');
    expect("apps/admin-web/public/icon.svg", /aria-label="ehotelOS"/, 'aria-label="ehotelOS"');
    expect("apps/guest-web/index.html", /<title>ehotelOS · Portal del huésped<\/title>/, "<title>ehotelOS · Portal del huésped</title>");
    expect("apps/mobile/app.json", /"name":\s*"ehotelOS"/, '"name": "ehotelOS"');
    expect("apps/api/docs/openapi.yaml", /^\s*title:\s*ehotelOS API\s*$/m, "title: ehotelOS API");
    assert.deepEqual(problems, [], `Superficies fijas pendientes (${problems.length}):\n${problems.join("\n")}`);
  });

  it("SIF VeriFactu por defecto", () => {
    const problems = [];
    const expect = (path, re, label) => {
      if (!exists(path)) problems.push(`${path}: no existe`);
      else if (!re.test(read(path))) problems.push(`${path}: falta ${label}`);
    };
    expect("packages/compliance/src/spain/verifactu/software.ts", /nombreSistema:\s*"ehotelOS"/, 'nombreSistema: "ehotelOS"');
    // Espejo .js (código muerto bajo tsx, R2): se exige mientras exista.
    if (exists("packages/compliance/src/spain/verifactu/software.js")) {
      expect("packages/compliance/src/spain/verifactu/software.js", /nombreSistema:\s*"ehotelOS"/, 'nombreSistema: "ehotelOS" (espejo .js)');
    }
    expect(
      "apps/api/src/lib/env.ts",
      /VERIFACTU_SYSTEM_NAME:\s*\{[^}]*default:\s*"ehotelOS"[^}]*example:\s*"ehotelOS"/,
      'VERIFACTU_SYSTEM_NAME default/example "ehotelOS"'
    );
    if (!exists("scripts/env-contract.json")) {
      problems.push("scripts/env-contract.json: no existe");
    } else {
      const contract = JSON.parse(read("scripts/env-contract.json"));
      const variable = contract.variables?.VERIFACTU_SYSTEM_NAME ?? {};
      if (variable.default !== "ehotelOS") problems.push(`scripts/env-contract.json: variables.VERIFACTU_SYSTEM_NAME.default = ${JSON.stringify(variable.default)} (esperado "ehotelOS")`);
      if (variable.example !== "ehotelOS") problems.push(`scripts/env-contract.json: variables.VERIFACTU_SYSTEM_NAME.example = ${JSON.stringify(variable.example)} (esperado "ehotelOS")`);
    }
    expect(".env.example", /^VERIFACTU_SYSTEM_NAME=ehotelOS$/m, "VERIFACTU_SYSTEM_NAME=ehotelOS");
    expect("deploy/.env.production.example", /^VERIFACTU_SYSTEM_NAME=ehotelOS$/m, "VERIFACTU_SYSTEM_NAME=ehotelOS");
    assert.deepEqual(problems, [], `SIF VeriFactu por defecto pendiente (${problems.length}):\n${problems.join("\n")}`);
  });

  it("dominios", () => {
    const problems = [];
    for (const { file, path } of visibleFiles()) {
      const source = readFileSync(file, "utf8");
      if (!OLD_DOMAIN_RE.test(source)) {
        OLD_DOMAIN_RE.lastIndex = 0;
        continue;
      }
      OLD_DOMAIN_RE.lastIndex = 0;
      const lines = source.split("\n");
      const hits = findHits(path, source, lines, OLD_DOMAIN_RE);
      if (path !== CADDY_NATIVE) {
        problems.push(...hits);
        continue;
      }
      // Bloque de transición (D5): `demo.hotelos.es {` seguido del redirect 301.
      for (const hit of hits) {
        const line = Number(hit.slice(path.length + 1).split(":")[0]);
        const current = lines[line - 1];
        const next = lines.slice(line).find((candidate) => candidate.trim() !== "") ?? "";
        const transition = current === "demo.hotelos.es {" && /^\s*redir https:\/\/demo\.ehotelos\.com\{uri\} permanent$/.test(next);
        if (!transition) problems.push(hit);
      }
    }
    const check = (path, re, label) => {
      if (!exists(path)) problems.push(`${path}: no existe`);
      else if (!re.test(read(path))) problems.push(`${path}: falta ${label}`);
    };
    check(CADDY_NATIVE, /^demo\.ehotelos\.com \{/m, "el bloque `demo.ehotelos.com {`");
    check(CADDY_NATIVE, /^\s*email admin@ehotelos\.com$/m, "`email admin@ehotelos.com`");
    // Acoplamiento instalador ↔ Caddyfile (R3): el sed del dominio, el del ACME y el borrado del bloque de transición.
    check(INSTALLER, /s#demo\\\.ehotelos\\\.com#\$DOMAIN#g/, "el sed `s#demo\\.ehotelos\\.com#$DOMAIN#g`");
    check(INSTALLER, /s#admin@ehotelos\\\.com#\$ACME_EMAIL#/, "el sed `s#admin@ehotelos\\.com#$ACME_EMAIL#`");
    check(INSTALLER, /\/\^demo\\\.hotelos\\\.es \{\$\/,\/\^\}\$\/d/, "el borrado del bloque de transición `/^demo\\.hotelos\\.es {$/,/^}$/d`");
    assert.deepEqual(problems, [], `Dominios antiguos o acoplamiento Caddy/instalador pendiente (${problems.length}):\n${problems.join("\n")}`);
  });
});
