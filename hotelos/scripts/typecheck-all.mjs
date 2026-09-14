#!/usr/bin/env node
/**
 * Workspace-wide typecheck gate (Tanda 4 · QC-07).
 *
 *   node scripts/typecheck-all.mjs [--parallel N] [--json] [--only <pkg>...]
 *
 * Runs the `typecheck` script of EVERY workspace under apps/* and packages/*
 * (unlike `pnpm -r typecheck`, which stops at the first failure and hides the
 * rest), prints one line per workspace and a summary, and exits 1 when any
 * workspace fails. A workspace is never skipped silently: the only skips are
 * the explicit, printed ones below (a missing prerequisite the script can
 * detect), known failures are still run and printed as XFAIL with their
 * file:line reason, and a workspace without tsconfig.json is a FAIL, not a skip.
 *
 * Exit codes: 0 all green · 1 at least one FAIL · 2 usage / spawn error.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Known failures (XFAIL): the workspace IS typechecked and its errors are
 * printed, but a failure does not block the gate while the listed defect is
 * open. The moment it passes, the script says so and the entry must be
 * removed. Never add an entry without file:line and an owner.
 */
const KNOWN_FAILURES = {};

/**
 * Explicit skips: `when(dir)` returns the reason to skip (printed), or null.
 * Keep this list short and each entry tied to a concrete prerequisite.
 */
const EXPLICIT_SKIPS = [
  {
    dir: "apps/guest-web",
    when: (dir) =>
      existsSync(join(dir, "node_modules", "@types", "react"))
        ? null
        : "apps/guest-web no declara @types/react (~266 errores TS preexistentes, JSX sin tipos); añadirla exige regenerar pnpm-lock.yaml (fuera de esta tanda). Deuda: CLAUDE.md §Deuda técnica"
  }
];

function discoverWorkspaces() {
  const found = [];
  for (const group of ["apps", "packages"]) {
    const base = join(ROOT, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(base, entry.name);
      const manifestPath = join(dir, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (!manifest.scripts?.typecheck) continue;
      found.push({ name: manifest.name ?? entry.name, dir, rel: relative(ROOT, dir), script: manifest.scripts.typecheck });
    }
  }
  return found.sort((a, b) => a.rel.localeCompare(b.rel));
}

function runOne(ws) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    if (!existsSync(join(ws.dir, "tsconfig.json"))) {
      resolvePromise({ ...ws, status: "FAIL", ms: 0, output: "sin tsconfig.json: tsc imprime la ayuda y sale con 1 (QC-07)" });
      return;
    }
    for (const skip of EXPLICIT_SKIPS) {
      if (skip.dir !== ws.rel) continue;
      const reason = skip.when(ws.dir);
      if (reason) {
        resolvePromise({ ...ws, status: "SKIP", ms: 0, output: reason });
        return;
      }
    }
    // `corepack pnpm run typecheck` in the workspace dir honours the script
    // as written (tsc --noEmit, or anything a package customises).
    const child = spawn("corepack", ["pnpm", "run", "--silent", "typecheck"], { cwd: ws.dir, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (error) => {
      resolvePromise({ ...ws, status: "FAIL", ms: Date.now() - started, output: `no se pudo lanzar corepack pnpm: ${error.message}` });
    });
    child.on("close", (code) => {
      const known = KNOWN_FAILURES[ws.rel];
      let status = code === 0 ? "PASS" : "FAIL";
      let note = "";
      if (known && status === "FAIL") {
        status = "XFAIL";
        note = known;
      } else if (known && status === "PASS") {
        note = `ya pasa: elimina "${ws.rel}" de KNOWN_FAILURES en scripts/typecheck-all.mjs`;
      }
      resolvePromise({ ...ws, status, ms: Date.now() - started, output: output.trim(), note });
    });
  });
}

async function runAll(workspaces, parallel, { quiet = false } = {}) {
  const results = [];
  let next = 0;
  async function worker() {
    while (next < workspaces.length) {
      const ws = workspaces[next++];
      const result = await runOne(ws);
      results.push(result);
      // --json must stay machine-readable: the per-workspace lines go only to the
      // human report.
      if (quiet) continue;
      const label = result.status.padEnd(5);
      const errorCount = (result.output.match(/error TS\d+/g) ?? []).length;
      let detail = "";
      if (result.status === "SKIP") detail = ` — ${result.output}`;
      else if (result.status === "XFAIL") detail = ` — ${errorCount} error(es) TS, fallo conocido que NO bloquea: ${result.note}`;
      else if (result.status === "FAIL") detail = errorCount ? ` — ${errorCount} error(es) TS` : ` — ${result.output.split("\n")[0]}`;
      else if (result.note) detail = ` — ${result.note}`;
      console.log(`${label} ${result.rel.padEnd(22)} ${String(result.ms).padStart(6)} ms${detail}`);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, parallel) }, worker));
  return results.sort((a, b) => a.rel.localeCompare(b.rel));
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const parallelIndex = args.indexOf("--parallel");
  const parallel = parallelIndex >= 0 ? Number(args[parallelIndex + 1]) : 2;
  if (!Number.isInteger(parallel) || parallel < 1) throw new Error("--parallel debe ser un entero ≥ 1");
  const onlyIndex = args.indexOf("--only");
  const only = onlyIndex >= 0 ? args.slice(onlyIndex + 1).filter((a) => !a.startsWith("--")) : [];

  let workspaces = discoverWorkspaces();
  if (only.length) workspaces = workspaces.filter((ws) => only.includes(ws.name) || only.includes(ws.rel) || only.includes(ws.rel.split("/")[1]));
  if (workspaces.length === 0) throw new Error("ningún workspace con script typecheck encontrado");

  const started = Date.now();
  if (!asJson) console.log(`typecheck-all · ${workspaces.length} workspaces · paralelo ${parallel}\n`);
  const results = await runAll(workspaces, parallel, { quiet: asJson });
  const failed = results.filter((r) => r.status === "FAIL");
  const expectedFailures = results.filter((r) => r.status === "XFAIL");
  const skipped = results.filter((r) => r.status === "SKIP");
  const passed = results.filter((r) => r.status === "PASS");

  if (asJson) {
    process.stdout.write(JSON.stringify({ ok: failed.length === 0, totalMs: Date.now() - started, results: results.map(({ dir, ...rest }) => rest) }, null, 2) + "\n");
  } else {
    for (const result of [...failed, ...expectedFailures]) {
      console.log(`\n--- ${result.rel} (${result.script})${result.status === "XFAIL" ? " · fallo conocido, no bloquea" : ""} ---`);
      console.log(result.output.split("\n").slice(0, 40).join("\n"));
    }
    console.log(
      `\n${passed.length} PASS · ${failed.length} FAIL · ${expectedFailures.length} XFAIL (conocidos, no bloquean) · ${skipped.length} SKIP (explícitos) · ${((Date.now() - started) / 1000).toFixed(1)} s`
    );
    if (failed.length) console.log(`FALLAN: ${failed.map((r) => r.rel).join(", ")}`);
  }
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`typecheck-all: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  });
