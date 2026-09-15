// Contrato documental de Rate Grid v2 (cierre 2026-09-15).
//
// Por qué existe: la verificación adversarial encontró un runbook que contaba
// rutas, límites y estados que el código ya no tenía (y una ruta pública que
// perdió su entrada del manifiesto sin que nadie lo viera). Este test ata
// docs/runbooks/rate-grid-v2.md (y los dos documentos de conectividad) a la
// fuente de verdad: los tres route-permissions.partial.ts, las constantes de
// límites, las reglas del outbox y el contrato compartido. Mismo estilo que el
// resto de contract tests: readFileSync + node --test, sin BD ni servidor.
//
// Robustez: las comprobaciones normalizan espacios (los docs envuelven a 80
// columnas), parsean tablas por celdas (no por línea literal) y leen los
// valores del código en vez de fijarlos aquí, así que un cambio de formato
// razonable no rompe el test; un cambio de contenido sin actualizar los docs sí.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");
const api = (relative) => read(`../apps/api/src/${relative}`);

const runbook = read("../docs/runbooks/rate-grid-v2.md");
const connectivity = read("../docs/channel-manager-connectivity.md");
const bookingDoc = read("../docs/booking-adapter.md");
const claudeMd = read("../CLAUDE.md");
const closeReport = read("../docs/audits/RATE-GRID-V2-CIERRE-2026-09-15.md");
const designProposal = read("../docs/rate-manager/DESIGN-PROPOSAL.md");
const planMaestro = read("../docs/strategy/anfitorio-equipo-2026-06/PLAN-MAESTRO.md");

const schemas = api("modules/rate-manager/rate-grid.schemas.ts");
const engine = api("modules/rate-manager/rate-grid.engine.ts");
const rateGridService = api("modules/rate-manager/rate-grid.service.ts");
const journalService = api("modules/rate-manager/journal.service.ts");
const ratePlanService = api("modules/rate-manager/rate-plan.service.ts");
const rateGridRoutes = api("modules/rate-manager/rate-grid.routes.ts");
const bridge = api("modules/rate-manager/channel-outbox.bridge.ts");
const delivery = api("modules/channel-manager/delivery.service.ts");
const deliveryCore = api("modules/channel-manager/delivery.core.ts");
const drainCore = api("modules/channel-manager/drain.core.ts");
const drainService = api("modules/channel-manager/drain.service.ts");
const channelRoutes = api("modules/channel-manager/channel-manager.routes.ts");
const channelsService = api("modules/channel-manager/channels.service.ts");
const envPartial = api("modules/channel-manager/env.partial.ts");
const recommendationService = api("modules/revenue/rate-recommendation.service.ts");
const recommendationRoutes = api("modules/revenue/recommendations.routes.ts");
const authContext = api("lib/auth-context.ts");
const envTs = api("lib/env.ts");
const seedScript = api("scripts/seed-sandbox-channels.ts");
const sharedTypes = read("../packages/shared/src/rate-manager-types.ts");

const partialSources = {
  "rate-manager": api("modules/rate-manager/route-permissions.partial.ts"),
  revenue: api("modules/revenue/route-permissions.partial.ts"),
  "channel-manager": api("modules/channel-manager/route-permissions.partial.ts")
};

// ---------------------------------------------------------------- helpers

/** Collapse whitespace so 80-column wrapping in the docs does not matter. */
const flat = (text) => text.replace(/\s+/g, " ");

/** Text between two headings (start inclusive, end exclusive). */
function section(doc, startHeading, endHeading) {
  const start = doc.indexOf(startHeading);
  assert.ok(start >= 0, `heading not found: ${startHeading}`);
  const end = endHeading ? doc.indexOf(endHeading, start + startHeading.length) : -1;
  assert.ok(!endHeading || end > start, `heading not found after ${startHeading}: ${endHeading}`);
  return end > start ? doc.slice(start, end) : doc.slice(start);
}

/** Same rule as tests/api-route-permissions-contract: a commented-out entry is not an entry. */
function stripLineComments(source) {
  return source
    .split("\n")
    .map((line) => (line.trim().startsWith("//") ? "" : line))
    .join("\n");
}

