# Build context: repo root (npm workspaces need sibling packages).
FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/event_schemas ./packages/event_schemas
COPY packages/chain_config ./packages/chain_config
COPY packages/shared_utils ./packages/shared_utils
COPY services/dex_monitor ./services/dex_monitor

RUN npm install
WORKDIR /app/services/dex_monitor
CMD ["npm", "start"]
