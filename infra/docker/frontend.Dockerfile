# Dominus Node Frontend
# Multi-stage build: Node for building, Nginx for serving

# ─── Stage 1: Build ─────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Copy workspace root (needed for npm workspace resolution)
COPY package.json package-lock.json ./
COPY packages/frontend/ packages/frontend/

# Install dependencies
RUN npm ci --ignore-scripts --workspace=packages/frontend

# Build frontend
RUN npm run build --workspace=packages/frontend

# ─── Stage 2: Serve ─────────────────────────────────────────────────
FROM nginx:1.27-alpine

# Run nginx as non-root user
RUN chown -R nginx:nginx /var/cache/nginx /var/log/nginx /etc/nginx/conf.d && \
    touch /var/run/nginx.pid && chown nginx:nginx /var/run/nginx.pid

# Copy built assets
COPY --from=builder --chown=nginx:nginx /app/packages/frontend/dist /usr/share/nginx/html

# Copy nginx config
COPY --chown=nginx:nginx infra/nginx/default.conf /etc/nginx/conf.d/default.conf

USER nginx

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
