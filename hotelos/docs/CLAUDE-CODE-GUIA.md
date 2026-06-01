# Guía Claude Code CLI · HotelOS

Referencia rápida para trabajar con Claude Code en el VPS (o en cualquier
máquina). Pensada para el flujo "código en el VPS, terminal desde el
MacBook Neo via SSH".

---

## Arrancar

```bash
ssh hotelos-dev                       # desde el Neo
cd ~/projects/hotelos/hotelos         # OJO: doble hotelos (subdir heredado)
tmux new -s claude                    # sesión persistente (sobrevive SSH drops)
claude                                # arranca · carga CLAUDE.md automáticamente
```

Primera vez: te pide login → abre el link → autoriza con tu cuenta
Anthropic → vuelve a la terminal.

## Reanudar / continuar

```bash
claude --continue     # retoma la última conversación
claude --resume       # elige de una lista de conversaciones pasadas
```

## Slash commands esenciales

| Comando            | Para qué                                              |
|--------------------|-------------------------------------------------------|
| `/help`            | Lista todos los comandos                              |
| `/clear`           | Borra contexto, empieza limpio (entre tareas distintas)|
| `/compact`         | Comprime la conversación cuando se llena              |
| `/model`           | Cambia Sonnet / Opus / Haiku                          |
| `/init`            | Genera/actualiza el CLAUDE.md                         |
| `/memory`          | Edita la memoria (CLAUDE.md) a mano                   |
| `/review`          | Revisa el diff actual                                 |
| `/cost`            | Tokens gastados esta sesión                           |
| `/agents`          | Gestiona subagentes                                   |
| `/mcp`             | Gestiona servidores MCP                               |
| `/terminal-setup`  | Configura Shift+Enter para multilínea                 |
| `/vim`             | Modo vim para editar prompts                          |
| `/exit` (o Ctrl+D) | Salir                                                 |

## Atajos de teclado en la TUI

| Tecla        | Acción                                                       |
|--------------|--------------------------------------------------------------|
| `Esc`        | INTERRUMPE a Claude mientras trabaja (no mata la sesión)     |
| `Esc Esc`    | Edita tu mensaje anterior / rebobina                         |
| `Shift+Tab`  | Cicla modos: normal → auto-accept edits → plan mode          |
| `Ctrl+R`     | Búsqueda en historial de la conversación                     |
| `Ctrl+L`     | Limpia pantalla (no el contexto)                             |
| `↑` / `↓`    | Navega prompts anteriores                                    |
| `@`          | Autocompleta paths (`@apps/api/src/server.ts`)               |
| `#`          | Añade algo al CLAUDE.md sobre la marcha (memoria)            |
| `!`          | Modo bash directo (un comando shell sin pasar por Claude)    |

## Los 3 modos (Shift+Tab cicla)

- **Normal** — Claude propone cada edición, tú apruebas. Seguro, lento.
- **Auto-accept edits** — Claude edita sin preguntar. Rápido. El
  pre-commit hook te protege igual al commitear.
- **Plan mode** — Claude NO toca nada: investiga y te presenta un plan.
  Apruebas → ejecuta. Ideal para tareas grandes.

Regla para HotelOS:
- 1-2 archivos → Normal / Auto-accept
- Refactor o módulo nuevo → Plan mode primero

## Prompts efectivos

Malo:  "arregla el dashboard"
Bueno: "En @apps/admin-web/src/screens/operations/GeneralManagerDashboard.tsx
        el KPI de RevPAR muestra NaN sin datos. Añade fallback a 0 y un
        guion '—' en la UI. Verifica con typecheck."

Patrones que funcionan:
- Apunta archivos con `@`
- "Plantéame un plan, no ejecutes aún" (para tareas grandes)
- "…y al terminar corre `bash .husky/pre-commit`"
- Da criterio de éxito explícito

## Memoria

Para que Claude recuerde algo siempre, en el prompt:
```
# El puerto de la API es 3000, NO 4000
```
Lo añade al CLAUDE.md y persiste entre sesiones.

## Git desde Claude

Claude respeta las reglas del proyecto:
- Solo commit/push si lo pides
- Corre el pre-commit hook (no lo salta)
- Conventional commits

```
Haz commit con mensaje descriptivo y push a main.
```
Si typecheck/discoverability fallan, NO commitea — te avisa.

## Sesiones persistentes (para viajar)

```bash
# Dejas Claude trabajando y te vas:
Ctrl-a d                      # detach tmux (Claude sigue en el VPS)

# En otra ciudad / otro día:
ssh hotelos-dev
tmux attach -t claude         # Claude justo donde lo dejaste
```

## Prompts típicos para HotelOS

```
Continuemos el demo readiness. ¿Qué mocks quedaban con TODO?

Aplana la estructura del repo: quita el subdir /hotelos/ para que apps/
y packages/ queden en la raíz. Plan mode primero.

Implementa el endpoint POST /compliance/exports/jobs y conéctalo al
Compliance Exports Hub screen.

Migra CocoaSidebarV2 a feature parity con el legacy y activa
USE_SIDEBAR_V2=true. Plan primero.

Audita los 5 módulos de compliance en paralelo y dame un informe
consolidado real vs mock.
```

## Verificación antes de declarar "hecho"

Claude debe correr siempre:
```bash
bash .husky/pre-commit         # discoverability (3 checks) + typecheck
```

Y para la app entera:
```bash
npm --workspace @hotelos/admin-web run typecheck
npm --workspace @hotelos/api run typecheck
node scripts/check-discoverability.mjs
```

## Modo no-interactivo (scripting / cron)

```bash
claude -p "corre el pre-commit hook y dime si pasa" --output-format json
```

## Flags útiles al arrancar

```bash
claude                      # interactivo normal
claude --continue           # retoma última conversación
claude --resume             # elige conversación pasada
claude --model opus         # arranca con un modelo concreto
claude -p "..."             # one-shot no interactivo
claude --dangerously-skip-permissions   # auto-aprueba TODO (úsalo solo
                            # en entornos aislados como este VPS dev;
                            # nunca en producción ni con datos sensibles)
```

## Buenas prácticas

1. Una tarea por conversación. `/clear` al cambiar de tema.
2. Plan mode para lo grande, auto-accept para lo rutinario.
3. `Esc` para corregir el rumbo sin reiniciar.
4. Deja que el pre-commit hook sea el guardián — no lo saltes.
5. tmux SIEMPRE — así un corte de SSH no mata el trabajo.
6. Enriquece el CLAUDE.md con `#` cuando descubras algo reusable.
7. Pide verificación explícita ("corre typecheck") en cada tarea.
