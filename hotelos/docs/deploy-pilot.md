# Deploy HotelOS para piloto con cliente

Guía concreta para llevar HotelOS a un cliente piloto en menos de una tarde.
Tres caminos según el escenario.

---

## 🎯 Qué necesitas decidir primero

Antes de elegir camino, responde:

1. **¿Cuánto va a durar el piloto?**
   - Demo de 1-2 horas → **Camino A (ngrok)**
   - 1-2 semanas → **Camino B (Railway / Render)**
   - 1-6 meses con SLA → **Camino C (VPS dedicado)**

2. **¿El cliente va a usar datos reales o demo?**
   - Solo demo → la cadena Iberia con datos sintéticos basta
   - Datos reales del cliente → necesitas onboarding (`PropertySetupWizard`) + GDPR firmado + cargar SES Hospedajes / VeriFactu en sandbox

3. **¿Va a haber integraciones reales?**
   - Channel Manager (Booking/Expedia) → necesitas credenciales sandbox
   - VeriFactu/SES → certificados FNMT del cliente
   - Pagos → cuenta Redsys/Stripe de pruebas

---

## 🚀 CAMINO A · Demo presencial (1-2 horas, gratis)

**Escenario:** Vas al hotel con tu laptop, enseñas la app en una reunión, no instalas nada.

```bash
# 1. Arranca local (lo que ya haces)
cd "/Users/cfernandez/Documents/New project/hotelos"
npm --workspace @hotelos/api run dev          # :3000
npm --workspace @hotelos/admin-web run dev    # :5173

# 2. Expón con ngrok (gratis, 1 comando)
brew install ngrok                            # si no lo tienes
ngrok http 5173                               # te da una URL pública HTTPS

# 3. Configura el API_URL del frontend para que apunte al ngrok del API
ngrok http 3000  # otro túnel, otro terminal
# Copia esa URL y arranca admin-web con:
VITE_API_URL="https://xxxx.ngrok.io" npm --workspace @hotelos/admin-web run dev
```

**Pros:** 5 minutos. Cero coste. Datos en tu máquina (no expuestos a internet).
**Contras:** La URL ngrok cambia cada vez. No puedes cerrar el portátil.

---

## ☁️ CAMINO B · Piloto 1-2 semanas (Railway/Render, €5-20)

**Escenario:** El cliente va a usar la app durante un sprint. Quieres URL fija, HTTPS y zero-ops.

### B.1 — Provisión rápida en Railway (recomendado · más simple)

```
1. Sube el repo a GitHub (privado)
2. railway.app → New Project → Deploy from GitHub
3. Add Plugin → PostgreSQL (te crea la BD)
4. Add Plugin → Redis
5. Crea 3 services apuntando al mismo repo:
   - api (root: apps/api, Dockerfile: infra/docker/Dockerfile.api)
   - admin-web (root: apps/admin-web, Dockerfile: infra/docker/Dockerfile.admin-web)
   - worker (root: apps/worker, Dockerfile: infra/docker/Dockerfile.worker)
6. En cada service, settings → variables, pega todas las del .env.example con valores reales
7. En admin-web añade VITE_API_URL = https://<url-pública-api>.railway.app
8. Deploy → Railway te da URLs HTTPS automáticas
```

**Después del primer deploy:**
```bash
# Conéctate al service api por shell de Railway:
npm --workspace @hotelos/database run db:push
npx tsx src/seeds/chain-8-hotels.ts
npx tsx src/seeds/chain-reservations.ts
```

**Pros:** HTTPS automático, dominio gratis (`*.railway.app`), Postgres managed con backups.
**Contras:** ~€20/mes total. Region por defecto US (puedes elegir EU al crear el proyecto).

### B.2 — Alternativa: Render.com

Similar a Railway, también soporta Dockerfile + Postgres managed. Plan free para hobby
(con cold starts) o Starter $7/service.

### B.3 — Variables de entorno mínimas para piloto

Edita las del `.env.example` antes de pegar en el panel:

```env
# CRÍTICAS (deben ser únicas y seguras)
DATABASE_URL=          # te la da Railway/Render
REDIS_URL=             # te la dan
JWT_SECRET=            # openssl rand -hex 32
ENCRYPTION_KEY=        # openssl rand -hex 32

# Para que el frontend llame al API correcto
PUBLIC_API_URL=https://api.tudominio.com
VITE_API_URL=https://api.tudominio.com

# Opcionales — déjalas en blanco para piloto sin integraciones reales
AI_PROVIDER_API_KEY=    # solo si vas a usar copilot con LLM
SES_HOSPEDAJES_CLIENT_ID=   # solo si vas a enviar partes reales
SES_HOSPEDAJES_CLIENT_SECRET=
PAYMENT_PROVIDER_SECRET=    # solo si vas a procesar pagos reales
```

