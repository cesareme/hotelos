// Tool use: tools[] y tool_choice en el cuerpo, bloques tool_use → toolUses,
// toolResultBlock para el turno siguiente y PII restaurada en toolUses.input.
//
// Run from the package directory: corepack pnpm --filter @hotelos/ai-core test

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveAiConfig } from "../config.ts";
import { createAiCore, toolResultBlock } from "../messages.ts";

globalThis.fetch = () => {
  throw new Error("red prohibida");
};

const CTX = { organizationId: "org_test", toolName: "checkInReservation", purpose: "complete" };
const TOOLS = [
  { name: "lookup_reservation", description: "Busca una reserva por huésped.", input_schema: { type: "object", additionalProperties: false, required: ["guest"], properties: { guest: { type: "string" }, email: { type: "string" } } } },
  { name: "create_task", description: "Crea una tarea de mantenimiento.", input_schema: { type: "object", additionalProperties: false, required: ["title"], properties: { title: { type: "string" } } } }
];

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function message(content, stopReason = "end_turn") {
  return json(200, { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5", content, stop_reason: stopReason, usage: { input_tokens: 30, output_tokens: 20 } });
}
function core(responders) {
  const calls = [];
  const ai = createAiCore({
    config: resolveAiConfig({ provider: "anthropic", apiKey: "sk-test", usdEurRate: "0.9" }),
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return responders.shift();
    },
    sleep: async () => undefined
  });
  return { ai, calls };
}

test("complete con tools y toolChoice: el cuerpo lleva tools[] y tool_choice; la respuesta tool_use rellena toolUses y stopReason", async () => {
  const { ai, calls } = core([
    message([{ type: "text", text: "Consulto la reserva." }, { type: "tool_use", id: "toolu_01", name: "lookup_reservation", input: { guest: "[NOMBRE_1]", email: "[EMAIL_1]" } }], "tool_use")
  ]);
  const result = await ai.complete({ system: "Eres recepcionista.", prompt: "Busca la reserva de la Sra. Ludmila Ferreiro (ana@example.com)." }, CTX, { tools: TOOLS, toolChoice: "auto" });
  const body = calls[0].body;
  assert.deepEqual(body.tools, TOOLS);
  assert.deepEqual(body.tool_choice, { type: "auto" });
  assert.equal(result.configured, true);
  assert.equal(result.stopReason, "tool_use");
  assert.equal(result.truncated, false);
  assert.equal(result.text, "Consulto la reserva.");
  assert.equal(result.toolUses.length, 1);
  assert.equal(result.toolUses[0].id, "toolu_01");
  assert.equal(result.toolUses[0].name, "lookup_reservation");
  assert.deepEqual(result.toolUses[0].input, { guest: "Ludmila Ferreiro", email: "ana@example.com" }, "PII restaurada en toolUses.input");
  assert.ok(!JSON.stringify(body.messages).includes("Ludmila"), "el nombre nunca viaja al proveedor");
});

test("toolChoice any/none/{name} se traducen a la forma del proveedor", async () => {
  const { ai, calls } = core([message([]), message([]), message([])]);
  await ai.complete({ prompt: "a" }, CTX, { tools: TOOLS, toolChoice: "any" });
  await ai.complete({ prompt: "a" }, CTX, { tools: TOOLS, toolChoice: "none" });
  await ai.complete({ prompt: "a" }, CTX, { tools: TOOLS, toolChoice: { name: "create_task" } });
  assert.deepEqual(calls[0].body.tool_choice, { type: "any" });
  assert.deepEqual(calls[1].body.tool_choice, { type: "none" });
  assert.deepEqual(calls[2].body.tool_choice, { type: "tool", name: "create_task" });
});

test("toolResultBlock construye el bloque tool_result (con is_error opcional) y el turno siguiente lo transporta", async () => {
  assert.deepEqual(toolResultBlock("toolu_01", "Reserva 123 encontrada"), { type: "tool_result", tool_use_id: "toolu_01", content: "Reserva 123 encontrada" });
  assert.deepEqual(toolResultBlock("toolu_02", [{ type: "text", text: "fallo" }], true), { type: "tool_result", tool_use_id: "toolu_02", content: [{ type: "text", text: "fallo" }], is_error: true });

  const { ai, calls } = core([message([{ type: "text", text: "La reserva de NOMBRE_1 está confirmada." }])]);
  const result = await ai.complete(
    {
      messages: [
        { role: "user", content: "Busca la reserva de la Sra. Ludmila Ferreiro." },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_01", name: "lookup_reservation", input: { guest: "Ludmila Ferreiro" } }] },
        { role: "user", content: [toolResultBlock("toolu_01", "Reserva 123 de Ludmila Ferreiro, confirmada")] }
      ]
    },
    CTX,
    { tools: TOOLS }
  );
  const sent = JSON.stringify(calls[0].body.messages);
  assert.ok(!sent.includes("Ludmila"), sent);
  assert.ok(sent.includes('"tool_result"'));
  assert.ok(sent.includes('"tool_use_id":"toolu_01"'));
  assert.equal(result.text, "La reserva de Ludmila Ferreiro está confirmada.");
});
