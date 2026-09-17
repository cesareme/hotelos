#!/usr/bin/env node
/**
 * Environment census + contract generator (Tanda 4 · DATA-04).
 *
 *   node scripts/env-census.mjs            # dry-run: report drift, exit 1 if out of date
 *   node scripts/env-census.mjs --write    # regenerate the three generated files
 *   node scripts/env-census.mjs --list     # print every variable the code reads, with locations
 *   node scripts/env-census.mjs --json     # machine-readable report (combinable with the above)
 *
 * Single source of truth: `ENV_CONTRACT` in apps/api/src/lib/env.ts. This
 * script (1) scans the runtime code for every environment variable it reads
 * (four styles: process.env.X — also the optional-chained process?.env?.X the
 * Expo app uses through globalThis —, env.X, readEnv(env, "X") / readFlag(env, "X"),
 * env("X"), plus import.meta.env.X for Vite), (2) fails when the code reads a
 * variable the contract does not document, (3) writes the union as
 * scripts/env-contract.json (consumed by scripts/validate-env.mjs, which has
 * no TypeScript at hand on a VPS) and (4) renders .env.example and
 * deploy/.env.production.example from the contract, section by section.
 *
 * Exit codes: 0 in sync / written · 1 drift or undocumented variables ·
 * 2 unexpected failure (contract could not be loaded, I/O error).
 *
 * The contract is loaded by running apps/api/src/lib/env.ts under tsx (the
 * API's dev loader) so this file stays dependency-free; tests/env-contract.test.mjs
 * runs the same census and compares it with the committed JSON.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT_JSON = join(ROOT, "scripts", "env-contract.json");
const EXAMPLE_DEV = join(ROOT, ".env.example");
const EXAMPLE_PROD = join(ROOT, "deploy", ".env.production.example");
const API_DIR = join(ROOT, "apps", "api");

/** Directories scanned for environment reads (relative to the repo root). */
export const CENSUS_ROOTS = ["apps/*/src", "packages/*/src", "packages/database/prisma", "scripts"];
const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set(["node_modules", "__tests__", "dist", "build", ".expo"]);
/** Generic tooling variables that are not application configuration. */
export const CENSUS_IGNORED = new Set([
  "NO_COLOR", "FORCE_COLOR", "CI", "HOME", "PATH", "PWD", "TERM", "USER", "TMPDIR", "SHELL",
  // Vite built-ins (import.meta.env.MODE / DEV / PROD / SSR / BASE_URL), not configuration.
  "MODE", "DEV", "PROD", "SSR"
]);

const PATTERNS = [
  // process.env.FOO, plus the optional-chained process?.env?.FOO the Expo app
  // uses (globalThis.process may not exist in React Native, so apps/mobile reads
  // `(globalThis as {...}).process?.env?.FOO`); a read the census misses shows
  // up as a "dead" contract variable, which is what H4 (Tanda 4) caught.
  /process\??\.env\??\.([A-Z][A-Z0-9_]+)/g,
  // process.env["FOO"] / process.env['FOO'] / process?.env?.["FOO"]
  /process\??\.env(?:\?\.)?\[\s*["']([A-Z][A-Z0-9_]+)["']\s*\]/g,
  // env.FOO where env is a NodeJS.ProcessEnv parameter (≥3 chars after the first letter)
  /\benv\.([A-Z][A-Z0-9_]{2,})\b/g,
  // readEnv(env, "FOO") / readFlag(env, "FOO")
  /\b(?:readEnv|readFlag)\(\s*env\s*,\s*["']([A-Z][A-Z0-9_]+)["']/g,
  // env("FOO")
  /\benv\(\s*["']([A-Z][A-Z0-9_]+)["']\s*\)/g,
  // import.meta.env.VITE_FOO (also the optional-chained import.meta.env?.VITE_FOO)
  /import\.meta\.env\??\.([A-Z][A-Z0-9_]+)/g
];

function expandRoots() {
  const dirs = [];
  for (const pattern of CENSUS_ROOTS) {
    if (!pattern.includes("*")) {
      const abs = join(ROOT, pattern);
      if (existsSync(abs)) dirs.push(abs);
      continue;
    }
    const [head, tail] = pattern.split("/*/");
    const base = join(ROOT, head);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const abs = join(base, entry, tail ?? "");
      if (existsSync(abs) && statSync(abs).isDirectory()) dirs.push(abs);
    }
  }
  return dirs;
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(join(dir, entry.name));
      continue;
    }
    const name = entry.name;
    const dot = name.lastIndexOf(".");
    const ext = dot >= 0 ? name.slice(dot) : "";
    if (!SCAN_EXTENSIONS.has(ext)) continue;
    if (name.endsWith(".d.ts") || /\.test\.[cm]?[jt]sx?$/.test(name)) continue;
    yield join(dir, name);
  }
}

/**
 * Scan the code base. Returns Map<name, Set<relative file path>>; the census
 * deliberately records files, not line numbers, so the generated JSON does
 * not churn every time an unrelated line moves.
 */
export function collectCensus(root = ROOT) {
  const reads = new Map();
  for (const dir of expandRoots()) {
    for (const file of walk(dir)) {
      const rel = relative(root, file);
      // The generator/validator themselves only handle names generically.
      if (rel === "scripts/env-census.mjs" || rel === "scripts/validate-env.mjs") continue;
      const content = readFileSync(file, "utf8");
      for (const pattern of PATTERNS) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(content)) !== null) {
          const name = match[1];
          if (CENSUS_IGNORED.has(name)) continue;
          if (!reads.has(name)) reads.set(name, new Set());
          reads.get(name).add(rel);
        }
      }
    }
  }
  return reads;
}