Todo lo demás (compliance, channel manager) funcionará en **modo demo/sandbox sin claves**.

---

## 🖥️ CAMINO C · Piloto largo o producción (VPS, €5-15/mes)

**Escenario:** El cliente va a estar varios meses, quieres dominio propio, control total.

### C.1 — VPS recomendado

| Proveedor | Plan | €/mes | Notas |
|---|---|---|---|
| **Hetzner CX22** | 4 GB RAM · 2 vCPU · EU | €4,50 | Mejor relación calidad/precio · región Falkenstein/Helsinki |
| DigitalOcean | Basic 4 GB | €24 | Más ecosistema, más caro |
| Contabo | VPS S | €8 | Mucha RAM (16 GB) pero soporte regular |
| OVH | VLE-2 | €5 | Datacenter España (Madrid) |

Yo iría con **Hetzner** para piloto en España (latencia + GDPR EU + barato).

### C.2 — Setup del VPS (Ubuntu 22.04, ~30 minutos)

```bash
# Conéctate por SSH
ssh root@TU_IP

# Instala Docker
curl -fsSL https://get.docker.com | sh
apt install -y docker-compose-plugin git

# Clona el repo (sube el código primero a GitHub privado)
cd /opt
git clone git@github.com:tuusuario/hotelos.git
cd hotelos

# Configura el .env
cp .env.example .env
nano .env
# (genera JWT_SECRET y ENCRYPTION_KEY con `openssl rand -hex 32`)

# Arranca todo
./scripts/deploy-pilot.sh init

# Comprueba
./scripts/deploy-pilot.sh status
```

### C.3 — Dominio + HTTPS con Caddy (10 minutos)

Crea `/opt/hotelos/infra/docker/Caddyfile`:

```caddy
api.tudominio.com {
    reverse_proxy api:3000
}

app.tudominio.com {
    reverse_proxy admin-web:80
}
```

Añade a `docker-compose.pilot.yml`:

```yaml
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
    networks:
      - hotelos

volumes:
  caddy_data:
```

Apunta los DNS de `api.tudominio.com` y `app.tudominio.com` a la IP del VPS.
Caddy obtiene los certificados Let's Encrypt automáticamente.

Cambia el `VITE_API_URL` a `https://api.tudominio.com` y reconstruye:
```bash
./scripts/deploy-pilot.sh down
./scripts/deploy-pilot.sh init
```

### C.3.5 — Primer arranque del piloto (clean-slate, 5 minutos)

La base de datos del piloto empieza vacía: no hay seeds de demo. Para crear la
**primera organización + property + usuario admin** usa el endpoint protegido
`POST /onboarding/bootstrap`.

#### Paso 1 — generar el `BOOTSTRAP_TOKEN`

```bash
# En el VPS
openssl rand -hex 32
# añade el resultado al .env del piloto
echo "BOOTSTRAP_TOKEN=<el-hex-de-32-bytes>" >> /opt/hotelos/.env
docker compose -f docker-compose.pilot.yml up -d api  # reinicia la API
```

#### Paso 2 — confirmar que el bootstrap está abierto

```bash
curl https://api.tudominio.com/onboarding/bootstrap/status
# → {"bootstrapAllowed": true}
```

Si responde `false`, comprueba que `BOOTSTRAP_TOKEN` está en el `.env` **y** que
la base de datos no tiene aún ninguna organización. La guard se desactiva sola
cuando hay al menos una org.

#### Paso 3 — lanzar el bootstrap con los datos reales del cliente

```bash
curl -X POST https://api.tudominio.com/onboarding/bootstrap \
  -H "Content-Type: application/json" \
  -d '{
    "bootstrapToken": "<el-token-del-paso-1>",
    "organization": {
      "name": "Hotel Cliente Real SL",
      "legalName": "Hotel Cliente Real Sociedad Limitada",
      "taxId": "B12345678",
      "country": "ES"
    },
    "property": {
      "name": "Hotel Cliente Real · Madrid",
      "legalName": "Hotel Cliente Real SL",
      "address": "Calle Mayor 1",
      "municipality": "Madrid",
      "province": "Madrid",
      "country": "ES",
      "taxRegion": "mainland",
      "timezone": "Europe/Madrid",
      "sesHospedajesEnabled": true,
      "verifactuEnabled": true
    },
    "adminUser": {
      "email": "admin@cliente-real.com",
      "password": "ContraseñaSegura2026!",
      "fullName": "Admin del Cliente",
      "phone": "+34911000000"
    }
  }'
```

