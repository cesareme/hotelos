# HotelOS Aurora Cocoa Edition v3.0

## Resumen ejecutivo

La Cocoa Edition v3.0 representa la evolucion mas ambiciosa del sistema de diseno Aurora desde su lanzamiento. Inspirada en los principios de diseno nativos de macOS, esta version transforma HotelOS en una experiencia visual y operativa que se siente como una aplicacion de escritorio profesional, no como una aplicacion web mas. La decision de adoptar este lenguaje ahora responde a tres fuerzas convergentes: el perfil pro-user de nuestros operadores hoteleros (recepcionistas, revenue managers, housekeeping leads) que pasan 6-9 horas diarias en la plataforma, la madurez tecnica del frontend que permite implementar materiales y animaciones complejas sin penalizar performance, y la oportunidad competitiva de diferenciarnos frente a competidores que siguen anclados en patrones Material Design genericos.

El valor business es triple. Primero, reduce la fatiga visual y cognitiva de usuarios intensivos, traduciendose en menos errores operativos y mayor retencion en sesion. Segundo, eleva la percepcion de calidad del producto: los hoteles de 4 y 5 estrellas que constituyen nuestro segmento premium esperan herramientas que reflejen ese mismo nivel de cuidado. Tercero, prepara el terreno para la futura expansion a iPad y Mac nativos via Catalyst-like, abriendo nuevos canales de distribucion sin reescribir la base de codigo.

## Pilares de diseno

La Cocoa Edition se construye sobre seis pilares interdependientes:

- **Nativo macOS feel** mediante adaptaciones web de NSWindow (window chrome con title bar integrada), NSToolbar (barra de herramientas con segmented controls y traffic lights conceptuales), NSSidebar (navegacion lateral con vibrancy translucida y disclosure groups), reproduciendo la jerarquia visual de Finder y las apps de productividad de Apple.
- **Tipografia SF Pro Display + SF Pro Text** como sistema dual: Display para titulares ≥20px con tracking optimizado y Text para cuerpo ≤19px con legibilidad superior en altas densidades de informacion, complementadas con SF Mono para datos numericos y tabulares.
- **Color tokens del sistema** con paletas semanticas separadas para modo claro y oscuro nativos, no derivadas por inversion sino curadas manualmente para cada modo, garantizando contraste WCAG AA en ambos contextos y consistencia con los system colors de macOS Sequoia.
- **Iconografia SF Symbols-style** con 36 iconos custom disenados especificamente para HotelOS, siguiendo el grid de 17pt, los tres pesos (regular, medium, semibold) y las variantes de relleno (outline, filled, multicolor) caracteristicas del set de Apple.
- **Vibrancy materials + spring animations** aplicando los cuatro niveles de material (chrome, sidebar, popover, hud) con blur dinamico segun contenido subyacente, conjugados con animaciones de transicion que respetan las preferencias de movimiento reducido del sistema.
- **Spring physics motion** con curvas de bezier especificas para acciones interactivas, sustituyendo las transiciones lineales por respuestas elasticas que comunican fisicalidad y refuerzan la sensacion de manipulacion directa de objetos.

## Componentes

El sistema entrega 25 componentes core distribuidos en tres capas. La capa base aporta 12 controles fundamentales: Button (5 variantes), Checkbox, Radio, Switch, TextField, TextArea, Select, Slider, ProgressIndicator, Spinner, Badge y Tooltip, todos con estados completos (default, hover, pressed, focused, disabled, error) y soporte de teclado. La capa de extras suma 5 componentes especializados: SegmentedControl, Stepper, ColorPicker, DatePicker y SearchField, optimizados para flujos hoteleros como seleccion de fechas de estancia y filtrado de inventario. La capa global integra 8 componentes de aplicacion: Sidebar, Toolbar, TitleBar, StatusBar, CommandPalette, ContextMenu, Sheet y Popover, que componen el chrome de cada pantalla.

Complementa este conjunto una biblioteca de 5 illustrations vectoriales (empty inbox, no results, error generico, onboarding welcome, success completion) y un wrapper EmptyState que unifica el patron de pantallas vacias con copy, ilustracion y accion primaria coherentes.

## Features Mac-signature

