# syntax=docker/dockerfile:1

FROM oven/bun:1.4-debian AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1.4-debian
# Podman CLI talks to the host socket (mount /run/podman/podman.sock).
RUN apt-get update \
  && apt-get install -y --no-install-recommends podman ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production \
    CONTAINER_RUNTIME=podman

# Host Podman socket is expected at the default path when bind-mounted.
ENV CONTAINER_HOST=unix:///run/podman/podman.sock

USER root
CMD ["bun", "run", "src/worker.ts"]
