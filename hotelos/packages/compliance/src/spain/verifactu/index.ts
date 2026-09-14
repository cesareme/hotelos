// VeriFactu (RD 1007/2023 · Orden HAC/1177/2024) — canonical barrel.
// spain/index.ts currently re-exports hash/xml/submitter/xades-signer/timestamp
// one by one; it can switch to `export * from "./verifactu/index.js"` whenever
// its owner lot touches it (software.ts is meanwhile re-exported via
// submitter.ts, so nothing is missing from @hotelos/compliance).
export * from "./hash.js";
export * from "./xml.js";
export * from "./software.js";
export * from "./submitter.js";
export * from "./xades-signer.js";
export * from "./timestamp/index.js";
