# Bounded-context routes (P1-9)

A medida que `server.ts` ha crecido (>5 600 líneas, 695 handlers), cada
release introducía conflictos de merge y dificultaba el code review. Este
directorio empieza la **extracción gradual** a Fastify plugins por bounded
context.

## Cómo funciona

Cada fichero `*.routes.ts` exporta un `FastifyPluginAsync` que se registra en
`server.ts` mediante `app.register(plugin)`. El plugin agrupa los handlers
relacionados con una capacidad concreta del producto.

## Estrategia de migración

- **Fase 1 (esta sesión)**: extraer los 3 módulos más recientes — `webhooks`,
  `assistant`, `tourist-tax` — como prueba del patrón. Cero ruptura: las
  rutas siguen funcionando porque el plugin sigue declarando exactamente las
  mismas paths.
- **Fase 2**: extraer compliance, accounting, revenue, etc. — 1 plugin por
  bounded context. Tras cada extracción, `server.ts` pierde N handlers y
  gana 1 línea `app.register()`.
- **Fase 3**: introducir Zod schemas por plugin con `@fastify/type-provider-zod`
  para validación automática.

## Convenciones

- Cada plugin exporta como default un `async function (app) { ... }`.
- El plugin acepta los servicios como parámetros del closure — no usa
  imports globales.
- Los `route-permissions.ts` entries siguen viviendo en el catálogo central
  (no se mueven aún).