Respuesta esperada:

```json
{
  "organizationId": "ck...",
  "propertyId": "ck...",
  "userId": "ck...",
  "ownerRoleId": "ck...",
  "permissionsSeeded": 78,
  "message": "Piloto inicializado. El endpoint /onboarding/bootstrap queda deshabilitado a partir de ahora."
}
```

#### Paso 4 — comprobaciones post-bootstrap

```bash
# Status ya debería ser false
curl https://api.tudominio.com/onboarding/bootstrap/status
# → {"bootstrapAllowed": false, "reason": "Ya existe al menos una organización..."}

# Login del admin recién creado
curl -X POST https://api.tudominio.com/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@cliente-real.com","password":"ContraseñaSegura2026!"}'
# → {"token": "...", "user": {...}}
```

#### Paso 5 — borrar el `BOOTSTRAP_TOKEN` del .env (defensa en profundidad)

Una vez creado el primer admin, el endpoint ya no aceptará más bootstraps
(guard `count(Organization) === 0`). Aun así, quita el token del `.env` para
reducir superficie:

```bash
sed -i '/^BOOTSTRAP_TOKEN=/d' /opt/hotelos/.env
docker compose -f docker-compose.pilot.yml restart api
```

A partir de aquí, el admin entra en la app, abre **Property Setup Wizard**
desde el sidebar y configura room types, rooms, departments, etc. Para añadir
más usuarios staff usa `POST /users` (requiere permiso `users.invite`, que el
rol "Owner" tiene).

### C.3.6 — Compliance ES: sandbox vs real (depende del cliente)

Las 4 integraciones de compliance (VeriFactu, SES Hospedajes, TBAI foral, IGIC
canario) ya tienen modo dual sandbox/preproducción/producción real en código.
Por defecto el piloto arranca en **sandbox** (stubs locales, no se llama a la
administración).

#### Comprobar estado en cualquier momento

```bash
curl -H "Authorization: Bearer $TOKEN" https://api.tudominio.com/compliance/health
```

Devuelve, para cada integración: modo actual, si el certificado está
configurado y existe en disco, endpoint que se usaría, y stats de envíos de
las últimas 24h.

#### Para pasar a real (VeriFactu pre-producción AEAT, ejemplo)

1. El cliente obtiene un **certificado FNMT** (persona jurídica) y lo exporta
   como PKCS#12 (`.p12` o `.pfx`).
2. Sube el archivo al VPS por SCP a una ruta protegida (`/opt/hotelos/certs/`).
3. Configura el `.env`:
   ```bash
   VERIFACTU_MODE=preproduction
   VERIFACTU_CERT_PATH=/opt/hotelos/certs/cliente-verifactu.p12
   VERIFACTU_CERT_PASSPHRASE=<pass-del-pkcs12>
   VERIFACTU_SOFTWARE_NIF=<nif-de-la-empresa-emisora>
   VERIFACTU_INSTALL_NUMBER=<install-id-asignado-por-AEAT>
   ```
4. Reinicia el API y comprueba `/compliance/health` — `readyForReal: true`
   para verifactu.
5. Emite una factura de prueba contra preproducción AEAT.
6. Cuando AEAT confirme la conformidad, cambia a `VERIFACTU_MODE=production`.

Procedimiento idéntico para SES Hospedajes (`SES_HOSPEDAJES_MODE`), TBAI
(`TBAI_MODE`, sin preproducción — directo a `production`) e IGIC (`IGIC_MODE`).

> ⚠️ **Importante**: los certificados FNMT y la alta como "emisor de
> facturas" en AEAT/MIR/Hacienda Foral los gestiona **el cliente piloto**, no
> HotelOS. Documenta esto en el contrato del piloto.

### C.4 — Backups (5 minutos · CRÍTICO)

Añade un cron diario para backup del Postgres:

El sistema lleva 3 scripts listos en `/opt/hotelos/scripts/`:

#### Paso 1 — provisión del bucket EU (Backblaze B2 recomendado · €0.006/GB/mes)

1. Crea cuenta en backblaze.com (residencia EU).
2. Bucket → "Create bucket": nombre `hotelos-pilot-backup`, región `eu-central-003`, privacidad `Private`.
3. App Keys → "Add a New Application Key" limitado al bucket. Anota `keyID` y `applicationKey`.

