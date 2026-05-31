# Demo para socio — kit

Esta carpeta contiene todo lo que necesitas para enviar una demo a un socio sin desplegar nada.

## Contenido

- `guion-loom.md` — guion paso a paso para grabar un Loom de ≈10 min. Indica qué decir y qué hacer en cada pantalla.
- `one-pager.md` — resumen ejecutivo de una página, en español, listo para convertir a PDF.

## Flujo recomendado

### 1. Prepara el entorno (5 min)
- Arranca la API: `npx pnpm --filter @hotelos/api dev` (o ya está corriendo en `:3000`).
- Arranca admin-web: `npx pnpm --filter @hotelos/admin-web dev` (o `:5173`).
- Abre el navegador en `http://localhost:5173/backoffice/reception`.
- Verifica que aparece "HotelOS Madrid Centro" en el topbar y vista "Recepción" en el sidebar. Si no, en la consola del navegador:
  ```js
  localStorage.setItem('hotelos-active-org', 'org_123');
  localStorage.setItem('hotelos-active-property', 'prop_123');
  localStorage.setItem('hotelos-active-property-name', 'HotelOS Madrid Centro');
  localStorage.setItem('hotelos-active-role', 'reception');
  localStorage.setItem('hotelos.role.v1', 'reception');
  location.href = '/backoffice/reception';
  ```
- Cierra cualquier banner de "Empezar recorrido" → "Ahora no".

### 2. Graba el Loom (10-12 min)
- Abre Loom, captura toda la pestaña, micro encendido.
- Sigue `guion-loom.md` escena por escena. Léelo antes para internalizar las "punch lines".
- No leas literal — habla natural.

### 3. Convierte el one-pager a PDF (2 min)
Opciones rápidas:
- **VS Code**: abre `one-pager.md`, instala extensión "Markdown PDF", click derecho → "Export to PDF".
- **Pandoc** (si lo tienes): `pandoc one-pager.md -o one-pager.pdf --pdf-engine=xelatex -V mainfont="Helvetica"`.
- **Online**: pega el contenido en `dillinger.io` y exporta a PDF.

### 4. Envío al socio
Email con:
- Asunto: "**HotelOS — demo de 10 min**"
- Cuerpo (plantilla):
  > Hola [nombre],
  >
  > Te paso una demo de **HotelOS**, la plataforma de PMS+ERP nativa de IA que estoy construyendo para hoteles independientes españoles. Son ~10 minutos.
  >
  > 🎬 **Vídeo:** [pega aquí el link de Loom]
  > 📄 **Resumen:** adjunto el one-pager (1 página).
  >
  > Si lo ves interesante, te propongo una llamada de 30 min la semana que viene para enseñártelo en directo y discutir piloto.
  >
  > Un abrazo,
  > Carlos
- Adjunto: `one-pager.pdf`.

## Después
Tras enviar, registra el envío en tu CRM o pipeline para hacer seguimiento en 3-5 días si no contesta.
