# Dominus Node Frontend
# Multi-stage build: Node for building, Nginx for serving

# ─── Stage 1: Build ─────────────────────────────────────────────────
FROM node:22.23.5-alpine AS builder

WORKDIR /app

# Copy workspace root (needed for npm workspace resolution)
COPY package.json package-lock.json ./
COPY packages/frontend/ packages/frontend/

# Install dependencies
RUN npm ci --ignore-scripts --workspace=packages/frontend

# Build frontend (public contact baked in at build time; placeholder by default)
ARG VITE_CONTACT_EMAIL=contact@example.org
ENV VITE_CONTACT_EMAIL=${VITE_CONTACT_EMAIL}
RUN npm run build --workspace=packages/frontend

# ─── Stage 2: Serve ─────────────────────────────────────────────────
FROM nginx:1.27-alpine

# Run nginx as non-root user
RUN chown -R nginx:nginx /var/cache/nginx /var/log/nginx /etc/nginx/conf.d && \
    touch /var/run/nginx.pid && chown nginx:nginx /var/run/nginx.pid

# Copy built assets
COPY --from=builder --chown=nginx:nginx /app/packages/frontend/dist /usr/share/nginx/html

# Copy nginx config. It goes in as a template: the image's entrypoint renders
# it into conf.d with envsubst, replacing only ${VAR}s set in the environment
# (selfhost.conf uses ${DN_PUBLIC_SITE}; default.conf has none and is unchanged).
ARG NGINX_CONF=infra/nginx/default.conf
RUN mkdir -p /etc/nginx/templates && rm -f /etc/nginx/conf.d/default.conf
COPY --chown=nginx:nginx ${NGINX_CONF} /etc/nginx/templates/default.conf.template

USER nginx

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:8080/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
