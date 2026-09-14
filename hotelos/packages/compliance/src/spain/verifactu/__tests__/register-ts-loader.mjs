// Entry point for `node --import`: registers ./ts-hooks.mjs as an ESM
// customization hook (Node ≥ 20.6 ignores hooks that are merely exported by
// an `--import`ed module — they must go through module.register()).
//
// Run every VeriFactu suite from the repo root with:
//   node --experimental-strip-types --import \
//     ./packages/compliance/src/spain/verifactu/__tests__/register-ts-loader.mjs \
//     --test packages/compliance/src/spain/verifactu/__tests__/*.test.mjs \
//            packages/compliance/src/spain/verifactu/timestamp/__tests__/*.test.mjs

import { register } from "node:module";

register("./ts-hooks.mjs", import.meta.url);
