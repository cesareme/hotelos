// Contract test (Tanda 5 · L1c · lote formato-copy): the admin-web screens speak
// Spanish and format every value through the single module lib/format.ts.
//
// 1. No English literal from the dictionary (content/actions.ts) is rendered:
//    JSX text (`>Save<`), label-like props (`label="Status"`), object labels
//    (`label: "Pending"`) and ternary branches (`? "Loading…" :`). Comments,
//    import lines and object KEYS are ignored.
// 2. No local money/percent/date formatter outside lib/format.ts: no
//    `Intl.NumberFormat` / `Intl.DateTimeFormat`, no `toLocale*String(`, no
//    `toFixed(n)` glued to «€» / «%», no `} EUR` in JSX, no `"EUR"` literal
//    passed to a money helper (the currency comes from the record or from
//    DEFAULT_CURRENCY inside lib/format.ts).
// 3. No roadmap or engineering jargon on a hotelier's screen: «sandbox»,
//    «stub», «mock», «Q1…Q4», «Pendiente de implementación», «Próximamente»,
//    «coming soon», «TODO» in visible JSX.
//
// Allowed exceptions are listed explicitly with a reason; keep the list short.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";

const adminWebSrc = fileURLToPath(new URL("../apps/admin-web/src/", import.meta.url));
const SCREENS_DIR = join(adminWebSrc, "screens");
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);

// Files that may keep a local formatter or a literal, and why.
const FORMATTER_EXCEPTIONS = new Map([
  // (none today — add "screens/<path>": "reason" when a screen genuinely needs its own formatter)
]);
// Screens excluded from the English-literal check (developer showcases of the
// Cocoa kit render component states by their English prop names on purpose).
const COPY_EXCEPTIONS = new Map([
  ["screens/developer/CocoaShowcaseScreen.tsx", "developer showcase of the Cocoa kit (dev-only route)"],
  ["screens/preview/CocoaGalleryScreen.tsx", "developer gallery of the Cocoa kit (dev-only route)"]
]);

// English literals from the dictionary (content/actions.ts) plus the ones the
// Tanda 5 audit found in headers, KPI tiles and buttons.
const FORBIDDEN_EN = [
  "Save", "Save changes", "Cancel", "Loading", "Loading...", "Loading…", "Export CSV", "Period", "Status", "Pending", "Configured",
  "Needs attention", "Open", "Close", "Delete", "Search", "Filter", "Reset", "Submit", "Success", "Warning", "Dashboard", "Settings",
  "Last saved", "End date", "Start date", "Refresh", "Retry", "Deactivate", "Details", "Type", "Name", "Actions", "Accepted", "Queued",
  "Failed", "Sent", "Submitted", "Completed", "Cancelled", "Draft", "Description", "Active", "Inactive", "Phone", "Email", "In-house",
  "Upcoming", "Hide", "Guest", "Amount", "Date", "Count", "Scopes", "Code", "Open reservation", "Open reservation detail", "Open full detail",
  "Guest profile", "Notification templates", "Delivery log", "Certificate health", "Sales pipeline"
];

const JARGON = ["sandbox", "stub", "mock", "Q1", "Q2", "Q3", "Q4", "Pendiente de implementación", "Próximamente", "próximamente", "coming soon", "TODO"];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      if (entry === "__tests__") continue;
      walk(full, out);
      continue;
    }
    const dot = entry.lastIndexOf(".");
    if (dot >= 0 && SOURCE_EXTENSIONS.has(entry.slice(dot))) out.push(full);
  }
  return out;
}

const posix = (file) => relative(adminWebSrc, file).split(sep).join("/");
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Source without comments and import lines (newlines kept, so line numbers stay exact). */
function stripNonCode(source) {
  const blank = (text) => text.replace(/[^\n]/g, "");
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/^import[\s\S]*?from\s+"[^"]+";[ \t]*$/gm, blank)
    .replace(/^import\s+"[^"]+";[ \t]*$/gm, "");
}

/** Line numbers (1-based) of every match of `re` in `text`. */
function findLines(text, re) {
  const hits = [];
  const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  let match;
  while ((match = global.exec(text)) !== null) {
    const line = text.slice(0, match.index).split("\n").length;
    hits.push(`${line}: ${match[0].replace(/\s+/g, " ").trim().slice(0, 120)}`);
  }
  return hits;
}

function englishLiteralPatterns(literal) {
  const word = escapeRe(literal);
  return [
    // JSX text node: >Save< · >Loading…{ · >Status\n
    new RegExp(`>\\s*${word}\\s*(?=<|\\{|\\n)`, "m"),
    // Label-like props and object fields with a string value.
    new RegExp(`\\b(label|title|placeholder|subtitle|aria-label|message|eyebrow|caption|hint|summary|description|cta|text|confirmLabel|cancelLabel|retryLabel|emptyMessage)\\s*[=:]\\s*["']${word}["']`),
    // Ternary / default branches that render a literal: ? "Loading…" : · ?? "Pending"
    new RegExp(`(\\?\\?|\\?|:)\\s*["']${word}["']\\s*(?=[:}),;\\]])`)
  ];
}

