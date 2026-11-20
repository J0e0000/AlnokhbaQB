# Deploying the OMR engine (Fly.io — or Render/Railway equivalents)

The engine is a small Python/OpenCV service in this directory
(`server.py` + `engine/`). Vercel runs the Next.js app; the engine must run
somewhere with a long-lived process and be reachable over HTTPS.

## 1. Deploy with the Dockerfile

```bash
cd mini-services/omr-engine
fly launch --no-deploy          # creates the app + fly.toml (choose a region)
```

`fly.toml` must look like this (the internal port MUST equal
`OMR_ENGINE_PORT`; the Dockerfile starts the engine on `0.0.0.0:3032` —
never loopback):

```toml
app = "alnokhba-omr-engine"
primary_region = "fra"

[http_service]
  internal_port = 3032          # == OMR_ENGINE_PORT in the Dockerfile ENV
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true

  [http_service.concurrency]
    type = "requests"

  # keep one machine always warm so scans never pay a cold start
  min_machines_running = 1

[[vm]]
  size = "shared-cpu-1x"
  memory = "1gb"
```

```bash
fly secrets set OMR_ENGINE_TOKEN="$(openssl rand -hex 32)"
fly deploy
```

The engine **refuses to start on 0.0.0.0 with an empty `OMR_ENGINE_TOKEN`**
(server.py startup guard) — always set the secret before deploying.

## 2. Wire it into Vercel

Project → Settings → Environment Variables (Production + Preview):

| Variable           | Value                              |
| ------------------ | ---------------------------------- |
| `OMR_ENGINE_URL`   | `https://<app>.fly.dev`            |
| `OMR_ENGINE_TOKEN` | the same value as the Fly secret   |

## 3. Verify

```bash
# health is public by design
curl https://<app>.fly.dev/health
# → {"ok": true, "engine": "python-opencv", ...}

# /process without a token → 401
curl -X POST https://<app>.fly.dev/process -d '{}' -H 'Content-Type: application/json'
# → {"ok": false, "error": "unauthorized — missing or invalid bearer token"}

# with the token → normal engine response
curl -X POST https://<app>.fly.dev/process -H "Authorization: Bearer $OMR_ENGINE_TOKEN" ...
```

The Next.js client (`src/lib/omr/client.ts`) sends
`Authorization: Bearer $OMR_ENGINE_TOKEN` automatically when the env var is
set; when it is unset it sends no header (loopback-only dev engines work
unchanged).

Render/Railway are acceptable equivalents: deploy this directory's
Dockerfile, bind 0.0.0.0, set `OMR_ENGINE_TOKEN`, and put the HTTPS URL +
token into Vercel.