Seis caracteristicas marca la diferencia con cualquier web app convencional:

- **Cmd+K Command Palette** ofrece busqueda fuzzy global sobre acciones, pantallas, reservas, huespedes y configuraciones, con resultados agrupados por categoria y atajos visibles.
- **Cmd+, Preferences** abre un sheet nativo de preferencias con secciones General, Apariencia, Notificaciones, Accesibilidad y Avanzado, replicando la convencion universal de macOS.
- **Cmd+/ Keyboard Shortcuts Help** despliega un cheat sheet contextual con todos los atajos disponibles en la pantalla actual y los globales.
- **Notification Center** centraliza alertas operativas (check-ins pendientes, overbookings, mensajes de huespedes) con agrupacion temporal y acciones inline.
- **Theme switcher** permite alternar entre light, dark y auto (seguimiento del sistema), mas seleccion de accent color entre 8 opciones, persistido por usuario.
- **Status bar live** muestra metricas en tiempo real (ocupacion del dia, ADR, llegadas restantes) en la parte inferior, siempre visible.

## Backend habilitador

Tres extensiones del API soportan la nueva capa de personalizacion. El endpoint `/users/me/preferences` (GET, PATCH) gestiona theme, accent color y flags de accesibilidad (reducedMotion, highContrast). El endpoint `/developer/keyboard-shortcuts` expone el catalogo completo de atajos para alimentar la pantalla de ayuda y el Command Palette. El modelo User incorpora cuatro campos nuevos: `themePreference` (light | dark | auto), `accentColor` (enum de 8 valores), `reducedMotion` (boolean) y `highContrast` (boolean), todos con defaults sensatos y migraciones idempotentes.

## Migracion

A cierre de W6, 8 pantallas estan migradas a Cocoa Edition: BackOfficeDashboard como flagship, mas Reservas, Huespedes, Tarifas, Disponibilidad, Reportes, Configuracion General y Login. Aproximadamente 30 pantallas permanecen en Aurora Material v1 y se migraran en oleadas trimestrales. El roadmap establece que todas las pantallas estaran migradas a Cocoa Edition antes de cerrar T2 2026, manteniendo paridad funcional durante la transicion mediante un feature flag por pantalla que permite rollback inmediato si surge regresion critica.

## Impacto en bundle

El sistema Cocoa anade 200 KB en componentes (103 KB core + 97 KB globales) mas 3 KB en tokens CSS, totalizando 203 KB raw. Gzipped el impacto real es de aproximadamente 55 KB (28 KB core + 26 KB globales + 1 KB tokens), una fraccion del bundle total. Este crecimiento se compensa parcialmente con la eventual eliminacion de Material Aurora v1 al completar la migracion, lo que retornara el balance neto a niveles inferiores al baseline previo.

## ROI estimado

Las proyecciones, basadas en pilotos internos y benchmarks de industria comparable, estiman tres metricas clave de retorno. Una reduccion del 32% en fatiga visual reportada por usuarios pro tras jornadas completas, medida via encuestas post-shift y heatmaps de pausas. Un incremento del 18% en velocidad operativa comparado con Aurora Material v1, medido en tareas representativas como check-in (de 47s a 39s), creacion de reserva (de 1m24s a 1m09s) y modificacion de tarifa (de 32s a 26s). Y un objetivo de mejora de +12 puntos NPS sobre el baseline actual de 56, llevando el indicador a un rango excelente de 68 que consolide retencion y abra puerta a referrals organicos.

## Proximos pasos

La hoja de ruta inmediata define tres hitos secuenciados. Primero, validar la Cocoa Edition con un cliente pilot real durante T1 2026, idealmente un hotel boutique de 80-120 habitaciones con perfil operativo intensivo, para obtener feedback cualitativo antes del rollout general. Segundo, ejecutar la migracion completa de las ~30 pantallas pendientes a lo largo de T2 2026, organizadas en sprints quincenales con dueno asignado por dominio funcional. Tercero, durante T3 2026, iniciar el trabajo de adaptacion para iPad mediante una capa Catalyst-like que reutilice el 85% del codigo Cocoa Edition existente, ampliando la presencia de HotelOS al canal mobile pro sin duplicar mantenimiento.
