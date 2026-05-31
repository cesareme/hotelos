# HotelOS · Hostinger VPS deployment guide

End-to-end playbook to get HotelOS running in production on a Hostinger VPS,
behind a custom domain with HTTPS, automatic backups, and CI/CD that deploys
on every push to `main`.

**Estimated time:** 45–60 min for the first setup, then every deploy is a
`git push`.

**Recommended tier:** VPS **KVM 4** (16 GB RAM · 4 vCPU · 200 GB NVMe). KVM 2
works for a pilot with ≤10 hotels; bump to KVM 8 once you cross 30 properties.

---

## Architecture

```
Client browser  →  Cloudflare DNS  →  Hostinger VPS (Ubuntu 24.04 LTS)
                                          │
                                          ▼
                                       Caddy 2  ─── automatic HTTPS via Let's Encrypt
                                          │
                                ┌─────────┼─────────┐
                                ▼         ▼         ▼
                              API     admin-web   guest-web
                            (Fastify) (Vite SPA)   (Vite SPA)
                                │
                       ┌────────┴────────┐
                       ▼                 ▼
                   PostgreSQL          Redis
                  (data + WAL)       (queues)
                       │
                       ▼
                  Nightly dump → ./postgres-backups (retained 14 days)
```

**Multi-tenant by design.** One instance serves every client; data is
partitioned by `organizationId` / `propertyId` at the row level. Onboard a
new client in 3 minutes via the Super-Admin Console (sidebar → Admin &
Developer → "Consola de tenants").

---

## What's in this folder

| File                              | Purpose                                                     |
|-----------------------------------|-------------------------------------------------------------|
| `docker-compose.production.yml`   | Orchestrates Postgres + Redis + API + admin-web + Caddy     |
| `Dockerfile.api`                  | Multi-stage build of the Fastify backend                    |
| `Dockerfile.admin-web`            | Multi-stage build of the Vite SPA (served by nginx)          |
| `Caddyfile`                       | Reverse proxy + automatic Let's Encrypt cert                |
| `.env.production.example`         | Template for production secrets — copy to `.env.production` |
| `scripts/bootstrap-vps.sh`        | First-time setup of a fresh VPS (firewall, Docker, swap, …) |
| `scripts/deploy.sh`               | Zero-downtime rolling deploy                                |
| `postgres-backups/`               | Nightly dumps land here (created on first backup)            |

CI/CD lives in `.github/workflows/`:

| File                | Purpose                                                |
|---------------------|--------------------------------------------------------|
| `ci.yml`            | Guardrails + typecheck + Docker smoke build on every PR |
| `deploy.yml`        | SSH to VPS and run `deploy.sh` when CI passes on main  |

---

## Step-by-step

### 1 · Buy the VPS

1. https://www.hostinger.com/vps-hosting → choose **KVM 4** (or higher).
2. OS template: **Ubuntu 24.04 LTS** (the bootstrap script targets this).
3. During checkout, choose a datacenter close to your customers (Lisbon for
   Spain pilots is the lowest-latency EU option).
4. Note the **public IPv4** and the temporary **root password**.

### 2 · Point your domain at the VPS

1. In your DNS provider (Hostinger DNS, Cloudflare, Namecheap, …) create:
   - `A   app.hotelos.app   → <VPS_PUBLIC_IP>`
2. If you use Cloudflare, set the proxy mode to **"DNS only"** while Caddy
   provisions the cert. After HTTPS is live you can flip it back to
   "Proxied" if you want Cloudflare's WAF/CDN in front.

### 3 · Bootstrap the VPS

```bash
# From your laptop:
ssh root@<VPS_PUBLIC_IP>

# Once in, paste this:
curl -fsSL https://raw.githubusercontent.com/<YOUR_GITHUB_USER>/hotelos/main/deploy/scripts/bootstrap-vps.sh \
  | REPO_URL=git@github.com:<YOUR_GITHUB_USER>/hotelos.git bash
```

What the script does (also documented at the top of the file):

- Updates apt, enables unattended security updates.
- Locks down the firewall to SSH + 80 + 443.
- Disables SSH password auth (key-only).
- Installs Docker Engine + Compose plugin.
- Creates a non-root `hotelos` user (added to `docker` and `sudo`).
- Adds a 4 GB swap file.
- Clones the repo into `/opt/hotelos` (if `REPO_URL` is set).
- Installs the nightly Postgres backup cron job.

**At the end it prints the next steps** — follow those.

### 4 · Fill in the production env

```bash
ssh hotelos@<VPS_PUBLIC_IP>
cd /opt/hotelos
cp deploy/.env.production.example deploy/.env.production
nano deploy/.env.production
```

Fill in:

| Variable             | How to generate                                            |
|----------------------|------------------------------------------------------------|
| `DOMAIN`             | The domain you pointed at the VPS in step 2                |
| `PUBLIC_API_URL`     | `https://$DOMAIN/api`                                       |
| `POSTGRES_PASSWORD`  | `openssl rand -base64 32`                                  |
| `JWT_SECRET`         | `openssl rand -base64 48`                                  |
| `ENCRYPTION_KEY`     | `openssl rand -base64 32` (must be 32 bytes)               |
| `AI_PROVIDER_API_KEY`| Your Anthropic/OpenAI key (optional — graceful fallback)   |
| `OBJECT_STORAGE_*`   | Hostinger Object Storage or AWS S3 / Cloudflare R2 creds   |
| `VERIFACTU_MODE`     | Leave `sandbox` until you have AEAT prod certs             |
| `SENTRY_DSN`         | Optional — your Sentry project DSN                         |

