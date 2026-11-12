# Minimal image for the Dominus Node MCP server (stdio transport).
#   docker build -t dominusnode-mcp packages/mcp-server
#   docker run -i --rm -e DOMINUSNODE_API_KEY dominusnode-mcp
#
# Gateway: proxy fetches use TLS to https://proxy.dominusnode.daedalusdevelopmentgroup.com:8443
# by default. Override with -e DOMINUSNODE_PROXY_URL=https://host:port, add a private CA with
# -e DOMINUSNODE_PROXY_CA_FILE=/run/secrets/proxy-ca.pem, or (not recommended: the API key is
# sent in clear) -e DOMINUSNODE_PROXY_INSECURE=1 for the plaintext :8080 listener.
#
# No secrets are baked in: pass DOMINUSNODE_API_KEY at run time. The wallet key file
# (DOMINUSNODE_WALLET_KEY_FILE) must be mode 0600 AND readable by the container user
# (uid 1000, "node"), or the server refuses it. Either:
#   chmod 600 wallet.key && sudo chown 1000 wallet.key
#   docker run -i --rm -v ./wallet.key:/run/secrets/wallet.key:ro \
#     -e DOMINUSNODE_WALLET_KEY_FILE=/run/secrets/wallet.key dominusnode-mcp
# or keep the file owned by you and run as your uid: add --user "$(id -u):$(id -g)".
# With Docker/Compose secrets, set the secret's uid: "1000" and mode: 0600 so the
# mounted /run/secrets/<name> passes the check.
#
# package-lock.json here is a standalone lock for this image (the repo build uses the
# root workspace lock). Refresh it with: npm install --package-lock-only --legacy-peer-deps
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.docker.json ./
RUN npm ci --no-audit --no-fund --ignore-scripts --legacy-peer-deps
COPY src ./src
RUN npx tsc -p tsconfig.docker.json && npm prune --omit=dev --ignore-scripts

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./dist/src
USER node
ENTRYPOINT ["node", "dist/src/index.js"]