/** Load ENV_CONTRACT by evaluating apps/api/src/lib/env.ts under tsx (dependency-free here). */
export function loadContract() {
  const code =
    'import { ENV_CONTRACT } from "./src/lib/env.ts";\n' +
    "process.stdout.write(JSON.stringify(ENV_CONTRACT));\n";
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    cwd: API_DIR,
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV ?? "test" },
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`No se pudo cargar ENV_CONTRACT desde apps/api/src/lib/env.ts (tsx exit ${result.status}):\n${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

const REQUIRED_TAG = {
  always: "[REQ]",
  production: "[PROD]"
};

function requiredLabel(spec) {
  if (spec.tags?.includes("test")) return "[TEST]";
  if (spec.tags?.includes("fiscal-real")) return "[FISCAL-REAL]";
  if (spec.required === "always" || spec.required === "production") return REQUIRED_TAG[spec.required];
  if (spec.required && typeof spec.required === "object") return "[COND]";
  return "[OPT]";
}

function formatLabel(spec) {
  switch (spec.format) {
    case "enum":
      return `enum ${spec.values.join("|")}`;
    case "int": {
      const bounds = [];
      if (spec.min !== undefined) bounds.push(`≥${spec.min}`);
      if (spec.max !== undefined) bounds.push(`≤${spec.max}`);
      return bounds.length ? `entero ${bounds.join(" ")}` : "entero";
    }
    case "bool":
      return "true|false";
    case "url":
      return spec.origin ? "origen http(s)://host[:puerto], sin barra final" : "URL http(s)";
    case "postgres-url":
      return "postgresql://usuario:clave@host:5432/bd";
    case "base64-32":
      return "base64 que decodifica a 32 bytes";
    case "nif":
      return "NIF/CIF español con letra de control";
    case "path":
      return "ruta de fichero legible por el proceso";
    case "origin-list":
      return "lista separada por comas de orígenes http(s)://host[:puerto]";
    default:
      return spec.minLength ? `texto, ≥${spec.minLength} caracteres` : "texto";
  }
}

function wrap(text, width = 78, prefix = "# ") {
  const words = text.split(/\s+/);
  const lines = [];
  let current = "";
  for (const word of words) {
    if ((current + " " + word).trim().length > width - prefix.length && current) {
      lines.push(prefix + current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(prefix + current);
  return lines;
}

/**
 * Render one example file. `production` renders the superset used by
 * deploy/.env.production.example: same sections, production values for the
 * flags, compose-only keys (DOMAIN, POSTGRES_*) prepended.
 */
export function renderExample(contract, { production }) {
  const out = [];
  const title = production
    ? "ehotelOS · entorno de PRODUCCIÓN (deploy/.env.production)"
    : "ehotelOS · entorno de desarrollo (.env en la raíz del monorepo)";
  out.push(`# ${title}`);
  out.push("#");
  out.push("# GENERADO por scripts/env-census.mjs a partir de apps/api/src/lib/env.ts");
  out.push("# (ENV_CONTRACT). No lo edites a mano: cambia el contrato y ejecuta");
  out.push("#   node scripts/env-census.mjs --write");
  out.push("# tests/env-contract.test.mjs falla si este fichero y el contrato divergen.");
  out.push("#");
  out.push("# Leyenda:");
  out.push("#   [REQ]         obligatoria siempre (el proceso no puede funcionar sin ella)");
  out.push("#   [PROD]        obligatoria con NODE_ENV=production (en dev solo avisa)");
  out.push("#   [OPT]         opcional, con valor por defecto seguro");
  out.push("#   [COND]        obligatoria cuando se cumple la condición indicada");
  out.push("#   [FISCAL-REAL] obligatoria al salir del modo sandbox de ese módulo fiscal");
  out.push("#   [TEST]        solo para tests automatizados; NUNCA en un despliegue accesible");
  out.push("# Cada clave indica su formato y, para secretos, cómo generarla. Ningún valor");
  out.push("# de ejemplo es un secreto real: los secretos van vacíos y hay que generarlos.");
  out.push("#");
  if (production) {
    out.push("# Uso:");
    out.push("#   cp deploy/.env.production.example deploy/.env.production");
    out.push("#   node scripts/validate-env.mjs deploy/.env.production --role production-compose");
    out.push("#   docker compose -f deploy/docker-compose.production.yml --env-file deploy/.env.production up -d");
    out.push("# Desde la Tanda 4 los servicios api y worker cargan este fichero completo con");
    out.push("# env_file: TODA clave definida aquí llega al contenedor. El compose solo");
    out.push("# sobreescribe lo que calcula (NODE_ENV, PORT, DATABASE_URL, REDIS_URL,");
    out.push("# TRUST_PROXY y RUN_SCHEDULERS=false en el worker). Los certificados fiscales");
    out.push("# se montan desde deploy/certs en /certs (solo lectura): usa rutas /certs/...");
    out.push("#");
    out.push("# HOTELOS_ALLOW_DEMO_AUTH está PROHIBIDA aquí: con NODE_ENV=production el API se");
    out.push("# niega a arrancar (AUTH-04) y validate-env rechaza el fichero.");
    out.push("");
    out.push("# ---- Solo compose (interpoladas por docker-compose.production.yml) ----------");
    out.push("# [PROD] Hostname al que apunta el registro DNS A; Caddy emite el certificado.");
    out.push("DOMAIN=app.example.com");
    out.push("# [PROD] URL base que llama el SPA (VITE_API_URL en el build de admin-web).");
    out.push("# Caddy sirve el API bajo /api en el mismo origen: https://$DOMAIN/api.");
    out.push("PUBLIC_API_URL=https://app.example.com/api");
    out.push("# Rol y base de datos creados en el primer arranque del contenedor postgres;");
    out.push("# el compose ensambla DATABASE_URL a partir de estos tres valores.");
    out.push("POSTGRES_USER=hotelos");
    out.push("POSTGRES_DB=hotelos");
    out.push("# [PROD] generar: openssl rand -base64 32");
    out.push("POSTGRES_PASSWORD=");
  } else {
    out.push("# Uso: cp .env.example .env && node scripts/validate-env.mjs .env");
    out.push("# El API y el worker cargan .env solo como valores por defecto: una variable ya");
    out.push("# definida en el entorno del proceso (compose, systemd, CI) siempre gana.");
  }

  const sections = new Map();
  for (const [name, spec] of Object.entries(contract)) {
    if (!sections.has(spec.section)) sections.set(spec.section, []);
    sections.get(spec.section).push([name, spec]);
  }

  for (const [section, entries] of sections) {
    out.push("");
    out.push(`# ==== ${section} ${"=".repeat(Math.max(4, 74 - section.length))}`);
    for (const [name, spec] of entries) {
      if (production && spec.tags?.includes("dev-only")) continue;
      const lines = [];
      lines.push(...wrap(`${requiredLabel(spec)} ${spec.doc}`));
      const meta = [`formato: ${formatLabel(spec)}`];
      if (spec.default !== undefined && spec.default !== "") meta.push(`por defecto: ${spec.default}`);
      if (spec.required && typeof spec.required === "object") meta.push(`obligatoria si: ${spec.required.when}`);
      if (spec.generate) meta.push(`generar: ${spec.generate}`);
      lines.push(...wrap(meta.join(" · ")));
      const value = production ? (spec.productionExample ?? spec.example ?? "") : (spec.example ?? "");
      const mandatory = spec.required === "always" || (production && spec.required === "production");
      // Active line only when there is a value to ship or the key is mandatory.
      // Every other key stays commented: the .env loaders keep "" verbatim and
      // readers use `??`, so `PORT=` would mean port 0 and `*_INTERVAL_MS=` a
      // 0 ms scheduler loop.
      const commented =
        spec.tags?.includes("dangerous") ||
        (production && spec.tags?.includes("test")) ||
        (production && spec.productionForbidden === "true") ||
        (!mandatory && value === "");
      lines.push(`${commented ? "# " : ""}${name}=${value}`);
      out.push(...lines);
    }
  }
  out.push("");
  return out.join("\n");
}

