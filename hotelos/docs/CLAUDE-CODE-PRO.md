# Claude Code CLI · Guía PRO · HotelOS

De usuario a power-user. Esta guía asume que ya sabes lo básico (ver
`docs/CLAUDE-CODE-GUIA.md`). Aquí está cómo trabajar como un developer
senior que usa Claude como multiplicador, no como autocompletado.

---

## 0 · La mentalidad pro

La diferencia entre un junior y un pro con Claude Code no son los
comandos — es **cómo encuadran el trabajo**:

- **Junior**: "arréglame esto" → acepta lo primero que sale → debuggea
  el resultado.
- **Pro**: define el problema con precisión → pide un plan → revisa el
  plan → deja que ejecute → verifica con tests → itera.

Las 5 leyes:

1. **Contexto es rey.** Claude solo es tan bueno como lo que sabe.
   Apunta a archivos (`@`), referencia docs, mantén el CLAUDE.md vivo.
2. **Plan antes de código** para todo lo no-trivial. Un mal plan
   detectado en 30s ahorra 30min de código equivocado.
3. **Verificación no negociable.** typecheck + tests + pre-commit hook
   en cada tarea. Claude puede alucinar; el hook no.
4. **Conversaciones cortas y enfocadas.** Una tarea por sesión.
   `/clear` al cambiar de tema. El contexto sucio degrada la calidad.
5. **Tú eres el arquitecto.** Claude ejecuta tu criterio, no lo
   reemplaza. Las decisiones de producto y diseño son tuyas.

---

## 1 · CLAUDE.md · tu activo más valioso

El `CLAUDE.md` se auto-carga en cada sesión. Es la diferencia entre
explicar el proyecto cada vez o que Claude ya lo sepa.

### Jerarquía de memoria (Claude lee todos)

```
~/.claude/CLAUDE.md              ← global · tus preferencias en TODOS los proyectos
<repo>/CLAUDE.md                 ← proyecto · el que ya tienes
<repo>/apps/api/CLAUDE.md        ← subdirectorio · contexto específico de un área
```

Truco pro: pon un `CLAUDE.md` pequeño en subdirectorios complejos
(p.ej. `apps/api/src/modules/compliance/CLAUDE.md`) con las reglas
específicas de ese dominio (cómo firmar VeriFactu, qué no tocar, etc.).
Claude lo carga cuando trabaja ahí.

### Añadir memoria sobre la marcha

En medio de una conversación, empieza un mensaje con `#`:
```
# Los precios siempre se almacenan en céntimos (int), nunca en euros (float)
```
Claude lo guarda en el CLAUDE.md. Úsalo cada vez que corrijas a Claude
sobre algo que debería recordar siempre.

### Qué meter en CLAUDE.md (y qué NO)

SÍ: arquitectura, convenciones, comandos frecuentes, deuda técnica,
"no toques X", paths críticos, gotchas (el puerto 3000 no 4000).

NO: secretos, detalles efímeros, cosas que cambian cada semana,
documentación larga (eso va a docs/ y la referencias).

---

## 2 · Plan mode · el superpoder infrautilizado

`Shift+Tab` hasta ver "plan mode". Claude investiga sin tocar nada y te
presenta el plan. Apruebas → ejecuta.

### Cuándo usarlo SIEMPRE

- Refactor que toca >3 archivos
- Módulo nuevo
- Migración de schema Prisma
- Cualquier cosa en `server.ts` (7000 LOC, fácil romper algo)
- Cuando no estás seguro de cómo Claude abordará algo

### El patrón "plan → critica → ejecuta"

```
[plan mode] Diseña cómo aplanar la estructura del repo quitando el
subdir /hotelos. Considera: el .git está en la carpeta padre, hay CI
workflows con paths, y un pre-commit hook.
```

Claude presenta el plan. Tú lo lees y respondes:
```
El paso 3 rompería los paths de .github/workflows. Ajusta el plan para
actualizar esos paths también. Y haz backup del .git antes.
```

Claude refina. Cuando estés conforme: `procede`.

