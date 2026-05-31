// Lightweight Zod validation helper for Fastify route handlers.
//
// We don't yet wire `@fastify/type-provider-zod` globally (would touch 695
// handlers); instead this helper validates request body/query at handler
// boundary and throws a typed BadRequestError that the existing global error
// handler converts to a 400 with structured details.
//
// Usage:
//   const Body = z.object({ amount: z.number().positive(), folioId: z.string().cuid() });
//   app.post("/foo", async (request) => {
//     const body = parse(Body, request.body, "body");
//     // body is fully typed now.
//   });

import type { ZodSchema, ZodIssue } from "zod";
import { BadRequestError } from "./http-error.js";

export function parse<T>(schema: ZodSchema<T>, value: unknown, label: "body" | "query" | "params" = "body"): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const message = result.error.issues.map(formatIssue).join("; ");
  throw new BadRequestError(`Validation failed (${label}): ${message}`);
}

function formatIssue(issue: ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join(".") + ": " : "";
  return `${path}${issue.message}`;
}
