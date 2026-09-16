// Cocoa 22 · ola 10 · lote 10-C · qa#14: readinessMessage() reads the API's
// readiness checks and connector health notes in Spanish without environment
// variable names, «sandbox», «stub» or English field keys. The inputs below
// are the exact templates of apps/api backoffice.service.ts computeReadiness,
// compliance-health.service.ts and packages/compliance verifactu/software.ts.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readinessMessage } from "../format.ts";

const JARGON = /\b(sandbox|stub|go-live|flag|MIR|preproduction|production)\b|[A-Z][A-Z0-9]*_[A-Z0-9_]+|\bpostalCode\b|\bmunicipality\b/;

describe("format · readinessMessage (Cocoa 22 · qa#14)", () => {
  it("reads the SES.HOSPEDAJES mode without the environment variable", () => {
    assert.equal(
      readinessMessage("SES_HOSPEDAJES_MODE=sandbox: los partes se envían a un simulador, no al MIR. Configura preproduction/production con certificado antes del go-live."),
      "SES.HOSPEDAJES en modo de pruebas: los partes se envían a un simulador, no al Ministerio del Interior. Configura el modo de preproducción o producción con certificado antes de salir en vivo."
    );
    assert.equal(readinessMessage("SES en modo preproduction sin certificado: variable de ruta del certificado no configurada."), "SES.HOSPEDAJES en modo de preproducción sin certificado: falta la ruta del certificado.");
    assert.equal(readinessMessage("SES en modo production sin certificado: passphrase del certificado no configurada."), "SES.HOSPEDAJES en modo de producción sin certificado: falta la contraseña del certificado.");
    assert.equal(readinessMessage("SES_HOSPEDAJES_CERT_PATH apunta a un fichero inexistente."), "La ruta del certificado de SES.HOSPEDAJES apunta a un fichero que no existe.");
    assert.equal(readinessMessage("SES.HOSPEDAJES en modo production con certificado configurado."), "SES.HOSPEDAJES en modo de producción con certificado configurado.");
  });

  it("humanises the VeriFactu software block and its usage note", () => {
    assert.equal(
      readinessMessage(
        "Bloque SistemaInformatico incompleto (Falta VERIFACTU_SOFTWARE_NAME (razón social del productor del software, NombreRazon del bloque SistemaInformatico).; Falta VERIFACTU_SOFTWARE_NIF (NIF del productor del software, no del hotel emisor).; Falta VERIFACTU_INSTALL_NUMBER (número de instalación asignado por el productor a este despliegue).). En sandbox se envía con valores de relleno. Nota: activo por uso: 5 facturas emitidas; el flag verifactuEnabled está desactivado."
      ),
      "Datos del software VeriFactu incompletos (Falta la razón social del productor del software.; Falta el NIF del productor del software (no el del hotel).; Falta el número de instalación asignado por el productor.). En modo de pruebas se envía con valores de relleno. Nota: activo por uso: 5 facturas emitidas; VeriFactu no está activado en la configuración del establecimiento."
    );
    assert.equal(
      readinessMessage("Bloque SistemaInformatico incompleto (VERIFACTU_SOFTWARE_NIF no es un NIF válido: formato incorrecto; IdSistemaInformatico (VERIFACTU_SYSTEM_ID) debe tener exactamente 2 caracteres (valor actual: \"001\").). Bloquea el envío real a AEAT."),
      "Datos del software VeriFactu incompletos (El NIF del productor del software no es válido: formato incorrecto; El identificador del sistema debe tener exactamente 2 caracteres (valor actual: \"001\").). Bloquea el envío real a AEAT."
    );
    assert.equal(
      readinessMessage("La razón social del productor (VERIFACTU_SOFTWARE_NAME) supera los 120 caracteres permitidos por el XSD (131)."),
      "La razón social del productor supera los 120 caracteres que admite la AEAT (131)."
    );
    assert.equal(
      readinessMessage("Bloque SistemaInformatico declarado (Anfitorio SL · NIF B12345674 · Anfitorio 0.1.0)."),
      "Datos del software VeriFactu declarados (Anfitorio SL · NIF B12345674 · Anfitorio 0.1.0)."
    );
  });

  it("explains the platform certificate notice without «stub» or «sandbox»", () => {
    assert.equal(
      readinessMessage("Sin certificado configurado en el entorno: los envíos a AEAT/MIR se firman con un stub (solo sandbox)."),
      "Sin certificado configurado en el entorno: los envíos a la AEAT y al Ministerio del Interior se firman con una firma de pruebas, válida solo en modo de pruebas."
    );
    assert.equal(
      readinessMessage("El certificado configurado (VERIFACTU_CERT_PATH / SES_HOSPEDAJES_CERT_PATH) es de la plataforma, no del hotel: cada obligado tributario debe firmar con su propio certificado antes de emitir en producción."),
      "El certificado configurado (VeriFactu y SES.HOSPEDAJES) es de la plataforma, no del hotel: cada obligado tributario debe firmar con su propio certificado antes de emitir en producción."
    );
  });

  it("names the fiscal address fields, the tax region and the module switches in Spanish", () => {
    assert.equal(
      readinessMessage("Dirección fiscal incompleta: faltan municipality, postalCode. Necesaria antes de activar SES.HOSPEDAJES o VeriFactu."),
      "Dirección fiscal incompleta: faltan municipio, código postal. Necesaria antes de activar SES.HOSPEDAJES o VeriFactu."
    );
    assert.equal(
      readinessMessage("Región fiscal ES_CANARIAS (IGIC) con tipos vigentes para alojamiento, restauración y servicios."),
      "Región fiscal Canarias (IGIC) con tipos vigentes para alojamiento, restauración y servicios."
    );
    assert.equal(
      readinessMessage("No aplica: SES.HOSPEDAJES desactivado para este establecimiento y sin envíos en los últimos 180 días. Nota: activo por uso: 3 envíos; el flag sesHospedajesEnabled está desactivado (últimos 180 días)."),
      "No aplica: SES.HOSPEDAJES desactivado para este establecimiento y sin envíos en los últimos 180 días. Nota: activo por uso: 3 envíos; SES.HOSPEDAJES no está activado en la configuración del establecimiento (últimos 180 días)."
    );
    assert.equal(
      readinessMessage("Se necesita al menos una serie de facturación activa (FAC): el establecimiento ya emite facturas. Nota: activo por uso: 25 facturas emitidas; el flag compliance_billing (módulo) está desactivado."),
      "Se necesita al menos una serie de facturación activa (FAC): el establecimiento ya emite facturas. Nota: activo por uso: 25 facturas emitidas; el módulo de facturación y cumplimiento no está activado."
    );
    assert.equal(
      readinessMessage("Falta el NIF/CIF de la sociedad emisora (Configuración › Estructura societaria › Datos fiscales): sin él las facturas salen con NIF de relleno (sandbox) o se bloquean (producción)."),
      "Falta el NIF/CIF de la sociedad emisora (Configuración › Estructura societaria › Datos fiscales): sin él las facturas salen con NIF de relleno (modo de pruebas) o se bloquean (producción)."
    );
  });

  it("covers the connector health notes of the fiscal settings card", () => {
    assert.equal(
      readinessMessage("Modo sandbox: no se llama a AEAT. Cambia VERIFACTU_MODE=preproduction + cert para validar contra AEAT pre-producción. Bloque SistemaInformatico incompleto: Falta VERIFACTU_SOFTWARE_NIF (NIF del productor del software, no del hotel emisor)."),
      "Modo de pruebas: no se llama a la AEAT. Cambia a preproducción con certificado para validar contra la AEAT de preproducción. Datos del software VeriFactu incompletos: Falta el NIF del productor del software (no el del hotel)."
    );
    assert.equal(readinessMessage("Variable de path del certificado no configurada."), "Falta la ruta del certificado.");
  });

  it("leaves plain messages unchanged and empties null", () => {
    for (const plain of [
      "3 tipo(s) de habitación activos.",
      "Hay al menos un usuario activo asignado al establecimiento.",
      "Series de facturación activas: FAC/2026 (incluye el ejercicio 2026).",
      "Tipos del IPSI confirmados contra la ordenanza municipal vigente."
    ]) {
      assert.equal(readinessMessage(plain), plain);
    }
    assert.equal(readinessMessage(null), "");
    assert.equal(readinessMessage(undefined), "");
  });

  it("never leaks an environment variable, a test-mode word or an English field key for the known templates", () => {
    const templates = [
      "SES_HOSPEDAJES_MODE=sandbox: los partes se envían a un simulador, no al MIR. Configura preproduction/production con certificado antes del go-live.",
      "SES en modo preproduction sin certificado: variable de ruta del certificado no configurada.",
      "SES_HOSPEDAJES_CERT_PATH apunta a un fichero inexistente.",
      "SES.HOSPEDAJES en modo production con certificado configurado.",
      "Bloque SistemaInformatico incompleto (Falta VERIFACTU_SOFTWARE_NAME (razón social del productor del software, NombreRazon del bloque SistemaInformatico).; VERIFACTU_MULTI_OT debe ser \"S\" o \"N\" (valor actual: \"X\").; INSTALLATION_NOT_DECLARED: el centro no tiene una instalación VeriFactu declarada (verifactu_installations). En preproduction/production el NumeroInstalacion nunca sale del entorno: da de alta la instalación del centro (o de la sociedad, según la política de cadena) en Configuración › Estructura societaria › Series y VeriFactu.). Bloquea el envío real a AEAT.",
      "Sin certificado configurado en el entorno: los envíos a AEAT/MIR se firman con un stub (solo sandbox).",
      "El certificado configurado (VERIFACTU_CERT_PATH / SES_HOSPEDAJES_CERT_PATH) es de la plataforma, no del hotel: cada obligado tributario debe firmar con su propio certificado antes de emitir en producción.",
      "Dirección fiscal incompleta: faltan address, municipality, province, postalCode. Obligatoria: SES.HOSPEDAJES activado y VeriFactu activado.",
      "Región fiscal ES_PENINSULA_BALEARES (IVA) con tipos vigentes para alojamiento, restauración y servicios.",
      "Región fiscal sin configurar (derivada por defecto: ES_PENINSULA_BALEARES): elige Península y Baleares, Canarias, Ceuta o Melilla en el perfil del establecimiento.",
      "Falta el NIF/CIF de la sociedad emisora (Configuración › Estructura societaria › Datos fiscales): sin él las facturas salen con NIF de relleno (sandbox) o se bloquean (producción).",
      "Modo sandbox: no se llama a AEAT. Cambia VERIFACTU_MODE=preproduction + cert para validar contra AEAT pre-producción."
    ];
    for (const template of templates) {
      const shown = readinessMessage(template);
      assert.ok(!JARGON.test(shown), `jargon left in «${shown}»`);
    }
  });
});
