// Suites de evaluación por prompt (clave = promptCode, lo que lee
// runEvaluation en apps/api/src/modules/ai-operations/governance.service.ts) y
// puntuación determinista de cada caso sobre la salida REAL del modelo: sin
// LLM juez, 100 si pasa y 40 si no (como hoy scoreReplyCase).

import analyzeReviewSentiment from "./analyze_review_sentiment.json" with { type: "json" };
import draftReviewResponse from "./draft_review_response.json" with { type: "json" };
import guestMessageReply from "./guest_message_reply.json" with { type: "json" };

export type EvalPattern = string | { pattern: string; flags?: string; reason?: string };

export type EvalExpectation = {
  /** Longitud máxima en caracteres (defecto 800). */
  maxChars?: number;
  /** Número máximo de palabras. */
  maxWords?: number;
  /** Expresiones regulares que la salida NO debe cumplir. */
  mustNotMatch?: EvalPattern[];
  /** Expresiones regulares que la salida SÍ debe cumplir. */
  mustMatch?: EvalPattern[];
};

export type EvalCase = { input: string; expect: EvalExpectation };
export type EvalSuite = { promptCode: string; system: string; cases: EvalCase[] };
export type EvalScore = { passed: boolean; score: number; reasons: string[] };

export const EVAL_PASS_SCORE = 100;
export const EVAL_FAIL_SCORE = 40;
export const EVAL_DEFAULT_MAX_CHARS = 800;

function asSuite(raw: unknown): EvalSuite {
  const suite = raw as EvalSuite;
  if (!suite || typeof suite.promptCode !== "string" || typeof suite.system !== "string" || !Array.isArray(suite.cases)) {
    throw new Error("Suite de evaluación mal formada: se esperaban promptCode, system y cases.");
  }
  return suite;
}

const SUITES: EvalSuite[] = [asSuite(guestMessageReply), asSuite(draftReviewResponse), asSuite(analyzeReviewSentiment)];

/** Suites disponibles, indexadas por promptCode. */
export const EVAL_SUITES: Readonly<Record<string, EvalSuite>> = Object.freeze(Object.fromEntries(SUITES.map((suite) => [suite.promptCode, suite])));

export const EVAL_PROMPT_CODES: readonly string[] = Object.freeze(SUITES.map((suite) => suite.promptCode));

export function getEvalSuite(promptCode: string): EvalSuite | null {
  return EVAL_SUITES[promptCode] ?? null;
}

export function compileEvalPattern(entry: EvalPattern): { regex: RegExp; reason: string | null } {
  if (typeof entry === "string") return { regex: new RegExp(entry, "iu"), reason: null };
  return { regex: new RegExp(entry.pattern, entry.flags ?? "u"), reason: entry.reason ?? null };
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Puntuación determinista de una salida real frente a la expectativa del caso (pura, sin red). */
export function scoreCase(output: string, expect: EvalExpectation = {}): EvalScore {
  const reasons: string[] = [];
  const text = (output ?? "").trim();
  if (text.length === 0) {
    return { passed: false, score: EVAL_FAIL_SCORE, reasons: ["respuesta vacía"] };
  }
  const maxChars = expect.maxChars ?? EVAL_DEFAULT_MAX_CHARS;
  if (text.length > maxChars) reasons.push("demasiado larga");
  if (typeof expect.maxWords === "number") {
    const words = countWords(text);
    if (words > expect.maxWords) reasons.push(`demasiadas palabras (${words} > ${expect.maxWords})`);
  }
  for (const entry of expect.mustNotMatch ?? []) {
    const { regex, reason } = compileEvalPattern(entry);
    if (regex.test(text)) reasons.push(reason ?? `contiene un patrón prohibido (${regex.source})`);
  }
  for (const entry of expect.mustMatch ?? []) {
    const { regex, reason } = compileEvalPattern(entry);
    if (!regex.test(text)) reasons.push(reason ?? `falta un patrón esperado (${regex.source})`);
  }
  const passed = reasons.length === 0;
  return { passed, score: passed ? EVAL_PASS_SCORE : EVAL_FAIL_SCORE, reasons };
}
