# Documentación del piloto · cliente real

Material para preparar y ejecutar la primera demo + arranque del piloto.

## Lo que se entrega al cliente

| # | Documento | Cuándo | Quién |
|---|---|---|---|
| 1 | [welcome-pack.md](./welcome-pack.md) | Día 1 del piloto | Equipo del hotel |
| 2 | [DPA.md](./DPA.md) | Antes de firmar | Cliente + abogado |
| 3 | [SLA.md](./SLA.md) | Antes de firmar | Cliente |
| 4 | [pricing-one-pager.md](./pricing-one-pager.md) | Durante la demo | Cliente |
| 5 | [architecture-overview.md](./architecture-overview.md) | A solicitud | CTO / IT cliente |

## Lo que NO se entrega al cliente · interno

| # | Documento | Para qué |
|---|---|---|
| 6 | [demo-runbook.md](./demo-runbook.md) | Tu guion para el día de la demo: checklist, walkthrough, objeciones, plan B |
| 7 | [risk-register.md](./risk-register.md) | Limitaciones conocidas con honestidad y mitigaciones |
| 8 | [runbook.md](./runbook.md) | Operativo: cómo responder a incidencias en producción |
| 9 | [session-summary.md](./session-summary.md) | Resumen de la sesión de preparación automatizada |
| 10 | [cloud-saas-playbook.md](./cloud-saas-playbook.md) | **Paso a paso de hostear el demo a vender HotelOS en cloud** |

## Secuencia recomendada

```
[Negociación]
  └─ Enviar pricing-one-pager.md
  └─ Compartir DPA.md + SLA.md (revisión con abogado)

[Día -1: preparación]
  └─ Leer demo-runbook.md COMPLETO
  └─ Hacer checklist de pre-demo
  └─ Revisar risk-register.md para tener las respuestas listas

[Día D: demo]
  └─ Seguir demo-runbook.md § Guion
  └─ Si pregunta técnica avanzada: ofrecer architecture-overview.md

[Día 1 del piloto]
  └─ Entregar welcome-pack.md al equipo del hotel
  └─ Compartir architecture-overview.md con su IT si lo pidieran

[Operación]
  └─ Soporte sigue runbook.md
```

## Material a producir aún (no automatizable)

- [ ] Deck de slides PDF (5-7 slides) — usar el guion del demo-runbook.md como base
- [ ] Video Loom de 3 min con el walkthrough — útil como follow-up post-demo
- [ ] One-page PDF imprimible del pricing (versión visual con diseño)
- [ ] Tarjetas de visita actualizadas
- [ ] Logo + recursos gráficos en alta resolución para presentación

## Contacto interno

Si necesitas algo durante la demo, mensajea por el canal `#piloto-<cliente>` en Slack.
