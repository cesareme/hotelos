// Tanda CHK · W2-D — plantillas de sistema del check-in automatizado y
// proveedor de WhatsApp con plantillas aprobadas. Sin base de datos ni red:
//   node --import tsx --test src/modules/notifications/__tests__/checkin-templates.test.mts
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BRAND } from "../../../lib/brand.js";
import { SYSTEM_TEMPLATES, resolveSystemTemplate, systemTemplateToRecord } from "../system-templates.js";
import { listTemplateTokensForTemplate, renderTemplate } from "../template-renderer.service.js";
import { pickTemplate, type NotificationTemplateRow } from "../templates.service.js";
import { buildWhatsappPayload, isWhatsappConfigured, send as sendWhatsapp } from "../providers/whatsapp.provider.js";
import type { ProviderSendInput } from "../providers/types.js";

const CHECKIN_CODES = ["checkin_invitation", "checkin_reminder", "checkin_welcome", "checkin_otp"] as const;
const CHECKIN_VARIABLES = new Set([
  "guestFirstName",
  "propertyName",
  "arrivalDate",
  "checkInUrl",
  "roomNumber",
  "wifiName",
  "wifiPassword",
  "breakfastHours",
  "otpCode",
  "botUrl"
]);

const checkinTemplates = SYSTEM_TEMPLATES.filter((tpl) => (CHECKIN_CODES as readonly string[]).includes(tpl.code));

