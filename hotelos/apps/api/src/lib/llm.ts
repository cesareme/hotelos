// LLM provider abstraction (P2 — real AI).
//
// This is the single seam where HotelOS talks to a real Large Language Model.
// It is configured entirely via environment variables and is SAFE BY DEFAULT:
// when no provider/key is configured (the dev default), `llmComplete` reports
// `configured: false` and every caller falls back to its deterministic logic, so
// the product keeps working with zero external dependencies. The moment an
// operator sets AI_PROVIDER + AI_PROVIDER_API_KEY, real inference lights up.
//
// Env:
//   AI_PROVIDER          "anthropic" | "openai" | "none" (default none)
//   AI_PROVIDER_API_KEY  provider API key ("change-me"/empty = not configured)
//   AI_MODEL             optional model override
//   AI_REQUEST_TIMEOUT_MS optional (default 20000)

export type LlmSuccess = {
  configured: true;
  text: string;
  provider: string;
  model: string;
  tokensInput: number;
  tokensOutput: number;
};
export type LlmNotConfigured = { configured: false; reason: string };
export type LlmResult = LlmSuccess | LlmNotConfigured;

const PLACEHOLDER_KEYS = new Set(["", "change-me", "changeme", "todo", "your-key-here"]);

function provider(): string {
  return (process.env.AI_PROVIDER ?? "none").trim().toLowerCase();
}
function apiKey(): string {
  return (process.env.AI_PROVIDER_API_KEY ?? "").trim();
}

/** True when a usable LLM provider + key are configured. */
export function isLlmConfigured(): boolean {
  const p = provider();
  if (p !== "anthropic" && p !== "openai") return false;
  const key = apiKey();
  return key.length > 0 && !PLACEHOLDER_KEYS.has(key.toLowerCase());
}

/** Provider name for /health and telemetry ("none" when unconfigured). */
export function llmProviderName(): string {
  return isLlmConfigured() ? provider() : "none";
}

export function llmModelName(): string {
  if (process.env.AI_MODEL && process.env.AI_MODEL.trim()) return process.env.AI_MODEL.trim();
  return provider() === "openai" ? "gpt-4o-mini" : "claude-3-5-sonnet-latest";
}

type CompleteInput = {
  system?: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
};

/**
 * Run a single completion. Returns `{ configured: false }` when no provider is
 * set up (caller should fall back). Throws only on a genuine provider/network
 * error when configured — callers catch and fall back, recording the failure.
 */
export async function llmComplete(input: CompleteInput): Promise<LlmResult> {
  if (!isLlmConfigured()) return { configured: false, reason: "AI provider not configured" };
  const timeoutMs = Number(process.env.AI_REQUEST_TIMEOUT_MS ?? 20000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return provider() === "openai"
      ? await callOpenAI(input, controller.signal)
      : await callAnthropic(input, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function callAnthropic(input: CompleteInput, signal: AbortSignal): Promise<LlmResult> {
  const model = llmModelName();
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey(),
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model,
      max_tokens: input.maxTokens ?? 400,
      temperature: input.temperature ?? 0.3,
      ...(input.system ? { system: input.system } : {}),
      messages: [{ role: "user", content: input.prompt }]
    })
  });
  if (!response.ok) {
    throw new Error(`Anthropic API error HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const data = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = (data.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
  return {
    configured: true,
    text,
    provider: "anthropic",
    model,
    tokensInput: data.usage?.input_tokens ?? 0,
    tokensOutput: data.usage?.output_tokens ?? 0
  };
}

// --- Vision: ID-document OCR -----------------------------------------------

export type DocFields = {
  documentType?: string;
  documentNumber?: string;
  documentSupportNumber?: string;
  firstName?: string;
  surname1?: string;
  surname2?: string;
  dateOfBirth?: string;
  nationality?: string;
  sex?: string;
};
export type LlmDocSuccess = {
  configured: true;
  fields: DocFields;
  provider: string;
  model: string;
  tokensInput: number;
  tokensOutput: number;
};
export type LlmDocResult = LlmDocSuccess | LlmNotConfigured;

const OCR_INSTRUCTION =
  "Eres un extractor de datos de documentos de identidad. Extrae los campos del documento (DNI, NIE, " +
  "pasaporte o TIE) de la imagen y devuelve EXCLUSIVAMENTE un objeto JSON válido, sin texto adicional, con " +
  "estas claves cuando aparezcan: documentType (uno de: DNI, NIE, PASSPORT, TIE), documentNumber, " +
  "documentSupportNumber, firstName, surname1, surname2, dateOfBirth (formato YYYY-MM-DD), nationality " +
  "(código ISO-3, p. ej. ESP), sex (M o F). Omite las claves que no puedas leer con seguridad. No inventes datos.";

function parseDataUrl(dataUrl: string): { mediaType: string; base64: string } | null {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl.trim());
  if (!m) return null;
  return { mediaType: m[1]!, base64: m[2]! };
}

function extractJson(text: string): DocFields {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return {};
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const pick = (k: string): string | undefined => {
      const v = obj[k];
      return typeof v === "string" && v.trim() ? v.trim() : undefined;
    };
    return {
      documentType: pick("documentType"),
      documentNumber: pick("documentNumber"),
      documentSupportNumber: pick("documentSupportNumber"),
      firstName: pick("firstName"),
      surname1: pick("surname1"),
      surname2: pick("surname2"),
      dateOfBirth: pick("dateOfBirth"),
      nationality: pick("nationality"),
      sex: pick("sex")
    };
  } catch {
    return {};
  }
}

/**
 * Extract ID-document fields from an image using a vision-capable model. Returns
 * `{ configured: false }` when no provider is set up (caller asks the user to
 * type the fields manually). Throws on a genuine provider error when configured.
 */
export async function llmExtractDocument(imageDataUrl: string): Promise<LlmDocResult> {
  if (!isLlmConfigured()) return { configured: false, reason: "AI provider not configured" };
  const parsed = parseDataUrl(imageDataUrl);
  if (!parsed) return { configured: false, reason: "Invalid image data URL" };
  const timeoutMs = Number(process.env.AI_REQUEST_TIMEOUT_MS ?? 20000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const model = llmModelName();
  try {
    let text = "";
    let tokensInput = 0;
    let tokensOutput = 0;
    if (provider() === "openai") {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey()}` },
        body: JSON.stringify({
          model,
          max_tokens: 500,
          temperature: 0,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: OCR_INSTRUCTION },
                { type: "image_url", image_url: { url: imageDataUrl } }
              ]
            }
          ]
        })
      });
      if (!response.ok) throw new Error(`OpenAI vision HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      text = data.choices?.[0]?.message?.content ?? "";
      tokensInput = data.usage?.prompt_tokens ?? 0;
      tokensOutput = data.usage?.completion_tokens ?? 0;
    } else {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey(),
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model,
          max_tokens: 500,
          temperature: 0,
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: parsed.mediaType, data: parsed.base64 } },
                { type: "text", text: OCR_INSTRUCTION }
              ]
            }
          ]
        })
      });
      if (!response.ok) throw new Error(`Anthropic vision HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const data = (await response.json()) as {
        content?: Array<{ type: string; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      tokensInput = data.usage?.input_tokens ?? 0;
      tokensOutput = data.usage?.output_tokens ?? 0;
    }
    return { configured: true, fields: extractJson(text), provider: provider(), model, tokensInput, tokensOutput };
  } finally {
    clearTimeout(timer);
  }
}