#### Paso 2 — `.env.backup` en el VPS

```bash
sudo tee /opt/hotelos/.env.backup > /dev/null <<EOF
DATABASE_URL=postgresql://hotelos:PASSWORD@postgres:5432/hotelos
BACKUP_S3_BUCKET=hotelos-pilot-backup
BACKUP_S3_REGION=eu-central-003
BACKUP_S3_ENDPOINT=https://s3.eu-central-003.backblazeb2.com
BACKUP_S3_ACCESS_KEY=<keyID>
BACKUP_S3_SECRET_KEY=<applicationKey>
BACKUP_ENCRYPTION_KEY=$(openssl rand -hex 32)
BACKUP_RETENTION_DAILY=7
BACKUP_RETENTION_WEEKLY=4
BACKUP_RETENTION_MONTHLY=12
BACKUP_NOTIFY_WEBHOOK=  # opcional: Slack/Discord webhook URL
EOF
sudo chmod 600 /opt/hotelos/.env.backup
```

⚠️ **Guarda `BACKUP_ENCRYPTION_KEY` aparte (gestor de contraseñas)**. Si la
pierdes, los backups en S3 son irrecuperables.

#### Paso 3 — instala `aws cli` + cron

```bash
# AWS CLI v2 (es compatible con cualquier S3-compatible)
sudo apt install -y awscli postgresql-client openssl

# Cron diario 03:00 UTC
sudo crontab -e
# Añade:
0 3 * * *      /opt/hotelos/scripts/backup-postgres.sh >> /var/log/hotelos-backup.log 2>&1
# Test ciclo restore primer domingo de cada mes a las 04:00 UTC
0 4 1-7 * 0    /opt/hotelos/scripts/test-backup-restore-cycle.sh >> /var/log/hotelos-restore-test.log 2>&1
```

#### Paso 4 — ejecuta un backup manual + test de restore

```bash
# Backup ad-hoc
/opt/hotelos/scripts/backup-postgres.sh

# Listar lo que está en S3
/opt/hotelos/scripts/restore-postgres.sh --list

# Test completo de ciclo (backup → S3 → download → restore → verify)
/opt/hotelos/scripts/test-backup-restore-cycle.sh
```

El test de ciclo verifica:
- SHA-256 del dump original vs. el descifrado tras descarga (integridad)
- Row counts > 0 en `users`, `organizations`, `properties` (no es backup vacío)
- Duración total reportada al webhook si está configurado

⚠️ **Un backup que nunca se ha restaurado no es un backup**. El cron mensual
del test es CRÍTICO — si falla recibirás alerta y descubrirás el problema
antes de necesitarlo de verdad.

#### Paso 5 — restore de emergencia (PRODUCCIÓN)

```bash
# A base de pruebas (seguro, recomendado siempre primero)
/opt/hotelos/scripts/restore-postgres.sh --latest

# A producción (peligroso, requiere confirmación interactiva)
/opt/hotelos/scripts/restore-postgres.sh --latest --target="$DATABASE_URL_PRODUCCION"
# El script pide escribir "CONFIRMO RESTAURAR" antes de proceder.
```

---

## 🎬 Plan del día de la demo

### Antes de ir al cliente (1 día antes)

- [ ] Verifica `./scripts/deploy-pilot.sh status` → todo verde
- [ ] Recarga la cadena demo: `./scripts/deploy-pilot.sh seed-iberia`
- [ ] Abre la app en tu portátil. Comprueba 5 pantallas:
  - Front Desk Cockpit (cola de 23 items)
  - Quick Check-in drawer
  - Room Rack tablero por planta
  - GM Dashboard con ▲▼
  - Operations Director con alertas críticas
- [ ] Configura el navegador del cliente con la URL: `app.tudominio.com`
- [ ] Si el piloto va a generar datos reales, **elimina la cadena Iberia primero**:
  ```bash
  ./scripts/deploy-pilot.sh reset    # borra todo
  ./scripts/deploy-pilot.sh init     # vuelve a montar (sin seed)
  # Luego: usar PropertySetupWizard del admin-web para crear la propiedad real
  ```

### Durante la demo (recorrido recomendado · 20 minutos)

1. **Persona Landing** (`/backoffice/personas`)
   → "Cada rol tiene su propia vista. Esto es nuevo en PMS."
