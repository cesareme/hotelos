// Redacción reversible de PII con nombres inventados. Sin red.
//
// Run from the package directory: corepack pnpm --filter @hotelos/ai-core test

import { test } from "node:test";
import assert from "node:assert/strict";

import { createPiiRedactor, redactPii, restorePii, restorePiiDeep } from "../redaction.ts";

globalThis.fetch = () => {
  throw new Error("red prohibida");
};

const SAMPLE =
  "Buenas tardes, soy la Sra. Ludmila Ferreiro (DNI 12345678Z, NIE de mi marido X1234567L). " +
  "Mi teléfono es +34 612 345 678 y el correo ana@example.com. Pagaré con la tarjeta 4111 1111 1111 1111. " +
  "Repito el correo por si acaso: ana@example.com. Gracias, Ludmila.";

test("ida y vuelta: cada dato recibe su marcador y restorePii devuelve el texto original", () => {
  const { text, map, count } = redactPii(SAMPLE);
  assert.ok(!text.includes("Ludmila Ferreiro"), text);
  assert.ok(!text.includes("12345678Z"));
  assert.ok(!text.includes("X1234567L"));
  assert.ok(!text.includes("612 345 678"));
  assert.ok(!text.includes("ana@example.com"));
  assert.ok(!text.includes("4111"));
  assert.match(text, /Sra\. \[NOMBRE_1\]/);
  assert.match(text, /DNI \[DOC_1\], NIE de mi marido \[DOC_2\]/);
  assert.match(text, /teléfono es \[TEL_1\]/);
  assert.match(text, /tarjeta \[TARJETA_1\]/);
  assert.equal(map.NOMBRE_1, "Ludmila Ferreiro");
  assert.equal(map.DOC_1, "12345678Z");
  assert.equal(map.DOC_2, "X1234567L");
  assert.equal(map.TEL_1, "+34 612 345 678");
  assert.equal(map.EMAIL_1, "ana@example.com");
  assert.equal(map.TARJETA_1, "4111 1111 1111 1111");
  assert.equal(count, 6);
  assert.equal(restorePii(text, map), SAMPLE);
});

test("misma cadena → mismo marcador (el correo repetido no crea EMAIL_2)", () => {
  const { text, map } = redactPii(SAMPLE);
  assert.equal((text.match(/\[EMAIL_1\]/g) ?? []).length, 2);
  assert.equal("EMAIL_2" in map, false);
  const { text: t2, map: m2 } = redactPii("Correo ANA@example.com y ana@example.com");
  assert.equal(t2, "Correo [EMAIL_1] y [EMAIL_1]");
  assert.equal(m2.EMAIL_1, "ANA@example.com");
});

test("idempotencia: redactar un texto ya redactado no cambia nada ni crea marcadores", () => {
  const first = redactPii(SAMPLE);
  const second = redactPii(first.text);
  assert.equal(second.text, first.text);
  assert.equal(second.count, 0);
});

test("texto sin PII intacto (fechas, horas, cantidades, localizadores)", () => {
  const plain = "Reserva HTL-2026-0917 confirmada para el 18/09/2026 a las 15:00: 2 adultos, 3 noches, 450 euros en total.";
  const { text, count } = redactPii(plain);
  assert.equal(text, plain);
  assert.equal(count, 0);
});

test("nunca sobre base64: URL de datos y bloques base64 largos quedan intactos", () => {
  const dataUrl = "data:image/jpeg;base64," + "QUJD".repeat(60) + "==";
  const blob = "ZZ1234567" + "x".repeat(80); // token largo sin espacios, parece pasaporte al inicio
  const input = `Adjunto ${dataUrl} y ${blob} fin`;
  const { text, count } = redactPii(input);
  assert.equal(text, input);
  assert.equal(count, 0);
});

test("teléfonos internacionales y nacionales con separadores; pasaportes; cartas y tarjetas inválidas no se tocan", () => {
  const { text, map } = redactPii("Llámame al 0044 20 7946 0958 o al 912.345.678; pasaporte PAB123456 o AB1234567. DNI erróneo 12345678A y tarjeta falsa 4111 1111 1111 1112.");
  assert.equal(map.TEL_1, "0044 20 7946 0958");
  assert.equal(map.TEL_2, "912.345.678");
  assert.equal(map.DOC_1, "PAB123456");
  assert.equal(map.DOC_2, "AB1234567");
  assert.ok(text.includes("12345678A"), "la letra de control no coincide: no es un NIF válido");
  assert.ok(text.includes("4111 1111 1111 1112"), "no cumple Luhn: no es un PAN");
});

