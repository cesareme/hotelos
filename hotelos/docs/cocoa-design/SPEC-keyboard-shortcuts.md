# SPEC: Keyboard Shortcuts — HotelOS Cocoa

Catalogo completo de atajos de teclado inspirados en las apps nativas de macOS (Mail, Notes, Reminders, Calendar, Finder) y adaptados al dominio hotelero. Todos los atajos respetan el muscle memory del usuario macOS y siguen las HIG de Apple.

**Principios de diseno**
- Cmd para acciones primarias; Shift para variantes amplificadas; Option para alternativas; Ctrl para foco/navegacion.
- Cmd+letra inicial cuando es mnemonico (S=Save, F=Find, N=New).
- Cmd+1..9 reservado para navegacion principal de modulos.
- Esc siempre cierra el contexto modal mas reciente.
- Atajos contextuales solo activos cuando el modulo correspondiente tiene foco.

---

## Global

Disponibles en toda la aplicacion, independientemente del modulo activo.

| Shortcut | Accion |
|--|--|
| Cmd+K | Command palette (Spotlight-style) |
| Cmd+/ | Help center / atajos overlay |
| Cmd+, | Settings (preferencias del usuario) |
| Cmd+N | New (contextual al modulo activo) |
| Cmd+F | Find / search en vista activa |
| Cmd+Shift+F | Find global (toda la base de datos) |
| Cmd+R | Refresh / recargar datos |
| Cmd+L | Logout |
| Cmd+Shift+L | Lock screen (sin cerrar sesion) |
| Esc | Close modal / cancelar accion |
| Cmd+S | Save (en formularios) |
| Cmd+Shift+S | Save As / guardar copia |
| Cmd+Z | Undo (donde aplique) |
| Cmd+Shift+Z | Redo |
| Cmd+P | Print (vista actual) |
| Cmd+Shift+P | Print preview |
| Cmd+W | Close window / tab |
| Cmd+Q | Quit app |
| Cmd+M | Minimize window |
| Cmd+H | Hide HotelOS |
| Cmd+Shift+N | New window |

---

## Navigation

Cambio rapido entre los modulos principales del shell.

