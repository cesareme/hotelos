// Template renderer (Sprint 26 — Notification engine)
//
// Pure Mustache-style template substitution. No I/O — keep this file
// deterministic and trivially unit-testable. Supported syntax:
//
//   {{var}}                          → string(variables.var) (or "" if undefined)
//   {{ var }}                        → whitespace inside braces is tolerated
//   {{ var | default: "fallback" }}  → string(variables.var) if defined and not "",
//                                       otherwise the literal between the quotes
//   {{var.nested.path}}              → simple dotted lookup (one level deep only;
//                                       supports common cases like guest.name)
//
// Nested loops / sections (`{{#each}}`) are deliberately NOT supported. If a
// caller needs those, render a pre-joined string into a single variable.

export type NotificationTemplateLike = {
  id?: string;
  code?: string;
  channel?: string;
  language?: string;
  subject?: string | null;
  body: string;
};

export type RenderResult = {
  subject: string;
  body: string;
};

const TOKEN_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

function resolvePath(variables: Record<string, unknown>, path: string): unknown {
  if (!path.includes(".")) return variables[path];
  const segments = path.split(".");
  let current: unknown = variables;
  for (const seg of segments) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// Parses one token body (the text between {{ and }}). Returns either a plain
// variable path, or a path + default literal when the `| default: "…"` filter
// is present.
function parseToken(raw: string): { path: string; fallback: string | undefined } {
  const pipeIdx = raw.indexOf("|");
  if (pipeIdx === -1) {
    return { path: raw.trim(), fallback: undefined };
  }
  const path = raw.slice(0, pipeIdx).trim();
  const filterRaw = raw.slice(pipeIdx + 1).trim();
  // Match: default: "…"  OR  default: '…'
  const m = filterRaw.match(/^default\s*:\s*(?:"([^"]*)"|'([^']*)')\s*$/i);
  if (!m) {
    return { path, fallback: undefined };
  }
  const fallback = (m[1] ?? m[2] ?? "");
  return { path, fallback };
}

function renderString(input: string, variables: Record<string, unknown>): string {
  return input.replace(TOKEN_RE, (_match, rawToken: string) => {
    const { path, fallback } = parseToken(rawToken);
    const resolved = resolvePath(variables, path);
    const stringValue = stringify(resolved);
    if (stringValue === "" && fallback !== undefined) return fallback;
    return stringValue;
  });
}

/**
 * Render a template's `subject` (may be null/empty) and `body` using the
 * supplied variables. Missing variables collapse to "" unless a
 * `| default: "…"` filter provides a fallback.
 */
export function renderTemplate(input: {
  template: NotificationTemplateLike;
  variables: Record<string, unknown>;
}): RenderResult {
  const subject = input.template.subject ? renderString(input.template.subject, input.variables) : "";
  const body = renderString(input.template.body ?? "", input.variables);
  return { subject, body };
}

/**
 * List all `{{var}}` tokens that appear in a string. Useful for template
 * validation ("which variables does this template expect?"). Filter syntax is
 * stripped so the returned tokens are just variable paths.
 */
export function listTemplateTokens(input: string): string[] {
  if (!input) return [];
  const tokens = new Set<string>();
  for (const match of input.matchAll(TOKEN_RE)) {
    const { path } = parseToken(match[1] ?? "");
    if (path) tokens.add(path);
  }
  return Array.from(tokens).sort();
}

/** List tokens across both `subject` and `body` of a template. */
export function listTemplateTokensForTemplate(template: NotificationTemplateLike): string[] {
  const subjectTokens = template.subject ? listTemplateTokens(template.subject) : [];
  const bodyTokens = listTemplateTokens(template.body ?? "");
  return Array.from(new Set([...subjectTokens, ...bodyTokens])).sort();
}