test("nombres tras Don/Doña/D./Dña. (máximo tres tokens) y números de habitación opcionales", () => {
  const { text, map } = redactPii("Don Ludovico Ferreiro Souto Abreu llega hoy; Dña. Aurelia irá a la habitación 204 y Room 12B.", { roomNumbers: true });
  assert.equal(map.NOMBRE_1, "Ludovico Ferreiro Souto");
  assert.equal(map.NOMBRE_2, "Aurelia");
  assert.equal(map.HAB_1, "204");
  assert.equal(map.HAB_2, "12B");
  assert.equal(text, "Don [NOMBRE_1] Abreu llega hoy; Dña. [NOMBRE_2] irá a la habitación [HAB_1] y Room [HAB_2].");
  // Sin la opción, las habitaciones no se tocan.
  assert.ok(redactPii("habitación 204").text.includes("204"));
});

test("nombres sin tratamiento tras fórmulas de presentación y despedida (SEC-07 / CFC-09)", () => {
  const { text, map, count } = redactPii("Hola, soy Ludmila Ferreiro y llego el viernes; mi mujer se llama Aurelia Souto y viene mi hija Aroa Ferreiro. Atentamente, Ludmila Ferreiro");
  assert.equal(count, 3);
  assert.equal(map.NOMBRE_1, "Ludmila Ferreiro");
  assert.equal(map.NOMBRE_2, "Aurelia Souto");
  assert.equal(map.NOMBRE_3, "Aroa Ferreiro");
  assert.equal(text, "Hola, soy [NOMBRE_1] y llego el viernes; mi mujer se llama [NOMBRE_2] y viene mi hija [NOMBRE_3]. Atentamente, [NOMBRE_1]");
  // Tras «soy» sin mayúscula no hay nombre; un tratamiento tras «Firmado:» lo resuelve el detector de tratamientos.
  assert.equal(redactPii("soy de Lugo y me llamo así").count, 0);
  assert.equal(redactPii("Firmado: Sra. Ludmila Ferreiro").text, "Firmado: Sra. [NOMBRE_1]");
  assert.equal(redactPii("Reserva a nombre de Bautista Lorenzo, llegada mañana.").text, "Reserva a nombre de [NOMBRE_1], llegada mañana.");
});

test("knownPii siembra la PII conocida del huésped: se sustituye aunque aparezca sin tratamiento ni formato (SEC-07)", () => {
  const redactor = createPiiRedactor({ knownPii: [{ kind: "name", value: "Ludmila Ferreiro" }, { kind: "phone", value: "612 345 678" }, { kind: "email", value: "ana@example.com" }, { kind: "name", value: "Al" }] });
  assert.equal(redactor.count, 3, "valores de menos de 3 caracteres no se siembran");
  const out = redactor.redact("Habla ludmila ferreiro: llamadme al 612345678 o escribid a ANA@example.com; gracias, Ludmila.");
  assert.equal(out, "Habla [NOMBRE_1]: llamadme al [TEL_1] o escribid a [EMAIL_1]; gracias, Ludmila.");
  assert.equal(redactor.map.TEL_1, "612 345 678");
  assert.equal(restorePii(out, redactor.map), "Habla Ludmila Ferreiro: llamadme al 612 345 678 o escribid a ana@example.com; gracias, Ludmila.");
  // Con `kinds` restringido, la PII conocida de otro tipo no se siembra.
  assert.equal(createPiiRedactor({ kinds: ["email"], knownPii: [{ kind: "name", value: "Ludmila Ferreiro" }] }).count, 0);
});

test("kinds restringe los detectores", () => {
  const { text, map } = redactPii(SAMPLE, { kinds: ["email"] });
  assert.equal(Object.keys(map).length, 1);
  assert.ok(text.includes("Ludmila Ferreiro"));
  assert.ok(text.includes("[EMAIL_1]"));
});

test("restauración tolerante (sin corchetes, con comillas latinas) y profunda sobre JSON", () => {
  const { map } = redactPii(SAMPLE);
  assert.equal(restorePii("Estimada Sra. NOMBRE_1, escribiremos a «EMAIL_1».", map), "Estimada Sra. Ludmila Ferreiro, escribiremos a ana@example.com.");
  assert.equal(restorePii("NOMBRE_10 no existe", map), "NOMBRE_10 no existe");
  const deep = restorePiiDeep({ guest: "[NOMBRE_1]", contact: { emails: ["[EMAIL_1]", "otro"] }, n: 3, nil: null }, map);
  assert.deepEqual(deep, { guest: "Ludmila Ferreiro", contact: { emails: ["ana@example.com", "otro"] }, n: 3, nil: null });
});

test("createPiiRedactor acumula el mapa entre varios textos (turnos de una conversación)", () => {
  const redactor = createPiiRedactor();
  const a = redactor.redact("Soy la Sra. Ludmila Ferreiro.");
  const b = redactor.redact("¿Podéis escribir a ana@example.com? Firmado: Sra. Ludmila Ferreiro");
  assert.equal(a, "Soy la Sra. [NOMBRE_1].");
  assert.equal(b, "¿Podéis escribir a [EMAIL_1]? Firmado: Sra. [NOMBRE_1]");
  assert.equal(redactor.count, 2);
});