const files = walk(SCREENS_DIR);

describe("admin-web · copy en español (Tanda 5 · L1c)", () => {
  it("scans a non-trivial set of screen files", () => {
    assert.ok(files.length > 150, `expected to scan >150 screen files, scanned ${files.length}`);
  });

  it("renders no English literal from the dictionary in JSX (text, labels, ternaries)", () => {
    const offenders = [];
    for (const file of files) {
      const rel = posix(file);
      if (COPY_EXCEPTIONS.has(rel)) continue;
      const code = stripNonCode(readFileSync(file, "utf8"));
      for (const literal of FORBIDDEN_EN) {
        for (const pattern of englishLiteralPatterns(literal)) {
          for (const hit of findLines(code, pattern)) offenders.push(`${rel}:${hit}  («${literal}»)`);
        }
      }
    }
    assert.deepEqual(offenders, [], `English literals rendered in screens:\n${offenders.join("\n")}`);
  });

  it("shows no roadmap or engineering jargon in visible JSX", () => {
    const offenders = [];
    for (const file of files) {
      const rel = posix(file);
      if (COPY_EXCEPTIONS.has(rel)) continue;
      const code = stripNonCode(readFileSync(file, "utf8"));
      for (const word of JARGON) {
        const w = escapeRe(word);
        const patterns = [
          new RegExp(`>[^<>{}]*\\b${w}\\b[^<>{}]*(?=<)`),
          new RegExp(`\\b(label|title|placeholder|subtitle|aria-label|message|eyebrow|caption|hint|summary|description|cta)\\s*[=:]\\s*["'\`][^"'\`]*\\b${w}\\b[^"'\`]*["'\`]`),
          new RegExp(`(\\?\\?|\\?|:)\\s*["'\`][^"'\`]*\\b${w}\\b[^"'\`]*["'\`]\\s*(?=[:}),;\\]])`),
          new RegExp(`showToast\\(\\s*["'\`][^"'\`]*\\b${w}\\b`)
        ];
        for (const pattern of patterns) {
          for (const hit of findLines(code, pattern)) offenders.push(`${rel}:${hit}  («${word}»)`);
        }
      }
    }
    assert.deepEqual(offenders, [], `Jargon visible in screens:\n${offenders.join("\n")}`);
  });

  it("formats money, percentages, dates and numbers only through lib/format.ts", () => {
    const offenders = [];
    const rules = [
      [/\bIntl\.NumberFormat\b/, "Intl.NumberFormat → money()/number()/percent()"],
      [/\bIntl\.DateTimeFormat\b/, "Intl.DateTimeFormat → date()/time()/dateTime()"],
      [/\.toLocale(Date|Time)?String\s*\(/, "toLocale*String → number()/date()/time()"],
      [/\.toFixed\(\d\)\s*\}?\s*(€|%|EUR\b)/, "toFixed + €/% → money()/percent()"],
      [/\}\s*EUR\b(?![A-Za-z_])/, "JSX «… EUR» → money(value, record.currency)"],
      [/\b(money|fmtMoney|formatMoney|fmtEur|formatEur)\([^)]*"EUR"/, "literal \"EUR\" passed to a money helper → currency from the record or DEFAULT_CURRENCY"],
      [/currency\s*(\?\?|\|\|)\s*"EUR"\s*[,)]/, "`currency ?? \"EUR\"` → pass the record's currency; money() defaults to DEFAULT_CURRENCY"]
    ];
    for (const file of files) {
      const rel = posix(file);
      if (FORMATTER_EXCEPTIONS.has(rel)) continue;
      const code = stripNonCode(readFileSync(file, "utf8"));
      for (const [re, why] of rules) {
        for (const hit of findLines(code, re)) offenders.push(`${rel}:${hit}  (${why})`);
      }
    }
    assert.deepEqual(offenders, [], `Local formatters outside lib/format.ts:\n${offenders.join("\n")}`);
  });

  it("keeps the exception lists short and justified", () => {
    assert.ok(FORMATTER_EXCEPTIONS.size <= 5, "too many formatter exceptions");
    assert.ok(COPY_EXCEPTIONS.size <= 5, "too many copy exceptions");
    for (const [, reason] of [...FORMATTER_EXCEPTIONS, ...COPY_EXCEPTIONS]) assert.ok(reason.length > 10, "every exception needs a reason");
  });

  it("lib/format.ts stays the single formatting module (es-ES, Europe/Madrid, DEFAULT_CURRENCY)", () => {
    const format = readFileSync(join(adminWebSrc, "lib", "format.ts"), "utf8");
    for (const marker of ['export const LOCALE = "es-ES"', 'export const TIME_ZONE = "Europe/Madrid"', 'export const DEFAULT_CURRENCY = "EUR"', "export function money(", "export function percent(", "export function date(", "export function dateTime("]) {
      assert.ok(format.includes(marker), `lib/format.ts must keep ${marker}`);
    }
  });
});
