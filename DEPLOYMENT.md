# ALNOKHBA QB — Deployment Guide (Hostinger VPS & any Docker host)

Target: a clean Ubuntu 22.04/24.04 VPS (Hostinger KVM 2–4 GB RAM is sufficient for a school; 4 GB+ recommended for heavy OMR/PDF batches). The stack ships as **3 containers**: Next.js app, Python OMR engine, Caddy (HTTPS gateway).

---

## 1. Prepare the server

```bash
ssh root@YOUR_SERVER_IP
# firewall + basics
apt update && apt upgrade -y
apt install -y curl git ufw
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable

# Docker
curl -fsSL https://get.docker.com | sh

# DNS (at your registrar):  A  qb.example.com  →  YOUR_SERVER_IP
```

## 2. Get the code

```bash
adduser --disabled-password --gecos "" qb && usermod -aG docker qb
su - qb
git clone <YOUR-QB-REPO-URL> alnokhba-qb && cd alnokhba-qb
```

> The QB code is independent of Alnokhba Management / Edu / Centres — it has its own database, config and containers. Do not share volumes with the other products.

## 3. Configure

```bash
cp .env.example .env
# generate a strong secret and edit .env
echo "AUTH_SECRET=$(openssl rand -base64 48)" >> .env
nano .env    # keep DATABASE_URL=file:/app/db/custom.db (compose overrides path)
```

Edit `docker/Caddyfile` → replace `qb.example.com` with your domain. Caddy obtains/renews Let's Encrypt certificates automatically.

## 4. Launch

```bash
cd docker
docker compose up -d --build     # first build takes a few minutes
docker compose ps                # app, omr-engine, caddy → Up
curl -s https://qb.example.com/api/health
# → {"ok":true,"db":true,"pdf":{...},"omrEngine":{"ok":true}}
```

First-time data init (inside the app container):

```bash
docker compose exec app sh -c "node node_modules/prisma/build/index.js db push --skip-generate"  # sync schema (no-op on first run)
docker compose exec app sh -c "ls scripts"   # seed-auth.ts ships with the image
# seed users/taxonomy (uses bun inside the builder stage; from host instead):
cd .. && bun install && bun run db:seed      # OR run once locally against a copy
```

> Simpler alternative: run `bun run db:push && bun run db:seed` once on your machine against the production `DATABASE_URL`, or exec a one-off node script. The seeded accounts are listed in the README — **change their passwords immediately** (الإدارة → reset key icon).

## 5. Backups (mandatory)

Everything persistent lives in the `app-db` volume: `custom.db` + `db/uploads` + `db/scans` + `db/assignments`.

```bash
# manual
bash scripts/backup.sh ./backups

# nightly 03:15 + keep 14 (script enforces retention)
crontab -e
#   15 3 * * *  cd /home/qb/alnokhba-qb && docker compose -f docker/docker-compose.yml exec -T app sh -c 'true' >/dev/null; bash scripts/backup.sh /home/qb/backups >> /home/qb/backup.log 2>&1
```

Restore:

```bash
bash scripts/restore.sh backups/anqb-YYYYmmdd-HHMMSS.tar.gz
docker compose restart app
```

Off-site copy (recommended): `rsync`/`rclone` the `backups/` directory to any object storage.

## 6. Maintenance

```bash
docker compose logs -f app          # app logs (also: /api/health for status)
docker compose logs -f omr-engine   # OMR pipeline logs
docker compose pull && docker compose up -d --build   # update
docker compose restart app          # after restoring a DB
```

**Memory**: the Chromium PDF pool + OpenCV engine are the heavy parts. On 2 GB VPS add `mem_limit: 1500m` to `app` and enable a 2 GB swapfile:
```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

---

## 7. PDF export engine (Chrome) — read this if PDF export fails

Exam/answer-key PDFs and OMR sheets are rendered by a **chrome-headless-shell pool** (vector text, embedded Tajawal/Amiri fonts — never screenshots).

The engine resolves its browser automatically, in order:

1. `$CHROME_PATH` / `$PUPPETEER_EXECUTABLE_PATH` — an explicit existing browser
2. An unpacked browser under `./chrome/` (created by `bun run chrome:install`)
3. Compressed `*.gz` copies under `./chrome/` (produced by `bun run build` — see below) — extracted once on first render
4. A **one-time runtime download** (~150 MB, needs internet) via the bundled `@puppeteer/browsers` CLI — this is what keeps deploy artifacts small
5. Distro Chromium at the usual system paths (`/usr/bin/chromium`, …)

**Docker install (default guide): nothing to do.** The image ships Chromium and sets `CHROME_PATH=/usr/bin/chromium`.

**Managed platform publish (z.ai): nothing to do either.** The artifact stays small; on the first PDF render (or via the `/api/health` warm-up right after boot) the server fetches chrome-headless-shell once into `./chrome/` and reuses it. First export may take ~10–60 s; every later export is ~1 s. If the host has **no internet**, set `CHROME_PATH` or copy an existing `chrome/` folder next to the server.

**Bare-metal / standalone deploy (`bun run build` + `bun run start`, no Docker):**

```bash
cd /path/to/app            # the directory you run the server from
cp .env.example .env       # if not done yet
bun run chrome:install     # downloads chrome-headless-shell into ./chrome/ (~150 MB, one-time)
bun run build              # build packs ./chrome as .gz into .next/standalone/ (stays small)
bun run start
```

Skip `chrome:install` and the server simply downloads the browser itself on first render (internet required).

If you ever see the Arabic error «لم يتم العثور على متصفح Chrome», it lists every path it probed and the fix hints. `/api/health` shows `pdf` status for a quick check.

---

## 8. PostgreSQL (optional, recommended for large multi-org installs)

The data layer is Prisma — switching engines is a provider change:

1. `docker compose add postgres:16-alpine` service (volume `pg-data`, healthcheck `pg_isready`), set `DATABASE_URL=postgresql://qb:STRONG@postgres:5432/alnokhba?schema=public`.
2. In `prisma/schema.prisma` change `provider = "sqlite"` → `"postgresql"`.
3. Prisma enums: SQLite builds store role/status as `String` — PostgreSQL accepts the same schema unchanged (strings), or you may convert columns to native enums later.
4. `docker compose exec app sh -c "prisma db push"` then seed, then restore data from a SQLite backup if migrating.