// --- Vision: generic image → JSON --------------------------------------------
// Used by the Compliance Center to read issue/expiry dates off a document photo.
export type LlmJsonSuccess = { configured: true; data: Record<string, unknown>; provider: string; model: string; tokensInput: number; tokensOutput: number };
export type LlmJsonResult = LlmJsonSuccess | LlmNotConfigured;

export async function llmExtractJsonFromImage(imageDataUrl: string, instruction: string): Promise<LlmJsonResult> {
  if (!isLlmConfigured()) return { configured: false, reason: "AI provider not configured" };
  const parsed = parseDataUrl(imageDataUrl);
  if (!parsed) return { configured: false, reason: "Invalid image data URL" };
  const timeoutMs = Number(process.env.AI_REQUEST_TIMEOUT_MS ?? 20000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const model = llmModelName();
  try {
    let text = "";
    let tokensInput = 0;
    let tokensOutput = 0;
    if (provider() === "openai") {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST", signal: controller.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey()}` },
        body: JSON.stringify({ model, max_tokens: 400, temperature: 0, messages: [{ role: "user", content: [{ type: "text", text: instruction }, { type: "image_url", image_url: { url: imageDataUrl } }] }] })
      });
      if (!response.ok) throw new Error(`OpenAI vision HTTP ${response.status}`);
      const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      text = data.choices?.[0]?.message?.content ?? "";
      tokensInput = data.usage?.prompt_tokens ?? 0; tokensOutput = data.usage?.completion_tokens ?? 0;
    } else {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", signal: controller.signal,
        headers: { "content-type": "application/json", "x-api-key": apiKey(), "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: 400, temperature: 0, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: parsed.mediaType, data: parsed.base64 } }, { type: "text", text: instruction }] }] })
      });
      if (!response.ok) throw new Error(`Anthropic vision HTTP ${response.status}`);
      const data = (await response.json()) as { content?: Array<{ type: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
      text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      tokensInput = data.usage?.input_tokens ?? 0; tokensOutput = data.usage?.output_tokens ?? 0;
    }
    let obj: Record<string, unknown> = {};
    const start = text.indexOf("{"); const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) { try { obj = JSON.parse(text.slice(start, end + 1)); } catch { obj = {}; } }
    return { configured: true, data: obj, provider: provider(), model, tokensInput, tokensOutput };
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAI(input: CompleteInput, signal: AbortSignal): Promise<LlmResult> {
  const model = llmModelName();
  const messages: Array<{ role: string; content: string }> = [];
  if (input.system) messages.push({ role: "system", content: input.system });
  messages.push({ role: "user", content: input.prompt });
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey()}`
    },
    body: JSON.stringify({
      model,
      max_tokens: input.maxTokens ?? 400,
      temperature: input.temperature ?? 0.3,
      messages
    })
  });
  if (!response.ok) {
    throw new Error(`OpenAI API error HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = (data.choices?.[0]?.message?.content ?? "").trim();
  return {
    configured: true,
    text,
    provider: "openai",
    model,
    tokensInput: data.usage?.prompt_tokens ?? 0,
    tokensOutput: data.usage?.completion_tokens ?? 0
  };
}
