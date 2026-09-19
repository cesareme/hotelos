// ESM resolve hook (copied from packages/compliance/src/spain/verifactu/__tests__
// and extended for ai-core):
//   1. rewrites relative `./foo.js` specifiers to `./foo.ts` when the .ts sibling
//      exists, so the NodeNext-style sources can be imported straight from `src/`
//      under `node --experimental-strip-types` (no build step);
//   2. resolves the bare workspace specifiers `@hotelos/<pkg>` to
//      `packages/<pkg>/src/index.ts`, mirroring the `paths` of tsconfig.base.json
//      (no package has a `dist/`, so Node's default resolution would fail).
// Registered by ./register-ts-loader.mjs; do not `--import` this file directly
// (an exported `resolve` is inert unless registered).

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

// packages/ai-core/src/__tests__/ts-hooks.mjs → <repo>/hotelos/
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

const WORKSPACE_ALIASES = {
  "@hotelos/ui/panels": "packages/ui/src/components/panels/index.ts"
};

function workspaceTarget(specifier) {
  const explicit = WORKSPACE_ALIASES[specifier];
  if (explicit) return `${REPO_ROOT}${explicit}`;
  const match = /^@hotelos\/([a-z0-9-]+)$/.exec(specifier);
  if (!match) return null;
  return `${REPO_ROOT}packages/${match[1]}/src/index.ts`;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@hotelos/")) {
    const target = workspaceTarget(specifier);
    if (target && existsSync(target)) {
      return nextResolve(pathToFileURL(target).href, context);
    }
  }
  if (specifier.endsWith(".js") && (specifier.startsWith("./") || specifier.startsWith("../"))) {
    try {
      const parent = context.parentURL ? fileURLToPath(context.parentURL) : process.cwd();
      const parentDir = parent.replace(/\/[^/]+$/, "");
      const tsPath = `${parentDir}/${specifier.slice(0, -3)}.ts`;
      if (existsSync(tsPath)) {
        return nextResolve(pathToFileURL(tsPath).href, context);
      }
    } catch {
      // Fall through to default resolution.
    }
  }
  return nextResolve(specifier, context);
}
