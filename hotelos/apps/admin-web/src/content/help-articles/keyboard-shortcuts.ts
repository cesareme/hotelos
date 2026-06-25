// keyboard-shortcuts — Help article: full keyboard shortcut reference.
//
// Single, comprehensive article that lists every keyboard combination
// available across Anfitorio admin-web, grouped by category and rendered
// as a markdown table per category. The article shape matches the
// `CocoaHelpArticle` interface defined in
// `components/cocoa-guidance/CocoaSearchableHelpModal.tsx`, so it can be
// dropped straight into the searchable help modal's `articles` prop.
//
// Source of truth for the catalog:
//   - GET /developer/keyboard-shortcuts (canonical global combos, see
//     apps/api/src/server.ts).
//   - Per-screen `shortcuts` arrays under `src/content/screen-instructions/`
//     (operations-level combos that only apply to a specific screen).
//
// Categories follow the order requested by product so the article reads
// top-down by user-flow priority: Navigation → Reservations → Operations
// → Search → Help.

import type { CocoaHelpArticle } from '../../components/cocoa-guidance/CocoaSearchableHelpModal';

export const KEYBOARD_SHORTCUTS_ARTICLE: CocoaHelpArticle = {
  id: 'keyboard-shortcuts',
  title: 'Atajos de teclado completos',
  category: 'Atajos de teclado',
  tags: [
    'atajos',
    'teclado',
    'shortcuts',
    'productividad',
    'cmd',
    'navegacion',
    'reservas',
    'operaciones',
    'busqueda',
    'ayuda',
  ],
  bodyMd: [
    'Referencia completa de combinaciones de teclado disponibles en Anfitorio. Los atajos estan agrupados por categoria y ordenados de mayor a menor uso dentro de cada bloque. En Windows/Linux sustituye `Cmd` por `Ctrl`.',
    '',
    '## Navigation',
    '',
    'Saltos rapidos entre las pantallas principales y navegacion lateral entre vistas.',
    '',
    '| Atajo | Accion |',
    '| --- | --- |',
    '| `Cmd+1` | Ir al Dashboard / Mi dia |',
    '| `Cmd+2` | Ir a Reservas |',
    '| `Cmd+3` | Ir a Front Desk |',
    '| `Cmd+4` | Ir a Housekeeping |',
    '| `Cmd+5` | Ir a Reportes |',
    '| `Cmd+[` | Atras en el historial de navegacion |',
    '| `Cmd+]` | Adelante en el historial de navegacion |',
    '| `Cmd+,` | Abrir preferencias |',
    '| `Cmd+Shift+P` | Quick switcher entre pantallas |',
    '| `Esc` | Cerrar dialogo, popover o panel activo |',
    '',
    '## Reservations',
    '',
    'Creacion, edicion y gestion de reservas desde el listado o el rack.',
    '',
    '| Atajo | Accion |',
    '| --- | --- |',
    '| `Cmd+N` | Crear nueva reserva |',
    '| `Cmd+F` | Buscar reserva por huesped, codigo, email o telefono |',
    '| `Cmd+E` | Editar la reserva seleccionada |',
    '| `Cmd+D` | Duplicar reserva |',
    '| `Cmd+R` | Refrescar listado de reservas |',
    '| `Cmd+1` | Cambiar a vista calendario |',
    '| `Cmd+2` | Cambiar a vista lista |',
    '| `Cmd+3` | Cambiar a vista grid |',
    '| `Cmd+Shift+C` | Check-in de la reserva seleccionada |',
    '| `Cmd+Shift+O` | Check-out de la reserva seleccionada |',
    '| `Cmd+Backspace` | Cancelar reserva |',
    '| `Cmd+Shift+G` | Nuevo bloque de grupo |',
    '| `Cmd+Shift+B` | Abrir block manager |',
    '| `Cmd+Shift+R` | Anadir entrada a la rooming list |',
    '| `Cmd+Shift+I` | Importar rooming list |',
    '| `Cmd+Shift+E` | Exportar rooming list |',
    '',
    '## Operations',
    '',
    'Combinaciones operativas para Housekeeping, Mantenimiento, Front Desk, Billing, Compliance y Allotments.',
    '',
    '| Atajo | Accion |',
    '| --- | --- |',
    '| `Cmd+H` | Abrir pizarra de Housekeeping |',
    '| `Cmd+M` | Abrir Mantenimiento |',
    '| `Cmd+B` | Abrir pantalla de Billing |',
    '| `Cmd+L` | Abrir centro de Compliance |',
    '| `Cmd+A` | Crear nuevo allotment |',
    '| `Cmd+G` | Abrir gestion de grupos |',
    '| `Cmd+N` | Anadir nuevo cargo al folio actual (en Billing) |',
    '| `Cmd+P` | Registrar un pago sobre el folio abierto |',
    '| `Cmd+Enter` | Emitir factura y enviarla a VeriFactu |',
    '| `Enter` | Ejecutar accion activa en Mi dia |',
    '| `J` / `K` | Navegar entre acciones del cockpit de Front Desk |',
    '| `R` | Release de allotments expirados |',
    '| `P` | Ver pickup tracking de allotments |',
    '| `F` | Filtrar por TT.OO. / bedbank o por CCAA segun pantalla |',
    '| `E` | Exportar inspection folder de compliance |',
    '',
    '## Search',
    '',
    'Acceso a buscadores globales y por pantalla.',
    '',
    '| Atajo | Accion |',
    '| --- | --- |',
    '| `Cmd+K` | Abrir command palette (busqueda global de comandos y pantallas) |',
    '| `Cmd+F` | Enfocar la barra de busqueda de la pantalla activa |',
    '| `Esc` | Cerrar el resultado de busqueda o el command palette |',
    '',
    '## Help',
    '',
    'Acceso a ayuda contextual, tours y catalogo de atajos.',
    '',
    '| Atajo | Accion |',
    '| --- | --- |',
    '| `Cmd+/` | Abrir / cerrar el catalogo de atajos de teclado |',
    '| `?` | Mostrar todos los atajos (alternativa al `Cmd+/`) |',
    '| `Esc` | Cerrar el centro de ayuda |',
    '',
    'Consejo: si un atajo no responde, comprueba que el foco no esta dentro de un campo de texto. La mayoria de combinaciones globales se ignoran mientras escribes en un input para no interferir con la edicion.',
  ].join('\n'),
};

export default KEYBOARD_SHORTCUTS_ARTICLE;