Esto es **pair-programming con un senior**: el plan es la conversación
de diseño antes de escribir código.

---

## 3 · Subagentes y paralelismo

Para trabajo grande, Claude lanza subagentes que trabajan en paralelo.
Tú no los gestionas — los describes.

### Patrón fan-out (exploración amplia)

```
Audita en paralelo los 5 módulos de compliance (verifactu, ses, tbai,
igic, esrs). Para cada uno: ¿está conectado a backend real o es mock?
¿qué endpoints usa? Dame un informe consolidado.
```

Claude lanza 5 agentes lectores, cada uno cubre un módulo, y sintetiza.
Mucho más rápido que leer secuencial.

### Patrón verify (verificación adversarial)

```
Encontraste 8 bugs. Para cada uno, lanza un agente escéptico que intente
REFUTAR que es un bug real. Solo reporta los que sobrevivan.
```

Esto elimina falsos positivos — patrón que usamos mucho en HotelOS.

### Cuándo NO usar subagentes

Para ediciones puntuales (1-2 archivos), los subagentes son overhead.
Edita directo. Los subagentes brillan en: auditorías, búsquedas amplias,
refactors masivos, verificación multi-ángulo.

---

## 4 · Gestión de contexto (lo que separa pros de juniors)

El contexto de Claude es finito. Un contexto lleno = respuestas peores.

### Comandos clave

- `/clear` — borra TODO el contexto. Úsalo religiosamente al cambiar de
  tarea. Es gratis y mejora la calidad.
- `/compact` — comprime la conversación manteniendo lo esencial. Úsalo
  cuando una tarea larga llena el contexto pero quieres continuarla.
- `/compact [instrucción]` — compacta enfocándose en lo que digas:
  `/compact mantén solo lo del Rate Manager`

### Regla práctica

- Tarea nueva → `/clear` primero.
- Tarea larga que se alarga → `/compact` cuando notes a Claude más lento
  o repetitivo.
- Nunca arrastres 3 tareas distintas en una conversación.

### Señales de contexto sucio

- Claude repite cosas que ya hizo
- Se "olvida" de algo que dijiste hace 10 mensajes
- Respuestas más lentas
→ `/compact` o `/clear`.

---

## 5 · Custom slash commands (automatiza tus flujos)

Crea comandos reutilizables en `.claude/commands/<nombre>.md`. El
contenido es el prompt. Se invocan con `/nombre`.

Ejemplo · crea `.claude/commands/verify.md`:
```markdown
Corre la verificación completa del proyecto y reporta en una tabla:
1. npm --workspace @hotelos/admin-web run typecheck
2. npm --workspace @hotelos/api run typecheck
3. node scripts/check-discoverability.mjs
4. bash .husky/pre-commit
Si algo falla, propón el fix pero NO lo apliques sin que confirme.
```

Ahora escribes `/verify` y Claude lo ejecuta. Útiles para HotelOS:
- `/verify` — typecheck + guardrails
- `/demo-check` — verifica que la app arranca + endpoints responden
- `/new-screen` — scaffold de una pantalla nueva siguiendo las
  convenciones Cocoa + actualiza el sidebar + whitelist

Args: usa `$ARGUMENTS` en el .md para pasar parámetros:
`.claude/commands/screen.md` con "Crea la pantalla $ARGUMENTS siguiendo
el patrón Cocoa..." → `/screen GuestLoyaltyScreen`.

---

## 6 · Hooks (automatización determinista)

Los hooks ejecutan comandos en eventos de Claude (antes/después de
editar, al terminar, etc.). Se configuran en `.claude/settings.json`.

Ejemplo · auto-typecheck después de cada edición de TypeScript:
```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Edit|Write",
      "hooks": [{
        "type": "command",
        "command": "cd \"$CLAUDE_PROJECT_DIR\" && npm --workspace @hotelos/admin-web run typecheck 2>&1 | tail -5"
      }]
    }]
  }
}
```

Diferencia clave con pedirle a Claude que verifique: **el hook SIEMPRE
corre**, Claude no puede "olvidarse". Es determinista.

