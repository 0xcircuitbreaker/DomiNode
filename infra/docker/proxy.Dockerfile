# DomiNode Proxy Gateway
# Multi-stage build for minimal production image

# ─── Stage 1: Build ─────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Copy workspace config
COPY package.json package-lock.json tsconfig.json ./

# Copy only packages needed for the proxy
COPY packages/shared/ packages/shared/
COPY packages/metering/ packages/metering/
COPY packages/pool-manager/ packages/pool-manager/
COPY packages/proxy-gateway/ packages/proxy-gateway/
COPY packages/billing/ packages/billing/
COPY packages/dashboard/ packages/dashboard/

# Install dependencies
RUN npm ci --ignore-scripts

# Build all packages
RUN npm run build

# Copy schema.sql to dist
RUN cp packages/shared/src/schema.sql packages/shared/dist/src/schema.sql

# ─── Stage 2: Runtime ───────────────────────────────────────────────
FROM node:22-alpine

RUN addgroup -g 1001 -S dominode && \
    adduser -S dominode -u 1001 -G dominode

WORKDIR /app

# Copy built artifacts
COPY --from=builder --chown=dominode:dominode /app/package.json /app/package-lock.json ./
COPY --from=builder --chown=dominode:dominode /app/packages/shared/package.json packages/shared/package.json
COPY --from=builder --chown=dominode:dominode /app/packages/shared/dist packages/shared/dist
COPY --from=builder --chown=dominode:dominode /app/packages/metering/package.json packages/metering/package.json
COPY --from=builder --chown=dominode:dominode /app/packages/metering/dist packages/metering/dist
COPY --from=builder --chown=dominode:dominode /app/packages/pool-manager/package.json packages/pool-manager/package.json
COPY --from=builder --chown=dominode:dominode /app/packages/pool-manager/dist packages/pool-manager/dist
COPY --from=builder --chown=dominode:dominode /app/packages/proxy-gateway/package.json packages/proxy-gateway/package.json
COPY --from=builder --chown=dominode:dominode /app/packages/proxy-gateway/dist packages/proxy-gateway/dist

# Install production dependencies
RUN npm ci --omit=dev

USER dominode

# HTTP proxy + SOCKS5 proxy
EXPOSE 8080 1080

# Higher memory for geoip-lite (~185MB)
ENV NODE_OPTIONS="--max-old-space-size=768"

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/internal/stats || exit 1

CMD ["node", "packages/proxy-gateway/dist/src/main.js"]
