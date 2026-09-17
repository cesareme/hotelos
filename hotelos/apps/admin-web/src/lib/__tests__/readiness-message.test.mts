// Cocoa 22 · ola 10 · lote 10-C · qa#14 → ola 11 · lote api-datos: readiness
// checks and connector health notes arrive from the API already in Spanish
// (backoffice.service.ts computeReadiness, compliance-health.service.ts and
// packages/compliance verifactu/software.ts humanise them at the source), so
// readinessMessage() is a normaliser: the exact templates the API ships today
// come back unchanged and never carry an environment variable, a test-mode word
// or an English field key. The inputs below are those templates verbatim.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readinessMessage } from "../format.ts";

const JARGON = /\b(sandbox|stub|go-live|flag|MIR|preproduction|production)\b|[A-Z][A-Z0-9]*_[A-Z0-9_]+|\bpostalCode\b|\bmunicipality\b|\bES_[A-Z_]+\b/;

/** Exact readiness / health messages of the API after Cocoa 22 · ola 11. */
const API_TEMPLATES = [
  // backoffice.service.ts computeReadiness
  "SES.HOSPEDAJES en modo de pruebas: los partes van a un simulador, no al Ministerio del Interior. Configura el modo de preproducción o producción con certificado antes de la puesta en marcha.",
  "SES.HOSPEDAJES en modo de preproducción sin certificado configurado: falta la ruta del certificado.",
  "SES.HOSPEDAJES en modo de producción sin certificado configurado: falta la contraseña del certificado.",
  "La ruta del certificado de SES.HOSPEDAJES no existe.",
  "SES.HOSPEDAJES en modo de producción con certificado configurado.",
  "Datos del establecimiento para SES.HOSPEDAJES completos (registro H-CO-000123, INE 15030).",
  "Declaración del sistema informático de VeriFactu completa (Anfitorio SL · NIF B12345674 · Anfitorio 0.1.0).",
  "Declaración del sistema informático de VeriFactu incompleta (Falta la razón social del productor del software.; Falta el NIF del productor del software (no el del hotel emisor).; Falta el número de instalación asignado por el productor a este despliegue.). En pruebas se envía con valores provisionales. Nota: activo por uso: 5 facturas emitidas; VeriFactu está desactivado en los ajustes del establecimiento.",
  "Declaración del sistema informático de VeriFactu incompleta (El NIF del productor del software no es válido: formato incorrecto; El identificador del sistema debe tener exactamente 2 caracteres (valor actual: «001»).). Bloquea el envío real a la AEAT.",
  "El certificado configurado (VeriFactu / SES.HOSPEDAJES) es de la plataforma, no del hotel: cada obligado tributario debe firmar con su propio certificado antes de emitir en producción.",
  "Certificado de plataforma no configurado (VeriFactu / SES.HOSPEDAJES): los envíos a la AEAT y al Ministerio del Interior se firman con una firma de pruebas, válida solo en modo de pruebas.",
  "Dirección fiscal incompleta: faltan municipio, código postal. Necesaria antes de activar SES.HOSPEDAJES o VeriFactu.",
  "Dirección fiscal incompleta: faltan dirección, municipio, provincia, código postal. Obligatoria: SES.HOSPEDAJES activado y VeriFactu activado.",
  "Región fiscal Canarias (IGIC) con tipos vigentes para alojamiento, restauración y servicios.",
  "Región fiscal sin configurar (derivada por defecto: Península y Baleares): elige Península y Baleares, Canarias, Ceuta o Melilla en el perfil del establecimiento.",
  "No aplica: SES.HOSPEDAJES desactivado para este establecimiento y sin envíos en los últimos 180 días. Nota: activo por uso: 3 envíos; SES.HOSPEDAJES está desactivado en los ajustes del establecimiento (últimos 180 días).",
  "Se necesita al menos una serie de facturación activa (FAC): el establecimiento ya emite facturas. Nota: activo por uso: 25 facturas emitidas; el módulo de facturación y cumplimiento está desactivado en los ajustes del establecimiento.",
  "Falta el NIF/CIF de la sociedad emisora (Configuración › Estructura societaria › Datos fiscales). El NIF del emisor es un valor provisional; sustitúyelo por el NIF real antes de emitir facturas: en producción la emisión se bloquea.",
  // compliance-health.service.ts (fiscal settings card)
  "Modo de pruebas: no se llama a la AEAT. Cambia a preproducción con certificado para validar contra la AEAT de preproducción. Declaración del sistema informático de VeriFactu incompleta: Falta el NIF del productor del software (no el del hotel emisor).",
  "Falta la ruta del certificado.",
  "Falta la contraseña del certificado.",
  // packages/compliance verifactu/software.ts (errors list of the fiscal settings card)
  "La razón social del productor supera los 120 caracteres que admite la AEAT (131).",
  "El indicador de varios obligados tributarios debe ser «S» o «N» (valor actual: «X»).",
  "El centro no tiene una instalación VeriFactu declarada. En preproducción y producción el número de instalación nunca sale de la configuración del servidor: da de alta la instalación del centro (o de la sociedad, según la política de cadena) en Configuración › Estructura societaria › Series y VeriFactu.",
  "La instalación VeriFactu declarada no tiene número de instalación."
];

describe("format · readinessMessage (Cocoa 22 · qa#14, normaliser since ola 11)", () => {
  it("returns every current API template unchanged", () => {
    for (const template of API_TEMPLATES) assert.equal(readinessMessage(template), template);
  });

  it("never leaks an environment variable, a test-mode word, a region code or an English field key", () => {
    for (const template of API_TEMPLATES) {
      const shown = readinessMessage(template);
      assert.ok(!JARGON.test(shown), `jargon left in «${shown}»`);
    }
  });

  it("leaves plain messages unchanged, trims whitespace and empties null / undefined", () => {
    for (const plain of [
      "3 tipo(s) de habitación activos.",
      "Hay al menos un usuario activo asignado al establecimiento.",
      "Series de facturación activas: FAC/2026 (incluye el ejercicio 2026).",
      "Tipos del IPSI confirmados contra la ordenanza municipal vigente."
    ]) {
      assert.equal(readinessMessage(plain), plain);
    }
    assert.equal(readinessMessage("  Zona horaria: Europe/Madrid.  "), "Zona horaria: Europe/Madrid.");
    assert.equal(readinessMessage("Dirección fiscal completa\n(dirección, municipio)."), "Dirección fiscal completa (dirección, municipio).");
    assert.equal(readinessMessage(null), "");
    assert.equal(readinessMessage(undefined), "");
    assert.equal(readinessMessage(""), "");
  });
});
