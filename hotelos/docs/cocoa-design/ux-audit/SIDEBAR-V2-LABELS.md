# Sidebar v2 — Labels (Spanish, HIG)

Esta tabla define los labels definitivos del sidebar de Cocoa siguiendo
las convenciones de Apple Human Interface Guidelines aplicadas al
castellano. Toda navegación primaria se enuncia en sentence case,
máximo 22 caracteres, sin emoji, sin mayúsculas decorativas y sin
signos de exclamación. Los tooltips amplían el contexto sin repetir
literalmente el label corto. Los shortcuts respetan el patrón macOS
(comando único para áreas principales, comando + shift para acciones
secundarias dentro de Reservas).

## Reglas aplicadas

- Sentence case: solo la primera letra en mayúscula salvo nombres
  propios o siglas establecidas (TT.OO., API, POS, F&B).
- Longitud: label corto ≤ 22 caracteres incluyendo espacios.
- Sin emoji, sin signos !, sin mayúsculas enfáticas.
- Tooltips en oración completa pero sin punto final.
- Shortcuts macOS: ⌘ = command, ⇧ = shift. Reservas hereda ⌘R y sus
  acciones derivadas usan ⌘⇧ para evitar colisiones con el sistema.
- Items sin shortcut son secciones de bajo uso diario o pertenecen a
  módulos administrativos donde el atajo añadiría ruido.

## Tabla maestra

| # | Label corto (sidebar) | Label largo (tooltip)                          | Shortcut |
|---|-----------------------|------------------------------------------------|----------|
| 1 | Inicio                | Panel de inicio y resumen del día              | ⌘D       |
| 2 | Reservas              | Listado y gestión de reservas                  | ⌘R       |
| 3 | Mi día                | Tareas y vista personal del turno              | ⌘1       |
| 4 | Check-in              | Registrar entrada de huéspedes                 | ⌘⇧I      |
| 5 | Check-out             | Registrar salida y cierre de cuenta            | ⌘⇧O      |
| 6 | Walk-in               | Reserva sin previa y entrada inmediata         | ⌘W       |
| 7 | Plano                 | Plano de habitaciones por planta               | ⌘P       |
| 8 | Grupos                | Reservas de grupo y bloqueos                   | ⌘G       |
| 9 | Allotments            | Cupos contratados y disponibilidad             | ⌘A       |
| 10 | TT.OO.               | Touroperadores y contratos asociados           | —        |
| 11 | Limpieza              | Estado de pisos y planificación housekeeping   | ⌘H       |
| 12 | Mantenimiento         | Partes, averías y órdenes de trabajo           | ⌘M       |
| 13 | Personal              | Plantilla, turnos y permisos                   | —        |
| 14 | Seguridad             | Accesos, incidencias y registro policial       | —        |
| 15 | F&B/POS               | Restauración y puntos de venta                 | ⌘F       |
| 16 | Revenue               | Panel de revenue management                    | —        |
| 17 | Tarifas               | Tarifas, planes y derivadas                    | —        |
| 18 | Canales               | Channel manager y distribución                 | —        |
| 19 | Forecast              | Previsión de ocupación e ingresos              | —        |
| 20 | Comparativa           | Comparativa entre periodos y competencia       | —        |
| 21 | Folios                | Folios de huésped y cargos abiertos            | ⌘B       |
| 22 | Pagos                 | Cobros, devoluciones y pasarelas               | —        |
| 23 | Banca                 | Conciliación bancaria y movimientos            | —        |
| 24 | Presupuesto           | Presupuesto anual y desviaciones               | —        |
| 25 | Informes              | Informes operativos y financieros              | —        |
| 26 | Cumplimiento          | Cumplimiento legal y registros oficiales       | ⌘L       |
| 27 | Configuración         | Ajustes del hotel y preferencias               | ⌘,       |
| 28 | Usuarios              | Usuarios, roles y permisos                     | —        |
| 29 | Marketplace           | Integraciones y extensiones de terceros        | —        |
| 30 | API Reference         | Referencia de la API y webhooks                | —        |
| 31 | Showcase Cocoa        | Galería viva del design system Cocoa           | —        |

## Verificación de longitud

Todos los labels cortos verificados ≤ 22 caracteres. El más largo es
"Showcase Cocoa" con 14 caracteres y "API Reference" con 13, ambos
dentro de la cuota. Ningún label requiere truncado en el rail
expandido (220 px) ni en el rail compacto con icono más label corto.

## Notas por item

- Inicio: reservado para el dashboard editorial. ⌘D porque "Dashboard"
  es el nombre interno del componente y libera ⌘H para Limpieza.