| Shortcut | Accion |
|--|--|
| Cmd+1 | Front Desk |
| Cmd+2 | Reservations |
| Cmd+3 | Groups |
| Cmd+4 | Allotments |
| Cmd+5 | Billing |
| Cmd+6 | Compliance |
| Cmd+7 | Reports |
| Cmd+8 | Housekeeping |
| Cmd+9 | Settings (modulo, no preferencias) |
| Cmd+Shift+S | Sidebar toggle |
| Cmd+Shift+I | Inspector toggle |
| Cmd+Shift+T | Toolbar toggle |
| Cmd+Option+Left | Modulo anterior |
| Cmd+Option+Right | Modulo siguiente |
| Cmd+T | New tab (en modulos con tabs) |
| Cmd+Shift+] | Tab siguiente |
| Cmd+Shift+[ | Tab anterior |
| Cmd+J | Jump to date (en vistas temporales) |
| Cmd+G | Go to record by ID |

---

## Front Desk

Atajos contextuales del modulo de operaciones del lobby.

| Shortcut | Accion |
|--|--|
| Cmd+N | New walk-in reservation |
| Cmd+I | Check-in seleccionado |
| Cmd+O | Check-out seleccionado |
| Cmd+Shift+R | Asignar room |
| Cmd+E | Editar guest profile |
| Cmd+D | Duplicar reserva |
| Cmd+Shift+M | Mover reserva (cambio de room) |
| Cmd+B | Block room |
| Cmd+U | Unblock room |
| Space | Quick view (peek) de la reserva |
| Return | Abrir reserva en detalle |
| Cmd+Return | Abrir en nueva ventana |
| Cmd+Backspace | Cancelar reserva |
| Tab | Siguiente field / room en grid |
| Shift+Tab | Field / room anterior |

---

## Reservations

| Shortcut | Accion |
|--|--|
| Cmd+N | New reservation |
| Cmd+Shift+N | New reservation from template |
| Cmd+F | Filter sidebar toggle |
| Cmd+Shift+F | Advanced search |
| Cmd+Option+1 | View: List |
| Cmd+Option+2 | View: Calendar |
| Cmd+Option+3 | View: Tape chart |
| Cmd+Option+4 | View: Kanban (status) |
| Cmd+Return | Confirmar reserva tentativa |
| Cmd+Shift+C | Copiar PNR / locator |
| Cmd+Shift+E | Email itinerario al guest |
| Cmd+Shift+P | Imprimir registration card |
| Cmd+Option+H | Historial de cambios |
| Cmd+Option+N | Add note / observacion |
| Cmd+Option+T | Add tag |
| Cmd+Left | Dia anterior (en calendar view) |
| Cmd+Right | Dia siguiente |
| Cmd+Up | Semana anterior |
| Cmd+Down | Semana siguiente |
| Cmd+T | Today (snap al dia actual) |
| Cmd+Shift+G | Convertir a grupo |
| Cmd+Shift+W | Add to waitlist |

---

## Groups

Manejo de bloques, allotments y eventos.

| Shortcut | Accion |
|--|--|
| Cmd+N | New group |
| Cmd+Shift+N | New group from template |
| Cmd+B | Block rooms |
| Cmd+R | Release rooms (pickup release) |
| Cmd+Shift+P | Pickup report |
| Cmd+Shift+R | Rooming list editor |
| Cmd+Shift+I | Import rooming list (CSV/XLSX) |
| Cmd+E | Edit master contract |
| Cmd+Shift+E | Edit rate code del grupo |
| Cmd+Shift+B | Banquet / event order link |
| Cmd+Option+M | Materializar reservas individuales |
| Cmd+Option+D | Desmaterializar |
| Cmd+Option+C | Cutoff date editor |
| Cmd+Option+L | Group ledger view |
| Cmd+Return | Confirmar bloqueo |
| Cmd+Backspace | Cancelar grupo |
| Space | Quick view del grupo |
| Cmd+Shift+T | Toggle vista tape vs grid |

---

## Folio / Billing

Operaciones financieras sobre cuentas de huesped y master accounts.

| Shortcut | Accion |
|--|--|
| Cmd+N | New folio / sub-folio |
| Cmd+Shift+N | New manual posting |
| Cmd+P | Post charge |
| Cmd+Shift+P | Post payment |
| Cmd+T | Transfer charge a otro folio |
| Cmd+Shift+T | Split folio |
| Cmd+J | Adjustment / correccion |
| Cmd+Shift+J | Void posting |
| Cmd+R | Refund |
| Cmd+Shift+R | Routing rules editor |
| Cmd+I | Invoice / factura electronica |
| Cmd+Shift+I | Reissue invoice |
| Cmd+E | Email folio al guest |
| Cmd+Shift+E | Export folio (PDF/CSV) |
| Cmd+B | Balance summary |
| Cmd+Shift+B | Aging buckets |
| Cmd+L | Lock folio (read-only) |
| Cmd+Shift+L | Unlock (requires manager auth) |
| Cmd+Option+C | Close folio (checkout final) |
| Cmd+Option+R | Reopen folio (auditoria) |
| Cmd+Option+T | Tax exemption toggle |
| Cmd+D | Discount editor |
| Cmd+Shift+D | Comp wizard |
| Up / Down | Navegar postings |
| Return | Edit posting seleccionado |
| Cmd+Backspace | Eliminar posting (con auth) |

---

## Housekeeping

| Shortcut | Accion |
|--|--|
| Cmd+1 | Status: Clean |
| Cmd+2 | Status: Dirty |
| Cmd+3 | Status: Inspected |
| Cmd+4 | Status: Out of order |
| Cmd+5 | Status: Out of service |
| Cmd+Shift+A | Asignar room a camarista |
| Cmd+Shift+D | Discrepancia report |
| Cmd+Shift+M | Maintenance ticket |
| Cmd+R | Refresh board |

---

## Reports

| Shortcut | Accion |
|--|--|
| Cmd+N | New report from template |
| Cmd+R | Run report |
| Cmd+Shift+R | Re-run con parametros |
| Cmd+E | Export (PDF/XLSX/CSV) |
| Cmd+Shift+E | Email report |
| Cmd+P | Print |
| Cmd+S | Save as favorito |
| Cmd+Shift+S | Schedule report |
| Cmd+F | Filter panel |
| Cmd+G | Group by toggle |

---

## Compliance / Night Audit

| Shortcut | Accion |
|--|--|
| Cmd+Shift+A | Start night audit |
| Cmd+Shift+P | Pause audit |
| Cmd+Shift+F | Finish audit (roll date) |
| Cmd+Shift+R | Rollback (manager only) |
| Cmd+E | Export CFDI / e-invoice batch |
| Cmd+Shift+E | Resend rejected CFDI |
| Cmd+L | Lock day |
| Cmd+Shift+L | Unlock day |

---

## Inspector / Detail Pane

Cuando el inspector tiene foco (Cmd+Shift+I activo).

| Shortcut | Accion |
|--|--|
| Cmd+Option+1 | Tab: Overview |
| Cmd+Option+2 | Tab: Notes |
| Cmd+Option+3 | Tab: History |
| Cmd+Option+4 | Tab: Files |
| Cmd+Option+5 | Tab: Comms |
| Tab | Field siguiente |
| Shift+Tab | Field anterior |
| Cmd+Return | Guardar y cerrar |
| Esc | Cerrar sin guardar |

---

## Command Palette (Cmd+K)

Atajos dentro del palette overlay.

| Shortcut | Accion |
|--|--|
| Up / Down | Navegar resultados |
| Return | Ejecutar accion |
| Tab | Auto-completar query |
| Cmd+Return | Abrir en nueva ventana |
| Cmd+Shift+K | Toggle entre acciones / navegacion / records |
| Esc | Cerrar palette |

---

## Accessibility

Cumplen con WCAG 2.2 AA y las preferencias de macOS Accessibility.

| Shortcut | Accion |
|--|--|
| Cmd+Plus | Increase font size (UI scale) |
| Cmd+Minus | Decrease font size |
| Cmd+0 | Reset font size al default |
| Ctrl+Tab | Cycle focus entre paneles |
| Ctrl+Shift+Tab | Cycle focus en reversa |
| Ctrl+F1 | Toggle full keyboard access |
| Ctrl+F2 | Focus menu bar |
| Ctrl+F3 | Focus toolbar |
| Ctrl+F4 | Focus sidebar |
| Ctrl+F5 | Focus main content |
| Ctrl+F6 | Focus inspector |
| Cmd+Option+8 | Toggle high contrast |
| Cmd+Option+F5 | Accessibility shortcuts panel |
| VO+Cmd+Letter | VoiceOver landmark jump |
| Cmd+Option+R | Reduce motion toggle |

---

## Reservas: notas de implementacion

- Todos los atajos contextuales deben mostrarse en tooltips con un delay de 800ms (segun spec de motion).
- El help overlay (Cmd+/) muestra solo atajos activos en el contexto actual, agrupados por seccion.
- Cuando hay conflicto entre atajo global y modulo, **gana el modulo activo** y se notifica visualmente en el palette.
- Los atajos de auditoria nocturna requieren rol Manager o superior; otros usuarios reciben prompt de elevation.
- Personalizacion: usuarios pueden remapear atajos en Settings > Keyboard. Conflictos se detectan en tiempo real.
- Internacionalizacion: shortcuts mostrados con el simbolo de la tecla segun layout (Cmd, Ctrl, Option, Shift) y traducen a etiquetas Windows (Ctrl, Alt, Shift, Win) en build cross-platform.

---

**Referencias**
- Apple HIG: Keyboard Shortcuts
- Mail.app, Notes.app, Reminders.app, Calendar.app shortcut maps
- SPEC-components.md (eventos de teclado por componente)
- SPEC-darkmode-a11y.md (focus rings y VoiceOver)
- 06-motion.md (timings de overlays)