2. **Recepcionista · Front Desk Cockpit**
   → "Aquí ve el recepcionista lo que tiene que hacer ahora. Cola priorizada de acciones."
   → Demo: pulsa "Hacer check-in" en una card → drawer 90 segundos.
3. **Housekeeping móvil** (en una tablet o iphone)
   → "Las camareras tienen su propia vista táctil. Adiós a WhatsApp."
4. **Director Operaciones**
   → "Para coordinar: ve los 6 departamentos en una pantalla. Alertas críticas arriba."
5. **GM Dashboard**
   → "Para gerencia: ocupación, ADR, RevPAR, comparativa vs ayer."
6. **Copiloto IA**
   → "Y la IA responde preguntas operativas. 'Qué llegadas tienen saldo pendiente?'"

### Después de la demo

- [ ] Manda al cliente un follow-up con:
  - URL del piloto
  - Credenciales de acceso por rol
  - PersonaGuideScreen como tutorial (`app.tudominio.com/backoffice/personas/guia`)
  - Lista de cosas que **no** están conectadas todavía (LLM real, channel manager real, pagos reales)

---

## 🔐 Seguridad mínima para piloto con datos reales

Si vas más allá de demo y el cliente carga datos reales:

| Punto | Acción | Cuándo |
|---|---|---|
| GDPR | Firma DPA con el cliente | Antes de cargar cualquier dato |
| Cifrado en reposo | Asegura que Postgres tiene encryption-at-rest (managed dbs lo hacen automático) | Antes de producción |
| TLS en tránsito | Caddy/nginx con Let's Encrypt | Antes de pasar la URL al cliente |
| Backups | Cron + offsite (S3 EU) + restore test mensual | Antes de pasar 50 reservas |
| Logs sin PII | Revisa `pino` config: no loguear req.body completos en endpoints con guest data | Antes de producción |
| Rotación de secrets | JWT_SECRET y ENCRYPTION_KEY rotables sin downtime (versionados en `keyring`) | Cuando lo necesites |
| Limitar IPs | Si el piloto es un solo hotel, restringe el VPS a su rango IP via UFW | Opcional |

---

## 🆘 Troubleshooting express

| Síntoma | Causa probable | Fix |
|---|---|---|
| Admin-web no carga (página blanca) | `VITE_API_URL` mal configurado en build | Rebuild admin-web con el ARG correcto |
| API responde 500 | Falta migración | `db:push` |
| API responde pero admin-web no muestra datos | CORS bloquea | Revisa `app.register(fastifyCors, ...)` en server.ts |
| Worker no procesa jobs | Redis no conecta | Comprueba `REDIS_URL` apunta al hostname correcto (no `localhost` desde container) |
| Postgres se llena | Logs PII sin rotar | Configura `log_min_duration_statement` y rota logs |
| Pantallas en blanco con error JS | Build de Vite caché vieja | `docker compose build --no-cache admin-web` |

---

## 📦 Lo que ya tienes en el repo

| Artefacto | Ubicación | Estado |
|---|---|---|
| Dockerfile API | `infra/docker/Dockerfile.api` | ✅ Existente |
| Dockerfile worker | `infra/docker/Dockerfile.worker` | ✅ Existente |
| Dockerfile ai-gateway | `infra/docker/Dockerfile.ai-gateway` | ✅ Existente |
| Dockerfile admin-web | `infra/docker/Dockerfile.admin-web` | ✅ **Creado en esta tanda** |
| docker-compose dev | `infra/docker/docker-compose.yml` | ✅ Existente |
| docker-compose pilot | `infra/docker/docker-compose.pilot.yml` | ✅ **Creado en esta tanda** |
| Deploy script | `scripts/deploy-pilot.sh` | ✅ **Creado en esta tanda** |
| Seed cadena demo | `apps/api/src/seeds/chain-8-hotels.ts` | ✅ Existente |
| .env.example | `.env.example` | ✅ Existente |

---

## 🎯 Recomendación concreta

**Si el cliente es serio y van a ser ≥ 2 semanas:** vete a **CAMINO C** con Hetzner CX22 + Caddy. €4,50/mes. Te lleva 1 tarde. Quedas con un setup listo para producción.

**Si solo es una demo el martes que viene:** **CAMINO A** con ngrok. Tarda 5 minutos.

**Si tienes prisa pero quieres URL estable:** **CAMINO B** con Railway. 30 minutos.

Mi voto: **CAMINO C**, porque ya que has construido HotelOS, deberías mostrarlo en
condiciones realistas con su propio dominio. El cliente percibe diferente
`hotelos.tudominio.com` que `xxxx.railway.app`.
