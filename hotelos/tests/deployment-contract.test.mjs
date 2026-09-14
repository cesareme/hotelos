import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Deployment readiness contract (Tanda 4 · instalabilidad). Static greps over
// the files that make a production install reproducible: root scripts, the env
// validator, the CI at the GIT ROOT (../../.github — GitHub only reads that
// path; the copies under hotelos/.github never ran), the tsx runtime decision,
// the deploy orchestrator, the native systemd/Caddy assets and the pnpm
// Dockerfiles. Every string pinned here is one the install docs rely on.

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
const exists = (relative) => existsSync(new URL(`../${relative}`, import.meta.url));
const json = (relative) => JSON.parse(read(relative));

describe("Deployment readiness contract", () => {
  it("has root scripts for env validation, backup rehearsal and versioned migrations", () => {
    const { scripts } = json("package.json");
    assert.equal(scripts["validate:env"], "node scripts/validate-env.mjs");
    assert.equal(scripts["backup:check"], "node scripts/backup-restore-check.mjs");
    for (const name of ["db:generate", "db:migrate:deploy", "db:adopt-baseline", "db:drift:check", "db:install:check"]) {
      assert.ok(scripts[name], `root package.json must define ${name}`);
    }
  });

  it("validates env files per deployment role (production-native is what the VPS install uses)", () => {
    const validator = read("scripts/validate-env.mjs");
    assert.match(validator, /production-native/);
    assert.match(validator, /HOTELOS_ALLOW_DEMO_AUTH/);
    assert.match(read("deploy/scripts/deploy.sh"), /validate-env\.mjs "\$ENV_FILE" --role/);
    assert.match(read("deploy/scripts/install-from-scratch.sh"), /--role production-native/);
  });

  it("runs the API and the worker with tsx as the official runtime (decision A)", () => {
    for (const app of ["apps/api/package.json", "apps/worker/package.json"]) {
      const pkg = json(app);
      // Decision (Tanda 4, final): tsx stays in devDependencies because moving
      // it would rewrite pnpm-lock.yaml; the deploy installs WITHOUT --prod
      // (pnpm install --frozen-lockfile in deploy.sh, systemd and the
      // Dockerfiles), so either section makes it available at runtime.
      assert.ok(pkg.dependencies?.tsx ?? pkg.devDependencies?.tsx, `${app}: tsx must be declared (dependencies or devDependencies; the deploy installs without --prod)`);
      assert.match(pkg.scripts.start, /^node --import tsx src\//, `${app}: start must be node --import tsx src/…`);
    }
    for (const unit of ["deploy/systemd/anfitorio-api.service", "deploy/systemd/anfitorio-worker.service"]) {
      const text = read(unit);
      assert.match(text, /node --import tsx src\//);
      assert.match(text, /EnvironmentFile=\/etc\/anfitorio\/api\.env/);
      assert.match(text, /User=anfitorio/);
    }
    assert.match(read("deploy/systemd/anfitorio-api.service"), /RUN_SCHEDULERS=true/);
    assert.match(read("deploy/systemd/anfitorio-worker.service"), /RUN_SCHEDULERS=false/);
  });

  it("deploys with migrate deploy behind adopt-baseline, never prisma db push", () => {
    const deploy = read("deploy/scripts/deploy.sh");
    assert.match(deploy, /db:adopt-baseline -- --apply/);
    assert.match(deploy, /db:migrate:deploy/);
    assert.match(deploy, /db:drift:check/);
    assert.match(deploy, /pnpm install --frozen-lockfile/);
    assert.match(deploy, /rbac:sync -- --dry-run/);
    assert.match(deploy, /smoke\.sh/);
    assert.doesNotMatch(deploy, /prisma db push/);
    assert.doesNotMatch(deploy, /\bnpm (install|ci|run)\b/);
    for (const script of ["deploy/scripts/install-from-scratch.sh", "deploy/scripts/smoke.sh", "deploy/scripts/vps-inventory.sh"]) {
      assert.ok(exists(script), `${script} must exist`);
    }
    const install = read("deploy/scripts/install-from-scratch.sh");
    assert.match(install, /corepack prepare "pnpm\$PNPM_VERSION" --activate|corepack prepare "pnpm@\$PNPM_VERSION" --activate/);
    assert.match(install, /--demo\|--real\|--adopt/);
    assert.doesNotMatch(install, /prisma db push/);
    const smoke = read("deploy/scripts/smoke.sh");
    assert.match(smoke, /\/auth\/login/);
    assert.match(smoke, /\/health/);
    assert.match(smoke, /401/);
    assert.match(smoke, /readiness/);
  });

  it("serves the SPA and /api from one origin with the native Caddyfile", () => {
    const caddy = read("deploy/caddy/Caddyfile.native");
    assert.match(caddy, /handle_path \/api\/\*/);
    assert.match(caddy, /reverse_proxy 127\.0\.0\.1:3000/);
    assert.match(caddy, /try_files \{path\} \/index\.html/);
    assert.match(caddy, /no-store/);
  });

  it("builds Docker images with corepack pnpm + tsx and no npm (single Dockerfile tree in deploy/)", () => {
    for (const file of ["deploy/Dockerfile.api", "deploy/Dockerfile.worker", "deploy/Dockerfile.admin-web"]) {
      const text = read(file);
      assert.match(text, /corepack prepare pnpm@9\.15\.0 --activate/, `${file}: pinned pnpm via corepack`);
      assert.match(text, /pnpm install --frozen-lockfile/, `${file}: frozen lockfile`);
      assert.doesNotMatch(text, /\bnpm (install|ci|prune)\b/, `${file}: no npm`);
      assert.doesNotMatch(text, /package-lock\.json/, `${file}: no package-lock.json`);
    }
    assert.match(read("deploy/Dockerfile.api"), /"node", "--import", "tsx", "src\/server\.ts"/);
    assert.match(read("deploy/Dockerfile.worker"), /"node", "--import", "tsx", "src\/index\.ts"/);
    assert.match(read("deploy/Dockerfile.admin-web"), /VITE_API_URL/);
    assert.equal(exists("infra/docker"), false, "infra/docker (npm Dockerfiles) was removed in Tanda 4");
    assert.equal(exists("infra/ci"), false, "infra/ci (npm ci workflow) was removed in Tanda 4");
  });

  it("has GitHub Actions CI at the git root, running inside hotelos/ on pnpm with migrate deploy", () => {
    const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
    assert.match(workflow, /pnpm\/action-setup/);
    assert.match(workflow, /working-directory: hotelos/);
    assert.match(workflow, /cache-dependency-path: hotelos\/pnpm-lock\.yaml/);
    assert.match(workflow, /pnpm install --frozen-lockfile/);
    assert.match(workflow, /pnpm validate:env/);
    assert.match(workflow, /pnpm test\b/);
    assert.match(workflow, /pnpm typecheck:all/);
    assert.match(workflow, /pnpm db:migrate:deploy/);
    assert.match(workflow, /pnpm db:drift:check/);
    assert.match(workflow, /fresh-install:/);
    assert.match(workflow, /deploy\/scripts\/smoke\.sh/);
    assert.match(workflow, /deploy\/Dockerfile\.api/);
    assert.match(workflow, /deploy\/Dockerfile\.worker/);
    assert.match(workflow, /deploy\/Dockerfile\.admin-web/);
    assert.doesNotMatch(workflow, /prisma db push/);
    assert.doesNotMatch(workflow, /infra\/docker/);
    const deploy = readFileSync(new URL("../../.github/workflows/deploy.yml", import.meta.url), "utf8");
    assert.match(deploy, /deploy\/scripts\/deploy\.sh --role production-native --pull --yes/);
    assert.match(deploy, /workflow_dispatch/);
  });

  it("every scripts/*.mjs parses (node --check)", () => {
    // A SyntaxError in a gate script (typecheck-all.mjs had one in Tanda 4)
    // fails every gate at once, so the parse itself is a contract.
    const root = fileURLToPath(new URL("..", import.meta.url));
    const dirs = ["scripts", "packages/database/scripts"];
    const files = dirs.flatMap((dir) => readdirSync(new URL(`../${dir}/`, import.meta.url)).filter((name) => name.endsWith(".mjs")).map((name) => `${dir}/${name}`));
    assert.ok(files.length >= 10, `expected the gate scripts under ${dirs.join(", ")}, found ${files.length}`);
    for (const file of files) {
      const result = spawnSync(process.execPath, ["--check", file], { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 0, `${file} does not parse:\n${result.stderr}`);
    }
  });

  it("deploy/scripts/smoke.sh accepts --property and its --property-id alias", () => {
    // Textual check of the getopts-style case (the script is never executed
    // here): the docs and CI pass --property, the deploy runbook --property-id.
    const smoke = read("deploy/scripts/smoke.sh");
    const start = smoke.indexOf('case "$1" in');
    const end = smoke.indexOf("esac", start);
    assert.ok(start >= 0 && end > start, "smoke.sh must parse its flags with a case \"$1\" in … esac block");
    const flags = smoke.slice(start, end);
    // A pattern label is `--flag)` or one alternative of `--a|--b)`.
    assert.match(flags, /(^|\|)\s*--property\s*(\||\))/m, "smoke.sh must handle --property in its case");
    assert.match(flags, /(^|\|)\s*--property-id\s*(\||\))/m, "smoke.sh must accept --property-id as an alias of --property");
  });

  it("documents the install in one place and marks the old playbooks as superseded", () => {
    assert.ok(exists("deploy/README-INSTALL.md"), "deploy/README-INSTALL.md must exist");
    const install = read("deploy/README-INSTALL.md");
    for (const needle of ["install-from-scratch.sh", "deploy.sh", "smoke.sh", "vps-inventory.sh", "db:adopt-baseline", "db:migrate:deploy", "/etc/anfitorio/api.env", "--frozen-lockfile"]) {
      assert.ok(install.includes(needle), `README-INSTALL.md must mention ${needle}`);
    }
    for (const legacy of ["deploy/README-HOSTINGER.md", "deploy/README-REMOTE-DEV.md", "docs/deploy-pilot.md", "docs/deployment.md"]) {
      const head = read(legacy).split("\n").slice(0, 12).join("\n");
      assert.match(head, /README-INSTALL\.md/, `${legacy} must point to deploy/README-INSTALL.md in its header`);
    }
  });
});