Hooks útiles:
- PostToolUse Edit → typecheck del workspace tocado
- Stop → corre el pre-commit hook al final de cada turno
- Notification → te avisa (sonido/notif) cuando Claude necesita input

Para configurarlos cómodo: usa el comando `/hooks` dentro de Claude.

---

## 7 · MCP servers (extiende lo que Claude puede tocar)

MCP conecta Claude a herramientas externas: bases de datos, navegador,
APIs, Slack, etc. En tu VPS los más útiles:

- **postgres MCP** — Claude consulta tu BD directamente:
  "¿cuántas reservas in-house hay ahora mismo?" → query real.
- **filesystem MCP** — acceso a archivos fuera del repo si lo necesitas.
- **github MCP** — gestiona issues/PRs sin salir de Claude.

Gestiona con `/mcp`. Para añadir el de Postgres (ejemplo):
```bash
claude mcp add postgres -- npx -y @modelcontextprotocol/server-postgres \
  postgresql://hotelos:hotelos@localhost:5432/hotelos
```
Luego dentro de Claude: "consulta cuántos folios tienen saldo pendiente"
y Claude hace la query real contra tu DB de desarrollo.

---

## 8 · Modo headless (scripting / automatización)

`claude -p "prompt"` corre sin interfaz, ideal para automatizar.

```bash
# Un check rápido
claude -p "corre el pre-commit hook y dime PASS o FAIL" --output-format json

# Generar el changelog de los últimos commits
claude -p "resume los commits desde el último tag en formato changelog"

# En un cron (revisión nocturna)
0 3 * * * cd /home/cesareme/projects/hotelos/hotelos && \
  claude -p "audita si hay screens nuevos sin entry en sidebar" \
  >> ~/nightly-audit.log
```

Flags útiles:
- `--output-format json` — salida parseable
- `--max-turns N` — límite de turnos (evita loops)
- `--allowedTools "Read,Grep"` — restringe qué puede hacer (solo lectura)

---

## 9 · Git workflow pro con Claude

Claude respeta las reglas del repo (pre-commit hook, conventional
commits). Patrones:

### Commits atómicos
```
Haz commit SOLO de los cambios del Rate Manager (no toques los del
sidebar que están a medias). Mensaje conventional commit.
```
Claude usa `git add` selectivo.

### Branch + PR
```
Crea una branch feature/loyalty-tiers, implementa el sistema de tiers,
y abre un PR con gh. Descripción con el qué y el por qué.
```

### Review antes de merge
```
/review
```
Revisa el diff actual buscando bugs antes de commitear.

### Reglas de oro
- Claude NUNCA hace push sin que lo pidas explícitamente.
- El pre-commit hook corre siempre — si falla, no se commitea.
- NO usar `--no-verify` jamás (consensuado en el proyecto).

---

## 10 · Patrones de trabajo avanzados

### TDD con Claude (el más potente)
```
1. Escribe los tests para el cálculo de GOPPAR primero (sin implementar).
2. Corre los tests — deben fallar.
3. Ahora implementa hasta que pasen. No modifiques los tests.
```
Claude no puede "hacer trampa" cambiando el test para que pase — se lo
prohíbes explícitamente. Calidad alta garantizada.

### Refactor grande seguro
```
[plan mode] Quiero extraer el módulo de reservations de server.ts
(7000 LOC) a su propio archivo en src/modules/reservations/. Plan que:
1. Identifique todas las rutas de reservations
2. Las mueva preservando comportamiento
3. Verifique con typecheck tras cada paso
4. No rompa los imports existentes
```

### Debugging sistemático
```
La pantalla X muestra NaN. NO adivines. Primero:
1. Lee el componente y rastrea de dónde sale el dato
2. Mira el endpoint que lo provee
3. Identifica la causa raíz exacta
4. Propón el fix mínimo
Solo después de los 4 pasos, implementa.
```

