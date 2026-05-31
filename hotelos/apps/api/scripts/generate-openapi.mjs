#!/usr/bin/env node
// Auto-generate OpenAPI 3.1 YAML from server.ts route definitions
// crossed with security/route-permissions.ts permission/risk metadata.
//
// Pure Node (no deps): only fs + path from the standard library.
//
// Usage: node scripts/generate-openapi.mjs

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const apiRoot = resolvePath(__dirname, "..");
const serverPath = resolvePath(apiRoot, "src/server.ts");
const permissionsPath = resolvePath(apiRoot, "src/security/route-permissions.ts");
const outputPath = resolvePath(apiRoot, "docs/openapi.yaml");

// ---------------------------------------------------------------------------
// Parse server.ts: extract app.get|post|patch|delete("/path", ...) entries.
// ---------------------------------------------------------------------------
function parseServerRoutes(source) {
  const routes = [];
  const re = /app\.(get|post|patch|delete)\(['"]([^'"]+)['"]/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const method = match[1].toUpperCase();
    const path = match[2];
    routes.push({ method, path });
  }
  return routes;
}

// ---------------------------------------------------------------------------
// Parse route-permissions.ts: pull every manifest entry. Supports both
// single-line { method: ..., path: ..., permissions: [...], riskLevel: ... }
// and multi-line entries (the manifest contains both forms).
// ---------------------------------------------------------------------------
function parseRoutePermissions(source) {
  const entries = [];
  // Capture inside routePermissionManifest = [ ... ]
  const manifestStart = source.indexOf("routePermissionManifest");
  if (manifestStart === -1) return entries;
  // Skip past the TypeScript type annotation (e.g. `: ApiRoutePermission[]`)
  // and the `=` sign before finding the actual array literal.
  const eqIndex = source.indexOf("=", manifestStart);
  if (eqIndex === -1) return entries;
  const bracketStart = source.indexOf("[", eqIndex);
  if (bracketStart === -1) return entries;
  // Find matching closing bracket at top level
  let depth = 0;
  let bracketEnd = -1;
  for (let i = bracketStart; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        bracketEnd = i;
        break;
      }
    }
  }
  if (bracketEnd === -1) return entries;
  const manifestBody = source.slice(bracketStart + 1, bracketEnd);

  // Iterate object literals at top level (depth 0 for { } inside the array).
  let objDepth = 0;
  let objStart = -1;
  for (let i = 0; i < manifestBody.length; i += 1) {
    const ch = manifestBody[i];
    if (ch === "{") {
      if (objDepth === 0) objStart = i;
      objDepth += 1;
    } else if (ch === "}") {
      objDepth -= 1;
      if (objDepth === 0 && objStart !== -1) {
        const objText = manifestBody.slice(objStart, i + 1);
        const parsed = parsePermissionEntry(objText);
        if (parsed) entries.push(parsed);
        objStart = -1;
      }
    }
  }
  return entries;
}

function parsePermissionEntry(text) {
  const methodMatch = text.match(/method:\s*['"]([^'"]+)['"]/);
  const pathMatch = text.match(/path:\s*['"]([^'"]+)['"]/);
  const riskMatch = text.match(/riskLevel:\s*['"]([^'"]+)['"]/);
  const permsMatch = text.match(/permissions:\s*\[([\s\S]*?)\]/);
  if (!methodMatch || !pathMatch) return null;
  const permissions = [];
  if (permsMatch) {
    const inner = permsMatch[1];
    const stringRe = /['"]([^'"]+)['"]/g;
    let m;
    while ((m = stringRe.exec(inner)) !== null) {
      permissions.push(m[1]);
    }
  }
  return {
    method: methodMatch[1].toUpperCase(),
    path: pathMatch[1],
    permissions,
    riskLevel: riskMatch ? riskMatch[1] : "unknown"
  };
}

// ---------------------------------------------------------------------------
// Convert Fastify-style path (/foo/:id) to OpenAPI-style (/foo/{id})
// and return the param names so we can add parameter objects.
// ---------------------------------------------------------------------------
function toOpenApiPath(fastifyPath) {
  const params = [];
  const path = fastifyPath.replace(/:([A-Za-z0-9_]+)/g, (_match, name) => {
    params.push(name);
    return `{${name}}`;
  });
  return { path, params };
}

