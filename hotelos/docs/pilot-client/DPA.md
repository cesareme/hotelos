> ⚠️ **PLANTILLA DE ACUERDO — NO ES ASESORAMIENTO LEGAL.** Adapta este DPA con un abogado antes de firmarlo con el cliente piloto.

# Acuerdo de Tratamiento de Datos (Data Processing Agreement · DPA)

**Entre:**

- **Responsable del tratamiento** (Cliente piloto): _[Razón social del hotel] — [NIF] — [Domicilio]_
- **Encargado del tratamiento** (HotelOS): _[Tu razón social] — [Tu NIF] — [Tu domicilio]_

**Fecha de entrada en vigor:** _[YYYY-MM-DD]_

**Duración:** Mientras el cliente piloto utilice la plataforma HotelOS. Cualquier
prórroga del periodo piloto requiere acuerdo escrito.

---

## 1. Objeto

El presente acuerdo regula el tratamiento de datos personales que HotelOS
realizará por cuenta del Cliente en el contexto de la operativa diaria del
hotel: alojamiento, reservas, facturación y comunicaciones obligatorias a la
administración española (SES Hospedajes, AEAT, Hacienda Foral / Canaria).

## 2. Categorías de datos

- **Huéspedes**: nombre completo, fecha de nacimiento, nacionalidad, tipo y
  número de documento de identidad (DNI/NIE/Pasaporte/permiso de residencia),
  fecha de expedición y vencimiento, domicilio, contacto (teléfono, email),
  género, género de habitación (parentesco con otros huéspedes en estancias
  familiares cuando RD 933/2021 lo exige).
- **Pagos**: importe, método (tarjeta tokenizada — nunca PAN completo),
  referencia de transacción del PSP, fecha y franquicia.
- **Personal del hotel**: nombre, email, teléfono profesional, rol asignado y
  registros de inicio/fin de sesión.
- **Datos operativos**: estado de habitaciones, tareas de housekeeping,
  partes de mantenimiento, comunicaciones internas.

No se tratan categorías especiales (salud, ideología, etc.) salvo que el
Cliente lo registre por su cuenta en notas libres, en cuyo caso el Cliente
asume la responsabilidad directa.

## 3. Finalidades del tratamiento

a. Gestión operativa del hotel (PMS/ERP) por cuenta del Cliente.
b. Cumplimiento de obligaciones legales del Cliente:
   - Hospedajes — RD 933/2021 (comunicación SES.HOSPEDAJES en 24h)
   - VeriFactu — Real Decreto 1007/2023 (alta inmediata de facturas)
   - TicketBAI — Foral (Bizkaia/Gipuzkoa/Álava) cuando aplique
   - IGIC — Canarias cuando aplique
c. Generación de copias de seguridad cifradas en la UE.
d. Soporte técnico y diagnóstico de incidencias.

HotelOS **no usa** datos personales del Cliente para entrenamiento de modelos,
estadísticas agregadas con terceros ni marketing.

## 4. Subencargados

HotelOS notificará al Cliente con 15 días de antelación cualquier cambio en
los subencargados listados a continuación. Si el Cliente se opone, podrá
resolver el contrato sin penalización.

| Subencargado     | Servicio                       | Localización del dato |
|------------------|--------------------------------|------------------------|
| Hetzner          | Hosting VPS (servidor del piloto) | Alemania / Finlandia (EU) |
| Backblaze        | Backups cifrados de la base de datos | UE (eu-central-003) |
| Sentry / GlitchTip | Captura de errores            | _Especificar región según deployment_ |
| Anthropic        | LLM (asistente IA opcional)    | EU si está disponible — por defecto desactivado en piloto |
| Stripe / Redsys  | Procesador de pagos            | UE                     |

El acceso a datos por estos subencargados está limitado al mínimo necesario
para prestar el servicio (least-privilege).

## 5. Medidas técnicas y organizativas

- **Cifrado en tránsito**: TLS 1.3 obligatorio.
- **Cifrado en reposo**: PII sensibles (números de documento, datos de pago
  tokenizados) cifrados con AES-256-GCM en envelope contra clave maestra
  custodiada en variable de entorno restringida.
- **Backups**: AES-256-CBC con clave separada de credenciales del bucket.
- **Autenticación**: hash de contraseña con scrypt, política mínima 8 caracteres
  con mayúscula+dígito+especial, bloqueo automático tras 5 intentos fallidos.
- **Auditoría**: log inmutable de eventos críticos (login, cambios de
  permisos, emisión de facturas, envíos SES) durante toda la vida del piloto.
- **Acceso a producción**: solo personal autorizado de HotelOS con autenticación
  multifactor.
- **Sentry PII redaction**: cabeceras `authorization` y `cookie` eliminadas,
  bodies redactados antes del envío a Sentry.

## 6. Brechas de seguridad

HotelOS notificará al Cliente cualquier brecha de seguridad sin dilación
indebida y, en cualquier caso, en un plazo máximo de **48 horas** desde su
detección. La notificación incluirá:

1. Naturaleza de la brecha y categorías de datos afectados.
2. Número aproximado de interesados.
3. Consecuencias probables.
4. Medidas adoptadas o propuestas.

El Cliente conserva la obligación de notificar a la AEPD en el plazo de 72h
cuando proceda.

## 7. Derechos de los interesados

Cuando un huésped ejerza ante el Cliente derechos GDPR (acceso, rectificación,
supresión, portabilidad, oposición), HotelOS prestará asistencia técnica
razonable:

- **Acceso**: exportación CSV/JSON del expediente del huésped.
- **Supresión**: borrado del huésped y registros asociados, respetando las
  obligaciones legales de retención (RD 933/2021 — registro de viajeros: 3
  años; AEAT — facturas: 4 años).
- **Portabilidad**: exportación estructurada en formato abierto.

## 8. Devolución / destrucción al final del contrato

A la finalización del piloto, y según las instrucciones escritas del Cliente:

- **Opción A — Devolución**: HotelOS exporta toda la base de datos a un archivo
  cifrado y lo entrega al Cliente. Borra su copia en producción.
- **Opción B — Destrucción**: HotelOS borra toda la base de datos y todos los
  backups cifrados en el bucket de almacenamiento, conservando únicamente
  registros mínimos exigidos por ley (audit logs).

Plazo máximo: 30 días desde la finalización.

## 9. Auditoría

El Cliente puede solicitar, con preaviso de 15 días, una auditoría documental
de las medidas técnicas de HotelOS. Las auditorías presenciales requieren
acuerdo previo sobre alcance y honorarios del auditor.

## 10. Transferencias internacionales

Por defecto, todos los datos permanecen en la UE. Si fuese necesaria una
transferencia internacional (p.ej. soporte de un proveedor en EEUU), se
aplicarán las cláusulas contractuales tipo de la Comisión Europea y se
informará al Cliente con anterioridad.

## 11. Responsabilidad

HotelOS responderá frente al Cliente por los daños directos derivados del
incumplimiento del DPA, con el límite que se acuerde en el contrato marco. La
responsabilidad frente a los interesados se rige por el artículo 82 RGPD.

## 12. Ley aplicable y jurisdicción

Este DPA se rige por la legislación española. Cualquier controversia se
someterá a los juzgados y tribunales de _[ciudad acordada]_.

---

**Firmado en _[Ciudad]_, el _[YYYY-MM-DD]_.**

_Por el Cliente:_                                _Por HotelOS:_
_[Nombre y cargo]_                                _[Nombre y cargo]_
