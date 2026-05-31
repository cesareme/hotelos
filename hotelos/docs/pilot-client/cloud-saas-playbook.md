# Playbook · de hostear el demo a vender HotelOS en cloud

> Documento operacional. Cómo pasar de "tengo una app" a "tengo SaaS funcionando con clientes que pagan al mes".

---

## Resumen ejecutivo

| Hito | Tiempo | Coste |
|---|---|---|
| Demo hospedado público | 4-6 h | €5/mes infra + €15/año dominio |
| Primer cliente firmado | 4-8 semanas | Tu tiempo |
| Cliente en producción | 7-10 días tras firma | €5/mes por cliente |
| 5 clientes (Founding) | 3-6 meses | MRR ~€2.000/mes |
| 20 clientes | 12-18 meses | MRR ~€10.000/mes |

---

## PARTE 1 · Hosting del demo (4-6 horas la primera vez)

### Stack recomendado

| Capa | Servicio | Coste/mes |
|---|---|---|
| DNS | Cloudflare | Gratis |
| VPS | Hetzner CX22 (EU) | 4,52€ |
| HTTPS | Caddy (auto Let's Encrypt) | Gratis |
| Storage backup | Backblaze B2 (EU) | ~0,50€ |
| Monitoring | UptimeRobot | Gratis |
| Errors | Sentry hobby | Gratis hasta 5K eventos |
| Total | | **~€5/mes** |

### Paso 1 — Dominio

1. Compra dominio (Namecheap / Cloudflare Registrar) ~10€/año
2. Mueve DNS a Cloudflare (gratis)
3. Apunta `app.hotelos.com` y `api.hotelos.com` como registros A a la IP del VPS (cuando lo tengas)

### Paso 2 — VPS Hetzner

1. Cuenta en hetzner.com → Cloud
2. New Project → New Server
3. Location: **Falkenstein** (Alemania) o **Helsinki** (Finlandia)
4. Image: **Ubuntu 24.04 LTS**
5. Type: **CX22** (€4,52/mes · 2 vCPU · 4 GB RAM · 40 GB SSD)
6. SSH key: añade la tuya
7. Crear y anotar la IP pública

### Paso 3 — Setup del servidor

```bash
ssh root@<IP>

apt update && apt upgrade -y
apt install -y docker.io docker-compose-plugin git curl ufw fail2ban openssl

# Firewall
ufw allow ssh
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# Usuario no-root
adduser hotelos --disabled-password --gecos ""
usermod -aG docker hotelos
mkdir -p /home/hotelos/.ssh
cp ~/.ssh/authorized_keys /home/hotelos/.ssh/
chown -R hotelos:hotelos /home/hotelos/.ssh
chmod 700 /home/hotelos/.ssh
chmod 600 /home/hotelos/.ssh/authorized_keys

exit
ssh hotelos@<IP>
```

### Paso 4 — Código y .env

```bash
sudo mkdir -p /opt/hotelos
sudo chown hotelos:hotelos /opt/hotelos
cd /opt/hotelos
git clone git@github.com:tu-usuario/hotelos.git .

# Generar secretos
cat > .env <<EOF
NODE_ENV=production
JWT_SECRET=$(openssl rand -hex 64)
ENCRYPTION_KEY=$(openssl rand -hex 32)
BOOTSTRAP_TOKEN=$(openssl rand -hex 32)
DATABASE_URL=postgresql://hotelos:$(openssl rand -hex 16)@postgres:5432/hotelos
REDIS_URL=redis://redis:6379
APP_PUBLIC_API_URL=https://api.hotelos.com
PILOT_PUBLIC_ORIGIN=https://app.hotelos.com
VERIFACTU_MODE=sandbox
SES_HOSPEDAJES_MODE=sandbox
TBAI_MODE=sandbox
IGIC_MODE=sandbox
SENTRY_DSN=
VITE_SENTRY_DSN=
EOF
chmod 600 .env
```

### Paso 5 — Caddy

```bash
mkdir -p /opt/hotelos/infra/docker
cat > /opt/hotelos/infra/docker/Caddyfile <<'EOF'
api.hotelos.com {
    reverse_proxy api:3000
    encode gzip
}
app.hotelos.com {
    reverse_proxy admin-web:80
    encode gzip
}
EOF
```

### Paso 6 — Levantar servicios

```bash
cd /opt/hotelos
docker compose -f docker-compose.pilot.yml up -d
docker compose -f docker-compose.pilot.yml logs --tail=50 api

# Schema
docker compose -f docker-compose.pilot.yml exec api \
  npm --workspace @hotelos/database exec prisma db push --skip-generate

# Baseline migration (marcar aplicada)
docker compose -f docker-compose.pilot.yml exec api \
  npm --workspace @hotelos/database exec prisma migrate resolve --applied 20260601000000_baseline_missing_tables

curl https://api.hotelos.com/health
```

### Paso 7 — Bootstrap del demo

```bash
curl -X POST https://api.hotelos.com/onboarding/bootstrap \
  -H "Content-Type: application/json" \
  -d @bootstrap-payload.json

# Después: borra el token
sed -i '/^BOOTSTRAP_TOKEN=/d' /opt/hotelos/.env
docker compose -f docker-compose.pilot.yml restart api
```

### Paso 8 — Backups + monitoring

```bash
# Backblaze B2 bucket "hotelos-pilot-backup" eu-central-003
cp scripts/.env.backup.example /opt/hotelos/.env.backup
nano /opt/hotelos/.env.backup   # configura BACKUP_S3_* + BACKUP_ENCRYPTION_KEY
chmod 600 /opt/hotelos/.env.backup

# Cron
sudo crontab -e
# 0 3 * * *      /opt/hotelos/scripts/backup-postgres.sh >> /var/log/hotelos-backup.log 2>&1
# 0 4 1-7 * 0    /opt/hotelos/scripts/test-backup-restore-cycle.sh >> /var/log/hotelos-restore-test.log 2>&1

# UptimeRobot: dashboard.uptimerobot.com → New Monitor → HTTP(s)
# - https://api.hotelos.com/health
# - https://app.hotelos.com
```

---

## PARTE 2 · Vender el PMS

### Etapa A — Prospección (4 semanas antes de cerrar)

**ICP (Ideal Customer Profile):**
- Hotel independiente urbano o boutique español
- 30-150 habitaciones
- Director-propietario con autonomía
- Usa Mews / Cloudbeds / Opera / PMS español viejo
- Dolor declarado: compliance ES, exportar a asesoría, equipo perdido entre herramientas

**Canales de prospección:**

| Canal | Volumen | Conversión |
|---|---|---|
| LinkedIn Sales Navigator | 50 mensajes/semana | 5-10% |
| Asociaciones ITH, CEHAT | Eventos físicos | 20-30% en demo |
| FITUR / Hostelco | Stand o pasillo | 15-25% |
| Referidos | 1-3 por cliente feliz | 50%+ |
| Email frío | 100/semana | 2-5% |

**Email frío template:**

```
Asunto: 4€/hab/mes — PMS español con VeriFactu nativo

Hola [Nombre],

Vi que estáis usando [Mews/Cloudbeds]. Con la entrada
obligatoria de VeriFactu en 2026, te toca contratar un
addon externo de cumplimiento o cambiar de PMS.

He construido HotelOS: el único PMS español con
compliance ES nativa (VeriFactu, SES, TicketBAI, IGIC).
Más ERP contable PGC y AI real (subes PDF y configura
el hotel).

Buscamos 5 Founding Customers a 4€/hab/mes durante
el primer año. A cambio: testimonial + caso de uso.

¿15 min de demo el martes?

[Tu nombre]
[Calendar link]
```

### Etapa B — Demo (sigue demo-runbook.md)

Resumen del flow:
1. Apertura honesta (3 min)
2. Compliance ES nativa (5 min) — diferenciador #1
3. Front Desk en vivo (4 min) — check-in 90s
4. AI real con Property Mapper (4 min) — WOW factor
5. ERP nativo (3 min) — sin exportar a asesoría
6. Mobile (2 min) — eliminar WhatsApp
7. Pricing + cierre (5 min) — 4€/hab/mes Founding

### Etapa C — Propuesta (24-48h post-demo)

Email follow-up con:
- Resumen 5 bullets
- pricing-one-pager.pdf
- DPA + SLA para revisión
- Calendar para segunda reunión

### Etapa D — Cierre

**Cuando dicen sí:**

1. Firma:
   - DPA
   - SLA
   - Pedido (1 página: nombre del hotel, NIF, num habitaciones, fecha go-live, precio, duración)
2. Datos a recoger:
   - Razón social + NIF/CIF + domicilio fiscal
   - Cuenta bancaria (IBAN) para SEPA
   - Email del admin
   - Email del responsable IT
   - Logo del hotel (PNG/SVG alta resolución)
   - Estimación final de habitaciones
3. Fecha go-live (7-10 días)

---

## PARTE 3 · Onboarding del cliente (semana 1)

### Día 1 — Provisión técnica

**Opción multi-tenant en VPS compartido** (recomendado para 1-5 clientes):

```bash
# Añade subdominio del cliente al Caddyfile
cat >> /opt/hotelos/infra/docker/Caddyfile <<EOF

api-cliente1.hotelos.com {
    reverse_proxy api:3000
    encode gzip
}
cliente1.hotelos.com {
    reverse_proxy admin-web:80
    encode gzip
}
EOF

docker compose -f docker-compose.pilot.yml restart caddy

# Reactiva BOOTSTRAP_TOKEN temporalmente
NEW_TOKEN=$(openssl rand -hex 32)
echo "BOOTSTRAP_TOKEN=$NEW_TOKEN" >> /opt/hotelos/.env
docker compose -f docker-compose.pilot.yml restart api

# Bootstrap del cliente
curl -X POST https://api.hotelos.com/onboarding/bootstrap \
  -H "Content-Type: application/json" \
  -d "{
    \"bootstrapToken\": \"$NEW_TOKEN\",
    \"organization\": {...datos reales del cliente...},
    \"property\": {...},
    \"adminUser\": {...}
  }"

# Borra el token
sed -i '/^BOOTSTRAP_TOKEN=/d' /opt/hotelos/.env
docker compose -f docker-compose.pilot.yml restart api
```

**Opción VPS dedicado por cliente** (recomendado cuando el cliente factura >€5M o requiere SLA fuerte):

Repite paso 2-7 de PARTE 1 con dominio del cliente. €5/mes extra.

### Día 2-3 — Migración de datos

Si vienen de otro PMS:

1. Pide export CSV de:
   - Huéspedes con reservas activas
   - Reservas futuras (los próximos 3 meses mínimo)
   - Folios abiertos
2. Property Mapper (subir el CSV de habitaciones)
3. Script Node con `POST /reservations` en batch (te lo escribo si me lo pides)
4. Reconciliación con el equipo del hotel: contar reservas, sumar folios, verificar

### Día 4 — Formación (4h presencial o remota)

| Tiempo | Tema | Audiencia |
|---|---|---|
| 30 min | Intro + roles + sidebar | Todos |
| 60 min | Recepción: Quick Check-in/out, reservas, parte SES, folio | Recepción |
| 45 min | Gobernanta: mobile, room rack | Housekeeping |
| 30 min | Mantenimiento: partes, bloqueo | Mantenimiento |
| 30 min | Dashboard + compliance + reports | Gerencia |
| 45 min | Preguntas | Todos |

Graba con Loom o Zoom.

### Día 5-7 — Soft launch

- PMS antiguo + HotelOS en paralelo 7 días
- Reservas se replican manualmente
- Recepción usa ambos
- Verificar KPIs cuadran

### Día 8 — Switch oficial

- Apaga PMS antiguo
- HotelOS único sistema
- Acompañamiento intensivo 2 semanas

---

## PARTE 4 · Facturación recurrente (cloud SaaS)

### Setup técnico

**Recomendado: Stripe Billing** (más fácil para internacional)
- Account en stripe.com España
- Product "HotelOS Founding" con metered billing
- Base €200/mes + €4 por habitación activa
- Customer por hotel
- Cron diario actualiza usage con count de habitaciones sellable
- Factura automática día 1 del mes

**Alternativa española simple:** Holded o Quipu + SEPA Direct Debit B2B

### Flujo de cobro mensual

1. **Día 1**: factura emitida + email al cliente
2. **Día 3-5**: SEPA ejecuta automáticamente
3. **Día 10**: si rechazo, email educado
4. **Día 20**: llamada
5. **Día 30 impago**: suspender acceso (NO borrar datos por 90 días)

### Métricas a vigilar

| Métrica | Cómo medir | Objetivo |
|---|---|---|
| MRR | Suma de suscripciones activas | Crecer mes a mes |
| Churn rate | % cancelaciones/mes | <2% |
| NPS | Encuesta trimestral | >40 |
| Active usage | Días/mes que el admin login | >20 |
| CAC | Coste de adquisición/cliente | <3x MRR cliente |
| LTV | Lifetime value | >12x MRR mensual |

---

## PARTE 5 · Operación día a día

### Soporte por niveles

| Nivel | Definición | SLA respuesta | SLA resolución |
|---|---|---|---|
| P1 | Servicio down, compliance fallando | 30 min · 24/7 | 4h |
| P2 | Módulo crítico falla (reservas, facturación) | 2h · L-V 9-19h | 1 día |
| P3 | Degradación módulo no crítico | 1 día | 5 días |

**Herramientas:**
- Helpscout o Plain (helpdesk)
- BetterStack (status page + uptime + on-call)
- Sentry (errores)

### Updates de producción

- 1 release/mes (primer martes)
- Aviso 48h previas
- Rolling deploy zero-downtime
- Hotfix anytime para P1

### Comunicación

- **Mensual**: boletín con novedades + tips
- **Trimestral**: QBR con cada cliente (Quarterly Business Review)
- **Inmediato**: status page para incidencias
- **Slack/Discord compartido** solo Founding Customers

---

## PARTE 6 · Escalar (5+ clientes)

### Architecture evolution

```
1-5 clientes:    1 VPS (€5)               ─ multi-tenant en mismo Hetzner
5-20 clientes:   2 VPS + DB managed (€80) ─ API/web separado de DB
20-100 clientes: 5 VPS + CDN + workers    ─ €300-400/mes
100+:            K8s managed              ─ €1500+/mes
```

### Team evolution

| Clientes | Equipo |
|---|---|
| 1-5 | Solo founder |
| 5-15 | +1 Customer Success |
| 15-50 | +1 Backend + 1 Frontend + 2 CS |
| 50+ | Equipo 8-12 + Head of Customer Success |

### Cuándo subir el pricing

- A los 5 clientes Founding: cierra Founding tier, abre Starter (7-9€/hab)
- A los 15-20 clientes: introduce Pro tier (10-13€/hab)
- A los 50+ clientes: introduce Chain tier (11-15€/hab) y Enterprise (negociado)

### Cuándo levantar inversión

- Si MRR crece 10%+ mes a mes y el churn es <3%, NO necesitas inversión todavía
- Si necesitas acelerar comercial (sales reps), considera €200-500K seed con angels del sector hospitality
- Si quieres internacionalizar (Portugal, Italia, México): Serie A €1-3M

---

## Recursos rápidos

### Herramientas recomendadas

| Categoría | Producto | Coste |
|---|---|---|
| Hosting | Hetzner Cloud | €5/mes |
| DNS + CDN | Cloudflare | Gratis |
| Backups | Backblaze B2 EU | <€1/mes |
| Monitoring | UptimeRobot | Gratis |
| Errors | Sentry | Gratis hasta 5K |
| Helpdesk | Plain o Helpscout | Gratis-€20/mes |
| Status page | BetterStack | €18/mes |
| Email transactional | Resend o Postmark | Gratis-€10/mes |
| CRM | HubSpot Free | Gratis |
| Billing | Stripe | 1,4% transacción |
| Contracts | Pandadoc o DocuSign | €25/mes |
| Calendar | Cal.com | Gratis |
| Video calls | Zoom Pro | €15/mes |

### Documentos en este repo

- `docs/deploy-pilot.md` — deployment técnico detallado
- `docs/pilot-client/demo-runbook.md` — guion del demo
- `docs/pilot-client/pricing-one-pager.md` — material comercial
- `docs/pilot-client/DPA.md` — contrato GDPR
- `docs/pilot-client/SLA.md` — acuerdo nivel servicio
- `docs/pilot-client/runbook.md` — operativo soporte
- `docs/pilot-client/risk-register.md` — limitaciones honestas
- `docs/pilot-client/architecture-overview.md` — para CTO del cliente

---

## Tu próximo paso ahora mismo

1. ☐ Compra `hotelos.com` (o tu nombre comercial) — 10€/año
2. ☐ Crea cuenta Hetzner — gratis hasta que crees servidor
3. ☐ Crea cuenta Sentry — gratis hasta 5K eventos
4. ☐ Crea cuenta Backblaze B2 — gratis hasta 10 GB
5. ☐ Sigue PARTE 1 (4-6 horas)
6. ☐ Una vez hosteado, agenda 5 demos para la próxima semana
7. ☐ Sigue demo-runbook.md

🚀