const ENTRY_PATTERN = /\{\s*method:\s*"(GET|POST|PATCH|DELETE|PUT)"\s*,\s*path:\s*"([^"]+)"\s*,\s*permissions:\s*\[([^\]]*)\]\s*,\s*riskLevel:\s*"(\w+)"\s*\}/g;

function parsePartial(rawSource, name) {
  const source = stripLineComments(rawSource);
  const declaration = /export const \w+(?:: ApiRoutePermission\[\])? = \[/.exec(source);
  assert.ok(declaration, `${name}: permission array not found`);
  const end = source.indexOf("\n];", declaration.index);
  assert.ok(end > declaration.index, `${name}: permission array not closed`);
  const body = source.slice(declaration.index, end);
  return [...body.matchAll(ENTRY_PATTERN)].map((m) => ({
    method: m[1],
    path: m[2],
    permissions: m[3].replace(/"/g, "").split(",").map((s) => s.trim()).filter(Boolean).sort(),
    risk: m[4]
  }));
}

/** Markdown table rows (cells trimmed) of a text fragment. */
function tableRows(text) {
  return text
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("| ---") && !/^\| Ruta \|/.test(line) && !/^\| Operación \|/.test(line) && !/^\| Elemento \|/.test(line))
    .map((line) => line.replace(/^\|\s*/, "").replace(/\s*\|$/, "").split(/\s\|\s/).map((cell) => cell.trim()));
}

/** `NAME = 1_234` → 1234 (NaN when absent). */
function constant(source, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*([0-9_]+)`).exec(source);
  return match ? Number(match[1].replace(/_/g, "")) : NaN;
}

/** Spanish thousands formatting used by the runbook tables (5000 → "5.000"; Intl grouping in es-ES skips 4-digit numbers, so it is done by hand). */
const es = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");

/**
 * Values of a string-literal union: `type X = "a" | "b"`, `field: "a" | "b";`
 * or `field: Alias;` with `export type Alias = "a" | "b"` (the shared contract
 * moved pushStatus behind `RateJournalPushStatus`).
 */
function unionValues(source, label) {
  const literal = new RegExp(`${label}\\s*[:=]\\s*((?:"[^"]+"\\s*\\|\\s*)*"[^"]+")`).exec(source);
  if (literal) return [...literal[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const alias = new RegExp(`${label}\\s*[:=]\\s*([A-Z]\\w+)\\s*;`).exec(source);
  assert.ok(alias, `union not found for ${label}`);
  return unionValues(source, `export type ${alias[1]}`);
}

function stringArray(source, name) {
  const match = new RegExp(`${name}[^=]*=\\s*\\[([^\\]]*)\\]`).exec(source);
  assert.ok(match, `array not found: ${name}`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

const rateManagerEntries = parsePartial(partialSources["rate-manager"], "rate-manager");
const revenueEntries = parsePartial(partialSources.revenue, "revenue");
const channelEntries = parsePartial(partialSources["channel-manager"], "channel-manager");
const recommendationEntries = revenueEntries.filter((e) => e.path.includes("/rate-grid/"));

const routesSection = section(runbook, "### 2.1 Rutas, permisos y riesgo", "### 2.2");
const limitsSection = section(runbook, "## 4. Límites duros", "## 5.");
const contractSection = section(runbook, "### 1.1 Contrato", "### 1.2");
const closeSection = section(runbook, "## 6. Contrato acordado en el cierre");

// ---------------------------------------------------------------- tests

describe("Rate grid v2 · contrato documental (docs/runbooks/rate-grid-v2.md)", () => {
  it("§2.1 lists exactly the entries of the three route-permissions partials (method, path, permissions, risk)", () => {
    const expected = new Map();
    for (const entry of [...rateManagerEntries, ...recommendationEntries, ...channelEntries]) {
      expected.set(`${entry.method} ${entry.path}`, entry);
    }
    assert.ok(expected.size >= 30, `unexpectedly few partial entries: ${expected.size}`);

    const documented = new Map();
    for (const cells of tableRows(routesSection)) {
      assert.equal(cells.length, 3, `§2.1 row must have 3 cells: ${cells.join(" | ")}`);
      const [route, permissionCell, risk] = cells;
      const routeMatch = /^`(GET|POST|PATCH|DELETE|PUT) (\/\S+)`$/.exec(route);
      assert.ok(routeMatch, `§2.1 route cell not parseable: ${route}`);
      const permissions = permissionCell.startsWith("—") ? [] : [...permissionCell.matchAll(/`([^`]+)`/g)].map((m) => m[1]).sort();
      documented.set(`${routeMatch[1]} ${routeMatch[2]}`, { permissions, risk, isPublic: permissionCell.includes("público") });
    }

    for (const [key, entry] of expected) {
      const row = documented.get(key);
      assert.ok(row, `§2.1 is missing the partial entry ${key}`);
      assert.deepEqual(row.permissions, entry.permissions, `§2.1 permissions differ for ${key}`);
      assert.equal(row.risk, entry.risk, `§2.1 risk differs for ${key}`);
      if (entry.risk === "public") assert.ok(row.isPublic, `§2.1 must mark ${key} as público`);
    }
    for (const key of documented.keys()) {
      assert.ok(expected.has(key), `§2.1 documents a route no partial declares: ${key}`);
    }

    // The counts quoted next to each partial name follow the parsed arrays.
    const counted = (file) => {
      const match = new RegExp(`${file.replace(/[/.]/g, "\\$&")}\`,\\s*(\\d+)\\s+entradas`).exec(routesSection);
      assert.ok(match, `§2.1 must state the entry count of ${file}`);
      return Number(match[1]);
    };
    assert.equal(counted("rate-manager/route-permissions.partial.ts"), rateManagerEntries.length);
    assert.equal(counted("revenue/route-permissions.partial.ts"), recommendationEntries.length);
    assert.equal(counted("channel-manager/route-permissions.partial.ts"), channelEntries.length);
    // The demand-calendar entries of the revenue partial are mentioned as text, not as rows.
    for (const entry of revenueEntries.filter((e) => !e.path.includes("/rate-grid/"))) {
      assert.ok(flat(routesSection).includes(entry.path.replace(/\/:eventId$/, "")), `§2.1 must mention ${entry.path}`);
    }
  });

  it("public partial entries sit under PUBLIC_PREFIXES (auth hook) and the runbook says so", () => {
    const prefixes = stringArray(authContext, "const PUBLIC_PREFIXES");
    const publicEntries = channelEntries.filter((e) => e.risk === "public");
    assert.ok(publicEntries.length >= 2, "channel-manager must expose the webhook and the sandbox loopback as public");
    for (const entry of publicEntries) {
      assert.ok(prefixes.some((p) => entry.path.startsWith(p)), `${entry.path} is public in the partial but not under PUBLIC_PREFIXES`);
      assert.deepEqual(entry.permissions, [], `${entry.path} public entry must carry no permissions`);
    }
    assert.match(flat(routesSection), /PUBLIC_PREFIXES/);
  });

  it("§4 limits match the constants and zod bounds of the code", () => {
    const rowWith = (needle) => {
      const row = limitsSection.split("\n").find((line) => line.startsWith("| ") && line.includes(needle));
      assert.ok(row, `§4 has no row mentioning ${needle}`);
      return row;
    };
    const named = [
      ["MAX_GRID_DAYS", schemas],
      ["MAX_CELLS", schemas],
      ["MAX_OPS", schemas],
      ["MAX_PRICE", schemas],
      ["MAX_RANGE_DAYS", delivery],
      ["RECOMMENDATION_MAX_DAYS", recommendationService]
    ];
    for (const [name, source] of named) {
      const value = constant(source, name);
      assert.ok(Number.isFinite(value), `${name} not found in code`);
      assert.ok(rowWith(`\`${name}\``).includes(es(value)), `§4 row of ${name} must state ${es(value)}`);
    }
    const webhookBytes = constant(channelRoutes, "WEBHOOK_MAX_BYTES");
    assert.equal(webhookBytes % 1_048_576, 0, "WEBHOOK_MAX_BYTES is documented in MiB");
    assert.ok(rowWith("`WEBHOOK_MAX_BYTES`").includes(`${webhookBytes / 1_048_576} MiB`));
    assert.ok(rowWith("`WEBHOOK_MAX_BYTES`").includes("413"));

    // Anchored on drainSchema: the deliveries list schema also caps `limit` (500) a few lines above.
    const drainMax = /const drainSchema = z\.object\(\{[^\n]*limit: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(([\d_]+)\)/.exec(channelRoutes);
    assert.ok(drainMax, "drain limit bound not found in channel-manager.routes.ts");
    assert.ok(rowWith("deliveries/drain").includes(es(Number(drainMax[1].replace(/_/g, "")))));

    const listLimit = /input\.limit \?\? (\d+), 1\), (\d+)\)/.exec(delivery);
    assert.ok(listLimit, "listDeliveries limit clamp not found");
    const deliveriesRow = rowWith("`GET /channel-manager/deliveries`");
    assert.ok(deliveriesRow.includes(listLimit[1]) && deliveriesRow.includes(listLimit[2]), "§4 deliveries limits must match listDeliveries");

    const journalLimit = /\{ limit: (\d+), max: (\d+) \}/.exec(rateGridRoutes);
    assert.ok(journalLimit, "rate-journal pagination bounds not found");
    const journalRow = rowWith("`GET …/rate-journal`");
    assert.ok(journalRow.includes(journalLimit[1]) && journalRow.includes(journalLimit[2]));

    const applyCells = /z\.array\(ApplyCellSchema\)\.max\((\d+)\)/.exec(recommendationRoutes);
    assert.ok(applyCells, "apply cells cap not found");
    assert.ok(rowWith("recommendations[/apply]").includes(es(Number(applyCells[1]))));
    assert.match(recommendationRoutes, /No se pueden aplicar recomendaciones sobre fechas pasadas/);
    assert.ok(rowWith("recommendations[/apply]").includes("no puede ser pasado"));

    const restrictionMax = /nullableInt = z\.number\(\)\.int\(\)\.min\(0\)\.max\((\d+)\)/.exec(schemas);
    assert.ok(restrictionMax, "restriction bound not found");
    assert.ok(rowWith("rate-grid/bulk-update").includes(`0..${restrictionMax[1]}`));
    const availableMax = /available: z\.number\(\)\.int\(\)\.min\(0\)\.max\(([\d_]+)\)/.exec(schemas);
    assert.ok(availableMax, "available bound not found");
    assert.ok(rowWith("rate-grid/bulk-update").includes(es(Number(availableMax[1].replace(/_/g, "")))));
    const clientRequestId = /clientRequestId: z\.string\(\)\.min\((\d+)\)\.max\((\d+)\)/.exec(schemas);
    assert.ok(clientRequestId, "clientRequestId bounds not found");
    assert.ok(rowWith("rate-grid/bulk-update").includes(`${clientRequestId[1]}..${clientRequestId[2]}`));

    const lockTimeout = /lock_timeout = '(\d+)s'/.exec(engine);
    assert.ok(lockTimeout, "lock_timeout not found in the engine");
    assert.ok(rowWith("rate-grid/bulk-update").includes(`${lockTimeout[1]} s`) && rowWith("rate-grid/bulk-update").includes("RATE_GRID_BUSY"));
    const staleCells = /code: "JOURNAL_STALE", cells: outcome\.stale\.slice\(0, (\d+)\)/.exec(engine);
    assert.ok(staleCells, "JOURNAL_STALE cell cap not found");
    assert.ok(rowWith("rate-journal/:journalId/revert").includes(`${es(Number(staleCells[1]))} celdas`));

    const backoffMs = /RETRY_BACKOFF_MS[^=]*=\s*\[([^\]]+)\]/.exec(drainCore);
    assert.ok(backoffMs, "RETRY_BACKOFF_MS not found");
    const label = backoffMs[1]
      .split(",")
      .map((expr) => Function(`return (${expr.replace(/_/g, "")});`)())
      .map((ms) => (ms < 3_600_000 ? `${ms / 60_000} m` : `${ms / 3_600_000} h`))
      .join(", ");
    assert.ok(flat(runbook).includes(label) && flat(connectivity).includes(label), `backoff «${label}» must be documented in runbook and connectivity`);
    const maxAttempts = constant(drainCore, "MAX_ATTEMPTS");
    assert.ok(flat(runbook).includes(`${maxAttempts}.º`), "runbook must state the attempt that ends in rejected");
    const staleMinutes = /STALE_SENDING_MS = (\d+) \* 60_000/.exec(drainCore);
    assert.ok(staleMinutes, "STALE_SENDING_MS not found");
    assert.ok(flat(runbook).includes(`${staleMinutes[1]} min`) && flat(connectivity).includes(`${staleMinutes[1]} min`));
  });

  it("outbox rules (requeue, supersede, retire, UTC, stop sell) match delivery.core / delivery.service / drain", () => {
    const requeueable = stringArray(deliveryCore, "REQUEUEABLE_STATUSES");
    assert.ok(flat(runbook).includes(`\`${requeueable.join("/")}\``), "runbook must list REQUEUEABLE_STATUSES as rejected/timeout/superseded");
    assert.ok(flat(connectivity).includes(`\`${requeueable.join("/")}\``));
    const supersedable = stringArray(deliveryCore, "SUPERSEDABLE_STATUSES");
    assert.ok(flat(runbook).includes(`\`${supersedable.join("/")}\``), "runbook must list the supersedable statuses");
    const requeueFrom = stringArray(deliveryCore, "REQUEUE_FROM_STATUSES");
    assert.ok(requeueFrom.includes("confirmed"), "a confirmed row overtaken by a newer payload must be re-queueable (outbox-drain#1)");
    for (const doc of [runbook, connectivity]) {
      assert.match(flat(doc), /REQUEUE_FROM_STATUSES/);
      assert.match(flat(doc), /la entrega más reciente por celda lleva el payload actual/i);
      assert.match(flat(doc), /retireObsoleteDeliveries/);
      assert.match(flat(doc), /AT TIME ZONE 'UTC'/);
      assert.match(flat(doc), /FOR UPDATE SKIP LOCKED/);
      assert.match(flat(doc), /retiredObsolete/);
    }
    assert.match(drainService, /retiredObsolete: number/);
    assert.match(drainService, /AT TIME ZONE 'UTC'/);
    // attempts reset on requeue AND on manual retry (two writes in delivery.service).
    assert.ok((delivery.match(/status: "queued", attempts: 0, nextRetryAt: null/g) ?? []).length >= 2, "requeue and retry must both reset attempts");
    assert.match(flat(runbook), /`attempts = 0`/);
    assert.match(flat(runbook), /retry manual también reinicia `attempts` a 0/);
    // `sent` is reserved: nothing in the drain writes it.
    assert.ok(!/status: "sent"/.test(drainCore) && !/status: "sent"/.test(drainService), "nothing writes `sent` today; if that changes, update runbook §1.6 and connectivity §5");
    assert.match(flat(runbook), /`sent` está reservado en el contrato/);
    // journal.pushStatus lifecycle: whichever stamp the enqueue writes must be the one the runbook names.
    if (/pushStatus: "pushed", status: "published"/.test(delivery)) {
      assert.match(flat(runbook), /forma OPTIMISTA/);
    }
    if (/pushStatus: "queued", status: "published"/.test(delivery)) {
      assert.match(flat(runbook), /`pushStatus: queued` SOLO si se encoló o reencoló algo/);
    }
    assert.match(deliveryCore, /export function classifyJournalPushStatus/);
    assert.match(flat(runbook), /classifyJournalPushStatus/);
    assert.match(flat(connectivity), /classifyJournalPushStatus/);
    // Retention: only superseded rows are purged, by the unscoped drain pass.
    assert.match(drainService, /export async function purgeSupersededDeliveries/);
    assert.match(drainService, /status: "superseded", updatedAt: \{ lt: cutoff \}/);
    assert.match(flat(runbook), /purgeSupersededDeliveries/);
    assert.match(flat(connectivity), /purgeSupersededDeliveries/);
    assert.match(drainService, /purgedSuperseded: number \| null/);
    assert.match(flat(runbook), /purgedSuperseded/);
    // stop sell → availability 0 (inventory flag and room-level restriction).
    assert.match(delivery, /inv\.stopSell \? 0/);
    assert.match(deliveryCore, /stopSell \? 0/);
    assert.match(flat(runbook), /`count = 0` en la entrega `availability`/);
    // inactive channel → warning, never silence.
    const inactive = /Canal \$\{channel\.providerCode\}: inactivo, no se encola nada\./.exec(deliveryCore);
    assert.ok(inactive, "inactive-channel warning text changed");
    assert.match(flat(connectivity), /inactivo, no se encola nada/);
  });

  it("shared contract (rate-manager-types.ts) is described in runbook §1.1 and §1.6", () => {
    const syncStatuses = unionValues(sharedTypes, "export type CellSyncStatus");
    for (const status of syncStatuses) {
      assert.ok(runbook.includes(`\`${status}\``) || runbook.includes(`"${status}"`), `runbook must mention CellSyncStatus «${status}»`);
    }
    const pushStatuses = unionValues(sharedTypes, "pushStatus");
    assert.ok(flat(runbook).includes(`\`${pushStatuses.join(" | ")}\``), `runbook must quote the pushStatus union verbatim: ${pushStatuses.join(" | ")}`);
    assert.match(sharedTypes, /expected\?: \{ price\?: number \| null; lastModifiedAt\?: string \| null \}/);
    assert.match(schemas, /expected: z/);
    assert.match(flat(contractSection), /`RateGridCellPatch\.expected\?: \{ price\?: number \| null; lastModifiedAt\?: string \| null \}`/);
    assert.match(sharedTypes, /degraded\?: string\[\]/);
    assert.match(flat(contractSection), /`RateGridResponse\.degraded\?: string\[\]`/);
    assert.match(sharedTypes, /export type RateJournalRevertRequest = \{\s*force\?: boolean;/);
    assert.match(journalService, /body\.force/);
    assert.match(flat(contractSection), /`RateJournalRevertRequest \{ force\?: boolean; reason\?: string \}`/);
    // Scoped enqueue: both ends of the bridge accept the narrowing filters.
    for (const source of [bridge, delivery]) {
      assert.match(source, /ratePlanIds\?: string\[\];/);
      assert.match(source, /roomTypeIds\?: string\[\];/);
      assert.match(source, /kinds\?: /);
    }
    assert.match(flat(runbook), /Encolado acotado: `roomTypeIds`\/`ratePlanIds`\/`kinds`/);
  });

  it("typed 4xx codes exist in the code and are listed in runbook §1.1", () => {
    const codes = {
      NO_CELLS: [engine, rateGridService, schemas],
      TOO_MANY_CELLS: [schemas],
      INACTIVE_RATE_PLANS: [engine],
      DERIVATION_CHAIN: [ratePlanService],
      DERIVATION_YIELDS_ZERO: [ratePlanService],
      UNKNOWN_IDS: [engine, rateGridService, recommendationService, deliveryCore],
      ALL_CELLS_CONFLICT: [engine],
      JOURNAL_STALE: [engine, journalService],
      RATE_GRID_BUSY: [engine],
      CHANNEL_HAS_PENDING_DELIVERIES: [channelsService],
      DELIVERY_NOT_RETRYABLE: [delivery]
    };
    for (const [code, sources] of Object.entries(codes)) {
      assert.ok(sources.some((s) => s.includes(`"${code}"`)), `${code} is documented but no source emits it`);
      assert.ok(contractSection.includes(`\`${code}\``), `runbook §1.1 must list ${code}`);
    }
    // The Spanish zod error map replaced the English literals (api-live-contract#8).
    assert.match(schemas, /export (const|function) zodErrorMapEs/);
    assert.match(flat(runbook), /zodErrorMapEs/);
  });

  it("environment variables of the channel-manager partial and the OTA section are documented", () => {
    const partialKeys = [...envPartial.matchAll(/^ {2}([A-Z][A-Z0-9_]+): \{/gm)].map((m) => m[1]);
    assert.ok(partialKeys.includes("CHANNEL_MAX_MODE") && partialKeys.includes("CHANNEL_DRAIN_BATCH_LIMIT"), `unexpected partial keys: ${partialKeys.join(", ")}`);
    for (const key of partialKeys) {
      assert.ok(runbook.includes(`\`${key}\``), `runbook must mention ${key} (channel-manager/env.partial.ts)`);
    }
    for (const key of ["BOOKING_API_BASE_URL", "BOOKING_OAUTH_URL", "EXPEDIA_API_BASE_URL"]) {
      assert.ok(envTs.includes(`${key}:`), `${key} must stay in ENV_CONTRACT`);
      assert.ok(runbook.includes(`\`${key}\``) && bookingDoc.includes(`\`${key}\``), `${key} must be documented in runbook and booking-adapter`);
    }
    for (const retired of ["BOOKING_ADAPTER_MODE", "BOOKING_SANDBOX_URL", "EXPEDIA_ADAPTER_MODE"]) {
      assert.ok(!envTs.includes(`${retired}:`), `${retired} was retired from ENV_CONTRACT; if it comes back, update booking-adapter.md`);
    }
    assert.match(flat(bookingDoc), /retiradas del contrato/);
  });

  it("the simulator is documented as structural validation and CLAUDE.md no longer says OTAs are mock", () => {
    for (const [name, doc] of [["runbook", runbook], ["connectivity", connectivity], ["booking-adapter", bookingDoc]]) {
      assert.ok(!/esquema (REAL|real) del proveedor|esquema OTA real|esquema EQC real/.test(doc), `${name} must not sell the simulator as the provider's real schema`);
    }
    assert.match(flat(connectivity), /validación estructural local/);
    assert.match(flat(runbook), /validación ESTRUCTURAL local/);
    assert.ok(!/\*\*OTAs son MOCK\*\*|son \*\*MOCK\*\*/.test(claudeMd), "CLAUDE.md Deuda 7 was closed by Rate Grid v2");
    assert.match(claudeMd, /CERRADA por Rate Grid v2 \(deuda 13\)/);
  });

  it("seed-sandbox flags and the drain scope are documented as the code implements them", () => {
    const known = /Known: ([^`]+?)\.`\)/.exec(seedScript);
    assert.ok(known, "seed-sandbox-channels.ts must list its known flags");
    for (const flag of known[1].match(/--[a-z-]+/g)) {
      assert.ok(runbook.includes(flag), `runbook §3 must mention the seed flag ${flag}`);
    }
    assert.match(seedScript, /--dry-run and --apply are mutually exclusive/);
    assert.match(flat(runbook), /--dry-run y --apply son excluyentes/);
    assert.match(flat(runbook), /\{ runs: DrainSummary\[\] \}/);
    assert.match(channelRoutes, /drainNow/);
    assert.match(flat(runbook), /drainNow\?/);
  });

  it("channel archival, webhook hardening and adapter behaviours are documented where the code implements them", () => {
    assert.match(channelRoutes, /app\.delete\("\/channel-manager\/channels\/:channelId"/);
    assert.match(channelsService, /ARCHIVED_CHANNEL_STATUS = "archived"/);
    for (const doc of [runbook, connectivity]) {
      assert.match(flat(doc), /`DELETE \/channel-manager\/channels\/:(channelId|id)`/);
      assert.match(flat(doc), /archivado lógico/);
      assert.match(flat(doc), /CHANNEL_HAS_PENDING_DELIVERIES/);
    }
    assert.match(channelRoutes, /statusCode: 413/);
    assert.match(channelRoutes, /addHook\("preParsing"/);
    assert.match(flat(runbook), /hook `preParsing`/);
    assert.match(flat(connectivity), /BYTES ORIGINALES/);
    // Adapter facts the connectivity doc states (fix:api-channel-manager).
    assert.match(api("modules/channel-manager/adapters/booking/xml.ts"), /itemIndexByMessage/);
    assert.match(flat(connectivity), /itemIndexByMessage/);
    assert.match(flat(bookingDoc), /itemIndexByMessage/);
    assert.match(api("modules/channel-manager/adapters/booking.adapter.ts"), /secure-supply-xml\.booking\.com/);
    assert.match(flat(connectivity), /secure-supply-xml\.booking\.com/);
    assert.match(flat(bookingDoc), /hotel_ids=/);
    assert.match(api("modules/channel-manager/adapters/expedia/xml.ts"), /BookingRetrievalRQ/);
    assert.match(flat(connectivity), /BookingRetrievalRQ/);
    assert.match(api("modules/channel-manager/adapters/transport.ts"), /retryAfterMs/);
    assert.match(flat(connectivity), /Retry-After/);
    assert.match(channelRoutes, /los, precio por estancia, no está implementado todavía/);
    assert.match(flat(runbook), /`pricingModel: "los"` → 400/);
  });

  it("runbook §6, DESIGN-PROPOSAL, PLAN-MAESTRO, CLAUDE.md and the closing report carry the cierre 2026-09-15 contract", () => {
    for (const item of ["stale", "pushStatus", "expected", "RateJournalRevertRequest", "degraded", "NO_CELLS", "roomTypeIds", "currentPrice", "suggestedPrice", "CHANNEL_DELIVERY_RETENTION_DAYS", "Payload Too Large", "@@unique([propertyId, clientRequestId])", "hotelos-nav"]) {
      assert.ok(closeSection.includes(item), `runbook §6 must track the agreed contract item «${item}»`);
    }
    assert.match(flat(runbook), /queueMicrotask/);
    assert.match(api("../../admin-web/src/App.tsx"), /queueMicrotask\(\(\) => \{\s*if \(event\.defaultPrevented \|\| event\.cancelBubble\) return;/);
    assert.match(designProposal, /^> Nota \(2026-09-15\):/m);
    assert.equal((planMaestro.match(/Nota 2026-09-15/g) ?? []).length, 4, "PLAN-MAESTRO keeps the four guardrail notes (líneas 86, 108, 172, 240)");
    for (const needle of ["JOURNAL_STALE", "RATE_GRID_BUSY", "rate-grid-docs-contract", "RATE-GRID-V2-CIERRE-2026-09-15", "CHANNEL_DELIVERY_RETENTION_DAYS", "scheduleAt"]) {
      assert.ok(claudeMd.includes(needle), `CLAUDE.md §Deuda 13 must mention ${needle}`);
    }
    // The closing report names what only the owner can provide.
    for (const needle of ["staging", "Channex", "API key", "extranet", "Rías Altas", "Los Tilos", "CHANNEL_MAX_MODE=real", "130 $/mes", "7 $/hotel"]) {
      assert.ok(closeReport.toLowerCase().includes(needle.toLowerCase()), `closing report must mention «${needle}»`);
    }
  });

  it("runbook, closing report and CLAUDE.md carry the final browser walkthrough of 2026-09-15 and only reasoned browser-pending markers remain", () => {
    // The undated «pendiente de verificar en navegador» markers were retired after the final walkthrough
    // (Carmen, Los Tilos 2027-08-15..31, after the second API restart). What that walkthrough could not
    // cover (BUX-05 physical keyboard, the popover branches «Fijar otro precio»/«Aceptar con ajuste»,
    // bulk-update+publish counts, «Efectivo» with an active channel) must state its reason inline:
    // «pendiente de verificar en navegador (motivo: …)». A bare marker means somebody documented a
    // screen change without seeing it — the exact drift that browser-ux-final#14 flagged.
    const bare = /pendientes? de verificar en navegador(?! \(motivo)/i;
    assert.doesNotMatch(flat(runbook), bare, "runbook keeps a browser-pending marker without a reason");
    assert.doesNotMatch(flat(closeReport), bare, "closing report keeps a browser-pending marker without a reason");
    assert.doesNotMatch(flat(runbook), /reinicio de :3000\/:3400 pendiente/);
    assert.match(closeSection, /verificado en navegador el 15\/09\/2026/);
    assert.match(closeReport, /^### 6\.5 Recorrido final tras el segundo reinicio/m);
    for (const id of ["BUX-01", "BUX-02", "BUX-03", "BUX-04", "BUX-06", "BUX-07", "BUX-08", "BUX-09", "BUX-10", "BUX-11", "BUX-12", "BUX-13"]) {
      assert.ok(runbook.includes(`**${id}**`), `runbook §2.2 must keep the browser finding ${id}`);
      assert.ok(closeReport.includes(`| ${id} |`), `closing report §6.3 must keep the row of ${id}`);
      assert.match(section(closeReport, `| ${id} |`, "\n"), /verificado en navegador el 15\/09\/2026/, `closing report §6.3 must date the browser verification of ${id}`);
    }
    assert.match(flat(runbook), /BUX-05[^*]*teclado físico/, "BUX-05 stays pending with the physical-keyboard reason");
    assert.match(flat(connectivity), /desde su reinicio del 2026-09-15/);
    assert.match(flat(claudeMd), /se verificaron en navegador el 15\/09\/2026/, "CLAUDE.md §Deuda 13 must record the final browser walkthrough");
  });
});
