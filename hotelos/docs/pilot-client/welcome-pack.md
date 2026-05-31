> Documento de bienvenida para el equipo del hotel cliente. Entregar el día del kick-off.

# Bienvenido a HotelOS · pack de primer arranque

Este documento te ayuda a empezar a usar HotelOS en tu hotel. Si te quedas
atascado en cualquier paso, escribe a soporte@tudominio.com o llama al
+34 _[xxx-xxx-xxx]_.

## 1. Tus accesos

| Dato                  | Valor                                  |
|-----------------------|----------------------------------------|
| URL de la aplicación  | https://app.tudominio.com              |
| Email del admin       | _[admin@tu-hotel.com]_                 |
| Contraseña inicial    | _enviada en sobre cerrado · cámbiala en cuanto entres_ |
| Soporte               | soporte@tudominio.com / +34 _[xxxxxx]_ |
| Panel Sentry (errores)| https://sentry.io/share/_[link]_ (solo lectura) |

> 🔒 **Cambia tu contraseña** en cuanto entres por primera vez:
> _Sidebar → Cuenta → Cambiar contraseña._
> La política exige mínimo 8 caracteres con mayúscula, dígito y carácter especial.

## 2. Tu primer día — checklist (60 min)

### Configura tu hotel (Property Setup Wizard)

1. Sidebar → **Back Office → Property Setup Wizard**.
2. Completa:
   - Datos legales (razón social, NIF/CIF, dirección)
   - Tipos de habitación (Doble Estándar, Suite, etc.)
   - Habitaciones (números, planta, conexiones)
   - Espacios y recursos (parking, sala de eventos, restaurantes)
3. Guarda los cambios.

### Da de alta a tu equipo

1. Sidebar → **Back Office → Usuarios → Invitar**.
2. Para cada miembro del equipo, introduce:
   - Email profesional
   - Nombre completo
   - Rol (Recepción / Housekeeping / Mantenimiento / Gerencia)
3. El sistema le enviará un email con su contraseña inicial.

### Configura SES Hospedajes y VeriFactu

Tu hotel necesita un **certificado digital FNMT** para enviar partes de
viajeros a SES Hospedajes y facturas a VeriFactu. Si todavía no lo tienes,
contacta con HotelOS y te guiamos en el proceso. Mientras tanto, el sistema
funciona en modo sandbox (genera los partes y facturas pero no los envía a
la administración).

### Comprueba que todo está listo

1. Sidebar → **Compliance → Salud de integraciones**.
2. Verás un semáforo para cada integración (VeriFactu, SES Hospedajes, TBAI
   si aplica, IGIC si aplica). Si están en sandbox = aún no envías a la
   administración.

## 3. Roles y qué puede hacer cada uno

| Rol                | Acceso típico                                                         |
|--------------------|------------------------------------------------------------------------|
| **Owner**          | Todo. Tú lo recibiste al firmar el contrato.                           |
| **Recepción**      | Reservas, check-in/out, huéspedes, folio, partes de viajero, mensajería |
| **Jefe Recepción** | Recepción + gestión de turnos, reasignación, planificación             |
| **Housekeeping**   | Habitaciones, tareas de limpieza, estado de plantas                    |
| **Mantenimiento**  | Partes de trabajo, bloqueo de habitaciones, parte técnico              |
| **Gerencia**       | Todos los dashboards de KPIs, sin acceso a configuración técnica       |
| **Operaciones**    | Vista de todos los boards operativos en tiempo real                    |
| **Asset Manager**  | Dashboards financieros, sin acceso a operativa día a día               |

Puedes ajustar permisos en Back Office → Roles.

## 4. Flujos cotidianos

### Recepción · check-in en 90 segundos

1. Front Desk Cockpit → cola de acciones → "Llega: huésped X" → **Quick Check-in**.
2. Escanea el DNI/Pasaporte con el botón "Escanear documento (IA)".
3. Verifica los datos extraídos y confirma.
4. Asigna habitación (o usa la sugerida por el sistema).
5. El parte SES se genera automáticamente y se envía en 24h.

### Recepción · check-out en 60 segundos

1. Front Desk Cockpit → "Salida: huésped X" → **Quick Check-out**.
2. Verifica el folio.
3. Cobra (efectivo, tarjeta tokenizada o transferencia).
4. Emite factura. VeriFactu se llama automáticamente.

### Housekeeping · mañana

1. Vista móvil → Sidebar → **Housekeeping (móvil)**.
2. Lista priorizada de habitaciones (salidas primero, después estancias).
3. Marca cada tarea como "iniciada" → "completada".

### Mantenimiento · partes

1. Cualquier empleado puede crear un parte: foto + ubicación + descripción.
2. El parte llega a Mantenimiento → tablero priorizado.
3. Si la incidencia bloquea una habitación, el sistema la marca como "Out of
   service" automáticamente (no se podrá reservar hasta resolverla).

## 5. Atajos útiles

- **Búsqueda global**: tecla `/` en cualquier pantalla → busca reservas,
  huéspedes, habitaciones, facturas.
- **Cambio de propiedad** (si gestionas varios hoteles): esquina superior
  derecha → selector.
- **Modo oscuro**: Cuenta → Apariencia.

## 6. ¿Y si algo va mal?

1. **No funciona algo**: refrescar la página (Ctrl+R / Cmd+R).
2. **Sigue sin funcionar**: abre soporte@tudominio.com con captura de pantalla.
3. **Es urgente** (no puedes hacer check-in/out): llama al teléfono P1.
4. **Pérdida de datos sospechada**: NO toques nada. Llama al P1. Tenemos
   backup cifrado diario en la UE; podemos restaurar en <4h.

## 7. Tu mes 1 con nosotros

- **Semana 1**: configuración + onboarding del equipo.
- **Semana 2**: operativa normal con sandbox SES/VeriFactu.
- **Semana 3**: una vez tengas tus certificados FNMT, pasamos a producción.
- **Semana 4**: sesión de feedback. ¿Qué falta? ¿Qué cambiarías?

Después del piloto decidimos juntos si renovamos, qué mejoras priorizar y qué
módulos activar.

---

¡Bienvenido a bordo! Estamos a tu disposición.

_Equipo HotelOS_