describe("system templates — check-in automatizado (W2-D)", () => {
  it("resolveSystemTemplate devuelve checkin_invitation email es (y en) y whatsapp es", () => {
    const emailEs = resolveSystemTemplate({ code: "checkin_invitation", channel: "email" });
    assert.ok(emailEs);
    assert.equal(emailEs.language, "es");
    assert.equal(emailEs.channel, "email");
    assert.match(emailEs.body, /\{\{checkInUrl\}\}/);
    assert.match(emailEs.subject, /\{\{propertyName\}\}/);

    const emailEn = resolveSystemTemplate({ code: "checkin_invitation", channel: "email", language: "en" });
    assert.ok(emailEn);
    assert.equal(emailEn.language, "en");
    assert.match(emailEn.body, /check in/i);

    // Idioma sin plantilla propia → cae en «es», nunca null.
    assert.equal(resolveSystemTemplate({ code: "checkin_invitation", channel: "email", language: "fr" })?.language, "es");

    const wa = resolveSystemTemplate({ code: "checkin_invitation", channel: "whatsapp" });
    assert.ok(wa);
    assert.equal(wa.channel, "whatsapp");
    assert.equal(wa.subject, "");
    assert.match(wa.body, /\{\{checkInUrl\}\}/);
  });

  it("cubre exactamente las combinaciones código/canal/idioma del lote", () => {
    const keys = checkinTemplates.map((tpl) => `${tpl.code}:${tpl.channel}:${tpl.language}`).sort();
    assert.deepEqual(keys, [
      "checkin_invitation:email:en",
      "checkin_invitation:email:es",
      "checkin_invitation:whatsapp:es",
      "checkin_otp:email:es",
      "checkin_otp:sms:es",
      "checkin_reminder:email:es",
      "checkin_reminder:whatsapp:es",
      "checkin_welcome:email:es",
      "checkin_welcome:sms:es",
      "checkin_welcome:whatsapp:es"
    ]);
    // Las dos plantillas previas (Tanda 3) siguen en cabeza, intactas.
    assert.equal(SYSTEM_TEMPLATES[0]?.code, "user_invitation");
    assert.equal(SYSTEM_TEMPLATES[1]?.code, "password_reset");
  });

  it("guest_magic_link sigue siendo null en todos los canales", () => {
    for (const channel of ["email", "whatsapp", "sms"]) {
      assert.equal(resolveSystemTemplate({ code: "guest_magic_link", channel }), null, channel);
    }
    assert.equal(pickTemplate([], { code: "guest_magic_link", channel: "email" }), null);
  });

  it("todas las variables declaradas aparecen en el cuerpo y el cuerpo no usa variables sin declarar", () => {
    for (const tpl of checkinTemplates) {
      const label = `${tpl.code}:${tpl.channel}:${tpl.language}`;
      const bodyTokens = new Set(listTemplateTokensForTemplate({ body: tpl.body }));
      for (const variable of tpl.variables) {
        assert.ok(bodyTokens.has(variable), `${label}: {{${variable}}} declarada pero ausente del cuerpo`);
        assert.ok(CHECKIN_VARIABLES.has(variable), `${label}: variable fuera del vocabulario del lote: ${variable}`);
      }
      for (const token of listTemplateTokensForTemplate({ body: tpl.body, subject: tpl.subject })) {
        assert.ok(tpl.variables.includes(token), `${label}: {{${token}}} usada sin declarar`);
      }
      assert.equal(tpl.body.includes("<"), false, `${label}: texto plano, sin HTML`);
      // El record sintético lista los mismos tokens (lo que ve el admin).
      const record = systemTemplateToRecord(tpl);
      assert.equal(record.id, `system:${tpl.code}:${tpl.channel}:${tpl.language}`);
      assert.deepEqual(record.tokens, listTemplateTokensForTemplate({ body: tpl.body, subject: tpl.subject }));
    }
  });

  it("la marca solo aparece en el pie y la bienvenida avisa de la IA (art. 50) al enlazar al bot", () => {
    for (const tpl of checkinTemplates) {
      const label = `${tpl.code}:${tpl.channel}:${tpl.language}`;
      const lines = tpl.body.split("\n");
      const brandLines = lines.map((line, i) => (line.includes(BRAND.name) ? i : -1)).filter((i) => i >= 0);
      assert.deepEqual(brandLines, [lines.length - 1], `${label}: la marca «${BRAND.name}» solo en la última línea`);
      assert.equal(tpl.subject.includes(BRAND.name), false, `${label}: sin marca en el asunto`);
    }
    for (const tpl of checkinTemplates.filter((t) => t.code === "checkin_welcome")) {
      const label = `${tpl.code}:${tpl.channel}`;
      assert.match(tpl.body, /\{\{\s*botUrl/, `${label}: enlaza al bot`);
      assert.match(tpl.body, /inteligencia artificial|asistente de IA/i, `${label}: aviso de IA`);
      assert.match(tpl.body, /persona/i, `${label}: ofrece hablar con una persona`);
      assert.match(tpl.body, /\{\{\s*roomNumber/, `${label}: número de habitación`);
      assert.match(tpl.body, /\{\{\s*wifiName/, `${label}: wifi`);
      assert.match(tpl.body, /\{\{\s*breakfastHours/, `${label}: horario`);
    }
  });

  it("la bienvenida se renderiza sin huecos cuando faltan habitación, wifi, horario o bot", () => {
    const tpl = resolveSystemTemplate({ code: "checkin_welcome", channel: "whatsapp" });
    assert.ok(tpl);
    const { body } = renderTemplate({
      template: { body: tpl.body },
      variables: { guestFirstName: "Prueba", propertyName: "Hotel Ensayo", roomNumber: "", wifiName: "", wifiPassword: "", breakfastHours: "", botUrl: "" }
    });
    assert.match(body, /Hola Prueba, ¡bienvenido\/a a Hotel Ensayo!/);
    assert.match(body, /recepción/);
    assert.doesNotMatch(body, /\{\{/);
    assert.doesNotMatch(body, /: \./, "ningún dato vacío deja «: .»");

    const full = renderTemplate({
      template: { body: tpl.body },
      variables: { guestFirstName: "Prueba", propertyName: "Hotel Ensayo", roomNumber: "312", wifiName: "Ensayo-Guest", wifiPassword: "abc123", breakfastHours: "7:30-10:30", botUrl: "https://stay.example.com/?property=prop_1" }
    }).body;
    assert.match(full, /Habitación: 312\./);
    assert.match(full, /Wifi: Ensayo-Guest · contraseña: abc123\./);
    assert.match(full, /https:\/\/stay\.example\.com\/\?property=prop_1/);
  });

  it("pickTemplate prefiere la fila de BD sobre la de sistema", () => {
    const NOW = new Date("2026-09-19T10:00:00.000Z");
    const orgRow: NotificationTemplateRow = {
      id: "tpl_org_welcome",
      organizationId: "org_1",
      propertyId: null,
      code: "checkin_welcome",
      channel: "whatsapp",
      language: "es",
      subject: null,
      body: "Bienvenida propia {{guestFirstName}} {{roomNumber}}",
      variablesJson: null,
      active: true,
      createdAt: NOW,
      updatedAt: NOW
    };
    const system = pickTemplate([], { code: "checkin_welcome", channel: "whatsapp", language: "es" });
    assert.equal(system?.id, "system:checkin_welcome:whatsapp:es");
    assert.equal(system?.organizationId, "system");

    const picked = pickTemplate([orgRow], { code: "checkin_welcome", channel: "whatsapp", language: "es" });
    assert.equal(picked?.id, "tpl_org_welcome");
    assert.equal(picked?.organizationId, "org_1");

    // Con propiedad: la fila de la propiedad gana a la de la organización y ambas a la de sistema.
    const propertyRow = { ...orgRow, id: "tpl_prop_welcome", propertyId: "prop_1" };
    assert.equal(pickTemplate([orgRow, propertyRow], { propertyId: "prop_1", code: "checkin_welcome", channel: "whatsapp" })?.id, "tpl_prop_welcome");
  });
});

describe("whatsapp provider — plantillas aprobadas (W2-D)", () => {
  const ENV_KEYS = ["WHATSAPP_PHONE_ID", "WHATSAPP_PROVIDER_TOKEN", "WHATSAPP_TOKEN", "NODE_ENV"] as const;
  let envBackup: Record<string, string | undefined> = {};
  let fetchBackup: typeof fetch;

  beforeEach(() => {
    envBackup = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    fetchBackup = globalThis.fetch;
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (envBackup[key] === undefined) delete process.env[key];
      else process.env[key] = envBackup[key];
    }
    globalThis.fetch = fetchBackup;
  });

  type Captured = { url: string; init: RequestInit; body: Record<string, unknown> };
  function fakeFetch(captured: Captured[], response: { status?: number; json: unknown } = { json: { messages: [{ id: "wamid.TEST" }] } }): typeof fetch {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      captured.push({ url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify(response.json), { status: response.status ?? 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
  }

  it("con template envía type template (fetch doble) con name, language.code y components", async () => {
    process.env.WHATSAPP_PHONE_ID = "123456789";
    process.env.WHATSAPP_PROVIDER_TOKEN = "token-de-prueba";
    delete process.env.NODE_ENV;
    assert.equal(isWhatsappConfigured(), true);
    const captured: Captured[] = [];
    globalThis.fetch = fakeFetch(captured);

    const input: ProviderSendInput = {
      recipient: "+34600000000",
      body: "Texto libre que NO debe viajar cuando hay plantilla",
      template: {
        name: "checkin_invitation",
        language: "es",
        components: [{ type: "body", parameters: [{ type: "text", text: "Prueba" }] }]
      }
    };
    const result = await sendWhatsapp(input);
    assert.deepEqual(result, { status: "sent", providerMessageId: "wamid.TEST" });
    assert.equal(captured.length, 1);
    const call = captured[0]!;
    assert.equal(call.url, "https://graph.facebook.com/v19.0/123456789/messages");
    assert.equal(call.init.method, "POST");
    assert.equal((call.init.headers as Record<string, string>).Authorization, "Bearer token-de-prueba");
    assert.equal(call.body.messaging_product, "whatsapp");
    assert.equal(call.body.to, "34600000000");
    assert.equal(call.body.type, "template");
    assert.deepEqual(call.body.template, {
      name: "checkin_invitation",
      language: { code: "es" },
      components: [{ type: "body", parameters: [{ type: "text", text: "Prueba" }] }]
    });
    assert.equal("text" in call.body, false, "sin cuerpo de texto cuando va plantilla");
  });

  it("sin template sigue enviando type text (dentro de la ventana de 24 h)", async () => {
    process.env.WHATSAPP_PHONE_ID = "123456789";
    process.env.WHATSAPP_PROVIDER_TOKEN = "token-de-prueba";
    delete process.env.NODE_ENV;
    const captured: Captured[] = [];
    globalThis.fetch = fakeFetch(captured);

    const result = await sendWhatsapp({ recipient: "+34600000000", body: "Hola" });
    assert.equal(result.status, "sent");
    assert.equal(captured[0]!.body.type, "text");
    assert.deepEqual(captured[0]!.body.text, { body: "Hola" });
    assert.equal("template" in captured[0]!.body, false);

    // Los componentes vacíos no viajan (Meta rechaza `components: []`).
    const payload = buildWhatsappPayload({ recipient: "+34600000000", body: "x", template: { name: "t", language: "es", components: [] } });
    assert.deepEqual(payload, { messaging_product: "whatsapp", to: "34600000000", type: "template", template: { name: "t", language: { code: "es" } } });
  });

  it("sin WHATSAPP_PHONE_ID el envío es simulated fuera de producción y failed en producción, sin tocar fetch", async () => {
    delete process.env.WHATSAPP_PHONE_ID;
    process.env.WHATSAPP_PROVIDER_TOKEN = "token-de-prueba";
    delete process.env.NODE_ENV;
    assert.equal(isWhatsappConfigured(), false);
    const captured: Captured[] = [];
    globalThis.fetch = fakeFetch(captured);

    const simulated = await sendWhatsapp({ recipient: "+34600000000", body: "Hola", template: { name: "checkin_welcome", language: "es" } });
    assert.equal(simulated.status, "sent");
    assert.equal(simulated.simulated, true);
    assert.match(simulated.providerMessageId ?? "", /^simulated_wa_/);
    assert.equal(captured.length, 0);

    process.env.NODE_ENV = "production";
    const failed = await sendWhatsapp({ recipient: "+34600000000", body: "Hola" });
    assert.equal(failed.status, "failed");
    assert.equal(failed.simulated, undefined);
    assert.match(failed.error ?? "", /not configured/);
    assert.equal(captured.length, 0);
  });

  it("valida el destinatario y el nombre de la plantilla antes de llamar a Meta", async () => {
    process.env.WHATSAPP_PHONE_ID = "123456789";
    process.env.WHATSAPP_PROVIDER_TOKEN = "token-de-prueba";
    const captured: Captured[] = [];
    globalThis.fetch = fakeFetch(captured);
    assert.equal((await sendWhatsapp({ recipient: "600000000", body: "x" })).status, "failed");
    assert.equal((await sendWhatsapp({ recipient: "+34600000000", body: "x", template: { name: "  ", language: "es" } })).status, "failed");
    assert.equal(captured.length, 0);

    globalThis.fetch = fakeFetch(captured, { status: 400, json: { error: { message: "Template name does not exist" } } });
    const rejected = await sendWhatsapp({ recipient: "+34600000000", body: "x", template: { name: "no_existe", language: "es" } });
    assert.equal(rejected.status, "failed");
    assert.match(rejected.error ?? "", /HTTP 400: Template name does not exist/);
  });
});