// ---------------------------------------------------------------------------
// YAML serialiser tailored to OpenAPI's nested-object shape. Avoids pulling
// a YAML dep while still emitting deterministic, human-readable output.
// ---------------------------------------------------------------------------
function yamlEscapeString(value) {
  if (value === "") return '""';
  // Quote if it contains characters that would change YAML semantics.
  if (/[:#&*!|>'"%@`,?{}\[\]\-]/.test(value) || /^[\d.+-]/.test(value) || /\s$/.test(value) || /^\s/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

function yamlValue(value, indent) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return yamlEscapeString(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value
      .map((item) => {
        if (item !== null && typeof item === "object") {
          const rendered = renderObject(item, indent + 2);
          // Inline first key with the dash, indent the rest.
          const lines = rendered.split("\n");
          return `${" ".repeat(indent)}- ${lines[0].trimStart()}` +
            (lines.length > 1 ? "\n" + lines.slice(1).join("\n") : "");
        }
        return `${" ".repeat(indent)}- ${yamlValue(item, indent + 2)}`;
      })
      .join("\n");
  }
  if (typeof value === "object") {
    return renderObject(value, indent);
  }
  return yamlEscapeString(String(value));
}

function renderObject(obj, indent) {
  const keys = Object.keys(obj);
  if (keys.length === 0) return "{}";
  return keys
    .map((key) => {
      const value = obj[key];
      const prefix = `${" ".repeat(indent)}${key}:`;
      if (value === null || typeof value !== "object") {
        return `${prefix} ${yamlValue(value, indent)}`;
      }
      if (Array.isArray(value)) {
        if (value.length === 0) return `${prefix} []`;
        return `${prefix}\n${yamlValue(value, indent)}`;
      }
      const innerKeys = Object.keys(value);
      if (innerKeys.length === 0) return `${prefix} {}`;
      return `${prefix}\n${renderObject(value, indent + 2)}`;
    })
    .join("\n");
}

function toYaml(doc) {
  return renderObject(doc, 0) + "\n";
}

// ---------------------------------------------------------------------------
// Build OpenAPI doc.
// ---------------------------------------------------------------------------
function buildOpenApi(routes, permissionsIndex) {
  const paths = {};
  let withPerms = 0;
  let publicCount = 0;

  // Deduplicate (method, path) — server.ts may register the same path more
  // than once via mismatched parsing; we keep the first occurrence.
  const seen = new Set();
  for (const route of routes) {
    const key = `${route.method} ${route.path}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const { path: openApiPath, params } = toOpenApiPath(route.path);
    const lookup = permissionsIndex.get(`${route.method} ${route.path}`);
    const permissions = lookup ? lookup.permissions : [];
    const riskLevel = lookup ? lookup.riskLevel : "unknown";
    if (permissions.length > 0) withPerms += 1;
    if (riskLevel === "public") publicCount += 1;

    if (!paths[openApiPath]) paths[openApiPath] = {};

    const responses = {
      "200": { description: "Successful response" },
      "400": { description: "Bad request" },
      "401": { description: "Unauthorized" },
      "403": { description: "Forbidden — missing required permission" },
      "404": { description: "Resource not found" },
      "429": { description: "Too many requests" },
      "500": { description: "Internal server error" }
    };

    const operation = {
      summary: `${route.method} ${route.path}`,
      operationId: buildOperationId(route.method, route.path),
      tags: [pickTag(route.path)],
      "x-permissions": permissions,
      "x-risk-level": riskLevel,
      "x-manifest-entry": Boolean(lookup),
      responses
    };

    if (params.length > 0) {
      operation.parameters = params.map((name) => ({
        name,
        in: "path",
        required: true,
        schema: { type: "string" }
      }));
    }

    if (route.method !== "GET" && route.method !== "DELETE") {
      operation.requestBody = {
        required: false,
        content: {
          "application/json": {
            schema: { type: "object", additionalProperties: true }
          }
        }
      };
    }

    paths[openApiPath][route.method.toLowerCase()] = operation;
  }

  return {
    doc: {
      openapi: "3.1.0",
      info: {
        title: "HotelOS API",
        version: "0.1.0",
        description: "Auto-generated OpenAPI specification derived from server.ts route definitions crossed with the route-permissions manifest."
      },
      servers: [
        { url: "http://localhost:3000", description: "Local development" }
      ],
      tags: [],
      paths
    },
    stats: {
      totalRoutes: routes.length,
      uniqueRoutes: seen.size,
      withPermissions: withPerms,
      publicRoutes: publicCount
    }
  };
}

function buildOperationId(method, path) {
  const cleaned = path
    .replace(/^\//, "")
    .replace(/:([A-Za-z0-9_]+)/g, "by-$1")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `${method.toLowerCase()}-${cleaned || "root"}`;
}

function pickTag(path) {
  const trimmed = path.replace(/^\//, "");
  const first = trimmed.split("/")[0] ?? "root";
  return first || "root";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  if (!existsSync(serverPath)) {
    console.error(`server.ts not found at ${serverPath}`);
    process.exit(1);
  }
  if (!existsSync(permissionsPath)) {
    console.error(`route-permissions.ts not found at ${permissionsPath}`);
    process.exit(1);
  }

  const serverSource = readFileSync(serverPath, "utf-8");
  const permissionsSource = readFileSync(permissionsPath, "utf-8");

  const routes = parseServerRoutes(serverSource);
  const permissionEntries = parseRoutePermissions(permissionsSource);

  const permissionsIndex = new Map();
  for (const entry of permissionEntries) {
    permissionsIndex.set(`${entry.method} ${entry.path}`, entry);
  }

  const { doc, stats } = buildOpenApi(routes, permissionsIndex);
  const yaml = toYaml(doc);

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, yaml, "utf-8");

  console.log(`[openapi] parsed ${routes.length} route definitions from server.ts`);
  console.log(`[openapi] parsed ${permissionEntries.length} entries from route-permissions.ts`);
  console.log(`[openapi] wrote ${stats.uniqueRoutes} unique paths -> ${outputPath}`);
  console.log(`[openapi] with-permissions=${stats.withPermissions} public=${stats.publicRoutes}`);
  console.log(`[openapi] yaml bytes=${yaml.length}`);
}

main();
