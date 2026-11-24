# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# Baked in at build time via --build-arg GIT_SHA=<sha> --build-arg VERSION=<semver>
ARG GIT_SHA=dev
ARG VERSION=dev
ENV SCOUT_GIT_SHA=${GIT_SHA}
ENV SCOUT_VERSION=${VERSION}

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
# Runtime data read from the repo root by dist/ (schema resources, spec version for compat checks).
COPY schema/ ./schema/
COPY openapi.json ./openapi.json

# Audit log + pre-write snapshots default to ./logs; keep them writable for the non-root user
# and mountable as a volume (-v scout-logs:/app/logs) so they survive container restarts.
RUN mkdir -p /app/logs && chown node:node /app/logs
VOLUME ["/app/logs"]

USER node

CMD ["node", "dist/index.js"]
