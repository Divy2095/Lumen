FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY --chown=node:node tsconfig.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node .gitignore ./
COPY --chown=node:node compose.test.yaml .env.integration.example ./
COPY --chown=node:node infra/test ./infra/test
# No .env, development storage, credentials, or host node_modules are copied.
USER node
