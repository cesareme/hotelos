> Runbook operacional para el equipo on-call de HotelOS durante el piloto.

# Runbook · piloto HotelOS

## Acceso de emergencia

| Recurso                  | Cómo entrar                                                  |
|--------------------------|--------------------------------------------------------------|
| VPS Hetzner              | `ssh root@piloto.tudominio.com` (clave SSH en 1Password)     |
| Postgres en el VPS       | `docker exec -it hotelos-postgres-1 psql -U hotelos hotelos` |
| Logs API                 | `docker logs -f hotelos-api-1`                               |
| Logs nginx/caddy         | `docker logs -f hotelos-caddy-1`                             |
| Sentry dashboard         | https://sentry.io/organizations/_[tu-org]_/projects/         |
| Backblaze bucket         | https://secure.backblaze.com → bucket `hotelos-pilot-backup` |

**Contacto cliente**: _[Nombre, móvil, email]_

## Síntomas → diagnóstico

### 1. La app no carga (5xx en /health)

```bash
ssh root@piloto.tudominio.com
docker ps                              # ¿está api up?
docker logs --tail=200 hotelos-api-1   # buscar stacktrace
docker exec hotelos-postgres-1 pg_isready  # ¿postgres responde?
```

Si la API está OOM-killed: `docker stats` para ver memoria. Posibles causas:
fuga en algún job de scheduler, queries N+1 en un endpoint. Capturar heap
snapshot con `kill -USR2` si node está en debug-mode, o reiniciar y abrir
ticket de investigación.

### 2. La app carga pero el login falla con 500

Lo normal es que falle con 401 (credenciales incorrectas). Un 500 indica:
- `BadRequestError`/`UnauthorizedError` no se está mapeando a 4xx → bug.
- Postgres caído o connection pool agotado.

```bash
docker logs hotelos-api-1 | grep "500\|error\|prisma"
docker exec hotelos-postgres-1 psql -U hotelos -c "SELECT count(*) FROM pg_stat_activity;"
```

### 3. Cliente reporta "no veo mis reservas"

Probables causas:
1. **El usuario está en la org/property equivocada** → consultar:
   ```sql
   SELECT u.email, p.name, r.name
   FROM users u
   JOIN user_property_roles upr ON upr.user_id = u.id
   JOIN properties p ON p.id = upr.property_id
   JOIN roles r ON r.id = upr.role_id
   WHERE u.email = 'usuario@cliente.com';
   ```
2. **Permisos faltantes** en el rol del usuario → verificar `role_permissions`
   contra el catálogo `permissions`.
3. **Filtro por fecha** en el front que oculta las reservas (revisar nav del usuario).

### 4. Cliente reporta "no me llega el envío SES"

```sql
SELECT id, status, error_code, error_message, submitted_at, created_at
FROM ses_hospedajes_submissions
WHERE created_at > NOW() - INTERVAL '24 hours'
ORDER BY created_at DESC LIMIT 50;
```

Estados:
- `accepted` · MIR ha aceptado el envío.
- `accepted_with_warnings` · aceptado pero con avisos (ver `response_payload_json`).
- `rejected` · revisar `error_code`/`error_message`.
- `retrying` · se reintentará automáticamente (campo `next_retry_at`).
- `queued` · no se ha enviado todavía — comprobar el scheduler.

Si un envío lleva >24h en estado distinto de `accepted`, hay riesgo legal
(RD 933/2021 obliga a comunicar en 24h). Abrir P1.

Retry manual de un envío específico:
```sql
UPDATE ses_hospedajes_submissions SET status='retrying', next_retry_at=NOW() WHERE id='ses_xxx';
```

### 5. Una factura no aparece en VeriFactu

```sql
SELECT i.invoice_number, i.status, i.verifactu_hash IS NOT NULL AS hashed,
       vs.status, vs.error_code, vs.csv_code
FROM invoices i
LEFT JOIN verifactu_submissions vs ON vs.invoice_id = i.id
WHERE i.id='inv_xxx';
```

Si `hashed = false`, la factura no llegó a ser firmada (probablemente porque
no se ha pasado por el flujo de emisión). Si `vs.status = rejected`, mirar
`vs.error_code` contra la tabla AEAT.

Retry manual:
```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  "https://api.tudominio.com/verifactu/submissions/<submissionId>/retry"
```

### 6. Sentry está saturado de errores idénticos

Si hay un loop generando miles de eventos:
1. Identificar el evento desde Sentry (URL + stacktrace).
2. Mitigar: deshabilitar el cron del scheduler si la causa es un job:
   ```bash
   docker exec hotelos-api-1 env | grep SCHEDULER
   # editar .env: SCHEDULER_DISABLED=true
   docker compose -f docker-compose.pilot.yml restart api
   ```
3. Abrir ticket para fix en código.

## Procedimientos críticos

### Despliegue de una nueva versión

```bash
ssh root@piloto.tudominio.com
cd /opt/hotelos
git pull
docker compose -f docker-compose.pilot.yml build api admin-web
docker compose -f docker-compose.pilot.yml up -d api admin-web
docker logs --tail=50 hotelos-api-1   # verificar startup
curl https://api.tudominio.com/health
```

Si hay cambio de schema:
```bash
docker exec hotelos-api-1 pnpm exec prisma db push --skip-generate
```

**NUNCA `prisma migrate dev`** en piloto — usa `db push --skip-generate` que es
aditivo y no destructivo.

### Rotación de JWT_SECRET

Si sospechas que se ha filtrado el JWT_SECRET, todos los tokens activos
deben invalidarse:

```bash
# Genera nuevo secret
NEW_SECRET=$(openssl rand -hex 64)
# Edita .env
sed -i "s/^JWT_SECRET=.*/JWT_SECRET=$NEW_SECRET/" /opt/hotelos/.env
# Reinicia
docker compose -f docker-compose.pilot.yml restart api
# Notifica al cliente: deben volver a hacer login
```

### Rotación de ENCRYPTION_KEY (PII envelope)

⚠️ **NO RUTINARIO** — los datos cifrados con la clave anterior se vuelven
ilegibles si no se hace re-encrypt. Solo en caso de filtración confirmada.
Procedimiento:

1. Anotar la `ENCRYPTION_KEY` actual como `ENCRYPTION_KEY_OLD`.
2. Generar nueva `ENCRYPTION_KEY` con `openssl rand -hex 32`.
3. Ejecutar script de re-encrypt (TODO: pendiente de escribir).
4. Una vez confirmado, eliminar `ENCRYPTION_KEY_OLD` del `.env`.

### Restore desde backup (escenario catastrófico)

Ver `docs/deploy-pilot.md § C.4` paso 5.

Resumen:
```bash
/opt/hotelos/scripts/restore-postgres.sh --latest                # a base de pruebas
/opt/hotelos/scripts/restore-postgres.sh --latest --target=$DB   # a producción (PELIGRO)
```

## Tareas semanales del on-call

- [ ] Lunes 09:00: revisar `/compliance/health` y reportar al cliente.
- [ ] Lunes 09:30: revisar Sentry — issues nuevas de la semana.
- [ ] Miércoles 14:00: confirmar que el último backup diario en S3 es <24h.
- [ ] Viernes 17:00: snapshot manual del Postgres antes del fin de semana.

## Tareas mensuales

- [ ] Día 1: revisar log de `test-backup-restore-cycle.sh` del día 1-7 del mes
  anterior. Si falló, investigar.
- [ ] Día 1: enviar informe SLA al cliente (ver §11 SLA).
- [ ] Día 5: revisar uso de disco del VPS (`df -h`) y limpiar logs antiguos.