### 5 · First deploy

```bash
cd /opt/hotelos
bash deploy/scripts/deploy.sh
```

The script will:
1. Build the API + admin-web Docker images (the first build takes ~5 min;
   subsequent ones with cached layers take 30–60 s).
2. Bring up Postgres + Redis.
3. Apply the Prisma schema (`db push`).
4. Roll the API + admin-web containers.
5. Smoke-test `https://$DOMAIN/health` and bail out on failure.

Caddy will request a Let's Encrypt cert the first time port 443 is hit.
After ~10 s the cert is live and `https://$DOMAIN/` returns the SPA.

### 6 · Seed the demo data (optional)

```bash
docker compose -f deploy/docker-compose.production.yml --env-file deploy/.env.production \
  exec api node packages/database/seeds/demo-pre-demo-enrichment.mjs
```

This creates the 10 demo properties, ~250 reservations, guests with SES
identity, BAR levels for the next 60 days, groups, allotments, etc.

### 7 · Onboard your first real client

1. Log in to `https://$DOMAIN/` with the super-admin credentials (the seed
   script prints them; alternatively the bootstrap admin user is
   `admin@hotelos.app` — change the password immediately).
2. Use the persona switcher → **"Admin (vista completa)"**.
3. Sidebar → Admin & Developer → **"Consola de tenants"** → **"+ Nuevo cliente"**.
4. Walk through the 5-step wizard.
5. Copy the generated `tempPassword` + `inviteLink` and send them to the
   client's owner email.

That's it — the client is live.

### 8 · Wire up CI/CD (every push to main auto-deploys)

In GitHub: **Repo → Settings → Secrets and variables → Actions → New
repository secret**. Add three secrets:

| Name          | Value                                                       |
|---------------|-------------------------------------------------------------|
| `VPS_HOST`    | Your VPS public IP or hostname                              |
| `VPS_USER`    | `hotelos`                                                   |
| `VPS_SSH_KEY` | Contents of your local `~/.ssh/id_ed25519` (the matching public key must be in `/home/hotelos/.ssh/authorized_keys` on the VPS) |

(Also optional repo variable `PUBLIC_DOMAIN` if you want CI's health probe
to hit `https://$DOMAIN/health` rather than the VPS IP directly.)

After the next push to `main`, the **CI** workflow runs guardrails +
typecheck + Docker smoke build; when it passes, **Deploy to Hostinger VPS**
SSHes in and runs `deploy.sh`. Every push is a deploy.

---

## Operations cookbook

### Tail the API logs
```bash
ssh hotelos@<VPS_PUBLIC_IP>
cd /opt/hotelos
docker compose -f deploy/docker-compose.production.yml logs -f api
```

### Restart just one service
```bash
docker compose -f deploy/docker-compose.production.yml restart api
```

### Apply a schema change
After merging a Prisma schema change to `main`, the deploy script runs
`prisma db push` automatically. To do it manually:
```bash
docker compose -f deploy/docker-compose.production.yml exec api \
  npx prisma db push --skip-generate --schema packages/database/prisma/schema.prisma
```

### Restore from a backup
Nightly dumps land in `/opt/hotelos/deploy/postgres-backups/`:
```bash
ls -lh deploy/postgres-backups
# Restore (DESTRUCTIVE — the existing DB is wiped):
docker compose -f deploy/docker-compose.production.yml stop api
docker compose -f deploy/docker-compose.production.yml exec postgres \
  pg_restore -U hotelos -d hotelos --clean --if-exists < deploy/postgres-backups/dump-20260601_031500.pgcustom
docker compose -f deploy/docker-compose.production.yml start api
```

### Scale up (more RAM / CPU)
Hostinger lets you upgrade in place. After the upgrade:
```bash
# Tell Postgres about the extra RAM:
docker compose -f deploy/docker-compose.production.yml restart postgres
# Bump the limits in docker-compose.production.yml if you want explicit caps.
```

---

## Cost summary

| Item                                       | Monthly (approx)              |
|--------------------------------------------|-------------------------------|
| Hostinger VPS KVM 4 (16 GB · 4 vCPU)        | €17                            |
| Domain (.app, .com, .es)                    | €1–2                           |
| Cloudflare DNS + free CDN                   | €0                             |
| GitHub Actions (free tier covers everything)| €0                             |
| **Total**                                  | **≈ €18–20/month**             |

Per-tenant pricing the customer pays is yours to set — €99–€399/mo is the
range Mews/Cloudbeds/Stayntouch hit; at that pricing one KVM 4 box pays for
itself with the first client.

---

## When to graduate off Hostinger

Hostinger VPS is great up to ~30 hotels / a few hundred concurrent users.
Beyond that, consider:

- **Database** → managed Postgres on Neon or RDS for automatic failover and
  point-in-time recovery.
- **App** → containerised on Fly.io / Railway / DigitalOcean App Platform for
  multi-region.
- **Object storage** → S3 or Cloudflare R2 for unlimited.

The Compose file is portable — moving to a different host is mostly a DNS
swap.
