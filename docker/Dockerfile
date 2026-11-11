# ============================================================
# ALNOKHBA QB — production Docker image (Next.js 16 standalone)
# Includes Chromium (vector PDF engine) + Arabic fonts.
# The OMR engine runs as a separate service (see docker-compose.yml).
# ============================================================

FROM node:20-slim AS base
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-liberation ca-certificates openssl curl \
    && rm -rf /var/lib/apt/lists/*
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    CHROME_PATH=/usr/bin/chromium \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# ---- deps + build ----
FROM base AS builder
RUN npm install -g bun
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run db:generate \
 && bunx next build \
 && cp -r .next/static .next/standalone/.next/ \
 && cp -r public .next/standalone/

# ---- runtime ----
FROM base AS runner
WORKDIR /app
RUN groupadd -r qb && useradd -r -g qb qb \
 && mkdir -p /app/db /app/db/uploads /app/db/scans /app/db/assignments \
 && chown -R qb:qb /app
USER qb
COPY --from=builder --chown=qb:qb /app/.next/standalone ./
COPY --from=builder --chown=qb:qb /app/public ./public
COPY --from=builder --chown=qb:qb /app/prisma ./prisma
COPY --from=builder --chown=qb:qb /app/scripts ./scripts
COPY --from=builder --chown=qb:qb /app/node_modules/.prisma ./node_modules/.prisma

ENV DATABASE_URL="file:/app/db/custom.db"
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=8s --start-period=25s \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]
