> ⚠️ **PLANTILLA — adapta los porcentajes y tiempos a tu capacidad real antes de firmar.**

# Service Level Agreement · piloto HotelOS

**Cliente:** _[Razón social del hotel]_
**Servicio:** Acceso a la plataforma HotelOS (PMS + ERP) en modo piloto.
**Periodo cubierto:** Desde el _[YYYY-MM-DD]_ hasta el _[YYYY-MM-DD]_ (renovable
por acuerdo escrito).

---

## 1. Definiciones

- **Servicio disponible**: la API responde en menos de 5 segundos a `GET /health`
  y el frontend `app.tudominio.com` carga en menos de 10 segundos.
- **Incidencia crítica (P1)**: el servicio está totalmente inaccesible o no se
  pueden emitir facturas / enviar SES dentro del plazo legal de 24h.
- **Incidencia alta (P2)**: el servicio responde pero un módulo crítico
  (reservas, check-in, facturación) no funciona.
- **Incidencia media (P3)**: degradación en módulos no críticos (revenue,
  reporting, ops boards).
- **Mantenimiento programado**: cualquier ventana de indisponibilidad
  anunciada con al menos 48h de antelación, fuera de horario de servicio
  (definido en §3).

## 2. Disponibilidad mensual

HotelOS se compromete a un **99,0% de disponibilidad mensual** del servicio,
excluyendo:

- Mantenimiento programado.
- Indisponibilidad causada por el Cliente (configuración errónea,
  agotamiento de recursos por uso anómalo).
- Causas de fuerza mayor (cortes de Hetzner, problemas de DNS del Cliente,
  caída de AEAT/SES/MIR que impida envíos).

99,0% mensual = máximo **7,3 horas** de indisponibilidad no programada al mes.

## 3. Horario de servicio (soporte 1ª línea)

| Día        | Horario CET   |
|------------|---------------|
| Lun – Vie  | 09:00 – 19:00 |
| Sábados    | 10:00 – 14:00 |
| Domingos   | Cerrado (P1 sí · P2/P3 lunes) |
| Festivos nacionales | Cerrado (P1 sí · P2/P3 día hábil siguiente) |

**P1 fuera de horario**: soporte de guardia 24/7 vía teléfono +34 _[xxx-xxx-xxx]_
y email _emergencia@tudominio.com_.

## 4. Tiempos de respuesta y resolución

| Severidad | Primera respuesta | Resolución objetivo | Crédito por incumplimiento |
|-----------|-------------------|---------------------|----------------------------|
| P1        | 30 min            | 4 horas             | 25% mensualidad por hora extra |
| P2        | 2 horas hábiles   | 1 día hábil         | 5% mensualidad por día extra |
| P3        | 1 día hábil       | 5 días hábiles      | 1% mensualidad por día extra |

**Crédito máximo por mes:** 50% de la mensualidad.

## 5. Backups y RPO/RTO

- **RPO** (Recovery Point Objective): máximo 24 horas de pérdida de datos. Los
  backups corren a las 03:00 UTC diariamente y se suben a Backblaze EU
  cifrados (AES-256).
- **RTO** (Recovery Time Objective): máximo 4 horas para restaurar el servicio
  desde el backup más reciente en caso de pérdida total.
- Test de restore: ejecución automatizada mensual con notificación de
  resultado al equipo.

## 6. Compliance — VeriFactu / SES / TBAI / IGIC

- HotelOS proporciona la infraestructura técnica para los envíos.
- **El Cliente** es responsable de obtener los certificados FNMT y de su
  alta como emisor en AEAT / MIR / Hacienda Foral o Canaria.
- HotelOS garantiza que, una vez configurados los certificados, los envíos
  cumplen los plazos legales (24h para SES, inmediato para VeriFactu/TBAI).
- Si la administración rechaza un envío con el certificado del Cliente,
  HotelOS apoyará en el diagnóstico técnico pero la subsanación legal
  corresponde al Cliente.

## 7. Mantenimiento programado

- Ventana estándar: domingos 02:00–06:00 CET.
- Notificación: email a contactos técnicos del Cliente con 48h de antelación.
- Duración media esperada: <60 minutos.

## 8. Soporte incluido

- Hasta **20 horas/mes** de soporte técnico para el Cliente (incidencias,
  preguntas operativas, ayuda en configuración).
- Acceso al portal de incidencias y panel de Sentry compartido (modo
  solo-lectura para el Cliente).
- Sesión de formación inicial de 4 horas para el equipo del hotel.
- Documentación del usuario actualizada.

Horas adicionales: tarifa fuera de SLA según contrato marco.

## 9. Exclusiones

Este SLA no aplica a:

- Modificaciones del código fuente solicitadas por el Cliente.
- Integraciones con sistemas de terceros no contratadas explícitamente.
- Recuperación de datos perdidos por acción directa del Cliente
  (p.ej. borrados manuales sin pedir confirmación).
- Pérdidas o daños indirectos (lucro cesante, pérdida de reputación, etc.).

## 10. Canal de soporte

- **Tickets** (preferente): https://soporte.tudominio.com — el Cliente recibe
  un usuario al firmar el contrato marco.
- **Email**: soporte@tudominio.com (respuesta automática con número de ticket).
- **Teléfono P1**: +34 _[xxx-xxx-xxx]_ (24/7).

Los SMS y WhatsApp no se consideran canales válidos para abrir incidencias
con SLA.

## 11. Reporting

HotelOS enviará al Cliente, el primer día hábil de cada mes:

- Informe de disponibilidad del mes anterior (%, minutos perdidos, causa).
- Listado de incidencias por severidad.
- Estado de los backups y resultado del test de restore mensual.
- Estado de las integraciones de compliance (`/compliance/health`).
- Métricas de uso (reservas, facturas, usuarios activos).

---

**Versión:** 1.0 · **Fecha:** _[YYYY-MM-DD]_

_Firmado en representación de:_
- _Cliente: [Nombre y cargo]_
- _HotelOS: [Nombre y cargo]_
