# Minimal image for the Dominus Node MCP server (stdio transport).
#   docker build -t dominusnode-mcp packages/mcp-server
#   docker run -i --rm -e DOMINUSNODE_API_KEY dominusnode-mcp
# No secrets are baked in: pass DOMINUSNODE_API_KEY at run time, and mount a
# wallet key file read-only if needed (-v ./wallet.key:/run/secrets/wallet.key:ro
# -e DOMINUSNODE_WALLET_KEY_FILE=/run/secrets/wallet.key).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json tsconfig.docker.json ./
RUN npm install --no-audit --no-fund --ignore-scripts
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
