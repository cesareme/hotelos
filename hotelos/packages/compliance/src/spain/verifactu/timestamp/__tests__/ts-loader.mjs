// Tiny ESM resolver hook that rewrites local `.js` imports to `.ts` for files
// that live inside the compliance package's `src/` tree. Combined with
// `node --experimental-strip-types`, this lets the test suite import the
// signer (which uses NodeNext `./foo.js` import specifiers) directly from
// source without needing a build step.

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