- Reservas: ⌘R es el atajo más usado del producto, alineado con la
  acción primaria de PMS.
- Mi día: vista personalizada del turno. ⌘1 refuerza que es la
  primera pestaña a la que vuelve el personal de recepción.
- Check-in y Check-out usan ⌘⇧I y ⌘⇧O para no colisionar con ⌘I
  (Inspector) ni con ⌘O (Abrir) del sistema.
- Walk-in: entrada espontánea. ⌘W no se solapa con cerrar ventana
  porque el sidebar consume el atajo antes de llegar a AppKit.
- Plano: ⌘P se mantiene aunque coincida con imprimir porque imprimir
  en Cocoa vive en el menú de cada folio o informe; el sidebar
  intercepta el atajo solo cuando el foco está fuera de un documento
  imprimible.
- Grupos y Allotments: ⌘G y ⌘A coherentes con las iniciales y con la
  jerarquía de comerciales.
- TT.OO.: se mantienen los puntos por convención del sector. Sin
  shortcut para evitar colisión con ⌘T (nueva pestaña).
- Limpieza: ⌘H (Housekeeping). Convive con "ocultar ventana" porque
  el sidebar captura ⌘H cuando el foco está en navegación.
- Mantenimiento: ⌘M sin colisión con minimizar gracias al mismo
  patrón de captura del sidebar.
- Personal y Seguridad: módulos de baja frecuencia diaria, no llevan
  shortcut para no saturar el espacio de atajos.
- F&B/POS: ⌘F reservado para Food & Beverage. La búsqueda global
  usa ⌘K, por lo que ⌘F queda libre para esta sección.
- Revenue, Tarifas, Canales, Forecast, Comparativa: sin shortcut. Son
  herramientas analíticas que el revenue manager abre por sesión, no
  por atajo de teclado.
- Folios: ⌘B por "Billing", evita colisión con ⌘F (F&B) y ⌘P (Plano).
- Pagos, Banca, Presupuesto, Informes: secciones financieras de
  consulta puntual; sin shortcut.
- Cumplimiento: ⌘L por "Legal". Cubre policía, padrón y normativa.
- Configuración: ⌘, es el estándar macOS para preferencias.
- Usuarios: sin shortcut. Acción administrativa de baja frecuencia.
- Marketplace, API Reference, Showcase Cocoa: viven en la zona inferior
  del rail como recursos transversales. No necesitan atajo.

## Criterios de tooltip

- Empiezan con verbo o sustantivo descriptivo, no repiten el label.
- Resuelven la ambigüedad de iniciales (F&B/POS aclara "Restauración y
  puntos de venta").
- No exceden 50 caracteres para mantener una sola línea en tooltip
  nativo macOS.
- No usan punto final, en línea con el patrón de Finder y Mail.

## Mapa de shortcuts ocupados

| Tecla | Función Cocoa            | Notas                                  |
|-------|--------------------------|----------------------------------------|
| ⌘D    | Inicio (dashboard)       | Sustituye marcadores que no aplican    |
| ⌘R    | Reservas                 | Acción nuclear del PMS                 |
| ⌘1    | Mi día                   | Vuelve a vista personal de turno       |
| ⌘⇧I   | Check-in                 | Evita colisión con Inspector           |
| ⌘⇧O   | Check-out                | Evita colisión con Abrir documento     |
| ⌘W    | Walk-in                  | Sidebar intercepta antes que ventana   |
| ⌘P    | Plano                    | Sidebar intercepta fuera de documentos |
| ⌘G    | Grupos                   | Convención inicial                     |
| ⌘A    | Allotments               | Convención inicial                     |
| ⌘H    | Limpieza                 | Housekeeping                           |
| ⌘M    | Mantenimiento            | Sidebar intercepta antes que minimizar |
| ⌘F    | F&B/POS                  | Búsqueda global vive en ⌘K             |
| ⌘B    | Folios                   | Billing                                |
| ⌘L    | Cumplimiento             | Legal                                  |
| ⌘,    | Configuración            | Estándar macOS                         |

## Pendiente / decisiones abiertas

- Confirmar con QA si el atajo ⌘W debe pedir confirmación cuando hay
  reserva sin guardar para no perder datos al cerrar ventana.
- Evaluar si "Showcase Cocoa" se renombra a "Cocoa Lab" cuando el
  módulo salga del modo interno; el label corto seguiría ≤ 22.
- Revisar la traducción de "Forecast" a "Previsión" en mercados donde
  el equipo revenue prefiera el término en castellano puro.
