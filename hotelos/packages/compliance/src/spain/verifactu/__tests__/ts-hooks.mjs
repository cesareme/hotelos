// ESM resolve hook: rewrites relative `./foo.js` specifiers to `./foo.ts` when
// the .ts sibling exists, so the NodeNext-style sources of this package can be
// imported straight from `src/` under `node --experimental-strip-types`
// (no build step). Registered by ./register-ts-loader.mjs; do not `--import`
// this file directly (an exported `resolve` is inert unless registered).

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function resolve(specifier, context, nextResolve) {
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
