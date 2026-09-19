# syntax=docker/dockerfile:1

FROM oven/bun:1.4.2-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1.4.2-alpine
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production \
    PODMAN_SOCKET=/run/podman/podman.sock

USER root
CMD ["bun", "run", "src/worker.ts"]
