# HotelOS · Arquitectura técnica (overview)

> Para el CTO / responsable técnico del cliente piloto.

## 1 · Stack

| Capa | Tecnología | Por qué |
|---|---|---|
| Frontend admin-web | React 19 + Vite + TypeScript | Velocidad, bundle pequeño, HMR rápido. Build de 9 chunks code-split. |
| Frontend mobile (gobernanta/mantenimiento) | React Native + Expo | Compartir lógica con web. |
| API | Node.js 22 + Fastify + Zod | Performance, schema-first, typecheck end-to-end. |
| ORM | Prisma 6 | Type-safe queries, migrations versionadas, schema declarativo. |
| DB | PostgreSQL 15 | Estándar, soporte completo de Row Level Security futuro. |
| Cache (opcional) | Redis | Para sesiones distribuidas y rate-limiting cuando se escale. |
| AI Gateway | Anthropic + OpenAI con fallback gracioso | Multi-provider, sin lock-in. |
| Observability | Sentry (errors) + endpoints `/health` + `/metrics` propios | Producción ready. |
| Auth | JWT con scrypt + lockout + reset flow | Sin dependencias externas (no Auth0/Cognito). |
| Hosting recomendado | Hetzner CX22 (EU) + Caddy + Docker Compose | EU residency, GDPR-OK, €5/mes. |

## 2 · Topología

```
┌──────────────────┐                  ┌──────────────────┐
│ Admin Web        │                  │ Mobile (RN/Expo) │
│ React 19 + Vite  │                  │ Housekeeping     │
│ app.hotel.com    │                  │ Mantenimiento    │
└────────┬─────────┘                  └────────┬─────────┘
         │                                     │
         │   HTTPS/JWT Bearer                  │
         ▼                                     ▼
   ┌───────────────────────────────────────────────────┐
   │ Caddy reverse proxy (auto-HTTPS Let's Encrypt)    │
   └───────────────────┬───────────────────────────────┘
                       │
                       ▼
   ┌───────────────────────────────────────────────────┐
   │ API Fastify · 740 endpoints · Node.js 22          │
   │ ┌─────────────────────────────────────────────┐   │
   │ │ Sentry · Rate limit · RBAC manifest         │   │
   │ │ Zod schemas en endpoints críticos           │   │
   │ │ AuditEvent en cada mutación importante      │   │
   │ └─────────────────────────────────────────────┘   │
   └───────┬───────────────────────────────┬───────────┘
           │                               │
           ▼                               ▼
   ┌──────────────┐                ┌──────────────┐
   │ PostgreSQL   │                │ External     │
   │ 248 modelos  │                │ AEAT VeriFactu (sandbox/prod)
   │ Prisma client│                │ MIR SES Hospedajes (sandbox/prod)
   │              │                │ Hacienda Foral TBAI
   │              │                │ Hacienda Canaria IGIC
   │              │                │ Booking.com (producción)
   │              │                │ Anthropic / OpenAI (opcional)
   │              │                │ SMTP / WhatsApp / SMS providers
   └──────┬───────┘                └──────────────┘
          │
          ▼ pg_dump diario 03:00 UTC cifrado AES-256
   ┌──────────────────┐
   │ Backblaze B2     │
   │ eu-central-003   │
   │ Retención 7d/4w/12m │
   │ Test mensual de restore │
   └──────────────────┘
```

## 3 · Multi-tenancy

- **Organización** es la unidad jurídica (NIF/CIF). Una organización puede tener múltiples propiedades.
- **Property** (hotel) es la unidad operativa.
- **User** pertenece a una organización y se asigna a una o varias propiedades vía `UserPropertyRole`.
- **Role** define permisos. Hay un `Owner` rol con 78 permisos canónicos creado por bootstrap.
- Todos los queries Prisma se filtran por `propertyId` o `organizationId` en `request.userContext`. RBAC en pre-handler.

## 4 · Seguridad

- **Password hashing**: scrypt (Node nativo) con salt + cost factor.
- **JWT**: HS256 firmado, secret en env (rotable).
- **Lockout**: 5 intentos fallidos → bloqueo 15 min.
- **Reset password**: token SHA256 hash + TTL 15 min + single-use.
- **PII encryption**: AES-256-GCM envelope para Guest.documentNumber, Payment.cardLast4, PaymentToken.tokenRef, etc.
- **Backups**: AES-256-CBC con clave separada de credenciales S3.
- **Sentry PII redaction**: cabeceras auth + cookie eliminadas, bodies redactados antes de enviar.
- **Rate limit global**: opt-in por ruta. `/auth/login` con 10 req/min, `/auth/forgot-password` con 5 req/min.
- **Audit trail**: `AuditEvent` inmutable con actorUserId, action, entityType, entityId, beforeJson, afterJson, correlationId.
- **GDPR**: soft-delete con `deletedAt` en Reservation, Guest, Invoice, Folio, Payment. Soporta retención 4-6 años.

