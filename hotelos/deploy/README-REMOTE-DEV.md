# HotelOS · Remote development on a Hostinger VPS

Your travel laptop becomes a disposable terminal. The code, the database,
the build cache, and the secrets all live on a €9/month VPS. Lose the
laptop on the plane and you lose nothing — buy any laptop, install VS
Code, SSH in, keep coding.

This guide takes you from a fresh Hostinger VPS to a productive
remote-dev setup in about 30 minutes.

---

## Quick architecture

```
   [ travel laptop · MacBook Neo ]              [ Hostinger VPS · Lisbon ]
     • VS Code + Remote-SSH                       • Ubuntu 24.04 LTS
     • ~/.ssh/id_ed25519                          • Node 22 · pnpm
     • ~/.ssh/config alias                        • Postgres 16 · Redis 7
     • Browser at localhost:5173    ───SSH──>     • /home/cesareme/projects/hotelos
                                                  • tmux session "dev"
                                                  • Vite :5173 · API :3000
```

The Vite dev server and the API run on the VPS. SSH port-forwarding (or
VS Code's automatic forward) makes them reachable as `localhost:5173` and
`localhost:3000` in your laptop's browser. Looks local, runs remote.

---

## Step 1 · Pick a VPS tier for dev

| Tier        | Specs                       | Good for                                      | €/mo |
|-------------|-----------------------------|-----------------------------------------------|-----:|
| **KVM 1**   | 4 GB RAM · 1 vCPU · 50 GB   | Trying it out — Vite + tsc strain at this size |   €5 |
| **KVM 2** ⭐ | 8 GB RAM · 2 vCPU · 100 GB  | Sweet spot for HotelOS dev                     |   €9 |
| KVM 4       | 16 GB RAM · 4 vCPU · 200 GB | Overkill for dev — use this for production    |  €17 |

The recommended path is **KVM 2 for dev (€9/mo)**, plus a separate
**KVM 4 for production (€17/mo)** when you sign your first client. €26
total. Keeping dev and production on *different* boxes is the cheapest
form of insurance — a broken `npm install` on dev can't tank a paying
customer.

---

## Step 2 · Bootstrap the dev VPS

1. Buy the VPS, OS template **Ubuntu 24.04 LTS**, datacenter Lisbon.
2. Note the public IPv4 and the temporary root password.
3. SSH in and paste:

   ```bash
   ssh root@<DEV_VPS_IP>

   curl -fsSL https://raw.githubusercontent.com/cesareme/hotelos/main/deploy/scripts/bootstrap-dev-vps.sh \
     | DEV_USER=cesareme REPO_URL=https://github.com/cesareme/hotelos.git bash
   ```

The script (re-runnable, idempotent) does:

| # | Step                                                                  |
|---|-----------------------------------------------------------------------|
| 1 | apt update + install base packages (git, tmux, vim, ripgrep, …)       |
| 2 | Automatic security updates                                            |
| 3 | UFW firewall (SSH only — everything else stays internal)              |
| 4 | Harden SSH (key-only auth, allow tcp/agent forwarding)                |
| 5 | Create non-root user `cesareme` with passwordless sudo                |
| 6 | 4 GB swap (the TypeScript compiler eats RAM)                          |
| 7 | Install Node 22 + pnpm + latest npm                                   |
| 8 | Install Postgres 16 + create `hotelos` DB + role                      |
| 9 | Install Redis 7                                                       |
|10 | Clone the repo to `/home/cesareme/projects/hotelos`                   |
|11 | Install `gh` CLI (for `gh repo clone` of private repos + auth)        |
|12 | Drop a sensible `~/.tmux.conf`                                        |

After it finishes it prints the next-steps for your laptop — that's
**Step 3** below.

---

## Step 3 · Configure your travel laptop (~/.ssh/config)

On the laptop, add this entry (creates the file if it doesn't exist):

```bash
mkdir -p ~/.ssh
cat >> ~/.ssh/config <<'EOF'
Host hotelos-dev
    HostName            DEV_VPS_IP_HERE
    User                cesareme
    IdentityFile        ~/.ssh/id_ed25519
    ForwardAgent        yes
    ServerAliveInterval 60
    ServerAliveCountMax 3
EOF
chmod 600 ~/.ssh/config
```

Replace `DEV_VPS_IP_HERE` with the real IP. Now you can connect with just:

```bash
ssh hotelos-dev
```

> **Why `ForwardAgent yes`?** So that `git push` *on the VPS* uses the
> same SSH key you have on your laptop. You never copy your private key
> to the server; the SSH agent on your laptop signs for you.

---

## Step 4 · Connect VS Code (or Cursor / Zed) via Remote-SSH

1. Install **VS Code** (or Cursor — same protocol).
2. Install the **Remote - SSH** extension (Microsoft, `ms-vscode-remote.remote-ssh`).
3. `Cmd+Shift+P` → "Remote-SSH: Connect to Host…" → pick **hotelos-dev**.
4. VS Code reconnects in a fresh window with the project's files. The
   integrated terminal opens on the VPS. Everything **looks local**,
   actually **runs remote**.
5. Open the folder `/home/cesareme/projects/hotelos`.

VS Code installs a small daemon on the VPS once; subsequent connects are
instant.

> **Recommended extensions to install in the Remote** (they install on
> the VPS, not your laptop):
> Prisma · Biome · TypeScript Vue Plugin · GitLens · ESLint · Tailwind
> IntelliSense (if you use it) · GitHub Pull Requests and Issues.

---

## Step 5 · Run the dev servers in tmux

Inside the VS Code terminal (or any SSH session):

```bash
cd ~/projects/hotelos
cp .env.example .env
nano .env       # set DATABASE_URL=postgresql://hotelos:hotelos@localhost:5432/hotelos
                # generate JWT_SECRET and ENCRYPTION_KEY with openssl rand -base64 32

npm install
npm --workspace @hotelos/database run prisma:generate
npm --workspace @hotelos/database run db:push

# Start tmux so a dropped SSH connection doesn't kill the dev servers:
tmux new -s dev
# Ctrl-a |          # split vertically
# Ctrl-a -          # split horizontally

# In one pane:
npm --workspace @hotelos/api run dev

# In another pane:
npm --workspace @hotelos/admin-web run dev
```

To leave the dev servers running and come back later from another
laptop / network:

```
Ctrl-a d            # detach the tmux session (servers keep running)
exit                # close ssh
# ... fly to a new city, open laptop ...
ssh hotelos-dev
tmux attach -t dev  # everything where you left it
```

---

## Step 6 · Reach the dev servers from your laptop browser

VS Code Remote-SSH **auto-forwards** ports it detects (you'll see a
notification "Open in Browser"). If you prefer manual control:

```bash
# From your laptop:
ssh -L 5173:localhost:5173 -L 3000:localhost:3000 hotelos-dev
```

Then on the laptop browser:
- `http://localhost:5173/` → admin-web (Vite)
- `http://localhost:3000/health` → API

The traffic goes over your existing SSH connection (encrypted, no extra
ports open on the VPS, no domain needed).

---

## Step 7 · Git workflow on the VPS

```bash
# Authenticate gh once (paste the device code in browser):
gh auth login

# From now on, every git command works as expected:
cd ~/projects/hotelos
git checkout -b feature/something
# ... edit, commit, push ...
git push -u origin feature/something
gh pr create --web      # opens GitHub in your laptop's browser
```

Because of `ForwardAgent yes`, your laptop's SSH key signs the push —
no PAT or password lives on the VPS.

---

## Step 8 · Lose the laptop in a café · keep coding

You walk into an Apple Store, buy any cheap MacBook (or use a borrowed
PC):

1. Generate a new SSH key: `ssh-keygen -t ed25519`.
2. Paste the public key into your GitHub account (Settings → SSH keys).
3. SSH into the dev VPS as root once (Hostinger console) and append the
   same public key to `/home/cesareme/.ssh/authorized_keys`.
4. Add the `Host hotelos-dev` block to the new laptop's `~/.ssh/config`.
5. `ssh hotelos-dev && tmux attach -t dev`.

Total downtime: ~10 minutes. Zero code lost. Zero secrets exposed (the
lost laptop only had `~/.ssh/id_ed25519`; you can revoke it from GitHub
+ VPS and roll a new one).

---

## Optional · Tailscale for zero-config networking

If you don't want to expose SSH port 22 on the public internet, install
[Tailscale](https://tailscale.com/) on both the laptop and the VPS
(free for personal use). The VPS gets a private `100.x.x.x` IP visible
only to your devices. Change `~/.ssh/config`'s `HostName` to that
private IP, close port 22 in UFW, and only Tailscale-authenticated
clients can reach the dev box. Highly recommended.

---

## Cost summary

| Item                               | €/month |
|------------------------------------|--------:|
| Hostinger VPS KVM 2 (dev)          |     €9  |
| Domain (only needed for production)|     €0  |
| GitHub Actions                     |     €0  |
| Tailscale (Personal Use)           |     €0  |
| VS Code / Cursor                   |     €0  |
| **Total for travel-dev setup**     |   **€9**|

When the first client comes:

| Item                               | €/month |
|------------------------------------|--------:|
| Hostinger VPS KVM 2 (dev)          |     €9  |
| Hostinger VPS KVM 4 (production)   |    €17  |
| Domain                             |   €1–2  |
| **Total**                          | **≈€28**|

---

## Troubleshooting

**"Permission denied (publickey)" when SSHing in for the first time**
The bootstrap script copies `/root/.ssh/authorized_keys` into the new
user's home. If you SSHed in as root with a password (not a key), there
was nothing to copy. Paste your laptop's `~/.ssh/id_ed25519.pub` into
`/home/cesareme/.ssh/authorized_keys` manually.

**`npm install` runs out of memory**
The 4 GB swap helps, but if you're on KVM 1 (4 GB RAM total), upgrade
to KVM 2. Vite + TypeScript watch mode comfortably uses 2–3 GB.

**Vite dev server times out in the browser**
Vite binds to `localhost` by default. With the SSH port-forward in Step
6 that's fine; if VS Code Remote-SSH's auto-forward isn't working, run
Vite explicitly on all interfaces:
```bash
npm --workspace @hotelos/admin-web run dev -- --host 0.0.0.0
```

**SSH connection drops every few minutes on hotel Wi-Fi**
Already mitigated by `ServerAliveInterval 60` in the config; if it still
happens, also add `Mosh` (`apt install mosh` on the VPS, `brew install
mosh` on the laptop) and use `mosh hotelos-dev` instead of `ssh`. Mosh
survives IP changes and long disconnects.
