# Dominus Node Setup Guide

Complete deployment guide for Dominus Node, a rotating proxy-as-a-service SaaS platform. This document covers every deployment method from local development to production Kubernetes clusters.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Environment Variables](#environment-variables)
3. [Method 1: Local Development](#method-1-local-development)
4. [Method 2: Docker Deployment](#method-2-docker-deployment)
5. [Method 3: Kubernetes Deployment](#method-3-kubernetes-deployment)
6. [Method 4: VPS Deployment (Ubuntu/Debian)](#method-4-vps-deployment-ubuntudebian)
7. [Method 5: Home Server](#method-5-home-server)
8. [Method 6: Netlify / Vercel (Frontend Only)](#method-6-netlify--vercel-frontend-only)
9. [Post-Deployment Verification](#post-deployment-verification)
10. [Security Checklist for Production](#security-checklist-for-production)
11. [Troubleshooting](#troubleshooting)

---

## Prerequisites

All deployment methods require the following:

| Requirement | Version | Notes |
|---|---|---|
| Node.js | 22+ (pinned in `.nvmrc`) | Runtime for all backend services |
| npm | 9+ | Comes with Node.js; manages workspaces |
| PostgreSQL | 16+ | Primary data store (users, wallets, usage, sessions) |
| Git | 2.x | To clone the repository |

**Required external accounts:**

- **PacketStream** account -- upstream proxy provider. Sign up at [packetstream.io](https://packetstream.io) and get your gateway username/password and reseller API key.

**Optional external accounts (for billing):**

- **Stripe** account -- for fiat (credit card) wallet top-ups. Get your secret key and webhook secret from the Stripe Dashboard.
- **NOWPayments** account -- for cryptocurrency payments (BTC, ETH, XMR, SOL, ZEC). Get your API key and IPN secret from the NOWPayments Dashboard.

---

## Environment Variables

All configuration is driven by environment variables. A complete template is provided in `.env.example` at the project root.

### Required Variables

```bash
# Database connection string
DATABASE_URL=postgresql://dominusnode:dominusnode_dev@localhost:5432/dominusnode

# JWT secret for authentication (MUST change in production)
# Generate with: openssl rand -hex 32
JWT_SECRET=change-me-to-a-64-char-random-string-in-production

# MFA encryption key for TOTP secrets (required if MFA is enabled)
# Generate with: openssl rand -hex 32
MFA_ENCRYPTION_KEY=

# PacketStream upstream proxy credentials
PACKETSTREAM_GATEWAY_HOST=gw.packetstream.io
PACKETSTREAM_GATEWAY_PORT=31112
PACKETSTREAM_USERNAME=your_username
PACKETSTREAM_PASSWORD=your_password
PACKETSTREAM_RESELLER_API_URL=https://reseller.packetstream.io
PACKETSTREAM_RESELLER_API_KEY=your_bearer_token
```

### Service Ports

```bash
PROXY_LISTEN_PORT=8080       # HTTP/HTTPS proxy
SOCKS5_LISTEN_PORT=1080      # SOCKS5 proxy
DASHBOARD_PORT=3000          # REST API server
```

### Billing Configuration (Optional)

```bash
# Stripe
STRIPE_SECRET_KEY=sk_test_xxxxxxxxxxxxxxxxxxxx
STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxxxxxxxxx
STRIPE_SUCCESS_URL=https://yourdomain.com/dashboard?topup=success
STRIPE_CANCEL_URL=https://yourdomain.com/dashboard?topup=cancel

# NOWPayments (crypto)
NOWPAYMENTS_API_KEY=your_api_key
NOWPAYMENTS_IPN_SECRET=your_ipn_secret_key
NOWPAYMENTS_API_URL=https://api.nowpayments.io/v1
```

### CORS and Proxy Host

```bash
# Comma-separated list of allowed frontend origins
CORS_ORIGINS=http://localhost:5173

# Public hostname for proxy endpoint (shown to users)
PROXY_PUBLIC_HOST=proxy.dominusnode.io

# Proxy config served to browser extension
PROXY_HOST=localhost
PROXY_HTTP_PORT=8080
PROXY_SOCKS5_PORT=1080
```

### Tuning Parameters

```bash
# Proxy tunables
PROXY_CONNECT_TIMEOUT_MS=30000
PROXY_SESSION_MAX_AGE_MS=3600000
PROXY_STALE_CLEANUP_INTERVAL_MS=60000
BALANCE_CACHE_TTL_MS=30000
PROXY_MAX_RETRIES=2
PROXY_RETRY_BASE_DELAY_MS=200
PROXY_MAX_CONNECTIONS=5000

# Circuit breaker
CIRCUIT_BREAKER_FAILURE_THRESHOLD=5
CIRCUIT_BREAKER_COOLDOWN_MS=30000

# Rate limiting
# AUTH_FAIL_MAX=5
# AUTH_FAIL_WINDOW_MS=60000
# PROXY_MAX_PER_USER=100
# MAX_SESSIONS_PER_MINUTE=30

# Webhook IP allowlisting (optional, comma-separated)
# STRIPE_WEBHOOK_IPS=
# NOWPAYMENTS_WEBHOOK_IPS=

# Logging
LOG_LEVEL=info
```

### Multi-Provider Failover (Optional)

Add fallback proxy providers for resilience. Supports up to 10 providers. Gaps in numbering are allowed.

```bash
# FALLBACK_PROXY_1_HOST=oracle-vm.example.com
# FALLBACK_PROXY_1_PORT=8080
# FALLBACK_PROXY_1_USER=proxyuser
# FALLBACK_PROXY_1_PASS=proxypass
# FALLBACK_PROXY_2_HOST=gcp-vm.example.com
# FALLBACK_PROXY_2_PORT=3128
```

---

## Method 1: Local Development

Best for development and testing. Uses Docker for PostgreSQL only; all services run natively on your machine.

### Step 1: Clone and Install

```bash
git clone https://github.com/your-org/Dominus Node.git
cd Dominus Node
npm install
```

### Step 2: Start PostgreSQL

The project includes a `docker-compose.yml` that starts PostgreSQL 16 and auto-applies the schema on first run:

```bash
docker compose up -d
```

This starts PostgreSQL on `localhost:5432` with:
- Database: `dominusnode`
- User: `dominusnode`
- Password: `dominusnode_dev`

Verify it is running:

```bash
docker compose ps
```

### Step 3: Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your actual credentials. At minimum, set:
- `JWT_SECRET` -- generate with `openssl rand -hex 32`
- `PACKETSTREAM_USERNAME` and `PACKETSTREAM_PASSWORD` -- from your PacketStream account

For local development, the default `DATABASE_URL` works with the Docker Compose PostgreSQL.

### Step 4: Build All Packages

```bash
npm run build
```

This runs `tsc --build` across all 6 backend packages via TypeScript project references:
- `@dominusnode/shared` -- types, database, auth, repositories
- `@dominusnode/pool-manager` -- PacketStream integration, provider failover
- `@dominusnode/metering` -- bandwidth cost calculation
- `@dominusnode/billing` -- Stripe and NOWPayments integration
- `@dominusnode/proxy-gateway` -- HTTP/HTTPS/SOCKS5 proxy server
- `@dominusnode/dashboard` -- Express REST API

**Note:** The `@dominusnode/shared` package has a `postbuild` script that automatically copies `schema.sql` to `dist/`. If for some reason you need to do this manually:

```bash
cp packages/shared/src/schema.sql packages/shared/dist/src/schema.sql
```

### Step 5: Apply Database Schema

If the Docker Compose schema init did not run (e.g., database volume already existed), apply it manually:

```bash
npm run db:migrate
```

### Step 6: Start Services

You need three terminals (or use `&` to background processes):

**Terminal 1 -- REST API server (port 3000):**

```bash
npm run start:api
```

**Terminal 2 -- Proxy gateway (HTTP port 8080, SOCKS5 port 1080):**

```bash
npm run start:proxy
```

**Terminal 3 -- Frontend dev server (port 5173):**

```bash
npm run start:frontend
```

The frontend Vite dev server automatically proxies `/api` requests to `localhost:3000`.

### Step 7: Verify

```bash
# Check API health
curl http://localhost:3000/api/health
# Expected: {"status":"ok","service":"dominusnode-api","db":"connected"}

# Open frontend
open http://localhost:5173
```

### Running Tests

```bash
# Run all backend unit tests (870 tests)
npm test

# Run frontend tests (61 tests)
npm run test:frontend

# Run extension tests
cd packages/extension && npx vitest run

# Run Node.js SDK tests
cd sdks/node && npx vitest run

# Run Python SDK tests
cd sdks/python && python3 -m pytest

# Run tests with coverage
npm run test:coverage
```

### Building the Browser Extension

```bash
cd packages/extension

# Build for a specific browser
npm run build:chrome
npm run build:firefox
npm run build:opera
npm run build:edge

# Build for all browsers
npm run build:all
```

Extension output goes to `packages/extension/dist/<browser>/`.

---

## Method 2: Docker Deployment

Full containerized deployment with Docker Compose. Suitable for staging and small-scale production.

### Dockerfiles

The project includes production-ready Dockerfiles in `infra/docker/` and a `docker-compose.prod.yml` at the project root:

- `infra/docker/api.Dockerfile` -- Dashboard API container
- `infra/docker/proxy.Dockerfile` -- Proxy gateway container
- `infra/docker/frontend.Dockerfile` -- Multi-stage: Vite build + nginx serve
- `infra/docker/.dockerignore` -- Excludes node_modules, .git, coverage
- `docker-compose.prod.yml` -- Production compose with all 4 services (postgres, api, proxy, frontend)
- `infra/nginx/default.conf` -- Nginx config with API proxy, gzip, security headers, SPA fallback

You can use these directly, or create a unified multi-target Dockerfile as shown below:

```dockerfile
# ── Stage 1: Build ───────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Copy workspace root files
COPY package.json package-lock.json tsconfig.json ./

# Copy all package.json files for workspace resolution
COPY packages/shared/package.json packages/shared/
COPY packages/pool-manager/package.json packages/pool-manager/
COPY packages/metering/package.json packages/metering/
COPY packages/billing/package.json packages/billing/
COPY packages/proxy-gateway/package.json packages/proxy-gateway/
COPY packages/dashboard/package.json packages/dashboard/

# Install dependencies (includes devDependencies for build)
RUN npm ci

# Copy all source code
COPY packages/ packages/

# Build all TypeScript packages
RUN npm run build

# Copy schema.sql to dist for migration script
RUN cp packages/shared/src/schema.sql packages/shared/dist/src/schema.sql

# Prune devDependencies
RUN npm prune --production

# ── Stage 2: API Runtime ────────────────────────────────────────────
FROM node:22-alpine AS api

WORKDIR /app

# Copy built artifacts and production dependencies
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/packages/shared/package.json packages/shared/
COPY --from=builder /app/packages/metering/dist packages/metering/dist
COPY --from=builder /app/packages/metering/package.json packages/metering/
COPY --from=builder /app/packages/billing/dist packages/billing/dist
COPY --from=builder /app/packages/billing/package.json packages/billing/
COPY --from=builder /app/packages/pool-manager/dist packages/pool-manager/dist
COPY --from=builder /app/packages/pool-manager/package.json packages/pool-manager/
COPY --from=builder /app/packages/dashboard/dist packages/dashboard/dist
COPY --from=builder /app/packages/dashboard/package.json packages/dashboard/

# Non-root user for security
RUN addgroup -S dominusnode && adduser -S dominusnode -G dominusnode
USER dominusnode

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "packages/dashboard/dist/src/main.js"]

# ── Stage 3: Proxy Runtime ──────────────────────────────────────────
FROM node:22-alpine AS proxy

WORKDIR /app

COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/packages/shared/package.json packages/shared/
COPY --from=builder /app/packages/metering/dist packages/metering/dist
COPY --from=builder /app/packages/metering/package.json packages/metering/
COPY --from=builder /app/packages/pool-manager/dist packages/pool-manager/dist
COPY --from=builder /app/packages/pool-manager/package.json packages/pool-manager/
COPY --from=builder /app/packages/proxy-gateway/dist packages/proxy-gateway/dist
COPY --from=builder /app/packages/proxy-gateway/package.json packages/proxy-gateway/

RUN addgroup -S dominusnode && adduser -S dominusnode -G dominusnode
USER dominusnode

EXPOSE 8080 1080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8080/ || exit 1

CMD ["node", "packages/proxy-gateway/dist/src/main.js"]

# ── Stage 4: Migrate (one-shot) ────────────────────────────────────
FROM node:22-alpine AS migrate

WORKDIR /app

COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/packages/shared/package.json packages/shared/

CMD ["node", "packages/shared/dist/src/migrate.js"]
```

**Note:** This is a multi-target Dockerfile. Build specific targets with `--target`:

```bash
docker build --target api -t dominusnode-api .
docker build --target proxy -t dominusnode-proxy .
docker build --target migrate -t dominusnode-migrate .
```

### docker-compose.production.yml

Create `docker-compose.production.yml` in the project root:

```yaml
version: "3.8"

services:
  # ── PostgreSQL ──────────────────────────────────────────────────────
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: dominusnode
      POSTGRES_USER: dominusnode
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-dominusnode_prod}
    ports:
      - "127.0.0.1:5432:5432"  # Only listen on localhost
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./packages/shared/src/schema.sql:/docker-entrypoint-initdb.d/01-schema.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U dominusnode -d dominusnode"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s
    networks:
      - backend
    deploy:
      resources:
        limits:
          memory: 512M

  # ── Database Migration (run once, then exit) ────────────────────────
  migrate:
    build:
      context: .
      target: migrate
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgresql://dominusnode:${POSTGRES_PASSWORD:-dominusnode_prod}@postgres:5432/dominusnode
    networks:
      - backend
    restart: "no"

  # ── REST API Server ─────────────────────────────────────────────────
  api:
    build:
      context: .
      target: api
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
    ports:
      - "3000:3000"
    environment:
      NODE_ENV: production
      DATABASE_URL: postgresql://dominusnode:${POSTGRES_PASSWORD:-dominusnode_prod}@postgres:5432/dominusnode
      DASHBOARD_PORT: "3000"
      JWT_SECRET: ${JWT_SECRET}
      MFA_ENCRYPTION_KEY: ${MFA_ENCRYPTION_KEY:-}
      STRIPE_SECRET_KEY: ${STRIPE_SECRET_KEY:-}
      STRIPE_WEBHOOK_SECRET: ${STRIPE_WEBHOOK_SECRET:-}
      STRIPE_SUCCESS_URL: ${STRIPE_SUCCESS_URL:-https://yourdomain.com/dashboard?topup=success}
      STRIPE_CANCEL_URL: ${STRIPE_CANCEL_URL:-https://yourdomain.com/dashboard?topup=cancel}
      NOWPAYMENTS_API_KEY: ${NOWPAYMENTS_API_KEY:-}
      NOWPAYMENTS_IPN_SECRET: ${NOWPAYMENTS_IPN_SECRET:-}
      NOWPAYMENTS_API_URL: ${NOWPAYMENTS_API_URL:-https://api.nowpayments.io/v1}
      CORS_ORIGINS: ${CORS_ORIGINS:-https://yourdomain.com}
      PROXY_PUBLIC_HOST: ${PROXY_PUBLIC_HOST:-proxy.yourdomain.com}
      PROXY_HOST: proxy
      PROXY_HTTP_PORT: "8080"
      PROXY_SOCKS5_PORT: "1080"
      LOG_LEVEL: ${LOG_LEVEL:-info}
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/api/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    networks:
      - backend
    deploy:
      resources:
        limits:
          memory: 256M

  # ── Proxy Gateway ──────────────────────────────────────────────────
  proxy:
    build:
      context: .
      target: proxy
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
    ports:
      - "8080:8080"
      - "1080:1080"
    environment:
      NODE_ENV: production
      DATABASE_URL: postgresql://dominusnode:${POSTGRES_PASSWORD:-dominusnode_prod}@postgres:5432/dominusnode
      PROXY_LISTEN_PORT: "8080"
      SOCKS5_LISTEN_PORT: "1080"
      PACKETSTREAM_GATEWAY_HOST: ${PACKETSTREAM_GATEWAY_HOST:-gw.packetstream.io}
      PACKETSTREAM_GATEWAY_PORT: ${PACKETSTREAM_GATEWAY_PORT:-31112}
      PACKETSTREAM_USERNAME: ${PACKETSTREAM_USERNAME}
      PACKETSTREAM_PASSWORD: ${PACKETSTREAM_PASSWORD}
      JWT_SECRET: ${JWT_SECRET}
      PROXY_CONNECT_TIMEOUT_MS: ${PROXY_CONNECT_TIMEOUT_MS:-30000}
      PROXY_SESSION_MAX_AGE_MS: ${PROXY_SESSION_MAX_AGE_MS:-3600000}
      PROXY_MAX_CONNECTIONS: ${PROXY_MAX_CONNECTIONS:-5000}
      BALANCE_CACHE_TTL_MS: ${BALANCE_CACHE_TTL_MS:-30000}
      CIRCUIT_BREAKER_FAILURE_THRESHOLD: ${CIRCUIT_BREAKER_FAILURE_THRESHOLD:-5}
      CIRCUIT_BREAKER_COOLDOWN_MS: ${CIRCUIT_BREAKER_COOLDOWN_MS:-30000}
      LOG_LEVEL: ${LOG_LEVEL:-info}
    networks:
      - backend
    deploy:
      resources:
        limits:
          memory: 512M

volumes:
  pgdata:
    driver: local

networks:
  backend:
    driver: bridge
```

### Deploying with Docker Compose

**Option A: Use the included `docker-compose.prod.yml`:**

```bash
# Set required environment variables (or create a .env file)
export JWT_SECRET=$(openssl rand -hex 32)
export POSTGRES_PASSWORD=$(openssl rand -hex 16)
export PACKETSTREAM_USERNAME=your_username
export PACKETSTREAM_PASSWORD=your_password

# Build and start all 4 services (postgres, api, proxy, frontend)
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d

# Check status (health checks on all services)
docker compose -f docker-compose.prod.yml ps

# View logs
docker compose -f docker-compose.prod.yml logs -f api
docker compose -f docker-compose.prod.yml logs -f proxy

# Stop everything
docker compose -f docker-compose.prod.yml down

# Stop and remove volumes (WARNING: deletes all data)
docker compose -f docker-compose.prod.yml down -v
```

**Option B: Use the custom multi-target `docker-compose.production.yml` (shown above):**

```bash
docker compose -f docker-compose.production.yml build
docker compose -f docker-compose.production.yml up -d
```

---

## Method 3: Kubernetes Deployment

Production-grade deployment with Kubernetes. These manifests assume you have a working cluster (EKS, GKE, AKS, or self-hosted).

### Directory Structure

Create a `k8s/` directory in the project root with the following files:

### k8s/namespace.yaml

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: dominusnode
  labels:
    app.kubernetes.io/part-of: dominusnode
```

### k8s/secrets.yaml

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: dominusnode-secrets
  namespace: dominusnode
type: Opaque
stringData:
  # IMPORTANT: Replace all values below before applying.
  # In production, use sealed-secrets, external-secrets, or Vault instead.
  DATABASE_URL: "postgresql://dominusnode:YOUR_DB_PASSWORD@dominusnode-postgres:5432/dominusnode?sslmode=require"
  JWT_SECRET: "GENERATE_WITH_openssl_rand_-hex_32"
  MFA_ENCRYPTION_KEY: "GENERATE_WITH_openssl_rand_-hex_32"
  PACKETSTREAM_USERNAME: "your_username"
  PACKETSTREAM_PASSWORD: "your_password"
  PACKETSTREAM_RESELLER_API_KEY: "your_bearer_token"
  STRIPE_SECRET_KEY: "sk_live_xxxxxxxxxxxxxxxxxxxx"
  STRIPE_WEBHOOK_SECRET: "whsec_xxxxxxxxxxxxxxxxxxxx"
  NOWPAYMENTS_API_KEY: "your_api_key"
  NOWPAYMENTS_IPN_SECRET: "your_ipn_secret"
  POSTGRES_PASSWORD: "YOUR_DB_PASSWORD"
```

### k8s/configmap.yaml

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: dominusnode-config
  namespace: dominusnode
data:
  NODE_ENV: "production"
  DASHBOARD_PORT: "3000"
  PROXY_LISTEN_PORT: "8080"
  SOCKS5_LISTEN_PORT: "1080"
  PACKETSTREAM_GATEWAY_HOST: "gw.packetstream.io"
  PACKETSTREAM_GATEWAY_PORT: "31112"
  PACKETSTREAM_RESELLER_API_URL: "https://reseller.packetstream.io"
  NOWPAYMENTS_API_URL: "https://api.nowpayments.io/v1"
  CORS_ORIGINS: "https://app.dominusnode.io"
  PROXY_PUBLIC_HOST: "proxy.dominusnode.io"
  PROXY_HOST: "dominusnode-proxy"
  PROXY_HTTP_PORT: "8080"
  PROXY_SOCKS5_PORT: "1080"
  STRIPE_SUCCESS_URL: "https://app.dominusnode.io/dashboard?topup=success"
  STRIPE_CANCEL_URL: "https://app.dominusnode.io/dashboard?topup=cancel"
  PROXY_CONNECT_TIMEOUT_MS: "30000"
  PROXY_SESSION_MAX_AGE_MS: "3600000"
  PROXY_MAX_CONNECTIONS: "5000"
  BALANCE_CACHE_TTL_MS: "30000"
  CIRCUIT_BREAKER_FAILURE_THRESHOLD: "5"
  CIRCUIT_BREAKER_COOLDOWN_MS: "30000"
  LOG_LEVEL: "info"
```

### k8s/postgres.yaml

For production, consider using a managed database (AWS RDS, GCP Cloud SQL, Azure Database for PostgreSQL) instead of running PostgreSQL inside Kubernetes. If you use a managed database, skip this file and update `DATABASE_URL` in secrets.yaml accordingly.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: dominusnode-postgres
  namespace: dominusnode
spec:
  type: ClusterIP
  ports:
    - port: 5432
      targetPort: 5432
  selector:
    app: dominusnode-postgres
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: dominusnode-postgres
  namespace: dominusnode
spec:
  serviceName: dominusnode-postgres
  replicas: 1
  selector:
    matchLabels:
      app: dominusnode-postgres
  template:
    metadata:
      labels:
        app: dominusnode-postgres
    spec:
      containers:
        - name: postgres
          image: postgres:16-alpine
          ports:
            - containerPort: 5432
          env:
            - name: POSTGRES_DB
              value: dominusnode
            - name: POSTGRES_USER
              value: dominusnode
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: dominusnode-secrets
                  key: POSTGRES_PASSWORD
            - name: PGDATA
              value: /var/lib/postgresql/data/pgdata
          resources:
            requests:
              memory: "256Mi"
              cpu: "250m"
            limits:
              memory: "512Mi"
              cpu: "500m"
          livenessProbe:
            exec:
              command: ["pg_isready", "-U", "dominusnode", "-d", "dominusnode"]
            initialDelaySeconds: 30
            periodSeconds: 10
          readinessProbe:
            exec:
              command: ["pg_isready", "-U", "dominusnode", "-d", "dominusnode"]
            initialDelaySeconds: 5
            periodSeconds: 5
          volumeMounts:
            - name: postgres-data
              mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:
    - metadata:
        name: postgres-data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 20Gi
```

### k8s/api.yaml

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: dominusnode-api
  namespace: dominusnode
  labels:
    app: dominusnode-api
spec:
  replicas: 2
  selector:
    matchLabels:
      app: dominusnode-api
  template:
    metadata:
      labels:
        app: dominusnode-api
    spec:
      containers:
        - name: api
          image: your-registry/dominusnode-api:latest
          ports:
            - containerPort: 3000
          envFrom:
            - configMapRef:
                name: dominusnode-config
            - secretRef:
                name: dominusnode-secrets
          resources:
            requests:
              memory: "128Mi"
              cpu: "100m"
            limits:
              memory: "256Mi"
              cpu: "500m"
          livenessProbe:
            httpGet:
              path: /api/health
              port: 3000
            initialDelaySeconds: 15
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /api/health
              port: 3000
            initialDelaySeconds: 5
            periodSeconds: 10
      restartPolicy: Always
---
apiVersion: v1
kind: Service
metadata:
  name: dominusnode-api
  namespace: dominusnode
spec:
  type: ClusterIP
  ports:
    - port: 3000
      targetPort: 3000
  selector:
    app: dominusnode-api
```

### k8s/proxy.yaml

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: dominusnode-proxy
  namespace: dominusnode
  labels:
    app: dominusnode-proxy
spec:
  replicas: 2
  selector:
    matchLabels:
      app: dominusnode-proxy
  template:
    metadata:
      labels:
        app: dominusnode-proxy
    spec:
      containers:
        - name: proxy
          image: your-registry/dominusnode-proxy:latest
          ports:
            - containerPort: 8080
              name: http-proxy
            - containerPort: 1080
              name: socks5-proxy
          envFrom:
            - configMapRef:
                name: dominusnode-config
            - secretRef:
                name: dominusnode-secrets
          resources:
            requests:
              memory: "256Mi"
              cpu: "250m"
            limits:
              memory: "512Mi"
              cpu: "1000m"
          livenessProbe:
            tcpSocket:
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 30
          readinessProbe:
            tcpSocket:
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
      restartPolicy: Always
---
apiVersion: v1
kind: Service
metadata:
  name: dominusnode-proxy
  namespace: dominusnode
  annotations:
    # For AWS NLB (if on EKS). Adjust annotations for your cloud provider.
    service.beta.kubernetes.io/aws-load-balancer-type: "nlb"
spec:
  type: LoadBalancer
  ports:
    - port: 8080
      targetPort: 8080
      name: http-proxy
      protocol: TCP
    - port: 1080
      targetPort: 1080
      name: socks5-proxy
      protocol: TCP
  selector:
    app: dominusnode-proxy
```

### k8s/ingress.yaml

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: dominusnode-ingress
  namespace: dominusnode
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/proxy-body-size: "16k"
    nginx.ingress.kubernetes.io/configuration-snippet: |
      more_set_headers "Strict-Transport-Security: max-age=31536000; includeSubDomains; preload";
      more_set_headers "X-Frame-Options: DENY";
      more_set_headers "X-Content-Type-Options: nosniff";
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - api.dominusnode.io
        - app.dominusnode.io
      secretName: dominusnode-tls
  rules:
    - host: api.dominusnode.io
      http:
        paths:
          - path: /api
            pathType: Prefix
            backend:
              service:
                name: dominusnode-api
                port:
                  number: 3000
    - host: app.dominusnode.io
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: dominusnode-frontend
                port:
                  number: 80
```

### k8s/hpa.yaml

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: dominusnode-proxy-hpa
  namespace: dominusnode
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: dominusnode-proxy
  minReplicas: 2
  maxReplicas: 20
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: dominusnode-api-hpa
  namespace: dominusnode
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: dominusnode-api
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
```

### Applying Kubernetes Manifests

```bash
# Create namespace
kubectl apply -f k8s/namespace.yaml

# Apply secrets (edit with your real values first!)
kubectl apply -f k8s/secrets.yaml

# Apply config
kubectl apply -f k8s/configmap.yaml

# Deploy PostgreSQL (or skip if using managed database)
kubectl apply -f k8s/postgres.yaml

# Wait for PostgreSQL to be ready
kubectl -n dominusnode rollout status statefulset/dominusnode-postgres

# Run database migration (one-time job)
kubectl -n dominusnode run dominusnode-migrate \
  --image=your-registry/dominusnode-migrate:latest \
  --restart=Never \
  --env="DATABASE_URL=postgresql://dominusnode:YOUR_DB_PASSWORD@dominusnode-postgres:5432/dominusnode" \
  --rm -it

# Deploy API and Proxy
kubectl apply -f k8s/api.yaml
kubectl apply -f k8s/proxy.yaml

# Set up Ingress (requires nginx-ingress-controller and cert-manager)
kubectl apply -f k8s/ingress.yaml

# Set up autoscaling
kubectl apply -f k8s/hpa.yaml

# Verify
kubectl -n dominusnode get pods
kubectl -n dominusnode get services
kubectl -n dominusnode get ingress
```

---

## Method 4: VPS Deployment (Ubuntu/Debian)

Step-by-step guide for deploying on a single VPS from providers like DigitalOcean, Linode, Hetzner, Vultr, or OVH. Tested on Ubuntu 22.04/24.04 LTS.

### Step 1: Initial Server Setup

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install essential tools
sudo apt install -y curl wget git build-essential ufw
```

### Step 2: Install Node.js 22

```bash
# Install Node.js 22 via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node --version   # Should show v22.x.x
npm --version    # Should show 10.x.x
```

### Step 3: Install PostgreSQL 16

```bash
# Add PostgreSQL APT repository
sudo sh -c 'echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list'
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo gpg --dearmor -o /etc/apt/trusted.gpg.d/postgresql.gpg
sudo apt update

# Install PostgreSQL 16
sudo apt install -y postgresql-16

# Start and enable
sudo systemctl enable postgresql
sudo systemctl start postgresql
```

### Step 4: Create Database and User

```bash
# Switch to postgres user
sudo -u postgres psql <<'SQL'
CREATE USER dominusnode WITH PASSWORD 'YOUR_STRONG_DB_PASSWORD';
CREATE DATABASE dominusnode OWNER dominusnode;
GRANT ALL PRIVILEGES ON DATABASE dominusnode TO dominusnode;
\q
SQL
```

Replace `YOUR_STRONG_DB_PASSWORD` with a strong password generated via `openssl rand -hex 16`.

### Step 5: Create Dominus Node System User

```bash
sudo useradd -r -m -s /bin/bash dominusnode
```

### Step 6: Clone and Build

```bash
# Clone as the dominusnode user
sudo -u dominusnode bash -c '
  cd /opt
  git clone https://github.com/your-org/Dominus Node.git dominusnode
  cd dominusnode
  npm install
  npm run build
  cp packages/shared/src/schema.sql packages/shared/dist/src/schema.sql
'
```

### Step 7: Configure Environment

```bash
sudo -u dominusnode bash -c '
  cd /opt/dominusnode
  cp .env.example .env
'

# Edit with your production values
sudo -u dominusnode nano /opt/dominusnode/.env
```

Set at minimum:

```bash
DATABASE_URL=postgresql://dominusnode:YOUR_STRONG_DB_PASSWORD@localhost:5432/dominusnode
JWT_SECRET=<output of openssl rand -hex 32>
MFA_ENCRYPTION_KEY=<output of openssl rand -hex 32>
PACKETSTREAM_USERNAME=your_username
PACKETSTREAM_PASSWORD=your_password
NODE_ENV=production
CORS_ORIGINS=https://app.yourdomain.com
PROXY_PUBLIC_HOST=proxy.yourdomain.com
```

### Step 8: Apply Database Schema

```bash
sudo -u dominusnode bash -c 'cd /opt/dominusnode && npm run db:migrate'
```

### Step 9: Set Up systemd Services

**Dominus Node API Service:**

```bash
sudo tee /etc/systemd/system/dominusnode-api.service > /dev/null <<'EOF'
[Unit]
Description=Dominus Node API Server
Documentation=https://github.com/your-org/Dominus Node
After=network.target postgresql.service
Requires=postgresql.service

[Service]
Type=simple
User=dominusnode
Group=dominusnode
WorkingDirectory=/opt/dominusnode
ExecStart=/usr/bin/node packages/dashboard/dist/src/main.js
Restart=always
RestartSec=5
EnvironmentFile=/opt/dominusnode/.env
Environment=NODE_ENV=production

# Security hardening
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/opt/dominusnode
PrivateTmp=yes

# Resource limits
LimitNOFILE=65535
MemoryMax=256M

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=dominusnode-api

[Install]
WantedBy=multi-user.target
EOF
```

**Dominus Node Proxy Service:**

```bash
sudo tee /etc/systemd/system/dominusnode-proxy.service > /dev/null <<'EOF'
[Unit]
Description=Dominus Node Proxy Gateway
Documentation=https://github.com/your-org/Dominus Node
After=network.target postgresql.service
Requires=postgresql.service

[Service]
Type=simple
User=dominusnode
Group=dominusnode
WorkingDirectory=/opt/dominusnode
ExecStart=/usr/bin/node packages/proxy-gateway/dist/src/main.js
Restart=always
RestartSec=5
EnvironmentFile=/opt/dominusnode/.env
Environment=NODE_ENV=production

# Security hardening
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/opt/dominusnode
PrivateTmp=yes

# Resource limits (proxy needs more)
LimitNOFILE=65535
MemoryMax=512M

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=dominusnode-proxy

[Install]
WantedBy=multi-user.target
EOF
```

**Enable and start both services:**

```bash
sudo systemctl daemon-reload
sudo systemctl enable dominusnode-api dominusnode-proxy
sudo systemctl start dominusnode-api dominusnode-proxy

# Check status
sudo systemctl status dominusnode-api
sudo systemctl status dominusnode-proxy

# View logs
sudo journalctl -u dominusnode-api -f
sudo journalctl -u dominusnode-proxy -f
```

### Step 10: Build Frontend

```bash
sudo -u dominusnode bash -c '
  cd /opt/dominusnode/packages/frontend
  npm run build
'
```

The built frontend will be at `/opt/dominusnode/packages/frontend/dist/`.

### Step 11: Install and Configure Nginx

```bash
sudo apt install -y nginx
```

**Main Nginx configuration:**

```bash
sudo tee /etc/nginx/sites-available/dominusnode > /dev/null <<'NGINX'
# Redirect HTTP to HTTPS
server {
    listen 80;
    server_name api.yourdomain.com app.yourdomain.com;
    return 301 https://$host$request_uri;
}

# API + Frontend
server {
    listen 443 ssl http2;
    server_name app.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/app.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/app.yourdomain.com/privkey.pem;

    # SSL hardening
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # API proxy
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";

        # Timeouts
        proxy_connect_timeout 10s;
        proxy_send_timeout 30s;
        proxy_read_timeout 30s;

        # Body size limit (matches Express 16kb limit)
        client_max_body_size 16k;
    }

    # Frontend (static files)
    location / {
        root /opt/dominusnode/packages/frontend/dist;
        try_files $uri $uri/ /index.html;

        # Cache static assets
        location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf)$ {
            expires 1y;
            add_header Cache-Control "public, immutable";
        }
    }
}

# API-only subdomain (optional, if using separate subdomain)
server {
    listen 443 ssl http2;
    server_name api.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/api.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.yourdomain.com/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;

    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        client_max_body_size 16k;
    }
}
NGINX

# Enable the site
sudo ln -sf /etc/nginx/sites-available/dominusnode /etc/nginx/sites-enabled/dominusnode
sudo rm -f /etc/nginx/sites-enabled/default

# Test configuration
sudo nginx -t

# Reload
sudo systemctl reload nginx
```

### Step 12: SSL Certificates with Let's Encrypt

```bash
# Install certbot
sudo apt install -y certbot python3-certbot-nginx

# Obtain certificates (Nginx plugin handles configuration automatically)
sudo certbot --nginx -d app.yourdomain.com -d api.yourdomain.com

# Verify auto-renewal
sudo certbot renew --dry-run
```

Certbot automatically sets up a cron job (or systemd timer) for renewal.

### Step 13: Configure Firewall

```bash
# Enable UFW
sudo ufw default deny incoming
sudo ufw default allow outgoing

# Allow SSH
sudo ufw allow 22/tcp

# Allow HTTP/HTTPS (for Nginx)
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Allow proxy ports (only if clients connect directly, not through Nginx)
sudo ufw allow 8080/tcp
sudo ufw allow 1080/tcp

# Enable firewall
sudo ufw enable

# Verify
sudo ufw status verbose
```

### Step 14: Set Up Log Rotation

```bash
sudo tee /etc/logrotate.d/dominusnode > /dev/null <<'EOF'
/var/log/dominusnode/*.log {
    daily
    missingok
    rotate 14
    compress
    delaycompress
    notifempty
    create 0640 dominusnode dominusnode
    sharedscripts
}
EOF
```

For systemd journal logs, journald handles rotation automatically. Check current settings:

```bash
sudo journalctl --disk-usage
```

### Updating Dominus Node

```bash
# Pull latest code
sudo -u dominusnode bash -c '
  cd /opt/dominusnode
  git pull
  npm install
  npm run build
  cp packages/shared/src/schema.sql packages/shared/dist/src/schema.sql
  npm run db:migrate
'

# Build frontend
sudo -u dominusnode bash -c '
  cd /opt/dominusnode/packages/frontend
  npm run build
'

# Restart services
sudo systemctl restart dominusnode-api dominusnode-proxy
```

---

## Method 5: Home Server

Deploy Dominus Node on a home server (Raspberry Pi, mini PC, repurposed desktop, NAS). This follows the same approach as VPS deployment with additional considerations for home networking.

### Additional Requirements

- A router you can configure (for port forwarding)
- A static IP from your ISP, or a Dynamic DNS service
- Recommended: a UPS (Uninterruptible Power Supply) to handle power outages

### Step 1: Set Up Dynamic DNS

If your ISP does not provide a static IP, use a Dynamic DNS service so your domain always points to your home IP.

**Option A: DuckDNS (free)**

```bash
# Sign up at https://www.duckdns.org and get your token

# Create update script
sudo tee /opt/duckdns/duck.sh > /dev/null <<'EOF'
#!/bin/bash
echo url="https://www.duckdns.org/update?domains=yourdomain&token=YOUR_TOKEN&ip=" | curl -k -o /opt/duckdns/duck.log -K -
EOF

chmod 700 /opt/duckdns/duck.sh

# Add cron job (update every 5 minutes)
(crontab -l 2>/dev/null; echo "*/5 * * * * /opt/duckdns/duck.sh >/dev/null 2>&1") | crontab -
```

**Option B: Cloudflare DDNS (if using Cloudflare for DNS)**

```bash
# Install ddclient
sudo apt install -y ddclient

# Configure for Cloudflare
sudo tee /etc/ddclient.conf > /dev/null <<'EOF'
protocol=cloudflare
use=web
web=https://api.ipify.org
zone=yourdomain.com
login=your-cloudflare-email
password=your-cloudflare-api-token
app.yourdomain.com
proxy.yourdomain.com
EOF

sudo systemctl enable ddclient
sudo systemctl start ddclient
```

### Step 2: Configure Router Port Forwarding

Forward the following ports from your router to your home server's local IP:

| External Port | Internal Port | Protocol | Service |
|---|---|---|---|
| 80 | 80 | TCP | HTTP (for Let's Encrypt & redirect) |
| 443 | 443 | TCP | HTTPS (API + Frontend) |
| 8080 | 8080 | TCP | HTTP Proxy |
| 1080 | 1080 | TCP | SOCKS5 Proxy |

Access your router's admin panel (usually at `192.168.1.1` or `192.168.0.1`) and add these forwarding rules.

### Step 3: SSL with DNS Challenge

For home servers behind NAT, the standard HTTP-01 Let's Encrypt challenge may not work reliably. Use the DNS-01 challenge instead:

```bash
# Using Cloudflare DNS plugin
sudo apt install -y certbot python3-certbot-dns-cloudflare

# Create credentials file
sudo mkdir -p /etc/letsencrypt
sudo tee /etc/letsencrypt/cloudflare.ini > /dev/null <<'EOF'
dns_cloudflare_api_token = your-cloudflare-api-token
EOF
sudo chmod 600 /etc/letsencrypt/cloudflare.ini

# Obtain wildcard certificate
sudo certbot certonly \
  --dns-cloudflare \
  --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
  -d "*.yourdomain.com" \
  -d "yourdomain.com"
```

### Step 4: Follow VPS Steps

After setting up DNS and port forwarding, follow [Method 4: VPS Deployment](#method-4-vps-deployment-ubuntudebian) starting from Step 2 (Install Node.js) through Step 14.

### Step 5: Bandwidth Considerations

Home internet has limited upload bandwidth. Calculate your capacity:

- **100 Mbps upload** = ~12.5 MB/s = ~1 TB/month theoretical max
- **50 Mbps upload** = ~6.25 MB/s = ~500 GB/month theoretical max
- **20 Mbps upload** = ~2.5 MB/s = ~200 GB/month theoretical max

Reserve at least 30% for your own usage. Set `PROXY_MAX_CONNECTIONS` accordingly:

```bash
# For 50 Mbps upload, limit to ~200 concurrent connections
PROXY_MAX_CONNECTIONS=200
```

### Step 6: Power Management

```bash
# Install UPS monitoring (for APC UPS)
sudo apt install -y apcupsd

# Configure for graceful shutdown on power loss
sudo nano /etc/apcupsd/apcupsd.conf
# Set UPSTYPE and DEVICE for your UPS model

sudo systemctl enable apcupsd
sudo systemctl start apcupsd
```

### Alternative: Docker on Home Server

You can also use the [Docker deployment method](#method-2-docker-deployment) on your home server. This simplifies installation:

```bash
# Install Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER

# Then follow Method 2
```

---

## Method 6: Netlify / Vercel (Frontend Only)

The Dominus Node frontend is a static React SPA built with Vite. It can be deployed to static hosting platforms like Netlify or Vercel. However, the backend API and proxy gateway are long-running Node.js servers and **cannot** run on serverless platforms. You must host the backend on a VPS, Docker host, or Kubernetes cluster.

### Frontend Build

```bash
npm run build --workspace=packages/frontend
# Output: packages/frontend/dist
```

### Netlify Deployment

**Option A: Netlify CLI**

```bash
# Install Netlify CLI
npm install -g netlify-cli

# Deploy
netlify deploy --prod --dir=packages/frontend/dist
```

**Option B: Git-based deployment**

1. Connect your repository to Netlify.
2. Netlify will use `netlify.toml` in the repo root (build command, publish directory, SPA routing).

**API Proxying (Recommended):**

The frontend uses cookie-based auth (httpOnly cookies) and expects the API at the same origin under `/api/*`.
To make this work on Netlify, proxy `/api/*` to your VPS-hosted API using a Netlify rewrite.

In `netlify.toml`, add this rule **above** the `/* -> /index.html` SPA redirect:

```toml
[[redirects]]
  from = "/api/*"
  to = "https://api.yourdomain.com/api/:splat"
  status = 200
  force = true
```

### Vercel Deployment

**Option A: Vercel CLI**

```bash
# Install Vercel CLI
npm install -g vercel

# Deploy
cd packages/frontend
vercel --prod
```

**Option B: Git-based deployment**

1. Connect your repository to Vercel.
2. Set root directory to `packages/frontend`.

**SPA Routing:** Create `packages/frontend/vercel.json`:

```json
{
  "rewrites": [
    { "source": "/(.*)", "destination": "/index.html" }
  ]
}
```

### Backend CORS Configuration

Update the backend `.env` to allow requests from your Netlify/Vercel URL:

```bash
# Add your deployment URL to CORS_ORIGINS (comma-separated)
CORS_ORIGINS=https://your-app.netlify.app,https://your-app.vercel.app,https://app.yourdomain.com
```

Then restart the API service.

### Vite API Proxy Configuration

In `packages/frontend/vite.config.ts`, the dev server proxies `/api` to `localhost:3000`.

For production static hosting (Netlify/Vercel), keep `/api/*` working by adding a platform rewrite rule that proxies `/api/*` to your VPS-hosted API (recommended).
This preserves first-party cookies and avoids third-party cookie restrictions.

---

## Post-Deployment Verification

Run through these checks after any deployment to confirm everything is working.

### 1. Check API Health

```bash
curl https://api.yourdomain.com/api/health
# Expected: {"status":"ok","service":"dominusnode-api","db":"connected"}
```

### 2. Register a Test User

```bash
curl -s -X POST https://api.yourdomain.com/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"SecurePass123!"}' | jq .
```

### 3. Log In

```bash
curl -s -X POST https://api.yourdomain.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"SecurePass123!"}' \
  -c cookies.txt | jq .
```

The access token is set as an httpOnly cookie. Use `-c cookies.txt` to save it, and `-b cookies.txt` in subsequent requests.

### 4. Create an API Key

```bash
curl -s -X POST https://api.yourdomain.com/api/keys \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{"label":"test-key"}' | jq .
```

Save the returned API key -- it is shown only once. It starts with `dn_live_`.

### 5. Check Wallet Balance

```bash
curl -s https://api.yourdomain.com/api/wallet \
  -b cookies.txt | jq .
```

### 6. Test HTTP Proxy

```bash
curl -x http://anything:dn_live_YOUR_API_KEY@proxy.yourdomain.com:8080 \
  http://httpbin.org/ip
```

### 7. Test HTTPS Proxy

```bash
curl -x http://anything:dn_live_YOUR_API_KEY@proxy.yourdomain.com:8080 \
  https://httpbin.org/ip
```

### 8. Test SOCKS5 Proxy

```bash
curl -x socks5://anything:dn_live_YOUR_API_KEY@proxy.yourdomain.com:1080 \
  http://httpbin.org/ip
```

### 9. Check Usage

```bash
curl -s https://api.yourdomain.com/api/usage \
  -b cookies.txt | jq .
```

### 10. Verify Frontend

Open `https://app.yourdomain.com` in your browser. You should see the Dominus Node login page.

---

## Security Checklist for Production

Before going live, verify every item on this list.

### Authentication and Secrets

- [ ] `JWT_SECRET` is a random 64-character hex string (generate: `openssl rand -hex 32`)
- [ ] `MFA_ENCRYPTION_KEY` is a random 64-character hex string (generate: `openssl rand -hex 32`)
- [ ] Default passwords have been changed in `.env` (no `dominusnode_dev` in production)
- [ ] `NODE_ENV=production` is set
- [ ] `.env` file permissions are restricted (`chmod 600 .env`)

### Database

- [ ] Database SSL is enabled (`DATABASE_URL` includes `?sslmode=require`)
- [ ] Database user has minimal required permissions
- [ ] Database password is strong and unique
- [ ] Automated database backups are configured (pg_dump cron or managed DB snapshots)
- [ ] Disk space monitoring is set up for PostgreSQL data directory

### Network

- [ ] `CORS_ORIGINS` is set to your actual frontend domain(s) -- no wildcards
- [ ] Firewall is configured (only ports 22, 80, 443, 8080, 1080 open)
- [ ] PostgreSQL port (5432) is NOT exposed to the internet
- [ ] SSH is key-based only (password authentication disabled)
- [ ] HSTS is enabled in the reverse proxy configuration

### Billing Webhooks

- [ ] `STRIPE_WEBHOOK_SECRET` is configured and matches Stripe dashboard
- [ ] `NOWPAYMENTS_IPN_SECRET` is configured and matches NOWPayments dashboard
- [ ] Webhook endpoints are accessible from payment provider IPs
- [ ] `STRIPE_SUCCESS_URL` and `STRIPE_CANCEL_URL` point to your production frontend

### Monitoring and Operations

- [ ] Log rotation is configured
- [ ] Service auto-restart is enabled (systemd `Restart=always` or Docker `restart: unless-stopped`)
- [ ] Health check endpoint is monitored (uptime checker on `/api/health`)
- [ ] Disk space alerts are set up
- [ ] SSL certificate auto-renewal is verified (`certbot renew --dry-run`)
- [ ] Database connection pool limits are appropriate for your workload

### Rate Limiting

- [ ] API rate limiting is active (100 req/min global, 10 req/15min for auth)
- [ ] Proxy session rate limiting is configured (`MAX_SESSIONS_PER_MINUTE=30`)
- [ ] Account lockout is enabled (5 failed logins triggers 15-minute lockout)

---

## Troubleshooting

### API returns "db: disconnected" on health check

PostgreSQL is not reachable. Check:

```bash
# Is PostgreSQL running?
sudo systemctl status postgresql

# Can you connect?
psql "postgresql://dominusnode:YOUR_PASSWORD@localhost:5432/dominusnode" -c "SELECT 1;"

# Check DATABASE_URL in .env
grep DATABASE_URL /opt/dominusnode/.env
```

### Migration fails with "relation already exists"

This is safe to ignore. The schema uses `CREATE TABLE IF NOT EXISTS` and idempotent `DO $$ BEGIN ... EXCEPTION WHEN duplicate_column` blocks. It will not overwrite existing data.

### Proxy returns 407 Proxy Authentication Required

The proxy requires API key authentication. Pass your API key as the password in proxy credentials:

```bash
curl -x http://anything:dn_live_YOUR_KEY@localhost:8080 http://httpbin.org/ip
```

The username can be any non-empty string.

### Proxy returns 402 Payment Required

Your wallet balance is too low. Top up via the dashboard or the API:

```bash
curl -X POST https://api.yourdomain.com/api/wallet/topup/stripe \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{"amount_cents": 1000}'
```

### Frontend shows "Network Error" or CORS errors

1. Verify `CORS_ORIGINS` in the backend `.env` includes your frontend URL.
2. Restart the API service after changing CORS settings.
3. Ensure the frontend is using the correct API URL (check `VITE_API_URL` or the Vite proxy config).

### Docker build fails on bcrypt

The `bcrypt` package requires native compilation. Ensure you are building on the same platform as the runtime. In Docker, `node:20-alpine` includes build tools. If you see errors:

```bash
# Inside Dockerfile, before npm ci:
RUN apk add --no-cache python3 make g++
```

### systemd service fails to start

```bash
# Check logs
sudo journalctl -u dominusnode-api --no-pager -n 50
sudo journalctl -u dominusnode-proxy --no-pager -n 50

# Common issues:
# - Missing .env file: ensure EnvironmentFile path is correct
# - Permission denied: ensure dominusnode user owns /opt/dominusnode
# - Port already in use: check with 'ss -tlnp | grep 3000'
```

### PostgreSQL running out of connections

Dominus Node uses `pg.Pool` with a default of 10 connections. If running multiple replicas:

```bash
# Check current connections
sudo -u postgres psql -c "SELECT count(*) FROM pg_stat_activity WHERE datname='dominusnode';"

# Increase max_connections in postgresql.conf if needed
sudo nano /etc/postgresql/16/main/postgresql.conf
# Set: max_connections = 200
sudo systemctl restart postgresql
```

### schema.sql not found after build

The migration script looks for `schema.sql` in the dist directory. Always copy it after building:

```bash
cp packages/shared/src/schema.sql packages/shared/dist/src/schema.sql
```

Or include this in your build script/CI pipeline.
