#!/usr/bin/env node
// Smoke test for the Director (General Manager) dashboard.
//
// Verifies that:
//   1. admin-web is reachable on http://localhost:5173
//   2. The API is reachable on http://localhost:3000 and /health is healthy
//   3. GET /dashboards/general-manager?propertyId=<demo> returns a valid payload
//   4. The response shape contains the expected KPI / arrival / departure fields
//
// No browser automation: only plain HTTP via global fetch (Node >= 18).
// Exits 0 on success, 1 on failure with a clear, colored message.

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  reset: COLOR ? "\x1b[0m" : "",
  bold: COLOR ? "\x1b[1m" : "",
  dim: COLOR ? "\x1b[2m" : "",
  red: COLOR ? "\x1b[31m" : "",
  green: COLOR ? "\x1b[32m" : "",
  yellow: COLOR ? "\x1b[33m" : "",
  blue: COLOR ? "\x1b[34m" : "",
  cyan: COLOR ? "\x1b[36m" : ""
};

const ADMIN_WEB_URL = process.env.ADMIN_WEB_URL ?? "http://localhost:5173";
const API_URL = process.env.API_URL ?? "http://localhost:3000";
const DEMO_PROPERTY_ID = process.env.DEMO_PROPERTY_ID ?? "prop_123";
const REQUEST_TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 8000);

function logInfo(msg) {
  console.log(`${c.cyan}info${c.reset}  ${msg}`);
}
function logOk(msg) {
  console.log(`${c.green}ok${c.reset}    ${msg}`);
}
function logWarn(msg) {
  console.log(`${c.yellow}warn${c.reset}  ${msg}`);
}
function logFail(msg) {
  console.error(`${c.red}fail${c.reset}  ${msg}`);
}

function fail(reason) {
  logFail(reason);
  console.error(
    `${c.red}${c.bold}Director dashboard smoke test FAILED${c.reset}`
  );
  process.exit(1);
}

async function fetchWithTimeout(url, opts = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

// 1. admin-web alive on :5173 -----------------------------------------------
async function checkAdminWeb() {
  logInfo(`checking admin-web at ${c.dim}${ADMIN_WEB_URL}${c.reset}`);
  let res;
  try {
    res = await fetchWithTimeout(ADMIN_WEB_URL, { method: "GET" });
  } catch (err) {
    fail(
      `admin-web is not reachable at ${ADMIN_WEB_URL} (${err.message}). ` +
        `Start it with "pnpm --filter @hotelos/admin-web dev".`
    );
  }
  if (!res.ok && res.status !== 304) {
    fail(`admin-web responded with HTTP ${res.status} at ${ADMIN_WEB_URL}`);
  }
  logOk(`admin-web is up (HTTP ${res.status})`);
}

// 2. API alive + /health healthy --------------------------------------------
async function checkApiHealth() {
  const healthUrl = `${API_URL}/health`;
  logInfo(`checking API health at ${c.dim}${healthUrl}${c.reset}`);
  let res;
  try {
    res = await fetchWithTimeout(healthUrl);
  } catch (err) {
    fail(
      `API is not reachable at ${API_URL} (${err.message}). ` +
        `Start it with "pnpm --filter @hotelos/api dev".`
    );
  }
  if (!res.ok) {
    fail(`API /health responded with HTTP ${res.status}`);
  }
  let body;
  try {
    body = await res.json();
  } catch (err) {
    fail(`API /health did not return JSON: ${err.message}`);
  }
  // Accept either { status: "ok" | "healthy" } or { ok: true }.
  const status = String(body?.status ?? "").toLowerCase();
  const healthy =
    body?.ok === true || status === "ok" || status === "healthy" || status === "pass";
  if (!healthy) {
    fail(
      `API /health is not healthy: ${JSON.stringify(body).slice(0, 200)}`
    );
  }
  logOk(`API /health is healthy`);
}

// 3 + 4. GM dashboard payload + shape ---------------------------------------
//
// The user-facing canonical route is /dashboards/general-manager, but we also
// accept /general-manager/dashboard for forward-compat in case the API ever
// adds an alias. We try the canonical route first.
const DASHBOARD_PATHS = [
  "/dashboards/general-manager",
  "/general-manager/dashboard"
];

async function fetchDashboard() {
  const errors = [];
  for (const path of DASHBOARD_PATHS) {
    const url = `${API_URL}${path}?propertyId=${encodeURIComponent(DEMO_PROPERTY_ID)}`;
    logInfo(`fetching ${c.dim}${url}${c.reset}`);
    try {
      const res = await fetchWithTimeout(url);
      if (res.ok) {
        const body = await res.json();
        logOk(`dashboard payload received from ${path} (HTTP ${res.status})`);
        return { path, body };
      }
      errors.push(`${path} -> HTTP ${res.status}`);
    } catch (err) {
      errors.push(`${path} -> ${err.message}`);
    }
  }
  fail(
    `Director dashboard endpoint did not respond: ${errors.join("; ")}`
  );
}

// Shape contract. We accept the canonical GmDashboard shape used by the API
// (occupancy / adr / revpar / productivity.checkInsPlanned etc) and also
// tolerate the historical aliases the user mentioned (kpis / todayArrivals /
// todayDepartures) so the smoke test stays green across both naming schemes.
function pickFirstDefined(obj, paths) {
  for (const p of paths) {
    const parts = p.split(".");
    let cur = obj;
    let ok = true;
    for (const part of parts) {
      if (cur == null || !(part in cur)) {
        ok = false;
        break;
      }
      cur = cur[part];
    }
    if (ok && cur !== undefined) return { path: p, value: cur };
  }
  return null;
}

function checkShape(body) {
  if (body == null || typeof body !== "object") {
    fail(`dashboard payload is not an object`);
  }

  const required = [
    {
      label: "kpis (occupancy / adr / revpar)",
      paths: ["kpis", "occupancy", "adr", "revpar"]
    },
    {
      label: "todayArrivals (or productivity.checkInsPlanned)",
      paths: [
        "todayArrivals",
        "arrivalsToday",
        "productivity.checkInsPlanned",
        "productivity.checkInsDone"
      ]
    },
    {
      label: "todayDepartures (or productivity.checkOutsPlanned)",
      paths: [
        "todayDepartures",
        "departuresToday",
        "productivity.checkOutsPlanned",
        "productivity.checkOutsDone"
      ]
    },
    {
      label: "propertyId",
      paths: ["propertyId"]
    }
  ];

  const missing = [];
  for (const field of required) {
    const hit = pickFirstDefined(body, field.paths);
    if (!hit) {
      missing.push(field.label);
    } else {
      logOk(`shape ok: ${field.label} -> ${c.dim}${hit.path}${c.reset}`);
    }
  }

  if (missing.length > 0) {
    fail(
      `dashboard payload is missing required fields:\n` +
        missing.map((m) => `  - ${m}`).join("\n") +
        `\n(top-level keys: ${Object.keys(body).join(", ")})`
    );
  }
}

// Main ----------------------------------------------------------------------
async function main() {
  console.log(
    `${c.bold}${c.blue}Director dashboard smoke test${c.reset} ${c.dim}(propertyId=${DEMO_PROPERTY_ID})${c.reset}`
  );
  await checkAdminWeb();
  await checkApiHealth();
  const { body } = await fetchDashboard();
  checkShape(body);
  console.log(
    `${c.green}${c.bold}Director dashboard smoke test PASSED${c.reset}`
  );
  process.exit(0);
}

main().catch((err) => {
  fail(`unexpected error: ${err?.stack ?? err}`);
});
