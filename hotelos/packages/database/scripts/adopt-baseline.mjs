#!/usr/bin/env node
// Baseline adoption (Tanda 4 · DATA-01 · squash of the migration chain).
//
// Marks the squashed baseline migration as APPLIED in `_prisma_migrations` on a
// database whose schema was created BEFORE the squash (demo Mac, VPS, restored
// dumps: built with `prisma db push` or with the archived 2026-05/06 chain), so
// that `prisma migrate deploy` skips the baseline instead of re-running it and
// failing on the first statement (`CREATE TYPE "RoomStatus"` → 42710 → P3009 on
// every later attempt).
//
// Equivalent to `prisma migrate resolve --applied <baseline>` plus the cleanup
// of stale history rows (archived migration names, failed or rolled-back
// attempts), done with @prisma/client only — no psql, no Prisma CLI — so it
// runs inside the api container and on any host with a generated client.
//
// Behaviour (idempotent):
//   empty database (0 tables, 0 enums) . no-op: `migrate deploy` applies the baseline
//   baseline row already applied ....... no-op
//   tables present, no clean row ....... DELETE stale rows + INSERT the baseline row
//   tables/columns missing vs baseline . refuse (exit 1): align the schema first
//
// Usage (from packages/database; DATABASE_URL in the environment or ../../.env):
//   pnpm db:adopt-baseline                # dry-run (default): report the plan, write nothing
//   pnpm db:adopt-baseline -- --apply     # write
//   pnpm db:adopt-baseline -- --json      # machine-readable output
//
// Exit codes: 0 ok / nothing to do · 1 failure (DB unreachable, schema does not
// match the baseline, Prisma client not generated) · 2 unknown flag.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BASELINE_NAME = "20260914000000_baseline_squash";
const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../prisma/migrations");
const MIGRATION_DIR_RE = /^\d{14}_/;

// Exact DDL Prisma uses for its history table on PostgreSQL (schema-engine,
// unchanged since Prisma 2.x). Only needed when the table does not exist yet.
// The row inserted below mirrors `prisma migrate resolve --applied` byte for
// byte (verified against Prisma 6.19.3): sha256 checksum of migration.sql,
// logs = '', applied_steps_count = 0, started_at = finished_at.
const HISTORY_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
  "id" VARCHAR(36) PRIMARY KEY NOT NULL,
  "checksum" VARCHAR(64) NOT NULL,
  "finished_at" TIMESTAMPTZ,
  "migration_name" VARCHAR(255) NOT NULL,
  "logs" TEXT,
  "rolled_back_at" TIMESTAMPTZ,
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "applied_steps_count" INTEGER NOT NULL DEFAULT 0
)`;

export function parseFlags(argv) {
  const flags = { apply: false, json: false, help: false };
  for (const arg of argv) {
    if (arg === "--apply") flags.apply = true;
    else if (arg === "--dry-run") flags.apply = false;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--") continue;
    else throw new Error(`Flag desconocido "${arg}". Conocidos: --apply, --dry-run, --json, --help.`);
  }
  return flags;
}

function usage() {
  return [
    "Uso: node scripts/adopt-baseline.mjs [--apply] [--json]",
    "",
    "Registra la baseline " + BASELINE_NAME + " como aplicada en _prisma_migrations",
    "(sin ejecutarla) en una BD cuyo esquema ya existe. Por defecto solo informa;",
    "con --apply escribe. Idempotente: en BD vacía o ya adoptada no hace nada."
  ].join("\n");
}

// Parses the CREATE TABLE / CREATE TYPE statements of a Prisma-generated
// migration.sql into { tables: Map<table, column[]>, enums: string[] }.
export function parseBaselineSql(sql) {
  const tables = new Map();
  const enums = [];
  let current = null;
  for (const rawLine of sql.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const table = /^CREATE TABLE "([^"]+)" \($/.exec(line);
    if (table) {
      current = table[1];
      tables.set(current, []);
      continue;
    }
    const enumType = /^CREATE TYPE "([^"]+)" AS ENUM/.exec(line);
    if (enumType) enums.push(enumType[1]);
    if (current === null) continue;
    if (/^\);/.test(line)) {
      current = null;
      continue;
    }
    const column = /^\s+"([^"]+)"\s/.exec(line);
    if (column && !/^\s+CONSTRAINT\s/.test(line)) tables.get(current).push(column[1]);
  }
  return { tables, enums };
}

export function checksumOf(sql) {
  return createHash("sha256").update(sql).digest("hex");
}

function localMigrations() {
  if (!existsSync(MIGRATIONS_DIR)) throw new Error(`No existe el directorio de migraciones ${MIGRATIONS_DIR}.`);
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && MIGRATION_DIR_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function describeDatabase(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.port ? ":" + parsed.port : ""}${parsed.pathname}`;
  } catch {
    return "(DATABASE_URL ilegible)";
  }
}

