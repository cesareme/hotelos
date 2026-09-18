// Entry point for `node --import`: registers ./ts-hooks.mjs as an ESM
// customization hook (Node ≥ 20.6 ignores hooks that are merely exported by
// an `--import`ed module — they must go through module.register()).
//
// Run every ai-core suite from the package directory with:
//   corepack pnpm --filter @hotelos/ai-core test
// or, from the repo root:
//   node --experimental-strip-types --import \
//     ./packages/ai-core/src/__tests__/register-ts-loader.mjs \
//     --test 'packages/ai-core/src/**/__tests__/*.test.mjs'

import { register } from "node:module";

register("./ts-hooks.mjs", import.meta.url);
