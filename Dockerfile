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

USER node

CMD ["node", "dist/index.js"]
