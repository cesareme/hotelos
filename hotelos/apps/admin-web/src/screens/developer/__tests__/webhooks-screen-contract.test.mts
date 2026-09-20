import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// FIX-1 · F7 (Configuración › Sistema › Webhooks): the screen reaches
// api-client (import.meta.env) and cannot load under node --test, so the lot
// is pinned on the source, like sage200-import-screen-contract.test.mts:
//   (1) every subscription created from the screen travels with the ACTIVE
//       property (the tenant guard of apps/api/src/lib/tenancy.ts resolves it,
//       so Pausar / Eliminar / entregas / prueba answer 200 instead of the 404
//       «Suscripción de webhook no encontrada.»);
//   (2) the URL placeholder carries the brand path `/ehotelos/webhook`;
//   (3) no legacy brand in rendered literals;
//   (4) the signature header keeps its REAL protocol name
//       `X-HotelOS-Signature` (webhooks.service.ts sends it; D7 identifier
//       allowed by tests/brand-contract.test.mjs) and the text says so;
//   (5) Cocoa 22: no new inline styles, no raw controls.

const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const count = (src: string, re: RegExp) => (src.match(re) ?? []).length;
/** Source without comments: only rendered code is checked. */
const stripComments = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

const screen = stripComments(source("../WebhooksAdminScreen.tsx"));
const service = stripComments(source("../../../services/webhooksApi.ts"));
const apiService = stripComments(source("../../../../../api/src/modules/webhooks/webhooks.service.ts"));

describe("Configuración › Sistema › Webhooks · pantalla (FIX-1 · F7)", () => {
  it("crea la suscripción con la propiedad activa (propertyId: getActivePropertyId())", () => {
    assert.match(screen, /import \{ getActivePropertyId \} from "\.\.\/\.\.\/services\/activeProperty";/);
    assert.match(screen, /createSubscription\(\{[^}]*propertyId: getActivePropertyId\(\)[^}]*\}\)/);
    assert.match(service, /export function createSubscription\(payload: \{\s*propertyId\?: string \| null;/, "el cliente acepta propertyId");
  });

  it("placeholder de la URL con la ruta de marca /ehotelos/webhook", () => {
    assert.match(screen, /placeholder="https:\/\/partner\.example\.com\/ehotelos\/webhook"/);
    assert.equal(count(screen, /placeholder=/g), 1, "un único placeholder (la URL de destino)");
  });

  it("sin marca heredada en literales visibles (solo la cabecera de protocolo lleva HotelOS)", () => {
    assert.doesNotMatch(screen, /anfitorio/i);
    const withoutProtocolHeaders = screen.replace(/X-HotelOS-[A-Za-z]+/g, "");
    assert.doesNotMatch(withoutProtocolHeaders, /HotelOS/);
  });

  it("conserva la cabecera real X-HotelOS-Signature (la que envía el API) y aclara que es un nombre técnico heredado", () => {
    assert.match(
      screen,
      /<code className="cocoa-mono">X-HotelOS-Signature<\/code> \(nombre técnico heredado del protocolo, no cambia con la marca; formato <code className="cocoa-mono">sha256=…<\/code>\)/
    );
    assert.match(apiService, /"X-HotelOS-Signature": signature/, "el nombre de la cabecera es el que envía webhooks.service.ts");
  });

  it("Cocoa 22: sin style= inline nuevos (los 2 overflow: clip previos) ni controles crudos", () => {
    assert.equal(count(screen, /\bstyle=\{\{/g), 2);
    assert.doesNotMatch(screen, /<button\b|<table\b|<(?:input|select|textarea)\b/);
    assert.doesNotMatch(screen, /\bfetch\s*\(/, "sin fetch crudo");
  });
});
