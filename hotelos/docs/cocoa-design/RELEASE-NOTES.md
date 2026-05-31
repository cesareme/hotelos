# Aurora Cocoa Edition v3.0 — Release Notes

30 de mayo de 2026

## Una nueva era para HotelOS

La Cocoa Edition trae a HotelOS la sensacion nativa de macOS. Cada panel, cada boton, cada animacion siente como una aplicacion Mac de primera clase. Hemos rediseñado el sistema desde cero respetando los principios de Apple HIG.

## Lo nuevo

### Nuevo look macOS
Tipografia SF Pro Display y SF Pro Text. Paleta de colores nativa con modo claro y oscuro automatico. Animaciones spring-based.

### Command Palette ⌘K
Pulsa Cmd+K en cualquier momento y accede a cualquier pantalla o accion en segundos. Como Spotlight pero para tu hotel.

### Preferences ⌘,
Personaliza el tema (claro/oscuro/auto), el color de acento (azul, indigo, purpura, rosa, rojo, naranja, amarillo, verde, teal, cyan), y opciones de accesibilidad. Tus preferencias se sincronizan automaticamente.

### Centro de notificaciones
Un panel lateral derecho con todas tus notificaciones agrupadas por dia. Marcar como leidas, acciones inline, empty state amigable.

### Atajos de teclado completos
Cmd+/ abre el catalogo completo de atajos. Buscar y filtrar por accion.

### Modo oscuro nativo
No es un theme overlay — es modo oscuro construido con tokens del sistema. Vibrante, contrastado, comodo a la vista en jornadas largas.

### Nuevas pantallas Cocoa
Login rediseñado con hero panel + form, paginas de error 404/500 con illustrations propias, onboarding wizard de 5 pasos.

## Mejoras de rendimiento
La pantalla de operaciones carga 31% mas rapida gracias a lazy loading y code splitting.

## Cambios para administradores
Nueva tabla de preferencias de usuario en la base de datos. Migracion automatica via prisma db push.

## Bug fixes
(Lista bugs corregidos durante la operacion)

## Limitaciones conocidas
- ~30 pantallas siguen en Aurora v2 (Material). Roadmap T2 2026 para migrarlas.
- Storybook publico llegara en v3.1.

## Como actualizar
Pull main, npm install, npm run db:push, npm run dev. No requiere migracion manual.

## Agradecimientos
Gracias al equipo y a los pilots hotels por el feedback. Cocoa Edition es para vosotros.

— El equipo HotelOS