### Exploración de codebase desconocido
```
Soy nuevo en este módulo. Dame un mapa: qué archivos hay, qué hace cada
uno, cuál es el entry point, y las 3 cosas que debería saber antes de
tocarlo.
```

---

## 11 · Anti-patrones (lo que hacen los juniors)

| ❌ Anti-patrón | ✅ Lo que hace un pro |
|---|---|
| "arregla todo lo que esté mal" | Una tarea concreta y verificable |
| Aceptar el primer plan sin leerlo | Leer, criticar, refinar |
| Arrastrar 5 tareas en una conversación | `/clear` entre tareas |
| Saltarse el pre-commit con --no-verify | Arreglar lo que el hook detecta |
| Pedirle que adivine sin contexto | Apuntar a archivos con @ |
| No verificar, confiar ciegamente | typecheck + tests siempre |
| Dejar el CLAUDE.md desactualizado | Enriquecerlo con # sobre la marcha |
| Leer el .jsonl crudo de 98MB | Usar grep puntual o el readable.md |
| Conversaciones eternas | Cortas, enfocadas, compactadas |

---

## 12 · Flujo diario PRO en el VPS (el loop completo)

```bash
# Mañana — te conectas desde el Neo
ssh hotelos-dev
tmux attach -t claude || tmux new -s claude    # retoma o crea
cd ~/projects/hotelos/hotelos

# Sincroniza
git pull

# Arranca Claude
claude

# Dentro de Claude:
/clear                                  # limpio para hoy
# [describes la tarea con @archivos]
# Shift+Tab → plan mode si es grande
# revisas plan → apruebas
# Claude ejecuta en auto-accept
/verify                                 # tu custom command
# "commit y push"                       # cuando esté verde

# Te vas:
Ctrl-a d                                # detach tmux, todo sigue vivo
```

### Multi-tarea con varias sesiones tmux
```bash
tmux new -s feature-loyalty    # una tarea grande
tmux new -s bugfix-rates       # otra en paralelo
# Ctrl-a d para saltar entre ellas, cada una con su Claude
```

---

## 13 · Trucos específicos HotelOS

```
# Antes de tocar el sidebar
"Lee navigation/Sidebar.tsx y .discoverability-whitelist.json antes de
añadir nada. Recuerda que el pre-commit hook valida coverage."

# Antes de un screen nuevo
"Crea PantallaX siguiendo el patrón Cocoa (CocoaPageHeader + CocoaCard),
añádela al sidebar Y al .discoverability-whitelist.json si es un dialog,
y registra el lazy import en App.tsx."

# Para datos en dev
"Usa el seed: node packages/database/seeds/demo-pre-demo-enrichment.mjs"

# Compliance — cuidado
"El módulo compliance toca AEAT/VeriFactu real (sandbox). Antes de
cambiar nada, lee packages/compliance/src/spain/ y explícame el flujo."

# Recuerda los puertos
"API en 3000, admin-web en 5173. NO 4000."
```

---

## 14 · Mantén el contexto vivo (meta-hábito)

Cada vez que termines algo grande, pídele a Claude:
```
Actualiza CLAUDE.md y docs/SESSION-LOG-2026-05.md con lo que acabamos
de hacer: qué se construyó, qué deuda técnica queda, qué cambió.
```

Así el contexto del proyecto **viaja contigo en git** y la próxima
sesión (en el VPS, en otro laptop, en 3 meses) arranca con el 100% del
conocimiento. Este es EL hábito que te hace imparable: el proyecto se
auto-documenta y cualquier Claude futuro retoma sin fricción.

---

## TL;DR · las 10 cosas de un pro

1. CLAUDE.md siempre vivo (auto-contexto)
2. Plan mode para todo lo no-trivial
3. `/clear` entre tareas, `/compact` en las largas
4. Apunta archivos con `@`, nunca hagas adivinar
5. Verificación no negociable (typecheck + hook)
6. Subagentes para auditorías/refactors masivos
7. Custom commands para tus flujos repetidos
8. Hooks para automatización determinista
9. TDD cuando la corrección importa
10. Actualiza el contexto al cerrar cada tarea grande
```
