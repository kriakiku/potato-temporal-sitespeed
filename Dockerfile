# syntax=docker/dockerfile:1

FROM oven/bun:1.4.2-debian AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1.4.2-debian
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production

USER root
CMD ["bun", "run", "src/worker.ts"]
