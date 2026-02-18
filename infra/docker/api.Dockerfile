# Dominus Node API Server
# Multi-stage build for minimal production image

# ─── Stage 1: Build ─────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Copy workspace config
COPY package.json package-lock.json tsconfig.json ./

# Copy only packages needed for the API
COPY packages/shared/ packages/shared/
COPY packages/metering/ packages/metering/
COPY packages/billing/ packages/billing/
COPY packages/dashboard/ packages/dashboard/
COPY packages/pool-manager/ packages/pool-manager/
COPY packages/proxy-gateway/ packages/proxy-gateway/

# Install dependencies
RUN npm ci --ignore-scripts

# Build all packages
RUN npm run build

# Copy schema.sql to dist (postbuild may not run in Docker)
RUN cp packages/shared/src/schema.sql packages/shared/dist/src/schema.sql

# ─── Stage 2: Runtime ───────────────────────────────────────────────
FROM node:22-alpine

RUN addgroup -g 1001 -S dominusnode && \
    adduser -S dominusnode -u 1001 -G dominusnode

WORKDIR /app

# Copy built artifacts
COPY --from=builder --chown=dominusnode:dominusnode /app/package.json /app/package-lock.json ./
COPY --from=builder --chown=dominusnode:dominusnode /app/packages/shared/package.json packages/shared/package.json
COPY --from=builder --chown=dominusnode:dominusnode /app/packages/shared/dist packages/shared/dist
COPY --from=builder --chown=dominusnode:dominusnode /app/packages/metering/package.json packages/metering/package.json
COPY --from=builder --chown=dominusnode:dominusnode /app/packages/metering/dist packages/metering/dist
COPY --from=builder --chown=dominusnode:dominusnode /app/packages/billing/package.json packages/billing/package.json
COPY --from=builder --chown=dominusnode:dominusnode /app/packages/billing/dist packages/billing/dist
COPY --from=builder --chown=dominusnode:dominusnode /app/packages/pool-manager/package.json packages/pool-manager/package.json
COPY --from=builder --chown=dominusnode:dominusnode /app/packages/pool-manager/dist packages/pool-manager/dist
COPY --from=builder --chown=dominusnode:dominusnode /app/packages/dashboard/package.json packages/dashboard/package.json
COPY --from=builder --chown=dominusnode:dominusnode /app/packages/dashboard/dist packages/dashboard/dist

# R24 C-3: Strip source maps from production image
RUN find /app -name "*.js.map" -delete && find /app -name "*.d.ts.map" -delete

# R30 C-2: --ignore-scripts prevents supply chain attacks; explicit rebuild for bcrypt native module
RUN npm ci --omit=dev --ignore-scripts && npm rebuild bcrypt

USER dominusnode

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

CMD ["node", "packages/dashboard/dist/src/main.js"]