## 5 · Compliance ES

Las 4 integraciones (VeriFactu, SES Hospedajes, TBAI, IGIC) tienen modo dual:

| Modo | Endpoint | Cert requerido |
|---|---|---|
| sandbox (default) | stub local | No |
| preproduction | URL oficial preprod | mTLS PKCS#12 |
| production | URL oficial AEAT/MIR/Foral | mTLS PKCS#12 |

Endpoint `/compliance/health` reporta el modo actual y si los certificados están configurados.

## 6 · AI

- `LLMProvider` abstrae Anthropic + OpenAI con fallback.
- `isLlmConfigured()` devuelve `false` si el API key es placeholder → callers degradan a heurística determinista.
- Aplicaciones: OCR de DNI, guest reply draft, copiloto de recepción, agente de reservas, Property Mapper.
- Cada llamada se telemetra en `AiToolCall` con tokens, latency, success/fail.
- `AiGovernance` con políticas, prompts versionados, evals, HITL (human-in-the-loop).

## 7 · Endpoints (740 totales · 668 con entrada en manifest de permisos)

Por categoría aproximada:
- 100+ Reservations / Folios / Invoices
- 80+ Revenue (rate grid, forecast, pickup, recommendations)
- 70+ Compliance (VeriFactu, SES, TBAI, parte viajeros, GDPR)
- 50+ Operations (housekeeping, mantenimiento, room rack)
- 40+ Channel Manager
- 40+ Banking + Accounting
- 30+ AI Gateway
- 30+ Backoffice (room types, departments, configuration)
- 20+ Guest portal + magic links
- 280+ otros (POS, Wallet pass, Workforce, CRM, Loyalty, ESRS, ...)

OpenAPI spec autogenerado en `/developer/openapi.yaml`.

## 8 · Performance

- **Bundle admin-web**: 164 KB entry (gzip 41 KB) + 88 chunks lazy-loaded.
- **Tiempo build**: ~1.5 s.
- **214 tests** corriendo en 215 ms.
- **DB**: 250+ índices Prisma. Queries críticas indexadas.
- **Pagination**: top 15 listados con `take: 100` configurable.
- **N+1 protection**: copilot endpoint refactorizado, otros bajo monitoreo.
- **Code splitting**: vendor (React) + 6 feature chunks (operations, revenue, compliance, aiOps, backoffice, marketplace).

## 9 · Deploy

```bash
# VPS Hetzner CX22 EU - 2 vCPU / 4GB RAM / €5/mes
docker compose -f docker-compose.pilot.yml up -d
# Caddy auto-HTTPS, Postgres en mismo host, API y admin-web como containers
```

Estimación de RAM:
- Postgres: 1 GB
- Node API: 500 MB
- Caddy: 50 MB
- Sobra ~2 GB headroom

## 10 · Observabilidad

- `GET /health` — db + redis + sentry + compliance integrations status
- `GET /metrics` — counters últimas 24h, memory, uptime
- `GET /compliance/health` — modo + readiness por integración
- Sentry con breadcrumbs en check-in, check-out, reserva, factura, login, api calls

## 11 · Backups

- Diario 03:00 UTC: `pg_dump` → AES-256-CBC → Backblaze B2 EU
- Retención: 7 daily + 4 weekly + 12 monthly
- Test mensual de ciclo completo (backup → S3 → restore → verify SHA + row counts)
- Scripts en `scripts/backup-postgres.sh`, `restore-postgres.sh`, `test-backup-restore-cycle.sh`

## 12 · Roadmap conocido

**Q1 2026**: validación Zod amplia (255 endpoints restantes), forms internos cableados, vista mobile FrontDeskDashboard.

**Q2 2026 (acelerable)**: Redsys producción real con certificado del cliente.

**Q3 2026**: Stripe, Adyen, otras OTAs en producción (Expedia, Airbnb, Hotelbeds, VRBO), Salto KS integración real.

**Q4 2026**: Assa Abloy, dormakaba, TESA cerraduras. SII obligatorio para grandes facturadores.

---

_Documento técnico para revisión con CTO/responsable IT del cliente. Solicitar versión inglesa si fuera necesaria._
