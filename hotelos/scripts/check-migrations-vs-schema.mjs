#!/usr/bin/env node
// Migrations-vs-schema check WITHOUT a database (Tanda 4 · DATA-01).
//
// Replays the CREATE/DROP TABLE and CREATE/DROP TYPE statements of every folder
// under packages/database/prisma/migrations and compares the resulting table
// and enum sets with the models (@@map) and enums declared in schema.prisma.
// It catches the failure this repo lived with for months — a model added to
// the schema (or applied with `db push`) with no migration behind it — in a
// plain contract test or CI job. It is a structural check only: column-level
// drift is what `pnpm db:drift:check` (needs a migrated database) is for.
//
// Usage (from the monorepo root):
//   pnpm db:migrations:check            # or: node scripts/check-migrations-vs-schema.mjs
//   node scripts/check-migrations-vs-schema.mjs --json
//
// Exit codes: 0 in sync · 1 mismatch (or unreadable files) · 2 unknown flag.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_PATH = join(ROOT, "packages/database/prisma/schema.prisma");
const MIGRATIONS_DIR = join(ROOT, "packages/database/prisma/migrations");

export function parseFlags(argv) {
  const flags = { json: false, help: false };
  for (const arg of argv) {
    if (arg === "--json") flags.json = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--") continue;
    else throw new Error(`Flag desconocido "${arg}". Conocidos: --json, --help.`);
  }
  return flags;
}

// Table name of each model: @@map("x") when present, the model name otherwise.
export function parseSchema(source) {
  const tables = new Set();
  const enums = new Set();
  const modelRe = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  for (const match of source.matchAll(modelRe)) {
    const [, model, body] = match;
    const map = /@@map\("([^"]+)"\)/.exec(body);
    tables.add(map ? map[1] : model);
  }
  for (const match of source.matchAll(/^enum\s+(\w+)\s*\{/gm)) enums.add(match[1]);
  return { tables, enums };
}

// Net effect of the migration chain, in folder order.
export function replayMigrations(sqlByFolder) {
  const tables = new Set();
  const enums = new Set();
  for (const [, sql] of sqlByFolder) {
    for (const line of sql.split("\n")) {
      let m;
      if ((m = /^CREATE TABLE(?: IF NOT EXISTS)? "([^"]+)"/.exec(line))) tables.add(m[1]);
      else if ((m = /^DROP TABLE(?: IF EXISTS)? "([^"]+)"/.exec(line))) tables.delete(m[1]);
      else if ((m = /^ALTER TABLE "([^"]+)" RENAME TO "([^"]+)"/.exec(line))) { tables.delete(m[1]); tables.add(m[2]); }
      else if ((m = /^CREATE TYPE "([^"]+)" AS ENUM/.exec(line))) enums.add(m[1]);
      else if ((m = /^DROP TYPE(?: IF EXISTS)? "([^"]+)"/.exec(line))) enums.delete(m[1]);
      else if ((m = /^ALTER TYPE "([^"]+)" RENAME TO "([^"]+)"/.exec(line))) { enums.delete(m[1]); enums.add(m[2]); }
    }
  }
  return { tables, enums };
}

function diff(expected, actual) {
  return {
    missing: [...expected].filter((x) => !actual.has(x)).sort(),
    extra: [...actual].filter((x) => !expected.has(x)).sort()
  };
}

export function check() {
  if (!existsSync(SCHEMA_PATH)) throw new Error(`No existe ${SCHEMA_PATH}`);
  if (!existsSync(MIGRATIONS_DIR)) throw new Error(`No existe ${MIGRATIONS_DIR}`);
  const folders = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{14}_/.test(e.name))
    .map((e) => e.name)
    .sort();
  if (folders.length === 0) throw new Error("prisma/migrations no contiene ninguna carpeta de migración");
  const sqlByFolder = folders.map((folder) => {
    const file = join(MIGRATIONS_DIR, folder, "migration.sql");
    if (!existsSync(file)) throw new Error(`Falta ${file}`);
    return [folder, readFileSync(file, "utf8")];
  });
  const schema = parseSchema(readFileSync(SCHEMA_PATH, "utf8"));
  const chain = replayMigrations(sqlByFolder);
  const tables = diff(schema.tables, chain.tables);
  const enums = diff(schema.enums, chain.enums);
  const ok = tables.missing.length === 0 && tables.extra.length === 0 && enums.missing.length === 0 && enums.extra.length === 0;
  return {
    ok,
    migrations: folders,
    schema: { tables: schema.tables.size, enums: schema.enums.size },
    chain: { tables: chain.tables.size, enums: chain.enums.size },
    tables,
    enums
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let flags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  if (flags.help) {
    console.log("Uso: node scripts/check-migrations-vs-schema.mjs [--json]\nCompara tablas/enums creados por prisma/migrations con schema.prisma (sin BD).");
    process.exit(0);
  }
  try {
    const result = check();
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`migrations-vs-schema · ${result.migrations.length} migración/es · schema ${result.schema.tables} tablas / ${result.schema.enums} enums · cadena ${result.chain.tables} tablas / ${result.chain.enums} enums`);
      if (result.tables.missing.length) console.log(`  tablas del schema SIN migración: ${result.tables.missing.join(", ")}`);
      if (result.tables.extra.length) console.log(`  tablas creadas por migraciones que el schema NO tiene: ${result.tables.extra.join(", ")}`);
      if (result.enums.missing.length) console.log(`  enums del schema SIN migración: ${result.enums.missing.join(", ")}`);
      if (result.enums.extra.length) console.log(`  enums creados por migraciones que el schema NO tiene: ${result.enums.extra.join(", ")}`);
      console.log(result.ok ? "  OK: migraciones y schema en sincronía (nivel tabla/enum)." : "  ERROR: falta una migración (`prisma migrate dev --name <cambio>`) o sobra una tabla.");
    }
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    console.error(`migrations-vs-schema: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
