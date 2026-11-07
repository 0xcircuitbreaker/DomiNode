# DomiNode node agent (exit node). Build from the repository root:
#   docker build -f packages/node-agent/Dockerfile \
#     --build-arg DN_COORD_PUBKEYS=<comma-separated coordinator public keys> \
#     -t dominusnode-node .
# DN_COORD_PUBKEYS are PUBLIC keys (policy-signature pins), not secrets; release
# builds refuse to compile without them (DEPLOYMENT.md §1–2).
#
# Run (key file mounted read-only, owned by uid 1001, mode 0600):
#   docker run -d --name dominusnode-node --restart unless-stopped \
#     -v /etc/dominusnode/node.json:/run/dominusnode/node.json:ro \
#     dominusnode-node
# The image contains no node key, API key or wallet key.

# ─── Build ──────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY packages/shared/ packages/shared/
COPY packages/node-agent/ packages/node-agent/
RUN npm ci --ignore-scripts --workspace=@dominusnode/shared --workspace=@dominusnode/node-agent --include-workspace-root
ARG DN_COORD_PUBKEYS=""
RUN DN_COORD_PUBKEYS="$DN_COORD_PUBKEYS" node packages/node-agent/scripts/gen-coord-pins.mjs --require \
 && npx tsc --build packages/node-agent \
 && find packages -name "*.map" -delete

# ─── Runtime ────────────────────────────────────────────────────────
FROM node:22-alpine
RUN addgroup -g 1001 -S dominusnode && adduser -S dominusnode -u 1001 -G dominusnode
WORKDIR /app
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/packages/shared/package.json packages/shared/package.json
COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/packages/node-agent/package.json packages/node-agent/package.json
COPY --from=builder /app/packages/node-agent/dist packages/node-agent/dist
RUN npm ci --omit=dev --ignore-scripts --workspace=@dominusnode/shared --workspace=@dominusnode/node-agent --include-workspace-root
# bcrypt is a native transitive dependency of @dominusnode/shared
RUN npm rebuild bcrypt
ENV NODE_ENV=production \
    DN_NODE_KEY_FILE=/run/dominusnode/node.json
USER dominusnode
ENTRYPOINT ["node", "packages/node-agent/dist/src/main.js"]
CMD ["run"]
