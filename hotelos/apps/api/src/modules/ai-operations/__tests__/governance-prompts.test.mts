// Tanda L6a (lote 4): prompts publicados. `promptFrom` de ai-core lee la versión
// publicada de ai_prompt_versions a través de la fuente que registra
// governance.service.ts (getPublishedPrompt → setAiPromptSource), la cachea 60 s
// por proceso y cae al texto por defecto cuando no hay fila o la fuente falla.
// Puro: fuente inyectada, sin Prisma ni red.
// From apps/api:
//   node --import tsx --test src/modules/ai-operations/__tests__/governance-prompts.test.mts
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createAiCore, PROMPT_CACHE_TTL_MS, resolveAiConfig } from "@hotelos/ai-core";
import { getAiCore, resetAiCoreForTests, setAiPromptSource } from "../../../lib/ai-client.js";
import { getPublishedPrompt } from "../governance.service.js";

globalThis.fetch = (() => {
  throw new Error("red prohibida en los tests de prompts publicados");
}) as typeof fetch;

const DEFAULT_TEXT = "Texto por defecto en código.";

afterEach(() => {
  setAiPromptSource(null);
  resetAiCoreForTests({ env: {} });
});

describe("promptFrom · versión publicada con caché de 60 s y respaldo al texto en código", () => {
  it("usa la versión publicada, la cachea 60 s (una sola lectura) y vuelve a leer al caducar", async () => {
    let now = 1_700_000_000_000;
    const reads: string[] = [];
    let published: string | null = "Versión publicada v2.";
    const core = createAiCore({
      config: resolveAiConfig({}),
      now: () => now,
      promptSource: {
        getPublishedPrompt: async (code) => {
          reads.push(code);
          return published;
        }
      }
    });
    assert.equal(await core.promptFrom("guest_message_reply", DEFAULT_TEXT), "Versión publicada v2.");
    assert.equal(await core.promptFrom("guest_message_reply", DEFAULT_TEXT), "Versión publicada v2.");
    assert.deepEqual(reads, ["guest_message_reply"], "la segunda llamada sale de la caché");

    now += PROMPT_CACHE_TTL_MS - 1;
    assert.equal(await core.promptFrom("guest_message_reply", DEFAULT_TEXT), "Versión publicada v2.");
    assert.equal(reads.length, 1, "dentro de los 60 s sigue en caché");

    published = "Versión publicada v3.";
    now += 2;
    assert.equal(await core.promptFrom("guest_message_reply", DEFAULT_TEXT), "Versión publicada v3.");
    assert.equal(reads.length, 2, "al caducar se vuelve a leer la fuente");
    assert.equal(PROMPT_CACHE_TTL_MS, 60_000);
  });

  it("sin fila publicada (null o texto vacío) o con la fuente rota cae al texto por defecto y también lo cachea", async () => {
    let now = 1_700_000_000_000;
    let calls = 0;
    const core = createAiCore({
      config: resolveAiConfig({}),
      now: () => now,
      promptSource: {
        getPublishedPrompt: async (code) => {
          calls += 1;
          if (code === "vacio") return "   ";
          if (code === "roto") throw new Error("base de datos caída");
          return null;
        }
      }
    });
    assert.equal(await core.promptFrom("sin_fila", DEFAULT_TEXT), DEFAULT_TEXT);
    assert.equal(await core.promptFrom("vacio", DEFAULT_TEXT), DEFAULT_TEXT);
    assert.equal(await core.promptFrom("roto", DEFAULT_TEXT), DEFAULT_TEXT);
    assert.equal(calls, 3);
    assert.equal(await core.promptFrom("sin_fila", DEFAULT_TEXT), DEFAULT_TEXT);
    assert.equal(calls, 3, "el «sin fila» también se cachea");
    now += PROMPT_CACHE_TTL_MS + 1;
    assert.equal(await core.promptFrom("sin_fila", "Otro texto por defecto."), "Otro texto por defecto.");
    assert.equal(calls, 4);
    const withoutSource = createAiCore({ config: resolveAiConfig({}) });
    assert.equal(await withoutSource.promptFrom("guest_message_reply", DEFAULT_TEXT), DEFAULT_TEXT, "sin fuente registrada: texto en código");
  });

  it("el núcleo del API delega en la fuente registrada con setAiPromptSource (gobernanza la registra al cargar)", async () => {
    assert.equal(typeof getPublishedPrompt, "function", "governance.service exporta getPublishedPrompt");
    resetAiCoreForTests({ env: {} });
    const codes: string[] = [];
    setAiPromptSource(async (code) => {
      codes.push(code);
      return code === "guest_message_reply" ? "Prompt publicado desde gobernanza." : null;
    });
    assert.equal(await getAiCore().promptFrom("guest_message_reply", DEFAULT_TEXT), "Prompt publicado desde gobernanza.");
    assert.equal(await getAiCore().promptFrom("draft_review_response", DEFAULT_TEXT), DEFAULT_TEXT);
    assert.deepEqual(codes, ["guest_message_reply", "draft_review_response"]);
    setAiPromptSource(null);
    resetAiCoreForTests({ env: {} });
    assert.equal(await getAiCore().promptFrom("guest_message_reply", DEFAULT_TEXT), DEFAULT_TEXT, "sin lector registrado vuelve al texto en código");
  });
});