Keep the `postgres` service on an internal network only (no published ports).

## 9. Reverse-proxy notes

- All client→backend traffic is same-origin (cookies are `SameSite=Lax`); Caddy proxies `:443 → app:3000` — no extra CORS config needed.
- The OMR engine is **never exposed publicly**; the Next backend proxies to it over the internal Docker network (`OMR_ENGINE_URL=http://omr-engine:3032`).
- Body size: Caddy default (no limit) is fine; the app itself caps uploads at 20 MB (documents) / 40 MB (PDF workspace, client-side) and OMR scan payloads at 25 MB.

## 10. Separation from other Alnokhba products

- QB ships its own `docker-compose.yml`, database volume and Caddy site block. To host beside Alnokhba Management/Edu/Centres on one VPS: run **separate compose projects**, and add one site block per product in a single shared Caddy (or give each its own Caddy on different ports behind your edge).
- Never point two products at the same `DATABASE_URL` or volume.

## 11. Vercel runbook — AI provider (Groq), storage cleanup, redeploy

### 11.1 Switch the AI provider to Groq (env vars only, no code change)

The AI gateway (`src/lib/ai/client.ts`) speaks OpenAI-compatible
`/chat/completions`; Groq works as-is. Set these in the Vercel dashboard
(**Settings → Environment Variables**, all environments) or via CLI:

```bash
vercel env rm AI_API_KEY production && \
vercel env add AI_API_KEY production      # paste: gsk_… (the Groq key)
vercel env add AI_BASE_URL production     # https://api.groq.com/openai/v1
vercel env add AI_VISION_MODEL production # meta-llama/llama-4-scout-17b-16e-instruct
vercel env add AI_CHAT_MODEL production   # llama-3.3-70b-versatile
vercel env add AI_MODEL production        # llama-3.3-70b-versatile
vercel env add AI_FALLBACK_MODEL production # meta-llama/llama-4-maverick-17b-128e-instruct
```

Then redeploy (env changes only apply to NEW deployments):
`git commit --allow-empty -m "chore: deploy" && git push`
or `vercel --prod`.

Verify: `curl https://alnokhba-qb.vercel.app/api/health` →
`"ai":{"mode":"env","baseUrl":"https://api.groq.com/openai/v1","model":"…"}`
then run a real extraction from the استخراج ذكي tab.

NOTE: `AI_API_KEY` is a secret — never commit it to the repo; Vercel env
vars (or `.env.local`, git-ignored) only.

### 11.2 Clean up Vercel deployment storage ("100% of storage used")

Vercel counts every deployment's source + build artifacts against the plan's
storage. Old deployments can be deleted safely — **never** the production
one (`target=production`) and never the newest one per environment.

```bash
TOKEN="<VERCEL_TOKEN>"; TEAM=""   # optional: "&teamId=team_…"
PID="prj_n57xBTPm2x6kgtI1586Mgmtlf23H"

# list the 100 most recent deployments
curl -s "https://api.vercel.com/v6/deployments?projectId=$PID&limit=100$TEAM" \
  -H "Authorization: Bearer $TOKEN" > /tmp/deployments.json

# delete every deployment older than the latest production one (dry-run first!)
python3 - <<'PY'
import json, os, time, urllib.request
TOKEN = os.environ["TOKEN"]; PID = os.environ["PID"]
d = json.load(open("/tmp/deployments.json"))
deps = sorted(d["deployments"], key=lambda x: x["createdAt"])
prod = [x for x in deps if x.get("target") == "production" and x.get("state") == "READY"]
keep = prod[-1]["uid"] if prod else None
for x in deps[:-6]:                      # always keep the latest 6
    if x["uid"] == keep: continue        # never delete the live production
    url = f"https://api.vercel.com/v13/deployments/{x['uid']}?projectId={PID}"
    req = urllib.request.Request(url, method="DELETE",
        headers={"Authorization": f"Bearer {TOKEN}"})
    print(x["uid"], x.get("state"), x.get("target"),
          urllib.request.urlopen(req).status)
PY
```

The dashboard equivalent: **Deployments tab → ⋯ menu → Delete** on each old
row. Also check **Storage** usage drops after the deletions (may take a few
minutes to reflect).

### 11.3 Deploying the current code (OMR fixes + Amethyst UI)

`main` HEAD (0e32262 and later) contains the circular-bubble Forms
generator, the robust OMR engine (41/41 harness cases), the Amethyst Royale
redesign and the Groq-ready AI gateway. Deploy by pushing `main`
(Git integration auto-deploys), then confirm:

1. `/api/health` → `ok:true`, `ai.mode:"env"`, `pdf` ready.
2. Print an OMR sheet from أوراق OMR — bubbles must be **circles**.
3. Scan one filled sheet from مسح وتصحيح — grade + accuracy appear.
