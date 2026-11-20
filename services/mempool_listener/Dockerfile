# Build context: repo root (npm workspaces need sibling packages).
#   docker compose build mempool_listener
FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/event_schemas ./packages/event_schemas
COPY packages/chain_config ./packages/chain_config
COPY packages/shared_utils ./packages/shared_utils
COPY services/mempool_listener ./services/mempool_listener

RUN npm install
WORKDIR /app/services/mempool_listener
CMD ["npm", "start"]