async function connect() {
  let PrismaClient;
  try {
    ({ PrismaClient } = await import("@prisma/client"));
  } catch (error) {
    throw new Error(`No se pudo cargar @prisma/client: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const prisma = new PrismaClient({ log: [] });
    await prisma.$queryRawUnsafe("SELECT 1");
    return prisma;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/did not initialize yet|prisma generate/i.test(message)) {
      throw new Error("El cliente Prisma no está generado: ejecuta `pnpm db:generate` antes de adoptar la baseline.");
    }
    throw new Error(`No se pudo conectar a la base de datos (${describeDatabase(process.env.DATABASE_URL ?? "")}): ${message}`);
  }
}

export async function inspect(prisma, baseline) {
  const tableRows = await prisma.$queryRawUnsafe(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
  );
  const columnRows = await prisma.$queryRawUnsafe(
    `SELECT c.table_name, c.column_name FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.table_name <> '_prisma_migrations'`
  );
  const enumRows = await prisma.$queryRawUnsafe(
    `SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typtype = 'e'`
  );
  const [{ present: historyTable }] = await prisma.$queryRawUnsafe(
    `SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS present`
  );
  const history = historyTable
    ? await prisma.$queryRawUnsafe(
        `SELECT id, migration_name, checksum, finished_at, rolled_back_at, applied_steps_count FROM "_prisma_migrations" ORDER BY started_at, migration_name`
      )
    : [];

  const dbTables = new Set(tableRows.map((r) => r.table_name).filter((name) => name !== "_prisma_migrations"));
  const dbColumns = new Set(columnRows.map((r) => `${r.table_name}.${r.column_name}`));
  const dbEnums = new Set(enumRows.map((r) => r.typname));

  const missingTables = [...baseline.tables.keys()].filter((t) => !dbTables.has(t));
  const missingColumns = [];
  for (const [table, columns] of baseline.tables) {
    if (!dbTables.has(table)) continue;
    for (const column of columns) if (!dbColumns.has(`${table}.${column}`)) missingColumns.push(`${table}.${column}`);
  }
  const missingEnums = baseline.enums.filter((e) => !dbEnums.has(e));
  const extraTables = [...dbTables].filter((t) => !baseline.tables.has(t)).sort();

  const isClean = (row) => row.migration_name === BASELINE_NAME && row.finished_at !== null && row.rolled_back_at === null;
  const cleanBaselineRows = history.filter(isClean);
  // Finanzas integration (2026-09-16): the versioned migrations that FOLLOW the
  // baseline (prisma/migrations/<timestamp>_<name>, applied and not rolled
  // back) are legitimate history, never stale — before, a freshly `migrate
  // deploy`ed DB with 5 migrations reported "adopted-with-stale-rows" and
  // `--apply` would have DELETED the rows of the real migrations.
  const versionedMigrations = new Set(
    existsSync(MIGRATIONS_DIR) ? readdirSync(MIGRATIONS_DIR).filter((name) => MIGRATION_DIR_RE.test(name) && name !== BASELINE_NAME) : []
  );
  const isVersioned = (row) => versionedMigrations.has(row.migration_name) && row.finished_at !== null && row.rolled_back_at === null;
  // Keep exactly one clean baseline row (the oldest) plus the versioned
  // migrations; everything else (archived names, failed or duplicated rows) is stale.
  const staleRows = history.filter((row) => !isVersioned(row) && (!isClean(row) || row.id !== cleanBaselineRows[0]?.id));

  return {
    tables: dbTables.size,
    columns: dbColumns.size,
    enums: dbEnums.size,
    historyTable,
    history: history.map((row) => ({
      id: row.id,
      migrationName: row.migration_name,
      checksum: row.checksum,
      finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
      rolledBackAt: row.rolled_back_at ? new Date(row.rolled_back_at).toISOString() : null,
      appliedStepsCount: row.applied_steps_count
    })),
    baselineApplied: cleanBaselineRows.length > 0,
    staleRows: staleRows.map((row) => ({ id: row.id, migrationName: row.migration_name, finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null })),
    missingTables,
    missingColumns,
    missingEnums,
    extraTables
  };
}

export async function run(flags) {
  const start = Date.now();
  const migrations = localMigrations();
  if (!migrations.includes(BASELINE_NAME)) {
    throw new Error(`No existe prisma/migrations/${BASELINE_NAME}/: la baseline no está en el árbol (¿checkout incompleto?).`);
  }
  const baselinePath = join(MIGRATIONS_DIR, BASELINE_NAME, "migration.sql");
  const baselineSql = readFileSync(baselinePath, "utf8");
  const baseline = parseBaselineSql(baselineSql);
  const checksum = checksumOf(baselineSql);
  if (baseline.tables.size === 0) throw new Error(`${baselinePath} no contiene ningún CREATE TABLE: fichero corrupto.`);

  const prisma = await connect();
  try {
    const db = await inspect(prisma, baseline);
    const summary = {
      dryRun: !flags.apply,
      applied: false,
      state: "unknown",
      baseline: { name: BASELINE_NAME, checksum, tables: baseline.tables.size, enums: baseline.enums.length },
      localMigrations: migrations,
      pendingAfterAdoption: migrations.filter((name) => name !== BASELINE_NAME),
      database: { target: describeDatabase(process.env.DATABASE_URL ?? ""), tables: db.tables, columns: db.columns, enums: db.enums, historyTable: db.historyTable },
      history: db.history,
      staleRows: db.staleRows,
      check: { missingTables: db.missingTables, missingColumns: db.missingColumns, missingEnums: db.missingEnums, extraTables: db.extraTables },
      actions: [],
      durationMs: 0
    };

    if (db.tables === 0 && db.enums === 0) {
      if (db.history.length === 0) {
        summary.state = "empty";
        summary.actions.push("BD vacía: nada que adoptar; `prisma migrate deploy` aplicará la baseline.");
      } else {
        // Empty schema with leftover history rows (an aborted deploy on an empty
        // DB, or a dump restored without its data): clear them so deploy can run.
        summary.state = "empty-with-stale-history";
        summary.actions.push(`Borrar ${db.history.length} fila(s) de _prisma_migrations sin esquema detrás.`);
        if (flags.apply) {
          await prisma.$executeRawUnsafe(`DELETE FROM "_prisma_migrations"`);
          summary.applied = true;
        }
      }
      summary.durationMs = Date.now() - start;
      return summary;
    }

    if (db.tables === 0 && db.enums > 0) {
      summary.state = "partial";
      throw new ExitError(
        `La BD no tiene tablas pero sí ${db.enums} tipo(s) enum: restos de una migración fallida. Recrea la BD (dropdb/createdb) y ejecuta \`prisma migrate deploy\`.`,
        summary
      );
    }

    if (db.missingTables.length > 0 || db.missingColumns.length > 0 || db.missingEnums.length > 0) {
      summary.state = "schema-mismatch";
      const detail = [
        db.missingTables.length ? `${db.missingTables.length} tabla(s): ${db.missingTables.slice(0, 5).join(", ")}${db.missingTables.length > 5 ? "…" : ""}` : null,
        db.missingColumns.length ? `${db.missingColumns.length} columna(s): ${db.missingColumns.slice(0, 5).join(", ")}${db.missingColumns.length > 5 ? "…" : ""}` : null,
        db.missingEnums.length ? `${db.missingEnums.length} enum(s): ${db.missingEnums.join(", ")}` : null
      ].filter(Boolean).join("; ");
      throw new ExitError(
        `La BD no contiene todo lo que crea la baseline (faltan ${detail}). Alinea el esquema antes de adoptar (en local: \`pnpm db:push\`; en un entorno serio: restaura un dump alineado o recrea la BD con \`migrate deploy\`) y comprueba \`pnpm db:drift:check\` = 0.`,
        summary
      );
    }

    if (db.baselineApplied && db.staleRows.length === 0) {
      summary.state = "adopted";
      summary.actions.push("La baseline ya está registrada como aplicada; nada que hacer.");
      summary.durationMs = Date.now() - start;
      return summary;
    }

    summary.state = db.baselineApplied ? "adopted-with-stale-rows" : "needs-adoption";
    if (!db.historyTable) summary.actions.push('Crear la tabla "_prisma_migrations".');
    for (const row of db.staleRows) {
      summary.actions.push(`Borrar fila ${row.migrationName}${row.finishedAt ? "" : " (fallida/incompleta)"} [${row.id}].`);
    }
    if (!db.baselineApplied) summary.actions.push(`Insertar ${BASELINE_NAME} como aplicada (checksum ${checksum.slice(0, 12)}…).`);
    if (db.extraTables.length > 0) {
      summary.actions.push(`Aviso: ${db.extraTables.length} tabla(s) en public que la baseline no crea (${db.extraTables.slice(0, 5).join(", ")}${db.extraTables.length > 5 ? "…" : ""}); \`pnpm db:drift:check\` las señalará.`);
    }

    if (flags.apply) {
      const writes = [];
      if (!db.historyTable) writes.push(prisma.$executeRawUnsafe(HISTORY_TABLE_DDL));
      for (const row of db.staleRows) writes.push(prisma.$executeRawUnsafe(`DELETE FROM "_prisma_migrations" WHERE id = $1`, row.id));
      if (!db.baselineApplied) {
        writes.push(
          prisma.$executeRawUnsafe(
            `INSERT INTO "_prisma_migrations" ("id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at", "started_at", "applied_steps_count")
             VALUES ($1, $2, now(), $3, '', NULL, now(), 0)`,
            randomUUID(),
            checksum,
            BASELINE_NAME
          )
        );
      }
      await prisma.$transaction(writes);
      const after = await inspect(prisma, baseline);
      if (!after.baselineApplied || after.staleRows.length > 0) {
        throw new ExitError("La adopción se ejecutó pero _prisma_migrations no quedó con una única fila limpia de la baseline; revisa la tabla a mano.", summary);
      }
      summary.applied = true;
      summary.history = after.history;
      summary.staleRows = [];
    }
    summary.durationMs = Date.now() - start;
    return summary;
  } finally {
    await prisma.$disconnect();
  }
}

class ExitError extends Error {
  constructor(message, summary) {
    super(message);
    this.summary = summary;
  }
}

function printHuman(summary) {
  const mode = summary.dryRun ? "DRY-RUN (sin escribir; usa --apply)" : summary.applied ? "APLICADO" : "SIN CAMBIOS";
  console.log(`adopt-baseline · ${summary.database.target} · ${mode}`);
  console.log(`  baseline local: ${summary.baseline.name} (${summary.baseline.tables} tablas, checksum ${summary.baseline.checksum.slice(0, 12)}…)`);
  console.log(`  BD: ${summary.database.tables} tablas, ${summary.database.columns} columnas, ${summary.database.enums} enums, _prisma_migrations ${summary.database.historyTable ? `presente (${summary.history.length} filas)` : "ausente"}`);
  console.log(`  estado: ${summary.state}`);
  for (const action of summary.actions) console.log(`  - ${action}`);
  if (summary.pendingAfterAdoption.length > 0) {
    console.log(`  migraciones posteriores a la baseline que aplicará \`migrate deploy\`: ${summary.pendingAfterAdoption.join(", ")}`);
  }
  console.log(`  siguiente paso: pnpm --filter @hotelos/database db:migrate:deploy && pnpm db:drift:check`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let flags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exit(2);
  }
  if (flags.help) {
    console.log(usage());
    process.exit(0);
  }
  try {
    const summary = await run(flags);
    if (flags.json) console.log(JSON.stringify(summary, null, 2));
    else printHuman(summary);
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (flags.json) {
      console.log(JSON.stringify({ ok: false, error: message, summary: error instanceof ExitError ? error.summary : null }, null, 2));
    } else {
      console.error(`adopt-baseline: ${message}`);
    }
    process.exit(1);
  }
}