function buildContractJson(contract, census) {
  const variables = {};
  for (const name of Object.keys(contract).sort()) {
    const spec = contract[name];
    variables[name] = { ...spec, readBy: [...(census.get(name) ?? [])].sort() };
  }
  return JSON.stringify(
    {
      $comment: "GENERADO por scripts/env-census.mjs desde apps/api/src/lib/env.ts (ENV_CONTRACT). No editar a mano.",
      sections: [...new Set(Object.values(contract).map((spec) => spec.section))],
      variables
    },
    null,
    2
  ) + "\n";
}

function main() {
  const args = new Set(process.argv.slice(2));
  const asJson = args.has("--json");
  const write = args.has("--write");
  const listOnly = args.has("--list");

  const census = collectCensus();
  if (listOnly) {
    const names = [...census.keys()].sort();
    if (asJson) {
      process.stdout.write(JSON.stringify(Object.fromEntries(names.map((n) => [n, [...census.get(n)].sort()])), null, 2) + "\n");
    } else {
      for (const name of names) console.log(`${name}\t${[...census.get(name)].sort().join(" ")}`);
      console.log(`\n${names.length} variables leídas por el código.`);
    }
    return 0;
  }

  const contract = loadContract();
  const undocumented = [...census.keys()].filter((name) => !(name in contract)).sort();
  const unread = Object.keys(contract).filter((name) => !census.has(name)).sort();

  const generated = {
    [CONTRACT_JSON]: buildContractJson(contract, census),
    [EXAMPLE_DEV]: renderExample(contract, { production: false }),
    [EXAMPLE_PROD]: renderExample(contract, { production: true })
  };
  const stale = Object.entries(generated)
    .filter(([path, content]) => !existsSync(path) || readFileSync(path, "utf8") !== content)
    .map(([path]) => relative(ROOT, path));

  if (write) {
    for (const [path, content] of Object.entries(generated)) writeFileSync(path, content);
  }

  const report = {
    variablesRead: census.size,
    variablesDocumented: Object.keys(contract).length,
    undocumented: undocumented.map((name) => ({ name, readBy: [...census.get(name)].sort() })),
    documentedButUnread: unread,
    stale,
    written: write ? Object.keys(generated).map((p) => relative(ROOT, p)) : []
  };
  const ok = undocumented.length === 0 && (write || stale.length === 0);

  if (asJson) {
    process.stdout.write(JSON.stringify({ ok, ...report }, null, 2) + "\n");
  } else {
    console.log(`Censo: ${report.variablesRead} variables leídas por el código · ${report.variablesDocumented} documentadas en ENV_CONTRACT.`);
    if (undocumented.length) {
      console.error(`ERROR: ${undocumented.length} variable(s) leídas por el código que el contrato no documenta (añádelas a ENV_CONTRACT en apps/api/src/lib/env.ts):`);
      for (const entry of report.undocumented) console.error(`  - ${entry.name}  ← ${entry.readBy.join(", ")}`);
    }
    if (unread.length) {
      console.warn(`AVISO: ${unread.length} variable(s) documentadas que ningún código lee (¿variable muerta?): ${unread.join(", ")}`);
    }
    if (write) {
      console.log(`Escritos: ${report.written.join(", ")}`);
    } else if (stale.length) {
      console.error(`ERROR: ficheros generados desactualizados: ${stale.join(", ")}. Ejecuta: node scripts/env-census.mjs --write`);
    } else {
      console.log("Ficheros generados en sincronía con el contrato.");
    }
  }
  return ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`FALLO inesperado del censo: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
