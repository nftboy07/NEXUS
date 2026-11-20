# Build context: repo root (npm workspaces need sibling packages).
#   docker compose build evm_listener
FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/event_schemas ./packages/event_schemas
COPY packages/chain_config ./packages/chain_config
COPY packages/shared_utils ./packages/shared_utils
COPY services/evm_listener ./services/evm_listener

RUN npm install
WORKDIR /app/services/evm_listener
CMD ["npm", "start"]
