// Shared, framework-free onboarding AI engines used by both apps/api
// (stub mode) and apps/ai-gateway (real mode delegation). Keeping these pure
// here means the gateway and the API run the EXACT same extraction + mapping
// logic — no duplicated parsing code.

export * from "./types.js";
export * from "./csv-parser.js";
export * from "./extraction-engine.js";
export * from "./classifier-engine.js";
export * from "./mapping-engine.js";
